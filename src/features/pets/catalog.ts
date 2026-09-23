import {
  DEFAULT_APPEARANCE_ID,
  isPetDefinition,
  type PetAppearance,
  type PetDefinition,
  type PetPersonality,
  type PetPersonalityDefinition,
} from "./types";

/**
 * The pet catalog: the only place that decides which pets exist and which of them
 * are offered.
 *
 * Unlike the model catalog (`src/server/ai/models/catalog.ts`) this one is **not**
 * `server-only`, and that is deliberate: a pet is presentation data with no secret
 * and no provider identifier behind it, so the browser can render the same catalog
 * the server listed. There is still exactly one list, and a pet that is not in it
 * cannot be drawn — `resolvePet` falls back instead of inventing one.
 *
 * Three placeholder pets, drawn from inline silhouettes: enough to prove the
 * framework handles several definitions, and none of them a finished character.
 * `available: false` follows the model catalog's convention for an entry that is
 * kept but not offered.
 */
/**
 * The personality library: the only place personalities are *defined*. Each entry is
 * a behaviour definition — a stable id, a display name, one short line, and a few
 * tags from the fixed trait vocabulary — never a prompt, and never anything a client
 * can supply. Pets below reference these by key, so a personality is written once and
 * a pet that offers it cannot drift from its definition.
 *
 * Typing the record as `Record<PetPersonality, …>` makes the set exhaustive: adding an
 * id to `PET_PERSONALITIES` without defining it here is a compile error.
 */
const PERSONALITY_LIBRARY: Record<PetPersonality, PetPersonalityDefinition> = {
  calm: {
    id: "calm",
    name: "Calm",
    description: "Settled and unhurried; happy to simply keep you company.",
    traits: ["gentle", "independent"],
    hints: { restingState: "idle", motionLevel: "low" },
  },
  playful: {
    id: "playful",
    name: "Playful",
    description: "Quick to perk up and always ready for a small distraction.",
    traits: ["energetic", "sociable"],
    hints: { restingState: "happy", motionLevel: "high" },
  },
  curious: {
    id: "curious",
    name: "Curious",
    description: "Notices new ideas first and likes to look a little closer.",
    traits: ["inquisitive", "energetic"],
    hints: { restingState: "thinking", motionLevel: "medium" },
  },
  sleepy: {
    id: "sleepy",
    name: "Sleepy",
    description: "Low-key and drowsy; prefers a quiet corner and a slow blink.",
    traits: ["restful", "gentle"],
    hints: { restingState: "sleeping", motionLevel: "low" },
  },
};

export const PET_CATALOG: readonly PetDefinition[] = [
  {
    id: "yori-cat",
    name: "Yori",
    species: "cat",
    description: "A quiet companion that watches the conversation go by.",
    defaultPersonality: "calm",
    available: true,
    asset: { kind: "inline-svg", shape: "cat" },
    appearances: [
      { id: "classic", name: "Classic", palette: "classic", description: "The original charcoal-and-mint look." },
      { id: "night", name: "Night", palette: "night", description: "A deeper, cooler coat for late sessions." },
      { id: "moss", name: "Moss", palette: "moss", description: "A soft green, like the cat rolled in the garden." },
    ],
    // A small, deliberate subset: Yori is not offered the fox's `playful`.
    personalities: [PERSONALITY_LIBRARY.calm, PERSONALITY_LIBRARY.sleepy, PERSONALITY_LIBRARY.curious],
  },
  {
    id: "ember-fox",
    name: "Ember",
    species: "fox",
    description: "Alert and quick, always first to notice a new idea.",
    defaultPersonality: "curious",
    available: true,
    asset: { kind: "inline-svg", shape: "fox" },
    appearances: [
      { id: "classic", name: "Classic", palette: "classic", description: "The original warm fox." },
      { id: "ember", name: "Flame", palette: "ember", description: "A brighter, fire-lit coat." },
      { id: "night", name: "Night", palette: "night", description: "A cool, dusk-toned fox." },
    ],
    // No `sleepy` here, so a cat's sleepy choice is invalid for this pet.
    personalities: [PERSONALITY_LIBRARY.curious, PERSONALITY_LIBRARY.playful],
  },
  {
    id: "pip-rabbit",
    name: "Pip",
    species: "rabbit",
    description: "Not offered yet; kept here so the catalog can carry a pet that is not selectable.",
    defaultPersonality: "playful",
    // Proves the availability filter: listed in the catalog, never offered or drawn.
    available: false,
    asset: { kind: "inline-svg", shape: "rabbit" },
    appearances: [
      { id: "classic", name: "Classic", palette: "classic", description: "The original rabbit." },
      { id: "frost", name: "Frost", palette: "frost", description: "A pale, winter-white coat." },
    ],
    personalities: [PERSONALITY_LIBRARY.playful, PERSONALITY_LIBRARY.sleepy],
  },
];

/** The pet shown when nothing else is chosen. Must be an available catalog entry. */
export const DEFAULT_PET_ID = "yori-cat";

const byId = new Map(PET_CATALOG.map((pet) => [pet.id, pet]));

/** The catalog entry for an id, available or not; `null` when the id is unknown. */
export function findPet(id: unknown): PetDefinition | null {
  if (typeof id !== "string") return null;
  return byId.get(id) ?? null;
}

/** True when this id names a pet the user may choose and see. */
export function isSelectablePetId(id: unknown): boolean {
  return findPet(id)?.available === true;
}

