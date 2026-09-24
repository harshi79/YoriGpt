# Authentication foundation (Better Auth)

Email/password identity, server-backed sessions, email verification, and password
reset for YoriGPT, built on the existing PostgreSQL/Prisma foundation with
**Better Auth 1.7.5**. Scope is deliberately limited: no OAuth/social providers,
no account dashboard, and no admin/moderation/subscription logic. Conversations,
stored messages, and assistant replies are all authorized as session ownership
rather than a separate permission model (see the reply section below).

## Architecture

```text
src/server/auth/config.ts   createAuth(sendEmail) — the only place the auth
                            instance is configured (adapter, secrets, sessions,
                            verification, reset, cookie prefix, origins)
src/server/auth/index.ts    lazy getAuth() singleton + exported auth types
src/server/auth/session.ts  cached per-request helpers (the single entry point
                            for "who is the current user?")
src/server/email/mailer.ts  server-only SMTP adapter used to deliver auth links
src/app/api/auth/[...all]/route.ts   official Next.js App Router handler
src/features/auth/          browser client, validation, error mapping, forms
src/app/(auth)/             register, login, verify-email, forgot/reset pages
```

- Better Auth owns password hashing (its default Scrypt), session/token creation,
  expiration, and single-use handling. No custom cryptography and no custom
  session table logic exist in this project.
- Every auth module starts with `import "server-only"`; `AUTH_SECRET`, the
  database URL, and SMTP configuration are read inside those modules only.
  `src/features/auth/*` (the browser boundary) contains no `process.env` access and
  imports no `@/server` module.
- The API surface is exactly Better Auth's own handler mounted at
  `/api/auth/[...all]`. No hand-written auth endpoints, no fake responses, and no
  email is sent from tests.
- Better Auth's cookie cache is **not** enabled: each request resolves the session
  from the database, so a revoked/expired session stops working immediately.

## Configuration decisions

| Setting                     | Value                                                                   |
| --------------------------- | ----------------------------------------------------------------------- |
| `baseURL` / origins         | `APP_URL` plus optional `AUTH_TRUSTED_ORIGINS` (comma-separated)         |
| `secret`                    | `AUTH_SECRET` (validated: at least 32 characters)                        |
| Adapter                     | `prismaAdapter(getDb(), { provider: "postgresql", transaction: true })`  |
| Email/password              | enabled; password length 8–128 (Better Auth default)                     |
| Email verification          | sent on sign-up, `autoSignInAfterVerification: true`, 1-hour token default |
| Password reset              | enabled; 1-hour token default; single use                                |
| Session                     | 7-day expiry, 1-day update age, cookie prefix `yorigpt`                   |
| Email delivery              | nodemailer over `SMTP_URL`; auth links must target `APP_URL`'s origin     |
| Rate limiting               | Better Auth defaults (enabled except in development)                      |
| Sign-up data                | only `name`, `email`, `password`; no user input is trusted for `status`   |

`createAuth(sendEmail)` accepts an email sender so tests and future adapters can
substitute delivery without weakening production configuration; the default is
the SMTP adapter.

## Using the session helpers

```ts
import { getCurrentUser, isAuthenticated, requireUser } from "@/server/auth/session";

const user = await getCurrentUser();        // AuthUser | null, request-cached
if (!(await isAuthenticated())) { /* anonymous */ }
const current = await requireUser();        // redirects to /login when anonymous
```

`getSession()` is wrapped in React's `cache`, so a page/section that calls these
helpers several times performs a single session lookup per request. Future
ownership checks (conversation/message authorization) must go through these
helpers — never a scattered adapter call. `requireAnonymous()` keeps signed-in
users away from the login/register screens.

**The chat shell is intentionally unprotected.** No route group, middleware, or
page guard was added, and conversations are still not linked to users. Only
`/verify-email` reads the session, to display the signed-in address.

## Required environment

| Variable                 | Required for                              | Notes                                                    |
| ------------------------ | ----------------------------------------- | -------------------------------------------------------- |
| `APP_URL`                | Auth base URL and link-origin validation  | Must be the real public origin in production             |
| `DATABASE_URL`           | Sessions, accounts, verification/reset rows | Server-only; least-privilege role in production        |
| `AUTH_SECRET`            | Signing sessions and tokens               | ≥ 32 chars; `openssl rand -base64 32`; never in the client |
| `AUTH_TRUSTED_ORIGINS`   | Deployed aliases/preview hosts (optional) | Comma-separated `http(s)` origins; defaults to none       |
| `SMTP_URL`, `EMAIL_FROM` | Verification and reset emails (optional)  | Without both, email features report "not configured"     |

`.env` stays uncommitted; `.env.example` contains placeholders only. Production
builds, typecheck, and unit tests run without SMTP credentials or a live database,
and no test ever sends mail.

