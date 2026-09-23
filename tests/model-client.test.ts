import { afterEach, describe, expect, it, vi } from "vitest";

const { requestModelSelection } = await import("../src/features/models/client");

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

describe("model selection client", () => {
  it("sends only the catalog key in a same-origin PUT", async () => {
    const calls = stubFetch(() => json({ selectedModelKey: "gpt-4o" }));

    await expect(requestModelSelection("gpt-4o")).resolves.toEqual({
      ok: true,
      selectedKey: "gpt-4o",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/models");
    expect(calls[0].init.method).toBe("PUT");
    expect(calls[0].init.credentials).toBe("same-origin");
    // No provider identifier, user id, or extra field is ever put on the wire.
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ modelKey: "gpt-4o" });
  });

  it("returns the server's own view of what is selected", async () => {
    stubFetch(() => json({ selectedModelKey: "claude-3.5-haiku" }));

    await expect(requestModelSelection("claude-3.7-sonnet")).resolves.toEqual({
      ok: true,
      selectedKey: "claude-3.5-haiku",
    });
  });

  it("surfaces the server's message and status when a change is refused", async () => {
    stubFetch(() =>
      json({ error: { code: "INVALID_REQUEST", message: "That model is not available." } }, 400),
    );

    await expect(requestModelSelection("llama-3.1-70b")).resolves.toEqual({
      ok: false,
      status: 400,
      message: "That model is not available.",
    });
  });

  it("reports a signed-out attempt as 401 so the shell can redirect", async () => {
    stubFetch(() =>
      json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } }, 401),
    );

    await expect(requestModelSelection("gpt-4o")).resolves.toEqual({
      ok: false,
      status: 401,
      message: "Sign in to continue.",
    });
  });

  it("falls back to a generic message for an unreadable or mistyped body", async () => {
    stubFetch(() => new Response("<html>error</html>", { status: 500 }));
    expect(await requestModelSelection("gpt-4o")).toEqual({
      ok: false,
      status: 500,
      message: "Something went wrong. Try again.",
    });

    stubFetch(() => json({ selectedModelKey: 42 }));
    const mistyped = await requestModelSelection("gpt-4o");
    expect(mistyped).toMatchObject({
      ok: false,
      status: 200,
      message: "Something went wrong. Try again.",
    });
    if (!mistyped.ok) expect(mistyped.message).toBe("Something went wrong. Try again.");
  });

  it("reports a transport failure as offline without throwing", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });

    const result = await requestModelSelection("gpt-4o");
    expect(result).toMatchObject({ ok: false, status: 0 });
    if (!result.ok) expect(result.message).toMatch(/couldn’t reach the server/i);
  });
});
