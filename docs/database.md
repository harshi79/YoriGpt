# PostgreSQL data foundation

## Scope and version decision

This step adds schema, migration SQL, generated-client configuration and the
server database boundary only. No authentication library, accounts/sessions,
passwords, credentials, API handlers, application queries, seeds, or UI/database
connection have been added.

Prisma CLI, `@prisma/client`, and `@prisma/adapter-pg` are pinned together at
**6.19.3**, the latest available 6.x patch at inspection. Node 22.22.3 is compatible.
Prisma 7.10.0 was evaluated: it does not fix the existing `deepmerge-ts` advisory,
adds unrelated CLI tooling dependencies, and entails a major configuration change.
The registry's `latest` tag points to an 8.x release candidate. Neither is a
justified change solely to hide the advisory. No dependency overrides are used.

The runtime uses the Rust-free client engine (`engineType = "client"`), generally
available since Prisma 6.16, with the official PostgreSQL adapter. Only two runtime
packages were added: `@prisma/client` and `@prisma/adapter-pg` (which brings its `pg`
driver). Generated output stays inside ignored `node_modules`; it is not committed.
Prisma 6 configuration belongs in `prisma/schema.prisma`; a Prisma 7-style
`prisma.config.ts` is not required. Native migration tooling remains the default.

## Data model

| Prisma model / table                   | Purpose                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `User` / `users`                       | String ID, unique case-insensitive email, name, email-verification flag, optional image, status, timestamps        |
| `Conversation` / `conversations`       | Required owner, title, timestamps; cannot exist without a user                                                     |
| `Message` / `messages`                 | Required conversation, role, text content, zero-based position, timestamps                                         |
| `AiModel` / `ai_models`                | Provider, provider-specific identifier, display name, inactive-by-default flag, timestamps                         |
| `UserPreferences` / `user_preferences` | Optional one-to-one user preferences, preferred model, theme, pet selection key, non-sensitive JSON UI preferences |
| `Session` / `sessions`                 | Better Auth login session: unique token, required user, expiry, optional IP/user agent, timestamps (added in the auth migration) |
| `Account` / `accounts`                 | Credential provider record: unique `(providerId, accountId)`, hashed password, optional tokens; cascade delete with the user |
| `Verification` / `verifications`       | Expiring single-use values: password-reset tokens today, future email flows; indexed by identifier |

```text
User ───< Session
  ├─────< Account
  ├─────< Conversation ───< Message
  └───── UserPreferences >──── AiModel (optional)

Verification stands alone: rows are keyed by identifier, not by user.
```

- IDs are Prisma-generated CUID strings, not database UUID columns. This leaves
  room for an authentication library to supply its own string IDs. Direct SQL
  writers must provide IDs; the migration does not define server-side ID defaults.
- Roles are `USER`, `ASSISTANT`, `SYSTEM`. Structured tool-call payloads and other
  roles belong in a later, concrete provider-contract migration.
- Providers are `OPENROUTER` and `NVIDIA`. Enum labels are not provider records;
  there are **no catalog entries** or API keys in this migration.
- User status is `ACTIVE` or `SUSPENDED`. This is metadata, **not enforcement**;
  a future authentication/authorization layer must explicitly enforce it.
- A user need not have preferences yet. Theme is `SYSTEM`, `DARK`, or `LIGHT`
  (`ThemePreference`), defaulting to `SYSTEM` in both the schema and the migration.
  A missing row now resolves to the schema default, so `src/server/settings/` answers
  `system` for an account that has no `user_preferences` row and for one whose row was
  created by another feature; see the README's settings section.
- `selectedPetKey` is a nullable, stable key into the code pet catalog
  (`src/features/pets/catalog.ts`: placeholder cats, a fox, and a rabbit drawn from
  inline SVG). It is now wired: `src/server/pets/service.ts` reads and writes it via
  `GET/PUT /api/settings/pet`, storing only a key the catalog marks available and
  resolving missing/unknown/retired values to the catalog default. No pet table or
  fabricated species data is added, and no migration exists or is needed. The pet
  *appearance* and *personality* are stored alongside it as single stable keys
  (`petAppearance`, `petPersonality`) inside the same existing non-sensitive
  `uiPreferences` JSON object — again no new column, table, or migration — each
  validated against the user's currently selected pet and resolved back to that pet's
  default when missing, unknown, or from another pet. Only these three keys are stored;
  pet mood and size are not. A personality is persisted as its catalog key only — never
  the personality object, its traits, or anything resembling a prompt. Future
  pet/accessibility options can use the non-sensitive `uiPreferences` object. Future
  writers must validate allowed keys, payload size, and versions; never store tokens,
  credentials, or behavioral state here.