`APP_URL` must be an absolute `http(s)` URL, scheme included; a missing, blank, or
host-only value is reported with that distinction (`Invalid server configuration
(app): APP_URL: …`) on the first auth or API request, not at startup. Every origin
that serves the app other than `APP_URL`'s own must appear in
`AUTH_TRUSTED_ORIGINS`, otherwise requests from it are rejected; see the
troubleshooting note in `README.md`.

## Email verification and password reset behavior

- Sign-up sends a verification link that redirects to
  `/verify-email?status=verified` on success. Better Auth 1.7.5 signs this token
  (HS256, short expiry) rather than storing a `verifications` row; the
  `verifications` table is still part of the schema because it backs password
  reset and future flows.
- Password reset writes a `verifications` row
  (`identifier = reset-password:<token>`) that is deleted on use, which makes the
  link single-use and expiring. The request endpoint answers identically for known
  and unknown addresses, so the API cannot be used to enumerate accounts.
- Without SMTP the flows fail loudly (a clear "email delivery is not configured"
  notice beside the forms and a `EmailDeliveryNotConfiguredError` on the server)
  instead of pretending mail was sent. Accounts, sessions, and sign-in still work.
- `deliverAuthEmail` refuses to send a link whose origin does not match `APP_URL`,
  so a misconfigured `baseURL` cannot produce a token-bearing link to another host.

To exercise verification/reset end to end you need a real mail provider (or a
local SMTP catcher such as Mailpit) plus `SMTP_URL`/`EMAIL_FROM`. Nothing in the
build or test pipeline requires that, and no test credentials are committed.

## Database changes

One additive migration, `prisma/migrations/20260923010000_add_better_auth`, adds
`sessions`, `accounts`, and `verifications` in the documented Better Auth shape:
cascading `userId` foreign keys, unique `sessions.token`, unique
`(accounts.providerId, accounts.accountId)`, and an index on both foreign-key
`userId` columns / `verifications.identifier`. Existing `users` columns, types,
and mappings are untouched, and no previous migration was edited. No users,
accounts, sessions, or tokens are seeded.

PostgreSQL does not enforce case-insensitive uniqueness through Prisma, so
`users.email` relies on the existing `CITEXT` column (the Prisma model still
declares `@unique`, which matches the schema-level uniqueness it also creates).
Duplicate sign-ups with different letter casing are rejected by the database —
verified against a disposable PostgreSQL 17.6 instance.

## Model preference (the one user setting)

The chat header's model selector stores exactly one preference per account, in the
existing `user_preferences.preferredModelId` column. The rules mirror the rest of the
app:

- **Authenticated.** `GET /api/models` and `PUT /api/models` both require a session;
  an anonymous request answers `401` and never touches a row.
- **Owner-scoped.** The row is addressed by the authenticated session's user id, which
  is never accepted from the request — there is no `userId` field anywhere in the
  route, body, or query. A second account's request therefore cannot read or change the
  first account's choice (unit tests assert the write arguments, the database suite
  asserts the stored rows, and a browser test runs two independent contexts).
- **Server-validated.** The body must be exactly `{ "modelKey": "<catalog key>" }`
  (unknown fields, a missing/non-string key, malformed JSON, and an oversized body are
  refused with `400`). The key must name an **active** entry in the server-owned
  catalog; the OpenRouter identifier is resolved from that catalog afterwards, so a
  browser can never install a model the deployment does not offer, and a retired model
  can never be selected.
- **Origin-checked.** `PUT` runs the same trusted-origin check as every other write
  (`403` for an untrusted origin), in addition to Better Auth's own session handling.
- **Not a secret surface.** Responses carry only catalog keys, display names,
  descriptions, and the selected key. No API key, provider identifier, key-pool state,
  or environment value is serialized, logged, or passed to a client component.

A stored preference that no longer resolves (its model was retired) is treated as no
preference: replies fall back to the configured default and the fallback is logged
once. Deleting a catalog row would set the column to `NULL` (`onDelete: SetNull`),
which behaves identically.

## Security notes

- Session cookies are Better Auth's defaults: `HttpOnly`, `SameSite=Lax`,
  `Secure` in production, prefixed `yorigpt`, and validated against the configured
  origins (CSRF protection through Better Auth's origin checks and its signed
  requests). No cookie settings were loosened to make tests pass.
- Passwords are hashed by Better Auth (never stored or logged in plain text), and
  verification/reset tokens are single-use with a one-hour default expiry.
- Errors returned to the browser are generic ("Invalid email or password"); code
  paths that could reveal whether an account exists answer identically.
- Invalid input, mismatched password confirmation, and weak passwords are caught
  in the browser form *and* by the server-side schema.
- No secret is delivered to the browser: there is no `NEXT_PUBLIC_` auth variable,
  no secret props passed to client components, and `src/features/auth/*` never
  reads `process.env`.

## Verification performed

Unit/integration (see `tests/`):

