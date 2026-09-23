import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The model API, exercised directly: the route handlers are called with real
 * `Request` objects while the session and the preference service are replaced, so
 * the status codes, the strict body handling, and the wire shape can all be
 * asserted without a database or a signed-in browser.
 */
const fake = vi.hoisted(() => ({
  state: {
    user: null as { id: string } | null,
    stored: null as string | null,
    saved: [] as { userId: string; modelKey: string }[],
    saveResult: null as unknown,
    readFails: false,
    readFailure: null as unknown,
  },
}));

vi.mock("../src/server/auth/session", () => ({
  getCurrentUser: async () => fake.state.user,
}));

vi.mock("../src/server/ai/models/service", () => ({
  getSelectedModelKey: async () => {
    if (fake.state.readFails) throw fake.state.readFailure ?? new Error("db down");
    return fake.state.stored;
  },
  saveSelectedModelKey: async (userId: string, modelKey: string) => {
    if (fake.state.saveResult) return fake.state.saveResult;
    fake.state.saved.push({ userId, modelKey });
    return { ok: true, modelKey };
  },
}));

const { GET, PUT } = await import("../src/app/api/models/route");
const { DEFAULT_MODEL_KEY, MODEL_CATALOG } = await import("../src/server/ai/models/catalog");

const APP_URL = "http://localhost:3000";

function put(body: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/models", {
    method: "PUT",
    headers: { "content-type": "application/json", origin: APP_URL, ...headers },
    body,
  });
}

beforeEach(() => {
  vi.stubEnv("APP_URL", APP_URL);
  vi.stubEnv("AUTH_SECRET", "model-route-test-secret-value-long-enough");
  vi.stubEnv("AUTH_TRUSTED_ORIGINS", "");
  fake.state.user = { id: "cmuser00000000000000001" };
  fake.state.stored = null;
  fake.state.saved = [];
  fake.state.saveResult = null;
  fake.state.readFails = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/models", () => {
  it("lists the active catalog models and the caller's saved selection", async () => {
    fake.state.stored = "gpt-4o";

    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      models: { key: string; name: string; description: string }[];
      selectedModelKey: string;
    };

    expect(body.selectedModelKey).toBe("gpt-4o");
    expect(body.models).toEqual(
      MODEL_CATALOG.filter((model) => model.active).map((model) => ({
        key: model.key,
        name: model.name,
        description: model.description,
      })),
    );
    // No identifier, provider, or configuration detail is exposed.
    const serialized = JSON.stringify(body);
    for (const model of MODEL_CATALOG) {
      expect(serialized).not.toContain(model.modelIdentifier);
    }
    expect(serialized).not.toContain("OPENROUTER");
    expect(serialized).not.toContain("ai_models");
  });

  it("reports the documented default when nothing is saved", async () => {
    const body = (await (await GET()).json()) as { selectedModelKey: string };
    expect(body.selectedModelKey).toBe(DEFAULT_MODEL_KEY);
  });

  it("reports the model a reply would actually use when the saved one was retired", async () => {
    const retired = MODEL_CATALOG.find((model) => !model.active)!;
    fake.state.stored = retired.key;

    const body = (await (await GET()).json()) as { selectedModelKey: string };
    expect(body.selectedModelKey).toBe(DEFAULT_MODEL_KEY);
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
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Something went wrong. Try again." },
    });
  });
});

describe("PUT /api/models", () => {
  it("stores an active catalog model for the signed-in user", async () => {
    const response = await PUT(put(JSON.stringify({ modelKey: "claude-3.5-haiku" })));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ selectedModelKey: "claude-3.5-haiku" });
    expect(fake.state.saved).toEqual([
      { userId: "cmuser00000000000000001", modelKey: "claude-3.5-haiku" },
    ]);
  });

  it("trims the key and rejects every other shape", async () => {
    expect((await PUT(put(JSON.stringify({ modelKey: "  gpt-4o  " })))).status).toBe(200);

    const cases: [string, string][] = [
      ["no body", ""],
      ["not JSON", "gpt-4o"],
      ["a JSON array", "[]"],
      ["a JSON string", '"gpt-4o"'],
      ["a missing field", "{}"],
      ["a non-string field", JSON.stringify({ modelKey: 42 })],
      ["an empty key", JSON.stringify({ modelKey: "   " })],
      ["an over-long key", JSON.stringify({ modelKey: "x".repeat(200) })],
      [
        "an unexpected field",
        JSON.stringify({ modelKey: "gpt-4o", modelIdentifier: "openai/gpt-4o" }),
      ],
      ["a nested override", JSON.stringify({ modelKey: "gpt-4o", user: { id: "other" } })],
    ];

    for (const [label, body] of cases) {
      const response = await PUT(put(body));
      expect(response.status, label).toBe(400);
      const payload = (await response.json()) as { error: { code: string } };
      expect(payload.error.code, label).toBe("INVALID_REQUEST");
    }

    // Only the two valid attempts above reached the service.
    expect(fake.state.saved).toHaveLength(1);
  });

  it("refuses a body that is not JSON, or is far too large, before parsing it", async () => {
    const notJson = await PUT(put("{}", { "content-type": "text/plain" }));
    expect(notJson.status).toBe(400);

    const oversized = await PUT(put("x".repeat(5000)));
    expect(oversized.status).toBe(400);
    expect(((await oversized.json()) as { error: { message: string } }).error.message).toMatch(
      /too large/i,
    );
    expect(fake.state.saved).toEqual([]);
  });

  it("rejects an unknown model and a raw provider identifier", async () => {
    for (const modelKey of ["not-a-model", "openai/gpt-4o", "gpt-4o-mini "]) {
      const response = await PUT(put(JSON.stringify({ modelKey })));
      // "gpt-4o-mini " trims to a real key; the others must be refused.
      const expected = modelKey === "gpt-4o-mini " ? 200 : 400;
      expect(response.status, modelKey).toBe(expected);
    }
    expect(fake.state.saved.map((entry) => entry.modelKey)).toEqual(["gpt-4o-mini"]);
  });

  it("rejects a retired catalog model", async () => {
    const retired = MODEL_CATALOG.find((model) => !model.active)!;

    const response = await PUT(put(JSON.stringify({ modelKey: retired.key })));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
      "That model is not available.",
    );
    expect(fake.state.saved).toEqual([]);
  });

  it("requires a session", async () => {
    fake.state.user = null;

    const response = await PUT(put(JSON.stringify({ modelKey: "gpt-4o" })));
    expect(response.status).toBe(401);
    expect(fake.state.saved).toEqual([]);
  });

  it("rejects a cross-origin write", async () => {
    const response = await PUT(
      put(JSON.stringify({ modelKey: "gpt-4o" }), { origin: "https://evil.example" }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "FORBIDDEN_ORIGIN", message: "This request came from an untrusted origin." },
    });
    expect(fake.state.saved).toEqual([]);
  });

  it("reports a storage failure without pretending the choice was saved", async () => {
    fake.state.saveResult = { ok: false, reason: "unavailable" };

    const response = await PUT(put(JSON.stringify({ modelKey: "gpt-4o" })));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
      "That model cannot be selected right now.",
    );
  });
});
