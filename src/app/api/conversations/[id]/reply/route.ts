import { getCurrentUser } from "@/server/auth/session";
import {
  errorResponse,
  forbiddenOriginResponse,
  invalidRequestResponse,
  isTrustedRequestOrigin,
  jsonResponse,
  notFoundResponse,
  serverErrorResponse,
  unauthenticatedResponse,
} from "@/server/api/http";
import { sseResponse } from "@/server/api/sse";
import { isValidConversationId } from "@/server/conversations/request";
import { parseReplyRequest } from "@/server/messages/request";
import {
  generateAssistantReply,
  prepareReply,
  streamAssistantReply,
  type ReplyFailureReason,
} from "@/server/messages/reply";
import { REPLY_STREAM_EVENTS } from "@/features/conversations/types";

/**
 * Generates one assistant reply for the newest user turn of a conversation the
 * caller owns. The request body carries nothing: the owner comes from the session,
 * the conversation from the URL, the history from the database, and the reply text
 * from the configured provider.
 *
 * Two response encodings, one implementation:
 *
 * - `Accept: text/event-stream` (the browser shell) receives the answer
 *   incrementally as server-sent events and the stored row in the final `done`.
 * - anything else receives the original JSON answer, `201 { message }`.
 *
 * Authentication, the origin check, the conversation lookup, and the reply
 * eligibility check all happen *before* the stream starts, so those failures stay
 * ordinary JSON errors with their original status codes (401/403/404/400) and the
 * browser can tell "you may not do this" apart from "generation failed halfway".
 * A conversation that does not exist and one owned by somebody else answer the
 * same 404, and a failure after the provider call stores nothing — the user's
 * message is never removed or replaced.
 */

type RouteContext = { params: Promise<{ id: string }> };

/** The browser asks for the stream explicitly; every other client keeps the JSON contract. */
function wantsStream(request: Request): boolean {
  return (request.headers.get("accept") ?? "").toLowerCase().includes("text/event-stream");
}

/**
 * One table for both encodings: the JSON path answers with this envelope and the
 * SSE path sends the same code and message inside its `error` event, so a client
 * never has to interpret two vocabularies.
 */
function failureShape(reason: ReplyFailureReason): {
  code: string;
  message: string;
  status: number;
} {
  switch (reason) {
    case "not-found":
      return { code: "NOT_FOUND", message: "Conversation not found.", status: 404 };
    case "nothing-to-reply-to":
      return {
        code: "INVALID_REQUEST",
        message: "Send a message before asking for a reply.",
        status: 400,
      };
    case "already-replied":
      return {
        code: "INVALID_REQUEST",
        message: "This message already has a reply.",
        status: 400,
      };
    case "not-configured":
      return {
        code: "AI_NOT_CONFIGURED",
        message: "AI replies are not configured on this server.",
        status: 500,
      };
    default:
      return {
        code: "INTERNAL_ERROR",
        message: "The assistant reply could not be generated. Try again.",
        status: 500,
      };
  }
}

function failureResponse(reason: ReplyFailureReason): Response {
  const { code, message, status } = failureShape(reason);
  return errorResponse(code, message, status);
}

export async function POST(request: Request, { params }: RouteContext) {
  const user = await getCurrentUser();
  if (!user) return unauthenticatedResponse();
  if (!isTrustedRequestOrigin(request)) return forbiddenOriginResponse();

  const { id } = await params;
  if (!isValidConversationId(id)) return notFoundResponse();

  const parsed = await parseReplyRequest(request);
  if (!parsed.ok) return invalidRequestResponse(parsed.message);

  if (!wantsStream(request)) {
    try {
      const result = await generateAssistantReply(user.id, id);
      if (result.ok) return jsonResponse({ message: result.message }, 201);
      return failureResponse(result.reason);
    } catch (error) {
      console.error("[messages] Failed to generate an assistant reply:", error);
      return serverErrorResponse();
    }
  }

  // Everything above the stream is answered as JSON; from here on, failures are
  // SSE `error` events because the response has already been committed.
  let prepared;
  try {
    prepared = await prepareReply(user.id, id);
  } catch (error) {
    console.error("[messages] Failed to prepare an assistant reply:", error);
    return serverErrorResponse();
  }
  if (!prepared.ok) return failureResponse(prepared.reason);

  // The stream stops as soon as the browser goes away: this controller is aborted
  // by the response's cancel hook, and `request.signal` covers a disconnect the
  // runtime reports first.
  const cancel = new AbortController();
  const signal = AbortSignal.any([cancel.signal, request.signal]);

  return sseResponse({
    onCancel: () => cancel.abort(),
    run: async (write) => {
      let finished = false;
      try {
        for await (const event of streamAssistantReply(user.id, prepared, { signal })) {
          switch (event.type) {
            case "delta":
              write(REPLY_STREAM_EVENTS.delta, { text: event.text });
              break;
            case "done":
              finished = true;
              write(REPLY_STREAM_EVENTS.done, { message: event.message });
              break;
            case "failed": {
              // A cancelled stream has no listener left; nothing is claimed either way.
              if (signal.aborted) break;
              const { code, message } = failureShape(event.reason);
              write(REPLY_STREAM_EVENTS.error, { code, message });
              break;
            }
          }
        }
      } catch (error) {
        // Persistence or an unexpected failure: report it, never a completion.
        console.error("[messages] Streaming assistant reply failed:", error);
        if (!finished && !signal.aborted)
          write(REPLY_STREAM_EVENTS.error, {
            code: "INTERNAL_ERROR",
            message: "The assistant reply could not be generated. Try again.",
          });
      }
    },
  });
}
