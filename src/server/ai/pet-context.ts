import "server-only";
import {
  DEFAULT_PET_ID,
  defaultPersonalityForPet,
  resolvePersonalityForPet,
  resolvePet,
} from "@/features/pets/catalog";
import { PET_STATES } from "@/features/pets/state";
import {
  PET_PERSONALITIES,
  PET_PERSONALITY_MOTION_LEVELS,
  PET_PERSONALITY_TRAITS,
  type PetDefinition,
  type PetPersonality,
  type PetPersonalityDefinition,
  type PetPersonalityHints,
  type PetPersonalityTrait,
} from "@/features/pets/types";
import { loadCompanion } from "../pets/service";

/**
 * The pet-context contract: the *only* companion information the AI layer is allowed
 * to hold, and the only shape it ever sees.
 *
 * It is a deliberate projection rather than a passthrough. Everything the catalog and
 * the database know about a companion is wider than what generation needs, and wider
 * than what should leave the server: this module narrows it once, in one place, so no
 * caller has to remember which fields are safe.
 *
 * Deliberately **absent**, and not by oversight:
 * - the appearance and its palette, the pet's `asset`, `species`, and `description`,
 *   and the personality's `description` — how a companion is drawn or marketed is not
 *   the AI layer's business, and a description is prose nobody asked a model to write;
 * - raw catalog objects and `PetDefinition`/`PetPersonalityDefinition` values, so a
 *   catalog field added later cannot silently start flowing toward a provider;
 * - the `user_preferences` row, `uiPreferences`, and every stored key — no database
 *   record is ever serialized toward the AI layer;
 * - the account: no user id, email, name, session, or conversation identifier;
 * - credentials: no API key, provider identifier, model key, or environment value.
 *
 * What remains is identity plus code-owned behavior metadata, and nothing that
 * identifies a person or the server. The values are catalog constants — a fixed id,
 * a display name, a closed trait vocabulary, and two optional hints — so the contract
 * carries no free-text field a client could have written and no prompt of any kind.
 *
 * This module still only resolves and shapes that context. `pet-instruction.ts`
 * separately translates its trusted traits and hints into a short server-owned
 * instruction; neither this resolver nor a provider adapter builds a pet prompt
 * or sees the preferences row.
 */

/** The companion itself: a stable catalog id and the name a person would use. */
export type AiPetSummary = {
  id: string;
  name: string;
};

/**
 * The companion's personality: identity plus the behavior metadata the catalog
 * already declares. Both are typed against the closed catalog vocabularies, so a
 * value outside them is a type error rather than a string that reaches a provider.
 */
export type AiPersonalitySummary = {
  id: PetPersonality;
  name: string;
  /** Behaviour tags from the fixed vocabulary; never prose. */
  traits: readonly PetPersonalityTrait[];
  /** The two optional behavior hints, when the personality declares any. */
  hints?: PetPersonalityHints;
};

/** Everything the AI layer may know about the signed-in user's companion. */
export type AiPetContext = {
  pet: AiPetSummary;
  personality: AiPersonalitySummary;
};

/**
 * Narrows two catalog definitions to the contract.
 *
 * Pure and total: no database, no request, no session, and no provider. Every field is
 * **copied** rather than aliased, so the object handed to the AI layer shares no
 * structure with the catalog (a consumer cannot mutate the catalog through it, and a
 * catalog entry cannot grow a field that quietly travels along). Traits are filtered
 * against the declared vocabulary for the same reason the rest of this project
 * re-validates what it already types: the value leaving the server is checked, not
 * assumed.
 */
export function toAiPetContext(
  pet: PetDefinition,
  personality: PetPersonalityDefinition,
): AiPetContext {
  const hints = hintContext(personality.hints);
  return {
    pet: { id: pet.id, name: pet.name },
    personality: {
      id: personality.id,
      name: personality.name,
      traits: personality.traits.filter((trait) =>
        (PET_PERSONALITY_TRAITS as readonly string[]).includes(trait),
      ),
      // Present only when the personality declares at least one hint, so the contract
      // never carries an empty object that a consumer might read as meaningful.
      ...(hints ? { hints } : {}),
    },
  };
}

/** A copy of the two declared hints, or `undefined` when there is nothing to say. */
function hintContext(hints: PetPersonalityHints | undefined): PetPersonalityHints | undefined {
  const projected: PetPersonalityHints = {};
  if (hints?.restingState && (PET_STATES as readonly string[]).includes(hints.restingState))
    projected.restingState = hints.restingState;
  if (
    hints?.motionLevel &&
    (PET_PERSONALITY_MOTION_LEVELS as readonly string[]).includes(hints.motionLevel)
  )
    projected.motionLevel = hints.motionLevel;
  return Object.keys(projected).length > 0 ? projected : undefined;
}

