import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { isValidConversationId, parseCreateConversationRequest } = await import(
  "../src/server/conversations/request"
);

function body(value: string, contentType = "application/json") {
  return new Request("http://localhost:3000/api/conversations", {
    method: "POST",
    headers: { "content-type": contentType },
    body: value,
  });
}

describe("conversation id validation", () => {
  it("accepts generated-looking ids and rejects junk", () => {
    expect(isValidConversationId("cm1a2b3c4d5e6f7g8h9i0jkl")).toBe(true);
    expect(isValidConversationId("abc")).toBe(false);
    expect(isValidConversationId("has space")).toBe(false);
    expect(isValidConversationId("../../etc/passwd")).toBe(false);
    expect(isValidConversationId("a".repeat(80))).toBe(false);
  });
});

describe("create-conversation request parsing", () => {
  it("uses the default title when no body or no fields are sent", async () => {
    await expect(parseCreateConversationRequest(body(""))).resolves.toEqual({
      ok: true,
      title: "New chat",
    });
    await expect(parseCreateConversationRequest(body("{}"))).resolves.toEqual({
      ok: true,
      title: "New chat",
    });
  });

  it("accepts a trimmed title and rejects empty or oversized ones", async () => {
    await expect(parseCreateConversationRequest(body('{"title":"  Trip planning  "}'))).resolves.toEqual({
      ok: true,
      title: "Trip planning",
    });
    expect((await parseCreateConversationRequest(body('{"title":"   "}'))).ok).toBe(false);
    expect((await parseCreateConversationRequest(body(JSON.stringify({ title: "x".repeat(201) })))).ok).toBe(false);
    expect((await parseCreateConversationRequest(body(JSON.stringify({ title: "x".repeat(200) })))).ok).toBe(true);
    expect((await parseCreateConversationRequest(body('{"title":42}'))).ok).toBe(false);
  });

  it("refuses fields the client must never set, including ownership", async () => {
    const ownership = await parseCreateConversationRequest(
      body(JSON.stringify({ title: "Mine", userId: "someone-else" })),
    );
    expect(ownership).toEqual({ ok: false, message: "Unsupported field: userId." });

    const timestamps = await parseCreateConversationRequest(
      body(JSON.stringify({ createdAt: "2000-01-01T00:00:00.000Z", updatedAt: "2000-01-01T00:00:00.000Z" })),
    );
    expect(timestamps.ok).toBe(false);
  });

  it("refuses malformed JSON, wrong shapes, and non-JSON payloads", async () => {
    expect((await parseCreateConversationRequest(body("{not json"))).ok).toBe(false);
    expect((await parseCreateConversationRequest(body('["title"]'))).ok).toBe(false);
    expect((await parseCreateConversationRequest(body('"title"'))).ok).toBe(false);
    expect(
      (await parseCreateConversationRequest(body('title=New+chat', "application/x-www-form-urlencoded"))).ok,
    ).toBe(false);
  });
});
