# YoriGPT

A Node.js application with a responsive chat shell, PostgreSQL data foundation,
email/password authentication, and a **user-scoped conversation and message flow**.
Assistant replies can stream from **OpenRouter or NVIDIA NIM**: the server chooses a
provider from its own model catalog, streams a provider-neutral answer over SSE,
and stores the reply only after the generation completes. Each provider has its own
server-only, rotating key pool; the existing OpenRouter model remains the default.
Account settings include a persistent theme preference. The interactive 2D pet
framework has persistent per-account selection and personalities and a deterministic
local reaction engine that follows the real chat lifecycle. A compact, server-owned
personality instruction now influences replies from either provider without replacing
those deterministic visual reactions or turning the assistant into a pet roleplay.
Signed-out visitors can view the chat shell, but conversations belong to an
authenticated account.

## Prerequisites

- Node.js **22.12+ on the Node 22 line**, or a compatible newer even-numbered
  release (see `package.json`). `.nvmrc` pins the tested version, **22.22.3**.
- npm (tested with **10.9.8**); use the committed `package-lock.json`.
- PostgreSQL is needed for migrations and opt-in database tests, not for
  installation, the UI shell, ordinary unit tests, or production builds.

## Quick start

```sh
nvm use                         # if using nvm
cp .env.example .env            # safe placeholder URL; no live DB required
npm ci                          # reproducible install; npm install also works
npm run db:generate             # explicit codegen; see network limitation below
npm run dev
```

Open http://localhost:3000. The server binds to `0.0.0.0` to support containers and
remote development environments. Do not expose a development server publicly in
production. No fonts or other assets need to be fetched during the build.

## Commands

