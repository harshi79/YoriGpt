import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestAssistantReplyStream,
} from "../src/features/conversations/client";
import {
  STREAM_INTERRUPTED_MESSAGE,
  STREAM_UNREADABLE_MESSAGE,
} from "../src/features/conversations/stream";

/**
 * The browser half of the streaming protocol: request shape, incremental
 * rendering callbacks, the `done` reconciliation, and every way a stream can end
 * badly. `fetch` is stubbed, so nothing here touches the network.
 */
const conversationId = "cm1a2b3c4d5e6f7g8h9i0jkl";

const stored = {
  id: "cm9z8y7x6w5v4u3t2s1r0qpo",
  role: "ASSISTANT",
  content: "Hello there",
  position: 1,
  createdAt: "2026-09-23T10:00:00.000Z",
  updatedAt: "2026-09-23T10:00:00.000Z",
};

function delta(text: string) {
  return `event: delta\ndata: ${JSON.stringify({ text })}\n\n`;
}
const done = `event: done\ndata: ${JSON.stringify({ message: stored })}\n\n`;

function errorEvent(code: string, message: string) {
  return `event: error\ndata: ${JSON.stringify({ code, message })}\n\n`;
}

function sseResponse(parts: (string | Uint8Array)[], status = 200) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(typeof part === "string" ? encoder.encode(part) : part);
      }
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function stubFetch(handler: (request: Request) => Promise<Response> | Response) {
  const calls: { request: Request; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(input), "http://localhost:3000"), init);
    calls.push({ request, init });
    return handler(request);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser streaming reply requests", () => {
  it("posts no client-controlled fields and renders each delta as it arrives", async () => {
    const calls = stubFetch(() => sseResponse([delta("Hello"), delta(" there"), done]));
    const received: string[] = [];

    const result = await requestAssistantReplyStream(conversationId, {
      onDelta: (text) => received.push(text),
    });

    expect(received).toEqual(["Hello", " there"]);
    expect(result).toEqual({ ok: true, value: stored });

    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.credentials).toBe("same-origin");
    expect(calls[0].request.headers.get("accept")).toBe("text/event-stream");
    expect(calls[0].request.headers.get("content-type")).toBe("application/json");
    expect(new URL(calls[0].request.url).pathname).toBe(
      `/api/conversations/${conversationId}/reply`,
    );
    // The server decides everything about the reply; the body only opens the stream.
    expect(await calls[0].request.text()).toBe("{}");
  });

  it("reassembles frames split across chunks, including CRLF and unknown events", async () => {
    stubFetch(() =>
      sseResponse([
        ": keep-alive\r\n\r\n",
        'event: delta\ndata: {"text":"Spl',
        'it "}',
        "\r\n\r\nevent: future\ndata: {\"anything\":1}\n\n",
        'event: delta\ndata: {"text":"text"}\n\n',
        done.slice(0, 20),
        done.slice(20),
      ]),
    );
    const received: string[] = [];

    const result = await requestAssistantReplyStream(conversationId, {
      onDelta: (text) => received.push(text),
    });

    expect(received.join("")).toBe("Split text");
    expect(result).toEqual({ ok: true, value: stored });
  });

  it("keeps the server's message and code when generation fails mid-stream", async () => {
    stubFetch(() =>
      sseResponse([
        delta("Half an answer"),
        errorEvent("INTERNAL_ERROR", "The assistant reply could not be generated. Try again."),
      ]),
    );
    const received: string[] = [];

    const result = await requestAssistantReplyStream(conversationId, {
      onDelta: (text) => received.push(text),
    });

    expect(received).toEqual(["Half an answer"]);
    expect(result).toEqual({
      ok: false,
      status: 500,
      code: "INTERNAL_ERROR",
      message: "The assistant reply could not be generated. Try again.",
    });
  });

  it("reports a pre-stream JSON failure exactly as the non-streaming endpoint does", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: "NOT_FOUND", message: "Conversation not found." } }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    );

    expect(
      await requestAssistantReplyStream(conversationId, { onDelta: () => {} }),
    ).toEqual({
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: "Conversation not found.",
    });
  });

  it("never reports success for an interrupted or unreadable stream", async () => {
    stubFetch(() => sseResponse([delta("Only a start")]));
    const interrupted = await requestAssistantReplyStream(conversationId, { onDelta: () => {} });
    expect(interrupted).toEqual({ ok: false, status: 500, message: STREAM_INTERRUPTED_MESSAGE });

    stubFetch(() => sseResponse(["event: delta\ndata: {not json}\n\n", done]));
    const unreadable = await requestAssistantReplyStream(conversationId, { onDelta: () => {} });
    expect(unreadable).toEqual({ ok: false, status: 500, message: STREAM_UNREADABLE_MESSAGE });

    // A stream that completes with a payload that is not a stored message is also
    // refused rather than shown.
    stubFetch(() => sseResponse([`event: done\ndata: {"message":{"id":1}}\n\n`]));
    const wrongShape = await requestAssistantReplyStream(conversationId, { onDelta: () => {} });
    expect(wrongShape).toEqual({ ok: false, status: 500, message: STREAM_UNREADABLE_MESSAGE });

    // A 200 that is not an event stream at all cannot be treated as a reply.
    stubFetch(
      () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const notAStream = await requestAssistantReplyStream(conversationId, { onDelta: () => {} });
    expect(notAStream.ok).toBe(false);
  });

  it("stops reading when the caller aborts and reports no failure to the user", async () => {
    const controller = new AbortController();
    stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              streamController.enqueue(new TextEncoder().encode(delta("Never finished")));
              controller.signal.addEventListener("abort", () =>
                streamController.error(new DOMException("The operation was aborted.", "AbortError")),
              );
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );

    const pending = requestAssistantReplyStream(
      conversationId,
      { onDelta: () => {} },
      { signal: controller.signal },
    );
    controller.abort();

    const result = await pending;
    expect(result).toMatchObject({ ok: false, status: 0, aborted: true });
  });
});
