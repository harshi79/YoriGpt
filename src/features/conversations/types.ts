/**
 * Wire shapes shared by the conversation API, the server service, and the chat
 * shell. This module is intentionally free of runtime code so both server
 * components and client components can use the same contract.
 */

/** The only conversation fields the current UI or API exposes. */
export type ConversationSummary = {
  id: string;
  title: string;
  /** ISO-8601 timestamps, serialized from the database values. */
  createdAt: string;
  updatedAt: string;
};

/** List state for the sidebar: anonymous visitors never trigger a lookup. */
export type ConversationListStatus = "anonymous" | "ready" | "error";

export type ConversationList = {
  status: ConversationListStatus;
  conversations: ConversationSummary[];
  /** True when the list was capped; the sidebar then says so explicitly. */
  truncated: boolean;
};

export const EMPTY_CONVERSATION_LIST: ConversationList = {
  status: "anonymous",
  conversations: [],
  truncated: false,
};

/**
 * Stored message roles. Only `USER` can be written by the current API; the read
 * path returns whatever is actually stored instead of narrowing it silently.
 */
export type MessageRole = "USER" | "ASSISTANT" | "SYSTEM";

/** The only message fields the API exposes; no owner or conversation columns. */
export type MessageSummary = {
  id: string;
  role: MessageRole;
  content: string;
  /** Zero-based position inside the conversation, assigned by the server. */
  position: number;
  /** ISO-8601 timestamps, serialized from the database values. */
  createdAt: string;
  updatedAt: string;
};

/**
 * Message read state for the conversation page. A failed read is reported as
 * `error` so the shell never claims a conversation has no messages when the
 * query failed.
 */
export type MessageList = {
  status: "ready" | "error";
  messages: MessageSummary[];
  /** True when the conversation is longer than one page of messages. */
  truncated: boolean;
};

export const EMPTY_MESSAGE_LIST: MessageList = {
  status: "ready",
  messages: [],
  truncated: false,
};

/**
 * The server-sent event protocol of the streaming reply endpoint, shared by the
 * route that writes it and the browser client that reads it.
 *
 * ```
 * event: delta
 * data: {"text":"Hello"}
 *
 * event: done
 * data: {"message":{"id":"…","role":"ASSISTANT","content":"Hello there",…}}
 *
 * event: error
 * data: {"code":"INTERNAL_ERROR","message":"…"}
 * ```
 *
 * Events carry application data only: assistant text, the stored message, and the
 * same `{ code, message }` envelope the JSON API uses. Raw provider chunks, model
 * names, prompts, and credentials are never part of the protocol.
 */
export const REPLY_STREAM_EVENTS = {
  /** One piece of assistant text. Incremental; never a stored message. */
  delta: "delta",
  /** The answer is complete and stored; `message` is the persisted row. */
  done: "done",
  /** Generation failed; nothing was stored. */
  error: "error",
} as const;

export type ReplyStreamEventName =
  (typeof REPLY_STREAM_EVENTS)[keyof typeof REPLY_STREAM_EVENTS];
