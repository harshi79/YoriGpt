import { readFileSync } from "node:fs";
import { Prisma, MessageRole, ModelProvider } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { getDb } from "../src/server/db/client";

const cache = globalThis as typeof globalThis & {
  yoriPrisma?: ReturnType<typeof getDb>;
};

afterEach(async () => {
  await cache.yoriPrisma?.$disconnect();
  delete cache.yoriPrisma;
  vi.unstubAllEnvs();
});

describe("database boundary (no database required)", () => {
  it("imports lazily and fails only when an unconfigured client is requested", () => {
    vi.stubEnv("DATABASE_URL", undefined);
    expect(() => getDb()).toThrow(/database.*DATABASE_URL/);
  });

  it("reuses its client across calls and module reloads without connecting", async () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://validation:validation@localhost:5432/validation?schema=public",
    );
    const first = getDb();
    expect(getDb()).toBe(first);
    vi.resetModules();
    const reloaded = await import("../src/server/db/client");
    expect(reloaded.getDb()).toBe(first);
  });

  it("generates the identity and conversation graph with explicit role/provider enums", () => {
    const conversation = Prisma.dmmf.datamodel.models.find(
      (model) => model.name === "Conversation",
    )!;
    const message = Prisma.dmmf.datamodel.models.find(
      (model) => model.name === "Message",
    )!;
    const userRelation = conversation.fields.find(
      (field) => field.name === "user",
    )!;
    expect(userRelation).toMatchObject({
      kind: "object",
      type: "User",
      relationName: "ConversationToUser",
    });
    expect(
      message.fields.find((field) => field.name === "conversation"),
    ).toMatchObject({
      kind: "object",
      type: "Conversation",
      relationName: "ConversationToMessage",
    });
    // The Rust-free runtime model is compact; full FK/nullability/uniqueness
    // assertions run against PostgreSQL in the opt-in integration suite.
    expect(Object.values(MessageRole)).toEqual(["USER", "ASSISTANT", "SYSTEM"]);
    expect(Object.values(ModelProvider)).toEqual(["OPENROUTER", "NVIDIA"]);
  });

  it("retains reviewed SQL-only constraints without seed data", () => {
    const migration = readFileSync(
      new URL(
        "../prisma/migrations/20260923000000_initial_data_foundation/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain('CREATE EXTENSION IF NOT EXISTS "citext"');
    expect(migration).toContain('CHECK ("position" >= 0)');
    expect(migration).toContain(
      "CHECK (jsonb_typeof(\"uiPreferences\") = 'object')",
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "messages_conversationId_position_key"',
    );
    expect(migration).not.toMatch(/\bINSERT\s+INTO\b/i);
  });
});
