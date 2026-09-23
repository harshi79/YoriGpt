import "server-only";
import { Prisma } from "@prisma/client";
import { getDb } from "../../db/client";
import { findCatalogModel, isSelectableModelKey, resolveStoredModelKey } from "./catalog";

/**
 * User-scoped model preference. Every function takes the id of the authenticated
 * user (from `getCurrentUser()` / `requireUser()`) and writes through a column that
 * belongs to that user's own `user_preferences` row, so one account can never read
 * or change another account's selection.
 *
 * The stored value is a catalog **key** — the `ai_models.id` the seed migration
 * inserts — never an OpenRouter identifier supplied by a client. A key that is
 * unknown, or that names a retired model, is not an error: generation falls back to
 * the documented default so an old preference cannot break replies.
 */

/** The saved key for a user, or `null` when they never chose a model. */
export async function getSelectedModelKey(userId: string): Promise<string | null> {
  const row = await getDb().userPreferences.findUnique({
    where: { userId },
    select: { preferredModelId: true },
  });
  return row?.preferredModelId ?? null;
}

export type SaveModelSelectionResult =
  | { ok: true; modelKey: string }
  | { ok: false; reason: "unknown-model" | "unavailable" };

/**
 * Stores one selection for the signed-in user. The key is re-checked against the
 * catalog here as well as at the route, so an inactive or unknown model can never
 * be persisted even if a caller skips validation.
 */
export async function saveSelectedModelKey(
  userId: string,
  modelKey: string,
): Promise<SaveModelSelectionResult> {
  if (!findCatalogModel(modelKey)) return { ok: false, reason: "unknown-model" };
  if (!isSelectableModelKey(modelKey)) return { ok: false, reason: "unavailable" };

  try {
    // Only the model column is touched: theme, pet, and UI preferences keep their
    // defaults (or their stored values) because they are not part of this task.
    await getDb().userPreferences.upsert({
      where: { userId },
      create: { userId, preferredModelId: modelKey },
      update: { preferredModelId: modelKey },
      select: { userId: true },
    });
    return { ok: true, modelKey };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      // The preference column references `ai_models`; a missing row means the
      // catalog seed migration has not been applied to this database.
      console.error(
        "[models] Could not store the model preference: the catalog rows are missing (apply the seed_ai_models migration).",
      );
      return { ok: false, reason: "unavailable" };
    }
    throw error;
  }
}

/**
 * The catalog key a reply should use for this user: their saved selection when it
 * is still an active catalog model, otherwise the configured default. Used by the
 * reply flow, so a stale preference degrades to the default instead of failing.
 */
export async function resolveReplyModelKey(userId: string): Promise<string> {
  const stored = await getSelectedModelKey(userId);
  const resolved = resolveStoredModelKey(stored);
  if (resolved.usedFallback) {
    console.error(
      `[models] Saved model preference "${String(stored)}" is no longer offered; using the default model.`,
    );
  }
  return resolved.key;
}