```sh
npm test                                  # 210 tests: shell and model selector, schema shape, config, mailer, session helpers, UI helpers, env, db boundary, conversation, message, and reply helpers, the streaming reply reader, the key pool, the model catalog/service/request/route and selection client, plus the mocked OpenRouter adapter (request, JSON answer, streamed answer, and key rotation)
DATABASE_TEST_URL=postgresql://user@127.0.0.1:55433/postgres npm run test:db
                                          # 72 tests against disposable PostgreSQL 17.6
```

The database suite drives the real Better Auth handler: registration, duplicate
(case-insensitive) email rejection, server-side password hashing, invalid login,
session row + cookie creation, anonymous session lookup, forged/expired
verification tokens, and reset-token single use (old password stops working). The
same suite now also runs the real conversation handlers: unauthenticated requests
answer 401, client-supplied ownership fields are rejected, an owner sees only their
own list in storage order, another account's conversation answers exactly like an
unknown id (404), and deletion cannot cross accounts. Conversation APIs use the
non-redirecting `getCurrentUser()`; the `/chat/[conversationId]` page uses
`requireUser()` and sends anonymous visitors to `/login`.
Signed-in message writes are authorized the same way: the request reaches the
conversation through an owner-scoped query before any message row is touched, so
another account's conversation is indistinguishable from an unknown id.
Assistant replies add no new authorization surface: `POST
/api/conversations/:id/reply` accepts no client fields, reuses the same
owner-scoped conversation lookup (foreign and unknown conversations answer the
same 404), generates from the stored latest message, and writes the assistant row
with a server-derived role, position, id, and timestamps. The same checks run
before the streaming variant of that endpoint begins: authentication, the origin
guard, the conversation id, and the reply eligibility check are ordinary JSON
errors with their original status codes (401/403/404/400), so a caller can tell
"you may not do this" apart from "the answer failed halfway". Once the stream is
open, a failure is an `error` event and still writes nothing. Without
`OPENROUTER_API_KEYS` the endpoint answers the controlled `AI_NOT_CONFIGURED`
error (as JSON before the stream, as an `error` event inside it); the no-key path is
covered by the database suite and a local mock provider stands in for OpenRouter in
every test, so no real key or network call is involved. A browser that disappears
cancels the stream, which stops the provider request and leaves no row behind — no
session outlives its requester. Provider credentials stay on the server in every
case: the reply endpoint reads `OPENROUTER_API_KEYS` (a comma-separated list) inside
the request handler, the key pool decides which entry signs an attempt, and neither a
key value nor a provider response body is ever logged, serialized into a prop, or
written into an SSE frame. A key the provider rejects or rate limits is skipped for a
short cooldown; that state is per process and in memory, so it cannot leak through the
database either.
The model preference is covered at every layer: unit tests for the catalog, the
service, the strict body parser, the route's status codes and wire shape, and the
selection client; database tests for the seeded rows, the foreign key, one
account's rows staying untouched by another's request, a retired preference being
reported as the model a reply would use, and the refusals; and
browser tests for the catalog the selector lists, a stored choice surviving a
reload and a second conversation, the identifier the provider stub actually
receives, two accounts keeping separate choices, and a raw provider identifier
being refused.
Playwright adds the model-selector checks and 7 auth checks: every auth page renders at 375px and 1440px
without horizontal scrolling, the register form validates locally without calling
`/api/auth`, keyboard tab order reaches the submit button, the reset page never
claims success with a missing/invalid token, and the "email not configured" notice
is shown.

Not verified here: real SMTP delivery, a real inbox click-through, production
cookie behavior over HTTPS, and any deployed-preview origin. Native Prisma
migration commands remain blocked in this sandbox (see
[database.md](database.md#what-was-actually-verified-in-this-sandbox)); the auth
migration SQL was executed against the disposable database with the PostgreSQL
driver, so Prisma migration history is still unconfirmed.

## Next step

The authorized data flow is complete for one round trip: conversations are created,
listed, opened, and deleted only for the signed-in owner
(`src/server/conversations/`), stored messages reach the database only through the
same owner-scoped lookup (`src/server/messages/`), and the assistant reply is
streamed by the single server-only OpenRouter adapter in `src/server/ai/` and
stored in the same conversation when the provider reports completion. Message and
reply authorization is therefore conversation ownership, not a separate permission
model, and multiple configured OpenRouter keys rotate in round-robin order with a
short cooldown for a key the provider refuses, so one request survives a rejected or
rate-limited key. Which model writes a reply is now the account's own stored choice,
validated against the server-owned catalog before it is stored and again before it is
used (see [Model preference](#model-preference-the-one-user-setting)), and every
catalog model uses that same key pool. Deliberately still absent: multiple providers,
per-model settings, resume/reconnect for interrupted streams, message
editing/deletion, and any client-side knowledge of the provider, its keys, or its
OpenRouter identifiers.
