import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The settings API, exercised directly: the route handlers are called with real
 * `Request` objects while the session and the settings service are replaced, so the
 * status codes, the strict body handling, and the wire shape can all be asserted
 * without a database or a signed-in browser. Real sessions and a real
 * `user_preferences` row are covered by tests/database/settings.integration.ts.
 */
const fake = vi.hoisted(() => ({
  state: {
    user: null as { id: string; name: string; email: string; emailVerified: boolean } | null,
    theme: "system" as string,
    saved: [] as { userId: string; theme: string }[],
    saveResult: null as unknown,
    saveFails: false,
    readFails: false,
  },
}));

vi.mock("../src/server/auth/session", () => ({
  getCurrentUser: async () => fake.state.user,
}));

vi.mock("../src/server/settings/service", () => ({
  getTheme: async () => {
    if (fake.state.readFails) throw new Error("db down");
    return fake.state.theme;
  },
  saveTheme: async (userId: string, theme: string) => {
    if (fake.state.saveFails) throw new Error("connection lost");
    if (fake.state.saveResult) return fake.state.saveResult;
    fake.state.saved.push({ userId, theme });
    return { ok: true, theme };
  },
  resolveTheme: async () => fake.state.theme,
}));

const { GET, PUT } = await import("../src/app/api/settings/route");

const APP_URL = "http://localhost:3000";
const SESSION_USER = {
  id: "cmuser00000000000000001",
  name: "Ada Lovelace",
  email: "ada@example.com",
  emailVerified: true,
};

function put(body: string, headers: Record<string, string> = {}) {
  return new Request(`${APP_URL}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: APP_URL, ...headers },
    body,
  });
}

beforeEach(() => {
  vi.stubEnv("APP_URL", APP_URL);
  vi.stubEnv("AUTH_SECRET", "settings-route-test-secret-value-long-enough");
  vi.stubEnv("AUTH_TRUSTED_ORIGINS", "");
  fake.state.user = SESSION_USER;
  fake.state.theme = "system";
  fake.state.saved = [];
  fake.state.saveResult = null;
  fake.state.saveFails = false;
  fake.state.readFails = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/settings", () => {
  it("returns the caller's theme and the account details the page shows", async () => {
    fake.state.theme = "dark";

    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      theme: "dark",
      account: { name: "Ada Lovelace", email: "ada@example.com", emailVerified: true },
    });
  });

  it("exposes nothing sensitive", async () => {
    fake.state.theme = "light";

    const serialized = JSON.stringify(await (await GET()).json());
    // No internal identifier, credential, session material, or provider detail.
    expect(serialized).not.toContain(SESSION_USER.id);
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("user_preferences");
    expect(serialized).not.toContain("preferredModelId");
    expect(serialized).not.toContain("OPENROUTER");
  });

  it("reports an unverified address honestly", async () => {
    fake.state.user = { ...SESSION_USER, emailVerified: false };

    const body = (await (await GET()).json()) as { account: { emailVerified: boolean } };
    expect(body.account.emailVerified).toBe(false);
  });

  it("reports the documented default when nothing is stored", async () => {
    const body = (await (await GET()).json()) as { theme: string };
    expect(body.theme).toBe("system");
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

describe("PUT /api/settings", () => {
  it("stores a theme for the signed-in user", async () => {
    const response = await PUT(put(JSON.stringify({ theme: "light" })));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ theme: "light" });
    expect(fake.state.saved).toEqual([{ userId: SESSION_USER.id, theme: "light" }]);
  });

  it("trims the value and accepts every supported theme", async () => {
    for (const theme of ["dark", " system ", "light"]) {
      expect((await PUT(put(JSON.stringify({ theme })))).status, theme).toBe(200);
    }
    expect(fake.state.saved.map((entry) => entry.theme)).toEqual(["dark", "system", "light"]);
  });

  it("rejects every other shape, including a supplied user id", async () => {
    const cases: [string, string][] = [
      ["no body", ""],
      ["not JSON", "{not json"],
      ["a JSON array", "[]"],
      ["a JSON string", '"dark"'],
      ["a missing field", "{}"],
      ["a non-string field", JSON.stringify({ theme: 42 })],
      ["an empty value", JSON.stringify({ theme: "   " })],
      ["an unknown value", JSON.stringify({ theme: "solarized" })],
      ["the stored enum spelling", JSON.stringify({ theme: "DARK" })],
      ["a null value", JSON.stringify({ theme: null })],
      ["an unexpected field", JSON.stringify({ theme: "dark", pet: "cat" })],
      ["a supplied userId", JSON.stringify({ theme: "dark", userId: "cmuser00000000000000002" })],
      ["a nested user", JSON.stringify({ theme: "dark", user: { id: "other" } })],
      ["a model preference", JSON.stringify({ theme: "dark", preferredModelId: "gpt-4o" })],
    ];

    for (const [label, body] of cases) {
      const response = await PUT(put(body));
      expect(response.status, label).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code, label).toBe(
        "INVALID_REQUEST",
      );
    }

    // None of the refused bodies reached the service.
    expect(fake.state.saved).toEqual([]);
  });

  it("names the unexpected field it refused", async () => {
    const response = await PUT(put(JSON.stringify({ theme: "dark", userId: "someone-else" })));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
      "userId",
    );
  });

  it("refuses a body that is not JSON, or is far too large, before parsing it", async () => {
    const notJson = await PUT(put("{}", { "content-type": "text/plain" }));
    expect(notJson.status).toBe(400);

    const oversized = await PUT(put(JSON.stringify({ theme: `dark${"x".repeat(5000)}` })));
    expect(oversized.status).toBe(400);
    expect(((await oversized.json()) as { error: { message: string } }).error.message).toMatch(
      /too large/i,
    );
    expect(fake.state.saved).toEqual([]);
  });

  it("requires a session", async () => {
    fake.state.user = null;

    const response = await PUT(put(JSON.stringify({ theme: "dark" })));
    expect(response.status).toBe(401);
    expect(fake.state.saved).toEqual([]);
  });

  it("rejects a cross-origin write", async () => {
    const response = await PUT(
      put(JSON.stringify({ theme: "dark" }), { origin: "https://evil.example" }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "FORBIDDEN_ORIGIN", message: "This request came from an untrusted origin." },
    });
    expect(fake.state.saved).toEqual([]);
  });

  it("rejects a cross-site write that carries no Origin header", async () => {
    // Browsers also report the relationship in Sec-Fetch-Site; a cross-site value
    // with no Origin at all is still refused.
    const response = await PUT(
      new Request(`${APP_URL}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
        body: JSON.stringify({ theme: "dark" }),
      }),
    );

    expect(response.status).toBe(403);
    expect(fake.state.saved).toEqual([]);
  });

  it("always writes to the session's own row", async () => {
    // Ownership is not a parameter of the route at all: even a body that names
    // another account is refused, and the service only ever sees the session id.
    await PUT(put(JSON.stringify({ theme: "dark", userId: "cmuser00000000000000009" })));
    await PUT(put(JSON.stringify({ theme: "light" })));

    expect(fake.state.saved).toEqual([{ userId: SESSION_USER.id, theme: "light" }]);
  });

  it("reports a refused write without pretending it was saved", async () => {
    fake.state.saveResult = { ok: false, reason: "invalid-theme" };

    const response = await PUT(put(JSON.stringify({ theme: "dark" })));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
      "That theme is not available.",
    );
  });

  it("reports a storage failure as a controlled error", async () => {
    fake.state.saveFails = true;

    const response = await PUT(put(JSON.stringify({ theme: "dark" })));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Something went wrong. Try again." },
    });
  });
});
