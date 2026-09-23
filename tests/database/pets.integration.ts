import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The route handlers read the incoming request headers from `next/headers`; this
// holder lets the tests present a real Better Auth session cookie (or none).
const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));

import { DEFAULT_PET_ID } from "../../src/features/pets/catalog";
import { createAuth } from "../../src/server/auth/config";
import { getDb } from "../../src/server/db/client";
import { GET, PUT } from "../../src/app/api/settings/pet/route";
import {
  GET as GET_APPEARANCE,
  PUT as PUT_APPEARANCE,
} from "../../src/app/api/settings/pet/appearance/route";

/**
 * Real Better Auth sessions + real PostgreSQL, driving the real pet-selection route:
 * the stored `user_preferences.selectedPetKey` column, the per-user isolation, and
 * the rule that a pet change touches no other column are all checked against the
 * database rather than a fake.
 */
const TEST_DOMAIN = "pets-test.invalid";
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
  return PUT(new Request(`${APP_ORIGIN}/api/settings/pet`, { method: "PUT", headers, body }));
}

async function callReadAppearance(cookie?: string) {
  request.headers = new Headers(cookie ? { cookie } : {});
  return GET_APPEARANCE();
}

async function callUpdateAppearance(
  body: string,
  options: { cookie?: string; origin?: string | null } = {},
) {
  const { cookie, origin = APP_ORIGIN } = options;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  request.headers = new Headers(headers);
  return PUT_APPEARANCE(
    new Request(`${APP_ORIGIN}/api/settings/pet/appearance`, { method: "PUT", headers, body }),
  );
}

beforeAll(async () => {
  if (!process.env.DATABASE_TEST_URL)
    throw new Error(
      "Set DATABASE_TEST_URL to a migrated disposable PostgreSQL database before running npm run test:db.",
    );
  vi.stubEnv("DATABASE_URL", process.env.DATABASE_TEST_URL);
  vi.stubEnv("APP_URL", APP_ORIGIN);
  vi.stubEnv("AUTH_SECRET", "pets-integration-test-secret-value-long-xx");
  vi.stubEnv("AUTH_TRUSTED_ORIGINS", "");
  auth = createAuth(async () => {});
  db = getDb();
  const stamp = Date.now();
  alice = await signUpAndGetSession(`alice-${stamp}@${TEST_DOMAIN}`, "Alice Pets");
  bob = await signUpAndGetSession(`bob-${stamp}@${TEST_DOMAIN}`, "Bob Pets");
});

afterAll(async () => {
  const users = await db.user.findMany({
    where: { email: { endsWith: `@${TEST_DOMAIN}` } },
    select: { id: true },
  });
  await db.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  await db.$disconnect();
  vi.unstubAllEnvs();
});

describe("reading the selected pet", () => {
  it("needs a session", async () => {
    expect((await callRead()).status).toBe(401);
    expect((await callUpdate(JSON.stringify({ pet: "ember-fox" }), {})).status).toBe(401);
  });

  it("reports the catalog default before anything is chosen", async () => {
    await db.userPreferences.deleteMany({ where: { userId: { in: [alice.id, bob.id] } } });

    const response = await callRead(alice.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pet: DEFAULT_PET_ID });
  });
});

describe("changing the selected pet", () => {
  it("stores an available pet for that user only", async () => {
    expect((await callUpdate(JSON.stringify({ pet: "ember-fox" }), { cookie: alice.cookie })).status).toBe(200);

    const row = await db.userPreferences.findUniqueOrThrow({ where: { userId: alice.id } });
    expect(row.selectedPetKey).toBe("ember-fox");

    const read = (await (await callRead(alice.cookie)).json()) as { pet: string };
    expect(read.pet).toBe("ember-fox");

    // Bob is untouched.
    expect((await (await callRead(bob.cookie)).json()) as { pet: string }).toEqual({
      pet: DEFAULT_PET_ID,
    });
  });

  it("leaves the theme and other columns of the same row alone", async () => {
    const before = await db.userPreferences.findUniqueOrThrow({ where: { userId: alice.id } });

    expect((await callUpdate(JSON.stringify({ pet: "yori-cat" }), { cookie: alice.cookie })).status).toBe(200);

    const after = await db.userPreferences.findUniqueOrThrow({ where: { userId: alice.id } });
    expect(after.selectedPetKey).toBe("yori-cat");
    expect(after.theme).toBe(before.theme);
    expect(after.preferredModelId).toBe(before.preferredModelId);
  });

  it("refuses invalid, unavailable, and unexpected bodies without writing", async () => {
    const before = await db.userPreferences.findUniqueOrThrow({ where: { userId: alice.id } });

    const cases: [string, string][] = [
      ["unavailable pet", JSON.stringify({ pet: "pip-rabbit" })],
      ["unknown pet", JSON.stringify({ pet: "nope" })],
      ["non-string pet", JSON.stringify({ pet: 7 })],
      ["missing pet", "{}"],
      ["malformed body", "{not json"],
      ["unexpected field", JSON.stringify({ pet: "ember-fox", theme: "dark" })],
      ["supplied user id", JSON.stringify({ pet: "ember-fox", userId: bob.id })],
    ];
    for (const [label, body] of cases) {
      const response = await callUpdate(body, { cookie: alice.cookie });
      expect(response.status, label).toBe(400);
    }

    const evil = await callUpdate(JSON.stringify({ pet: "ember-fox" }), {
      cookie: alice.cookie,
      origin: "https://evil.example",
    });
    expect(evil.status).toBe(403);

    const after = await db.userPreferences.findUniqueOrThrow({ where: { userId: alice.id } });
    expect(after.selectedPetKey).toBe(before.selectedPetKey);
  });

  it("does not let one account write another account's preference", async () => {
    const aliceBefore = await db.userPreferences.findUniqueOrThrow({ where: { userId: alice.id } });

    // Ownership is not a request parameter; Bob's writes are keyed by Bob's session.
    await callUpdate(JSON.stringify({ pet: "ember-fox", userId: alice.id }), { cookie: bob.cookie });
    await callUpdate(JSON.stringify({ pet: "ember-fox" }), { cookie: bob.cookie });

    const aliceAfter = await db.userPreferences.findUniqueOrThrow({ where: { userId: alice.id } });
    expect(aliceAfter.selectedPetKey).toBe(aliceBefore.selectedPetKey);

    const bobRow = await db.userPreferences.findUniqueOrThrow({ where: { userId: bob.id } });
    expect(bobRow.selectedPetKey).toBe("ember-fox");
  });
});

