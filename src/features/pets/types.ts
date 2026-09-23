/**
 * The pet domain model: what a pet *is*, independent of how it is drawn, where it
 * appears, or what it will eventually do.
 *
 * Runtime-free and free of React, server-only, and provider imports, so the server
 * page, the renderer, the playground, and the tests all share one contract.
 *
 * Nothing here is persisted yet. Selection and state live in React state on the
 * `/pets` playground; a later task will connect a chosen pet to the existing
 * `user_preferences.selectedPetKey` column (see `docs/database.md`).
 */

import type { PetState } from "./state";

/** Species in the placeholder catalog. A new species adds one member here. */
export const PET_SPECIES = ["cat", "fox", "rabbit"] as const;

export type PetSpecies = (typeof PET_SPECIES)[number];

/**
 * Every personality the catalog defines. This is the closed set of stable ids: a
 * pet may offer a subset, and only one of these ids is ever persisted or sent by a
 * client — never a personality object, and never a natural-language prompt.
 */
export const PET_PERSONALITIES = ["calm", "playful", "curious", "sleepy"] as const;

export type PetPersonality = (typeof PET_PERSONALITIES)[number];

/**
 * Behaviour tags a personality carries. A fixed, code-owned vocabulary so traits stay
 * comparable and machine-readable: they describe tendencies for future behavior tasks
 * to branch on, not prose to feed a model.
 */
export const PET_PERSONALITY_TRAITS = [
  "gentle",
  "energetic",
  "inquisitive",
  "restful",
  "sociable",
  "independent",
] as const;

export type PetPersonalityTrait = (typeof PET_PERSONALITY_TRAITS)[number];

/** How much movement a personality implies. A hint only; nothing animates it yet. */
export const PET_PERSONALITY_MOTION_LEVELS = ["low", "medium", "high"] as const;

export type PetPersonalityMotionLevel = (typeof PET_PERSONALITY_MOTION_LEVELS)[number];

/**
 * Optional, deliberately tiny hooks for later behavior tasks. Nothing consumes these
 * yet, and they must stay small and code-owned: no prompt text, no asset or URL, no
 * arbitrary values a client could supply.
 */
export type PetPersonalityHints = {
  /** The state this personality tends toward when it has nothing to do. */
  restingState?: PetState;
  /** How much movement the personality implies. */
  motionLevel?: PetPersonalityMotionLevel;
};

/**
 * A behaviour definition, not an AI prompt. Catalog-defined and identified by a
 * stable id; the display name, one-line description, and trait tags are metadata for
 * the UI and for future behavior code.
 */
export type PetPersonalityDefinition = {
  /** Stable key within this pet's personality list; what gets persisted. */
  id: PetPersonality;
  /** Human-readable name shown in the playground. */
  name: string;
  /** One short line. Never a system prompt. */
  description: string;
  /** A small set of behaviour tags from the fixed vocabulary. */
  traits: readonly PetPersonalityTrait[];
  /** Optional hints a later task may consume. */
  hints?: PetPersonalityHints;
};

/** True for a value shaped like a catalog personality. */
export function isPetPersonality(value: unknown): value is PetPersonalityDefinition {
  if (typeof value !== "object" || value === null) return false;
  const personality = value as Partial<PetPersonalityDefinition>;
  return (
    isString(personality.id) &&
    (PET_PERSONALITIES as readonly string[]).includes(personality.id) &&
    isString(personality.name) &&
    personality.name !== "" &&
    isString(personality.description) &&
    Array.isArray(personality.traits) &&
    personality.traits.every(
      (trait) =>
        typeof trait === "string" &&
        (PET_PERSONALITY_TRAITS as readonly string[]).includes(trait),
    )
  );
}

/**
 * Silhouettes the renderer knows how to draw inline. The registry in
 * `components/shapes.tsx` is a `Record<PetShapeId, …>`, so adding an animal here
 * without drawing it is a compile error rather than a missing picture.
 */
export const PET_SHAPES = ["cat", "fox", "rabbit"] as const;

export type PetShapeId = (typeof PET_SHAPES)[number];

/**
 * Where a pet's visual comes from. Deliberately abstract: everything except the
 * renderer treats this as an opaque reference, so a later task can add a sprite
 * sheet or a generated asset by adding one member here and one branch in the
 * renderer. The catalog's shape, the state model, and every call site stay put.
 *
 * No provider, generator, or external asset service is named anywhere: `image`
 * is a path the app itself serves.
 */
export type PetAsset =
  /** Drawn from a registered inline silhouette. No network, no build step. */
  | { kind: "inline-svg"; shape: PetShapeId }
  /** A static raster asset shipped with the app. */
  | { kind: "image"; src: string };

