import { getCurrentUser } from "@/server/auth/session";
import {
  forbiddenOriginResponse,
  invalidRequestResponse,
  isTrustedRequestOrigin,
  jsonResponse,
  notFoundResponse,
  serverErrorResponse,
  unauthenticatedResponse,
} from "@/server/api/http";
import { isValidConversationId } from "@/server/conversations/request";
import { parseCreateMessageRequest } from "@/server/messages/request";
import { createUserMessage, listMessages } from "@/server/messages/service";

/**
 * Messages of one conversation, always reached through an owner-scoped query. A
 * conversation the caller does not own answers with the same 404 envelope as an
 * unknown id, so the route never reveals that another account's data exists.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const user = await getCurrentUser();
  if (!user) return unauthenticatedResponse();

  const { id } = await params;
  if (!isValidConversationId(id)) return notFoundResponse();

  try {
    const page = await listMessages(user.id, id);
    return page ? jsonResponse(page) : notFoundResponse();
  } catch (error) {
    console.error("[messages] Failed to list messages:", error);
    return serverErrorResponse();
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const user = await getCurrentUser();
  if (!user) return unauthenticatedResponse();
  if (!isTrustedRequestOrigin(request)) return forbiddenOriginResponse();

  const { id } = await params;
  if (!isValidConversationId(id)) return notFoundResponse();

  const parsed = await parseCreateMessageRequest(request);
  if (!parsed.ok) return invalidRequestResponse(parsed.message);

  try {
    const result = await createUserMessage(user.id, id, parsed.content);
    if (!result.ok) return notFoundResponse();
    return jsonResponse({ message: result.message }, 201);
  } catch (error) {
    console.error("[messages] Failed to create a message:", error);
    return serverErrorResponse();
  }
}
