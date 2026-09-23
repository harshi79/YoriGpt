import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The route handlers read the incoming request headers from `next/headers`; this
// holder lets the tests present a real Better Auth session cookie (or none).
const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));

/**
 * The provider is mocked at the server boundary: these tests never reach the
 * network, so they stay deterministic and need no OpenRouter credentials. The
 * real adapter has its own unit tests, and the browser suite drives a local
 * OpenRouter-compatible stub server.
 */
const provider = vi.hoisted(() => ({
  reply: "A stored assistant reply.",
  failure: null as Error | null,
  calls: [] as { role: string; content: string }[][],
}));

vi.mock("../../src/server/ai/providers/openrouter", () => ({
  openRouterProvider: {
    name: "openrouter",
    generateReply: async (turns: { role: string; content: string }[]) => {
      provider.calls.push(turns);
      if (provider.failure) throw provider.failure;
      return provider.reply;
    },
    // The streaming path is covered by reply-stream.integration.ts; this suite
    // exercises the JSON endpoint, so the stream only has to exist.
    streamReply: async function* (turns: { role: string; content: string }[]) {
      provider.calls.push(turns);
      if (provider.failure) throw provider.failure;
      yield { type: "delta" as const, text: provider.reply };
    },
  },
}));

import { createAuth } from "../../src/server/auth/config";
import { getDb } from "../../src/server/db/client";
import { POST as createConversation } from "../../src/app/api/conversations/route";
import {
  GET as listMessages,
  POST as createMessage,
} from "../../src/app/api/conversations/[id]/messages/route";
import { POST as createReply } from "../../src/app/api/conversations/[id]/reply/route";
import { AiNotConfiguredError, AiProviderError } from "../../src/server/ai/errors";

/**
 * Real Better Auth sessions + real PostgreSQL, driving the real reply handler
 * with a stubbed provider. Ownership, ordering, and the "one reply per user
 * turn" guarantee are the point of this suite.
 */
const TEST_DOMAIN = "reply-test.invalid";
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

type CallOptions = { cookie?: string; body?: unknown; origin?: string | null };

async function callCreateConversation({ cookie, body, origin = APP_ORIGIN }: CallOptions = {}) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  request.headers = new Headers(headers);
  return createConversation(
    new Request(`${APP_ORIGIN}/api/conversations`, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function callCreateMessage(conversationId: string, { cookie, body }: CallOptions = {}) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  request.headers = new Headers(headers);
  return createMessage(
    new Request(`${APP_ORIGIN}/api/conversations/${conversationId}/messages`, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: conversationId }) },
  );
}

async function callReply(conversationId: string, { cookie, body, origin = APP_ORIGIN }: CallOptions = {}) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  request.headers = new Headers(headers);
  return createReply(
    new Request(`${APP_ORIGIN}/api/conversations/${conversationId}/reply`, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: conversationId }) },
  );
}

async function callListMessages(conversationId: string, { cookie }: CallOptions = {}) {
  request.headers = new Headers(cookie ? { cookie } : {});
  return listMessages(new Request(`${APP_ORIGIN}/api/conversations/${conversationId}/messages`), {
    params: Promise.resolve({ id: conversationId }),
  });
}

type StoredMessage = {
  id: string;
  role: string;
  content: string;
  position: number;
  createdAt: string;
  updatedAt: string;
};

async function ownedConversationWithMessage(cookie: string, content = "Hello there") {
  const conversationResponse = await callCreateConversation({ cookie });
  expect(conversationResponse.status).toBe(201);
  const { conversation } = (await conversationResponse.json()) as {
    conversation: { id: string };
  };
  const messageResponse = await callCreateMessage(conversation.id, { cookie, body: { content } });
  expect(messageResponse.status).toBe(201);
  const { message } = (await messageResponse.json()) as { message: StoredMessage };
  return { conversationId: conversation.id, message };
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
  vi.stubEnv("AUTH_SECRET", "reply-test-secret-value-long-enough");
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
});

afterAll(async () => {
  // Disposable database only: removing the users cascades to their data, so a run
  // leaves no application rows behind.
  await db.user.deleteMany({ where: { email: { endsWith: `@${TEST_DOMAIN}` } } });
  expect(await testMessages()).toEqual([]);
  await db.$disconnect();
  vi.unstubAllEnvs();
});

describe("unauthenticated reply requests", () => {
  it("answers 401 and writes nothing", async () => {
    const { conversationId } = await ownedConversationWithMessage(alice.cookie);
    const before = await testMessages();

    const response = await callReply(conversationId);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
    });
    expect(provider.calls).toEqual([]);
    expect(await testMessages()).toEqual(before);
  });
});

