import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The route handlers read the incoming request headers from `next/headers`; this
// holder lets the tests present a real Better Auth session cookie (or none).
const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));

import { createAuth } from "../../src/server/auth/config";
import { getDb } from "../../src/server/db/client";
import { GET, PUT } from "../../src/app/api/models/route";
import { DEFAULT_MODEL_KEY } from "../../src/server/ai/models/catalog";

/**
 * Real Better Auth sessions + real PostgreSQL, driving the real model preference
 * route: the stored row, the per-user isolation, and the catalog/foreign-key
 * behavior of `user_preferences.preferredModelId` are all checked against the
 * database rather than a fake. The seed migration supplies the `ai_models` rows.
 */
const TEST_DOMAIN = "model-test.invalid";
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

async function callList(cookie?: string) {
  request.headers = new Headers(cookie ? { cookie } : {});
  return GET();
}

async function callUpdate(body: string, options: { cookie?: string; origin?: string | null } = {}) {
  const { cookie, origin = APP_ORIGIN } = options;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  request.headers = new Headers(headers);
  return PUT(
    new Request(`${APP_ORIGIN}/api/models`, { method: "PUT", headers, body }),
  );
}

beforeAll(async () => {
  if (!process.env.DATABASE_TEST_URL)
    throw new Error(
      "Set DATABASE_TEST_URL to a migrated disposable PostgreSQL database before running npm run test:db.",
    );
  vi.stubEnv("DATABASE_URL", process.env.DATABASE_TEST_URL);
  vi.stubEnv("APP_URL", APP_ORIGIN);
  vi.stubEnv("AUTH_SECRET", "model-preference-test-secret-value-long-enough");
  vi.stubEnv("AUTH_TRUSTED_ORIGINS", "");
  auth = createAuth(async () => {});
  db = getDb();
  const stamp = Date.now();
  alice = await signUpAndGetSession(`alice-${stamp}@${TEST_DOMAIN}`, "Alice");
  bob = await signUpAndGetSession(`bob-${stamp}@${TEST_DOMAIN}`, "Bob");
});

afterAll(async () => {
  // Disposable database only: remove this suite's users; their preferences cascade.
  const users = await db.user.findMany({
    where: { email: { endsWith: `@${TEST_DOMAIN}` } },
    select: { id: true },
  });
  await db.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  await db.$disconnect();
  vi.unstubAllEnvs();
});

describe("the seeded catalog rows", () => {
  it("exist for every active catalog model, and for the retired one", async () => {
    const rows = await db.aiModel.findMany({ orderBy: { id: "asc" } });
    expect(rows.map((row) => row.id)).toContain(DEFAULT_MODEL_KEY);
    for (const row of rows) {
      expect(row.provider).toBe("OPENROUTER");
      expect(row.modelIdentifier).toMatch(/^[a-z0-9-]+\/[A-Za-z0-9.:_-]+$/);
      expect(row.displayName.trim().length).toBeGreaterThan(0);
    }
  });

  it("refuses a preference that points at no model at all", async () => {
    // The foreign key is the last line of defense: even a bug that skipped the
    // catalog check could not store an arbitrary identifier.
    await expect(
      db.userPreferences.create({
        data: { userId: alice.id, preferredModelId: "not-a-model" },
      }),
    ).rejects.toThrow();
  });
});

