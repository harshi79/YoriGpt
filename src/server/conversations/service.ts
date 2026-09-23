import "server-only";
import { getDb } from "../db/client";
import type { ConversationSummary } from "@/features/conversations/types";

/**
 * Ownership-scoped conversation queries. Every function takes the id of the
 * authenticated user (from `requireUser()` / `getCurrentUser()`) and includes it
 * in the database filter, so a caller can never read or change another user's
 * data — even when it holds a valid conversation id. No function accepts an
 * owner id from request input.
 */

/** Default title for a new conversation; a later task may replace it with a title. */
export const DEFAULT_CONVERSATION_TITLE = "New chat";

/** Upper bound for one sidebar request; the UI reports when it is reached. */
export const CONVERSATION_LIST_LIMIT = 200;

/** Only the columns the API returns; never the owner or internal columns. */
const summarySelect = {
  id: true,
  title: true,
  createdAt: true,
  updatedAt: true,
} as const;

type ConversationRow = {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
};

function toSummary(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Owned conversations, most recent activity first. `updatedAt` and the `id`
 * tie-breaker match the `conversations_userId_updatedAt_id_idx` index, so equal
 * timestamps still return a stable order.
 */
export async function listConversations(
  userId: string,
  limit = CONVERSATION_LIST_LIMIT,
): Promise<{ conversations: ConversationSummary[]; truncated: boolean }> {
  const rows = await getDb().conversation.findMany({
    where: { userId },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: summarySelect,
  });
  return {
    conversations: rows.slice(0, limit).map(toSummary),
    truncated: rows.length > limit,
  };
}

/** Creates a conversation owned by `userId`. The client cannot influence ownership. */
export async function createConversation(
  userId: string,
  title: string = DEFAULT_CONVERSATION_TITLE,
): Promise<ConversationSummary> {
  const row = await getDb().conversation.create({
    data: { userId, title },
    select: summarySelect,
  });
  return toSummary(row);
}

/** Returns the conversation only when `userId` owns it, otherwise null. */
export async function getConversation(
  userId: string,
  conversationId: string,
): Promise<ConversationSummary | null> {
  const row = await getDb().conversation.findFirst({
    where: { id: conversationId, userId },
    select: summarySelect,
  });
  return row ? toSummary(row) : null;
}

/**
 * Deletes the conversation only when `userId` owns it. Returns whether a row was
 * removed, so callers can answer 404 for another user's id without ever reading it.
 */
export async function deleteConversation(
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const result = await getDb().conversation.deleteMany({
    where: { id: conversationId, userId },
  });
  return result.count === 1;
}
