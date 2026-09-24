import { getCurrentUser } from "@/server/auth/session";
import {
  forbiddenOriginResponse,
  invalidRequestResponse,
  isTrustedRequestOrigin,
  jsonResponse,
  serverErrorResponse,
  unauthenticatedResponse,
} from "@/server/api/http";
import {
  isSelectableModelKey,
  listSelectableModels,
  resolveStoredModelKey,
} from "@/server/ai/models/catalog";
import { parseModelSelectionRequest } from "@/server/ai/models/request";
import { getSelectedModelKey, saveSelectedModelKey } from "@/server/ai/models/service";

/**
 * The models a signed-in user may generate with, and their saved selection.
 *
 * `GET` returns the server catalog plus the caller's current key — both are
 * user-scoped and require a session. `PUT` stores one selection.
 *
 * The client sends a catalog **key** and nothing else. The route rejects unknown
 * and inactive keys; the model's provider and its identifier are resolved only
 * from the catalog, so a browser cannot activate a model the server does not offer,
 * name a provider model directly, or override the provider separately. No provider
 * configuration, credential, or identifier is included in a response.
 */

/** Only the catalog fields the selector needs; no provider or internal columns. */
function toWireModel(model: { key: string; name: string; description: string }) {
  return { key: model.key, name: model.name, description: model.description };
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthenticatedResponse();

  try {
    // No preference yet is not an error, and a preference that no longer resolves
    // (a retired model) is reported as the default — the same model a reply would
    // actually use, so the header can never disagree with the next generation.
    const stored = await getSelectedModelKey(user.id);
    return jsonResponse({
      models: listSelectableModels().map(toWireModel),
      selectedModelKey: resolveStoredModelKey(stored).key,
    });
  } catch (error) {
    console.error("[models] Failed to read the model selection:", error);
    return serverErrorResponse();
  }
}

export async function PUT(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthenticatedResponse();
  if (!isTrustedRequestOrigin(request)) return forbiddenOriginResponse();

  const parsed = await parseModelSelectionRequest(request);
  if (!parsed.ok) return invalidRequestResponse(parsed.message);

  // Checked again in the service, which is what actually writes.
  if (!isSelectableModelKey(parsed.modelKey))
    return invalidRequestResponse("That model is not available.");

  try {
    const saved = await saveSelectedModelKey(user.id, parsed.modelKey);
    if (!saved.ok)
      return invalidRequestResponse(
        saved.reason === "unknown-model"
          ? "That model is not available."
          : "That model cannot be selected right now.",
      );
    return jsonResponse({ selectedModelKey: saved.modelKey });
  } catch (error) {
    console.error("[models] Failed to store the model selection:", error);
    return serverErrorResponse();
  }
}
