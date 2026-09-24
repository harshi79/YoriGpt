import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * One in-process smoke through the real route, pet resolver/instruction, dispatcher,
 * provider adapters, SSE reader and persistence boundary. Only session, preference
 * and database I/O are faked; there is no PostgreSQL, external request or real key.
 */
const fake = vi.hoisted(() => ({
  user: { id: "smoke-user" } as { id: string } | null,
  conversationId: "smoke-conversation-00001",
  model: "gpt-4o-mini",
  pet: "yori-cat",
  personality: "calm",
  messages: [] as Array<{ id: string; role: "USER" | "ASSISTANT"; content: string; position: number;
    createdAt: string; updatedAt: string }>,
  writes: [] as string[],
}));

vi.mock("../src/server/auth/session", () => ({ getCurrentUser: async () => fake.user }));
vi.mock("../src/server/ai/models/service", () => ({ resolveReplyModelKey: async () => fake.model }));
vi.mock("../src/server/pets/service", () => ({
  loadCompanion: async () => ({ pet: fake.pet, personality: fake.personality, appearance: "classic" }),
}));
vi.mock("../src/server/messages/service", () => ({
  listMessages: async (userId: string, conversationId: string) =>
    userId === fake.user?.id && conversationId === fake.conversationId
      ? { messages: [...fake.messages], truncated: false } : null,
  createAssistantMessage: async (userId: string, conversationId: string, text: string, answeredId: string) => {
    if (userId !== fake.user?.id || conversationId !== fake.conversationId)
      return { ok: false, reason: "not-found" };
    if (fake.messages.at(-1)?.id !== answeredId) return { ok: false, reason: "stale" };
    const message = {
      id: `smoke-reply-${fake.writes.length}`, role: "ASSISTANT" as const,
      content: text, position: fake.messages.length,
      createdAt: "2026-09-24T00:00:01.000Z", updatedAt: "2026-09-24T00:00:01.000Z",
    };
    fake.messages.push(message);
    fake.writes.push(text);
    return { ok: true, message };
  },
}));

const { POST } = await import("../src/app/api/conversations/[id]/reply/route");
const { readReplyStream } = await import("../src/features/conversations/stream");
const { resetKeyPools } = await import("../src/server/ai/key-pool");
const { buildPetAiInstruction } = await import("../src/server/ai/pet-instruction");
const { resolvePet, resolvePersonalityForPet } = await import("../src/features/pets/catalog");
const { toAiPetContext } = await import("../src/server/ai/pet-context");

const OPENROUTER_FIRST = "smoke-openrouter-first-not-a-secret";
const OPENROUTER_SECOND = "smoke-openrouter-second-not-a-secret";
const NVIDIA_KEY = "smoke-nvidia-only-not-a-secret";
const timestamp = "2026-09-24T00:00:00.000Z";

function startTurn(content = "Explain a safe concept") {
  fake.messages = [{
    id: "smoke-message-00001", role: "USER", content, position: 0,
    createdAt: timestamp, updatedAt: timestamp,
  }];
  fake.writes = [];
}

function replyRequest(accept: string, conversationId = fake.conversationId) {
  return POST(new Request(`http://localhost:3000/api/conversations/${conversationId}/reply`, {
    method: "POST", headers: { origin: "http://localhost:3000", accept }, body: "{}",
  }), { params: Promise.resolve({ id: conversationId }) });
}

function frame(text: string) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

