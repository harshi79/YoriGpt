import "server-only";
import { listConversations } from "./service";
import type { ConversationList } from "@/features/conversations/types";

/**
 * Read model for the chat shell. Anonymous visitors never touch the database;
 * a failed query is reported as an error state instead of breaking the page, so
 * the shell can still render (with a retry) when the database is unavailable.
 */
export async function loadSidebarConversations(
  user: { id: string } | null,
): Promise<ConversationList> {
  if (!user) return { status: "anonymous", conversations: [], truncated: false };
  try {
    const { conversations, truncated } = await listConversations(user.id);
    return { status: "ready", conversations, truncated };
  } catch (error) {
    console.error("[conversations] Failed to load the conversation list:", error);
    return { status: "error", conversations: [], truncated: false };
  }
}