| Command                               | Purpose                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run dev`                         | Next.js development server                                                                 |
| `npm run lint`                        | ESLint; warnings fail the check                                                            |
| `npm run typecheck`                   | Generate Next route types, then strict TypeScript checking                                 |
| `npm test`                            | Run the Vitest test suite once                                                             |
| `npm run test:watch`                  | Watch tests during development                                                             |
| `npm run test:e2e`                    | Run Chromium UI tests against the production build (build first)                           |
| `npm run build`                       | Optimized production build, without database/API credentials                               |
| `npm start`                           | Serve the production build on port 3000                                                    |
| `npm run db:validate`                 | Validate Prisma schema; requires a syntactically valid `DATABASE_URL`, not a live database |
| `npm run db:migrate -- --name <name>` | Create/apply development migrations for future schema changes                              |
| `npm run db:deploy`                   | Apply committed migrations in deployment, against the configured database                  |
| `npm run test:db`                     | Opt-in database checks; requires `DATABASE_TEST_URL` for a disposable, migrated database    |

Unit tests cover the shell, composer states, static message roles, scoped
environment validation, the Better Auth schema/config contract, mailer guards, auth
form helpers, and the conversation/message request, service, and client helpers.
Browser tests cover responsive layout, keyboard focus, mobile navigation, local
drafts, presentation-only model selection, the auth pages (rendering, local
validation, keyboard order, invalid reset links), and — when `DATABASE_TEST_URL` is
set — the signed-in conversation checks (create, list, delete, cross-account
isolation), the stored-message checks (send, reload, order, cross-account isolation,
signed-out rejection), and the signed-out redirects. The default suite connects to
no database and sends no email; the opt-in database suite runs against a disposable
PostgreSQL instance. CI runs install, lint,
typecheck, tests, Prisma validation/generation, build, and browser tests without real secrets
or a database service in the ordinary check job. A separate opt-in PostgreSQL
job verifies the database foundation.

For browser testing:

```sh
npx playwright install --with-deps chromium  # once per browser/tooling upgrade
npm run build
npm run test:e2e
```

Playwright starts the production server on port 3100. Set `DATABASE_TEST_URL` to a
disposable migrated database (the same variable as `npm run test:db`) to enable the
four signed-in conversation checks; without it they are skipped and the rest of the
suite still runs. On restricted development machines,
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select an existing Chromium binary instead.
Browser checks completed in an earlier environment with a separately installed
Chromium; no browser executable was available for Task 24. Browser binaries and
screenshots are not committed.

## Visual application shell

- Desktop sidebar that lists the signed-in account's stored conversations, with a
  client-side search filter, two-step delete, and active-conversation highlight.
  Signed-out visitors see the disabled guest-account area and one labeled static
  example instead; the guest label is not an authenticated account.
- Native modal mobile navigation with Escape dismissal, keyboard focus cycling,
  focus restoration, and close-on-desktop-resize behavior.
- Native accessible model dropdown, fed by the **server's own catalog** (see
  [Model catalog and selection](#model-catalog-and-selection)). It shows the models
  this deployment offers and the one that will write the next reply; choosing
  another stores it for the signed-in account immediately. Signed out, the catalog
  is listed with the default selected and choosing one routes to `/login`.
- Settings entry in the sidebar's account area (signed in only), opening `/settings`
  with the appearance preference and read-only account details (see
  [Settings and theme preference](#settings-and-theme-preference)). Signed-out
  visitors keep the existing guest area and no settings link.
- Empty conversation with four draft starters. Choosing one populates and focuses
  the textarea; it does not send anything.
- One explicitly labeled static conversation under **UI examples**, with user and
  assistant presentation, role labels, and a working copy-example action. It is
  labeled as an example and is separate from any stored conversation.
- Controlled, auto-resizing composer. In a stored conversation it saves the
  written message and shows it immediately; the attachment control stays disabled.
  **New chat** does not send anything: when signed in it creates a stored
  conversation and opens it; when signed out it routes to `/login`.
- Stored user messages rendered with the existing message styles, followed by the
  **real assistant reply the server generated for them**. While a reply is arriving,
  its text is rendered incrementally from the provider's deltas in a marked,
  provisional bubble (no simulated typing); the composer disables itself and shows an
  honest status line. When the server confirms the stored row, the provisional bubble
  is replaced by it. A failure removes the provisional text, shows a retryable error,
  keeps the user's message, and never invents or stores a partial assistant row.
- Full-height layout using dynamic viewport units, independently scrolling chat
  content, safe-area padding, and touch-sized mobile controls.

`src/components/layout/chat-shell.tsx` is the sole client entry point for this UI.
Its interactive descendants share that boundary; the page and root layout remain
server components. Local demonstration data lives in
`src/features/chat/presentation.ts`, not in a database or mock API. Model options are
not presentation data: they come from the server catalog.
`ModelSelector` accepts model options, a value, and an on-change callback; the shell
fills them from the server-rendered selection and saves a change through
`PUT /api/models`. `MessageComposer` accepts a controlled draft, a busy flag, and the
submit callback the shell uses to store a user message and then stream its reply from
`/api/conversations/:id/reply`.

There was no reference screenshot available at this step. All marks/icons are
original inline SVG, and the provisional visual tokens can be refined later.

## Environment configuration

Next.js loads `.env` automatically; Prisma 6 also reads `.env`. Prefer this file
for local configuration so both tools share the same database setting. Supply
real secrets using your deployment platform's secret manager in production.
Do not commit local environment files. `.env.example` is a template only.

All configuration below is **server-only**:

| Variables                                    | Required when                                                        |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `APP_URL`                                    | Authentication is used; must be the real public origin               |
| `DATABASE_URL`                               | Running database commands / auth sessions and credentials            |
| `AUTH_SECRET`                                | Authentication is used; random secret, at least 32 characters        |
| `AUTH_TRUSTED_ORIGINS`                       | Extra deployed/preview origins may call the auth API (optional)       |
| `SMTP_URL`, `EMAIL_FROM`                     | Verification/reset emails should be delivered (optional)             |
| `OPENROUTER_API_KEYS`                        | An OpenRouter model is selected; comma-separated, rotated server-side |
| `OPENROUTER_BASE_URL`                        | Optional; defaults to `https://openrouter.ai/api/v1`                 |
| `OPENROUTER_MODEL`                           | Optional legacy default name; an active catalog key or identifier (defaults to OpenRouter's `gpt-4o-mini` when unset) |
| `NVIDIA_API_KEYS`                            | A NVIDIA model is selected; comma-separated, rotated in a separate pool |
| `NVIDIA_BASE_URL`                            | Optional; defaults to `https://integrate.api.nvidia.com/v1`          |

`src/server/env.ts` exports `getServerEnv(scope)`. Validation runs **only when
called**, for the selected scope, not on import. Call it inside the relevant
server service, never at module scope or in the root layout. It rejects invalid
URLs, missing credentials, short authentication secrets, and a key list with no
usable entry (blank entries inside a list are ignored). Surrounding whitespace is
trimmed from URL values, and a missing, blank, or malformed variable is reported as
exactly that — `APP_URL: is not set`, `APP_URL: is blank`, or `APP_URL: must be an
absolute http(s) URL, including the scheme` — instead of a bare `Invalid URL`.
Errors identify fields without
printing their values. Provider URLs have defaults and `OPENROUTER_MODEL` is optional;
API keys have none. The current model is chosen from the server catalog
(`src/server/ai/models/catalog.ts`), never by a reply request body; that entry
selects the provider. A key list is read only for the selected provider and handed
to its isolated server-only key pool. Streaming reuses the same variables: there is
no separate streaming key, endpoint, or model. Absent credentials never break the
build or the stored-message flow: a reply through the unconfigured provider answers
a controlled `AI_NOT_CONFIGURED` error. OpenRouter continues working without any
NVIDIA credential, and the reverse is true for a selected NVIDIA model.

The `server-only` import prevents this module from entering a client component's
import graph. Never use `NEXT_PUBLIC_` for secrets, pass configuration objects to
client components, or put secret values in `next.config.ts`. Vitest mocks only the
Next-specific `server-only` marker so it can exercise the actual validator.

For a future authentication secret, generate your own value locally:

```sh
openssl rand -base64 32
```

For public deployments, configure `APP_URL` to the HTTPS origin. The local default
in the example file is not a production URL.

The other provider URLs keep their documented defaults, so a stray
`OPENROUTER_BASE_URL=` or `NVIDIA_BASE_URL=` line is treated as "not configured"
rather than as a failure. A blank `AUTH_TRUSTED_ORIGINS` means "no extra origins",
and a trailing comma or empty line inside either list is ignored.

### Troubleshooting: `Invalid server configuration (app): APP_URL ...`

`npm start` (or `npm run dev`) reports this on the first request that needs the app
origin — any page that resolves a session, plus the auth and API routes — so the app
is unusable until it is fixed. The response the browser gets is Next.js's generic
error page; the actionable text is in the server log, once per request. Validation is
deliberately lazy (`getServerEnv` runs inside the service that needs it), so a static
build, the test suite, and unrelated tooling never require any of these variables,
which is why the failure appears per request instead of at startup. It covers three
distinct mistakes, each named in the message:

- **No `.env` at all.** Environment files are not committed, so a fresh clone has
  none: run `cp .env.example .env`. Restart the server afterwards — a running
  process does not pick up a newly created or edited `.env`.
- **A blank value.** `APP_URL=`, `APP_URL="  "`, or an empty variable injected by a
  deployment platform is reported as *blank*. Fix the value, not the quoting.
- **A value that is not an absolute URL.** `yorigpt.example.com` (no scheme),
  `localhost:3000`, `$PUBLIC_ORIGIN` (an unexpanded reference), or a leftover
  template placeholder must become `http://localhost:3000` or
  `https://your-real-origin`.

A host that is neither `APP_URL` nor listed in `AUTH_TRUSTED_ORIGINS` is a different
failure: requests from it are rejected with `FORBIDDEN_ORIGIN`, and Better Auth
refuses its callback URLs. Behind a preview proxy, an alias host, or a container
port mapping, either set `APP_URL` to the origin users actually open (generated
verification/reset links then point there as well) or keep `APP_URL` and add the
extra origins, for example `AUTH_TRUSTED_ORIGINS=https://*.e2b.app`.

## Authentication foundation

`src/server/auth/config.ts` is the single Better Auth (1.7.5) configuration, and
`src/server/auth/index.ts` exposes a lazy `getAuth()` singleton used by the
official handler at `/api/auth/[...all]`. `src/server/auth/session.ts` provides the
only session entry points — `getSession()`, `getCurrentUser()`, `isAuthenticated()`,
`requireUser()`, `requireAnonymous()` — request-cached so a page performs one
lookup. Registration, login, email verification, and password reset use
email/password only; passwords are hashed by Better Auth, and tokens are expiring
and single-use.

Pages live in `src/app/(auth)/` (`/register`, `/login`, `/verify-email`,
`/forgot-password`, `/reset-password`) and reuse the shell's tokens and
primitives. The browser boundary is `src/features/auth/` (client, validation, error
mapping, forms); it never reads environment variables or secrets.

Conversations are now user-owned: the API and the `/chat/[conversationId]` page
accept only the authenticated session, and every query is scoped to the current
user, and so are its messages and their replies: writing one stores it in the owning
conversation and returns exactly that row, and the following request streams the
assistant reply for it and stores the finished answer. Without SMTP credentials the
verification/reset emails cannot be delivered — the pages say so explicitly, while
accounts and sessions keep working. See
**[docs/authentication.md](docs/authentication.md)**.

## Database foundation

The PostgreSQL schema defines `User`, `Session`, `Account`, `Verification`,
`Conversation`, `Message`, `AiModel`, and `UserPreferences`, with foundation and
auth migrations plus two catalog seed migrations and a lazy server-only client in
`src/server/db/client.ts`. The server reads and writes owned conversations and
messages; `ai_models` contains seeded catalog rows, and `user_preferences` stores
the account's model, theme, and pet keys. Provider API keys, demo conversations,
pet reactions, and personality instructions are not stored; Better Auth separately
stores password hashes and sessions in its own tables.

Prisma CLI, client, and PostgreSQL adapter are pinned at **6.19.3**. Run
`npm run db:generate` after installation and schema changes; this needs only a
syntactically valid URL, not a live database. Generation is explicit, not a
migration hook. A generated client is needed by TypeScript/unit tests/build.

Database commands:

- `npm run db:generate` — generate the typed Prisma client.
- `npm run db:validate` — validate the schema.
- `npm run db:deploy` — apply committed migrations to the configured database.
- `npm run db:status` — inspect Prisma migration status.
- The auth migration `20260923010000_add_better_auth` is additive: it creates
  `sessions`, `accounts`, and `verifications` only.
- `npm run db:migrate -- --name <name>` — future development schema changes only.
- `DATABASE_TEST_URL=... npm run test:db` — opt-in checks against a disposable, migrated PostgreSQL database.

### Troubleshooting: `The table public.users does not exist in the current database`

The app starts, the static shell renders, but sign-in and registration answer `500`,
and the server log shows `ERROR [Better Auth]`, `Invalid prisma.user.findFirst()
invocation`, and `code: 'P2021'`. This is not a configuration error: `DATABASE_URL`
reaches a real database that has **no tables**, because the committed migrations were
never applied to it. A fresh hosted database (Neon, Supabase, RDS, a new compose
volume) is empty even when migrations ran on your machine, and each environment needs
them applied once:

```sh
npm run db:deploy   # prisma migrate deploy — applies every file in prisma/migrations
npm run db:status   # shows the recorded migration history
```

Two traps in a production-style install:

- **The `prisma` CLI is a devDependency.** If dependencies were installed with
  `--omit=dev` (npm prints `npm warn config production Use --omit=dev instead`),
  `npm run db:deploy` fails with `sh: 1: prisma: not found`. Install with dev
  dependencies for the release step (`npm ci`), or run the pinned CLI on demand:
  `npx prisma@6.19.3 migrate deploy`.
- **Migrations need DDL rights.** Creating enums, tables, and constraints requires a
  role with schema-owner rights on that database. The least-privilege role the server
  runs as cannot apply them, so use a migration credential (for example as a release
  command or one-off job) rather than the runtime one.

To confirm the state without the CLI, ask PostgreSQL directly:
`psql "$DATABASE_URL" -c "select to_regclass('public.users')"` prints `users` once the
schema exists and an empty (`NULL`) value while the database is still unmigrated.
Nothing about the failure is cached in the app, so requests succeed as soon as the
migrations land — no rebuild is needed.

**Sandbox limitation:** standard native Prisma commands still fail to download
engines because TLS to `binaries.prisma.sh` is terminated. Validation, generation,
and migration SQL generation succeeded with a temporary WASM verification config.
The exact SQL was accepted by real disposable PostgreSQL 17.6, and three live
catalog/client checks passed. Native `migrate deploy` and migration-history/drift
verification are **not** claimed as passed; the experimental WASM deploy also
failed and is not used in production configuration.

See **[docs/database.md](docs/database.md)** for model/constraint decisions,
auth compatibility research, migration instructions, pooling, the dependency
advisory, and precise verification limitations. A separate CI job is configured
for clean/repeat native migration deployment, drift checking, and database tests.
No live production database is required to install, typecheck, test, or build.

## Conversation data flow

`src/server/conversations/` owns every conversation query. `service.ts` scopes each
statement to the owner (`WHERE id = ? AND userId = ?`), lists with the
`[userId, updatedAt DESC, id DESC]` index, and never returns a row for another
account; `request.ts` validates the JSON body and the id format; `sidebar.ts` turns
the list into the shell's read model (anonymous / ready / error). The App Router
handlers are `GET|POST /api/conversations` and `GET|DELETE /api/conversations/:id`,
returning `{ conversations, truncated }`, `{ conversation }`, or an
`{ error: { code, message } }` envelope with `Cache-Control: no-store`. Creating a
conversation requires an authenticated session; the server generates the id, sets
`userId` from the session, defaults the title to `New chat`, and rejects any body
that tries to set ownership fields. A conversation the caller does not own answers
exactly like one that does not exist (404), and state-changing requests must come
from a trusted origin (`APP_URL` / `AUTH_TRUSTED_ORIGINS`).

`src/server/messages/` owns stored messages. `GET|POST
/api/conversations/:id/messages` reach the conversation through an owner-scoped
query before touching a row, so another account's conversation answers the same 404
as an unknown id. `POST` accepts exactly `{ "content": string }` (1–4000
characters, trimmed, unknown fields rejected); the server derives the owner from the
session, always stores the role `USER`, and assigns the position inside a
transaction that first updates the parent conversation (activity timestamp for the
sidebar order) — the row lock serializes concurrent writers, and the
`(conversationId, position)` unique constraint turns any remaining race into a
retry instead of a duplicate position. Invalid or oversized input is rejected, never
truncated. The app-owned conversation, message, reply, model, pet, and settings
write parsers bound incoming bytes before trimming or parsing, even if
`Content-Length` is absent or inaccurate; a large padded `{}` cannot start a reply
or save a setting. `GET` returns the stored messages in ascending
position order, capped at 500 with a `truncated` flag. There is no role, admin, bulk,
or assistant-message authorization, and no message editing or deletion yet.

## Assistant replies (OpenRouter and NVIDIA NIM)

`POST /api/conversations/:id/reply` is the **only** generation endpoint — there is no
`/api/chat` and no `/api/providers`. (`GET`/`PUT /api/models` exist, but only to list
the catalog and read or store a preference; they never generate anything, see
[Model catalog and selection](#model-catalog-and-selection).) The reply endpoint takes
no body fields at all: the client may choose the conversation and ask for a reply,
nothing more — the model is resolved on the server from the account's stored
preference. The server
resolves the conversation through the same owner-scoped query used by messages, so a
foreign conversation answers the same 404 as an unknown one, and it generates the
reply for the conversation's **latest stored message**, ignoring any client-supplied
content, role, position, or owner.

The endpoint answers two encodings of the same generation:

- `Accept: text/event-stream` (the browser shell) receives the answer incrementally as
  server-sent events.
- Any other client receives the original JSON answer, `201 { message }`.

Generation lives in `src/server/ai/` and `src/server/messages/reply.ts`:

- `src/server/ai/providers/index.ts` dispatches from the **selected catalog key**
  to its entry's provider, and then to exactly one adapter. No browser request can
  supply a separate provider. OpenRouter and NVIDIA implement the same
  `ReplyProvider` interface without moving orchestration, database logic, or pet
  context into either adapter. OpenRouter remains the default; its adapter now also
  rejects upstream error frames, bounds non-streamed response reads, and discards
  untrusted network error causes that could echo a key.
- Each adapter calls its official OpenAI-compatible
  `POST {baseUrl}/chat/completions` with exactly `{ model, messages, stream }`:
  the `model` identifier comes from that provider's catalog entry, never from a
  browser or an untrusted preference. NVIDIA's hosted endpoint is
  [`https://integrate.api.nvidia.com/v1/chat/completions`](https://docs.api.nvidia.com/nim/reference/llm-apis).
  Its [Llama 3.3 70B NIM API](https://docs.api.nvidia.com/nim/reference/meta-llama-3_3-70b-instruct-infer)
  documents both the model identifier and `data: [DONE]` SSE streaming. Only the
  chosen provider's server-only key signs the request. Each adapter has a 30-second
  overall deadline, a 1 MB response/stream cap, a 16,000-character streaming reply
  cap, and status-only logs — never keys, prompts, authorization headers, or raw
  provider bodies. Failures use the same categories: `timeout`, `aborted`,
  `http-error`, `malformed-response`, `empty-response`, `network-error`, or
  `too-long`.
- `src/server/ai/key-pool/` owns key selection and nothing else: it receives keys
  validated by the env layer, hands them out in deterministic round-robin order, and skips
  a key its provider rejected (401/403) or rate limited (429) for a 30-second cooldown
  before it becomes eligible again. One request tries at most
  `min(configured keys, 3)` keys and never the same key twice, so rotation is bounded
  and a single request cannot hammer a failing key. Only failures another key could
  avoid are retried — malformed, empty, oversized, validation, timeout, and cancelled
  attempts are reported as they are. Streaming rotates only before the first delta is
  forwarded: once the browser has answer text, a failure is reported exactly as
  before rather than splicing two answers together. Cooldown state is per process and
  in memory (never in PostgreSQL) and keyed by **provider plus configured key list**:
  NVIDIA and OpenRouter cannot share a cooldown or cursor even if their configured
  strings happen to match. A 5xx or network failure may retry with another key
  without quarantining it; a non-retryable response, timeout, abort, or an answer
  that has emitted its first delta cannot rotate. Key values never reach a log
  line, SSE event, error message, or client bundle.
- Each adapter owns its upstream SSE framing. Both handle frames split across
  reads (including CRLF and UTF-8 splits), keep-alives, empty and usage-only chunks,
  `data: [DONE]`, and a `finish_reason` marker, forwarding only
  `{ type: "delta", text }` to the reply service. A malformed chunk, explicit
  upstream error frame, `finish_reason: "error"`, or interrupted stream is a
  failure, never a finished answer. Aborting the request cancels the upstream read
  even if the fetch runtime leaves a body pending. No provider payload reaches the
  route or browser; the browser always sees the same `delta`, `done`, and `error`
  events.
- `reply.ts` builds history from the **stored** rows only: newest at most 40 turns
  within 24,000 characters, mapping `USER` → `user` and `ASSISTANT` → `assistant`,
  never accepting a stored `SYSTEM` row as an instruction. It prepends one trusted
  personality `system` message (below) for both JSON and streaming requests, with no
  ids or positions. It then persists only the assistant's finished reply with a
  server-derived role, position, id, and timestamps — never the instruction. A
  transaction-level row lock plus a "latest message unchanged" check means a second
  concurrent request is refused (`400`) rather than storing a duplicate reply, and
  the `(conversationId, position)` unique constraint stays intact.
- `src/server/ai/pet-context.ts` is the **companion context contract**: the only
  information about the user's pet that the AI layer may hold. It is a projection, not
  a passthrough — a catalog pet `id` and `name`, plus a personality `id`, `name`, the
  closed trait vocabulary, and the two optional behavior hints. Deliberately absent:
  the appearance and its palette, the `asset`, `species`, and every catalog
  `description`; raw catalog objects; the `user_preferences` row and `uiPreferences`;
  any account field (user id, email, session, conversation); and any credential,
  environment value, or provider identifier. `resolveAiPetContext(user)` takes the
  session user and nothing else — there is no parameter a request could smuggle a pet
  or personality through, and the reply endpoint already refuses every body field — and
  resolves both values through the existing pet preference service and catalog, so
  there is no second source of truth. A missing, unknown, retired, unavailable,
  malformed, or *incompatible* selection (a personality some other pet offers) degrades
  to the documented defaults, and the personality returned always belongs to the pet it
  is returned with. It reads only the caller's own row, writes nothing — a stale pair is
  resolved, never repaired in passing — and never throws: a companion is context, not a
  requirement, so a failed preference read degrades to the catalog default instead of
  failing a reply. `prepareReply` resolves it beside the history and model key and
  carries it on the prepared reply for both paths. `src/server/ai/pet-instruction.ts`
  accepts only that shape, checks the pet/personality pair against the same catalog,
  and translates its trusted trait tags and motion hint into a short, deterministic
  **style** instruction. No context name, raw catalog object, visual resting state,
  appearance, account data, preference record, or API key enters the instruction.
  The assistant is told to keep tasks accurate, useful, and subject to higher-priority
  and safety instructions; no catchphrase, personality label, or claim to be an animal
  is required. The reply service places this one system message before stored history,
  once per generation before streaming starts. Both adapters still receive only plain
  messages and a catalog model key; neither knows about pets, preferences, or AI style
  rules. Pet changes during a stream cannot change that stream's prepared instruction.

The current catalog produces four distinct but task-first tones from the **existing**
traits and motion hints, not a second personality catalog:

| Personality | Assistant style |
| ----------- | --------------- |
| Calm | Gentle, composed, clear, supportive without unnecessary excitement |
| Playful | Warm and upbeat; occasional harmless playfulness, never a running joke |
| Curious | Interested and exploratory; useful connections or a relevant follow-up, never invented facts |
| Sleepy | Relaxed and low-energy while still answering fully and clearly |

The visual `restingState` hint remains exclusively with the deterministic reaction
engine. The assistant is not instructed to imitate an animal or to mention the pet's
name. Changing the account's selection affects future generations, not stored messages
or a stream already underway.

The SSE protocol is small and documented in `src/features/conversations/types.ts`:

```text
event: delta          event: done                    event: error
data: {"text":"Hi"}   data: {"message":{ …row… }}    data: {"code":"INTERNAL_ERROR","message":"…"}
```

Events carry application data only — assistant text, the stored message, and the same
`{ code, message }` envelope the JSON API uses. Raw provider chunks, model names,
prompts, and credentials are never sent to the browser.

Pre-stream failures stay ordinary JSON with their original status codes, whatever the
`Accept` header: `401` unauthenticated, `403` untrusted origin, `404` for a
foreign/unknown/malformed conversation, `400` for an unsupported body, an empty
conversation, or a turn that already has a reply. Once the stream has started, a
failure is delivered as an `error` event instead: `AI_NOT_CONFIGURED` (no key) or
`INTERNAL_ERROR` (provider or database failure).

**Persistence happens once, after the provider reports completion.** Deltas are
forwarded as they arrive, but a partial answer is never written: a stream that fails,
is truncated, is empty, exceeds the caps, or is cancelled because the browser went
away stores nothing and reports no success. The stored row is the accumulated text,
trimmed, with a server-derived role, position, id, and timestamps, written through the
same transaction and "latest message unchanged" check as before — so a second
generation for the same turn (a duplicate submit, a retry that lost a race, or two
concurrent streams) is refused and still yields exactly one assistant row per user
turn.

## Model catalog and selection

The models a reply can use are owned by the server, in code:
`src/server/ai/models/catalog.ts`. It is a short, explicit list — nothing is fetched
from either provider, and the app boots (and builds, once Prisma is generated)
without a model-API round trip or provider key. Each entry names a stable internal
key, a provider, that provider's documented identifier, a display name, and active
metadata:

| Catalog key              | Provider   | Provider identifier                 | Shown as          | State                |
| ------------------------ | ---------- | ----------------------------------- | ----------------- | -------------------- |
| `gpt-4o-mini`            | OpenRouter | `openai/gpt-4o-mini`                | GPT-4o mini       | active (**default**) |
| `gpt-4o`                 | OpenRouter | `openai/gpt-4o`                     | GPT-4o            | active               |
| `claude-3.5-haiku`       | OpenRouter | `anthropic/claude-3.5-haiku`        | Claude 3.5 Haiku  | active               |
| `claude-3.7-sonnet`      | OpenRouter | `anthropic/claude-3.7-sonnet`       | Claude 3.7 Sonnet | active               |
| `llama-3.1-70b`          | OpenRouter | `meta-llama/llama-3.1-70b-instruct` | Llama 3.1 70B     | retired              |
| `nvidia-llama-3.3-70b`   | NVIDIA NIM | `meta/llama-3.3-70b-instruct`      | Llama 3.3 70B    | active               |

The **catalog key is the only model name the browser ever sees or sends**. The
provider and its identifier are resolved on the server from this list immediately
before generation; an unknown, retired, empty, or raw-identifier value is refused
before any request is made. A retired entry stays in the list (and in the database,
see below) but is never offered, never selectable, and never used. The first five
entries retain their previous provider and catalog order. NVIDIA's
[`meta/llama-3.3-70b-instruct` model](https://docs.api.nvidia.com/nim/reference/meta-llama-3_3-70b-instruct-infer)
is the initial verified NVIDIA-hosted entry; different NVIDIA models may accept
different parameters, so expanding this list is a reviewed code-and-seed change,
not a browser-supplied string.

**Default model, in this order of precedence:**

1. The signed-in account's stored preference, if it names an active catalog model.
2. `OPENROUTER_MODEL`, the existing deployment-default variable, if it matches an
   active catalog entry — by provider identifier (`openai/gpt-4o` or the cataloged
   NVIDIA identifier) or catalog key (`gpt-4o` or `nvidia-llama-3.3-70b`). This
   legacy name is retained to avoid breaking deployments; explicitly setting it
   to a NVIDIA entry is the only way to change the deployment default to NVIDIA.
3. The catalog default, `gpt-4o-mini`.

A preference that no longer resolves (a model retired since it was chosen) is treated
as no preference: the reply uses the next step in that list, and the fallback is
logged once without a credential. `OPENROUTER_MODEL` likewise never invents a model:
a value outside the catalog is ignored with a one-time warning, so a deployment
cannot point the app at an "available" model that the selector cannot show.

**Example NVIDIA default.** Leave `OPENROUTER_MODEL` unset to keep OpenRouter's
`gpt-4o-mini` as the default. To explicitly select NVIDIA for accounts with no
stored preference, set the following server-side variables (supply actual API keys
through a secret manager, not a committed file):

```text
OPENROUTER_MODEL=nvidia-llama-3.3-70b
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
```

`NVIDIA_API_KEYS` is required at reply time for that selection, as a comma-separated
list. An account can also select the NVIDIA catalog key through the existing model
selector without changing the default for anyone else. OpenRouter replies never
need `NVIDIA_API_KEYS`, and NVIDIA replies never use `OPENROUTER_API_KEYS`.

**Preference API.** `GET /api/models` returns the active models (key, name, short
description) and `selectedModelKey`; `PUT /api/models` accepts exactly
`{ "modelKey": "<catalog key>" }` and answers `{ "selectedModelKey": "…" }`. Both
require a session, and the stored row is keyed by the authenticated session — a
request cannot name, read, or write another account's preference. `PUT` also requires
the same trusted-origin check as every other write. Malformed JSON, an oversized
body, a missing or non-string key, an unexpected field, an unknown key, and a retired
model are all `400` with the standard `{ error: { code, message } }` envelope;
unauthenticated is `401`, an untrusted origin is `403`. No raw provider identifier,
provider field, credential, key-pool state, or environment configuration is
serialized. `src/server/ai/models/request.ts` holds the strict body parsing and
`src/server/ai/models/view.ts` the read model the chat header renders; both are
server-only.

**Storage.** The preference is the existing `user_preferences.preferredModelId`
column, which already references `ai_models` with `onDelete: SetNull`. The migration
`prisma/migrations/20260923020000_seed_ai_models` inserts the five OpenRouter rows;
`prisma/migrations/20260924000000_seed_nvidia_model` adds one NVIDIA row. Both use
stable ids equal to catalog keys and idempotent `ON CONFLICT (id) DO UPDATE` inserts.
The existing `ModelProvider` enum already includes NVIDIA: this second migration
adds **data only** — no schema change, new table, enum value, index, or runtime
catalog discovery. The row is required for the `preferredModelId` foreign key to
accept the NVIDIA key; apply both seed migrations in deployments. The app does not
read the table to decide what to offer. If a seed was skipped, storing that model's
preference answers a controlled `400`; replies can still resolve catalog models.

**From selection to provider.** The reply flow resolves the model once per turn:

```text
session user → stored catalog key (or default) → active catalog entry
  → entry.provider → ReplyProvider adapter → entry.modelIdentifier
```

`resolveReplyModelKey(userId)` gets the key from that authenticated user's existing
preference, falling back according to the precedence above. `prepareReply` carries
it alongside the typed `petContext`; the shared message builder sends only the
code-owned instruction derived from that context, never the context object. The
provider dispatcher in `src/server/ai/providers/index.ts` maps the entry's provider
to an adapter; the chosen adapter independently re-checks that the key is active and
belongs to *that* provider before it touches its isolated key pool. The client
cannot select a provider separately from the catalog entry. Both the JSON path and
the SSE path use this resolution, so a stream and a plain reply for the same key
cannot disagree. Key rotation is independent of model choice *within* each
provider: OpenRouter models still share the same `OPENROUTER_API_KEYS` pool; NVIDIA
models share only the `NVIDIA_API_KEYS` pool, with the same bounded attempt and
cooldown semantics.

**Chat history is not affected.** No table, column, or row records which model
produced a reply — the change applies to future generations only. A stored
conversation keeps loading exactly as before, and switching models never rewrites it.

## Settings and theme preference

`/settings` is an authenticated page: an anonymous visitor is redirected to
`/login` by the same `requireUser()` guard the conversation routes use, so no
settings data is ever rendered for someone who is not signed in. It is reached from
the settings control in the sidebar's account area (desktop and mobile dialog), and
it shows two sections:

- **Appearance** — the theme preference, one of three values.
- **Account** — the signed-in account's name (or `Not provided`), email, and email
  verification status. All three are **read-only**: nothing on this page edits the
  name, the email, or the password, and there is no account deletion, billing, or
  usage information.

| Wire value | Stored as (`user_preferences.theme`) | Behavior                                            |
| ---------- | ------------------------------------ | --------------------------------------------------- |
| `system`   | `SYSTEM`                             | Follows the device's `prefers-color-scheme` (**default**) |
| `dark`     | `DARK`                               | Always the dark palette                              |
| `light`    | `LIGHT`                              | Always the light palette                             |

**Default theme.** `system`, which is the Prisma default of
`user_preferences.theme` in the existing schema (`ThemePreference @default(SYSTEM)`).
An account with no `user_preferences` row and one whose row was created by another
feature — choosing a model writes the same row — therefore resolve to the same
theme. Because `system` follows the device, an account that has never chosen a
theme sees the light palette on a light-preferring device: the single dark palette
of the earlier steps is still what `dark` (and `system` on a dark device) renders,
and no rule of the dark design changed — see the verification note below.

**Persistence.** PostgreSQL is the only source of truth. `PUT /api/settings`
upserts the caller's `user_preferences.theme`; the root layout then reads that
value per request and renders it as `data-theme` on `<html>`, so the choice survives
a reload, a new tab, a logout/login, and navigation, and applies on every route.
Nothing is kept in `localStorage`. A tiny inline script in `<head>` — before the
first paint — resolves `system` into `data-color-scheme` and keeps following the
device while the preference is `system`; `src/app/globals.css` keys both palettes
off those two attributes, so there is no flash of the wrong theme on load and no
new theme framework. Saving also applies the confirmed value in the current tab, so
the page does not wait for a reload.

**Settings API.** `GET /api/settings` returns the non-sensitive settings the UI
needs — `{ "theme": "…", "account": { "name", "email", "emailVerified" } }` — and
`PUT /api/settings` accepts exactly `{ "theme": "system" | "dark" | "light" }`,
answering `{ "theme": "…" }`. Both require a session; the stored row is keyed by the
authenticated session, and the API never accepts a user id from the client, so a
request cannot read or write another account's preference. `PUT` also requires the
same trusted-origin check as every other write. An unknown field (including
`userId`), a missing or non-string theme, an invalid theme value, malformed JSON, a
non-JSON body, and an oversized body are all `400` with the standard
`{ error: { code, message } }` envelope; unauthenticated is `401`, an untrusted
origin is `403`. No password hash, session token, API key, provider configuration,
internal identifier, or other column of `user_preferences` is ever serialized.

**Server layout.** `src/server/settings/` owns the feature: `theme.ts` maps the wire
values onto the existing enum, `service.ts` reads and writes the preference (and
resolves the default) through the shared Prisma client, `request.ts` holds the
strict body parsing, and `view.ts` is the read model the page and the API render.
No Prisma call is made from a component or a route handler, no new table or column
was added, and only the `theme` column is written — the model, pet, and UI
preference columns of the same row keep their values.

**Scope.** The persisted settings are the theme and the pet companion (its selection,
appearance, and personality). Account editing, password or email changes, account
deletion, billing, and usage tracking do not exist and are not stubbed. Pet
*personalities* are catalog-defined behavior metadata: they are stored, displayed, and
drive a small **local, deterministic** reaction engine. That engine follows the real
chat lifecycle and never calls an AI provider. The separate server-side builder reads
the same metadata to influence generated reply style (see the next section).

## Pet framework

A small, reusable foundation for interactive 2D companions, kept entirely inside
`src/features/pets/` (plus a thin server preference service) so chat components never
hold pet logic. It is deliberately a *framework*: types, catalog, state vocabulary, a
renderer, lightweight CSS animations, a persisted per-account selection, appearance,
and personality, and a deterministic local reaction engine that follows the chat
lifecycle — the visual framework itself makes no AI requests and has no finished
artwork.

- **Architecture.** `types.ts` declares the domain (`id`, `name`, `species`,
  `description`, `defaultPersonality`, `available`, an abstract `asset` reference, a
  list of catalog-defined `appearances`, and a list of catalog-defined
  `personalities`). `catalog.ts` is the single list of pets plus `findPet` /
  `listAvailablePets` / `resolvePet` (which falls back to an available default instead
  of throwing), the appearance helpers `listAppearancesForPet` /
  `defaultAppearanceForPet` / `findAppearanceForPet` / `isSelectableAppearance` /
  `resolveAppearanceForPet`, and the matching personality helpers
  `listPersonalitiesForPet` / `defaultPersonalityForPet` / `findPersonalityForPet` /
  `isSelectablePersonality` / `resolvePersonalityForPet`.
  `state.ts` holds the state vocabulary; `animations.ts` holds what each state looks
  like (two CSS classes plus whether it moves), so behavior, vocabulary, and markup
  stay in separate files. `components/` has the presentational `PetRenderer`, the
  inline `shapes.tsx` silhouettes, and the client `PetPlayground`.
- **Initial catalog.** Three placeholder companions — Yori the cat and Ember the fox
  are available; Pip the rabbit is kept with `available: false` to prove the
  availability filter. All are drawn from simple, original inline SVG (no copyright
  characters, no external or generated assets).
- **State vocabulary.** `idle`, `happy`, `thinking`, `sleeping`, `sad`, `excited`.
  Each maps to a distinct pose and, where it has one, a CSS keyframe; `sad` is a
  still pose so nothing depends on motion.
- **Appearances.** Each pet declares a small, catalog-defined list of appearances —
  a stable `id`, a human-readable `name`, an optional short `description`, and a
  `palette` from a fixed code-owned set (`classic`, `night`, `moss`, `ember`,
  `frost`). The catalog is the single source of truth: `listAppearancesForPet` lists
  them, `defaultAppearanceForPet` returns the first (always present, so a pet with no
  alternate still has a valid default), `isSelectableAppearance` allows an id only for
  an available pet that lists it, and `resolveAppearanceForPet` maps a missing,
  unknown, or other-pet id back to that pet's default. Appearances are intentionally
  small and safe — no arbitrary CSS, no external or user-uploaded assets; the palette
  only re-tints the existing silhouette through CSS variables. Only the appearance
  `id` is ever sent by a client or stored.
- **Personalities.** A personality is a **behavior definition, not an AI prompt**. Each
  one is catalog-defined with a stable `id` from a closed set (`calm`, `playful`,
  `curious`, `sleepy`), a display `name`, a one-line `description`, a few tags from a
  fixed trait vocabulary (`gentle`, `energetic`, `inquisitive`, `restful`, `sociable`,
  `independent`), and optional tiny `hints` (`restingState`, `motionLevel`) that the
  reaction engine reads as behavior metadata. No prompt text, no asset or URL, and
  nothing a client can supply.
  Definitions live in one library in `catalog.ts` that pets reference, so a personality
  is written once; each pet offers a small subset and declares exactly one default
  (Yori: calm/sleepy/curious, Ember: curious/playful, Pip: playful/sleepy but never
  selectable). `isSelectablePersonality` allows an id only for an available pet that
  lists it, and `resolvePersonalityForPet` maps a missing, unknown, or other-pet id
  back to that pet's default. Personalities drive the local reaction engine below
  through exactly that metadata — the trait tags and the two hints — which is what makes
  the four of them observably different on the same event. The server also interprets
  the traits and motion hint into an AI style instruction for *future* replies; no raw
  personality definition or visual reaction is forwarded or persisted as a prompt.
- **Behavior & reactions.** `reactions.ts` is a pure engine: it takes a pet, a
  personality, an application event, and the current state, and returns one of the six
  **existing** states plus an optional settle duration. No React, no timers, no network,
  no database, no AI — the same inputs always give the same output, which is what makes
  it testable with synthetic events. The vocabulary is deliberately small: `idle`,
  `user-started-message`, `thinking`, `response-started`, `response-completed`,
  `response-error`, `cancelled`, `successful-action`. Personality enters only as a
  **temperament** read from the catalog definition — *expressive* (a `high` motion level
  or the `energetic` trait), *sociable*, *inquisitive*, and a *resting* state — so no
  personality id appears in the engine and a fifth personality would behave from its own
  metadata with no code change. With the catalog as it stands that gives four
  distinguishable companions (calm / playful / curious / sleepy): a new message is
  `happy` / `excited` / `thinking` / `happy`, waiting for an answer is `thinking` /
  `happy` / `thinking` / `sleeping`, a good outcome is `happy` / `excited` / `excited` /
  `happy`, and a cancellation is `idle` / `idle` / `idle` / `sleeping`. Three things
  deliberately do not vary, because varying them would misinform: `response-error` is
  always `sad`, `thinking` always reports real processing, and a cancellation is never a
  positive reaction. Where no existing state is an exact match the closest one is used
  and documented in the mapping (`response-started` → `thinking` for a personality that
  rests at attention, since there is no "attentive" state). All of it is local and
  deterministic — no randomness, no timers inside the resolver, nothing persisted, and
  no provider calls or prompt construction inside the visual reaction engine.
  `use-pet-behavior.ts` is the client-side controller that owns the only mutable parts:
  the current state, a **single** settle timer, and an unmount guard. State is derived
  rather than synced — a reaction is stored with the pet and personality that produced
  it, so changing either settles the pet with no effect and no stale value. The
  "current state" the mapping reads is derived from that same record, never from a
  second mirror, so a state left behind by one selection cannot be inherited by the
  next (a dozing record from a sleepy personality cannot put a calm pet to sleep), and
  the unmount guard covers the setters as well as the timer: a dispatch that outlives
  its component writes nothing and schedules nothing. Nothing is persisted: mood,
  temporary state, and reaction history never reach the database.
  `CHAT_PHASE_REACTIONS` maps the chat lifecycle onto the same vocabulary, so neither
  side grows a second event system.
- **Chat reactions.** `features/chat/pet-reactions.ts` is the only bridge between the
  two. The shell reports what actually happened — a message was stored, a reply request
  was issued, the first provider text arrived, and then exactly one outcome — and the
  adapter turns each report into one event from the vocabulary above. A reporter is
  created per generation, which is what keeps one reply to one coherent sequence: the
  first-content event is reported once however many deltas arrive, and once an outcome
  has been reported no other can follow, so a cancelled or failed generation can never
  be celebrated by a late callback. A stream replaced by a retry or by navigation
  reports nothing at all, and a message the server refused never reports anything. The
  companion is drawn in the chat header while a conversation is open — never beside the
  welcome mark, so a page carries exactly one accessible pet name — and it is not a live
  region, so reactions are seen and never announced. None of it is persisted, and none
  of it reaches a provider request, a prompt, or the database.
- **Chat reaction lifecycle.** The shell keeps the generation it is reading in one ref:
  the request's `AbortController` together with the reporter scoped to it, so the two
  always end in the same step and a generation that is no longer current has no route
  back to the pet or to the shell's state. A generation *replaced* by a newer one (a
  retry, or a second submit that won the race) is sealed silently — the replacement
  announces its own `thinking` and stays authoritative — while a generation *abandoned*
  with nothing taking over (switching conversation, or leaving the page) reports
  `cancelled`, so the companion settles instead of waiting forever for an answer that
  will not arrive. Deltas and outcomes from a stream the shell has already dropped are
  ignored, a message that finishes being stored after the user moved on does not start a
  reply for a conversation that is no longer open, and every terminal path — success,
  provider error, cancellation, navigation, replacement, unmount — leaves the pet either
  settled or following the generation that is really in flight. No timer, retry rule, or
  second reaction state was added to the chat component to achieve this.
- **Renderer.** `<PetRenderer pet appearance personality state size className label />`
  renders any catalog pet at `sm`/`md`/`lg`, exposes one stable accessible name
  (`role="img"`, e.g. "Yori, a cat"), marks the drawing `aria-hidden`, and carries the
  state as `data-state`, the resolved appearance palette as `data-appearance`, and the
  resolved personality as `data-personality` — it is not a live region, so a mood,
  appearance, or personality change never announces itself. A missing or invalid
  appearance or personality resolves to the pet's default. The personality attribute is
  a passive hook for future behavior tasks: it changes no pose, animation, or label. An
  unavailable or malformed pet degrades to a labelled placeholder rather than throwing.
  It is pure presentational React: no timer, effect, network, or storage.
- **Animations & reduced motion.** Idle breathing, a happy bounce, a thinking
  head-tilt with thought dots, a sleeping doze with drifting `z` marks, and an
  excited wiggle with sparkles — all plain CSS keyframes under
  `@media (prefers-reduced-motion: no-preference)`. With reduced motion the movement
  stops but every mood is still drawn as a static pose.
- **Persistent selection.** `src/server/pets/service.ts` reads and writes the
  existing `user_preferences.selectedPetKey` column (no new table, no migration): it
  returns the stored, still-available key or the catalog default, and only persists a
  key the catalog marks available, keyed by the authenticated user. It reuses the
  shared catalog for validation and never duplicates it. Exposed as a nested member
  of the settings API — `GET /api/settings/pet` answers `{ "pet": "<key>" }`,
  `PUT /api/settings/pet` accepts exactly `{ "pet": "<key>" }` — with the same
  session, trusted-origin, and `{ error: { code, message } }` conventions as the theme
  endpoint, and the same strict "exactly one known field" parsing. The theme endpoint
  (`GET/PUT /api/settings`) is unchanged.
- **Persistent appearance.** The chosen appearance is stored as a single stable key
  inside the existing `user_preferences.uiPreferences` JSON object (property
  `petAppearance`) — no new column, table, or migration. `savePetAppearance` validates
  the id against the user's *currently selected* pet (so an id from another pet, an
  unknown id, or an unavailable pet is refused), writes only that property, and leaves
  `selectedPetKey`, `theme`, and any other `uiPreferences` values intact; reads resolve
  an invalid stored value back to the pet's default. Exposed as a nested member of the
  pet settings API — `GET /api/settings/pet/appearance` answers
  `{ "pet": "<key>", "appearance": "<id>" }`, `PUT` accepts exactly
  `{ "appearance": "<id>" }` — with the same session, trusted-origin, and error
  conventions. The separate selection route (`GET/PUT /api/settings/pet`) keeps its
  exact `{ "pet" }` shape.
- **Persistent personality.** Stored the same way, beside the appearance: one stable
  catalog key (`petPersonality`) inside the same `uiPreferences` JSON object — again no
  new column, table, or migration, and never the personality object, its traits, or
  anything resembling a prompt. `savePetPersonality` validates the id against the
  user's *currently selected* pet (so an id from another pet, an unknown id, or an
  unavailable pet is refused), writes only that property, and leaves `selectedPetKey`,
  the stored appearance, and every other preference intact; reads resolve an invalid
  stored value back to the pet's default. Exposed as `GET/PUT
  /api/settings/pet/personality` — `GET` answers `{ "pet", "personality" }`, `PUT`
  accepts exactly `{ "personality": "<id>" }` — with the same session, trusted-origin,
  and error conventions. Selection, appearance, and personality stay logically separate
  routes.
- **`/pets` playground.** A public page that shows the available pets, the current
  selection, and appearance/personality/state/size controls driving the renderer. The
  appearance and personality controls list only what the selected pet offers and switch
  to that pet's default when the pet changes to one that lacks the current choice; the
  chosen personality is also stated in plain text under the pet. A signed-in visitor is
  shown their stored companion, appearance, and personality, and choosing any of them
  saves it optimistically (drawn immediately, confirmed by the server, rolled back with
  a short note on failure — no spinner); reloading keeps all three. An anonymous visitor
  gets the full playground but the choices stay in the tab and never touch the database.
  A small **Reaction demo** dispatches the synthetic events (`User Message`,
  `Start Thinking`, `Response Started`, `Response Complete`, `Response Error`, `Cancel`)
  straight into the local behavior engine so the personality mapping and the settle
  timing are visible; `Response Started` is there beside `Start Thinking` because a wait
  is where the personalities differ most, while processing looks the same on all of them.
  Under the demo, one read-only line resolves the last event against **every** personality
  the selected pet offers and marks the chosen one, so the differences can be compared
  without switching back and forth — plain text, not a live region, and no new page or
  dashboard. Mood and size stay manual controls. Both paths write nothing at runtime —
  mood, temporary state, and reaction history are never persisted.
- **Chat integration.** The empty-state companion beside the welcome mark is the
  signed-in user's stored pet, appearance, and personality (the catalog defaults for
  anonymous visitors), loaded server-side and passed down as props — the chat stores
  nothing pet-related itself. While a conversation is open the same companion appears
  in the header and reacts to the real reply lifecycle; that route loads the same
  stored selection and personality keys, so the header pet and the empty-state pet
  cannot disagree. Reply preparation resolves the companion separately on the server
  for one compact AI style instruction, while the chat keeps using the deterministic
  visual reaction engine. No client instruction construction, model-dependent pet
  logic, sentiment engine, new states, or reaction persistence is introduced.
- **AI context contract.** `src/server/ai/pet-context.ts` narrows the stored companion
  to the only fields the AI layer may hold: pet `id` and `name`, personality `id`,
  `name`, `traits`, and the two optional `hints`. It is resolved **server-side** from
  the authenticated account's own preferences through the same service and catalog the
  pages use, always as a compatible pet/personality pair, and it degrades to the
  catalog defaults for a missing, unavailable, or stale selection. No appearance,
  palette, description, preference row, account field, or credential is part of it, and
  nothing a browser sent is read — the reply endpoint refuses every body field, and the
  resolver has one parameter: the session user. The new instruction builder interprets
  only its catalog-checked metadata into tone and task-first guidance; it does not
  change the resolver or the reaction engine. Both provider request formats remain
  `{ model, messages, stream }`, now with one server-generated `system` message ahead
  of the same stored conversation turns.

## Architecture

```text
src/
├── app/                   # App Router: layout, chat shell route, global CSS
├── components/
│   ├── ui/                # Original icons and accessible icon buttons
│   ├── layout/            # Interactive shell and sidebar
│   └── chat/              # Empty state, model selector, messages, composer
├── features/
│   ├── auth/              # Browser auth client, validation, error mapping, forms
│   ├── chat/              # Explicitly local presentation data
│   ├── models/            # Model-selector wire types and browser call
│   ├── settings/          # Theme vocabulary, browser call, theme attribute, page form
│   └── pets/              # Pet types, catalog, state, animations, renderer, playground, client
├── server/
│   ├── env.ts             # Lazy, scoped, server-only environment validation
│   ├── api/               # Shared JSON envelope and request-origin checks
│   ├── auth/              # Better Auth config, lazy instance, session helpers
│   ├── conversations/     # Owner-scoped conversation queries and request parsing
│   ├── messages/          # Owner-scoped message queries, reply generation
│   ├── pets/              # Pet preference read/write over selectedPetKey, request parsing
│   ├── settings/          # Theme vocabulary, preference read/write, request parsing
│   ├── api/               # JSON envelope, origin guard, SSE framing
│   ├── db/                # Lazy server-only Prisma client boundary
│   ├── email/             # Server-only SMTP adapter for auth links
│   └── ai/                # Server-only reply provider boundary
│       ├── providers/     # Catalog dispatcher, OpenRouter + NVIDIA NIM adapters
│       ├── key-pool/      # Provider-scoped round-robin rotation and cooldowns
│       ├── models/        # Server-owned provider/model catalog and preferences
│       ├── pet-context.ts # Narrowed, resolved companion contract
│       └── pet-instruction.ts # Shared, server-only AI style instruction builder
└── lib/                   # Reserved for shared, non-secret utilities
prisma/                    # PostgreSQL schema and model seed migrations
tests/                    # Vitest unit tests and Playwright browser checks
```

`src/server/auth/`, `src/server/email/`, `src/server/conversations/`,
`src/server/messages/`, `src/server/settings/`, `src/server/ai/` (provider boundary,
key pool, and model catalog), `src/features/models/`, `src/features/settings/`, and
`src/features/pets/` + `src/server/pets/` (the pet framework, `/pets` playground, and
persistent per-account pet selection)
are implemented.
Routes remain thin; future domain behavior
belongs in feature modules and server services. Database access and provider
secrets must remain under server boundaries. No additional backend service, state library, UI kit, or
provider SDK is needed. Playwright remains a development dependency; the database
step added the Prisma client and PostgreSQL adapter, and the authentication step
added exactly two runtime dependencies: `better-auth` and `nodemailer`. The reply
step added **no dependency at all**: the adapter uses the platform `fetch`.

`src/app/globals.css` provides the dark palette — the original design, unchanged —
plus a light palette behind the theme preference (see
[Settings and theme preference](#settings-and-theme-preference)), system typography,
spacing/radius tokens, responsive baseline rules, visible keyboard focus, and
reduced-motion handling. Colors are defined once as CSS custom properties and
referenced as `rgb(var(--tint) / …)` / `rgb(var(--accent-rgb) / …)`, so every rule in
the file — including the ones written as literal colors earlier — follows the palette
named by `data-color-scheme` on `<html>`. These support the shell; no proprietary
assets or external font requests are used.

## Verification and tooling limitations

**Task 24 verification in this restricted sandbox (2026-09-24):** `npm ci`,
`npm run lint`, and — after generating the ignored Prisma client with a *temporary*
config using Prisma's bundled WASM schema engine — `npm test` (704/704),
`npm run typecheck`, and `npm run build` pass. The unchanged native
`npm run db:generate` still fails downloading its engine checksum due to a TLS
disconnect. Before the temporary generation, `npm test` reproduced the eight known
Prisma-stub failures (678/686 passed), and typecheck/build showed the same 31
Prisma-client errors. The WASM config was removed after generation; no schema,
dependency, or runtime configuration was changed. A mocked route-to-provider-to-SSE
smoke test passes for OpenRouter rotation/failure and NVIDIA JSON, but no live provider
was called. `DATABASE_TEST_URL` is unset; Playwright lists 81 tests but no browser
executable is available, so neither DB integration nor Playwright was run for Task 24.

**Environment-configuration fix verified end to end in this restricted sandbox
(2026-09-24):** the Prisma client was generated by satisfying the CLI's schema-engine
preflight with a stub path (the bundled WASM engine does the actual work; the native
download still fails on TLS to `binaries.prisma.sh`). With the client present,
`npm test` passes **711/711 across 50 files** (7 of them new: missing/blank/malformed
`APP_URL`, whitespace trimming, origin-list entries, blank email and provider base
URLs), and `npm run lint`, `npm run typecheck`, and `npm run build` pass. The built
app was then served with `npm start` against disposable PostgreSQL 18.4 using the
uncommitted local `.env`, with the committed migrations applied by executing
`prisma/migrations/*/migration.sql` directly (native `migrate deploy`/`db:status`
remain blocked by the same download limitation): `/` and `/login` answered 200,
`/api/auth/sign-up/email` created the user, account, and session rows, and Better Auth
answered 403 `INVALID_ORIGIN` for an unlisted origin while accepting one from
`AUTH_TRUSTED_ORIGINS`. Serving with a blank `APP_URL` reproduced the reported failure
and logged the new message (`APP_URL: is blank; …`) in place of `APP_URL: Invalid URL`.
Playwright was not run (no browser executable); no live AI provider, SMTP server, or
production database was contacted.

**Unmigrated-database diagnosis verified in the same sandbox (2026-09-25):** two
databases were served by the same build, one migrated and one left empty. Against the
empty database, sign-in reproduced the report exactly — HTTP `500`,
`Invalid prisma.user.findFirst() invocation`, `The table public.users does not exist in
the current database`, `code: 'P2021'` — and the same query returned `null` (a normal
"no such account") after the migration SQL was applied, with the endpoint answering
`401` instead of `500` without a restart. `npm test` (711/711), `npm run lint`,
`npm run typecheck`, and `npm run build` were re-run in the rebuilt sandbox and pass.
The `--omit=dev` trap was reproduced directly: with the dev-only CLI removed,
`npm run db:deploy` fails with `sh: 1: prisma: not found`, while
`npx prisma@6.19.3 migrate deploy` resolves the pinned CLI (its engine download is
blocked here by the same `binaries.prisma.sh` TLS limitation, not by the command).

The following database and browser coverage was verified during earlier steps in an
environment where the Prisma client and disposable PostgreSQL were available, not
re-executed for Task 23 in this sandbox: **87 database checks** (13 streaming reply
+ 16 reply + 9 message + 13 conversation + 9 settings + 6 pets + 9 model preference + 9 auth + 3 structure)
against disposable PostgreSQL 17.6,
including registration, duplicate-email rejection, session creation, expired
verification tokens, single-use password reset, the conversation ownership matrix
(owner-scoped list order, foreign/unknown ids answering the same 404, and deletion
that cannot cross accounts), the message matrix (owner-only read and write,
server-assigned roles/positions, activity-timestamp updates, unique positions under
concurrent writers, and invalid input writing no rows), and the assistant-reply matrix
(owner-only generation, the same 404 for foreign and unknown conversations, a
provider failure that stores nothing, `AI_NOT_CONFIGURED` without a key, empty
responses that are never stored, duplicate and racing requests refused, and
client-supplied fields rejected), plus the streaming matrix (an SSE response with the
right content type, several deltas and exactly one `done` carrying the stored row,
the persisted text equal to the accumulated deltas, no provider field or credential in
any event, an `error` event with no row for a failed, empty, or truncated stream, no
row when the client disconnects mid-stream, and the unchanged JSON contract for
clients that do not ask for a stream), and the model preference matrix (the seeded
catalog rows, a preference that points at no model refused by the foreign key, an
anonymous request refused, one account's stored choice untouched by another's
request, and unknown/retired/identifier/malformed/unexpected-field bodies writing
nothing), and the settings matrix (a signed-out read/write refused, the documented
default with no preferences row, the enum column rejecting a value outside it, a row
created by the model preference keeping the default theme, one account's stored theme
untouched by another's request, a theme change that updates the existing row and
leaves its other columns alone, and invalid/malformed/unexpected/user-id/anonymous/
untrusted-origin bodies writing nothing), and the pets matrix (the catalog default with
no stored row, a valid available pet written to `selectedPetKey` for that user only,
unavailable/unknown/unexpected/user-id/malformed/untrusted bodies writing nothing, a
pet change leaving the theme and model columns of the same row alone, and one account
unable to write another's stored pet). Unit tests also cover the adapter's framing
(split frames, split UTF-8, CRLF, keep-alive comments, `[DONE]` and `finish_reason`
completion, HTTP failures, timeouts, cancellation, network failures, empty streams,
size caps, early consumer cancellation), the key pool (round-robin order, cooldown and
re-eligibility, exhausted and empty configurations), key rotation in the adapter (401,
403, 429, 5xx, and network retries, non-retryable and cancelled attempts that must not
rotate, the attempt ceiling, a quarantined key being skipped, and keys staying out of
errors and logs), the browser reader (incremental callbacks, `done` reconciliation,
`error` mapping, interruption, abort), and the model system (catalog lookup and
selectable/inactive filtering, rejection of unknown, retired, and raw-identifier
values before any request, default resolution from `OPENROUTER_MODEL` with a
warn-once fallback, the migration's seed rows matching the catalog, the preference
service's scoping and fallbacks, the strict `PUT` body parsing, the route's status
codes and wire shape, the selection client's error mapping, and the selector's
rendered states), and the settings system (the wire-vocabulary maps including
prototype-pollution keys, default resolution with and without a preferences row, the
service's per-user reads and upserts, the strict request parsing and its status
mapping, both route handlers' auth, origin, and body validation, the browser call's
payload and error mapping, the theme resolver and the inline bootstrap script's
resolution of `system`, the root layout's rendered attributes, and the settings
page's rendered sections), and the pet system (unique catalog ids and required
metadata, the availability filter, safe lookups and fallbacks, the state vocabulary
and its fallback, a distinct treatment per state with at least one still pose, the
renderer's accessible label, size variants, `data-state`/`data-motion` attributes, and
labelled placeholder for an unavailable or malformed pet, plus the pet preference
service's default/invalid/unavailable/per-user resolution, the `/api/settings/pet`
route's auth, origin, and strict-body handling, and the selection client's payload and
error mapping), and the local reaction engine (every event's deterministic mapping for
every personality the catalog offers, repeated calls returning identical results, each
pair of personalities differing on the *intended* events rather than merely on some
event, while a failure, real processing, and an explicit settle stay identical for all
of them, the temperament rules re-derived from the catalog metadata instead of restated
as per-personality expectations, a cancellation never turning positive for any
personality or current state, missing, invalid, and other-pet pet/personality input
falling back without throwing, `idle` holding, an error reaction never being positive,
the resolver scheduling no timer and consulting no clock, no randomness, and nothing
outside its arguments, the chat-phase seam, and the behavior
controller's dispatch, settle-to-idle, reset, per-pet and per-personality resolution
with no stale reaction, and a settle timer that cannot fire after unmount), the AI
companion-context contract (the exact fields it narrows two catalog definitions to and
the ones it refuses — appearance, palette, species, descriptions, preference rows,
account fields, credentials — plus a guard that rejects every wider shape, server-side
resolution of a stored, missing, unavailable, malformed, and cross-pet selection, the
invariant that the personality always belongs to the pet it is returned with across
every stored combination the catalog can produce, one account's companion never
appearing in another's, an anonymous caller resolving to the catalog default with no
row read at all, a smuggled pet, personality, or credential changing nothing, no write
while building context, and a failed preference read degrading instead of throwing),
the reply flow resolving that context beside the history and model key while the
serialized provider body still carries only a model, turns, and the stream flag, the
reply endpoint still refusing a body that claims a pet or personality, and the provider
adapter's own source importing nothing pet- or database-related), and the
chat integration (each lifecycle moment producing its documented event, a reporter
reusing the existing phase mapping and emitting nothing outside the vocabulary, the
first-content event reported once for many deltas, a completed, failed, or cancelled
generation unable to report a second outcome, and guards scoped to one generation
rather than to the caller). The same wiring is covered against the real shell in jsdom:
the companion appearing only for an open conversation, `thinking` once the reply request
is genuinely issued, the first delta reaching the renderer, a completed stream
celebrating and settling, an error showing `sad`, a cancellation settling rather than
sulking (and a dozing companion staying asleep through it, per the engine's documented
rule), a refused message reporting nothing at all, a personality change mid-generation
carrying no stale reaction, and the composer's own error display left intact. The
lifecycle edge cases are covered against that same real shell: two overlapping
generations (a retry clicked twice before React re-renders) with the replaced request
provably aborted, its late deltas kept out of the reply on screen, and its late success
or failure changing neither the companion nor the stored thread; a retry after a
provider error getting a clean `thinking → response-started → completed` sequence of its
own with nothing inherited from the failure; cancellation, and a completion or an error
arriving after it; switching conversation mid-generation, which settles the companion
instead of leaving it thinking, keeps the abandoned stream's success and failure out of
the next conversation, and leaves that conversation fully usable with a fresh
lifecycle; a message that finishes being stored after the user left, which never starts
a reply for a thread that is not open; unmounting mid-generation, which aborts the
request and schedules no timer afterwards; pet and personality changes before, during,
and after a reaction, including a settle timer left pending by the previous selection;
and the header companion itself — drawn exactly once for an open conversation, absent
from the welcome state, never duplicated by streaming or a route change, keeping one
accessible name, no live region, the same element and footprint across reactions, and a
pose for every reaction so nothing depends on motion. The behavior controller is
additionally checked for the two things only a real mount can show: that a state left by
one pet or personality is never read as the next one's current state, and that its
dispatch, hold, and reset are ignored once it is gone. The playground is mounted in
jsdom for the same reason, so the reaction demo is covered where it can actually run: a
dispatched event reaching the renderer and the note, the read-only comparison listing
exactly the personalities the selected pet offers with the chosen one marked, that
listing staying readable after a temporary reaction settles and giving way to the manual
state controls, no live region anywhere on the page, and an anonymous visitor's choices
and reactions performing no `fetch` at all. The browser suite drives the selector end to end: the catalog it
lists, a stored choice surviving a reload and a second conversation, the identifier
the stub receives for the default and for two other selections (including a streamed
rotation), two accounts keeping separate choices, and a raw provider identifier
refused by the API. It drives the settings page the same way: the stored theme it
displays, dark/light/system each painting their palette (system following an emulated
device change), a choice surviving a reload, navigation, and a second account, the
signed-out redirect, the API refusing an untrusted origin and every invalid body, the
chat and model features still working with a stored theme, and the sidebar's settings
link on desktop and in the mobile dialog. It drives the pet playground the same way:
the available pets it offers and the unavailable one it hides, selecting a pet
changing the renderer, switching state and size changing the renderer, keyboard
operation of the controls, reduced motion removing the movement while the pose
remains, a signed-in user's choice persisting across a reload, an anonymous choice
staying local and never reaching the database, the reaction demo changing the pose for
each synthetic event and settling back to idle while a high-motion personality reacts
more strongly than a calm one, the demo's read-only comparison line resolving that same
event for every personality the selected pet offers and marking the chosen one without
announcing anything, that demo working from the keyboard and under reduced
motion, and the chat empty-state companion
following the stored pet without breaking a narrow layout. Against the real streaming
stub it also drives the header companion: following the live reply phases and settling
back to idle, being drawn exactly once for an open conversation and not at all in the
welcome state (with one accessible name, no live region, and no sideways overflow at
375px), a retried reply getting a clean reaction lifecycle of its own after a stream
that died mid-answer, and leaving a conversation mid-generation settling the companion
instead of leaving it thinking about a reply that will never arrive.
No ordinary AI test reaches a live provider: both adapter contracts have unit
coverage with a mocked `fetch`; route and reply-service tests mock the two adapters;
and existing browser tests target a local OpenRouter stub
(`tests/e2e/mock-openrouter.mjs`) wired through `OPENROUTER_BASE_URL`. NVIDIA route
unit tests exercise the unchanged `delta`/`done`/`error` SSE wire format, a failed
partial answer that writes no row, and a client-supplied provider or model that never
reaches an adapter. NVIDIA provider tests cover the exact endpoint and body,
`[DONE]`, fragmented SSE, malformed and upstream error frames, timeouts, aborts,
network and HTTP failures, round-robin/quarantine/retry rules, no key switch after
first delta, and isolation from the OpenRouter key pool even for identical test key
strings. No real key is required in CI or locally; live NVIDIA output has not been
verified. See the database documentation for the code-generation limitation.
Browser layout checks cover 320, 375, 768, 1024, and 1440px widths, plus a 320×540
viewport with a long draft, and every auth page at 375px and 1440px. An automated
accessibility audit found no WCAG A/AA violations in the empty, static-conversation,
mobile-dialog, or authentication states.
This is not a substitute for physical-device, screen-reader, or cross-browser
acceptance testing; those remain future verification work.

- `npm audit` reports **three high-severity entries** in one Prisma
  tooling chain: `prisma` → `@prisma/config` → `deepmerge-ts`
  (GHSA-ggr8-5vv4-36mx, recursive object graph stack exhaustion). Since
  `@prisma/client` declares the `prisma` CLI as an optional peer dependency, these
  also appear under `npm audit --omit=dev`, although the server runtime never loads
  `@prisma/config` or `deepmerge-ts`. No user-controlled Prisma configuration is
  accepted. Do not blindly force a major transitive override or downgrade using
  `npm audit fix --force`; see
  [the dependency note](docs/database.md#known-dependency-issue).
- ESLint 9 is retained because the current Next.js React/import/accessibility
  plugins do not all support ESLint 10. npm emits an ESLint 9 end-of-support
  warning. Upgrade the compatible toolchain together when supported.
- Real SMTP delivery, production `Secure`-cookie behavior over HTTPS, and deployed
  preview origins could not be exercised here. The auth migration SQL was applied
  to the disposable database with the PostgreSQL driver, so Prisma-managed
  migration history for it is likewise unconfirmed.
- Native Prisma engine downloads remain blocked in this sandbox. Validation and
  generation succeeded via a temporary WASM config, and migration SQL was accepted
  by PostgreSQL. Prisma-managed deployment/history remains unverified. See
  [the database verification report](docs/database.md#what-was-actually-verified-in-this-sandbox).
- **Task 24 did not run the browser or database suites.** The native Prisma CLI
  still cannot download its schema engine; the temporary WASM generation described
  above enabled a passing production build but did not provide a disposable
  PostgreSQL database or a Chromium executable. `npx playwright test --list` finds
  81 browser tests, not proof that they execute. A migrated `DATABASE_TEST_URL` is
  required for the signed-in checks; the public-page checks also need Chromium.
  The mocked in-process smoke and jsdom lifecycle suites run without either.
- Earlier development verified streaming in a real browser against the local stub
  (incremental delivery measured end to end, several deltas rendered before the
  stored row arrived); that browser test was not rerun for Task 24. No real OpenRouter
  service was called: the sandbox holds no credentials, so live model output,
  provider-side rate limits, and any provider-specific framing outside the documented
  OpenAI-compatible shape remain unexercised. Key rotation is covered by unit tests
  with a mocked `fetch`, a mocked Task 24 end-to-end smoke, and a browser test written
  for the local stub (which refuses one attempt so the fallback key is observable on
  the wire), but a real OpenRouter rate limit or revoked key was never
  seen here, so the exact cooldown that suits live provider limits may need tuning;
  provider-side `Retry-After` is deliberately not read. The model catalog is a
  server-owned **code** list, so adding a model is a code change plus one seed row —
  there is no admin UI, no provider-side model discovery, and no per-model settings
  (limits, pricing, or capability flags); `llama-3.1-70b` exists only to prove a
  retired entry is never offered. NVIDIA NIM is integrated through the same
  catalog and reply flow, but no live NVIDIA request was made in this sandbox, so
  provider-side behavior outside the documented OpenAI-compatible contract remains
  unexercised. There is no resume/reconnect: a dropped stream is retried by asking
  for a new generation, not by continuing the old one.

## License

The existing GNU GPL v3 `LICENSE` is preserved unchanged.
