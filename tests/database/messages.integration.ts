import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The route handlers read the incoming request headers from `next/headers`; this
// holder lets the tests present a real Better Auth session cookie (or none).
const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));

import { createAuth } from "../../src/server/auth/config";
import { getDb } from "../../src/server/db/client";
import { POST as createConversation } from "../../src/app/api/conversations/route";
import { GET as readConversation } from "../../src/app/api/conversations/[id]/route";
import {
  GET as listMessages,
  POST as createMessage,
} from "../../src/app/api/conversations/[id]/messages/route";

/**
 * Real Better Auth sessions + real PostgreSQL, driving the real message route
 * handlers. Authorization and position assignment are the point of this suite:
 * every case checks what one account can and cannot do with another account's
 * conversation, and that a failed write leaves no rows behind.
 */
const TEST_DOMAIN = "message-test.invalid";
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

async function callCreateMessage(
  conversationId: string,
  { cookie, body, origin = APP_ORIGIN }: CallOptions & { rawBody?: boolean } = {},
) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
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

async function callListMessages(conversationId: string, { cookie }: CallOptions = {}) {
  request.headers = new Headers(cookie ? { cookie } : {});
  return listMessages(new Request(`${APP_ORIGIN}/api/conversations/${conversationId}/messages`), {
    params: Promise.resolve({ id: conversationId }),
  });
}

async function callReadConversation(conversationId: string, { cookie }: CallOptions = {}) {
  request.headers = new Headers(cookie ? { cookie } : {});
  return readConversation(new Request(`${APP_ORIGIN}/api/conversations/${conversationId}`), {
    params: Promise.resolve({ id: conversationId }),
  });
}

async function createOwnedConversation(cookie: string) {
  const response = await callCreateConversation({ cookie });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { conversation: { id: string } };
  return body.conversation;
}

type StoredMessage = {
  id: string;
  role: string;
  content: string;
  position: number;
  createdAt: string;
  updatedAt: string;
};

async function createMessageAndRead(conversationId: string, cookie: string, content: string) {
  const response = await callCreateMessage(conversationId, { cookie, body: { content } });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { message: StoredMessage };
  return body.message;
}

/** Messages of the suite's conversations, for leak and duplicate checks. */
function testMessages() {
  return db.message.findMany({
    where: { conversation: { user: { email: { endsWith: `@${TEST_DOMAIN}` } } } },
    select: { conversationId: true, position: true, role: true, content: true },
  });
}

beforeAll(async () => {
  if (!process.env.DATABASE_TEST_URL)
    throw new Error(
      "Set DATABASE_TEST_URL to a migrated disposable PostgreSQL database before running npm run test:db.",
    );
  vi.stubEnv("DATABASE_URL", process.env.DATABASE_TEST_URL);
  vi.stubEnv("APP_URL", APP_ORIGIN);
  vi.stubEnv("AUTH_SECRET", "message-test-secret-value-long-enough");
  vi.stubEnv("AUTH_TRUSTED_ORIGINS", "");
  auth = createAuth(async () => {});
  db = getDb();
  const stamp = Date.now();
  alice = await signUpAndGetSession(`alice-${stamp}@${TEST_DOMAIN}`, "Alice");
  bob = await signUpAndGetSession(`bob-${stamp}@${TEST_DOMAIN}`, "Bob");
});

afterAll(async () => {
  // Disposable database only: remove this suite's users; conversations and
  // messages cascade, so a run leaves no application rows behind.
  const users = await db.user.findMany({
    where: { email: { endsWith: `@${TEST_DOMAIN}` } },
    select: { id: true },
  });
  await db.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  expect(
    await db.message.count({ where: { conversation: { user: { email: { endsWith: `@${TEST_DOMAIN}` } } } } }),
  ).toBe(0);
  await db.$disconnect();
  vi.unstubAllEnvs();
});

