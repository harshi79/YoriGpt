import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { requestUserMessage } from "../src/features/conversations/client";

const conversationId = "cm1a2b3c4d5e6f7g8h9i0jkl";
const stored = {
  id: "cm9z8y7x6w5v4u3t2s1r0qpo",
  role: "USER",
  content: "A stored thought.",
  position: 0,
  createdAt: "2026-09-23T10:00:00.000Z",
  updatedAt: "2026-09-23T10:00:00.000Z",
};

function stubFetch(handler: (request: Request) => Promise<Response> | Response) {
  const calls: { request: Request; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    // The browser resolves relative URLs against the page origin; Node's Request
    // requires an absolute URL, so the stub does the same resolution.
    const request = new Request(new URL(String(input), "http://localhost:3000"), init);
    calls.push({ request, init });
    return handler(request);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser message requests", () => {
  it("posts only the message text to the conversation's message endpoint", async () => {
    const calls = stubFetch(
      () => new Response(JSON.stringify({ message: stored }), { status: 201 }),
    );

    const result = await requestUserMessage(conversationId, "A stored thought.");
    expect(result).toEqual({ ok: true, value: stored });

    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.credentials).toBe("same-origin");
    expect(calls[0].request.headers.get("content-type")).toBe("application/json");
    expect(new URL(calls[0].request.url).pathname).toBe(
      `/api/conversations/${conversationId}/messages`,
    );
    // No owner, role, position, id, or timestamps: the server owns all of them.
    expect(JSON.parse(await calls[0].request.text())).toEqual({ content: "A stored thought." });
  });

  it("surfaces the server's error message and never invents success", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: "NOT_FOUND", message: "Conversation not found." } }),
          { status: 404 },
        ),
    );
    expect(await requestUserMessage(conversationId, "Hello")).toEqual({
      ok: false,
      status: 404,
      message: "Conversation not found.",
    });

    stubFetch(() => new Response(JSON.stringify({ error: {} }), { status: 401 }));
    const unauthorized = await requestUserMessage(conversationId, "Hello");
    expect(unauthorized).toMatchObject({ ok: false, status: 401 });
    expect(unauthorized.ok === false && unauthorized.message).not.toBe("");

    stubFetch(() => new Response(JSON.stringify(null), { status: 201 }));
    expect((await requestUserMessage(conversationId, "Hello")).ok).toBe(false);
  });

  it("reports an unreachable server instead of pretending the message was stored", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const result = await requestUserMessage(conversationId, "Hello");
    expect(result).toEqual({
      ok: false,
      status: 0,
      message: expect.stringContaining("reach the server"),
    });
  });
});

describe("message client/server boundary", () => {
  it("keeps message access on the server and the browser module secret-free", () => {
    for (const file of [
      "src/server/messages/service.ts",
      "src/server/messages/request.ts",
      "src/server/messages/view.ts",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source.startsWith('import "server-only"'), file).toBe(true);
      // Queries go through Prisma's typed client, never hand-built SQL.
      expect(source, file).not.toMatch(/\$queryRaw|\$executeRaw/);
    }

    const client = readFileSync("src/features/conversations/client.ts", "utf8");
    for (const forbidden of [
      "process.env",
      "DATABASE_URL",
      "AUTH_SECRET",
      "@prisma",
      "@/server",
      "server-only",
    ]) {
      expect(client).not.toContain(forbidden);
    }
    expect(client.startsWith('"use client"')).toBe(true);
  });
});