/**
 * True for exactly the contract's shape.
 *
 * The resolver builds this shape itself, so the guard is not needed on the happy path;
 * it exists for the same reason the rest of the pet domain has guards — so a boundary
 * (a test, or a later task's prompt builder) can check what it was handed instead of
 * trusting it. It accepts nothing wider: an extra field, a stray description, an
 * appearance, an unknown trait, or a nested database row all fail.
 */
export function isAiPetContext(value: unknown): value is AiPetContext {
  if (!isRecord(value) || !hasExactly(value, ["pet", "personality"])) return false;

  const pet = value.pet;
  if (!isRecord(pet) || !hasExactly(pet, ["id", "name"])) return false;
  if (!isNonEmptyString(pet.id) || !isNonEmptyString(pet.name)) return false;

  const personality = value.personality;
  if (!isRecord(personality)) return false;
  // `hints` is the only optional field; anything else is outside the contract.
  const allowed = ["id", "name", "traits", "hints"];
  if (Object.keys(personality).some((field) => !allowed.includes(field))) return false;
  if (!["id", "name", "traits"].every((field) => field in personality)) return false;
  if (!isNonEmptyString(personality.id)) return false;
  if (!(PET_PERSONALITIES as readonly string[]).includes(personality.id)) return false;
  if (!isNonEmptyString(personality.name)) return false;
  if (!Array.isArray(personality.traits)) return false;
  const vocabulary = PET_PERSONALITY_TRAITS as readonly string[];
  if (!personality.traits.every((trait) => vocabulary.includes(trait as string))) return false;
  // An absent hint and an explicitly undefined one mean the same thing: no hints.
  if (!("hints" in personality) || personality.hints === undefined) return true;
  return isHints(personality.hints);
}

/** True for an object holding only the two declared hints, each within its vocabulary. */
function isHints(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!Object.keys(value).every((key) => ["restingState", "motionLevel"].includes(key)))
    return false;
  const { restingState, motionLevel } = value;
  if (
    restingState !== undefined &&
    !(PET_STATES as readonly string[]).includes(restingState as string)
  )
    return false;
  if (
    motionLevel !== undefined &&
    !(PET_PERSONALITY_MOTION_LEVELS as readonly string[]).includes(motionLevel as string)
  )
    return false;
  return restingState !== undefined || motionLevel !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the object's own keys are exactly these, so nothing extra rode along. */
function hasExactly(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => keys.includes(field));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * The companion context for one request, resolved **server-side** from the
 * authenticated user's own stored preferences.
 *
 * The caller passes the session user and nothing else. There is no parameter for a
 * pet, a personality, or a request body, because there is nothing a client could send
 * that this function would read: the reply endpoint already refuses every body field,
 * and this resolver never looks at one. A browser that claims a different companion
 * gets the companion the account actually stored.
 *
 * Resolution reuses the pet system's existing authority instead of adding a second
 * one — `loadCompanion` reads the same `selectedPetKey` column and the same
 * `uiPreferences` keys the pages read, keyed by this user's id, and the catalog
 * resolves both values:
 * - a missing, unknown, retired, unavailable, or malformed pet falls back to the
 *   catalog default;
 * - a missing, unknown, or malformed personality falls back to that pet's default;
 * - a personality belonging to a *different* pet is not offered by this one, so it
 *   falls back the same way — an incompatible pair can never reach the AI layer;
 * - `null` (a signed-out caller) resolves to the catalog default without a database
 *   read, so no anonymous request can reach anybody's stored preferences.
 *
 * Nothing is written: building context has no side effects on the account, and a
 * stale combination is reported as the valid default rather than repaired in passing.
 *
 * The function is total. A companion is context, never a requirement, so an unexpected
 * failure degrades to the catalog default instead of throwing into a reply that would
 * otherwise have succeeded — the same convention the preference service itself follows.
 */
export async function resolveAiPetContext(user: { id: string } | null): Promise<AiPetContext> {
  try {
    // One read serves both stored keys, so the pet and the personality it is resolved
    // against can never disagree. The appearance comes back with them and is dropped
    // here: it is not part of the contract.
    const companion = await loadCompanion(user);
    const pet = resolvePet(companion.pet);
    return toAiPetContext(pet, resolvePersonalityForPet(pet.id, companion.personality));
  } catch (error) {
    console.error("[ai] Failed to resolve the companion context:", error);
    return catalogDefaultContext();
  }
}

/**
 * The catalog's own default companion. Computed from the catalog rather than written
 * out, so there is no second copy of a pet or personality to fall out of date.
 */
function catalogDefaultContext(): AiPetContext {
  const pet = resolvePet(DEFAULT_PET_ID);
  return toAiPetContext(pet, defaultPersonalityForPet(pet.id));
}
