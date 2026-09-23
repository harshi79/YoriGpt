# YoriGPT

A Node.js application foundation, responsive chat shell, PostgreSQL data
foundation, email/password authentication, a **user-scoped conversation and message
data flow**, and **streaming OpenRouter assistant replies** for YoriGPT. One
server-side provider streams a reply for a stored user message over server-sent
events while the browser renders it, and the finished answer is stored; several
OpenRouter keys rotate with a short cooldown when one is refused or rate limited,
while model selection, settings functionality, and pets still do not exist. The home route is an original
charcoal-and-mint interface, ready for later service integration. The chat shell
stays usable for signed-out visitors, but conversations belong to an authenticated
account: they are created, listed, opened, and deleted only for their owner.

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
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select an existing Chromium binary instead. The normal browser download was blocked in this sandbox; checks
were completed with a separately installed Chromium executable, outside the
project dependencies. Browser binaries and screenshots are not committed.

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
| `OPENROUTER_API_KEYS`                        | Assistant replies should be generated; comma-separated and rotated (otherwise they report "not configured") |
| `OPENROUTER_BASE_URL`                        | Optional; defaults to `https://openrouter.ai/api/v1`                 |
| `OPENROUTER_MODEL`                           | Optional; names the **default** model when it matches an active catalog entry (otherwise the catalog default is used and a warning is logged once) |
| `NVIDIA_API_KEYS`, `NVIDIA_BASE_URL`         | Future NVIDIA integration is used                                    |

`src/server/env.ts` exports `getServerEnv(scope)`. Validation runs **only when
called**, for the selected scope, not on import. Call it inside the relevant
server service, never at module scope or in the root layout. It rejects invalid
URLs, missing credentials, short authentication secrets, and a key list with no
usable entry (blank entries inside a list are ignored). Errors identify fields without
printing their values. Provider URLs have defaults and `OPENROUTER_MODEL` is optional; API keys
have none. Which model a reply uses is decided by the server catalog
(`src/server/ai/models/catalog.ts`), never by a request body. A key list is read once per request from this layer and handed to the
server-only key pool, which owns rotation. Streaming reuses the same variables: there
is no separate streaming key, endpoint, or model. Absent credentials never break the build or
the stored-message flow: the reply endpoint answers a controlled
`AI_NOT_CONFIGURED` error and says so in the UI.

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
`Conversation`, `Message`, `AiModel`, and `UserPreferences`, with two reviewed
migrations (foundation and Better Auth) and a lazy server-only client in
`src/server/db/client.ts`. The chat UI reads and writes `conversations` and the
owner's `messages` through the server-side services; `ai_models` and
`user_preferences` remain unused. There are no seed records, session-token
fixtures, or demo conversations.

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
- `DATABASE_TEST_URL=... npm run test:db` — opt-in read-only PostgreSQL checks.

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
truncated. `GET` returns the stored messages in ascending position order, capped at
500 with a `truncated` flag. There is no role, admin, bulk, or assistant-message
authorization, and no message editing or deletion yet.

## Assistant replies (OpenRouter)

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

- `src/server/ai/providers/openrouter.ts` is the single adapter. It calls the official
  OpenAI-compatible `POST {baseUrl}/chat/completions` with `{ model, messages, stream:
  true }` (`stream: false` for the JSON path) — where `model` is the OpenRouter
  identifier the catalog resolved from the selected catalog key — the key from
  `OPENROUTER_API_KEYS`, a
  30-second overall deadline, a 1 MB response/stream cap, a 16,000-character reply
  cap, and only status codes in its logs — never the key, the prompt, or the provider
  body. Failures are normalized to `timeout`, `aborted`, `http-error`,
  `malformed-response`, `empty-response`, `network-error`, or `too-long`.
- `src/server/ai/key-pool/` owns key selection and nothing else: it reads the keys
  through the env layer, hands them out in deterministic round-robin order, and skips
  a key the provider rejected (401/403) or rate limited (429) for a 30-second cooldown
  before it becomes eligible again. One request tries at most
  `min(configured keys, 3)` keys and never the same key twice, so rotation is bounded
  and a single request cannot hammer a failing key. Only failures another key could
  avoid are retried — malformed, empty, oversized, validation, timeout, and cancelled
  attempts are reported as they are. Streaming rotates only before the first delta is
  forwarded: once the browser has answer text, a failure is reported exactly as
  before rather than splicing two answers together. Cooldown state is per process and
  in memory (never in PostgreSQL), and key values never reach a log line, an SSE
  event, an error message, or the client bundle.