/**
 * A named look a pet can wear. Appearances are catalog-defined; only their stable
 * `id` is ever persisted or sent by a client — never colours, CSS, or URLs. The
 * `palette` selects one of a fixed, code-owned set of palettes the stylesheet knows
 * how to paint, so there is no arbitrary CSS/asset injection path.
 */
export const PET_PALETTES = ["classic", "night", "moss", "ember", "frost"] as const;

export type PetPalette = (typeof PET_PALETTES)[number];

/** The look every pet has; a pet with no alternates still has this. */
export const DEFAULT_APPEARANCE_ID = "classic";

export type PetAppearance = {
  /** Stable key within this pet's appearance list; what gets persisted. */
  id: string;
  /** Human-readable name shown in the playground. */
  name: string;
  /** Optional one-liner. */
  description?: string;
  /** Which fixed palette paints it; never user-supplied at render time. */
  palette: PetPalette;
};

/** True for a value shaped like a catalog appearance. */
export function isPetAppearance(value: unknown): value is PetAppearance {
  if (typeof value !== "object" || value === null) return false;
  const appearance = value as Partial<PetAppearance>;
  return (
    isString(appearance.id) &&
    appearance.id !== "" &&
    isString(appearance.name) &&
    isString(appearance.palette) &&
    (PET_PALETTES as readonly string[]).includes(appearance.palette)
  );
}

/** One pet the framework knows about. */
export type PetDefinition = {
  /** Stable identifier: what a later stored preference would reference. */
  id: string;
  /** Display name. */
  name: string;
  species: PetSpecies;
  /** One short line shown with the pet. */
  description: string;
  /** The personality this pet starts with; must be one of `personalities`. */
  defaultPersonality: PetPersonality;
  /** Unavailable pets stay in the catalog but are never offered or drawn. */
  available: boolean;
  asset: PetAsset;
  /** The looks this pet can wear; always includes the default. */
  appearances: readonly PetAppearance[];
  /** The personalities this pet can have; always includes `defaultPersonality`. */
  personalities: readonly PetPersonalityDefinition[];
};

/** Rendered sizes. Pixels live in the stylesheet, not here. */
export const PET_SIZES = ["sm", "md", "lg"] as const;

export type PetSize = (typeof PET_SIZES)[number];

export const DEFAULT_PET_SIZE: PetSize = "md";

/** Short labels for the size controls. */
export const PET_SIZE_LABELS: Record<PetSize, string> = {
  sm: "Small",
  md: "Medium",
  lg: "Large",
};

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** True for exactly the declared asset shapes; anything else is not an asset. */
export function isPetAsset(value: unknown): value is PetAsset {
  if (typeof value !== "object" || value === null) return false;
  const asset = value as { kind?: unknown; shape?: unknown; src?: unknown };
  if (asset.kind === "inline-svg") {
    return isString(asset.shape) && (PET_SHAPES as readonly string[]).includes(asset.shape);
  }
  if (asset.kind === "image") return isString(asset.src) && asset.src !== "";
  return false;
}

/**
 * True for a value shaped like a catalog entry. The renderer is typed, so this is
 * not needed on the happy path; it exists so a pet that arrives from anywhere else
 * — a stored key resolved by a later task, a test fixture, a malformed object —
 * degrades to a labelled placeholder instead of throwing mid-render.
 */
export function isPetDefinition(value: unknown): value is PetDefinition {
  if (typeof value !== "object" || value === null) return false;
  const pet = value as Partial<PetDefinition>;
  return (
    isString(pet.id) &&
    pet.id !== "" &&
    isString(pet.name) &&
    isString(pet.description) &&
    isString(pet.species) &&
    (PET_SPECIES as readonly string[]).includes(pet.species) &&
    isString(pet.defaultPersonality) &&
    (PET_PERSONALITIES as readonly string[]).includes(pet.defaultPersonality) &&
    typeof pet.available === "boolean" &&
    isPetAsset(pet.asset) &&
    Array.isArray(pet.appearances) &&
    pet.appearances.length > 0 &&
    pet.appearances.every(isPetAppearance) &&
    Array.isArray(pet.personalities) &&
    pet.personalities.length > 0 &&
    pet.personalities.every(isPetPersonality) &&
    // The declared default must actually be one this pet offers, so a pet can never
    // resolve to a personality it does not have.
    pet.personalities.some((personality) => personality.id === pet.defaultPersonality)
  );
}

/** The name a screen reader hears: stable, so a changing state never re-announces. */
export function petLabel(pet: PetDefinition): string {
  return `${pet.name}, a ${pet.species}`;
}