## Integrity, indexing and deletion

- `User.email` uses PostgreSQL **citext** with a unique index. Case-only variants
  cannot create different identities and equality lookups remain case-insensitive.
  The initial migration installs the `citext` extension in `public`; managed
  databases may require an administrator to provision it before deployment.
  Email syntax/whitespace normalization still belongs to the future auth library.
- Required owner/conversation foreign keys plus `NOT NULL` enforce
  `User → Conversation → Message`. There is no nullable/global conversation owner.
- Deleting a user cascades to their conversations, messages, and preferences.
  Deleting a conversation cascades to its messages. These are intentional hard
  deletes; a future user-facing deletion operation needs confirmation and policy.
- `(conversationId, position)` is unique, and SQL enforces `position >= 0`. The
message service relies on that constraint: it computes the next position inside a
transaction that locks the parent conversation first, and retries an insert if the
constraint still rejects it, so positions stay dense and unique. The assistant-reply
writer uses the same path after re-checking that the message it was generated for is
still the conversation's latest row, which is how a duplicate or competing reply is
refused instead of stored twice.
  Its B-tree supports ordered history and reverse scans for the latest messages.
  Gaps are permitted. Future writers must allocate positions transactionally with
  concurrency handling; do not use client timestamps or an unprotected `max + 1`.
- `(userId, updatedAt DESC, id DESC)` supports owner-filtered recent conversations
  and stable cursor pagination. It also covers the owner foreign key.
- `(provider, modelIdentifier)` is unique; IDs can legitimately repeat across
  providers. `(isActive, provider, displayName, id)` supports active catalog reads.
- The preferences primary key (`userId`) enforces at most one row per user.
  Its optional model FK has `ON DELETE SET NULL`, plus a supporting index.
  Deactivating a catalog model does not remove the preference; future services
  must handle inactive models explicitly.
- A SQL-only CHECK requires `uiPreferences` to be a JSON **object**, not an array,
  primitive, or JSON null. The field is non-nullable with an empty-object default.
- Timestamps use `TIMESTAMPTZ(3)` and database creation defaults. `@updatedAt` is
  Prisma-maintained, not a PostgreSQL trigger. Raw SQL writers must update it.
  Adding a message does **not** automatically bump its conversation timestamp;
  the future message-writing transaction must do that explicitly.

Prisma 6 cannot express CHECK constraints or extension provisioning directly in
this schema. Preserve the reviewed SQL additions in subsequent migrations.
`prisma migrate diff` only compares Prisma-supported features, so the opt-in
catalog tests also check SQL-only constraints.

**Structural ownership is not authorization by itself.** There is still no RLS;
authorization lives in the server query. `src/server/conversations/service.ts` now
scopes every conversation read, write, and delete to the authenticated owner, so
knowing another account's conversation ID grants nothing and answers the same 404
as an id that never existed.

## Model catalog rows

`ai_models` is seeded from the code catalog (see the migration note above). Its unique
`(provider, modelIdentifier)` constraint keeps one row per provider model, and
`user_preferences.preferredModelId` references it with `onDelete: SetNull` — deleting a
catalog row silently drops that preference instead of failing, and the app then falls
back to the catalog default. `isActive = false` marks a retired model: it keeps
resolving for the rows that reference it but is never offered or selectable.

## Authentication tables (implemented with Better Auth 1.7.5)

The auth migration `20260923010000_add_better_auth` adds `sessions`, `accounts`,
and `verifications` in the shape the installed Better Auth version expects; the
existing `users` table already matched its core user fields (`id`, `name`, `email`,
`emailVerified`, `image`, `createdAt`, `updatedAt`) plus the app-owned `status`,
which the library never accepts from user input. Credential records store Better
Auth's own Scrypt hash in `accounts.password`; this project implements no password
hashing of its own.

