import { afterEach, describe, expect, it, vi } from "vitest";

const { requestThemePreference } = await import("../src/features/settings/client");

type FetchCall = { url: string; init: RequestInit };

/** Stubs fetch and captures what the browser actually sent. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  });
  return calls;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * The browser call for the theme preference: it sends one field, adopts the
 * server's answer, and maps every failure onto a message the page can show.
 */
describe("theme preference client", () => {
  it("sends only the theme in a same-origin PUT", async () => {
    const calls = stubFetch(() => json({ theme: "dark" }));

    await expect(requestThemePreference("dark")).resolves.toEqual({ ok: true, theme: "dark" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/settings");
    expect(calls[0].init.method).toBe("PUT");
    expect(calls[0].init.credentials).toBe("same-origin");
    // No user id, and nothing but the theme, is ever put on the wire.
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ theme: "dark" });
  });

  it("adopts the server's own answer", async () => {
    stubFetch(() => json({ theme: "system" }));

    await expect(requestThemePreference("light")).resolves.toEqual({ ok: true, theme: "system" });
  });

  it("surfaces the server's message and status when a change is refused", async () => {
    stubFetch(() =>
      json({ error: { code: "INVALID_REQUEST", message: "Theme must be one of: system, dark, light." } }, 400),
    );

    await expect(requestThemePreference("dark")).resolves.toEqual({
      ok: false,
      status: 400,
      message: "Theme must be one of: system, dark, light.",
    });
  });

  it("reports a signed-out attempt as 401 so the page can redirect", async () => {
    stubFetch(() => json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } }, 401));

    await expect(requestThemePreference("dark")).resolves.toEqual({
      ok: false,
      status: 401,
      message: "Sign in to continue.",
    });
  });

  it("refuses to treat an unexpected response as a saved theme", async () => {
    stubFetch(() => json({ theme: "SEPIA" }));

    const result = await requestThemePreference("dark");
    expect(result.ok).toBe(false);
  });

  it("reports a failed request without pretending the theme changed", async () => {
    stubFetch(() => {
      throw new TypeError("network down");
    });

    await expect(requestThemePreference("light")).resolves.toEqual({
      ok: false,
      status: 0,
      message: "We couldn’t reach the server. Check your connection and try again.",
    });
  });

  it("falls back to a generic message when the error body is not JSON", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));

    await expect(requestThemePreference("light")).resolves.toEqual({
      ok: false,
      status: 500,
      message: "Something went wrong. Try again.",
    });
  });
});
