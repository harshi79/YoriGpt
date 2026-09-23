import {
  forbiddenOriginResponse,
  invalidRequestResponse,
  isTrustedRequestOrigin,
  jsonResponse,
  serverErrorResponse,
  unauthenticatedResponse,
} from "@/server/api/http";
import { getCurrentUser } from "@/server/auth/session";
import { parsePetSelectionRequest } from "@/server/pets/request";
import { resolveSelectedPetKey, saveSelectedPetKey } from "@/server/pets/service";

/**
 * The signed-in user's pet companion, as a nested member of the settings API.
 *
 * `GET /api/settings/pet` answers `{ "pet": "<catalog key>" }` — the stored, still
 * available choice, or the catalog default. `PUT` accepts exactly `{ "pet": "<key>" }`
 * and answers `{ "pet": "<key>" }`.
 *
 * Both require a session, and the stored row is keyed by the authenticated session,
 * so the client can never name a user or touch another account's choice. `PUT` also
 * requires the same trusted-origin check as every other write. An unknown field
 * (including `userId`), a missing or non-string pet, malformed JSON, and an oversized
 * body are `400` with the standard `{ error: { code, message } }` envelope; an
 * unavailable or unknown pet key is also `400`; unauthenticated is `401`; an untrusted
 * origin is `403`.
 *
 * This route is deliberately separate from `GET/PUT /api/settings` (theme + account)
 * so the theme endpoint's response shape and its tests stay exactly as they were.
 * Nothing sensitive is serialized: only the pet key crosses the wire.
 */

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthenticatedResponse();

  try {
    return jsonResponse({ pet: await resolveSelectedPetKey(user.id) });
  } catch (error) {
    console.error("[pets] Failed to read the selected pet:", error);
    return serverErrorResponse();
  }
}

export async function PUT(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthenticatedResponse();
  if (!isTrustedRequestOrigin(request)) return forbiddenOriginResponse();

  const parsed = await parsePetSelectionRequest(request);
  if (!parsed.ok) return invalidRequestResponse(parsed.message);

  try {
    // Re-checked against the catalog in the service, which is what actually writes.
    const saved = await saveSelectedPetKey(user.id, parsed.pet);
    if (!saved.ok) return invalidRequestResponse("That pet is not available.");
    return jsonResponse({ pet: saved.pet });
  } catch (error) {
    console.error("[pets] Failed to store the selected pet:", error);
    return serverErrorResponse();
  }
}