- The adapter owns OpenRouter's framing entirely: it parses the stream incrementally
  (frames split across reads, CRLF endings, a UTF-8 character split across chunks, `:`
  keep-alive comments, unknown fields), ends on `data: [DONE]` **or** a chunk carrying
  `finish_reason`, and yields one normalized `{ type: "delta", text }` per provider
  chunk. A stream that stops before either marker is a `malformed-response`, so a
  truncated answer can never be mistaken for a finished one. No provider payload
  reaches the service, the route, or the browser.
- `reply.ts` builds history from the **stored** rows only: newest at most 40 turns
  within 24,000 characters, mapping `USER` → `user` and `ASSISTANT` → `assistant`, with
  no ids, positions, or invented system prompt. It then persists the reply with a
  server-derived role, position, id, and timestamps. A transaction-level row lock plus
  a "latest message unchanged" check means a second concurrent request is refused
  (`400`) rather than storing a duplicate reply, and the
  `(conversationId, position)` unique constraint stays intact.

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
from OpenRouter, and the app boots (and builds) without a database or a key. Each
entry is:

| Catalog key         | OpenRouter identifier               | Shown as          | State    |
| ------------------- | ----------------------------------- | ----------------- | -------- |
| `gpt-4o-mini`       | `openai/gpt-4o-mini`                | GPT-4o mini       | active (**default**) |
| `gpt-4o`            | `openai/gpt-4o`                     | GPT-4o            | active   |
| `claude-3.5-haiku`  | `anthropic/claude-3.5-haiku`        | Claude 3.5 Haiku  | active   |
| `claude-3.7-sonnet` | `anthropic/claude-3.7-sonnet`       | Claude 3.7 Sonnet | active   |
| `llama-3.1-70b`     | `meta-llama/llama-3.1-70b-instruct` | Llama 3.1 70B     | retired  |

The **catalog key is the only model name the browser ever sees or sends**. The
OpenRouter identifier is resolved on the server, from this list, immediately before
the provider is called; an unknown, retired, empty, or raw-identifier value is
refused before any request is made. A retired entry stays in the list (and in the
database, see below) but is never offered, never selectable, and never used.

**Default model, in this order of precedence:**

1. The signed-in account's stored preference, if it names an active catalog model.
2. `OPENROUTER_MODEL`, if it matches an active catalog entry — by OpenRouter
   identifier (`openai/gpt-4o`) or by catalog key (`gpt-4o`).
3. The catalog default, `gpt-4o-mini`.

A preference that no longer resolves (a model retired since it was chosen) is treated
as no preference: the reply uses the next step in that list, and the fallback is
logged once without a credential. `OPENROUTER_MODEL` likewise never invents a model:
a value outside the catalog is ignored with a one-time warning, so a deployment
cannot point the app at an "available" model that the selector cannot show.

**Preference API.** `GET /api/models` returns the active models (key, name, short
description) and `selectedModelKey`; `PUT /api/models` accepts exactly
`{ "modelKey": "<catalog key>" }` and answers `{ "selectedModelKey": "…" }`. Both
require a session, and the stored row is keyed by the authenticated session — a
request cannot name, read, or write another account's preference. `PUT` also requires
the same trusted-origin check as every other write. Malformed JSON, an oversized
body, a missing or non-string key, an unexpected field, an unknown key, and a retired
model are all `400` with the standard `{ error: { code, message } }` envelope;
unauthenticated is `401`, an untrusted origin is `403`. The OpenRouter identifier,
the provider, the key pool's state, and the rest of the environment configuration are
never serialized. `src/server/ai/models/request.ts` holds the strict body parsing and
`src/server/ai/models/view.ts` the read model the chat header renders; both are
server-only.

**Storage.** The preference is the existing `user_preferences.preferredModelId`
column, which already references `ai_models` with `onDelete: SetNull`. The migration
`prisma/migrations/20260923020000_seed_ai_models` inserts one `ai_models` row per
catalog entry (id = catalog key, provider `OPENROUTER`, the identifier, the display
name, and the active flag; re-runnable via `ON CONFLICT (id) DO UPDATE`). Seeding is
therefore a migration, not a runtime requirement: every catalog key always has a row
to reference, and nothing in the app reads the table to decide what to offer — that
is what keeps booting without a live database possible. If the rows are missing (a
deployment that skipped the migration), storing a preference answers a controlled
`400` and logs the seed migration's name; replies continue to work.

**From selection to OpenRouter.** The reply flow resolves the model once per turn:
authenticate → `resolveReplyModelKey(userId)` (the precedence above) → carry that key
on the prepared turn → the adapter resolves the identifier from the catalog and
rejects anything else before a key is even selected. Both the JSON path and the SSE
path use the same resolution, so a stream and a plain reply for the same turn cannot
disagree. Key rotation is entirely independent of model choice: every catalog model
uses the same `OPENROUTER_API_KEYS` pool, the same bounded `min(keys, 3)` attempts,
the same cooldown, and the same rule that a stream never switches keys after the
first delta.

