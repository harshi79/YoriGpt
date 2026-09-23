import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The pet-selection API (`/api/settings/pet`), exercised directly: the route handlers
 * run with real `Request` objects while the session and the pet service are replaced,
 * so the status codes, the strict body handling, and the wire shape can be asserted
 * without a database. Real sessions and a real row are covered by
 * tests/database/pets.integration.ts.
 */
const fake = vi.hoisted(() => ({
  state: {
    user: null as { id: string } | null,
    pet: "yori-cat" as string,
    saved: [] as { userId: string; pet: string }[],
    saveResult: null as unknown,
    saveFails: false,
    readFails: false,
  },
}));

vi.mock("../src/server/auth/session", () => ({
  getCurrentUser: async () => fake.state.user,
}));

vi.mock("../src/server/pets/service", () => ({
  resolveSelectedPetKey: async () => {
    if (fake.state.readFails) throw new Error("db down");
    return fake.state.pet;
  },
  saveSelectedPetKey: async (userId: string, pet: string) => {
    // Mirror the real service's catalog re-check so the route's 400 path for an
    // unavailable/unknown key is exercised without a database.
    const { isSelectablePetId } = await import("../src/features/pets/catalog");
    if (!isSelectablePetId(pet)) return { ok: false, reason: "invalid-pet" };
    if (fake.state.saveFails) throw new Error("connection lost");
    if (fake.state.saveResult) return fake.state.saveResult;
    fake.state.saved.push({ userId, pet });
    return { ok: true, pet };
  },
}));

const { GET, PUT } = await import("../src/app/api/settings/pet/route");

const APP_URL = "http://localhost:3000";
const SESSION_USER = { id: "cmuser00000000000000001" };

function put(body: string, headers: Record<string, string> = {}) {
  return new Request(`${APP_URL}/api/settings/pet`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: APP_URL, ...headers },
    body,
  });
}

beforeEach(() => {
  vi.stubEnv("APP_URL", APP_URL);
  vi.stubEnv("AUTH_SECRET", "pets-route-test-secret-value-long-enough-x");
  vi.stubEnv("AUTH_TRUSTED_ORIGINS", "");
  fake.state.user = SESSION_USER;
  fake.state.pet = "yori-cat";
  fake.state.saved = [];
  fake.state.saveResult = null;
  fake.state.saveFails = false;
  fake.state.readFails = false;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/settings/pet", () => {
  it("returns the caller's selected pet", async () => {
    fake.state.pet = "ember-fox";

    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pet: "ember-fox" });
  });

  it("requires a session", async () => {
    fake.state.user = null;

    const response = await GET();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
    });
  });

  it("answers a controlled error when the preference cannot be read", async () => {
    fake.state.readFails = true;

    const response = await GET();
    expect(response.status).toBe(500);
  });
});

describe("PUT /api/settings/pet", () => {
  it("stores an available pet for the signed-in user", async () => {
    const response = await PUT(put(JSON.stringify({ pet: "ember-fox" })));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pet: "ember-fox" });
    expect(fake.state.saved).toEqual([{ userId: SESSION_USER.id, pet: "ember-fox" }]);
  });

  it("requires a session", async () => {
    fake.state.user = null;

    const response = await PUT(put(JSON.stringify({ pet: "ember-fox" })));
    expect(response.status).toBe(401);
    expect(fake.state.saved).toEqual([]);
  });

  it("refuses an untrusted origin", async () => {
    const response = await PUT(
      put(JSON.stringify({ pet: "ember-fox" }), { origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
    expect(fake.state.saved).toEqual([]);
  });

  it.each([
    ["an unavailable pet", JSON.stringify({ pet: "pip-rabbit" })],
    ["an unknown pet", JSON.stringify({ pet: "nope" })],
    ["a non-string pet", JSON.stringify({ pet: 42 })],
    ["a missing pet", "{}"],
    ["an unexpected field", JSON.stringify({ pet: "ember-fox", theme: "dark" })],
    ["a supplied user id", JSON.stringify({ pet: "ember-fox", userId: "cmx" })],
    ["malformed JSON", "{not json"],
  ])("rejects %s with 400", async (_label, body) => {
    const response = await PUT(put(body));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_REQUEST",
    );
    expect(fake.state.saved).toEqual([]);
  });

  it("rejects a non-JSON content type", async () => {
    const response = await PUT(put("{}", { "content-type": "text/plain" }));
    expect(response.status).toBe(400);
    expect(fake.state.saved).toEqual([]);
  });

  it("rejects an oversized body", async () => {
    const response = await PUT(put(JSON.stringify({ pet: `ember-${"x".repeat(9000)}` })));
    expect(response.status).toBe(400);
    expect(fake.state.saved).toEqual([]);
  });

  it("maps a refused save to 400 and a failed write to 500", async () => {
    fake.state.saveResult = { ok: false, reason: "invalid-pet" };
    expect((await PUT(put(JSON.stringify({ pet: "ember-fox" })))).status).toBe(400);

    fake.state.saveResult = null;
    fake.state.saveFails = true;
    expect((await PUT(put(JSON.stringify({ pet: "ember-fox" })))).status).toBe(500);
    expect(fake.state.saved).toEqual([]);
  });
});
