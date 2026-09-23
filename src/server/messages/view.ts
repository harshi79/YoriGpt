import "server-only";
import { listMessages } from "./service";
import type { MessageList } from "@/features/conversations/types";

/**
 * Read model for the conversation page. A failed or unauthorized read is
 * reported as an error state rather than an empty list, so the shell can still
 * render and never shows "no messages yet" when the messages could not be read.
 */
export async function loadConversationMessages(
  userId: string,
  conversationId: string,
): Promise<MessageList> {
  try {
    const page = await listMessages(userId, conversationId);
    if (!page) return { status: "error", messages: [], truncated: false };
    return { status: "ready", messages: page.messages, truncated: page.truncated };
  } catch (error) {
    console.error("[messages] Failed to load conversation messages:", error);
    return { status: "error", messages: [], truncated: false };
  }
}
