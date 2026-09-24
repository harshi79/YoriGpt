import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PetPersonalityDefinition } from "../src/features/pets/types";

vi.mock("server-only", () => ({}));

/**
 * The AI pet-context contract and its resolver.
 *
 * The resolver is exercised against a fake `user_preferences` table, so the stored
 * selection, the catalog fallbacks, the user scoping, and the absence of any write can
 * be inspected directly — no PostgreSQL and no network. Real database behavior for the
 * underlying preference reads is covered by `tests/database/pets.integration.ts`, and
 * the reply flow that consumes the context by `tests/reply-service.test.ts`.
 *
 * What is being pinned here is a security boundary as much as a mapping: the AI layer
 * may only ever see the catalog-narrowed companion of the *authenticated* user, resolved
 * server-side, and never a value a browser sent, a raw preference row, or a credential.
 */
const fake = vi.hoisted(() => {
  const state = {
    rows: new Map<
      string,
      { userId: string; selectedPetKey: string | null; uiPreferences: unknown }
    >(),
    /** Every user id a read was scoped to, in order. */
    reads: [] as string[],
    /** Any write at all is a failure: building context must not touch the account. */
    writes: 0,
    failWith: null as unknown,
  };
  const refuseWrite = () => {
    state.writes += 1;
    return Promise.resolve({ userId: "written" });
  };
  return {
    state,
    db: {
      userPreferences: {
        findUnique: async (args: { where: { userId: string } }) => {
          if (state.failWith) throw state.failWith;
          state.reads.push(args.where.userId);
          return state.rows.get(args.where.userId) ?? null;
        },
        upsert: refuseWrite,
        update: refuseWrite,
        create: refuseWrite,
        updateMany: refuseWrite,
        delete: refuseWrite,
      },
    },
  };
});

vi.mock("../src/server/db/client", () => ({ getDb: () => fake.db }));

const { isAiPetContext, resolveAiPetContext, toAiPetContext } = await import(
  "../src/server/ai/pet-context"
);
const { loadCompanion } = await import("../src/server/pets/service");
const {
  DEFAULT_PET_ID,
  PET_CATALOG,
  defaultPersonalityForPet,
  listPersonalitiesForPet,
  resolvePet,
  resolvePersonalityForPet,
} = await import("../src/features/pets/catalog");
const { PET_PERSONALITIES } = await import("../src/features/pets/types");

const userId = "cmuser00000000000000001";
const otherUserId = "cmuser00000000000000002";

/** Store one preference row exactly as the pet routes would have written it. */
function store(
  id: string,
  selectedPetKey: string | null,
  uiPreferences: unknown = { petPersonality: null },
) {
  fake.state.rows.set(id, { userId: id, selectedPetKey, uiPreferences });
}

/** The catalog's own default companion, projected — the fallback every test can expect. */
function catalogDefault() {
  const pet = resolvePet(DEFAULT_PET_ID);
  return toAiPetContext(pet, defaultPersonalityForPet(pet.id));
}

beforeEach(() => {
  fake.state.rows.clear();
  fake.state.reads = [];
  fake.state.writes = 0;
  fake.state.failWith = null;
  vi.restoreAllMocks();
});

