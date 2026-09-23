"use client";

import {
  REPLY_STREAM_EVENTS,
  type MessageSummary,
} from "./types";

/**
 * Reader for the streaming reply response. It owns the other half of the SSE
 * protocol documented in `types.ts`: framing, incremental decoding, and turning
 * named events into application data. It never forwards a provider payload — the
 * server already normalized its stream, so this reader only knows `delta`, `done`,
 * and `error`.
 */

/** The stream ended without the server confirming a stored reply. */
export const STREAM_INTERRUPTED_MESSAGE =
  "The assistant reply stopped before it finished. Try again.";

/** The bytes on the wire did not follow the protocol. */
export const STREAM_UNREADABLE_MESSAGE = "The assistant reply could not be read. Try again.";

export type ReplyStreamOutcome =
  | { ok: true; message: MessageSummary }
  | { ok: false; code?: string; message: string; aborted?: boolean };

type Handlers = {
  /** Called for each piece of assistant text, in arrival order. */
  onDelta: (text: string) => void;
};

/** One parsed frame: its event name and its raw `data:` payload (if any). */
function readFrame(frame: string): { event: string; data: string | null } {
  let event = "";
  const data: string[] = [];

  for (const line of frame.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1);
    const trimmed = value.startsWith(" ") ? value.slice(1) : value;
    if (field === "event") event = trimmed;
    else if (field === "data") data.push(trimmed);
  }

  return { event, data: data.length > 0 ? data.join("\n") : null };
}

function isMessageSummary(value: unknown): value is MessageSummary {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.role === "string" &&
    typeof candidate.content === "string" &&
    typeof candidate.position === "number" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

/**
 * Reads the reply stream until the server says the answer is stored (`done`),
 * reports a failure (`error`), or the connection ends. Text deltas are handed to
 * `onDelta` as they arrive; the caller keeps them in memory only — nothing is
 * considered persisted until `done` carries the stored row.
 */
export async function readReplyStream(
  body: ReadableStream<Uint8Array>,
  handlers: Handlers,
  signal?: AbortSignal,
): Promise<ReplyStreamOutcome> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  try {
    while (!finished) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        return { ok: false, message: STREAM_INTERRUPTED_MESSAGE, aborted: signal?.aborted };
      }
      if (chunk.done) return { ok: false, message: STREAM_INTERRUPTED_MESSAGE };

      buffer += decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\r\n?/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const parsed = readFrame(frame);
        if (parsed.data !== null && parsed.event !== "") {
          let payload: unknown;
          try {
            payload = JSON.parse(parsed.data);
          } catch {
            return { ok: false, message: STREAM_UNREADABLE_MESSAGE };
          }

          if (parsed.event === REPLY_STREAM_EVENTS.delta) {
            const text = (payload as { text?: unknown })?.text;
            if (typeof text === "string" && text !== "") handlers.onDelta(text);
          } else if (parsed.event === REPLY_STREAM_EVENTS.done) {
            const message = (payload as { message?: unknown })?.message;
            if (!isMessageSummary(message)) return { ok: false, message: STREAM_UNREADABLE_MESSAGE };
            finished = true;
            return { ok: true, message };
          } else if (parsed.event === REPLY_STREAM_EVENTS.error) {
            const error = payload as { code?: unknown; message?: unknown };
            return {
              ok: false,
              code: typeof error.code === "string" ? error.code : undefined,
              message:
                typeof error.message === "string" && error.message.trim() !== ""
                  ? error.message
                  : STREAM_INTERRUPTED_MESSAGE,
            };
          }
          // Unknown event names are ignored so a future event cannot break this.
        }

        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    // Stop the connection when the reader left early (an `error` event, a broken
    // frame, or a caller that gave up) instead of leaving it half-open.
    reader.releaseLock();
    void body.cancel().catch(() => {});
  }

  return { ok: false, message: STREAM_INTERRUPTED_MESSAGE };
}
