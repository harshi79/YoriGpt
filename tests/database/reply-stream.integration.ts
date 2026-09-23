import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The route handlers read the incoming request headers from `next/headers`; this
// holder lets the tests present a real Better Auth session cookie (or none).
const request = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock("next/headers", () => ({ headers: async () => request.headers }));

/**
 * The provider is stubbed at the server boundary, so these tests never reach the
 * network. Both reply paths are scripted here: `generateReply` for the JSON
 * endpoint, `streamReply` for the SSE endpoint. The real adapter has its own unit
 * tests, and the browser suite drives a local OpenRouter-compatible stub server.
 */
const provider = vi.hoisted(() => ({
  reply: "A stored assistant reply.",
  failure: null as Error | null,
  calls: [] as { role: string; content: string }[][],
  // Streaming script.
  chunks: [] as string[],
  streamFailure: null as Error | null,
  chunkDelayMs: 10,
  started: 0,
}));

vi.mock("../../src/server/ai/providers/openrouter", async () => {
  const { AiProviderError } = await import("../../src/server/ai/errors");

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  return {
    openRouterProvider: {
      name: "openrouter",
      generateReply: async (turns: { role: string; content: string }[]) => {
        provider.calls.push(turns);
        if (provider.failure) throw provider.failure;
        return provider.reply;
      },
      streamReply: async function* (
        turns: { role: string; content: string }[],
        options: { signal?: AbortSignal } = {},
      ) {
        provider.calls.push(turns);
        provider.started += 1;
        for (const text of provider.chunks) {
          if (options.signal?.aborted) throw new AiProviderError("aborted");
          yield { type: "delta" as const, text };
          await sleep(provider.chunkDelayMs);
        }
        if (options.signal?.aborted) throw new AiProviderError("aborted");
        // A provider that stops without a completion marker: the adapter would
        // report this as a malformed stream, so the fake reports it the same way.
        if (provider.streamFailure) throw provider.streamFailure;
      },
    },
  };
});

import { createAuth } from "../../src/server/auth/config";
import { getDb } from "../../src/server/db/client";
import { POST as createConversation } from "../../src/app/api/conversations/route";
import { POST as createMessage } from "../../src/app/api/conversations/[id]/messages/route";
import { POST as createReply } from "../../src/app/api/conversations/[id]/reply/route";
import { AiNotConfiguredError, AiProviderError } from "../../src/server/ai/errors";

/**
 * Real Better Auth sessions + real PostgreSQL, driving the real streaming reply
 * handler. The point of this suite: deltas arrive before the row exists, exactly
 * one ASSISTANT row is stored per finished stream, and every failure path — a
 * failed stream, an empty stream, a lost race, a client that disconnected —
 * stores nothing.
 */
const TEST_DOMAIN = "reply-stream-test.invalid";
const password = "correct-horse-battery";
const APP_ORIGIN = "http://localhost:3000";

let auth: ReturnType<typeof createAuth>;
let db: ReturnType<typeof getDb>;
let alice: { id: string; cookie: string };
let bob: { id: string; cookie: string };