describe("the stored appearance", () => {
  it("needs a session", async () => {
    expect((await callReadAppearance()).status).toBe(401);
    expect((await callUpdateAppearance(JSON.stringify({ appearance: "night" }), {})).status).toBe(401);
  });

  it("reports the pet's default appearance before anything is chosen", async () => {
    await db.userPreferences.updateMany({
      where: { userId: alice.id },
      data: { selectedPetKey: DEFAULT_PET_ID, uiPreferences: {} },
    });

    const response = await callReadAppearance(alice.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pet: DEFAULT_PET_ID, appearance: "classic" });
  });

  it("stores a valid appearance as a single key in uiPreferences, keeping the pet", async () => {
    expect(
      (await callUpdateAppearance(JSON.stringify({ appearance: "night" }), { cookie: alice.cookie }))
        .status,
    ).toBe(200);

    const row = await db.userPreferences.findUniqueOrThrow({ where: { userId: alice.id } });
    expect(row.selectedPetKey).toBe(DEFAULT_PET_ID);
    expect(row.uiPreferences).toEqual({ petAppearance: "night" });

    const read = (await (await callReadAppearance(alice.cookie)).json()) as {
      pet: string;
      appearance: string;
    };
    expect(read).toEqual({ pet: DEFAULT_PET_ID, appearance: "night" });
  });

  it("keeps each account's appearance separate", async () => {
    // Bob is still on the fox with no appearance stored, so he resolves to its default.
    const bobRead = (await (await callReadAppearance(bob.cookie)).json()) as { appearance: string };
    expect(bobRead.appearance).toBe("classic");
  });

  it("refuses an appearance from another pet, an unknown one, and unexpected bodies", async () => {
    const before = await db.userPreferences.findUniqueOrThrow({ where: { userId: alice.id } });

    const cases: [string, string][] = [
      // Alice is on the cat; "ember" belongs to the fox.
      ["another pet's appearance", JSON.stringify({ appearance: "ember" })],
      ["unknown appearance", JSON.stringify({ appearance: "disco" })],
      ["non-string appearance", JSON.stringify({ appearance: 7 })],
      ["missing appearance", "{}"],
      ["malformed body", "{not json"],
      ["unexpected field", JSON.stringify({ appearance: "night", pet: "ember-fox" })],
      ["supplied user id", JSON.stringify({ appearance: "night", userId: bob.id })],
    ];
    for (const [label, body] of cases) {
      const response = await callUpdateAppearance(body, { cookie: alice.cookie });
      expect(response.status, label).toBe(400);
    }

    const evil = await callUpdateAppearance(JSON.stringify({ appearance: "moss" }), {
      cookie: alice.cookie,
      origin: "https://evil.example",
    });
    expect(evil.status).toBe(403);

    const after = await db.userPreferences.findUniqueOrThrow({ where: { userId: alice.id } });
    expect(after.uiPreferences).toEqual(before.uiPreferences);
  });

  it("resolves an invalid stored appearance to the pet's default on read", async () => {
    await db.userPreferences.update({
      where: { userId: alice.id },
      data: { uiPreferences: { petAppearance: "not-real" } },
    });
    const read = (await (await callReadAppearance(alice.cookie)).json()) as { appearance: string };
    expect(read.appearance).toBe("classic");
  });
});
