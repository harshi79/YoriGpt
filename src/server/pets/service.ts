import "server-only";
import {
  DEFAULT_PET_ID,
  defaultAppearanceForPet,
  defaultPersonalityForPet,
  isSelectableAppearance,
  isSelectablePersonality,
  isSelectablePetId,
  resolveAppearanceForPet,
  resolvePersonalityForPet,
} from "@/features/pets/catalog";
import { getDb } from "../db/client";

/**
 * The appearance is stored as a stable key inside the existing, schema-blessed
 * `user_preferences.uiPreferences` JSON object (its comment designates it for pet
 * preferences), under this property. No new column, table, or migration: only a key
 * is persisted, never colours or an appearance object, and the key is always
 * validated against the catalog for the user's currently selected pet.
 */
const PET_APPEARANCE_KEY = "petAppearance";

/**
 * The personality is stored the same way, beside the appearance and the selected pet:
 * one stable catalog key in the same `uiPreferences` object. Only the key is kept —
 * never the personality object, its traits, or anything resembling a prompt — and it
 * is always validated against the catalog for the user's currently selected pet.
 */
const PET_PERSONALITY_KEY = "petPersonality";

/**
 * The signed-in user's pet companion preference, stored in the existing
 * `user_preferences.selectedPetKey` column. No new table, no migration: the column
 * has been part of the schema since the initial migration and was simply unwired.
 *
 * This is the only server code that reads or writes that column, and it reuses the
 * browser-shared catalog (`@/features/pets/catalog`) for validation and fallback —
 * the catalog is not duplicated here. Every function is keyed by the authenticated
 * user's id, so one account can never read or change another account's choice.
 *
 * A "selected pet" is always an *available* catalog key. A missing, unknown, retired,
 * or malformed stored value is not an error: it resolves to the catalog default, so
 * the UI always has a pet to draw and a bad row can never break a page.
 */

/** The raw stored key for one user, or `null` when nothing is stored. */
export async function getSelectedPetKey(userId: string): Promise<string | null> {
  const row = await getDb().userPreferences.findUnique({
    where: { userId },
    select: { selectedPetKey: true },
  });
  return row?.selectedPetKey ?? null;
}

/**
 * The pet a page should render for this user: their stored, still-available choice,
 * or the catalog default. Never throws, so a database outage degrades to the default
 * instead of failing the page (the same convention as the theme preference).
 */
export async function resolveSelectedPetKey(userId: string): Promise<string> {
  try {
    const stored = await getSelectedPetKey(userId);
    return isSelectablePetId(stored) ? (stored as string) : DEFAULT_PET_ID;
  } catch (error) {
    console.error("[pets] Failed to load the selected pet:", error);
    return DEFAULT_PET_ID;
  }
}

/**
 * The companion the chat empty state shows. Anonymous visitors get the catalog
 * default without touching the database; signed-in users get their stored choice.
 */
export async function loadCompanionPetKey(user: { id: string } | null): Promise<string> {
  if (!user) return DEFAULT_PET_ID;
  return resolveSelectedPetKey(user.id);
}

export type SavePetResult = { ok: true; pet: string } | { ok: false; reason: "invalid-pet" };

/**
 * Stores one available catalog pet for the signed-in user. The key is re-checked
 * against the catalog here as well as at the route, so an unknown, retired, or
 * non-string value can never be persisted even if a caller skips validation. The
 * row is created if this is the account's first preference of any kind, and only the
 * `selectedPetKey` column is written — theme, model, and UI preferences keep theirs.
 */
export async function saveSelectedPetKey(userId: string, petKey: string): Promise<SavePetResult> {
  if (!isSelectablePetId(petKey)) return { ok: false, reason: "invalid-pet" };

  await getDb().userPreferences.upsert({
    where: { userId },
    create: { userId, selectedPetKey: petKey },
    update: { selectedPetKey: petKey },
    select: { userId: true },
  });
  return { ok: true, pet: petKey };
}

