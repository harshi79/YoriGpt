import { getCurrentUser } from "@/server/auth/session";
import {
  forbiddenOriginResponse,
  isTrustedRequestOrigin,
  jsonResponse,
  notFoundResponse,
  serverErrorResponse,
  unauthenticatedResponse,
} from "@/server/api/http";
import { isValidConversationId } from "@/server/conversations/request";
import { deleteConversation, getConversation } from "@/server/conversations/service";

/**
 * One conversation, always filtered by the authenticated owner. A conversation
 * that does not exist and one owned by somebody else both answer 404, so the API
 * never confirms that another user's conversation exists.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const user = await getCurrentUser();
  if (!user) return unauthenticatedResponse();

  const { id } = await params;
  if (!isValidConversationId(id)) return notFoundResponse();

  try {
    const conversation = await getConversation(user.id, id);
    return conversation ? jsonResponse({ conversation }) : notFoundResponse();
  } catch (error) {
    console.error("[conversations] Failed to read a conversation:", error);
    return serverErrorResponse();
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const user = await getCurrentUser();
  if (!user) return unauthenticatedResponse();
  if (!isTrustedRequestOrigin(request)) return forbiddenOriginResponse();

  const { id } = await params;
  if (!isValidConversationId(id)) return notFoundResponse();

  try {
    const deleted = await deleteConversation(user.id, id);
    if (!deleted) return notFoundResponse();
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("[conversations] Failed to delete a conversation:", error);
    return serverErrorResponse();
  }
}
