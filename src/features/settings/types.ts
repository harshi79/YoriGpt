/**
 * Wire and render shapes for user settings. Runtime-free, so the server page, the
 * API route, and the client component all share one contract.
 *
 * Only the theme preference exists at this step. The values below are the *wire*
 * values: the browser sends and receives these, and the server maps them onto the
 * existing `ThemePreference` enum in `user_preferences.theme` (see
 * `src/server/settings/theme.ts`). Nothing else about the row is exposed.
 */

/** Every theme a user may choose, in the order the settings page lists them. */
export const THEME_VALUES = ["system", "dark", "light"] as const;

export type ThemeValue = (typeof THEME_VALUES)[number];

/**
 * The application default, used whenever an account has no stored preference.
 * It matches the Prisma default of `user_preferences.theme` (`SYSTEM`), so an
 * account with no `user_preferences` row and one whose row was created by another
 * feature (choosing a model also writes that row) resolve to the same theme.
 */
export const DEFAULT_THEME: ThemeValue = "system";

/** Short labels for the selector; `System` is described by the hint text. */
export const THEME_LABELS: Record<ThemeValue, string> = {
  system: "System",
  dark: "Dark",
  light: "Light",
};

/** What the page shows next to each choice. */
export const THEME_DESCRIPTIONS: Record<ThemeValue, string> = {
  system: "Follow this device’s appearance",
  dark: "Always use the dark palette",
  light: "Always use the light palette",
};

/** The read-only account details the settings page displays. */
export type SettingsAccount = {
  /** The stored display name; an empty value is reported as unavailable. */
  name: string;
  email: string;
  emailVerified: boolean;
};

/** Everything `/settings` renders: the stored theme plus the account summary. */
export type UserSettings = {
  /**
   * `error` means the stored preference could not be read; the documented default
   * is shown and the page says so instead of pretending it was chosen.
   */
  status: "ready" | "error";
  theme: ThemeValue;
  account: SettingsAccount;
};

/** True for exactly the three supported wire values; nothing else is a theme. */
export function isThemeValue(value: unknown): value is ThemeValue {
  return typeof value === "string" && (THEME_VALUES as readonly string[]).includes(value);
}
