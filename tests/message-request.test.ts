import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { MAX_MESSAGE_LENGTH, parseCreateMessageRequest, parseReplyRequest } = await import(
  "../src/server/messages/request"
);

function body(value: string, contentType = "application/json") {
  return new Request("http://localhost:3000/api/conversations/cm1a2b3c/messages", {
    method: "POST",
    headers: { "content-type": contentType },
    body: value,
  });
}

function json(value: unknown) {
  return body(JSON.stringify(value));
}

describe("create-message request parsing", () => {
  it("accepts content and trims only the surrounding whitespace", async () => {
    await expect(parseCreateMessageRequest(json({ content: "  Hello there  " }))).resolves.toEqual({
      ok: true,
      content: "Hello there",
    });
    // Blank lines and indentation inside the message are the author's text.
    await expect(
      parseCreateMessageRequest(json({ content: "First line\n\n  second line  " })),
    ).resolves.toEqual({ ok: true, content: "First line\n\n  second line" });
    await expect(
      parseCreateMessageRequest(json({ content: "x".repeat(MAX_MESSAGE_LENGTH) })),
    ).resolves.toMatchObject({ ok: true });
  });

  it("requires content", async () => {
    expect(await parseCreateMessageRequest(body(""))).toEqual({
      ok: false,
      message: "Message content is required.",
    });
    expect((await parseCreateMessageRequest(json({}))).ok).toBe(false);
    expect((await parseCreateMessageRequest(json({ content: "" }))).ok).toBe(false);
    expect((await parseCreateMessageRequest(json({ content: "   \n\t " }))).ok).toBe(false);
  });

  it("rejects non-string and oversized content without truncating it", async () => {
    for (const content of [42, null, true, ["Hello"], { text: "Hello" }]) {
      expect((await parseCreateMessageRequest(json({ content }))).ok).toBe(false);
    }

    const oversized = await parseCreateMessageRequest(
      json({ content: "x".repeat(MAX_MESSAGE_LENGTH + 1) }),
    );
    expect(oversized).toEqual({
      ok: false,
      message: `Message content must be ${MAX_MESSAGE_LENGTH} characters or fewer.`,
    });
  });

  it("refuses fields the client must never set, including ownership and ordering", async () => {
    for (const field of [
      "id",
      "userId",
      "conversationId",
      "role",
      "position",
      "createdAt",
      "updatedAt",
    ]) {
      const parsed = await parseCreateMessageRequest(
        json({ content: "Hello", [field]: field === "position" ? 0 : "x" }),
      );
      expect(parsed, field).toEqual({ ok: false, message: `Unsupported field: ${field}.` });
    }

    const parsed = await parseCreateMessageRequest(
      json({ content: "Hello", userId: "someone-else", role: "ASSISTANT", position: 7 }),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain("Unsupported fields: userId, role, position.");
  });

  it("refuses an oversized payload before reading it", async () => {
    // 4000 four-byte characters still fit; anything larger cannot be a valid body.
    const tooLarge = new Request("http://localhost:3000/api/conversations/cm1a2b3c/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(MAX_MESSAGE_LENGTH * 4 + 2000) },
      body: "{}",
    });
    expect(await parseCreateMessageRequest(tooLarge)).toEqual({
      ok: false,
      message: `Message content must be ${MAX_MESSAGE_LENGTH} characters or fewer.`,
    });
  });

  it("refuses malformed JSON, wrong shapes, and non-JSON payloads", async () => {
    expect((await parseCreateMessageRequest(body("{not json"))).ok).toBe(false);
    expect((await parseCreateMessageRequest(body('"Hello"'))).ok).toBe(false);
    expect((await parseCreateMessageRequest(body('["Hello"]'))).ok).toBe(false);
    expect(
      (await parseCreateMessageRequest(body("content=Hello", "application/x-www-form-urlencoded"))).ok,
    ).toBe(false);
    // A JSON body without the JSON content type is rejected as well.
    expect((await parseCreateMessageRequest(body('{"content":"Hi"}', "text/plain"))).ok).toBe(false);
  });
});

describe("reply request parsing", () => {
  it("accepts an empty body because the URL identifies the conversation", async () => {
    await expect(parseReplyRequest(body(""))).resolves.toEqual({ ok: true });
    await expect(parseReplyRequest(json({}))).resolves.toEqual({ ok: true });
  });

  it("refuses every field, including an attempted role, owner, or content", async () => {
    // `pet` and `personality` are in the list because the reply flow resolves a
    // companion context server-side: a body field claiming one is refused here, so the
    // only companion a reply can carry is the account's own stored selection.
    for (const field of [
      "content",
      "role",
      "userId",
      "position",
      "model",
      "prompt",
      "temperature",
      "pet",
      "personality",
      "petPersonality",
    ]) {
      const parsed = await parseReplyRequest(json({ [field]: "x" }));
      expect(parsed, field).toEqual({ ok: false, message: `Unsupported field: ${field}.` });
    }

    const parsed = await parseReplyRequest(json({ role: "ASSISTANT", content: "Injected" }));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain("role");
  });

  it("refuses malformed JSON and non-object bodies", async () => {
    expect((await parseReplyRequest(body("{oops"))).ok).toBe(false);
    expect((await parseReplyRequest(body('"reply"'))).ok).toBe(false);
    expect((await parseReplyRequest(body("[]"))).ok).toBe(false);
  });
});
