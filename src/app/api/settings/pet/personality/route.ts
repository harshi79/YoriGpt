import { resolvePersonalityForPet } from "@/features/pets/catalog";
import {
  forbiddenOriginResponse,
  invalidRequestResponse,
  isTrustedRequestOrigin,
  jsonResponse,
  serverErrorResponse,
  unauthenticatedResponse,
} from "@/server/api/http";
import { getCurrentUser } from "@/server/auth/session";
import { parsePetPersonalityRequest } from "@/server/pets/request";
import {
  getPetPersonalityKey,
  resolveSelectedPetKey,
  savePetPersonality,
} from "@/server/pets/service";

/**
 * The signed-in user's pet personality, as a nested member of the pet settings API.
 *
 * `GET /api/settings/pet/personality` answers `{ "pet": "<key>", "personality": "<id>" }`
 * — the stored pet and the stored personality resolved for that pet (its default when
 * nothing valid is stored). `PUT` accepts exactly `{ "personality": "<id>" }` and
 * answers `{ "pet", "personality" }`.
 *
 * The personality is always validated against the user's *currently selected* pet, so
 * an id that belongs to another pet, is unknown, or whose pet is unavailable is `400`.
 * Only a stable catalog id is accepted: an arbitrary personality object, traits, or
 * prompt text is not a string and is refused. Session determines ownership, `PUT`
 * requires the trusted-origin check, and the standard `{ error: { code, message } }`
 * envelope is used. The sibling routes — `GET/PUT /api/settings/pet` (selection) and
 * `GET/PUT /api/settings/pet/appearance` — are untouched, so their contracts and tests
 * are unchanged; selection, appearance, and personality stay logically separate.
 */

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthenticatedResponse();

  try {
    const pet = await resolveSelectedPetKey(user.id);
    const stored = await getPetPersonalityKey(user.id);
    return jsonResponse({ pet, personality: resolvePersonalityForPet(pet, stored).id });
  } catch (error) {
    console.error("[pets] Failed to read the pet personality:", error);
    return serverErrorResponse();
  }
}

export async function PUT(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthenticatedResponse();
  if (!isTrustedRequestOrigin(request)) return forbiddenOriginResponse();

  const parsed = await parsePetPersonalityRequest(request);
  if (!parsed.ok) return invalidRequestResponse(parsed.message);

  try {
    const saved = await savePetPersonality(user.id, parsed.personality);
    if (!saved.ok)
      return invalidRequestResponse("That personality is not available for this pet.");
    return jsonResponse({ pet: saved.pet, personality: saved.personality });
  } catch (error) {
    console.error("[pets] Failed to store the pet personality:", error);
    return serverErrorResponse();
  }
}