describe("reading a preference", () => {
  it("needs a session", async () => {
    expect((await callList()).status).toBe(401);
  });

  it("reports the catalog default before anything is chosen", async () => {
    await db.userPreferences.deleteMany({ where: { userId: { in: [alice.id, bob.id] } } });

    const response = await callList(alice.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { selectedModelKey: string; models: unknown[] };
    expect(body.selectedModelKey).toBe(DEFAULT_MODEL_KEY);
    expect(body.models.length).toBeGreaterThan(0);
  });
});

describe("a stored preference that no longer resolves", () => {
  it("is reported as the model a reply would use, and is never offered", async () => {
    // Written directly, as an older server version (or a hand-edited row) could have.
    await db.userPreferences.upsert({
      where: { userId: alice.id },
      create: { userId: alice.id, preferredModelId: "llama-3.1-70b" },
      update: { preferredModelId: "llama-3.1-70b" },
    });

    const response = await callList(alice.cookie);
    const body = (await response.json()) as {
      selectedModelKey: string;
      models: { key: string }[];
    };
    expect(body.selectedModelKey).toBe(DEFAULT_MODEL_KEY);
    expect(body.models.map((model) => model.key)).not.toContain("llama-3.1-70b");

    // The row itself is left alone: nothing rewrites a stored preference behind the
    // user's back, it is simply not used.
    const row = await db.userPreferences.findUniqueOrThrow({ where: { userId: alice.id } });
    expect(row.preferredModelId).toBe("llama-3.1-70b");
  });
});

describe("changing a preference", () => {
  it("stores the choice for that user only", async () => {
    expect((await callUpdate(JSON.stringify({ modelKey: "gpt-4o" }), { cookie: alice.cookie })).status).toBe(200);
    expect(
      (await callUpdate(JSON.stringify({ modelKey: "claude-3.5-haiku" }), { cookie: bob.cookie }))
        .status,
    ).toBe(200);

    const rows = await db.userPreferences.findMany({
      where: { userId: { in: [alice.id, bob.id] } },
      select: { userId: true, preferredModelId: true },
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        { userId: alice.id, preferredModelId: "gpt-4o" },
        { userId: bob.id, preferredModelId: "claude-3.5-haiku" },
      ]),
    );
    expect(rows).toHaveLength(2);

    const aliceRead = (await (await callList(alice.cookie)).json()) as { selectedModelKey: string };
    const bobRead = (await (await callList(bob.cookie)).json()) as { selectedModelKey: string };
    expect(aliceRead.selectedModelKey).toBe("gpt-4o");
    expect(bobRead.selectedModelKey).toBe("claude-3.5-haiku");
  });

  it("updates the existing row instead of adding another", async () => {
    await callUpdate(JSON.stringify({ modelKey: "claude-3.7-sonnet" }), { cookie: alice.cookie });

    const rows = await db.userPreferences.findMany({ where: { userId: alice.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].preferredModelId).toBe("claude-3.7-sonnet");
  });

  it("refuses unknown, retired, and unauthenticated changes without writing", async () => {
    const before = await db.userPreferences.findMany({ where: { userId: alice.id } });
    const cases: [string, string, number][] = [
      ["unknown model", JSON.stringify({ modelKey: "not-a-model" }), 400],
      ["retired model", JSON.stringify({ modelKey: "llama-3.1-70b" }), 400],
      ["raw identifier", JSON.stringify({ modelKey: "openai/gpt-4o" }), 400],
      ["malformed body", "{not json", 400],
      ["unexpected field", JSON.stringify({ modelKey: "gpt-4o", extra: true }), 400],
    ];
    for (const [label, body, status] of cases) {
      const response = await callUpdate(body, { cookie: alice.cookie });
      expect(response.status, label).toBe(status);
    }

    const anonymous = await callUpdate(JSON.stringify({ modelKey: "gpt-4o" }), {});
    expect(anonymous.status).toBe(401);

    const after = await db.userPreferences.findMany({ where: { userId: alice.id } });
    expect(after).toEqual(before);
  });

  it("does not let one account write another account's preference", async () => {
    // Ownership is not a parameter in the route at all: the stored row is always
    // keyed by the authenticated session, so Bob's request cannot touch Alice's.
    const aliceBefore = await db.userPreferences.findUnique({ where: { userId: alice.id } });
    await callUpdate(JSON.stringify({ modelKey: "gpt-4o-mini" }), { cookie: bob.cookie });

    const aliceAfter = await db.userPreferences.findUnique({ where: { userId: alice.id } });
    expect(aliceAfter).toEqual(aliceBefore);
  });
});
