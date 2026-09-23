"use client";

import {
  readReplyStream,
  STREAM_INTERRUPTED_MESSAGE,
  type ReplyStreamOutcome,
} from "./stream";
import type { ConversationSummary, MessageSummary } from "./types";

/**
 * Browser calls to the conversation API. Only the fetch plumbing lives here —
 * ownership, validation, and persistence are enforced by the server.
 */

export type ConversationActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; message: string };

const GENERIC_ERROR = "Something went wrong. Try again.";
const OFFLINE_ERROR = "We couldn’t reach the server. Check your connection and try again.";

function isConversationSummary(value: unknown): value is ConversationSummary {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

const MESSAGE_ROLES: readonly string[] = ["USER", "ASSISTANT", "SYSTEM"];

function isMessageSummary(value: unknown): value is MessageSummary {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.role === "string" &&
    MESSAGE_ROLES.includes(candidate.role) &&
    typeof candidate.content === "string" &&
    typeof candidate.position === "number" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

async function errorFrom(
  response: Response,
  fallback: string,
): Promise<{ message: string; code?: string }> {
  try {
    const body: unknown = await response.json();
    const error = (body as { error?: { message?: unknown; code?: unknown } })?.error;
    const message =
      typeof error?.message === "string" && error.message.trim() !== "" ? error.message : fallback;
    return { message, code: typeof error?.code === "string" ? error.code : undefined };
  } catch {
    return { message: fallback };
  }
}

async function messageFrom(response: Response, fallback: string): Promise<string> {
  return (await errorFrom(response, fallback)).message;
}

export async function requestNewConversation(): Promise<
  ConversationActionResult<ConversationSummary>
> {
  try {
    // No fields are sent: the server owns the title default and always assigns
    // the owner from the session.
    const response = await fetch("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      credentials: "same-origin",
    });

    if (response.status === 201) {
      const body: unknown = await response.json();
      const conversation = (body as { conversation?: unknown })?.conversation;
      if (isConversationSummary(conversation)) return { ok: true, value: conversation };
      return { ok: false, status: response.status, message: GENERIC_ERROR };
    }
    return {
      ok: false,
      status: response.status,
      message: await messageFrom(response, GENERIC_ERROR),
    };
  } catch {
    return { ok: false, status: 0, message: OFFLINE_ERROR };
  }
}

/**
 * Stores one message written by the signed-in user in an owned conversation.
 * Only the message text is sent: the server derives the owner from the session
 * and assigns the role, position, and timestamps.
 */
export async function requestUserMessage(
  conversationId: string,
  content: string,
): Promise<ConversationActionResult<MessageSummary>> {
  try {
    const response = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
        credentials: "same-origin",
      },
    );

    if (response.status === 201) {
      const body: unknown = await response.json();
      const message = (body as { message?: unknown })?.message;
      if (isMessageSummary(message)) return { ok: true, value: message };
      return { ok: false, status: response.status, message: GENERIC_ERROR };
    }
    return {
      ok: false,
      status: response.status,
      message: await messageFrom(response, GENERIC_ERROR),
    };
  } catch {
    return { ok: false, status: 0, message: OFFLINE_ERROR };
  }
}

/**
 * Asks the server to generate and store one assistant reply for this
 * conversation. Nothing about the reply is chosen here: no model, role, content,
 * or position is sent — the server reads the conversation and the configured
 * provider decides the text.
 */
export async function requestAssistantReply(
  conversationId: string,
): Promise<ConversationActionResult<MessageSummary>> {
  try {
    const response = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/reply`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        credentials: "same-origin",
      },
    );

    if (response.status === 201) {
      const body: unknown = await response.json();
      const message = (body as { message?: unknown })?.message;
      if (isMessageSummary(message)) return { ok: true, value: message };
      return { ok: false, status: response.status, message: GENERIC_ERROR };
    }
    return {
      ok: false,
      status: response.status,
      message: await messageFrom(response, GENERIC_ERROR),
    };
  } catch {
    return { ok: false, status: 0, message: OFFLINE_ERROR };
  }
}

/** The HTTP status each stream `error` code corresponds to, for the caller's decisions. */
const STREAM_STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN_ORIGIN: 403,
  NOT_FOUND: 404,
  INVALID_REQUEST: 400,
};

function statusForCode(code: string | undefined): number {
  return (code && STREAM_STATUS[code]) || 500;
}

function isEventStream(response: Response): boolean {
  return (response.headers.get("content-type") ?? "")
    .toLowerCase()
    .includes("text/event-stream");
}

/**
 * Asks the server to generate one assistant reply and reads it as it is produced.
 * Each provider delta arrives through `onDelta` and is shown while it is still
 * provisional: the reply is only real once the final `done` event carries the row
 * the server stored. Aborting through `options.signal` (a component unmounting,
 * for example) cancels the request and the server-side provider call with it.
 */
export async function requestAssistantReplyStream(
  conversationId: string,
  handlers: { onDelta: (text: string) => void },
  options: { signal?: AbortSignal } = {},
): Promise<
  ConversationActionResult<MessageSummary> & { code?: string; aborted?: boolean }
> {
  try {
    const response = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/reply`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: "{}",
        credentials: "same-origin",
        signal: options.signal,
      },
    );

    // Pre-stream failures keep the JSON envelope: the request never became a
    // stream, so it is reported exactly like the non-streaming endpoint reports it.
    if (!response.ok || !isEventStream(response)) {
      const { message, code } = await errorFrom(response, GENERIC_ERROR);
      return { ok: false, status: response.status, message, code };
    }
    if (!response.body) return { ok: false, status: response.status, message: GENERIC_ERROR };

    const outcome: ReplyStreamOutcome = await readReplyStream(
      response.body,
      handlers,
      options.signal,
    );
    if (outcome.ok) return { ok: true, value: outcome.message };
    if (outcome.aborted)
      return { ok: false, status: 0, message: OFFLINE_ERROR, aborted: true };
    return {
      ok: false,
      status: statusForCode(outcome.code),
      message: outcome.message || STREAM_INTERRUPTED_MESSAGE,
      code: outcome.code,
    };
  } catch (error) {
    if (options.signal?.aborted || (error as Error)?.name === "AbortError")
      return { ok: false, status: 0, message: OFFLINE_ERROR, aborted: true };
    return { ok: false, status: 0, message: OFFLINE_ERROR };
  }
}

export async function requestDeleteConversation(
  conversationId: string,
): Promise<ConversationActionResult<null>> {
  try {
    const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
      method: "DELETE",
      credentials: "same-origin",
    });

    if (response.status === 204) return { ok: true, value: null };
    return {
      ok: false,
      status: response.status,
      message: await messageFrom(response, GENERIC_ERROR),
    };
  } catch {
    return { ok: false, status: 0, message: OFFLINE_ERROR };
  }
}
