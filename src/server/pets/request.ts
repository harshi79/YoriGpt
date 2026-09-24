import "server-only";
import { readBoundedRequestBody } from "../api/request-body";

/**
 * Strict parsing for the pet-selection request. Exactly one field is accepted —
 * `pet` — and anything else is rejected instead of ignored: an unknown field, a
 * `userId` override, a theme, or a second value riding along. The value is only a
 * *candidate* here (a non-empty string); the service re-checks it against the
 * catalog before writing, so an unavailable or unknown key is never persisted.
 *
 * Mirrors the conventions of `../settings/request.ts`: size cap, JSON content type,
 * object-only body, and plain-language refusal messages in the standard envelope.
 */

/** The only field the client may send. */
const PET_FIELD = "pet";
const APPEARANCE_FIELD = "appearance";
const PERSONALITY_FIELD = "personality";

/** A whole body larger than this is refused before parsing. */
export const MAX_PET_REQUEST_BYTES = 4_096;

/** Shared strict-envelope parsing; returns the parsed object or a refusal message. */
async function parseSingleStringField(
  request: Request,
  field: string,
  noun: string,
): Promise<{ ok: true; value: string } | { ok: false; message: string }> {
  const contentType = request.headers.get("content-type") ?? "";
  const raw = await readBoundedRequestBody(request, MAX_PET_REQUEST_BYTES);
  if (raw === null) return { ok: false, message: "That request is too large." };
  const body = raw.trim();

  if (body === "") return { ok: false, message: `Send a JSON object with a ${noun}.` };
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
  const unexpected = fields.filter((name) => name !== field);
  if (unexpected.length > 0)
    return {
      ok: false,
      message: `Unsupported field${unexpected.length > 1 ? "s" : ""}: ${unexpected.join(", ")}.`,
    };

  const candidate = (value as Record<string, unknown>)[field];
  if (candidate === undefined) return { ok: false, message: `Send a ${noun}.` };
  if (typeof candidate !== "string") return { ok: false, message: `${capitalize(noun)} must be text.` };

  const trimmed = candidate.trim();
  if (trimmed === "") return { ok: false, message: `Send a ${noun}.` };

  return { ok: true, value: trimmed };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export type ParsedPetUpdate = { ok: true; pet: string } | { ok: false; message: string };

export async function parsePetSelectionRequest(request: Request): Promise<ParsedPetUpdate> {
  const parsed = await parseSingleStringField(request, PET_FIELD, "pet");
  return parsed.ok ? { ok: true, pet: parsed.value } : parsed;
}

export type ParsedAppearanceUpdate =
  | { ok: true; appearance: string }
  | { ok: false; message: string };

/** Strict parsing for the appearance request: exactly one field, `appearance`. */
export async function parsePetAppearanceRequest(
  request: Request,
): Promise<ParsedAppearanceUpdate> {
  const parsed = await parseSingleStringField(request, APPEARANCE_FIELD, "pet appearance");
  return parsed.ok ? { ok: true, appearance: parsed.value } : parsed;
}

export type ParsedPersonalityUpdate =
  | { ok: true; personality: string }
  | { ok: false; message: string };

/**
 * Strict parsing for the personality request: exactly one field, `personality`. A
 * personality *object* — with traits, hints, or prompt text — is not a string, so it
 * is refused here rather than reaching the catalog check.
 */
export async function parsePetPersonalityRequest(
  request: Request,
): Promise<ParsedPersonalityUpdate> {
  const parsed = await parseSingleStringField(request, PERSONALITY_FIELD, "pet personality");
  return parsed.ok ? { ok: true, personality: parsed.value } : parsed;
}
