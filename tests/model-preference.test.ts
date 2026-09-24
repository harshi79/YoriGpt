import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("server-only", () => ({}));

/**
 * The preference service is exercised against a fake `user_preferences` table, so
 * the write arguments and the user scoping can be inspected directly. Real
 * PostgreSQL behavior (FK, isolation) is covered by the database suite.
 */
const fake = vi.hoisted(() => {
  const state = {
    rows: new Map<string, { userId: string; preferredModelId: string | null }>(),
    upserts: [] as { where: { userId: string }; create: unknown; update: unknown }[],
    failWith: null as unknown,
  };
  return {
    state,
    db: {
      userPreferences: {
        findUnique: async (args: { where: { userId: string } }) =>
          state.rows.get(args.where.userId) ?? null,
        upsert: async (args: {
          where: { userId: string };
          create: { userId: string; preferredModelId: string };
          update: { preferredModelId: string };
        }) => {
          state.upserts.push(args);
          if (state.failWith) throw state.failWith;
          state.rows.set(args.where.userId, {
            userId: args.where.userId,
            preferredModelId: args.create.preferredModelId,
          });
          return { userId: args.where.userId };
        },
      },
    },
  };
});

vi.mock("../src/server/db/client", () => ({ getDb: () => fake.db }));

const { getSelectedModelKey, saveSelectedModelKey, resolveReplyModelKey } = await import(
  "../src/server/ai/models/service"
);
const { DEFAULT_MODEL_KEY } = await import("../src/server/ai/models/catalog");

const userId = "cmuser00000000000000001";
const otherUserId = "cmuser00000000000000002";

beforeEach(() => {
  fake.state.rows.clear();
  fake.state.upserts = [];
  fake.state.failWith = null;
  vi.restoreAllMocks();
});

describe("reading a saved model preference", () => {
  it("returns the stored key, and null when the user never chose one", async () => {
    fake.state.rows.set(userId, { userId, preferredModelId: "gpt-4o" });

    await expect(getSelectedModelKey(userId)).resolves.toBe("gpt-4o");
    await expect(getSelectedModelKey(otherUserId)).resolves.toBeNull();
  });

  it("resolves the user's own model for a reply", async () => {
    fake.state.rows.set(userId, { userId, preferredModelId: "claude-3.7-sonnet" });
    await expect(resolveReplyModelKey(userId)).resolves.toBe("claude-3.7-sonnet");
  });

  it("resolves a saved NVIDIA model for one user without changing another", async () => {
    const chosen = "nvidia-llama-3.3-70b";
    fake.state.rows.set(userId, { userId, preferredModelId: chosen });
    fake.state.rows.set(otherUserId, { userId: otherUserId, preferredModelId: "gpt-4o" });

    await expect(resolveReplyModelKey(userId)).resolves.toBe(chosen);
    await expect(resolveReplyModelKey(otherUserId)).resolves.toBe("gpt-4o");
  });

  it("falls back to the default when nothing is stored", async () => {
    await expect(resolveReplyModelKey(userId)).resolves.toBe(DEFAULT_MODEL_KEY);
  });

  it("falls back to the default when the stored model is unknown or retired", async () => {
    const warnings = vi.spyOn(console, "error").mockImplementation(() => {});

    fake.state.rows.set(userId, { userId, preferredModelId: "removed-model" });
    await expect(resolveReplyModelKey(userId)).resolves.toBe(DEFAULT_MODEL_KEY);

    fake.state.rows.set(userId, { userId, preferredModelId: "llama-3.1-70b" });
    await expect(resolveReplyModelKey(userId)).resolves.toBe(DEFAULT_MODEL_KEY);

    // The fallback is reported (it explains an unexpected model in the reply) but
    // nothing about it is invented: the stored value is the only thing logged.
    expect(
      warnings.mock.calls.some((call) => String(call[0]).includes("no longer offered")),
    ).toBe(true);
  });
});

describe("saving a model preference", () => {
  it("stores an active catalog model for the signed-in user", async () => {
    const result = await saveSelectedModelKey(userId, "gpt-4o");

    expect(result).toEqual({ ok: true, modelKey: "gpt-4o" });
    expect(fake.state.upserts).toHaveLength(1);
    // A single column is written, scoped to the caller's own row.
    expect(fake.state.upserts[0].where).toEqual({ userId });
    expect(fake.state.upserts[0].update).toEqual({ preferredModelId: "gpt-4o" });
    expect(fake.state.upserts[0].create).toEqual({ userId, preferredModelId: "gpt-4o" });
    await expect(getSelectedModelKey(userId)).resolves.toBe("gpt-4o");
  });

  it("stores a NVIDIA catalog key in the same user-scoped preference column", async () => {
    const chosen = "nvidia-llama-3.3-70b";
    expect(await saveSelectedModelKey(userId, chosen)).toEqual({ ok: true, modelKey: chosen });
    expect(fake.state.upserts[0].where).toEqual({ userId });
    expect(fake.state.upserts[0].update).toEqual({ preferredModelId: chosen });
    expect(fake.state.upserts[0].create).toEqual({ userId, preferredModelId: chosen });
    await expect(resolveReplyModelKey(userId)).resolves.toBe(chosen);
  });

  it("refuses an unknown key without writing anything", async () => {
    const result = await saveSelectedModelKey(userId, "not-a-model");

    expect(result).toEqual({ ok: false, reason: "unknown-model" });
    expect(fake.state.upserts).toEqual([]);
  });

  it("refuses a retired model, and a raw provider identifier, without writing", async () => {
    expect(await saveSelectedModelKey(userId, "llama-3.1-70b")).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await saveSelectedModelKey(userId, "openai/gpt-4o")).toEqual({
      ok: false,
      reason: "unknown-model",
    });
    expect(await saveSelectedModelKey(userId, "meta/llama-3.3-70b-instruct")).toEqual({
      ok: false,
      reason: "unknown-model",
    });
    expect(fake.state.upserts).toEqual([]);
  });

  it("keeps one user's choice out of another user's row", async () => {
    await saveSelectedModelKey(userId, "gpt-4o");
    await saveSelectedModelKey(otherUserId, "claude-3.5-haiku");

    await expect(getSelectedModelKey(userId)).resolves.toBe("gpt-4o");
    await expect(getSelectedModelKey(otherUserId)).resolves.toBe("claude-3.5-haiku");
  });

  it("reports a controlled failure when the catalog rows are missing", async () => {
    const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
    // P2003 is the foreign key violation a database without the seed migration raises.
    fake.state.failWith = new Prisma.PrismaClientKnownRequestError("foreign key", {
      code: "P2003",
      clientVersion: "6.19.3",
    });

    await expect(saveSelectedModelKey(userId, "gpt-4o")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(warnings.mock.calls.some((call) => String(call[0]).includes("seed_ai_models"))).toBe(
      true,
    );
  });

  it("lets an unexpected database failure surface instead of hiding it", async () => {
    fake.state.failWith = new Error("connection lost");
    await expect(saveSelectedModelKey(userId, "gpt-4o")).rejects.toThrow("connection lost");
  });
});