Auth configuration, flows, environment, and the verification performed are
documented in **[authentication.md](authentication.md)**. Keep the two documents
in sync when upgrading Better Auth: the adapter's expectations are version
specific, and `tests/auth-schema.test.ts` plus `tests/database/auth.integration.ts`
exist to catch drift.

Sources reviewed:

- https://better-auth.com/docs/adapters/prisma
- https://better-auth.com/docs/concepts/database#core-schema
- https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/no-rust-engine

## Server boundary and lifecycle

Import `getDb` only from `src/server/db/client.ts`, inside server services. Its
`server-only` marker prevents importing it into a Client Component. Importing the
module neither reads `DATABASE_URL` nor connects. Calling `getDb()` validates the
runtime URL and lazily creates a shared Prisma client/adapter; the first query
opens a connection. `globalThis` reuses it across development module reloads.
No application-specific query helpers are included.

The pool is bounded at five connections per Node process with a 5-second connect
timeout and 30-second idle timeout. Deployment replicas multiply that pool budget;
review these limits against the actual PostgreSQL connection limit before scale-up.
The URL's `schema` parameter is passed explicitly to the adapter and removed from
the driver URL. The default is `public`. Prisma-specific Rust-engine pool URL
parameters such as `connection_limit` are not used by the `pg` driver; configure
pool limits in the boundary, not by assuming those parameters work.

Do not disconnect per request. Scripts/tests should disconnect at shutdown. Never
log the connection URL, weaken TLS verification, or serialize a client/config
object into the UI. Use an unpooled migration/admin connection for deployment and
a least-privilege runtime database role for future application queries.

## Normal installation and migration workflow

```sh
cp .env.example .env
npm ci
npm run db:generate
npm run db:validate
npm run lint
npm run typecheck
npm test
npm run build
```

Code generation/validation need only a syntactically valid PostgreSQL URL, not a
live database or real credentials. `.env.example` supplies a placeholder URL for
that purpose. Generation is an explicit setup/deployment step; rerun it after
schema changes. Never assume a cached generated client matches a changed schema.
The native Prisma CLI may need network access to download engines, even with a
Rust-free runtime client. Installation's automatic Prisma generation may be
skipped/unsuccessful in restricted environments; always run `db:generate` explicitly.
`next build`, typecheck, and unit tests require the generated client but make no
PostgreSQL connection. Do not run migrations as a build or install hook.

For a **new local/deployment database**, set `DATABASE_URL` to its actual URL, then:

```sh
npm run db:deploy            # apply committed migrations
npm run db:status
npm run db:deploy            # safe no-op if already up to date
```

For subsequent development schema changes, use a disposable development database
and `npm run db:migrate -- --name descriptive_change`, review the generated SQL,
commit it, regenerate the client, and recheck constraints. `migrate dev` needs
shadow-database privileges; do not run it against production. Do not edit an
already-deployed migration or use `db push` as a production migration workflow.

The committed migrations are
`prisma/migrations/20260923000000_initial_data_foundation/migration.sql` (generated via
Prisma's empty-to-schema diff and augmented with `citext`, the two CHECK constraints,
and a transaction — it contains **no application INSERTs**),
`prisma/migrations/20260923010000_add_better_auth/migration.sql` (Better Auth tables),
`prisma/migrations/20260923020000_seed_ai_models/migration.sql` (OpenRouter rows),
and `prisma/migrations/20260924000000_seed_nvidia_model/migration.sql` (one NVIDIA
NIM row). Each seed's row id is the catalog key, and the `provider`,
`modelIdentifier`, `displayName`, and `isActive` columns mirror the server-owned
catalog (`src/server/ai/models/catalog.ts`). Both are idempotent
(`INSERT … ON CONFLICT (id) DO UPDATE`). The NVIDIA migration adds **data only**:
the `ModelProvider.NVIDIA` enum value and the table already existed. It is necessary
because `user_preferences.preferredModelId` is a foreign key to `ai_models.id`;
without this row the NVIDIA selection cannot be saved. **No request-time decision
reads the model table**: which models are offered, which provider and identifier
answer for each key, and which model is the default all come from the code catalog,
so that metadata is available without a database round trip. A running session
still needs a reachable database for its stored conversations and preferences.