/** The pets that can be chosen and drawn, in catalog order. */
export function listAvailablePets(): PetDefinition[] {
  return PET_CATALOG.filter((pet) => pet.available);
}

/**
 * A pet that is always safe to render: the requested one when it is a real,
 * available catalog entry, otherwise the default. Unknown, retired, malformed,
 * and missing ids all land here, so no caller has to handle "no pet" and an
 * unusable value can never reach the renderer as one.
 */
export function resolvePet(id: unknown): PetDefinition {
  const pet = findPet(id);
  if (pet?.available) return pet;

  const fallback = byId.get(DEFAULT_PET_ID);
  // Guarded rather than assumed: a catalog edit that removes or disables the
  // default would otherwise throw while rendering a page.
  if (fallback?.available) return fallback;
  const firstAvailable = listAvailablePets()[0];
  if (firstAvailable) return firstAvailable;
  throw new Error("The pet catalog has no available pet to render.");
}

/**
 * The pet a caller can hand straight to the renderer without checking it first.
 * `null` means the value was not a usable pet — the caller then decides whether to
 * draw nothing or fall back, which is what the renderer does internally.
 */
export function toRenderablePet(value: unknown): PetDefinition | null {
  if (!isPetDefinition(value)) return null;
  return value.available ? value : null;
}

/**
 * Appearance lookups. The catalog stays the single source of truth: these only read
 * the `appearances` list each pet declares, and every one of them degrades to the
 * pet's default look instead of throwing, so a stored or sent key that is missing,
 * unknown, or from another pet can never break the renderer.
 */

/** A pet's declared looks, in catalog order; an unknown pet yields none. */
export function listAppearancesForPet(petId: unknown): PetAppearance[] {
  return [...(findPet(petId)?.appearances ?? [])];
}

/** The look a pet shows when nothing (or nothing valid) is chosen. Never null. */
export function defaultAppearanceForPet(petId: unknown): PetAppearance {
  const first = findPet(petId)?.appearances[0];
  return first ?? { id: DEFAULT_APPEARANCE_ID, name: "Classic", palette: "classic" };
}

/** The appearance for a pet by id, or `null` when the pet does not offer it. */
export function findAppearanceForPet(petId: unknown, appearanceId: unknown): PetAppearance | null {
  if (typeof appearanceId !== "string") return null;
  return findPet(petId)?.appearances.find((a) => a.id === appearanceId) ?? null;
}

/** True when the pet is offered *and* it lists that appearance. */
export function isSelectableAppearance(petId: unknown, appearanceId: unknown): boolean {
  const pet = findPet(petId);
  return Boolean(pet?.available) && findAppearanceForPet(petId, appearanceId) !== null;
}

/**
 * The appearance a renderer or page should use for a pet: the requested one when the
 * pet offers it, otherwise that pet's default. An id belonging to a different pet is
 * simply not offered here, so it falls back — the API rejects it separately.
 */
export function resolveAppearanceForPet(petId: unknown, appearanceId: unknown): PetAppearance {
  return findAppearanceForPet(petId, appearanceId) ?? defaultAppearanceForPet(petId);
}

/**
 * Personality lookups, following the same rules as appearances: the catalog is the
 * single source of truth, a personality must belong to the pet that offers it, and
 * every lookup degrades to that pet's declared default instead of throwing — so a
 * stored or sent key that is missing, unknown, or from another pet can never break a
 * page. Availability is checked the same way too: a pet that is not offered can never
 * have a personality selected, however valid the id looks.
 */

/** A pet's declared personalities, in catalog order; an unknown pet yields none. */
export function listPersonalitiesForPet(petId: unknown): PetPersonalityDefinition[] {
  return [...(findPet(petId)?.personalities ?? [])];
}

/**
 * The personality a pet starts with: the one its `defaultPersonality` names, or the
 * first it declares. Never null, so a pet with a single personality still has a
 * default and a malformed catalog entry still resolves to something real.
 */
export function defaultPersonalityForPet(petId: unknown): PetPersonalityDefinition {
  const pet = findPet(petId);
  const offered = pet?.personalities ?? [];
  return (
    offered.find((personality) => personality.id === pet?.defaultPersonality) ??
    offered[0] ??
    PERSONALITY_LIBRARY.calm
  );
}

/** The personality for a pet by id, or `null` when that pet does not offer it. */
export function findPersonalityForPet(
  petId: unknown,
  personalityId: unknown,
): PetPersonalityDefinition | null {
  if (typeof personalityId !== "string") return null;
  return findPet(petId)?.personalities.find((personality) => personality.id === personalityId) ?? null;
}

/** True when the pet is offered *and* it lists that personality. */
export function isSelectablePersonality(petId: unknown, personalityId: unknown): boolean {
  const pet = findPet(petId);
  return Boolean(pet?.available) && findPersonalityForPet(petId, personalityId) !== null;
}

/**
 * The personality a page or companion should use for a pet: the requested one when the
 * pet offers it, otherwise that pet's default. An id belonging to a different pet is
 * simply not offered here, so it falls back — the API rejects it separately.
 */
export function resolvePersonalityForPet(
  petId: unknown,
  personalityId: unknown,
): PetPersonalityDefinition {
  return findPersonalityForPet(petId, personalityId) ?? defaultPersonalityForPet(petId);
}
