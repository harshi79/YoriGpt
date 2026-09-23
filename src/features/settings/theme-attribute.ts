import type { ThemeValue } from "./types";

/**
 * How the stored theme reaches the document.
 *
 * The server renders the user's preference as `data-theme` on `<html>`, and a tiny
 * inline script — placed in `<head>`, so it runs before the first paint — resolves
 * `system` against the device preference into `data-color-scheme`. The stylesheet
 * keys every palette decision off those two attributes (see `src/app/globals.css`),
 * so there is no flash of the wrong theme on load, none on client-side navigation
 * (the layout is not re-rendered), and no framework or extra dependency.
 *
 * This module holds no React and no server-only imports, so the root layout and the
 * settings form can both use it.
 */

export const THEME_ATTRIBUTE = "data-theme";
export const COLOR_SCHEME_ATTRIBUTE = "data-color-scheme";
export const LIGHT_MEDIA_QUERY = "(prefers-color-scheme: light)";

/**
 * Runs before the first paint: resolves the server-rendered preference and keeps
 * `data-color-scheme` in step with the device while the preference is `system`.
 * Written as plain ES5 so it works in every browser the app supports.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function () {
  var root = document.documentElement;
  var query = window.matchMedia(${JSON.stringify(LIGHT_MEDIA_QUERY)});
  function apply() {
    var preference = root.getAttribute(${JSON.stringify(THEME_ATTRIBUTE)}) || "system";
    var scheme = preference === "system" ? (query.matches ? "light" : "dark") : preference;
    root.setAttribute(${JSON.stringify(COLOR_SCHEME_ATTRIBUTE)}, scheme);
  }
  apply();
  if (typeof query.addEventListener === "function") query.addEventListener("change", apply);
  else if (typeof query.addListener === "function") query.addListener(apply);
})();`;

/** The palette a preference resolves to on this device. */
export function resolveColorScheme(theme: ThemeValue): "dark" | "light" {
  if (theme !== "system") return theme;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia(LIGHT_MEDIA_QUERY).matches ? "light" : "dark";
}

/**
 * Applies a theme immediately, in this tab, after a change is saved. The server
 * stays the source of truth; this only stops the page waiting for a reload to look
 * like the choice the user just made.
 */
export function applyTheme(theme: ThemeValue): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute(THEME_ATTRIBUTE, theme);
  root.setAttribute(COLOR_SCHEME_ATTRIBUTE, resolveColorScheme(theme));
}
