import "server-only";
import { Prisma } from "@prisma/client";
import { getDb } from "../db/client";
import { getConversation } from "../conversations/service";
import type { MessageRole, MessageSummary } from "@/features/conversations/types";

/**
 * Ownership-scoped message queries. Every function takes the id of the
 * authenticated user (from `getCurrentUser()` / `requireUser()`) and reaches the
 * conversation through a filter that includes it, so a caller can never read or
 * write messages in another user's conversation — even with a valid id. No
 * function accepts an owner, role, position, or timestamp from request input.
 *
 * A conversation that does not exist and one owned by somebody else are treated
 * identically (`null`), so the API answers the same 404 for both and never
 * confirms that another account's conversation exists.
 */

/** Upper bound for one message read; the page reports when it is reached. */
export const MESSAGE_LIST_LIMIT = 500;

/** How often a losing writer retries after a position collision. */
const MAX_POSITION_ATTEMPTS = 3;

/** Only the columns the API returns; never owner or internal columns. */
const messageSelect = {
  id: true,
  role: true,
  content: true,
  position: true,
  createdAt: true,
  updatedAt: true,
} as const;

type MessageRow = {
  id: string;
  role: MessageRole;
  content: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
};

function toSummary(row: MessageRow): MessageSummary {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type MessagePage = { messages: MessageSummary[]; truncated: boolean };

/**
 * Messages of one owned conversation, oldest first (ascending `position`).
 * Returns `null` when the conversation is unknown or belongs to another user.
 *
 * A long conversation is read newest-first and then reversed, so the cap keeps
 * the most recent messages in their original order instead of an arbitrary slice.
 */
export async function listMessages(
  userId: string,
  conversationId: string,
): Promise<MessagePage | null> {
  // The ownership filter lives in this query (`id` + `userId`), not in a check
  // performed after the rows were read.
  const conversation = await getConversation(userId, conversationId);
  if (!conversation) return null;

  const rows = await getDb().message.findMany({
    where: { conversationId },
    orderBy: { position: "desc" },
    take: MESSAGE_LIST_LIMIT + 1,
    select: messageSelect,
  });
  const truncated = rows.length > MESSAGE_LIST_LIMIT;
  const kept = truncated ? rows.slice(0, MESSAGE_LIST_LIMIT) : rows;
  return { messages: kept.reverse().map(toSummary), truncated };
}

export type CreateMessageResult =
  | { ok: true; message: MessageSummary }
  | { ok: false; reason: "not-found" };

/** Outcome of one attempt inside the transaction, before the retry wrapper. */
type InsertOutcome =
  | { status: "created"; message: MessageSummary }
  | { status: "not-found" }
  | { status: "stale" };

/**
 * Stores one message in an owned conversation. Every value the client does not
 * control is derived here: the conversation comes from the URL, the owner from
 * the session, the role from the caller, and the position from the stored rows.
 *
 * The transaction first updates the parent conversation with an ownership filter,
 * which (a) refreshes its activity timestamp for the sidebar order and (b) locks
 * the row until the transaction ends, so concurrent writers queue behind each
 * other instead of both reading the same last position. If two writers still
 * collide, the `(conversationId, position)` unique constraint rejects the loser
 * and the insert is retried — a duplicate position can never be stored.
 *
 * `requireLatestMessageId` additionally refuses to write unless the newest stored
 * message is still the one the caller replied to. Because the row lock serializes
 * writers, that check makes "one assistant reply per user turn" a database
 * guarantee rather than a client-side hope.
 */
async function insertMessage(
  userId: string,
  conversationId: string,
  data: { role: MessageRole; content: string },
  requireLatestMessageId?: string,
): Promise<InsertOutcome> {
  const now = new Date();
  return getDb().$transaction(
    async (tx) => {
      const owned = await tx.conversation.updateMany({
        where: { id: conversationId, userId },
        data: { updatedAt: now },
      });
      // Unknown id and somebody else's conversation are the same answer.
      if (owned.count !== 1) return { status: "not-found" };

      const latest = await tx.message.findFirst({
        where: { conversationId },
        orderBy: { position: "desc" },
        select: { id: true, position: true },
      });
      if (requireLatestMessageId !== undefined && latest?.id !== requireLatestMessageId)
        return { status: "stale" };

      const position = (latest?.position ?? -1) + 1;

      const row = await tx.message.create({
        data: { conversationId, role: data.role, content: data.content, position },
        select: messageSelect,
      });
      return { status: "created", message: toSummary(row) };
    },
    { timeout: 15_000, maxWait: 10_000 },
  );
}

/** Runs one insert, retrying only a position collision. */
async function insertWithRetry(
  userId: string,
  conversationId: string,
  data: { role: MessageRole; content: string },
  requireLatestMessageId?: string,
): Promise<InsertOutcome> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await insertMessage(userId, conversationId, data, requireLatestMessageId);
    } catch (error) {
      if (isPositionConflict(error) && attempt < MAX_POSITION_ATTEMPTS) continue;
      throw error;
    }
  }
}

/** Stores a message written by the user (role `USER`). */
export async function createUserMessage(
  userId: string,
  conversationId: string,
  content: string,
): Promise<CreateMessageResult> {
  const outcome = await insertWithRetry(userId, conversationId, { role: "USER", content });
  if (outcome.status === "created") return { ok: true, message: outcome.message };
  return { ok: false, reason: "not-found" };
}

export type CreateAssistantMessageResult =
  | { ok: true; message: MessageSummary }
  | { ok: false; reason: "not-found" | "stale" };

/**
 * Stores an assistant reply (role `ASSISTANT`) for the user turn identified by
 * `inReplyToMessageId`. Only the reply text comes from the provider; the role,
 * position, id, and timestamps are assigned here. A turn that already has a reply
 * (or moved on) answers `stale` instead of writing a second assistant row.
 */
export async function createAssistantMessage(
  userId: string,
  conversationId: string,
  content: string,
  inReplyToMessageId: string,
): Promise<CreateAssistantMessageResult> {
  const outcome = await insertWithRetry(
    userId,
    conversationId,
    { role: "ASSISTANT", content },
    inReplyToMessageId,
  );
  if (outcome.status === "created") return { ok: true, message: outcome.message };
  return { ok: false, reason: outcome.status };
}

/** True when PostgreSQL rejected a second message at an already-used position. */
function isPositionConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
