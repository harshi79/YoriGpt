import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The route handlers read the incoming request headers from `next/headers`; this
// holder lets the tests present a real Better Auth session cookie (or none).
const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));

import { createAuth } from "../../src/server/auth/config";
import { getDb } from "../../src/server/db/client";
import { GET as listConversations, POST as createConversation } from "../../src/app/api/conversations/route";
import {
  DELETE as deleteConversation,
  GET as readConversation,
} from "../../src/app/api/conversations/[id]/route";

/**
 * Real Better Auth sessions + real PostgreSQL, driving the real route handlers.
 * Authorization is the point of this suite: every case checks what one account
 * can and cannot do with another account's data.
 */
const TEST_DOMAIN = "conversation-test.invalid";
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
  id?: string;
};

async function callList({ cookie }: CallOptions = {}) {
  request.headers = new Headers(cookie ? { cookie } : {});
  return listConversations();
}

async function callCreate({ cookie, body, origin = APP_ORIGIN }: CallOptions = {}) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (origin) headers.origin = origin;
  request.headers = new Headers(headers);
  return createConversation(
    new Request(`${APP_ORIGIN}/api/conversations`, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function callRead(id: string, { cookie, origin = APP_ORIGIN }: CallOptions = {}) {
  const headers: Record<string, string> = origin ? { origin } : {};
  if (cookie) headers.cookie = cookie;
  request.headers = new Headers(headers);
  return readConversation(new Request(`${APP_ORIGIN}/api/conversations/${id}`, { headers }), {
    params: Promise.resolve({ id }),
  });
}

async function callDelete(id: string, { cookie, origin = APP_ORIGIN }: CallOptions = {}) {
  const headers: Record<string, string> = origin ? { origin } : {};
  if (cookie) headers.cookie = cookie;
  request.headers = new Headers(headers);
  return deleteConversation(
    // The origin/cookie headers must be on the Request itself: the route handler
    // reads the incoming origin from it, while the session cookie is resolved
    // through the mocked `next/headers` holder.
    new Request(`${APP_ORIGIN}/api/conversations/${id}`, { method: "DELETE", headers }),
    { params: Promise.resolve({ id }) },
  );
}

async function createOwnedConversation(cookie: string, title?: string) {
  const response = await callCreate({ cookie, body: title ? { title } : undefined });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { conversation: { id: string; title: string } };
  return body.conversation;
}

beforeAll(async () => {
  if (!process.env.DATABASE_TEST_URL)
    throw new Error(
      "Set DATABASE_TEST_URL to a migrated disposable PostgreSQL database before running npm run test:db.",
    );
  vi.stubEnv("DATABASE_URL", process.env.DATABASE_TEST_URL);
  vi.stubEnv("APP_URL", APP_ORIGIN);
  vi.stubEnv("AUTH_SECRET", "conversation-test-secret-value-long-enough");
  vi.stubEnv("AUTH_TRUSTED_ORIGINS", "");
  auth = createAuth(async () => {});
  db = getDb();
  const stamp = Date.now();
  alice = await signUpAndGetSession(`alice-${stamp}@${TEST_DOMAIN}`, "Alice");
  bob = await signUpAndGetSession(`bob-${stamp}@${TEST_DOMAIN}`, "Bob");
});

afterAll(async () => {
  // Disposable database only: remove this suite's users; conversations cascade.
  const users = await db.user.findMany({
    where: { email: { endsWith: `@${TEST_DOMAIN}` } },
    select: { id: true },
  });
  await db.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  await db.$disconnect();
  vi.unstubAllEnvs();
});

describe("unauthenticated access", () => {
  it("rejects listing and creating without a session", async () => {
    const before = await db.conversation.count({ where: { user: { email: { endsWith: `@${TEST_DOMAIN}` } } } });

    const list = await callList();
    expect(list.status).toBe(401);
    expect(await list.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
    });

    const create = await callCreate({ body: { title: "Not allowed" } });
    expect(create.status).toBe(401);

    const after = await db.conversation.count({ where: { user: { email: { endsWith: `@${TEST_DOMAIN}` } } } });
    expect(after).toBe(before);
  });

  it("rejects reading and deleting without a session", async () => {
    const owned = await createOwnedConversation(alice.cookie, "Alice private");

    expect((await callRead(owned.id)).status).toBe(401);
    expect((await callDelete(owned.id)).status).toBe(401);
    // The conversation is still there: an anonymous delete changes nothing.
    expect(await db.conversation.findUnique({ where: { id: owned.id } })).not.toBeNull();
  });
});

describe("creating conversations", () => {
  it("stores an owned conversation with a server-generated id and default title", async () => {
    const response = await callCreate({ cookie: alice.cookie });
    expect(response.status).toBe(201);
    const { conversation } = (await response.json()) as {
      conversation: Record<string, string>;
    };

    expect(conversation.title).toBe("New chat");
    expect(conversation.id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    // Only the fields the UI needs; no owner or internal columns are exposed.
    expect(Object.keys(conversation).sort()).toEqual(["createdAt", "id", "title", "updatedAt"]);

    const stored = await db.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(stored.userId).toBe(alice.id);
    expect(stored.createdAt.toISOString()).toBe(conversation.createdAt);
    expect(stored.updatedAt.toISOString()).toBe(conversation.updatedAt);
  });

  it("never lets the client choose the owner or timestamps", async () => {
    const bobBefore = await db.conversation.count({ where: { userId: bob.id } });

    const response = await callCreate({
      cookie: alice.cookie,
      body: { userId: bob.id, createdAt: "2000-01-01T00:00:00.000Z" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });

    // Nothing was written for either account.
    expect(await db.conversation.count({ where: { userId: bob.id } })).toBe(bobBefore);
    expect(await db.conversation.count({ where: { userId: alice.id, createdAt: new Date("2000-01-01") } })).toBe(0);
  });

  it("refuses a creation request from another origin", async () => {
    const before = await db.conversation.count({ where: { userId: alice.id } });
    const response = await callCreate({
      cookie: alice.cookie,
      origin: "https://evil.example.com",
      body: { title: "Cross-site" },
    });
    expect(response.status).toBe(403);
    expect(await db.conversation.count({ where: { userId: alice.id } })).toBe(before);
  });
});

describe("listing conversations", () => {
  it("returns only the signed-in user's conversations, newest activity first", async () => {
    const aliceOne = await createOwnedConversation(alice.cookie, "Alice one");
    const aliceTwo = await createOwnedConversation(alice.cookie, "Alice two");
    await createOwnedConversation(bob.cookie, "Bob only");

    // Equal timestamps must still return a stable order (id descending). The tie is
    // dated from now rather than a fixed calendar time, so it stays in the past
    // relative to these rows however late in the day the suite runs.
    const tie = new Date();
    await db.conversation.updateMany({
      where: { id: { in: [aliceOne.id, aliceTwo.id] } },
      data: { updatedAt: tie },
    });
    const [expectedFirst, expectedSecond] = [aliceOne.id, aliceTwo.id].sort().reverse();

    const response = await callList({ cookie: alice.cookie });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      conversations: { id: string; title: string }[];
      truncated: boolean;
    };

    expect(body.truncated).toBe(false);
    expect(body.conversations.map((conversation) => conversation.title)).not.toContain("Bob only");
    // The two tied rows keep their relative order whichever other conversations the
    // account already has.
    const order = body.conversations.map((conversation) => conversation.id);
    expect(order).toEqual(expect.arrayContaining([expectedFirst, expectedSecond]));
    expect(order.indexOf(expectedFirst)).toBeLessThan(order.indexOf(expectedSecond));
    for (const conversation of body.conversations) {
      const stored = await db.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      expect(stored.userId).toBe(alice.id);
    }
  });

  it("returns an empty list for an account without conversations", async () => {
    const fresh = await signUpAndGetSession(`fresh-${Date.now()}@${TEST_DOMAIN}`, "Fresh");
    const response = await callList({ cookie: fresh.cookie });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ conversations: [], truncated: false });
  });
});

