import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { getDb } from "../../src/server/db/client";

let db: ReturnType<typeof getDb>;
beforeAll(() => {
  // Separate, explicit opt-in: never silently fall back to DATABASE_URL.
  if (!process.env.DATABASE_TEST_URL)
    throw new Error(
      "Set DATABASE_TEST_URL to a migrated disposable PostgreSQL database before running npm run test:db.",
    );
  vi.stubEnv("DATABASE_URL", process.env.DATABASE_TEST_URL);
  db = getDb();
});
afterAll(async () => {
  await db?.$disconnect();
  vi.unstubAllEnvs();
});

it("the migrated database enforces required ownership and deletion policies", async () => {
  const fks = await db.$queryRaw<{ table_name: string; definition: string }[]>`
    SELECT c.relname::text AS table_name, pg_get_constraintdef(k.oid) AS definition
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE k.contype = 'f' AND n.nspname = current_schema()
  `;
  expect(fks).toEqual(
    expect.arrayContaining([
      {
        table_name: "conversations",
        definition: expect.stringMatching(
          /FOREIGN KEY \("userId"\) REFERENCES users\(id\).*ON DELETE CASCADE/,
        ),
      },
      {
        table_name: "messages",
        definition: expect.stringMatching(
          /REFERENCES conversations\(id\).*ON DELETE CASCADE/,
        ),
      },
      {
        table_name: "user_preferences",
        definition: expect.stringMatching(
          /REFERENCES users\(id\).*ON DELETE CASCADE/,
        ),
      },
      {
        table_name: "user_preferences",
        definition: expect.stringMatching(
          /REFERENCES ai_models\(id\).*ON DELETE SET NULL/,
        ),
      },
    ]),
  );
  const columns = await db.$queryRaw<
    { table_name: string; column_name: string; is_nullable: string }[]
  >`
    SELECT table_name::text, column_name::text, is_nullable::text FROM information_schema.columns
    WHERE table_schema = current_schema() AND
      ((table_name = 'conversations' AND column_name = 'userId') OR
       (table_name = 'messages' AND column_name = 'conversationId'))
  `;
  expect(columns).toHaveLength(2);
  expect(columns.every((column) => column.is_nullable === "NO")).toBe(true);
});

it("ordering, catalog identity, email uniqueness and SQL-only checks exist", async () => {
  const indexes = await db.$queryRaw<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema()
  `;
  const definitions = indexes.map((row) => row.indexdef).join("\n");
  expect(definitions).toMatch(
    /UNIQUE INDEX "messages_conversationId_position_key".*\("conversationId", "?position"?\)/,
  );
  expect(definitions).toMatch(
    /UNIQUE INDEX "ai_models_provider_modelIdentifier_key"/,
  );
  expect(definitions).toMatch(/UNIQUE INDEX users_email_key/);
  expect(definitions).toMatch(
    /conversations_userId_updatedAt_id_idx".*"updatedAt" DESC, id DESC/,
  );
  const checks = await db.$queryRaw<{ conname: string }[]>`
    SELECT k.conname::text FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE k.contype = 'c' AND n.nspname = current_schema()
  `;
  expect(checks.map((check) => check.conname)).toEqual(
    expect.arrayContaining([
      "messages_position_nonnegative",
      "user_preferences_ui_object",
    ]),
  );
  const equality = await db.$queryRaw<
    { equal: boolean }[]
  >`SELECT 'Name@Example.invalid'::citext = 'name@example.invalid'::citext AS equal`;
  expect(equality[0].equal).toBe(true);
});

it("all foundation tables are queryable using the generated client", async () => {
  // Read-only probes, not fixtures/seeds. No application rows are created.
  const counts = await Promise.all([
    db.user.count(),
    db.conversation.count(),
    db.message.count(),
    db.aiModel.count(),
    db.userPreferences.count(),
  ]);
  expect(counts.every((count) => Number.isInteger(count) && count >= 0)).toBe(
    true,
  );
});
