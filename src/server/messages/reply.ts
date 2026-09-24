import "server-only";
import { AiNotConfiguredError, AiProviderError } from "../ai/errors";
import { openRouterProvider } from "../ai/providers/openrouter";
import { resolveReplyModelKey } from "../ai/models/service";
import { resolveAiPetContext, type AiPetContext } from "../ai/pet-context";
import type { ChatTurn } from "../ai/types";
import { createAssistantMessage, listMessages } from "./service";
import type { MessageRole, MessageSummary } from "@/features/conversations/types";

/**
 * Generates and stores one assistant reply for the newest user turn of an owned
 * conversation. The client identifies the conversation and nothing else: the
 * owner comes from the session, the conversation is filtered by that owner, the
 * history is read from the database, and the role, position, id, and timestamps
 * of the reply are assigned by the message service.
 *
 * Both reply paths share this file. They differ only in how the text arrives: the
 * streaming path forwards provider deltas as they come and stores the text once
 * the provider is finished; the non-streaming path waits for the whole answer.
 * Nothing about ownership, history, limits, or persistence is duplicated.
 *
 * Preparation also resolves the caller's **companion context** (`AiPetContext`) —
 * the safe, catalog-resolved projection of their stored pet and personality. It is
 * carried on the prepared reply so the AI orchestration layer has it in one typed
 * value, and it stops there: no turn, prompt, or provider request is built from it
 * yet, and the provider adapter still receives only turns and a catalog model key.
 * Like the model key, it is resolved from the session user alone — never from
 * anything the request carried.
 */

/** Newest messages considered as context; no summarization or memory yet. */
export const REPLY_HISTORY_MAX_MESSAGES = 40;

/**
 * Rough character budget for one provider request. Older turns are dropped from
 * the front (never the newest one), so a long conversation degrades to a smaller
 * context instead of an unbounded payload or an error.
 */
export const REPLY_HISTORY_MAX_CHARACTERS = 24_000;

/**
 * Turns stored messages into provider input: `USER` → `user`, `ASSISTANT` →
 * `assistant`, and nothing else. Ids, positions, and timestamps stay in the
 * database. Oldest-first order is preserved.
 */
export function buildProviderTurns(
  messages: readonly { role: MessageRole; content: string }[],
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let characters = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const role = message.role === "USER" ? "user" : message.role === "ASSISTANT" ? "assistant" : null;
    if (!role) continue;

    const withinCount = turns.length < REPLY_HISTORY_MAX_MESSAGES;
    // The newest turn is always sent, even if it alone fills the budget.
    const withinSize =
      turns.length === 0 || characters + message.content.length <= REPLY_HISTORY_MAX_CHARACTERS;
    if (!withinCount || !withinSize) break;

    turns.push({ role, content: message.content });
    characters += message.content.length;
  }

  return turns.reverse();
}

/** Why a reply could not be produced. Mapped to HTTP codes and SSE events by the route. */
export type ReplyFailureReason =
  | "not-found"
  | "nothing-to-reply-to"
  | "already-replied"
  | "not-configured"
  | "generation-failed";

export type PreparedReply = {
  ok: true;
  conversationId: string;
  /** The user turn this reply answers; the write is refused if it is no longer newest. */
  answeredMessageId: string;
  turns: ChatTurn[];
  /**
   * Catalog key of the model to generate with: the signed-in user's saved choice
   * when it is still offered, otherwise the configured default. It is a key from
   * the server-owned catalog, never a provider identifier and never anything a
   * browser sent; the adapter resolves it to the OpenRouter identifier.
   */
  modelKey: string;
  /**
   * The caller's companion, resolved server-side from their own stored preferences
   * and narrowed to the AI contract in `../ai/pet-context`: a catalog pet id and
   * name, plus a personality id, name, traits, and hints that always belongs to
   * that pet. Missing, stale, unavailable, or incompatible selections degrade to
   * the documented catalog defaults, so this is always a usable value and never a
   * reason for a reply to fail.
   *
   * It carries no user id, no appearance, no stored preference row, and no
   * credential. Nothing consumes it yet: it is available to the orchestration
   * layer, and the provider request is unchanged.
   */
  petContext: AiPetContext;
};

export type ReplyPreparation = PreparedReply | { ok: false; reason: ReplyFailureReason };

/**
 * The first half of both reply paths: resolve the owned conversation, find the
 * newest turn, build the provider history, and resolve the caller's own
 * preferences — the model to generate with and the companion context. Everything
 * here happens before a stream starts, so an unknown or foreign conversation, an
 * empty conversation, and a turn that already has a reply are answered with an
 * ordinary JSON error.
 */