/** The raw appearance object stored for a user, or an empty object. */
async function readUiPreferences(userId: string): Promise<Record<string, unknown>> {
  const row = await getDb().userPreferences.findUnique({
    where: { userId },
    select: { uiPreferences: true },
  });
  const value = row?.uiPreferences;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The raw stored appearance key for one user, or `null` when nothing is stored. */
export async function getPetAppearanceKey(userId: string): Promise<string | null> {
  return keyFrom(await readUiPreferences(userId), PET_APPEARANCE_KEY);
}

/** The raw stored personality key for one user, or `null` when nothing is stored. */
export async function getPetPersonalityKey(userId: string): Promise<string | null> {
  return keyFrom(await readUiPreferences(userId), PET_PERSONALITY_KEY);
}

/**
 * The companion the pages render: the stored, still-available pet plus the stored
 * appearance and personality resolved for that pet (each one's default when missing,
 * unknown, or from another pet). Anonymous users get the catalog defaults without a
 * database read.
 */
export async function loadCompanion(user: { id: string } | null): Promise<{
  pet: string;
  appearance: string;
  personality: string;
}> {
  if (!user) return defaultCompanion();
  try {
    const pet = await resolveSelectedPetKey(user.id);
    // One read serves both keys, so the two preferences can never disagree.
    const prefs = await readUiPreferences(user.id);
    return {
      pet,
      appearance: resolveAppearanceForPet(pet, keyFrom(prefs, PET_APPEARANCE_KEY)).id,
      personality: resolvePersonalityForPet(pet, keyFrom(prefs, PET_PERSONALITY_KEY)).id,
    };
  } catch (error) {
    console.error("[pets] Failed to load the companion:", error);
    return defaultCompanion();
  }
}

/** The catalog-default companion, used for anonymous visitors and failed reads. */
function defaultCompanion(): { pet: string; appearance: string; personality: string } {
  return {
    pet: DEFAULT_PET_ID,
    appearance: defaultAppearanceForPet(DEFAULT_PET_ID).id,
    personality: defaultPersonalityForPet(DEFAULT_PET_ID).id,
  };
}

/** A non-empty string stored under a key, or `null`. */
function keyFrom(prefs: Record<string, unknown>, key: string): string | null {
  const value = prefs[key];
  return typeof value === "string" && value !== "" ? value : null;
}

export type SaveAppearanceResult =
  | { ok: true; pet: string; appearance: string }
  | { ok: false; reason: "invalid-appearance" };

/**
 * Stores one appearance key for the signed-in user, validated against their
 * currently selected pet — so an appearance that belongs to another pet, or an
 * unknown/unavailable one, is refused rather than persisted. Only the
 * `petAppearance` property of `uiPreferences` is written; every other property of the
 * object, and the `selectedPetKey`/`theme`/model columns, keep their values.
 */
export async function savePetAppearance(
  userId: string,
  appearanceId: string,
): Promise<SaveAppearanceResult> {
  const pet = await resolveSelectedPetKey(userId);
  if (!isSelectableAppearance(pet, appearanceId)) return { ok: false, reason: "invalid-appearance" };

  const existing = await readUiPreferences(userId);
  await getDb().userPreferences.upsert({
    where: { userId },
    create: { userId, selectedPetKey: pet, uiPreferences: { ...existing, [PET_APPEARANCE_KEY]: appearanceId } },
    update: { uiPreferences: { ...existing, [PET_APPEARANCE_KEY]: appearanceId } },
    select: { userId: true },
  });
  return { ok: true, pet, appearance: appearanceId };
}

export type SavePersonalityResult =
  | { ok: true; pet: string; personality: string }
  | { ok: false; reason: "invalid-personality" };

/**
 * Stores one personality key for the signed-in user, validated against their
 * currently selected pet — so a personality that belongs to another pet, or an
 * unknown/unavailable one, is refused rather than persisted. Only the
 * `petPersonality` property of `uiPreferences` is written; the stored appearance,
 * every other property of the object, and the `selectedPetKey`/`theme`/model columns
 * all keep their values.
 */
export async function savePetPersonality(
  userId: string,
  personalityId: string,
): Promise<SavePersonalityResult> {
  const pet = await resolveSelectedPetKey(userId);
  if (!isSelectablePersonality(pet, personalityId))
    return { ok: false, reason: "invalid-personality" };

  const existing = await readUiPreferences(userId);
  await getDb().userPreferences.upsert({
    where: { userId },
    create: {
      userId,
      selectedPetKey: pet,
      uiPreferences: { ...existing, [PET_PERSONALITY_KEY]: personalityId },
    },
    update: { uiPreferences: { ...existing, [PET_PERSONALITY_KEY]: personalityId } },
    select: { userId: true },
  });
  return { ok: true, pet, personality: personalityId };
}
