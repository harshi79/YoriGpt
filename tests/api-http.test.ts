import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { isTrustedRequestOrigin, trustedOrigins, notFoundResponse, jsonResponse } = await import(
  "../src/server/api/http"
);

const SECRET = "conversation-test-secret-value-long-enough";

function post(headers: Record<string, string>) {
  return new Request("http://localhost:3000/api/conversations", { method: "POST", headers });
}

function configure(options: { appUrl?: string; trusted?: string } = {}) {
  vi.stubEnv("APP_URL", options.appUrl ?? "http://localhost:3000");
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("AUTH_TRUSTED_ORIGINS", options.trusted ?? "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("request origin checks for state-changing routes", () => {
  it("accepts the application origin and configured extra origins", () => {
    configure({ trusted: "https://preview.example.com,https://*.e2b.app" });
    expect(isTrustedRequestOrigin(post({ origin: "http://localhost:3000" }))).toBe(true);
    expect(isTrustedRequestOrigin(post({ origin: "https://preview.example.com" }))).toBe(true);
    expect(isTrustedRequestOrigin(post({ origin: "https://3000-abc.e2b.app" }))).toBe(true);
  });

  it("rejects another site's origin", () => {
    configure({ trusted: "https://*.e2b.app" });
    expect(isTrustedRequestOrigin(post({ origin: "https://evil.example.com" }))).toBe(false);
    // A lookalike host must not pass the wildcard.
    expect(isTrustedRequestOrigin(post({ origin: "https://e2b.app.evil.example.com" }))).toBe(false);
    expect(isTrustedRequestOrigin(post({ origin: "https://not-e2b.app" }))).toBe(false);
  });

  it("rejects a cross-site browser request and allows non-browser callers", () => {
    configure();
    expect(isTrustedRequestOrigin(post({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isTrustedRequestOrigin(post({ "sec-fetch-site": "same-origin" }))).toBe(true);
    // Scripts and tests send neither header and cannot be driven by another page.
    expect(isTrustedRequestOrigin(post({}))).toBe(true);
  });

  it("normalizes stored origins and ignores unusable configuration", () => {
    configure({ trusted: "https://preview.example.com/" });
    expect(trustedOrigins()).toEqual(["http://localhost:3000", "https://preview.example.com"]);
    configure({ appUrl: "http://localhost:3100", trusted: "" });
    expect(trustedOrigins()).toEqual(["http://localhost:3100"]);
  });
});

describe("JSON response envelope", () => {
  it("wraps errors with a code and never caches API answers", async () => {
    const response = notFoundResponse();
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Conversation not found." },
    });
  });

  it("returns plain JSON bodies for successful payloads", async () => {
    const response = jsonResponse({ conversations: [], truncated: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ conversations: [], truncated: false });
  });
});
