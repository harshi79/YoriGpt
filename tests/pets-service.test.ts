import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The pet preference service against a fake `user_preferences` table, so the stored
 * column, the catalog validation, and the user scoping can be inspected directly.
 * Real PostgreSQL behavior is covered by tests/database/pets.integration.ts.
 */
const fake = vi.hoisted(() => {
  const state = {
    rows: new Map<string, { userId: string; selectedPetKey: string | null }>(),
    upserts: [] as {
      where: { userId: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }[],
    failWith: null as unknown,
  };
  return {
    state,
    db: {
      userPreferences: {
        findUnique: async (args: { where: { userId: string } }) => {
          if (state.failWith) throw state.failWith;
          return state.rows.get(args.where.userId) ?? null;
        },
        upsert: async (args: {
          where: { userId: string };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          state.upserts.push(args);
          if (state.failWith) throw state.failWith;
          const existing = state.rows.get(args.where.userId);
          state.rows.set(args.where.userId, {
            userId: args.where.userId,
            selectedPetKey:
              (args.update.selectedPetKey as string) ??
              (args.create.selectedPetKey as string) ??
              existing?.selectedPetKey ??
              null,
          });
          return { userId: args.where.userId };
        },
      },
    },
  };
});

vi.mock("../src/server/db/client", () => ({ getDb: () => fake.db }));

const {
  getSelectedPetKey,
  loadCompanionPetKey,
  resolveSelectedPetKey,
  saveSelectedPetKey,
} = await import("../src/server/pets/service");
const { DEFAULT_PET_ID } = await import("../src/features/pets/catalog");

const userId = "cmuser00000000000000001";
const otherUserId = "cmuser00000000000000002";

beforeEach(() => {
  fake.state.rows.clear();
  fake.state.upserts = [];
  fake.state.failWith = null;
  vi.restoreAllMocks();
});

describe("the pet preference service", () => {
  it("resolves to the default available pet when nothing is stored", async () => {
    expect(await getSelectedPetKey(userId)).toBeNull();
    expect(await resolveSelectedPetKey(userId)).toBe(DEFAULT_PET_ID);
  });

  it("persists a valid available pet and reads it back", async () => {
    const saved = await saveSelectedPetKey(userId, "ember-fox");
    expect(saved).toEqual({ ok: true, pet: "ember-fox" });

    expect(await getSelectedPetKey(userId)).toBe("ember-fox");
    expect(await resolveSelectedPetKey(userId)).toBe("ember-fox");

    // Only the selectedPetKey column is written, keyed by the authenticated user.
    expect(fake.state.upserts[0].where).toEqual({ userId });
    expect(fake.state.upserts[0].update).toEqual({ selectedPetKey: "ember-fox" });
  });

  it("rejects an unknown pet key", async () => {
    expect(await saveSelectedPetKey(userId, "nope")).toEqual({ ok: false, reason: "invalid-pet" });
    expect(await getSelectedPetKey(userId)).toBeNull();
  });

  it("rejects an unavailable pet key", async () => {
    expect(await saveSelectedPetKey(userId, "pip-rabbit")).toEqual({
      ok: false,
      reason: "invalid-pet",
    });
    expect(await getSelectedPetKey(userId)).toBeNull();
  });

  it("resolves a stored invalid or unavailable value to the default", async () => {
    fake.state.rows.set(userId, { userId, selectedPetKey: "pip-rabbit" });
    expect(await resolveSelectedPetKey(userId)).toBe(DEFAULT_PET_ID);

    fake.state.rows.set(userId, { userId, selectedPetKey: "retired-pet" });
    expect(await resolveSelectedPetKey(userId)).toBe(DEFAULT_PET_ID);
  });

  it("keeps each account's preference separate", async () => {
    await saveSelectedPetKey(userId, "ember-fox");

    // The other account has no row and resolves to the default.
    expect(await resolveSelectedPetKey(otherUserId)).toBe(DEFAULT_PET_ID);
    // Saving for one user never writes the other's row.
    expect(fake.state.upserts.every((u) => u.where.userId === userId)).toBe(true);
  });

  it("never throws for anonymous users or a failed read", async () => {
    expect(await loadCompanionPetKey(null)).toBe(DEFAULT_PET_ID);

    fake.state.failWith = new Error("db down");
    expect(await loadCompanionPetKey({ id: userId })).toBe(DEFAULT_PET_ID);
    expect(await resolveSelectedPetKey(userId)).toBe(DEFAULT_PET_ID);
  });
});
