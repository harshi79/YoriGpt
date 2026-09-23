import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The route handlers read the incoming request headers from `next/headers`; this
// holder lets the tests present a real Better Auth session cookie (or none).
const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));

import { createAuth } from "../../src/server/auth/config";
import { getDb } from "../../src/server/db/client";
import { GET, PUT } from "../../src/app/api/settings/route";

/**
 * Real Better Auth sessions + real PostgreSQL, driving the real settings route: the
 * stored `user_preferences.theme` row, the per-user isolation, the enum column, and
 * the rule that a theme change touches no other column are all checked against the
 * database rather than a fake.
 */
const TEST_DOMAIN = "settings-test.invalid";
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

async function callRead(cookie?: string) {
  request.headers = new Headers(cookie ? { cookie } : {});
  return GET();
}

async function callUpdate(body: string, options: { cookie?: string; origin?: string | null } = {}) {
  const { cookie, origin = APP_ORIGIN } = options;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  request.headers = new Headers(headers);
  return PUT(new Request(`${APP_ORIGIN}/api/settings`, { method: "PUT", headers, body }));
}

beforeAll(async () => {
  if (!process.env.DATABASE_TEST_URL)
    throw new Error(
      "Set DATABASE_TEST_URL to a migrated disposable PostgreSQL database before running npm run test:db.",
    );
  vi.stubEnv("DATABASE_URL", process.env.DATABASE_TEST_URL);
  vi.stubEnv("APP_URL", APP_ORIGIN);
  vi.stubEnv("AUTH_SECRET", "settings-integration-test-secret-value-long");
  vi.stubEnv("AUTH_TRUSTED_ORIGINS", "");
  auth = createAuth(async () => {});
  db = getDb();
  const stamp = Date.now();
  alice = await signUpAndGetSession(`alice-${stamp}@${TEST_DOMAIN}`, "Alice Settings");
  bob = await signUpAndGetSession(`bob-${stamp}@${TEST_DOMAIN}`, "Bob Settings");
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

describe("reading the settings", () => {
  it("needs a session", async () => {
    const read = await callRead();
    expect(read.status).toBe(401);

    const write = await callUpdate(JSON.stringify({ theme: "dark" }), {});
    expect(write.status).toBe(401);
    expect((await callRead()).status).toBe(401);
  });

  it("reports the documented default before anything is chosen", async () => {
    await db.userPreferences.deleteMany({ where: { userId: { in: [alice.id, bob.id] } } });

    const response = await callRead(alice.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      theme: string;
      account: { name: string; email: string; emailVerified: boolean };
    };

    expect(body.theme).toBe("system");
    expect(body.account).toEqual({
      name: "Alice Settings",
      email: expect.stringContaining(`@${TEST_DOMAIN}`),
      emailVerified: false,
    });
    // Nothing but those fields crosses to the client.
    expect(Object.keys(body)).toEqual(["theme", "account"]);
    expect(JSON.stringify(body)).not.toContain(alice.id);
  });
});

describe("the theme column", () => {
  it("is the existing enum, and refuses a value outside it", async () => {
    // Written directly, as an older server version (or a hand-edited row) might.
    await expect(
      db.$executeRaw`INSERT INTO user_preferences ("userId", "theme")
        VALUES (${alice.id}, 'SEPIA'::"ThemePreference")`,
    ).rejects.toThrow();
  });

  it("keeps the default for a row created by another feature", async () => {
    // Choosing a model creates the same row; the theme must stay the default so
    // the account's appearance cannot change as a side effect.
    await db.userPreferences.upsert({
      where: { userId: alice.id },
      create: { userId: alice.id, preferredModelId: "gpt-4o" },
      update: { preferredModelId: "gpt-4o" },
    });

    const body = (await (await callRead(alice.cookie)).json()) as { theme: string };
    expect(body.theme).toBe("system");
  });
});

describe("changing the theme", () => {
  it("stores the choice for that user only", async () => {
    expect((await callUpdate(JSON.stringify({ theme: "dark" }), { cookie: alice.cookie })).status).toBe(200);
    expect((await callUpdate(JSON.stringify({ theme: "light" }), { cookie: bob.cookie })).status).toBe(
      200,
    );

    const rows = await db.userPreferences.findMany({
      where: { userId: { in: [alice.id, bob.id] } },
      select: { userId: true, theme: true },
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        { userId: alice.id, theme: "DARK" },
        { userId: bob.id, theme: "LIGHT" },
      ]),
    );

    const aliceRead = (await (await callRead(alice.cookie)).json()) as { theme: string };
    const bobRead = (await (await callRead(bob.cookie)).json()) as { theme: string };
    expect(aliceRead.theme).toBe("dark");
    expect(bobRead.theme).toBe("light");
  });

  it("updates the existing row instead of adding another, and leaves other columns alone", async () => {
    const before = await db.userPreferences.findUniqueOrThrow({ where: { userId: alice.id } });

    const response = await callUpdate(JSON.stringify({ theme: "system" }), { cookie: alice.cookie });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ theme: "system" });

    const rows = await db.userPreferences.findMany({ where: { userId: alice.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].theme).toBe("SYSTEM");
    // The model preference of the same row survived the theme change untouched.
    expect(rows[0].preferredModelId).toBe(before.preferredModelId);
  });

  it("refuses invalid, malformed, and unexpected bodies without writing", async () => {
    const before = await db.userPreferences.findUniqueOrThrow({ where: { userId: alice.id } });

    const cases: [string, string][] = [
      ["unknown theme", JSON.stringify({ theme: "solarized" })],
      ["stored enum spelling", JSON.stringify({ theme: "DARK" })],
      ["non-string theme", JSON.stringify({ theme: 3 })],
      ["missing theme", "{}"],
      ["malformed body", "{not json"],
      ["unexpected field", JSON.stringify({ theme: "dark", pet: "cat" })],
      ["supplied user id", JSON.stringify({ theme: "dark", userId: bob.id })],
    ];
    for (const [label, body] of cases) {
      const response = await callUpdate(body, { cookie: alice.cookie });
      expect(response.status, label).toBe(400);
    }

    const anonymous = await callUpdate(JSON.stringify({ theme: "dark" }), {});
    expect(anonymous.status).toBe(401);

    const evil = await callUpdate(JSON.stringify({ theme: "dark" }), {
      cookie: alice.cookie,
      origin: "https://evil.example",
    });
    expect(evil.status).toBe(403);

    const after = await db.userPreferences.findUniqueOrThrow({ where: { userId: alice.id } });
    expect(after.theme).toBe(before.theme);
  });

  it("does not let one account write another account's preference", async () => {
    // Ownership is not a parameter of the route at all: the stored row is always
    // keyed by the authenticated session, so Bob's request cannot touch Alice's.
    const aliceBefore = await db.userPreferences.findUniqueOrThrow({ where: { userId: alice.id } });

    await callUpdate(JSON.stringify({ theme: "light", userId: alice.id }), { cookie: bob.cookie });
    await callUpdate(JSON.stringify({ theme: "light" }), { cookie: bob.cookie });

    const aliceAfter = await db.userPreferences.findUniqueOrThrow({ where: { userId: alice.id } });
    expect(aliceAfter.theme).toBe(aliceBefore.theme);
    expect(aliceAfter.updatedAt).toEqual(aliceBefore.updatedAt);
  });

  it("keeps the preference after the session is used again", async () => {
    // The same cookie, a later request: the value comes from the database.
    const body = (await (await callRead(alice.cookie)).json()) as { theme: string };
    expect(body.theme).toBe("system");

    await callUpdate(JSON.stringify({ theme: "light" }), { cookie: alice.cookie });
    const again = (await (await callRead(alice.cookie)).json()) as { theme: string };
    expect(again.theme).toBe("light");
  });
});
