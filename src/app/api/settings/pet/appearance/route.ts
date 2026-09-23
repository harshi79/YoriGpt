import { resolveAppearanceForPet } from "@/features/pets/catalog";
import {
  forbiddenOriginResponse,
  invalidRequestResponse,
  isTrustedRequestOrigin,
  jsonResponse,
  serverErrorResponse,
  unauthenticatedResponse,
} from "@/server/api/http";
import { getCurrentUser } from "@/server/auth/session";
import { parsePetAppearanceRequest } from "@/server/pets/request";
import {
  getPetAppearanceKey,
  resolveSelectedPetKey,
  savePetAppearance,
} from "@/server/pets/service";

/**
 * The signed-in user's pet appearance, as a nested member of the pet settings API.
 *
 * `GET /api/settings/pet/appearance` answers `{ "pet": "<key>", "appearance": "<id>" }`
 * — the stored pet and the stored appearance resolved for that pet (its default when
 * nothing valid is stored). `PUT` accepts exactly `{ "appearance": "<id>" }` and
 * answers `{ "pet", "appearance" }`.
 *
 * The appearance is always validated against the user's *currently selected* pet, so
 * an id that belongs to another pet, is unknown, or whose pet is unavailable is `400`.
 * Session determines ownership, `PUT` requires the trusted-origin check, and the same
 * `{ error: { code, message } }` envelope is used. The separate
 * `GET/PUT /api/settings/pet` (selection) is untouched, so its contract and tests are
 * unchanged. Only stable keys cross the wire.
 */

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthenticatedResponse();

  try {
    const pet = await resolveSelectedPetKey(user.id);
    const stored = await getPetAppearanceKey(user.id);
    return jsonResponse({ pet, appearance: resolveAppearanceForPet(pet, stored).id });
  } catch (error) {
    console.error("[pets] Failed to read the pet appearance:", error);
    return serverErrorResponse();
  }
}

export async function PUT(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthenticatedResponse();
  if (!isTrustedRequestOrigin(request)) return forbiddenOriginResponse();

  const parsed = await parsePetAppearanceRequest(request);
  if (!parsed.ok) return invalidRequestResponse(parsed.message);

  try {
    const saved = await savePetAppearance(user.id, parsed.appearance);
    if (!saved.ok)
      return invalidRequestResponse("That appearance is not available for this pet.");
    return jsonResponse({ pet: saved.pet, appearance: saved.appearance });
  } catch (error) {
    console.error("[pets] Failed to store the pet appearance:", error);
    return serverErrorResponse();
  }
}
