import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { parseCreateConversationRequest } = await import("../src/server/conversations/request");
const { parseCreateMessageRequest, parseReplyRequest } = await import("../src/server/messages/request");
const { parseModelSelectionRequest } = await import("../src/server/ai/models/request");
const { parsePetSelectionRequest, parsePetAppearanceRequest, parsePetPersonalityRequest } =
  await import("../src/server/pets/request");
const { parseSettingsRequest } = await import("../src/server/settings/request");

/** A valid small object with unbounded padding is still an oversized HTTP body. */
function paddedRequest(json: string): Request {
  return new Request("http://localhost:3000/api/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: json + " ".repeat(20_000),
  });
}

describe("request body limits before trimming or parsing", () => {
  it.each([
    ["conversation", parseCreateConversationRequest, "{}"],
    ["user message", parseCreateMessageRequest, '{"content":"Hello"}'],
    ["assistant reply", parseReplyRequest, "{}"],
    ["model", parseModelSelectionRequest, '{"modelKey":"gpt-4o"}'],
    ["pet", parsePetSelectionRequest, '{"pet":"yori-cat"}'],
    ["appearance", parsePetAppearanceRequest, '{"appearance":"night"}'],
    ["personality", parsePetPersonalityRequest, '{"personality":"calm"}'],
    ["theme", parseSettingsRequest, '{"theme":"dark"}'],
  ])("rejects an oversized %s request without accepting its trimmed value", async (_name, parse, json) => {
    expect((await parse(paddedRequest(json))).ok).toBe(false);
  });

  it("stops an unbounded upload even when Content-Length claims it is small", async () => {
    let reads = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(new Uint8Array(4097));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    // Node requires `duplex` for a streaming Request body; keep it on a variable
    // because the DOM RequestInit type does not declare this Node-specific field.
    const init = {
      method: "PUT",
      headers: { "content-type": "application/json", "content-length": "1" },
      body,
      duplex: "half" as const,
    };
    const request = new Request("http://localhost:3000/api/models", init);

    expect((await parseModelSelectionRequest(request)).ok).toBe(false);
    expect(reads).toBe(1);
    expect(cancelled).toBe(true);
  });
});