describe("another account's conversation", () => {
  it("answers exactly like an unknown conversation and writes nothing", async () => {
    const { conversationId } = await ownedConversationWithMessage(bob.cookie, "Bob's thought");

    const foreign = await callReply(conversationId, { cookie: alice.cookie });
    const unknown = await callReply("cmunknownconversationid00", { cookie: alice.cookie });

    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());

    // No provider call was made for a conversation Alice does not own, and Bob's
    // conversation still holds only his own message.
    expect(provider.calls).toEqual([]);
    const stored = await db.message.findMany({ where: { conversationId } });
    expect(stored.map((message) => message.role)).toEqual(["USER"]);
  });

  it("treats a malformed conversation id as not found", async () => {
    const response = await callReply("not a valid id", { cookie: alice.cookie });
    expect(response.status).toBe(404);
    expect(provider.calls).toEqual([]);
  });
});

describe("generating a reply", () => {
  it("stores one ASSISTANT message after the user's message", async () => {
    const { conversationId, message } = await ownedConversationWithMessage(alice.cookie, "Question?");

    const response = await callReply(conversationId, { cookie: alice.cookie });
    expect(response.status).toBe(201);
    const { message: reply } = (await response.json()) as { message: StoredMessage };

    expect(reply.role).toBe("ASSISTANT");
    expect(reply.content).toBe("A stored assistant reply.");
    expect(reply.position).toBe(message.position + 1);
    expect(reply.id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(Object.keys(reply).sort()).toEqual([
      "content",
      "createdAt",
      "id",
      "position",
      "role",
      "updatedAt",
    ]);

    // The provider saw the stored conversation only — no ids, owners, or positions.
    expect(provider.calls).toEqual([[{ role: "user", content: "Question?" }]]);

    const stored = await db.message.findMany({
      where: { conversationId },
      orderBy: { position: "asc" },
      select: { role: true, content: true, position: true, conversationId: true },
    });
    expect(stored).toEqual([
      { role: "USER", content: "Question?", position: 0, conversationId },
      { role: "ASSISTANT", content: "A stored assistant reply.", position: 1, conversationId },
    ]);
  });

  it("returns both messages when the conversation is read again", async () => {
    const { conversationId } = await ownedConversationWithMessage(alice.cookie, "Reload me");
    expect((await callReply(conversationId, { cookie: alice.cookie })).status).toBe(201);

    const response = await callListMessages(conversationId, { cookie: alice.cookie });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { messages: StoredMessage[] };
    expect(body.messages.map(({ role, content, position }) => ({ role, content, position }))).toEqual([
      { role: "USER", content: "Reload me", position: 0 },
      { role: "ASSISTANT", content: "A stored assistant reply.", position: 1 },
    ]);
  });

  it("orders a multi-turn exchange user, assistant, user, assistant", async () => {
    const { conversationId } = await ownedConversationWithMessage(alice.cookie, "First question");
    expect((await callReply(conversationId, { cookie: alice.cookie })).status).toBe(201);

    expect((await callCreateMessage(conversationId, { cookie: alice.cookie, body: { content: "Second question" } })).status).toBe(201);
    expect((await callReply(conversationId, { cookie: alice.cookie })).status).toBe(201);

    const body = (await (await callListMessages(conversationId, { cookie: alice.cookie })).json()) as {
      messages: StoredMessage[];
    };
    expect(body.messages.map((message) => message.role)).toEqual([
      "USER",
      "ASSISTANT",
      "USER",
      "ASSISTANT",
    ]);
    expect(body.messages.map((message) => message.position)).toEqual([0, 1, 2, 3]);
    // The second request carried the whole stored history.
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "A stored assistant reply." },
      { role: "user", content: "Second question" },
    ]);
  });

  it("refreshes the conversation's activity timestamp", async () => {
    const { conversationId } = await ownedConversationWithMessage(alice.cookie, "Activity");
    const before = await db.conversation.findUniqueOrThrow({ where: { id: conversationId } });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await callReply(conversationId, { cookie: alice.cookie })).status).toBe(201);

    const after = await db.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());

    // The conversation timestamp is written by the application while the message
    // timestamp comes from PostgreSQL's clock, so they are the same moment but not
    // necessarily the same millisecond.
    const assistant = await db.message.findFirstOrThrow({
      where: { conversationId, role: "ASSISTANT" },
    });
    expect(Math.abs(after.updatedAt.getTime() - assistant.createdAt.getTime())).toBeLessThan(1_000);
  });
});

