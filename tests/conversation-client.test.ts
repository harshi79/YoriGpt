import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  requestAssistantReply,
  requestDeleteConversation,
  requestNewConversation,
} from "../src/features/conversations/client";

const conversationId = "cm1a2b3c4d5e6f7g8h9i0jkl";
const stored = {
  id: "cm9z8y7x6w5v4u3t2s1r0qpo",
  role: "USER",
  content: "A stored thought.",
  position: 0,
  createdAt: "2026-09-23T10:00:00.000Z",
  updatedAt: "2026-09-23T10:00:00.000Z",
};

const summary = {
  id: "cm1a2b3c4d5e6f7g8h9i0jkl",
  title: "New chat",
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

describe("browser conversation requests", () => {
  it("creates a conversation with no client-controlled fields", async () => {
    const calls = stubFetch(
      () => new Response(JSON.stringify({ conversation: summary }), { status: 201 }),
    );

    const result = await requestNewConversation();
    expect(result).toEqual({ ok: true, value: summary });

    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.credentials).toBe("same-origin");
    expect(calls[0].request.headers.get("content-type")).toBe("application/json");
    expect(new URL(calls[0].request.url).pathname).toBe("/api/conversations");
    // No title, no owner, no timestamps: the server owns all of them.
    expect(await calls[0].request.text()).toBe("{}");
  });

  it("surfaces the server's error message without inventing success", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: { code: "INVALID_REQUEST", message: "Unsupported field: userId." } }), {
          status: 400,
        }),
    );

    const result = await requestNewConversation();
    expect(result).toEqual({ ok: false, status: 400, message: "Unsupported field: userId." });
  });

  it("reports unreachable servers and malformed success payloads", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const offline = await requestNewConversation();
    expect(offline).toEqual({ ok: false, status: 0, message: expect.stringContaining("reach the server") });

    stubFetch(() => new Response(JSON.stringify({ conversation: { id: 1 } }), { status: 201 }));
    const malformed = await requestNewConversation();
    expect(malformed.ok).toBe(false);
  });

  it("asks for a reply without sending any content, role, or model", async () => {
    const reply = { ...stored, id: "cmreply000000000000001", role: "ASSISTANT", position: 1 };
    const calls = stubFetch(
      () => new Response(JSON.stringify({ message: reply }), { status: 201 }),
    );

    expect(await requestAssistantReply(conversationId)).toEqual({ ok: true, value: reply });

    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.credentials).toBe("same-origin");
    expect(new URL(calls[0].request.url).pathname).toBe(
      `/api/conversations/${conversationId}/reply`,
    );
    // Generation is identified by the URL alone; no field can influence it.
    expect(await calls[0].request.text()).toBe("{}");
  });

  it("surfaces a truthful reply failure, including an unconfigured provider", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: { code: "AI_NOT_CONFIGURED", message: "AI replies are not configured on this server." },
          }),
          { status: 500 },
        ),
    );
    expect(await requestAssistantReply(conversationId)).toEqual({
      ok: false,
      status: 500,
      message: "AI replies are not configured on this server.",
    });

    stubFetch(() => new Response(null, { status: 502 }));
    const failed = await requestAssistantReply(conversationId);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.status).toBe(502);

    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    expect(await requestAssistantReply(conversationId)).toEqual({
      ok: false,
      status: 0,
      message: expect.stringContaining("reach the server"),
    });
  });

  it("does not treat a malformed reply payload as success", async () => {
    stubFetch(() => new Response(JSON.stringify({ message: { role: "ASSISTANT" } }), { status: 201 }));
    expect((await requestAssistantReply(conversationId)).ok).toBe(false);
  });

  it("deletes a conversation by id and treats 404 as a safe failure", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    expect(await requestDeleteConversation(summary.id)).toEqual({ ok: true, value: null });
    expect(calls[0].init?.method).toBe("DELETE");
    expect(new URL(calls[0].request.url).pathname).toBe(`/api/conversations/${summary.id}`);

    stubFetch(
      () =>
        new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Conversation not found." } }), {
          status: 404,
        }),
    );
    const missing = await requestDeleteConversation(summary.id);
    expect(missing).toEqual({ ok: false, status: 404, message: "Conversation not found." });
  });
});

describe("client/server boundary", () => {
  it("keeps the browser module free of secrets and server imports", () => {
    const sources = ["src/features/conversations/client.ts", "src/features/conversations/types.ts"].map((file) =>
      readFileSync(file, "utf8"),
    );
    for (const source of sources) {
      for (const forbidden of ["process.env", "DATABASE_URL", "AUTH_SECRET", "@prisma", "@/server", "server-only"]) {
        expect(source).not.toContain(forbidden);
      }
    }
    expect(sources[0].startsWith('"use client"')).toBe(true);
    // Memory + message access stays on the server.
    expect(readFileSync("src/server/conversations/service.ts", "utf8").startsWith('import "server-only"')).toBe(true);
  });
});
