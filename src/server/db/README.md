# Server-only database boundary

`client.ts` exports `getDb()`: a lazy, globally reused Prisma client with a bounded
PostgreSQL pool. Importing it does not validate environment or open a connection;
calling it validates `DATABASE_URL`, and queries open connections when needed.
Do not import from Client Components, connect at module scope, disconnect per
request, or add database calls to the presentation-only UI.

The schema, migration decisions, setup commands, auth compatibility, and exact
verification limitations are documented in [`docs/database.md`](../../../docs/database.md).
No application queries or authorization logic belong in this foundation step.
