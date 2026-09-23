import "server-only";
import type { ModelSelection } from "@/features/models/types";
import { defaultModelKey, listSelectableModels, resolveStoredModelKey } from "./catalog";
import { getSelectedModelKey } from "./service";

/**
 * Read model for the chat header: the models this deployment offers, and which one
 * the current user is on. A failed preference read is reported as `status: "error"`
 * — the catalog still renders, so the selector stays usable and honest instead of
 * silently presenting the default as the user's own choice.
 *
 * Only catalog keys, names, and descriptions cross to the client; the OpenRouter
 * identifier stays on the server.
 */
export async function loadModelSelection(user: { id: string } | null): Promise<ModelSelection> {
  const models = listSelectableModels().map(({ key, name, description }) => ({
    key,
    name,
    description,
  }));

  // Anonymous visitors see what exists but have no stored preference to read.
  if (!user) return { status: "anonymous", models, selectedKey: defaultModelKey() };

  try {
    const stored = await getSelectedModelKey(user.id);
    return { status: "ready", models, selectedKey: resolveStoredModelKey(stored).key };
  } catch (error) {
    console.error("[models] Failed to load the model preference:", error);
    return { status: "error", models, selectedKey: defaultModelKey() };
  }
}