describe("reading one conversation", () => {
  it("returns an owned conversation", async () => {
    const owned = await createOwnedConversation(alice.cookie, "Alice readable");
    const response = await callRead(owned.id, { cookie: alice.cookie });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ conversation: { id: owned.id, title: "Alice readable" } });
  });

  it("hides another user's conversation behind the same 404 as an unknown id", async () => {
    const bobs = await createOwnedConversation(bob.cookie, "Bob secret");
    const foreign = await callRead(bobs.id, { cookie: alice.cookie });
    const unknown = await callRead("cmunknownconversationid00", { cookie: alice.cookie });

    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());
    expect(await db.conversation.findUnique({ where: { id: bobs.id } })).not.toBeNull();
  });

  it("treats a malformed id as not found", async () => {
    const response = await callRead("not a valid id", { cookie: alice.cookie });
    expect(response.status).toBe(404);
  });
});

describe("deleting conversations", () => {
  it("deletes an owned conversation and is idempotent afterwards", async () => {
    const owned = await createOwnedConversation(alice.cookie, "Alice to delete");

    const response = await callDelete(owned.id, { cookie: alice.cookie });
    expect(response.status).toBe(204);
    expect(await db.conversation.findUnique({ where: { id: owned.id } })).toBeNull();

    const again = await callDelete(owned.id, { cookie: alice.cookie });
    expect(again.status).toBe(404);
  });

  it("cannot delete another user's conversation", async () => {
    const bobs = await createOwnedConversation(bob.cookie, "Bob keeps this");

    const response = await callDelete(bobs.id, { cookie: alice.cookie });
    expect(response.status).toBe(404);
    expect(await db.conversation.findUnique({ where: { id: bobs.id } })).not.toBeNull();

    // Bob can still delete his own.
    expect((await callDelete(bobs.id, { cookie: bob.cookie })).status).toBe(204);
  });

  it("refuses a delete request from another origin", async () => {
    const owned = await createOwnedConversation(alice.cookie, "Alice keeps this");
    const response = await callDelete(owned.id, { cookie: alice.cookie, origin: "https://evil.example.com" });
    expect(response.status).toBe(403);
    expect(await db.conversation.findUnique({ where: { id: owned.id } })).not.toBeNull();
  });
});