beforeEach(() => {
  resetKeyPools();
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("AUTH_SECRET", "smoke-test-secret-value-long-enough-not-a-secret");
  vi.stubEnv("AUTH_TRUSTED_ORIGINS", "");
  vi.stubEnv("OPENROUTER_API_KEYS", `${OPENROUTER_FIRST},${OPENROUTER_SECOND}`);
  vi.stubEnv("OPENROUTER_BASE_URL", "https://openrouter.test/api/v1");
  vi.stubEnv("NVIDIA_API_KEYS", NVIDIA_KEY);
  vi.stubEnv("NVIDIA_BASE_URL", "https://nvidia.test/v1");
  fake.user = { id: "smoke-user" };
  fake.model = "gpt-4o-mini";
  fake.pet = "yori-cat";
  fake.personality = "calm";
  startTurn();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  resetKeyPools();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mocked production reply flow", () => {
  it("rotates OpenRouter before its first delta, refuses a later error, then routes JSON to NVIDIA", async () => {
    const requests: Array<{ url: string; authorization: string; body: {
      model: string; stream: boolean; messages: Array<{ role: string; content: string }> } }> = [];
    let mode: "success" | "error" = "success";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      const body = JSON.parse(String(init?.body)) as (typeof requests)[number]["body"];
      const url = String(input);
      requests.push({ url, authorization, body });
      if (url.startsWith("https://openrouter.test/")) {
        if (authorization === `Bearer ${OPENROUTER_FIRST}`) return new Response("", { status: 429 });
        return new Response(
          mode === "success"
            ? `${frame("Useful ")}${frame("answer.")}data: [DONE]\n\n`
            : `${frame("Provisional")}${`data: ${JSON.stringify({ error: { message: `error for ${OPENROUTER_SECOND}` } })}\n\n`}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.startsWith("https://nvidia.test/")) {
        return Response.json({ choices: [{ message: { content: "NVIDIA answer" }, finish_reason: "stop" }] });
      }
      throw new Error("Unexpected provider endpoint");
    });

    const deltas: string[] = [];
    const streamed = await replyRequest("text/event-stream");
    expect(streamed.status).toBe(200);
    const streamedResult = await readReplyStream(streamed.body!, { onDelta: (text) => deltas.push(text) });
    expect(streamedResult).toMatchObject({ ok: true, message: { content: "Useful answer.", role: "ASSISTANT" } });
    expect(deltas).toEqual(["Useful ", "answer."]);
    expect(fake.writes).toEqual(["Useful answer."]);
    expect(requests.map((call) => call.authorization)).toEqual([
      `Bearer ${OPENROUTER_FIRST}`, `Bearer ${OPENROUTER_SECOND}`,
    ]);
    expect(requests[0].body).toEqual(requests[1].body);
    expect(requests[1].body.model).toBe("openai/gpt-4o-mini");
    expect(requests[1].body.stream).toBe(true);
    const calm = buildPetAiInstruction(toAiPetContext(
      resolvePet(fake.pet), resolvePersonalityForPet(fake.pet, fake.personality),
    )).systemInstruction;
    expect(requests[1].body.messages).toEqual([
      { role: "system", content: calm },
      { role: "user", content: "Explain a safe concept" },
    ]);
    expect(JSON.stringify(requests[1].body)).not.toMatch(/uiPreferences|appearance|smoke-user|password/i);

    // A provider error after text must not become a persisted partial reply or a
    // retry on another key, even when the provider also sends a [DONE] marker.
    startTurn();
    resetKeyPools();
    requests.length = 0;
    mode = "error";
    const failedDeltas: string[] = [];
    const failed = await replyRequest("text/event-stream");
    const failure = await readReplyStream(failed.body!, { onDelta: (text) => failedDeltas.push(text) });
    expect(failedDeltas).toEqual(["Provisional"]);
    expect(failure).toMatchObject({ ok: false, code: "INTERNAL_ERROR" });
    expect(JSON.stringify(failure)).not.toContain(OPENROUTER_SECOND);
    expect(requests).toHaveLength(2); // the first key was rejected, no mid-stream switch
    expect(fake.writes).toEqual([]);

    // The model preference selects another adapter. It receives the *new* pet's
    // trusted style and its own key, but the JSON route/persistence shape is the same.
    requests.length = 0;
    fake.model = "nvidia-llama-3.3-70b";
    fake.pet = "ember-fox";
    fake.personality = "playful";
    const json = await replyRequest("application/json");
    expect(json.status).toBe(201);
    expect(await json.json()).toMatchObject({ message: { role: "ASSISTANT", content: "NVIDIA answer" } });
    expect(fake.writes).toEqual(["NVIDIA answer"]);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://nvidia.test/v1/chat/completions");
    expect(requests[0].authorization).toBe(`Bearer ${NVIDIA_KEY}`);
    expect(requests[0].body.model).toBe("meta/llama-3.3-70b-instruct");
    expect(requests[0].body.stream).toBe(false);
    expect(requests[0].body.messages[0]).toEqual({
      role: "system",
      content: buildPetAiInstruction(toAiPetContext(
        resolvePet(fake.pet), resolvePersonalityForPet(fake.pet, fake.personality),
      )).systemInstruction,
    });
    expect(requests[0].body.messages[0].content).not.toBe(calm);
    expect(JSON.stringify(requests[0].body)).not.toMatch(/uiPreferences|appearance|smoke-user|password/i);
  });
});
