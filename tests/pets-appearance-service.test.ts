import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The appearance half of the pet preference service, against a fake
 * `user_preferences` table that tracks both `selectedPetKey` and the `uiPreferences`
 * JSON object. It checks that the appearance is stored as a single key inside
 * `uiPreferences`, validated against the user's currently selected pet, and that
 * saving it never disturbs the pet selection or other stored preferences.
 */
const fake = vi.hoisted(() => {
  const state = {
    rows: new Map<
      string,
      { userId: string; selectedPetKey: string | null; uiPreferences: unknown }
    >(),
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
          const next = {
            selectedPetKey:
              (args.update.selectedPetKey as string) ??
              (args.create.selectedPetKey as string) ??
              existing?.selectedPetKey ??
              null,
            uiPreferences:
              (args.update.uiPreferences as unknown) ??
              (args.create.uiPreferences as unknown) ??
              existing?.uiPreferences ??
              {},
          };
          state.rows.set(args.where.userId, { userId: args.where.userId, ...next });
          return { userId: args.where.userId };
        },
      },
    },
  };
});

vi.mock("../src/server/db/client", () => ({ getDb: () => fake.db }));

const { getPetAppearanceKey, loadCompanion, savePetAppearance } = await import(
  "../src/server/pets/service"
);
const { DEFAULT_PET_ID } = await import("../src/features/pets/catalog");

const userId = "cmuser00000000000000001";

beforeEach(() => {
  fake.state.rows.clear();
  fake.state.upserts = [];
  fake.state.failWith = null;
});

describe("the pet appearance service", () => {
  it("reads nothing when no appearance is stored", async () => {
    expect(await getPetAppearanceKey(userId)).toBeNull();
  });

  it("stores a valid appearance as a single key in uiPreferences", async () => {
    // The default pet is the cat, whose "night" appearance is valid.
    const saved = await savePetAppearance(userId, "night");
    expect(saved).toEqual({ ok: true, pet: DEFAULT_PET_ID, appearance: "night" });

    expect(await getPetAppearanceKey(userId)).toBe("night");
    // The stored object holds only the key, keyed by the authenticated user.
    expect(fake.state.rows.get(userId)?.uiPreferences).toEqual({ petAppearance: "night" });
    expect(fake.state.upserts[0].where).toEqual({ userId });
  });

  it("keeps the pet selection and other preferences intact", async () => {
    fake.state.rows.set(userId, {
      userId,
      selectedPetKey: DEFAULT_PET_ID,
      uiPreferences: { someOther: "value" },
    });

    await savePetAppearance(userId, "moss");

    const row = fake.state.rows.get(userId)!;
    expect(row.selectedPetKey).toBe(DEFAULT_PET_ID);
    expect(row.uiPreferences).toEqual({ someOther: "value", petAppearance: "moss" });
    // The update touches only uiPreferences, never the pet column.
    expect(fake.state.upserts[0].update).toEqual({
      uiPreferences: { someOther: "value", petAppearance: "moss" },
    });
  });

  it("rejects an appearance that belongs to another pet", async () => {
    // "ember" is the fox's, not the cat's.
    expect(await savePetAppearance(userId, "ember")).toEqual({
      ok: false,
      reason: "invalid-appearance",
    });
    expect(await getPetAppearanceKey(userId)).toBeNull();
  });

  it("rejects an unknown appearance", async () => {
    expect(await savePetAppearance(userId, "disco")).toEqual({
      ok: false,
      reason: "invalid-appearance",
    });
  });

  it("validates against the user's selected pet, not the default", async () => {
    fake.state.rows.set(userId, { userId, selectedPetKey: "ember-fox", uiPreferences: {} });
    // "ember" is valid for the fox the user actually chose.
    expect(await savePetAppearance(userId, "ember")).toEqual({
      ok: true,
      pet: "ember-fox",
      appearance: "ember",
    });
  });

  it("loadCompanion returns the stored pet with a resolved appearance", async () => {
    fake.state.rows.set(userId, {
      userId,
      selectedPetKey: "ember-fox",
      uiPreferences: { petAppearance: "ember" },
    });
    expect(await loadCompanion({ id: userId })).toEqual({ pet: "ember-fox", appearance: "ember" });
  });

  it("loadCompanion falls back to the pet default for an invalid stored appearance", async () => {
    fake.state.rows.set(userId, {
      userId,
      selectedPetKey: "ember-fox",
      uiPreferences: { petAppearance: "not-a-real-appearance" },
    });
    // The fox's default appearance, whatever it is.
    const companion = await loadCompanion({ id: userId });
    expect(companion.pet).toBe("ember-fox");
    expect(companion.appearance).toBe("classic");
  });

  it("loadCompanion uses defaults for anonymous users and never throws on failure", async () => {
    expect(await loadCompanion(null)).toEqual({ pet: DEFAULT_PET_ID, appearance: "classic" });

    fake.state.failWith = new Error("db down");
    expect(await loadCompanion({ id: userId })).toEqual({ pet: DEFAULT_PET_ID, appearance: "classic" });
  });
});
