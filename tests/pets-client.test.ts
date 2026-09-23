import { afterEach, describe, expect, it, vi } from "vitest";

const { requestPetSelection, requestPetAppearance } = await import(
  "../src/features/pets/client"
);

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
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

describe("the pet selection client", () => {
  it("sends only the pet key in a same-origin PUT", async () => {
    const calls = stubFetch(() => json({ pet: "ember-fox" }));

    await expect(requestPetSelection("ember-fox")).resolves.toEqual({ ok: true, pet: "ember-fox" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/settings/pet");
    expect(calls[0].init.method).toBe("PUT");
    expect(calls[0].init.credentials).toBe("same-origin");
    // No user id, nothing but the pet key.
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ pet: "ember-fox" });
  });

  it("surfaces the server's message when a change is refused", async () => {
    stubFetch(() =>
      json({ error: { code: "INVALID_REQUEST", message: "That pet is not available." } }, 400),
    );
    await expect(requestPetSelection("pip-rabbit")).resolves.toEqual({
      ok: false,
      status: 400,
      message: "That pet is not available.",
    });
  });

  it("reports a signed-out attempt as 401", async () => {
    stubFetch(() => json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } }, 401));
    await expect(requestPetSelection("ember-fox")).resolves.toEqual({
      ok: false,
      status: 401,
      message: "Sign in to continue.",
    });
  });

  it("refuses to treat an unexpected response as a saved pet", async () => {
    stubFetch(() => json({ pet: "" }));
    const result = await requestPetSelection("ember-fox");
    expect(result.ok).toBe(false);
  });

  it("reports a failed request without pretending the pet changed", async () => {
    stubFetch(() => {
      throw new TypeError("network down");
    });
    await expect(requestPetSelection("ember-fox")).resolves.toEqual({
      ok: false,
      status: 0,
      message: "We couldn’t reach the server. Check your connection and try again.",
    });
  });
});

describe("the pet appearance client", () => {
  it("sends only the appearance key in a same-origin PUT", async () => {
    const calls = stubFetch(() => json({ pet: "yori-cat", appearance: "night" }));

    await expect(requestPetAppearance("night")).resolves.toEqual({
      ok: true,
      pet: "yori-cat",
      appearance: "night",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/settings/pet/appearance");
    expect(calls[0].init.method).toBe("PUT");
    expect(calls[0].init.credentials).toBe("same-origin");
    // No user id, nothing but the appearance key.
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ appearance: "night" });
  });

  it("surfaces the server's message when an appearance is refused", async () => {
    stubFetch(() =>
      json(
        { error: { code: "INVALID_REQUEST", message: "That appearance is not available for this pet." } },
        400,
      ),
    );
    await expect(requestPetAppearance("ember")).resolves.toEqual({
      ok: false,
      status: 400,
      message: "That appearance is not available for this pet.",
    });
  });

  it("refuses to treat an unexpected response as a saved appearance", async () => {
    stubFetch(() => json({ pet: "yori-cat", appearance: "" }));
    const result = await requestPetAppearance("night");
    expect(result.ok).toBe(false);
  });

  it("reports a failed request without pretending the appearance changed", async () => {
    stubFetch(() => {
      throw new TypeError("network down");
    });
    await expect(requestPetAppearance("night")).resolves.toEqual({
      ok: false,
      status: 0,
      message: "We couldn’t reach the server. Check your connection and try again.",
    });
  });
});
