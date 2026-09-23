import { getCurrentUser } from "@/server/auth/session";
import {
  forbiddenOriginResponse,
  invalidRequestResponse,
  isTrustedRequestOrigin,
  jsonResponse,
  serverErrorResponse,
  unauthenticatedResponse,
} from "@/server/api/http";
import { parseCreateConversationRequest } from "@/server/conversations/request";
import { createConversation, listConversations } from "@/server/conversations/service";

/**
 * The authenticated user's conversations. Ownership always comes from the
 * session; nothing in the request can change it.
 */

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthenticatedResponse();

  try {
    const { conversations, truncated } = await listConversations(user.id);
    return jsonResponse({ conversations, truncated });
  } catch (error) {
    console.error("[conversations] Failed to list conversations:", error);
    return serverErrorResponse();
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return unauthenticatedResponse();
  if (!isTrustedRequestOrigin(request)) return forbiddenOriginResponse();

  const parsed = await parseCreateConversationRequest(request);
  if (!parsed.ok) return invalidRequestResponse(parsed.message);

  try {
    const conversation = await createConversation(user.id, parsed.title);
    return jsonResponse({ conversation }, 201);
  } catch (error) {
    console.error("[conversations] Failed to create a conversation:", error);
    return serverErrorResponse();
  }
}
