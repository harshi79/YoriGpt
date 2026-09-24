import "server-only";
import { readBoundedRequestBody } from "../api/request-body";
import { DEFAULT_CONVERSATION_TITLE } from "./service";

/**
 * Strict parsing for conversation requests. Only the fields listed here are ever
 * written; anything the client sends beyond them (including a `userId` or
 * timestamp override attempt) is rejected instead of ignored.
 */

/** Matches the `VarChar(200)` length of `conversations.title`. */
export const MAX_TITLE_LENGTH = 200;
/** More than enough for a 200-character JSON title, including four-byte characters. */
export const MAX_CONVERSATION_REQUEST_BYTES = 4_096;

/**
 * Loose shape check for a conversation id (Prisma generates CUIDs). This is a
 * cheap guard against junk in URLs and logs; the ownership filter is what
 * actually authorizes a lookup, and an unknown id simply resolves to no row.
 */
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidConversationId(value: string): boolean {
  return CONVERSATION_ID_PATTERN.test(value);
}

export type ParsedCreateConversation =
  | { ok: true; title: string }
  | { ok: false; message: string };

/**
 * Reads an optional JSON body of the form `{ "title"?: string }`. An empty body
 * uses the default title. Unknown keys, malformed JSON, and invalid titles are
 * reported so the caller can answer 400 without writing anything.
 */
export async function parseCreateConversationRequest(
  request: Request,
): Promise<ParsedCreateConversation> {
  const contentType = request.headers.get("content-type") ?? "";
  const raw = await readBoundedRequestBody(request, MAX_CONVERSATION_REQUEST_BYTES);
  if (raw === null) return { ok: false, message: "That request is too large." };
  const body = raw.trim();

  if (body === "") return { ok: true, title: DEFAULT_CONVERSATION_TITLE };
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
  const unexpected = fields.filter((field) => field !== "title");
  if (unexpected.length > 0)
    return {
      ok: false,
      message: `Unsupported field${unexpected.length > 1 ? "s" : ""}: ${unexpected.join(", ")}.`,
    };

  if (fields.length === 0) return { ok: true, title: DEFAULT_CONVERSATION_TITLE };

  const title = (value as { title?: unknown }).title;
  if (typeof title !== "string")
    return { ok: false, message: "Title must be text." };

  const trimmed = title.trim();
  if (trimmed.length === 0)
    return { ok: false, message: "Title cannot be empty." };
  if (trimmed.length > MAX_TITLE_LENGTH)
    return { ok: false, message: `Title must be ${MAX_TITLE_LENGTH} characters or fewer.` };

  return { ok: true, title: trimmed };
}
