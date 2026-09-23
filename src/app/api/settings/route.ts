import { getCurrentUser } from "@/server/auth/session";
import {
  forbiddenOriginResponse,
  invalidRequestResponse,
  isTrustedRequestOrigin,
  jsonResponse,
  serverErrorResponse,
  unauthenticatedResponse,
} from "@/server/api/http";
import { parseSettingsRequest } from "@/server/settings/request";
import { saveTheme } from "@/server/settings/service";
import { loadSettings } from "@/server/settings/view";

/**
 * The signed-in user's own settings.
 *
 * `GET` returns the non-sensitive settings the UI needs: the stored theme and the
 * account summary the settings page displays. `PUT` stores one theme.
 *
 * Both require a session, and the row is keyed by the authenticated session — the
 * client cannot name a user, so it cannot read or write another account's
 * preference. `PUT` also requires the same trusted-origin check as every other
 * write. An unknown field (including `userId`), a missing or invalid theme,
 * malformed JSON, and an oversized body are `400` with the standard
 * `{ error: { code, message } }` envelope; unauthenticated is `401`, an untrusted
 * origin is `403`.
 *
 * Nothing sensitive is serialized: no user id, password hash, session token, API
 * key, provider configuration, or other column of `user_preferences`.
 */

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthenticatedResponse();

  const settings = await loadSettings(user);
  if (settings.status === "error") return serverErrorResponse();

  return jsonResponse({ theme: settings.theme, account: settings.account });
}

export async function PUT(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthenticatedResponse();
  if (!isTrustedRequestOrigin(request)) return forbiddenOriginResponse();

  const parsed = await parseSettingsRequest(request);
  if (!parsed.ok) return invalidRequestResponse(parsed.message);

  try {
    // Checked again in the service, which is what actually writes.
    const saved = await saveTheme(user.id, parsed.theme);
    if (!saved.ok) return invalidRequestResponse("That theme is not available.");
    return jsonResponse({ theme: saved.theme });
  } catch (error) {
    console.error("[settings] Failed to store the theme preference:", error);
    return serverErrorResponse();
  }
}
