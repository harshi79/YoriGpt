import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The personality API (`/api/settings/pet/personality`), exercised directly with real
 * `Request` objects while the session and the pet service are replaced, so the status
 * codes, strict body handling, and wire shape can be asserted without a database.
 * The sibling `/api/settings/pet` and `/api/settings/pet/appearance` routes keep their
 * own suites, which also prove they are untouched by this one.
 */
const fake = vi.hoisted(() => ({
  state: {
    user: null as { id: string } | null,
    pet: "yori-cat" as string,
    personality: "calm" as string,
    saved: [] as { userId: string; personality: string }[],
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
  getPetPersonalityKey: async () => {
    if (fake.state.readFails) throw new Error("db down");
    return fake.state.personality === "calm" ? null : fake.state.personality;
  },
  savePetPersonality: async (userId: string, personality: string) => {
    // Mirror the real service's catalog re-check so the 400 path for a wrong-pet or
    // unknown personality is exercised without a database.
    const { isSelectablePersonality } = await import("../src/features/pets/catalog");
    if (!isSelectablePersonality(fake.state.pet, personality))
      return { ok: false, reason: "invalid-personality" };
    if (fake.state.saveFails) throw new Error("connection lost");
    if (fake.state.saveResult) return fake.state.saveResult;
    fake.state.saved.push({ userId, personality });
    return { ok: true, pet: fake.state.pet, personality };
  },
}));

const { GET, PUT } = await import("../src/app/api/settings/pet/personality/route");

const APP_URL = "http://localhost:3000";
const SESSION_USER = { id: "cmuser00000000000000001" };

function put(body: string, headers: Record<string, string> = {}) {
  return new Request(`${APP_URL}/api/settings/pet/personality`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: APP_URL, ...headers },
    body,
  });
}

beforeEach(() => {
  vi.stubEnv("APP_URL", APP_URL);
  vi.stubEnv("AUTH_SECRET", "pets-personality-test-secret-value-long-x");
  vi.stubEnv("AUTH_TRUSTED_ORIGINS", "");
  fake.state.user = SESSION_USER;
  fake.state.pet = "yori-cat";
  fake.state.personality = "calm";
  fake.state.saved = [];
  fake.state.saveResult = null;
  fake.state.saveFails = false;
  fake.state.readFails = false;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/settings/pet/personality", () => {
  it("returns the caller's pet and resolved personality", async () => {
    fake.state.pet = "ember-fox";
    fake.state.personality = "playful";

    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pet: "ember-fox", personality: "playful" });
  });

  it("resolves a missing personality to the pet default", async () => {
    const response = await GET();
    expect(await response.json()).toEqual({ pet: "yori-cat", personality: "calm" });
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

describe("PUT /api/settings/pet/personality", () => {
  it("stores a valid personality for the selected pet", async () => {
    const response = await PUT(put(JSON.stringify({ personality: "sleepy" })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pet: "yori-cat", personality: "sleepy" });
    expect(fake.state.saved).toEqual([{ userId: SESSION_USER.id, personality: "sleepy" }]);
  });

  it("requires a session", async () => {
    fake.state.user = null;
    const response = await PUT(put(JSON.stringify({ personality: "sleepy" })));
    expect(response.status).toBe(401);
    expect(fake.state.saved).toEqual([]);
  });

  it("refuses an untrusted origin", async () => {
    const response = await PUT(
      put(JSON.stringify({ personality: "sleepy" }), { origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
    expect(fake.state.saved).toEqual([]);
  });

  it.each([
    // "playful" belongs to the fox, not the cat.
    ["a personality from another pet", JSON.stringify({ personality: "playful" })],
    ["an unknown personality", JSON.stringify({ personality: "disco" })],
    ["a non-string personality", JSON.stringify({ personality: 7 })],
    ["a missing personality", "{}"],
    ["an unexpected field", JSON.stringify({ personality: "sleepy", pet: "ember-fox" })],
    ["a supplied user id", JSON.stringify({ personality: "sleepy", userId: "cmx" })],
    ["malformed JSON", "{not json"],
  ])("rejects %s with 400", async (_label, body) => {
    const response = await PUT(put(body));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_REQUEST",
    );
    expect(fake.state.saved).toEqual([]);
  });

  it("rejects an arbitrary personality object instead of storing it", async () => {
    // A whole behaviour definition — with traits and prompt-like text — is not a key.
    const response = await PUT(
      put(
        JSON.stringify({
          personality: { id: "sleepy", traits: ["restful"], prompt: "You are a sleepy cat." },
        }),
      ),
    );
    expect(response.status).toBe(400);
    expect(fake.state.saved).toEqual([]);
  });

  it("rejects a non-JSON content type and an oversized body", async () => {
    expect((await PUT(put("{}", { "content-type": "text/plain" }))).status).toBe(400);
    expect(
      (await PUT(put(JSON.stringify({ personality: `s${"x".repeat(9000)}` })))).status,
    ).toBe(400);
    expect(fake.state.saved).toEqual([]);
  });

  it("maps a refused save to 400 and a failed write to 500", async () => {
    fake.state.saveResult = { ok: false, reason: "invalid-personality" };
    expect((await PUT(put(JSON.stringify({ personality: "sleepy" })))).status).toBe(400);

    fake.state.saveResult = null;
    fake.state.saveFails = true;
    expect((await PUT(put(JSON.stringify({ personality: "sleepy" })))).status).toBe(500);
    expect(fake.state.saved).toEqual([]);
  });
});
