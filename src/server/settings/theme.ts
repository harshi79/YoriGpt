import "server-only";
import type { ThemePreference } from "@prisma/client";
import { DEFAULT_THEME, type ThemeValue } from "@/features/settings/types";

/**
 * The theme vocabulary, kept in one place: the browser only ever sees the wire
 * values (`system`, `dark`, `light`), and the database only ever stores the
 * existing `ThemePreference` enum of `user_preferences.theme`. No new column,
 * table, or enum is introduced, and no other preference is read or written here.
 *
 * Both maps are `Map`s rather than object literals so a client-supplied string
 * such as `__proto__` or `constructor` can never resolve to an inherited member.
 */

const STORED_BY_VALUE: ReadonlyMap<ThemeValue, ThemePreference> = new Map([
  ["system", "SYSTEM"],
  ["dark", "DARK"],
  ["light", "LIGHT"],
]);

const VALUE_BY_STORED: ReadonlyMap<ThemePreference, ThemeValue> = new Map([
  ["SYSTEM", "system"],
  ["DARK", "dark"],
  ["LIGHT", "light"],
]);

/** Every stored value this server understands; anything else falls back below. */
export const STORED_THEME_VALUES: readonly ThemePreference[] = [...VALUE_BY_STORED.keys()];

/**
 * The documented default, expressed both ways: `DEFAULT_THEME` is what the API and
 * the page show, and `DEFAULT_STORED_THEME` is the value a newly created
 * `user_preferences` row gets from the schema — the same theme, so creating a row
 * for any reason never changes the appearance an account is served.
 */
export const DEFAULT_STORED_THEME: ThemePreference = STORED_BY_VALUE.get(DEFAULT_THEME) ?? "SYSTEM";

/** The stored enum value for a wire value, or `null` when it is not a theme. */
export function toStoredTheme(value: unknown): ThemePreference | null {
  return (typeof value === "string" ? STORED_BY_VALUE.get(value as ThemeValue) : undefined) ?? null;
}

/**
 * The wire value for a stored row. A missing row is not an error — it is the
 * documented default — and so is a value this build does not know, which keeps an
 * old or hand-edited row from breaking the page.
 */
export function toThemeValue(stored: ThemePreference | null | undefined): ThemeValue {
  if (stored === null || stored === undefined) return DEFAULT_THEME;
  return VALUE_BY_STORED.get(stored) ?? DEFAULT_THEME;
}
