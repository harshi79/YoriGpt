import "server-only";
import { getDb } from "../db/client";
import type { ThemeValue } from "@/features/settings/types";
import { DEFAULT_THEME } from "@/features/settings/types";
import { toStoredTheme, toThemeValue } from "./theme";

/**
 * The user's own settings: reading, updating, and default resolution for the
 * `user_preferences` row that already exists in the schema. Every function takes
 * the id of the authenticated user (from `getCurrentUser()` / `requireUser()`) and
 * reads or writes only that user's row, so one account can never read or change
 * another account's preference.
 *
 * Only the `theme` column is touched. The other columns of the same row
 * (`preferredModelId`, `selectedPetKey`, `uiPreferences`) keep their stored values
 * or their schema defaults, because they belong to other features.
 */

/**
 * The stored theme for one user. A user with no `user_preferences` row has not
 * chosen anything yet, which is the documented default rather than an error.
 */
export async function getTheme(userId: string): Promise<ThemeValue> {
  const row = await getDb().userPreferences.findUnique({
    where: { userId },
    select: { theme: true },
  });
  return toThemeValue(row?.theme ?? null);
}

export type SaveThemeResult = { ok: true; theme: ThemeValue } | { ok: false; reason: "invalid-theme" };

/**
 * Stores one theme for the signed-in user. The value is re-checked against the
 * supported vocabulary here as well as at the route, so an unknown value can never
 * be persisted even if a caller skips validation, and the row is created if this is
 * the account's first preference of any kind.
 */
export async function saveTheme(userId: string, theme: ThemeValue): Promise<SaveThemeResult> {
  const stored = toStoredTheme(theme);
  if (!stored) return { ok: false, reason: "invalid-theme" };

  await getDb().userPreferences.upsert({
    where: { userId },
    // Only the theme column is written; the rest of the row keeps its defaults.
    create: { userId, theme: stored },
    update: { theme: stored },
    select: { userId: true },
  });
  return { ok: true, theme };
}

/**
 * The theme a page should render for this user: their stored preference, or the
 * default when nothing is stored. Never throws, so a database outage degrades to
 * the documented default instead of failing the page — the settings page reports
 * the failed read separately (see `./view.ts`).
 */
export async function resolveTheme(userId: string): Promise<ThemeValue> {
  try {
    return await getTheme(userId);
  } catch (error) {
    console.error("[settings] Failed to load the theme preference:", error);
    return DEFAULT_THEME;
  }
}