## Opt-in PostgreSQL verification

```sh
# First deploy the migration to a dedicated test database using DATABASE_URL.
# DATABASE_TEST_URL is a separate explicit opt-in, not a fallback to runtime config.
DATABASE_TEST_URL='postgresql://USER:PASSWORD@HOST:5432/TEST_DATABASE?schema=public' npm run test:db
```

The structure test only reads catalog definitions and table counts: it verifies
required FKs/deletion policies, indexes, citext equality, SQL checks, and actual
Prisma reads. The auth and conversation integration tests write real users,
sessions, and conversations through the application code and delete their rows in
`afterAll` (test accounts use a reserved `*.invalid` domain), so a run leaves the
auth tables empty. Use the `public` schema for this verification suite. Constraint
rejection under raw concurrent writes (for example two simultaneous inserts of one
`(conversationId, position)`) remains a later integration-test task; catalog checks
are not represented as proof of concurrent transaction behavior.

CI has a separate disposable PostgreSQL 17 service job for the standard native
migration lifecycle: clean deploy, second deploy, status, schema diff, and these
read-only checks. That workflow has been configured, **not run remotely here**.

## What was actually verified in this sandbox

- `binaries.prisma.sh` resolves and TCP connects, but TLS terminates before a
  secure session; curl reports `SSL_ERROR_SYSCALL` and Prisma reports a socket
  disconnect. This happens before schema validation/database access. Official
  alternate download hosts also failed. The underlying network/egress cause
  cannot be determined from this sandbox; certificates/checksums were not disabled.
- **The assistant-reply step required no schema change.** A reply is an ordinary
`Message` row with role `ASSISTANT` and the next position, so the existing enum,
text column, unique constraint, and cascade already cover it: no new migration, no
`ai_models` record, and no model-selection column was added. The model name lives in
server configuration only.
- **Streaming replies needed no schema change either.** Provider deltas are held in
  server memory while they are forwarded and are written only once, after the
  provider signals completion, through the same insert path — so there is no partial
  row, no draft table, and no new column. `messages.content` stores the finished
  text; the position, role, and timestamps are still assigned by the message
  service, and a stream that fails, is truncated, is empty, or is cancelled writes
  nothing.
- **The model catalog added one seed migration and no schema change.** The
  `ai_models` table already existed for exactly this purpose, so the preference reuses
  `user_preferences.preferredModelId` and its foreign key. The only new SQL is
  `prisma/migrations/20260923020000_seed_ai_models/migration.sql`, which inserts the
  catalog rows (idempotently). It was applied to the disposable PostgreSQL 17.6
  instance here with the `pg` driver (native `prisma migrate deploy` remains blocked
  in this sandbox), and the database suite confirms the rows exist, that a preference
  pointing at no model is refused by the constraint, and that one account's stored
  choice is untouched by another account's request.
- **The NVIDIA provider step added a data-only seed, not a schema change.** The
  existing `ModelProvider.NVIDIA` enum value and `ai_models` table are reused.
  `prisma/migrations/20260924000000_seed_nvidia_model/migration.sql` inserts the
  `nvidia-llama-3.3-70b` catalog row with provider `NVIDIA` so the existing foreign
  key can save it as a per-user preference. The catalog is still in code, and a raw
  provider identifier cannot be stored through the model route. Applying this new
  migration to a real database has not been exercised in the current restricted
  sandbox (no `DATABASE_TEST_URL` and no generated Prisma client); the unit test
  checks its SQL row matches the catalog, and the opt-in database integration test
  checks the row, provider, preference write, and account isolation when a migrated
  test database is available.
- **The settings step added no schema change either.** The theme preference reuses
  `user_preferences.theme` and its existing `ThemePreference` enum exactly as the
  initial migration created them: `src/server/settings/service.ts` upserts only that
  column, keyed by the authenticated user, and reads it back through the shared
  Prisma client. No table, column, enum value, index, or migration was added, and no
  secret or internal identifier is serialized. The database suite checks it against
  real sessions: the documented `SYSTEM` default with no row, the enum column
  rejecting a value outside it, one account's theme untouched by another account's
  request, a theme change updating the existing row without disturbing its
  `preferredModelId`, and invalid or unauthorized bodies writing nothing.
