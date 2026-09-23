import "server-only";
import {
  DEFAULT_THEME,
  type SettingsAccount,
  type ThemeValue,
  type UserSettings,
} from "@/features/settings/types";
import { getTheme, resolveTheme } from "./service";

/**
 * Read model for `/settings` and `GET /api/settings`.
 *
 * The account details come from the authenticated session, never from the request
 * body, and only the three non-sensitive fields the page shows are carried across:
 * no user id, no password hash, no session token, and nothing from the rest of the
 * `user_preferences` row.
 *
 * A failed preference read is reported as `status: "error"` instead of throwing, so
 * the page still renders (with the documented default and an honest note) when the
 * database is unavailable — the same convention the conversation list and the model
 * selection follow.
 */

/** The account summary rendered on the settings page. */
export function toSettingsAccount(user: {
  name: string;
  email: string;
  emailVerified: boolean;
}): SettingsAccount {
  return {
    name: typeof user.name === "string" ? user.name.trim() : "",
    email: user.email,
    emailVerified: user.emailVerified === true,
  };
}

/** Loads the settings of one authenticated user. */
export async function loadSettings(user: {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
}): Promise<UserSettings> {
  const account = toSettingsAccount(user);
  try {
    return { status: "ready", theme: await getTheme(user.id), account };
  } catch (error) {
    console.error("[settings] Failed to load the settings:", error);
    return { status: "error", theme: DEFAULT_THEME, account };
  }
}

/**
 * The theme the root layout writes to `<html>` before anything is painted.
 *
 * Signed-in users get their own stored preference; everybody else gets the
 * documented default. Anonymous visitors never reach the database, and a failed
 * read degrades to the default rather than failing the page, so the shell keeps
 * rendering (in the default theme) when the database is unavailable.
 */
export async function loadThemePreference(user: { id: string } | null): Promise<ThemeValue> {
  if (!user) return DEFAULT_THEME;
  return resolveTheme(user.id);
}