export async function prepareReply(
  userId: string,
  conversationId: string,
): Promise<ReplyPreparation> {
  // Three independent reads, each keyed by the session user and none of them by
  // anything the request carried.
  const [page, modelKey, petContext] = await Promise.all([
    listMessages(userId, conversationId),
    resolveReplyModelKey(userId),
    resolveAiPetContext({ id: userId }),
  ]);
  if (!page) return { ok: false, reason: "not-found" };

  const latest = page.messages.at(-1);
  if (!latest) return { ok: false, reason: "nothing-to-reply-to" };
  // Only a user turn can be answered: this also rejects a repeated request for a
  // turn that already has a reply.
  if (latest.role !== "USER") return { ok: false, reason: "already-replied" };

  return {
    ok: true,
    conversationId,
    answeredMessageId: latest.id,
    turns: buildProviderTurns(page.messages),
    modelKey,
    petContext,
  };
}

/** Provider failures translated into the shared vocabulary; `null` means unexpected. */
function providerFailureReason(error: unknown): ReplyFailureReason | null {
  if (error instanceof AiNotConfiguredError) return "not-configured";
  if (error instanceof AiProviderError) return "generation-failed";
  return null;
}

/** Safe diagnostics only: a reason and a status, never bodies, prompts, or keys. */
function logProviderFailure(error: unknown) {
  if (error instanceof AiNotConfiguredError) {
    console.error("[messages] Assistant replies are not configured:", error.message);
    return;
  }
  if (error instanceof AiProviderError) {
    console.error(
      `[messages] Assistant reply failed (${error.reason}${error.status ? `, status ${error.status}` : ""}).`,
    );
  }
}

export type StoredReply =
  | { ok: true; message: MessageSummary }
  | { ok: false; reason: ReplyFailureReason };

/**
 * Stores a *finished* answer. Both reply paths funnel through this function, so
 * the empty answer check, the trim, and the stale-turn guard apply to streaming
 * and non-streaming generation alike. A partial answer never reaches it: the
 * streaming path calls it only after the provider signalled completion.
 */
async function storeReply(
  userId: string,
  prepared: PreparedReply,
  text: string,
): Promise<StoredReply> {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, reason: "generation-failed" };

  const stored = await createAssistantMessage(
    userId,
    prepared.conversationId,
    trimmed,
    prepared.answeredMessageId,
  );
  if (stored.ok) return { ok: true, message: stored.message };
  return { ok: false, reason: stored.reason === "stale" ? "already-replied" : "not-found" };
}

export type GenerateReplyResult =
  | { ok: true; message: MessageSummary }
  | { ok: false; reason: ReplyFailureReason };

/**
 * Non-streaming generation for the JSON reply endpoint: read the turn, wait for
 * the whole answer, store it. Failure never writes an assistant row.
 */
export async function generateAssistantReply(
  userId: string,
  conversationId: string,
): Promise<GenerateReplyResult> {
  const prepared = await prepareReply(userId, conversationId);
  if (!prepared.ok) return prepared;

  let content: string;
  try {
    // The model comes from the server catalog, keyed by the user's stored choice.
    content = await openRouterProvider.generateReply(prepared.turns, {
      model: prepared.modelKey,
    });
  } catch (error) {
    const reason = providerFailureReason(error);
    if (!reason) throw error;
    logProviderFailure(error);
    return { ok: false, reason };
  }

  return storeReply(userId, prepared, content);
}

/**
 * One event of the streaming reply, in application terms. The route maps these to
 * SSE events; the browser never sees a provider chunk.
 */
export type ReplyStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; message: MessageSummary }
  | { type: "failed"; reason: ReplyFailureReason };

/**
 * Streams an answer for a prepared turn: yields provider deltas as they arrive and
 * finishes with exactly one `done` (the stored row) or one `failed`.
 *
 * Persistence happens once, after the provider reports completion — a stream that
 * fails, is cut off, or is cancelled by a client that disconnected stores nothing
 * and reports nothing as success. The position, role, and timestamps are still
 * assigned by the message service, so a reply that lost a race against another
 * writer ends as `already-replied` without a second row.
 */
export async function* streamAssistantReply(
  userId: string,
  prepared: PreparedReply,
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<ReplyStreamEvent, void, void> {
  let text = "";
  try {
    const model = { model: prepared.modelKey };
    const stream = options.signal
      ? openRouterProvider.streamReply(prepared.turns, { ...model, signal: options.signal })
      : openRouterProvider.streamReply(prepared.turns, model);
    for await (const chunk of stream) {
      text += chunk.text;
      yield { type: "delta", text: chunk.text };
    }
  } catch (error) {
    const reason = providerFailureReason(error);
    if (!reason) throw error;
    logProviderFailure(error);
    // A cancelled stream has no listener left: nothing is reported, and nothing is
    // stored, because the client that asked for this reply is gone.
    if (options.signal?.aborted) return;
    yield { type: "failed", reason };
    return;
  }

  // A client that went away must not cause a write, and must never be told the
  // reply was stored. Aborting also reaches the provider through the same signal.
  if (options.signal?.aborted) {
    console.error("[messages] Assistant reply stream was cancelled before completion.");
    return;
  }

  const stored = await storeReply(userId, prepared, text);
  if (stored.ok) {
    yield { type: "done", message: stored.message };
    return;
  }
  yield { type: "failed", reason: stored.reason };
}
