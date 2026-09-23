import { describe, expect, it } from "vitest";
import {
  DEFAULT_PET_ID,
  PET_CATALOG,
  defaultAppearanceForPet,
  findAppearanceForPet,
  findPet,
  isSelectableAppearance,
  isSelectablePetId,
  listAppearancesForPet,
  listAvailablePets,
  resolveAppearanceForPet,
  resolvePet,
  toRenderablePet,
} from "../src/features/pets/catalog";
import {
  DEFAULT_APPEARANCE_ID,
  isPetAppearance,
  isPetAsset,
  isPetDefinition,
  PET_PALETTES,
  PET_SHAPES,
  PET_SPECIES,
  PET_PERSONALITIES,
} from "../src/features/pets/types";

describe("the pet catalog", () => {
  it("gives every entry a unique id", () => {
    const ids = PET_CATALOG.map((pet) => pet.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every entry the required metadata and a valid asset", () => {
    expect(PET_CATALOG.length).toBeGreaterThan(0);
    for (const pet of PET_CATALOG) {
      expect(pet.id, pet.id).not.toBe("");
      expect(pet.name, pet.id).not.toBe("");
      expect(pet.description, pet.id).not.toBe("");
      expect(PET_SPECIES, pet.id).toContain(pet.species);
      expect(PET_PERSONALITIES, pet.id).toContain(pet.defaultPersonality);
      expect(typeof pet.available, pet.id).toBe("boolean");
      expect(isPetAsset(pet.asset), pet.id).toBe(true);
      expect(isPetDefinition(pet), pet.id).toBe(true);
    }
  });

  it("only draws silhouettes the renderer registers", () => {
    for (const pet of PET_CATALOG) {
      if (pet.asset.kind === "inline-svg") {
        expect(PET_SHAPES, pet.id).toContain(pet.asset.shape);
      }
    }
  });

  it("filters unavailable pets out of the offered list", () => {
    const available = listAvailablePets();
    expect(available.length).toBeLessThan(PET_CATALOG.length);
    expect(available.every((pet) => pet.available)).toBe(true);
    // The placeholder that proves the filter is present in the catalog but not offered.
    expect(PET_CATALOG.some((pet) => !pet.available)).toBe(true);
    expect(available.some((pet) => pet.id === "pip-rabbit")).toBe(false);
  });

  it("finds a known pet", () => {
    expect(findPet("yori-cat")?.name).toBe("Yori");
    expect(findPet("ember-fox")?.species).toBe("fox");
  });

  it("fails safely for an unknown pet", () => {
    expect(findPet("nope")).toBeNull();
    expect(findPet(undefined)).toBeNull();
    expect(findPet({})).toBeNull();
    expect(isSelectablePetId("nope")).toBe(false);
  });

  it("resolves unknown and retired ids to an available default, never throwing", () => {
    const fallback = resolvePet("nope");
    expect(fallback.available).toBe(true);
    expect(fallback.id).toBe(DEFAULT_PET_ID);

    // The retired entry is findable but not selectable, and resolves to the default.
    expect(findPet("pip-rabbit")?.available).toBe(false);
    expect(isSelectablePetId("pip-rabbit")).toBe(false);
    expect(resolvePet("pip-rabbit").id).toBe(DEFAULT_PET_ID);

    // A usable default itself is available and in the catalog.
    expect(listAvailablePets().some((pet) => pet.id === DEFAULT_PET_ID)).toBe(true);
  });

  it("rejects malformed values as renderable pets", () => {
    expect(toRenderablePet(null)).toBeNull();
    expect(toRenderablePet({ id: "x" })).toBeNull();
    expect(toRenderablePet("yori-cat")).toBeNull();
    expect(toRenderablePet(findPet("pip-rabbit"))).toBeNull(); // unavailable
    expect(toRenderablePet(findPet("yori-cat"))?.id).toBe("yori-cat");
  });
});

describe("the appearance catalog", () => {
  it("gives every pet a non-empty list of well-formed appearances with a default first", () => {
    for (const pet of PET_CATALOG) {
      const appearances = listAppearancesForPet(pet.id);
      expect(appearances.length, pet.id).toBeGreaterThan(0);
      for (const appearance of appearances) {
        expect(isPetAppearance(appearance), pet.id).toBe(true);
        expect(PET_PALETTES, pet.id).toContain(appearance.palette);
      }
      expect(appearances[0].id, pet.id).toBe(DEFAULT_APPEARANCE_ID);
      expect(defaultAppearanceForPet(pet.id).id, pet.id).toBe(DEFAULT_APPEARANCE_ID);
    }
  });

  it("keeps appearance ids unique within a pet", () => {
    for (const pet of PET_CATALOG) {
      const ids = listAppearancesForPet(pet.id).map((a) => a.id);
      expect(new Set(ids).size, pet.id).toBe(ids.length);
    }
  });

  it("only lets a selectable pet's own appearances through", () => {
    expect(isSelectableAppearance(DEFAULT_PET_ID, "night")).toBe(true);
    // "ember" belongs to the fox, not the cat.
    expect(isSelectableAppearance(DEFAULT_PET_ID, "ember")).toBe(false);
    expect(isSelectableAppearance(DEFAULT_PET_ID, "disco")).toBe(false);
    // An unavailable pet never becomes selectable just because it has an appearance.
    expect(isSelectableAppearance("pip-rabbit", "classic")).toBe(false);
  });

  it("finds an appearance only for the pet that has it", () => {
    expect(findAppearanceForPet("ember-fox", "ember")?.id).toBe("ember");
    expect(findAppearanceForPet(DEFAULT_PET_ID, "ember")).toBeNull();
    expect(findAppearanceForPet("nope", "night")).toBeNull();
  });

  it("resolves a missing, unknown, or other-pet appearance to that pet's default", () => {
    expect(resolveAppearanceForPet("ember-fox", "ember").id).toBe("ember");
    expect(resolveAppearanceForPet("ember-fox", "disco").id).toBe(DEFAULT_APPEARANCE_ID);
    expect(resolveAppearanceForPet("ember-fox", "frost").id).toBe(DEFAULT_APPEARANCE_ID);
    expect(resolveAppearanceForPet("ember-fox", null).id).toBe(DEFAULT_APPEARANCE_ID);
    // An unknown pet still resolves to a safe default without throwing.
    expect(resolveAppearanceForPet("nope", "ember").id).toBe(DEFAULT_APPEARANCE_ID);
  });
});