describe("unauthenticated message access", () => {
  it("rejects reading and creating messages without a session, and writes nothing", async () => {
    const owned = await createOwnedConversation(alice.cookie);
    const before = await testMessages();

    const list = await callListMessages(owned.id);
    expect(list.status).toBe(401);
    expect(await list.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
    });

    const create = await callCreateMessage(owned.id, { body: { content: "Anonymous" } });
    expect(create.status).toBe(401);
    expect(await testMessages()).toEqual(before);
  });
});

describe("creating a user message", () => {
  it("stores an owner-scoped message with server-derived fields", async () => {
    const owned = await createOwnedConversation(alice.cookie);
    const message = await createMessageAndRead(owned.id, alice.cookie, "  Hello there  ");

    expect(message.content).toBe("Hello there");
    expect(message.role).toBe("USER");
    expect(message.position).toBe(0);
    expect(message.id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    // Only the fields the UI needs; no owner or conversation columns.
    expect(Object.keys(message).sort()).toEqual([
      "content",
      "createdAt",
      "id",
      "position",
      "role",
      "updatedAt",
    ]);

    const stored = await db.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(stored.conversationId).toBe(owned.id);
    expect(stored.role).toBe("USER");
    expect(stored.createdAt.toISOString()).toBe(message.createdAt);
  });

  it("assigns the next position and keeps the conversation's activity fresh", async () => {
    const owned = await createOwnedConversation(alice.cookie);
    const other = await createOwnedConversation(alice.cookie);
    const before = await db.conversation.findUniqueOrThrow({ where: { id: owned.id } });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const first = await createMessageAndRead(owned.id, alice.cookie, "First");
    const second = await createMessageAndRead(owned.id, alice.cookie, "Second");
    expect([first.position, second.position]).toEqual([0, 1]);

    const after = await db.conversation.findUniqueOrThrow({ where: { id: owned.id } });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());

    // The sidebar is ordered by conversation activity, so the conversation that
    // received a message moves ahead of the older, untouched one.
    const listed = await (await callCreateConversation({ cookie: alice.cookie })).json();
    void listed;
    const sidebar = await db.conversation.findMany({
      where: { userId: alice.id, id: { in: [owned.id, other.id] } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    expect(sidebar[0].id).toBe(owned.id);
  });

  it("never lets the client choose the owner, role, position, id, or timestamps", async () => {
    const owned = await createOwnedConversation(alice.cookie);
    const before = await testMessages();

    const attempts: Record<string, unknown>[] = [
      { content: "Mine", userId: bob.id },
      { content: "Mine", role: "ASSISTANT" },
      { content: "Mine", position: 42 },
      { content: "Mine", id: "cmclientchosenid00000000" },
      { content: "Mine", createdAt: "2000-01-01T00:00:00.000Z" },
      { content: "Mine", updatedAt: "2000-01-01T00:00:00.000Z" },
      { content: "Mine", conversationId: "cmanotherconversationid" },
    ];

    for (const body of attempts) {
      const response = await callCreateMessage(owned.id, { cookie: alice.cookie, body });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    }

    // Nothing was written anywhere: no message, no owner invented, no assistant row.
    expect(await testMessages()).toEqual(before);
    expect(await db.message.count({ where: { role: { not: "USER" } } })).toBe(0);
  });

  it("refuses invalid content and a cross-origin write without creating a row", async () => {
    const owned = await createOwnedConversation(alice.cookie);
    const before = await testMessages();

    for (const body of [undefined, {}, { content: "" }, { content: "   " }, { content: 5 }, { content: "x".repeat(4001) }]) {
      const response = await callCreateMessage(owned.id, { cookie: alice.cookie, body });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }

    const crossSite = await callCreateMessage(owned.id, {
      cookie: alice.cookie,
      origin: "https://evil.example.com",
      body: { content: "Cross-site" },
    });
    expect(crossSite.status).toBe(403);

    expect(await testMessages()).toEqual(before);
  });

  it("treats a malformed conversation id as not found", async () => {
    const response = await callCreateMessage("not a valid id", {
      cookie: alice.cookie,
      body: { content: "Hello" },
    });
    expect(response.status).toBe(404);
  });
});

describe("listing messages", () => {
  it("returns only the conversation's messages in ascending position order", async () => {
    const owned = await createOwnedConversation(alice.cookie);
    const other = await createOwnedConversation(alice.cookie);
    await createMessageAndRead(other.id, alice.cookie, "Another conversation");

    const created = [
      await createMessageAndRead(owned.id, alice.cookie, "One"),
      await createMessageAndRead(owned.id, alice.cookie, "Two"),
      await createMessageAndRead(owned.id, alice.cookie, "Three"),
    ];

    const response = await callListMessages(owned.id, { cookie: alice.cookie });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { messages: StoredMessage[]; truncated: boolean };

    expect(body.truncated).toBe(false);
    expect(body.messages.map((message) => message.content)).toEqual(["One", "Two", "Three"]);
    expect(body.messages.map((message) => message.position)).toEqual([0, 1, 2]);
    expect(body.messages.map((message) => message.id)).toEqual(created.map((message) => message.id));
    expect(body.messages.every((message) => message.role === "USER")).toBe(true);

    // A conversation without messages is an empty list, not an error.
    const empty = await callListMessages((await createOwnedConversation(alice.cookie)).id, {
      cookie: alice.cookie,
    });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ messages: [], truncated: false });
  });

  it("assigns unique positions under concurrent writers", async () => {
    const owned = await createOwnedConversation(alice.cookie);
    const contents = ["Concurrent one", "Concurrent two", "Concurrent three", "Concurrent four"];

    const responses = await Promise.all(
      contents.map((content) => callCreateMessage(owned.id, { cookie: alice.cookie, body: { content } })),
    );
    for (const response of responses) expect(response.status).toBe(201);

    const body = (await (await callListMessages(owned.id, { cookie: alice.cookie })).json()) as {
      messages: StoredMessage[];
    };
    const positions = body.messages.map((message) => message.position).sort((a, b) => a - b);
    // Every message kept its own slot: no duplicates, no gaps.
    expect(positions).toEqual([0, 1, 2, 3]);
    expect(body.messages.map((message) => message.content).sort()).toEqual([...contents].sort());

    const duplicates = await db.message.groupBy({
      by: ["conversationId", "position"],
      where: { conversationId: owned.id },
      _count: { position: true },
      having: { position: { _count: { gt: 1 } } },
    });
    expect(duplicates).toEqual([]);
  });
});

describe("another account's conversation", () => {
  it("answers reading, listing, and writing with the same 404 as an unknown id", async () => {
    const bobs = await createOwnedConversation(bob.cookie);
    await createMessageAndRead(bobs.id, bob.cookie, "Bob's private thought");

    const foreignList = await callListMessages(bobs.id, { cookie: alice.cookie });
    const unknownList = await callListMessages("cmunknownconversationid00", { cookie: alice.cookie });
    expect(foreignList.status).toBe(404);
    const foreignListBody = await foreignList.json();
    expect(foreignListBody).toEqual(await unknownList.json());

    const foreignWrite = await callCreateMessage(bobs.id, {
      cookie: alice.cookie,
      body: { content: "Injected" },
    });
    const unknownWrite = await callCreateMessage("cmunknownconversationid00", {
      cookie: alice.cookie,
      body: { content: "Injected" },
    });
    expect(foreignWrite.status).toBe(404);
    const foreignWriteBody = await foreignWrite.json();
    expect(foreignWriteBody).toEqual(await unknownWrite.json());

    // Unknown and foreign ids answer exactly like the conversation route does.
    const conversationRoute = await callReadConversation(bobs.id, { cookie: alice.cookie });
    expect(conversationRoute.status).toBe(404);
    expect(await conversationRoute.json()).toEqual(foreignWriteBody);
    expect(foreignListBody).toEqual(foreignWriteBody);

    // Bob's message is untouched and still his.
    const bobsMessages = await callListMessages(bobs.id, { cookie: bob.cookie });
    const stored = (await bobsMessages.json()) as { messages: StoredMessage[] };
    expect(stored.messages.map((message) => message.content)).toEqual(["Bob's private thought"]);
    expect(await db.message.count({ where: { content: "Injected" } })).toBe(0);
  });
});