describe("the contract the AI layer is allowed to hold", () => {
  it("narrows two catalog definitions to exactly the intended fields", () => {
    const context = toAiPetContext(
      resolvePet("ember-fox"),
      resolvePersonalityForPet("ember-fox", "playful"),
    );

    expect(context).toEqual({
      pet: { id: "ember-fox", name: "Ember" },
      personality: {
        id: "playful",
        name: "Playful",
        traits: ["energetic", "sociable"],
        hints: { restingState: "happy", motionLevel: "high" },
      },
    });

    // Exactly these keys, and no others: the projection is the guarantee.
    expect(Object.keys(context).sort()).toEqual(["personality", "pet"]);
    expect(Object.keys(context.pet).sort()).toEqual(["id", "name"]);
    expect(Object.keys(context.personality).sort()).toEqual(["hints", "id", "name", "traits"]);
    expect(isAiPetContext(context)).toBe(true);
  });

  it("carries nothing a provider should not see", () => {
    const context = toAiPetContext(
      resolvePet("yori-cat"),
      resolvePersonalityForPet("yori-cat", "sleepy"),
    );
    const serialized = JSON.stringify(context).toLowerCase();

    // No appearance or palette, no asset or species, no catalog prose, no preference
    // row or account field, and no credential or provider identifier.
    for (const forbidden of [
      "appearance",
      "palette",
      "asset",
      "species",
      "description",
      "uipreferences",
      "selectedpetkey",
      "userid",
      "email",
      "session",
      "token",
      "secret",
      "openrouter",
      "sk-or",
      "api_key",
      "apikey",
      "password",
      "conversation",
      "defaultpersonality",
      "available",
    ])
      expect(serialized, forbidden).not.toContain(forbidden);

    // And the JSON is small enough to reason about: two objects, four and five fields.
    expect(serialized.length).toBeLessThan(300);
  });

  it("omits hints entirely for a personality that declares none", () => {
    const bare: PetPersonalityDefinition = {
      id: "calm",
      name: "Calm",
      description: "A definition with no hints at all.",
      traits: ["gentle"],
    };

    const context = toAiPetContext(resolvePet("yori-cat"), bare);

    expect("hints" in context.personality).toBe(false);
    expect(isAiPetContext(context)).toBe(true);
  });

  it("drops a trait outside the declared vocabulary instead of forwarding it", () => {
    const invented: PetPersonalityDefinition = {
      id: "curious",
      name: "Curious",
      description: "A definition carrying a trait nobody declared.",
      traits: ["inquisitive", "obedient", ""] as unknown as PetPersonalityDefinition["traits"],
    };

    const context = toAiPetContext(resolvePet("yori-cat"), invented);

    expect(context.personality.traits).toEqual(["inquisitive"]);
    expect(isAiPetContext(context)).toBe(true);
  });

  it("copies every field, so the AI layer cannot reach the catalog through it", () => {
    const pet = resolvePet("ember-fox");
    const personality = resolvePersonalityForPet("ember-fox", "curious");

    const first = toAiPetContext(pet, personality);
    // A consumer that mutates what it was given must not be able to change the catalog.
    (first.personality.traits as string[]).push("invented");
    if (first.personality.hints) first.personality.hints.motionLevel = "low";
    (first.pet as { name: string }).name = "Renamed";

    const second = toAiPetContext(pet, personality);
    expect(second).toEqual({
      pet: { id: "ember-fox", name: "Ember" },
      personality: {
        id: "curious",
        name: "Curious",
        traits: ["inquisitive", "energetic"],
        hints: { restingState: "thinking", motionLevel: "medium" },
      },
    });
    // The catalog definitions themselves are untouched.
    expect(personality.traits).toEqual(["inquisitive", "energetic"]);
    expect(personality.hints?.motionLevel).toBe("medium");
    expect(pet.name).toBe("Ember");
  });

  it("accepts only the contract's shape", () => {
    const valid = toAiPetContext(
      resolvePet("yori-cat"),
      resolvePersonalityForPet("yori-cat", "calm"),
    );
    expect(isAiPetContext(valid)).toBe(true);
    expect(isAiPetContext(structuredClone(valid))).toBe(true);

    const rejected: [string, unknown][] = [
      ["nothing", undefined],
      ["a string", "calm"],
      ["an array", []],
      ["an extra top-level field", { ...valid, user: { id: userId } }],
      ["a raw preference row", { ...valid, uiPreferences: { petPersonality: "calm" } }],
      ["a pet with its species", { ...valid, pet: { ...valid.pet, species: "cat" } }],
      ["a pet with its appearance", { ...valid, pet: { ...valid.pet, appearance: "classic" } }],
      ["an empty pet id", { ...valid, pet: { ...valid.pet, id: "" } }],
      [
        "a personality with its description",
        { ...valid, personality: { ...valid.personality, description: "Settled." } },
      ],
      [
        "a personality id outside the catalog",
        { ...valid, personality: { ...valid.personality, id: "mischievous" } },
      ],
      [
        "a trait outside the vocabulary",
        { ...valid, personality: { ...valid.personality, traits: ["obedient"] } },
      ],
      [
        "traits that are not a list",
        { ...valid, personality: { ...valid.personality, traits: "gentle" } },
      ],
      ["empty hints", { ...valid, personality: { ...valid.personality, hints: {} } }],
      [
        "an unknown hint",
        { ...valid, personality: { ...valid.personality, hints: { voice: "soft" } } },
      ],
      [
        "a hint outside its vocabulary",
        { ...valid, personality: { ...valid.personality, hints: { motionLevel: "extreme" } } },
      ],
      ["a missing personality", { pet: valid.pet }],
    ];

    for (const [label, value] of rejected) expect(isAiPetContext(value), label).toBe(false);
  });
});

