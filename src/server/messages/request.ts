import "server-only";
import { readBoundedRequestBody } from "../api/request-body";

/**
 * Strict parsing for user-message requests. `content` is the only field a client
 * may send: the id, owner, role, position, and timestamps are always derived on
 * the server, so any other key is rejected instead of quietly ignored.
 */

/**
 * Characters allowed in one message. `messages.content` is PostgreSQL `text`, so
 * this is an application bound (roughly six pages of prose), not a column limit.
 * Longer input is rejected — never truncated, because silently dropping the end
 * of somebody's message is worse than an honest error.
 */
export const MAX_MESSAGE_LENGTH = 4000;

/**
 * Refuse an unreasonable request before reading it. Four bytes per character plus
 * JSON overhead is the most a valid message can occupy, so anything larger cannot
 * be acceptable — and it is never read into memory to find out.
 */
const MAX_MESSAGE_BODY_BYTES = MAX_MESSAGE_LENGTH * 4 + 1024;

export type ParsedCreateMessage =
  | { ok: true; content: string }
  | { ok: false; message: string };

/**
 * Reads a required JSON body of exactly `{ "content": string }`. Surrounding
 * whitespace is trimmed for validation and storage; interior text, including
 * blank lines, is preserved as written.
 */
export async function parseCreateMessageRequest(
  request: Request,
): Promise<ParsedCreateMessage> {
  const contentType = request.headers.get("content-type") ?? "";
  const raw = await readBoundedRequestBody(request, MAX_MESSAGE_BODY_BYTES);
  if (raw === null) return { ok: false, message: tooLongMessage() };
  const body = raw.trim();

  if (body === "") return { ok: false, message: "Message content is required." };
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
  const unexpected = fields.filter((field) => field !== "content");
  if (unexpected.length > 0)
    return {
      ok: false,
      message: `Unsupported field${unexpected.length > 1 ? "s" : ""}: ${unexpected.join(", ")}.`,
    };

  const content = (value as { content?: unknown }).content;
  if (typeof content !== "string")
    return { ok: false, message: "Message content must be text." };

  const trimmed = content.trim();
  if (trimmed.length === 0)
    return { ok: false, message: "Message content cannot be empty." };
  if (trimmed.length > MAX_MESSAGE_LENGTH) return { ok: false, message: tooLongMessage() };

  return { ok: true, content: trimmed };
}

function tooLongMessage() {
  return `Message content must be ${MAX_MESSAGE_LENGTH} characters or fewer.`;
}

export type ParsedReplyRequest = { ok: true } | { ok: false; message: string };
/** A reply carries no input fields; this allows harmless JSON whitespace only. */
export const MAX_REPLY_REQUEST_BYTES = 4_096;

/**
 * Reads the reply request. Generation is initiated by the URL alone, so the body
 * must be empty (or `{}`): any field — including an attempted `userId`, `role`,
 * `content`, or `position` — is rejected rather than ignored.
 */
export async function parseReplyRequest(request: Request): Promise<ParsedReplyRequest> {
  const raw = await readBoundedRequestBody(request, MAX_REPLY_REQUEST_BYTES);
  if (raw === null) return { ok: false, message: "That request is too large." };
  const body = raw.trim();
  if (body === "") return { ok: true };

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, message: "Send a valid JSON object." };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, message: "Send a valid JSON object." };

  const fields = Object.keys(value as Record<string, unknown>);
  if (fields.length === 0) return { ok: true };
  return {
    ok: false,
    message: `Unsupported field${fields.length > 1 ? "s" : ""}: ${fields.join(", ")}.`,
  };
}