- **The pet framework and its persistence added no schema change at all.** The render
  layer (catalog, renderer, state, appearances, personalities) lives in
  `src/features/pets/`, and the persisted selection reuses the existing
  `user_preferences.selectedPetKey` column exactly as the initial migration created it,
  while the appearance and personality reuse the existing non-sensitive `uiPreferences`
  JSON object (properties `petAppearance` and `petPersonality`):
  `src/server/pets/service.ts` upserts only those fields, keyed by the authenticated
  user, and reads them back through the shared Prisma client. No table, column, index,
  or migration was added. The database suite checks it against real sessions: the
  catalog default with no row, a valid available pet written for that user only,
  unavailable/unknown/unexpected/untrusted bodies writing nothing, a pet change leaving
  the row's theme/model columns alone, one account unable to write another's stored
  pet, and the appearance and personality each stored as a single validated key that
  leaves the selection, the other key, and every other preference intact.
- **OpenRouter key rotation added no schema change either.** Which of the configured
  keys signs a request, and which keys are cooling down after the provider rejected
  them, live in the server process's memory (`src/server/ai/key-pool/`). There is no
  credential table, no per-key counter, and no migration: the keys come from server
  environment variables, rotation state is rebuilt on restart, and a credential value
  never reaches the database, a log line, or the browser.
- Unmodified native `db:validate` and `db:generate` were attempted and failed at
  that download. A **temporary, ignored** Prisma config used the bundled WASM
  schema engine (`engine: "js"`, `experimental.adapter: true`) for formatting,
  schema validation, client generation, and the initial migration diff; these
  operations succeeded. The standard project configuration was not switched to
  experimental migration tooling.
- A real disposable PostgreSQL **17.6** process was installed outside the repo and
  bound only to loopback. The exact migration SQL of both migrations (foundation and
  auth) was accepted and committed via the PostgreSQL driver; the database now
  contains all eight tables, and the integration suites verified real
  registration/session/reset behavior, real conversation ownership, stored message
  writes, and assistant replies on both the JSON and the streaming endpoint
  (including the refusal of a duplicate or racing reply, no row after a failed or
  truncated stream, and no row when the client disconnects mid-stream) against it.
- Experimental WASM `migrate deploy` was also attempted, but it failed before
  applying the migration because Prisma 6's adapter could not decode PostgreSQL's
  catalog `name` type. It is **not a verified replacement** for the native runner.
- Consequently, **Prisma-managed deployment/history, repeat deployment, native
  shadow-database migration, and native drift checking remain unverified here**.
  Manual SQL acceptance does not establish a Prisma migration-history entry. The
  disposable database is not a baseline to reuse in production; start clean and
  run the standard `db:deploy` workflow in an engine-download-capable environment.
- The no-database suite, the disposable-database integration suites (which delete
  the rows they create), the production build, and the browser suite pass. Runtime
  imports do not connect to PostgreSQL on their own.

## Known dependency issue

The `prisma → @prisma/config → deepmerge-ts` chain (GHSA-ggr8-5vv4-36mx) is still
reported as three high-severity audit entries. Because `@prisma/client` declares the
`prisma` CLI as an optional **peer** dependency, npm now surfaces this chain in
`npm audit --omit=dev` as well, even though `prisma` is a devDependency and the
server runtime never loads `@prisma/config` or `deepmerge-ts` (verified by
instrumenting module loading around `require("@prisma/client")`). The exposure is
limited to Prisma CLI/config tooling that parses trusted local configuration files:
no untrusted Prisma configuration is accepted, and no override is used to hide it.
No compatible patched 6.x release was available, the checked 7.x release is also
affected, and the registry's `latest` is an 8.x release candidate. Re-evaluate an
official upstream fix before production deployment; a blind downgrade
(`npm audit fix --force` suggests `prisma@6.12.0`, a breaking change) or an
unverified transitive override is not a safe remediation.