describe("server-side resolution of the stored companion", () => {
  it("resolves a stored, compatible selection", async () => {
    store(userId, "ember-fox", { petAppearance: "ember", petPersonality: "playful" });

    const context = await resolveAiPetContext({ id: userId });

    expect(context).toEqual({
      pet: { id: "ember-fox", name: "Ember" },
      personality: {
        id: "playful",
        name: "Playful",
        traits: ["energetic", "sociable"],
        hints: { restingState: "happy", motionLevel: "high" },
      },
    });
    expect(isAiPetContext(context)).toBe(true);
    // The appearance was stored beside it and is not part of the contract.
    expect(JSON.stringify(context)).not.toContain('"ember"');
    expect(JSON.stringify(context)).not.toContain("appearance");
    // Every read was scoped to the caller's own row.
    expect(fake.state.reads).toEqual([userId, userId]);
  });

  it("resolves the catalog default when nothing is stored", async () => {
    expect(await resolveAiPetContext({ id: userId })).toEqual(catalogDefault());

    // A row with no pet and no personality behaves the same way.
    store(userId, null, {});
    expect(await resolveAiPetContext({ id: userId })).toEqual(catalogDefault());
  });

  it("resolves the pet's own default personality when no personality is stored", async () => {
    store(userId, "ember-fox", { petAppearance: "night" });

    const context = await resolveAiPetContext({ id: userId });

    expect(context.pet).toEqual({ id: "ember-fox", name: "Ember" });
    expect(context.personality.id).toBe(defaultPersonalityForPet("ember-fox").id);
    expect(context.personality.id).toBe("curious");
  });

  it("resolves a personality that belongs to a different pet back to that pet's default", async () => {
    // Ember's playful personality is not offered by Yori, so the pair is incompatible.
    store(userId, "yori-cat", { petPersonality: "playful" });

    const context = await resolveAiPetContext({ id: userId });

    expect(context.pet.id).toBe("yori-cat");
    expect(context.personality.id).toBe("calm");
    expect(listPersonalitiesForPet(context.pet.id).map((p) => p.id)).toContain(
      context.personality.id,
    );
  });

  it("resolves an unavailable pet to the default, and the personality against that pet", async () => {
    // Pip is in the catalog but not offered, so it can never be a selection.
    store(userId, "pip-rabbit", { petPersonality: "sleepy" });
    const withOfferedPersonality = await resolveAiPetContext({ id: userId });
    expect(withOfferedPersonality.pet.id).toBe(DEFAULT_PET_ID);
    // The stored personality is re-resolved against the pet that will actually be used:
    // sleepy *is* offered by the default cat, so it survives the pet fallback.
    expect(withOfferedPersonality.personality.id).toBe("sleepy");

    // …and one that the fallback pet does not offer resolves to that pet's default.
    store(userId, "pip-rabbit", { petPersonality: "playful" });
    const withForeignPersonality = await resolveAiPetContext({ id: userId });
    expect(withForeignPersonality.pet.id).toBe(DEFAULT_PET_ID);
    expect(withForeignPersonality.personality.id).toBe("calm");
  });

  it("resolves unknown, retired, and malformed stored values to the default", async () => {
    const stale: [string, unknown][] = [
      ["a retired pet id", "retired-pet"],
      ["an empty string", ""],
      ["a number", 42],
      ["an object", { id: "ember-fox" }],
    ];
    for (const [label, selectedPetKey] of stale) {
      store(userId, selectedPetKey as string | null, { petPersonality: "curious" });
      const context = await resolveAiPetContext({ id: userId });
      expect(context.pet.id, label).toBe(DEFAULT_PET_ID);
      expect(isAiPetContext(context), label).toBe(true);
    }

    const malformedPreferences: unknown[] = [
      "calm",
      42,
      null,
      [],
      { petPersonality: 42 },
      { petPersonality: "" },
      { petPersonality: ["calm"] },
      { petPersonality: { id: "calm" } },
      { __proto__: null, petPersonality: "calm" },
    ];
    for (const uiPreferences of malformedPreferences) {
      store(userId, "yori-cat", uiPreferences);
      const context = await resolveAiPetContext({ id: userId });
      expect(context.pet.id, JSON.stringify(uiPreferences)).toBe("yori-cat");
      expect(isAiPetContext(context), JSON.stringify(uiPreferences)).toBe(true);
      // Whatever was stored, the personality is one the cat actually offers.
      expect(listPersonalitiesForPet("yori-cat").map((p) => p.id)).toContain(
        context.personality.id,
      );
    }
  });

  it("never returns a personality the resolved pet does not offer", async () => {
    // Every stored combination the catalog can produce, including the impossible ones.
    const petKeys = [...PET_CATALOG.map((pet) => pet.id), "nope", "", "pip-rabbit"];
    const personalityKeys: unknown[] = [...PET_PERSONALITIES, "nope", "", 42, null, {}];

    for (const petKey of petKeys) {
      for (const personalityKey of personalityKeys) {
        store(userId, petKey, { petPersonality: personalityKey });
        const context = await resolveAiPetContext({ id: userId });
        const label = `${petKey}/${JSON.stringify(personalityKey)}`;

        expect(isAiPetContext(context), label).toBe(true);
        // The companion is always one a visitor could choose and see.
        expect(resolvePet(context.pet.id).available, label).toBe(true);
        expect(context.pet.name, label).toBe(resolvePet(context.pet.id).name);
        // And the personality always belongs to it.
        expect(
          listPersonalitiesForPet(context.pet.id).some((p) => p.id === context.personality.id),
          label,
        ).toBe(true);
        expect(context.personality.name, label).toBe(
          resolvePersonalityForPet(context.pet.id, context.personality.id).name,
        );
      }
    }
  });

  it("reads the same stored selection the pages read, so there is one source of truth", async () => {
    store(userId, "ember-fox", { petAppearance: "night", petPersonality: "playful" });

    const companion = await loadCompanion({ id: userId });
    const context = await resolveAiPetContext({ id: userId });

    expect(context.pet.id).toBe(companion.pet);
    expect(context.personality.id).toBe(companion.personality);
    // The appearance the pages need is deliberately not part of the contract.
    expect(companion.appearance).toBe("night");
    expect(JSON.stringify(context)).not.toContain("night");
  });

  it("keeps one account's companion out of another account's context", async () => {
    store(userId, "ember-fox", { petPersonality: "playful" });
    store(otherUserId, "yori-cat", { petPersonality: "sleepy" });

    const mine = await resolveAiPetContext({ id: userId });
    const theirs = await resolveAiPetContext({ id: otherUserId });

    expect(mine.pet.id).toBe("ember-fox");
    expect(mine.personality.id).toBe("playful");
    expect(theirs.pet.id).toBe("yori-cat");
    expect(theirs.personality.id).toBe("sleepy");
    // Each resolution read only its own user's rows.
    expect(fake.state.reads.filter((id) => id === userId).length).toBeGreaterThan(0);
    expect(fake.state.reads).not.toContain("somebody-else");
    // And an account with no row at all gets the default, never another user's choice.
    expect(await resolveAiPetContext({ id: "cmuser00000000000000003" })).toEqual(catalogDefault());
  });

  it("resolves the catalog default for a signed-out caller without reading any row", async () => {
    const context = await resolveAiPetContext(null);

    expect(context).toEqual(catalogDefault());
    // No user, no read: an anonymous request cannot reach anybody's stored preferences.
    expect(fake.state.reads).toEqual([]);

    store(userId, "ember-fox", { petPersonality: "playful" });
    expect(await resolveAiPetContext(null)).toEqual(catalogDefault());
    expect(fake.state.reads).toEqual([]);
  });

  it("ignores every field of the caller except the user id", async () => {
    store(userId, "yori-cat", { petPersonality: "sleepy" });

    // A caller that smuggles a pet, a personality, a preference object, or a credential
    // along with the session user changes nothing: none of it is read.
    const smuggled = {
      id: userId,
      pet: "ember-fox",
      petKey: "ember-fox",
      personality: "playful",
      petPersonality: "playful",
      uiPreferences: { petPersonality: "playful" },
      selectedPetKey: "ember-fox",
      apiKey: "test-key-not-a-secret",
      email: "somebody@example.com",
    } as unknown as { id: string };

    const context = await resolveAiPetContext(smuggled);

    expect(context).toEqual({
      pet: { id: "yori-cat", name: "Yori" },
      personality: {
        id: "sleepy",
        name: "Sleepy",
        traits: ["restful", "gentle"],
        hints: { restingState: "sleeping", motionLevel: "low" },
      },
    });
    expect(JSON.stringify(context)).not.toContain("test-key-not-a-secret");
    expect(JSON.stringify(context)).not.toContain("somebody@example.com");
    // The stored row was not "corrected" to match the claim either.
    expect(fake.state.rows.get(userId)?.selectedPetKey).toBe("yori-cat");
  });

  it("has no parameter through which a request could supply a companion", () => {
    // One argument: the session user. There is nowhere to put a pet or personality id.
    expect(resolveAiPetContext.length).toBe(1);
  });

  it("writes nothing while building context", async () => {
    store(userId, "pip-rabbit", { petPersonality: "playful" });
    const before = structuredClone(fake.state.rows.get(userId));

    // Even a stale, incompatible selection is resolved, not repaired: fixing the row is
    // the settings route's job, and only when the user asks for it.
    const context = await resolveAiPetContext({ id: userId });
    expect(isAiPetContext(context)).toBe(true);

    expect(fake.state.writes).toBe(0);
    expect(fake.state.rows.get(userId)).toEqual(before);
  });

  it("degrades to the catalog default when a preference read fails", async () => {
    store(userId, "ember-fox", { petPersonality: "playful" });
    fake.state.failWith = new Error("database unreachable");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    // A companion is context, never a requirement: a reply must not fail because of one.
    await expect(resolveAiPetContext({ id: userId })).resolves.toEqual(catalogDefault());
    expect(errors).toHaveBeenCalled();
  });

  it("degrades to the catalog default when the preference service itself throws", async () => {
    // `loadCompanion` already survives a database failure; this covers the resolver's
    // own guarantee, whatever the reason something below it throws.
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    vi.doMock("../src/server/pets/service", () => ({
      loadCompanion: async () => {
        throw new Error("preference service unavailable");
      },
    }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const fresh = await import("../src/server/ai/pet-context");
      await expect(fresh.resolveAiPetContext({ id: userId })).resolves.toEqual(catalogDefault());
      expect(errors).toHaveBeenCalledWith(
        "[ai] Failed to resolve the companion context:",
        expect.any(Error),
      );
    } finally {
      vi.doUnmock("../src/server/pets/service");
      vi.resetModules();
      errors.mockRestore();
    }
  });
});

describe("the boundary the contract stops at", () => {
  const provider = readFileSync("src/server/ai/providers/openrouter.ts", "utf8");
  const contract = readFileSync("src/server/ai/pet-context.ts", "utf8");

  it("keeps the provider adapter unaware of companions", () => {
    // Provider-specific code stays unaware of pets: it receives turns and a catalog
    // model key, exactly as it did before this contract existed.
    expect(provider).not.toMatch(/\bpets?\b/i);
    expect(provider).not.toMatch(/\bpersonalit(?:y|ies)\b/i);
    expect(provider).not.toMatch(/\bcompanions?\b/i);
    expect(provider).not.toContain("AiPetContext");
    expect(provider).not.toContain("pet-context");
  });

  it("keeps the provider adapter away from the database and the stored preferences", () => {
    for (const forbidden of [
      "@prisma",
      "db/client",
      "getDb",
      "pets/service",
      "loadCompanion",
      "userPreferences",
      "uiPreferences",
      "selectedPetKey",
    ])
      expect(provider, forbidden).not.toContain(forbidden);
  });

  it("keeps the contract and its resolver server-side, and free of its own queries", () => {
    // Neither can be pulled into a client bundle, and the resolver reads preferences
    // through the service that already owns them instead of querying a table itself —
    // one source of truth, and no second place for a fallback rule to drift.
    expect(contract.startsWith('import "server-only";')).toBe(true);
    expect(contract).toContain('import { loadCompanion } from "../pets/service";');
    expect(contract).not.toContain("getDb");
    expect(contract).not.toContain("@prisma");
    expect(contract).not.toContain("userPreferences");
  });
});