function authRequest(path: string, body: unknown) {
  return auth.handler(
    new Request(`${APP_ORIGIN}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("expected a session cookie");
  return header.split(";")[0];
}

async function signUpAndGetSession(email: string, name: string) {
  const response = await authRequest("/sign-up/email", { name, email, password });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { user: { id: string } };
  return { id: body.user.id, cookie: cookieFrom(response) };
}

type CallOptions = {
  cookie?: string;
  body?: unknown;
  origin?: string | null;
  accept?: string | null;
  signal?: AbortSignal;
};

async function callCreateConversation({ cookie }: CallOptions = {}) {
  request.headers = new Headers(cookie ? { cookie } : {});
  return createConversation(
    new Request(`${APP_ORIGIN}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
}

async function callCreateMessage(conversationId: string, { cookie, body }: CallOptions = {}) {
  request.headers = new Headers(cookie ? { cookie } : {});
  return createMessage(
    new Request(`${APP_ORIGIN}/api/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
    { params: Promise.resolve({ id: conversationId }) },
  );
}

async function callReply(conversationId: string, options: CallOptions = {}) {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.origin !== null) headers.origin = options.origin ?? APP_ORIGIN;
  if (options.accept !== null) headers.accept = options.accept ?? "text/event-stream";
  if (options.body !== undefined) headers["content-type"] = "application/json";
  request.headers = new Headers(options.cookie ? { cookie: options.cookie } : {});

  return createReply(
    new Request(`${APP_ORIGIN}/api/conversations/${conversationId}/reply`, {
      method: "POST",
      headers,
      body: options.body === undefined ? "{}" : JSON.stringify(options.body),
      signal: options.signal,
    }),
    { params: Promise.resolve({ id: conversationId }) },
  );
}

/** Every event in a framed SSE body, in order. */
function parseEvents(raw: string) {
  return raw
    .split("\n\n")
    .filter((frame) => frame.trim() !== "")
    .map((frame) => {
      const lines = frame.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "";
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "";
      return { event, data: data === "" ? null : (JSON.parse(data) as unknown) };
    });
}

async function ownedConversationWithMessage(cookie: string, content = "Hello there") {
  const conversationResponse = await callCreateConversation({ cookie });
  expect(conversationResponse.status).toBe(201);
  const { conversation } = (await conversationResponse.json()) as {
    conversation: { id: string };
  };
  const messageResponse = await callCreateMessage(conversation.id, { cookie, body: { content } });
  expect(messageResponse.status).toBe(201);
  return conversation.id;
}

/** Rows of one conversation, for the no-partial-row / no-duplicate assertions. */
function messagesOf(conversationId: string) {
  return db.message.findMany({
    where: { conversationId },
    select: { conversationId: true, role: true, content: true, position: true },
    orderBy: { position: "asc" },
  });
}

/** Rows of this suite's conversations, for leak and duplicate checks. */
function testMessages() {
  return db.message.findMany({
    where: { conversation: { user: { email: { endsWith: `@${TEST_DOMAIN}` } } } },
    select: { conversationId: true, role: true, content: true, position: true },
    orderBy: { position: "asc" },
  });
}

beforeAll(async () => {
  if (!process.env.DATABASE_TEST_URL)
    throw new Error(
      "Set DATABASE_TEST_URL to a migrated disposable PostgreSQL database before running npm run test:db.",
    );
  vi.stubEnv("DATABASE_URL", process.env.DATABASE_TEST_URL);
  vi.stubEnv("APP_URL", APP_ORIGIN);
  vi.stubEnv("AUTH_SECRET", "reply-stream-test-secret-long-enough");
  vi.stubEnv("AUTH_TRUSTED_ORIGINS", "");
  auth = createAuth(async () => {});
  db = getDb();
  const stamp = Date.now();
  alice = await signUpAndGetSession(`alice-${stamp}@${TEST_DOMAIN}`, "Alice");
  bob = await signUpAndGetSession(`bob-${stamp}@${TEST_DOMAIN}`, "Bob");
});

beforeEach(() => {
  provider.reply = "A stored assistant reply.";
  provider.failure = null;
  provider.calls = [];
  provider.chunks = ["Streamed ", "assistant ", "answer"];
  provider.streamFailure = null;
  provider.chunkDelayMs = 10;
  provider.started = 0;
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email: { endsWith: `@${TEST_DOMAIN}` } } });
  expect(await testMessages()).toEqual([]);
  await db.$disconnect();
  vi.unstubAllEnvs();
});

describe("streaming reply responses", () => {
  it("streams deltas and finishes with exactly one done carrying the stored row", async () => {
    const conversationId = await ownedConversationWithMessage(alice.cookie);

    const response = await callReply(conversationId, { cookie: alice.cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-store");

    const raw = await response.text();
    const events = parseEvents(raw);

    expect(events.filter((event) => event.event === "delta")).toEqual([
      { event: "delta", data: { text: "Streamed " } },
      { event: "delta", data: { text: "assistant " } },
      { event: "delta", data: { text: "answer" } },
    ]);
    expect(events.filter((event) => event.event === "done")).toHaveLength(1);
    expect(events.filter((event) => event.event === "error")).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      event: "done",
      data: {
        message: {
          id: expect.any(String),
          role: "ASSISTANT",
          content: "Streamed assistant answer",
          position: 1,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      },
    });

    // The provider received the stored history only, and the persisted row is
    // exactly the accumulated text — nothing added, nothing partial.
    expect(provider.calls[0]).toEqual([{ role: "user", content: "Hello there" }]);
    expect(await messagesOf(conversationId)).toEqual([
      { conversationId, role: "USER", content: "Hello there", position: 0 },
      { conversationId, role: "ASSISTANT", content: "Streamed assistant answer", position: 1 },
    ]);
  });

  it("never forwards provider fields, prompts, or credentials in the events", async () => {
    const conversationId = await ownedConversationWithMessage(alice.cookie, "Secret question");

    const raw = await (await callReply(conversationId, { cookie: alice.cookie })).text();

    for (const forbidden of [
      "choices",
      "finish_reason",
      "system_fingerprint",
      "OpenRouter",
      "authorization",
      "Bearer",
      "openrouter-test-key-not-a-secret",
    ])
      expect(raw).not.toContain(forbidden);
    // The only text in the events is the assistant's own answer.
    expect(raw).not.toContain("model");
  });

  it("keeps the JSON contract for clients that do not ask for a stream", async () => {
    const conversationId = await ownedConversationWithMessage(alice.cookie);

    const response = await callReply(conversationId, { cookie: alice.cookie, accept: null });

    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { message: { role: string; content: string } };
    expect(body.message).toMatchObject({ role: "ASSISTANT", content: "A stored assistant reply." });
    expect(provider.calls).toEqual([[{ role: "user", content: "Hello there" }]]);
  });
});

describe("streaming failures", () => {
  it("reports an error and stores nothing when the provider fails after sending text", async () => {
    const conversationId = await ownedConversationWithMessage(alice.cookie);
    // Two deltas arrive before the provider stops without a completion marker.
    provider.chunks = ["Half an ", "answer"];
    provider.chunkDelayMs = 0;
    provider.streamFailure = new AiProviderError("malformed-response");

    const raw = await (await callReply(conversationId, { cookie: alice.cookie })).text();
    const events = parseEvents(raw);

    expect(events.filter((event) => event.event === "delta")).toHaveLength(2);
    expect(events.filter((event) => event.event === "done")).toEqual([]);
    expect(events.at(-1)).toEqual({
      event: "error",
      data: {
        code: "INTERNAL_ERROR",
        message: "The assistant reply could not be generated. Try again.",
      },
    });
    // No partial row: the user's message is the only stored row.
    expect(await messagesOf(conversationId)).toEqual([
      { conversationId, role: "USER", content: "Hello there", position: 0 },
    ]);
  });

  it("treats an empty stream as a failure and stores nothing", async () => {
    const conversationId = await ownedConversationWithMessage(alice.cookie);
    provider.chunks = [];
    provider.chunkDelayMs = 0;

    const events = parseEvents(
      await (await callReply(conversationId, { cookie: alice.cookie })).text(),
    );

    expect(events).toEqual([
      {
        event: "error",
        data: {
          code: "INTERNAL_ERROR",
          message: "The assistant reply could not be generated. Try again.",
        },
      },
    ]);
    expect(await messagesOf(conversationId)).toHaveLength(1);
  });

  it("reports a missing configuration without calling the provider", async () => {
    const conversationId = await ownedConversationWithMessage(alice.cookie);
    provider.streamFailure = new AiNotConfiguredError();

    const events = parseEvents(
      await (await callReply(conversationId, { cookie: alice.cookie })).text(),
    );

    expect(events.at(-1)).toEqual({
      event: "error",
      data: {
        code: "AI_NOT_CONFIGURED",
        message: "AI replies are not configured on this server.",
      },
    });
    expect(await messagesOf(conversationId)).toHaveLength(1);
  });

  it("ends a losing stream without a duplicate row when two clients race the same turn", async () => {
    const conversationId = await ownedConversationWithMessage(alice.cookie, "Race question");
    provider.chunkDelayMs = 5;

    const responses = await Promise.all([
      callReply(conversationId, { cookie: alice.cookie }),
      callReply(conversationId, { cookie: alice.cookie }),
    ]);
    const results = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        streaming: (response.headers.get("content-type") ?? "").includes("text/event-stream"),
        events: parseEvents(await response.text()),
      })),
    );

    // Exactly one stream finishes; the other is refused — either inside its own
    // stream (both passed the pre-stream check) or as an ordinary JSON 400 if it
    // arrived after the winner had already stored its row.
    const won = results.filter((result) => result.events.some((e) => e.event === "done"));
    const refused = results.filter(
      (result) =>
        result.events.some((e) => e.event === "error") ||
        (!result.streaming && result.status === 400),
    );
    expect(won).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const refusedStream = refused[0].events.find((event) => event.event === "error");
    if (refusedStream)
      expect(refusedStream.data).toEqual({
        code: "INVALID_REQUEST",
        message: "This message already has a reply.",
      });

    const stored = await messagesOf(conversationId);
    expect(stored.filter((row) => row.role === "ASSISTANT")).toHaveLength(1);
    expect(stored.map((row) => row.role)).toEqual(["USER", "ASSISTANT"]);
  });

  it("stores nothing when the client disconnects mid-stream", async () => {
    const conversationId = await ownedConversationWithMessage(alice.cookie, "Abandoned question");
    provider.chunks = ["Started ", "but ", "abandoned ", "before ", "the end"];
    provider.chunkDelayMs = 30;

    const controller = new AbortController();
    const response = await callReply(conversationId, {
      cookie: alice.cookie,
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let raw = "";

    // Read only until the first delta is visible, then behave like a closing tab.
    while (!raw.includes("event: delta")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      raw += decoder.decode(chunk.value, { stream: true });
    }
    expect(raw).toContain("event: delta");
    controller.abort();

    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      raw += decoder.decode(chunk.value, { stream: true });
    }

    expect(parseEvents(raw).some((event) => event.event === "done")).toBe(false);
    expect(await messagesOf(conversationId)).toEqual([
      { conversationId, role: "USER", content: "Abandoned question", position: 0 },
    ]);
  });
});

describe("streaming authorization", () => {
  it("answers 401 for an unauthenticated stream request and writes nothing", async () => {
    const conversationId = await ownedConversationWithMessage(alice.cookie);
    const before = await messagesOf(conversationId);

    const response = await callReply(conversationId, { accept: "text/event-stream" });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
    });
    expect(await messagesOf(conversationId)).toEqual(before);
  });

  it("answers the same 404 for a foreign conversation as for an unknown id", async () => {
    const conversationId = await ownedConversationWithMessage(alice.cookie);
    const before = await messagesOf(conversationId);

    const foreign = await callReply(conversationId, { cookie: bob.cookie });
    const unknown = await callReply("cmunknownconversationid000", { cookie: bob.cookie });

    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());
    expect(provider.started).toBe(0);
    expect(await messagesOf(conversationId)).toEqual(before);
  });

  it("keeps the conversation-id validation and the origin guard", async () => {
    const conversationId = await ownedConversationWithMessage(alice.cookie);

    const malformed = await callReply("not a valid id", { cookie: alice.cookie });
    expect(malformed.status).toBe(404);

    const crossOrigin = await callReply(conversationId, {
      cookie: alice.cookie,
      origin: "https://evil.example",
    });
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json()).toEqual({
      error: { code: "FORBIDDEN_ORIGIN", message: "This request came from an untrusted origin." },
    });
    expect(provider.started).toBe(0);
  });

  it("refuses client-supplied fields and a turn that already has a reply", async () => {
    const conversationId = await ownedConversationWithMessage(alice.cookie);

    const withFields = await callReply(conversationId, {
      cookie: alice.cookie,
      body: { content: "I choose the answer", role: "ASSISTANT" },
    });
    expect(withFields.status).toBe(400);
    expect(provider.started).toBe(0);

    // A finished stream leaves the turn answered: asking again is a 400 pre-stream,
    // and the stored rows are unchanged.
    await (await callReply(conversationId, { cookie: alice.cookie })).text();
    expect(await messagesOf(conversationId)).toHaveLength(2);

    const repeated = await callReply(conversationId, { cookie: alice.cookie });
    expect(repeated.status).toBe(400);
    expect(await repeated.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: "This message already has a reply." },
    });
    expect(await messagesOf(conversationId)).toHaveLength(2);
  });

  it("answers an empty conversation with a JSON 400 and no provider call", async () => {
    const conversationResponse = await callCreateConversation({ cookie: alice.cookie });
    const { conversation } = (await conversationResponse.json()) as {
      conversation: { id: string };
    };

    const response = await callReply(conversation.id, { cookie: alice.cookie });

    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: "Send a message before asking for a reply." },
    });
    expect(provider.started).toBe(0);
  });
});
