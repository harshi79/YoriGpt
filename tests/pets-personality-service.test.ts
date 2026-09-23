import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The personality half of the pet preference service, against a fake
 * `user_preferences` table that tracks `selectedPetKey` and the `uiPreferences` JSON
 * object. It checks that the personality is stored as a single catalog key inside
 * `uiPreferences`, validated against the user's currently selected pet, and that
 * writing it never disturbs the pet selection, the stored appearance, or any other
 * preference in the same object.
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

const { getPetPersonalityKey, loadCompanion, savePetPersonality } = await import(
  "../src/server/pets/service"
);
const { DEFAULT_PET_ID } = await import("../src/features/pets/catalog");

const userId = "cmuser00000000000000001";
const otherUserId = "cmuser00000000000000002";

beforeEach(() => {
  fake.state.rows.clear();
  fake.state.upserts = [];
  fake.state.failWith = null;
});

describe("the pet personality service", () => {
  it("reads nothing when no personality is stored", async () => {
    expect(await getPetPersonalityKey(userId)).toBeNull();
  });

  it("resolves to the selected pet's default personality when none is stored", async () => {
    // The default pet is the cat, whose default personality is `calm`.
    expect(await loadCompanion({ id: userId })).toEqual({
      pet: DEFAULT_PET_ID,
      appearance: "classic",
      personality: "calm",
    });
  });

  it("stores a valid personality as a single key in uiPreferences", async () => {
    const saved = await savePetPersonality(userId, "sleepy");
    expect(saved).toEqual({ ok: true, pet: DEFAULT_PET_ID, personality: "sleepy" });

    expect(await getPetPersonalityKey(userId)).toBe("sleepy");
    // Only the key is stored: no traits, no hints, no prompt text.
    expect(fake.state.rows.get(userId)?.uiPreferences).toEqual({ petPersonality: "sleepy" });
    expect(fake.state.upserts[0].where).toEqual({ userId });
  });

  it("leaves the pet selection and the stored appearance intact", async () => {
    fake.state.rows.set(userId, {
      userId,
      selectedPetKey: DEFAULT_PET_ID,
      uiPreferences: { petAppearance: "night", someOther: "value" },
    });

    await savePetPersonality(userId, "curious");

    const row = fake.state.rows.get(userId)!;
    expect(row.selectedPetKey).toBe(DEFAULT_PET_ID);
    expect(row.uiPreferences).toEqual({
      petAppearance: "night",
      someOther: "value",
      petPersonality: "curious",
    });
    // The update touches only uiPreferences, never the pet column.
    expect(fake.state.upserts[0].update).toEqual({
      uiPreferences: { petAppearance: "night", someOther: "value", petPersonality: "curious" },
    });
  });

  it("rejects a personality that belongs to another pet", async () => {
    // "playful" is the fox's, not the cat's.
    expect(await savePetPersonality(userId, "playful")).toEqual({
      ok: false,
      reason: "invalid-personality",
    });
    expect(await getPetPersonalityKey(userId)).toBeNull();
  });

  it("rejects an unknown personality", async () => {
    expect(await savePetPersonality(userId, "disco")).toEqual({
      ok: false,
      reason: "invalid-personality",
    });
  });

  it("validates against the user's selected pet, not the catalog default", async () => {
    fake.state.rows.set(userId, { userId, selectedPetKey: "ember-fox", uiPreferences: {} });
    // "playful" is valid for the fox the user actually chose…
    expect(await savePetPersonality(userId, "playful")).toEqual({
      ok: true,
      pet: "ember-fox",
      personality: "playful",
    });
    // …while the cat's "sleepy" is not.
    expect(await savePetPersonality(userId, "sleepy")).toEqual({
      ok: false,
      reason: "invalid-personality",
    });
  });

  it("safely resolves an invalid stored personality to the pet's default", async () => {
    fake.state.rows.set(userId, {
      userId,
      selectedPetKey: "ember-fox",
      uiPreferences: { petPersonality: "not-a-real-personality" },
    });
    expect(await loadCompanion({ id: userId })).toEqual({
      pet: "ember-fox",
      appearance: "classic",
      personality: "curious",
    });

    // A personality the pet does not offer resolves to its default too.
    fake.state.rows.set(userId, {
      userId,
      selectedPetKey: "ember-fox",
      uiPreferences: { petPersonality: "sleepy" },
    });
    expect((await loadCompanion({ id: userId })).personality).toBe("curious");
  });

  it("keeps each account's personality separate", async () => {
    await savePetPersonality(userId, "sleepy");

    expect(await getPetPersonalityKey(userId)).toBe("sleepy");
    // The other account has no row at all.
    expect(await getPetPersonalityKey(otherUserId)).toBeNull();
    expect((await loadCompanion({ id: otherUserId })).personality).toBe("calm");
    // And nothing was written to any row but this user's.
    expect(fake.state.upserts.every((u) => u.where.userId === userId)).toBe(true);
  });

  it("uses defaults for anonymous users and never throws on a failed read", async () => {
    expect(await loadCompanion(null)).toEqual({
      pet: DEFAULT_PET_ID,
      appearance: "classic",
      personality: "calm",
    });

    fake.state.failWith = new Error("db down");
    expect(await loadCompanion({ id: userId })).toEqual({
      pet: DEFAULT_PET_ID,
      appearance: "classic",
      personality: "calm",
    });
  });
});
