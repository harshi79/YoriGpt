import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The appearance API (`/api/settings/pet/appearance`), exercised directly with real
 * `Request` objects while the session and the pet service are replaced, so the status
 * codes, strict body handling, and wire shape can be asserted without a database.
 * The separate `/api/settings/pet` route is covered by tests/pets-route.test.ts.
 */
const fake = vi.hoisted(() => ({
  state: {
    user: null as { id: string } | null,
    pet: "yori-cat" as string,
    appearance: "classic" as string,
    saved: [] as { userId: string; appearance: string }[],
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
  getPetAppearanceKey: async () => {
    if (fake.state.readFails) throw new Error("db down");
    return fake.state.appearance === "classic" ? null : fake.state.appearance;
  },
  savePetAppearance: async (userId: string, appearance: string) => {
    // Mirror the real service's catalog re-check so the 400 path for a wrong-pet or
    // unknown appearance is exercised without a database.
    const { isSelectableAppearance } = await import("../src/features/pets/catalog");
    if (!isSelectableAppearance(fake.state.pet, appearance))
      return { ok: false, reason: "invalid-appearance" };
    if (fake.state.saveFails) throw new Error("connection lost");
    if (fake.state.saveResult) return fake.state.saveResult;
    fake.state.saved.push({ userId, appearance });
    return { ok: true, pet: fake.state.pet, appearance };
  },
}));

const { GET, PUT } = await import("../src/app/api/settings/pet/appearance/route");

const APP_URL = "http://localhost:3000";
const SESSION_USER = { id: "cmuser00000000000000001" };

function put(body: string, headers: Record<string, string> = {}) {
  return new Request(`${APP_URL}/api/settings/pet/appearance`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: APP_URL, ...headers },
    body,
  });
}

beforeEach(() => {
  vi.stubEnv("APP_URL", APP_URL);
  vi.stubEnv("AUTH_SECRET", "pets-appearance-test-secret-value-long-x");
  vi.stubEnv("AUTH_TRUSTED_ORIGINS", "");
  fake.state.user = SESSION_USER;
  fake.state.pet = "yori-cat";
  fake.state.appearance = "classic";
  fake.state.saved = [];
  fake.state.saveResult = null;
  fake.state.saveFails = false;
  fake.state.readFails = false;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/settings/pet/appearance", () => {
  it("returns the caller's pet and resolved appearance", async () => {
    fake.state.pet = "ember-fox";
    fake.state.appearance = "ember";

    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pet: "ember-fox", appearance: "ember" });
  });

  it("resolves a missing appearance to the pet default", async () => {
    const response = await GET();
    expect(await response.json()).toEqual({ pet: "yori-cat", appearance: "classic" });
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
    expect((await GET()).status).toBe(500);
  });
});

describe("PUT /api/settings/pet/appearance", () => {
  it("stores a valid appearance for the selected pet", async () => {
    const response = await PUT(put(JSON.stringify({ appearance: "night" })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pet: "yori-cat", appearance: "night" });
    expect(fake.state.saved).toEqual([{ userId: SESSION_USER.id, appearance: "night" }]);
  });

  it("requires a session", async () => {
    fake.state.user = null;
    const response = await PUT(put(JSON.stringify({ appearance: "night" })));
    expect(response.status).toBe(401);
    expect(fake.state.saved).toEqual([]);
  });

  it("refuses an untrusted origin", async () => {
    const response = await PUT(
      put(JSON.stringify({ appearance: "night" }), { origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
    expect(fake.state.saved).toEqual([]);
  });

  it.each([
    ["an appearance from another pet", JSON.stringify({ appearance: "ember" })],
    ["an unknown appearance", JSON.stringify({ appearance: "disco" })],
    ["a non-string appearance", JSON.stringify({ appearance: 7 })],
    ["a missing appearance", "{}"],
    ["an unexpected field", JSON.stringify({ appearance: "night", pet: "ember-fox" })],
    ["a supplied user id", JSON.stringify({ appearance: "night", userId: "cmx" })],
    ["malformed JSON", "{not json"],
  ])("rejects %s with 400", async (_label, body) => {
    const response = await PUT(put(body));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_REQUEST",
    );
    expect(fake.state.saved).toEqual([]);
  });

  it("rejects a non-JSON content type and an oversized body", async () => {
    expect((await PUT(put("{}", { "content-type": "text/plain" }))).status).toBe(400);
    expect((await PUT(put(JSON.stringify({ appearance: `n${"x".repeat(9000)}` })))).status).toBe(400);
    expect(fake.state.saved).toEqual([]);
  });

  it("maps a refused save to 400 and a failed write to 500", async () => {
    fake.state.saveResult = { ok: false, reason: "invalid-appearance" };
    expect((await PUT(put(JSON.stringify({ appearance: "night" })))).status).toBe(400);

    fake.state.saveResult = null;
    fake.state.saveFails = true;
    expect((await PUT(put(JSON.stringify({ appearance: "night" })))).status).toBe(500);
    expect(fake.state.saved).toEqual([]);
  });
});
