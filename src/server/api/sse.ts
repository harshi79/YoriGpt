import "server-only";

/**
 * Server-sent events for the streaming reply endpoint. Framing lives here so the
 * route describes *what* it sends (named events with JSON data) and this module
 * owns the wire format. No provider payload ever passes through: callers hand over
 * plain application data, which is JSON-encoded.
 */

export const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";

/** One framed event: a named event followed by its JSON payload. */
export function formatSseEvent(event: string, data: unknown): string {
  // JSON.stringify keeps the payload on one line, so a value containing newlines
  // cannot break the frame.
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export type SseWriter = (event: string, data: unknown) => void;

/**
 * Wraps an event pump in a streaming `Response`.
 *
 * `run` receives the writer and returns when the conversation is finished, which
 * closes the body. A client that disconnects cancels the underlying stream, so
 * `run`'s writes become no-ops and `onCancel` runs — the route uses that hook to
 * abort the provider request instead of leaving it open for the remaining
 * deadline. Buffering headers are disabled because the point of the response is
 * incremental delivery.
 */
export function sseResponse({
  run,
  onCancel,
}: {
  run: (write: SseWriter) => Promise<void>;
  onCancel?: () => void;
}): Response {
  const encoder = new TextEncoder();
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write: SseWriter = (event, data) => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(formatSseEvent(event, data)));
        } catch {
          // The consumer went away between the check and the enqueue.
          cancelled = true;
        }
      };

      try {
        await run(write);
      } finally {
        // A cancelled stream must not be closed (or enqueued to) again.
        if (!cancelled) {
          try {
            controller.close();
          } catch {
            cancelled = true;
          }
        }
      }
    },
    cancel() {
      cancelled = true;
      onCancel?.();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": SSE_CONTENT_TYPE,
      // `no-transform` keeps proxies from buffering or compressing the stream.
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