describe("refusing invalid generation", () => {
  it("creates no assistant row when the provider fails", async () => {
    const { conversationId, message } = await ownedConversationWithMessage(alice.cookie, "Keeps me");
    provider.failure = new AiProviderError("http-error", { status: 502 });

    const response = await callReply(conversationId, { cookie: alice.cookie });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "The assistant reply could not be generated. Try again.",
      },
    });
    const stored = await db.message.findMany({ where: { conversationId } });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: message.id, role: "USER", content: "Keeps me" });
  });

  it("reports an unconfigured provider without writing a row", async () => {
    const { conversationId } = await ownedConversationWithMessage(alice.cookie, "No provider");
    provider.failure = new AiNotConfiguredError();

    const response = await callReply(conversationId, { cookie: alice.cookie });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "AI_NOT_CONFIGURED",
        message: "AI replies are not configured on this server.",
      },
    });
    expect(await db.message.count({ where: { conversationId } })).toBe(1);
  });

  it("never stores an empty assistant answer", async () => {
    const { conversationId } = await ownedConversationWithMessage(alice.cookie, "Empty answer");
    provider.reply = "   \n ";

    expect((await callReply(conversationId, { cookie: alice.cookie })).status).toBe(500);
    expect(await db.message.count({ where: { conversationId } })).toBe(1);
  });

  it("refuses a conversation with nothing to reply to", async () => {
    const response = await callCreateConversation({ cookie: alice.cookie });
    const { conversation } = (await response.json()) as { conversation: { id: string } };

    const reply = await callReply(conversation.id, { cookie: alice.cookie });
    expect(reply.status).toBe(400);
    expect(await reply.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: "Send a message before asking for a reply." },
    });
    expect(provider.calls).toEqual([]);
  });

  it("refuses client-supplied ownership, role, content, or position", async () => {
    const { conversationId } = await ownedConversationWithMessage(alice.cookie, "Client fields");
    const before = await testMessages();

    for (const body of [
      { userId: bob.id },
      { role: "ASSISTANT" },
      { content: "Injected answer" },
      { position: 5 },
      { model: "some/other-model" },
    ]) {
      const response = await callReply(conversationId, { cookie: alice.cookie, body });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    }

    expect(provider.calls).toEqual([]);
    expect(await testMessages()).toEqual(before);
  });

  it("refuses a cross-origin generation request", async () => {
    const { conversationId } = await ownedConversationWithMessage(alice.cookie, "Cross-site");
    const response = await callReply(conversationId, {
      cookie: alice.cookie,
      origin: "https://evil.example.com",
    });

    expect(response.status).toBe(403);
    expect(provider.calls).toEqual([]);
    expect(await db.message.count({ where: { conversationId } })).toBe(1);
  });
});

describe("one reply per user turn", () => {
  it("answers the same turn only once, even when the request is repeated", async () => {
    const { conversationId } = await ownedConversationWithMessage(alice.cookie, "Only once");

    expect((await callReply(conversationId, { cookie: alice.cookie })).status).toBe(201);
    const repeated = await callReply(conversationId, { cookie: alice.cookie });

    expect(repeated.status).toBe(400);
    expect(await repeated.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: "This message already has a reply." },
    });
    expect(await db.message.count({ where: { conversationId, role: "ASSISTANT" } })).toBe(1);
  });

  it("keeps a single assistant row when two requests race", async () => {
    const { conversationId } = await ownedConversationWithMessage(alice.cookie, "Racing turn");

    const responses = await Promise.all([
      callReply(conversationId, { cookie: alice.cookie }),
      callReply(conversationId, { cookie: alice.cookie }),
      callReply(conversationId, { cookie: alice.cookie }),
    ]);
    const statuses = responses.map((response) => response.status).sort();

    // One winner; the others are refused instead of storing duplicate replies.
    expect(statuses).toEqual([201, 400, 400]);
    const stored = await db.message.findMany({
      where: { conversationId },
      orderBy: { position: "asc" },
      select: { role: true, position: true },
    });
    expect(stored).toEqual([
      { role: "USER", position: 0 },
      { role: "ASSISTANT", position: 1 },
    ]);
  });

  it("leaves no duplicate positions anywhere in the suite", async () => {
    const duplicates = await db.message.groupBy({
      by: ["conversationId", "position"],
      where: { conversation: { user: { email: { endsWith: `@${TEST_DOMAIN}` } } } },
      _count: { position: true },
      having: { position: { _count: { gt: 1 } } },
    });
    expect(duplicates).toEqual([]);

    // Only the two expected roles exist, and no message was invented for a
    // conversation that never received one.
    const roles = await db.message.groupBy({
      by: ["role"],
      where: { conversation: { user: { email: { endsWith: `@${TEST_DOMAIN}` } } } },
      _count: { role: true },
    });
    expect(roles.map((row) => row.role).sort()).toEqual(["ASSISTANT", "USER"]);
  });
});
