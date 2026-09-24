import "server-only";

/**
 * Strict parsing for the model-selection request. Exactly one field is accepted —
 * a catalog key — and everything else (a raw provider identifier, a provider name, a
 * `userId` override) is rejected instead of ignored. The key is only a *candidate*
 * here: the route and the service both re-check it against the server catalog.
 */

/** The only field the client may send. */
const MODEL_KEY_FIELD = "modelKey";

/** Matches the longest catalog key we would ever define; anything longer is junk. */
export const MAX_MODEL_KEY_LENGTH = 64;

/** A whole body larger than this is refused before parsing. */
export const MAX_MODEL_REQUEST_BYTES = 4_096;

export type ParsedModelSelection =
  | { ok: true; modelKey: string }
  | { ok: false; message: string };

export async function parseModelSelectionRequest(
  request: Request,
): Promise<ParsedModelSelection> {
  const contentType = request.headers.get("content-type") ?? "";
  const raw = await request.text();
  const body = raw.trim();

  if (body === "") return { ok: false, message: "Send a JSON object with a modelKey." };
  if (body.length > MAX_MODEL_REQUEST_BYTES)
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
  const unexpected = fields.filter((field) => field !== MODEL_KEY_FIELD);
  if (unexpected.length > 0)
    return {
      ok: false,
      message: `Unsupported field${unexpected.length > 1 ? "s" : ""}: ${unexpected.join(", ")}.`,
    };

  const modelKey = (value as { modelKey?: unknown }).modelKey;
  if (typeof modelKey !== "string") return { ok: false, message: "Model key must be text." };

  const trimmed = modelKey.trim();
  if (trimmed.length === 0) return { ok: false, message: "Model key cannot be empty." };
  if (trimmed.length > MAX_MODEL_KEY_LENGTH)
    return { ok: false, message: `Model key must be ${MAX_MODEL_KEY_LENGTH} characters or fewer.` };

  return { ok: true, modelKey: trimmed };
}
