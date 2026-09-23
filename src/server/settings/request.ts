import "server-only";
import { isThemeValue, THEME_VALUES, type ThemeValue } from "@/features/settings/types";

/**
 * Strict parsing for the settings request. Exactly one field is accepted — the
 * theme — and everything else is rejected instead of ignored: an unknown field, a
 * `userId` override, a pet or model preference, or a second value riding along.
 * The value is only a *candidate* here; the service re-checks it before writing.
 */

/** The only field the client may send. */
const THEME_FIELD = "theme";

/** A whole body larger than this is refused before parsing. */
export const MAX_SETTINGS_REQUEST_BYTES = 4_096;

export type ParsedSettingsUpdate =
  | { ok: true; theme: ThemeValue }
  | { ok: false; message: string };

export async function parseSettingsRequest(request: Request): Promise<ParsedSettingsUpdate> {
  const contentType = request.headers.get("content-type") ?? "";
  const raw = await request.text();
  const body = raw.trim();

  if (body === "") return { ok: false, message: "Send a JSON object with a theme." };
  if (body.length > MAX_SETTINGS_REQUEST_BYTES)
    return { ok: false, message: "That request is too large." };
  if (!contentType.toLowerCase().includes("application/json"))
    return { ok: false, message: "Send this request as JSON." };

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, message: "Send a valid JSON object." };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, message: "Send a valid JSON object." };

  const fields = Object.keys(value as Record<string, unknown>);
  const unexpected = fields.filter((field) => field !== THEME_FIELD);
  if (unexpected.length > 0)
    return {
      ok: false,
      message: `Unsupported field${unexpected.length > 1 ? "s" : ""}: ${unexpected.join(", ")}.`,
    };

  const theme = (value as { theme?: unknown }).theme;
  if (theme === undefined) return { ok: false, message: "Send a theme." };
  if (typeof theme !== "string") return { ok: false, message: "Theme must be text." };

  const trimmed = theme.trim();
  if (!isThemeValue(trimmed))
    return { ok: false, message: `Theme must be one of: ${THEME_VALUES.join(", ")}.` };

  return { ok: true, theme: trimmed };
}