**Chat history is not affected.** No table, column, or row records which model
produced a reply — the change applies to future generations only. A stored
conversation keeps loading exactly as before, and switching models never rewrites it.

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
│   ├── settings/          # Reserved
│   └── pets/              # Reserved
├── server/
│   ├── env.ts             # Lazy, scoped, server-only environment validation
│   ├── api/               # Shared JSON envelope and request-origin checks
│   ├── auth/              # Better Auth config, lazy instance, session helpers
│   ├── conversations/     # Owner-scoped conversation queries and request parsing
│   ├── messages/          # Owner-scoped message queries, reply generation
│   ├── api/               # JSON envelope, origin guard, SSE framing
│   ├── db/                # Lazy server-only Prisma client boundary
│   ├── email/             # Server-only SMTP adapter for auth links
│   └── ai/                # Server-only reply provider boundary
│       ├── providers/     # OpenRouter adapter: request + stream parsing (no SDK)
│       ├── key-pool/      # Round-robin key selection, cooldowns, bounded rotation
│       └── models/        # Reserved; no model records or selection exist
└── lib/                   # Reserved for shared, non-secret utilities
prisma/                    # PostgreSQL schema and initial migration
tests/                    # Vitest unit tests and Playwright browser checks
```

`src/server/auth/`, `src/server/email/`, `src/server/conversations/`,
`src/server/messages/`, `src/server/ai/` (provider boundary, key pool, and model
catalog), and `src/features/models/` are implemented; `src/features/settings/` and
`src/features/pets/` stay empty until their implementation step. Routes remain thin; future domain behavior
belongs in feature modules and server services. Database access and provider
secrets must remain under server boundaries. No additional backend service, state library, UI kit, or
provider SDK is needed. Playwright remains a development dependency; the database
step added the Prisma client and PostgreSQL adapter, and the authentication step
added exactly two runtime dependencies: `better-auth` and `nodemailer`. The reply
step added **no dependency at all**: the adapter uses the platform `fetch`.

`src/app/globals.css` provides provisional dark colors, system typography,
spacing/radius tokens, responsive baseline rules, visible keyboard focus, and
reduced-motion handling. These support the shell; no proprietary assets or external font requests are used.

## Verification and tooling limitations

The project passes `npm install`, lint, typecheck, **210 unit tests**, **45 Chromium
browser tests**, and production build/start without real secrets, SMTP credentials,
or a live database after client generation. **72 database checks** (13 streaming reply
+ 16 reply + 9 message + 13 conversation + 9 model preference + 9 auth + 3 structure)
pass against disposable PostgreSQL 17.6,
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
nothing). Unit tests also cover the adapter's framing
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
rendered states). The browser suite drives the selector end to end: the catalog it
lists, a stored choice surviving a reload and a second conversation, the identifier
the stub receives for the default and for two other selections (including a streamed
rotation), two accounts keeping separate choices, and a raw provider identifier
refused by the API.
No AI check reaches the network: the provider contract is covered by unit tests with a
mocked `fetch`, the reply service and database suites mock the adapter module, and the
browser suite talks to a local stub (`tests/e2e/mock-openrouter.mjs`) wired in through
`OPENROUTER_BASE_URL`, which streams deterministic deltas. No real key is required in
CI or locally. See the database documentation for the code-generation network
limitation.
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
- Streaming replies were verified against a real browser and the local stub
  (incremental delivery measured end to end, several deltas rendered before the
  stored row arrived), but never against the real OpenRouter service: the sandbox
  holds no credentials, so live model output, provider-side rate limits, and any
  provider-specific framing outside the documented OpenAI-compatible shape remain
  unexercised. Key rotation is covered by unit tests with a mocked `fetch` and by a
  browser test against the local stub (which refuses one attempt so the fallback key is
  observable on the wire), but a real OpenRouter rate limit or revoked key was never
  seen here, so the exact cooldown that suits live provider limits may need tuning;
  provider-side `Retry-After` is deliberately not read. The model catalog is a
  server-owned **code** list, so adding a model is a code change plus one seed row —
  there is no admin UI, no provider-side model discovery, and no per-model settings
  (limits, pricing, or capability flags); `llama-3.1-70b` exists only to prove a
  retired entry is never offered. NVIDIA support is still **not** implemented, and
  there is no resume/reconnect: a dropped stream is retried by asking for a new
  generation, not by continuing the old one.

## License

The existing GNU GPL v3 `LICENSE` is preserved unchanged.
