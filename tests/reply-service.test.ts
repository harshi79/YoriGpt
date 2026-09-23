import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
vi.mock("server-only", () => ({}));

/**
 * Reply generation is exercised with a fake database and a mocked provider, so
 * no network call happens and the stored rows can be inspected directly. Real
 * PostgreSQL behavior is covered by the database suite.
 */
const fake = vi.hoisted(() => {
  const state = {
    conversation: {
      id: "cmconversation000000001",
      title: "New chat",
      createdAt: new Date("2026-09-23T09:00:00.000Z"),
      updatedAt: new Date("2026-09-23T09:00:00.000Z"),
    } as {
      id: string;
      title: string;
      createdAt: Date;
      updatedAt: Date;
    } | null,
    storedMessages: [] as {
      id: string;
      role: "USER" | "ASSISTANT" | "SYSTEM";
      content: string;
      position: number;
      createdAt: Date;
      updatedAt: Date;
    }[],
    ownedCount: 1,
    created: [] as { role: string; content: string; position: number }[],
    lastPosition: null as number | null,
    // Set to simulate another writer having changed the newest row between the
    // history read and the insert transaction.
    racedLatest: null as { id: string; position: number } | null,
  };
  const tx = {
    conversation: {
      updateMany: async () => ({ count: state.ownedCount }),
    },
    message: {
      findFirst: async () =>
        state.racedLatest ?? {
          id: state.storedMessages.at(-1)?.id ?? null,
          position: state.lastPosition,
        },
      create: async (args: { data: { role: string; content: string; position: number } }) => {
        state.created.push(args.data);
        const now = new Date("2026-09-23T10:00:00.000Z");
        return { id: "cmreply000000000000001", createdAt: now, updatedAt: now, ...args.data };
      },
    },
  };
  return {
    state,
    db: {
      conversation: { findFirst: async () => state.conversation },
      // The real query reads newest-first (`orderBy: position desc`) and the
      // service reverses it, so the fake has to match that order.
      message: {
        findMany: async () =>
          [...state.storedMessages].sort((a, b) => b.position - a.position),
      },
      $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
    },
  };
});

vi.mock("../src/server/db/client", () => ({ getDb: () => fake.db }));
// The model preference comes from its own service; the reply tests choose it directly.
const models = vi.hoisted(() => ({ state: { key: "gpt-4o-mini" } }));
vi.mock("../src/server/ai/models/service", () => ({
  resolveReplyModelKey: async () => models.state.key,
}));
vi.mock("../src/server/ai/providers/openrouter", () => ({
  openRouterProvider: { name: "openrouter", generateReply: vi.fn(), streamReply: vi.fn() },
  generateReply: vi.fn(),
}));

const provider = await import("../src/server/ai/providers/openrouter");
const { AiNotConfiguredError, AiProviderError } = await import("../src/server/ai/errors");
const {
  buildProviderTurns,
  generateAssistantReply,
  prepareReply,
  streamAssistantReply,
  REPLY_HISTORY_MAX_MESSAGES,
} = await import("../src/server/messages/reply");

const userId = "cmuser00000000000000001";
const conversationId = "cmconversation000000001";
const generateReply = vi.mocked(provider.openRouterProvider.generateReply);
const streamReply = vi.mocked(provider.openRouterProvider.streamReply);

/** A row as Prisma would return it: timestamp columns are real `Date` objects. */
type Row = {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
};

function message(overrides: Partial<Row> & { position: number }): Row {
  return {
    id: `cmessage${String(overrides.position).padStart(4, "0")}000000`,
    role: "USER",
    content: `Message ${overrides.position}`,
    createdAt: new Date("2026-09-23T10:00:00.000Z"),
    updatedAt: new Date("2026-09-23T10:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  models.state.key = "gpt-4o-mini";
  fake.state.conversation = {
    id: conversationId,
    title: "New chat",
    createdAt: new Date("2026-09-23T09:00:00.000Z"),
    updatedAt: new Date("2026-09-23T09:00:00.000Z"),
  };
  fake.state.storedMessages = [];
  fake.state.ownedCount = 1;
  fake.state.created = [];
  fake.state.lastPosition = null;
  fake.state.racedLatest = null;
});

describe("provider history", () => {
  it("maps stored roles in order and drops database-only fields", () => {
    const turns = buildProviderTurns([
      message({ position: 0, role: "USER", content: "Hello" }),
      message({ position: 1, role: "ASSISTANT", content: "Hi there" }),
      message({ position: 2, role: "SYSTEM", content: "Ignored" }),
      message({ position: 3, role: "USER", content: "How are you?" }),
    ]);

    expect(turns).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" },
    ]);
    expect(JSON.stringify(turns)).not.toContain("position");
  });

  it("keeps the newest turns within the size limits, oldest-first", () => {
    const many = Array.from({ length: REPLY_HISTORY_MAX_MESSAGES + 10 }, (_, index) =>
      message({ position: index, content: `Turn ${index}` }),
    );

    const turns = buildProviderTurns(many);
    expect(turns).toHaveLength(REPLY_HISTORY_MAX_MESSAGES);
    expect(turns.at(-1)?.content).toBe(`Turn ${many.length - 1}`);
    expect(turns[0].content).not.toBe("Turn 0");

    // A character budget also applies, and the newest turn is never dropped.
    const long = Array.from({ length: 5 }, (_, index) =>
      message({ position: index, content: "x".repeat(10_000) }),
    );
    const budgeted = buildProviderTurns(long);
    expect(budgeted.at(-1)?.content).toHaveLength(10_000);
    expect(budgeted.length).toBeLessThan(long.length);
  });
});

describe("assistant reply generation", () => {
  it("answers with the provider text stored as a server-derived ASSISTANT row", async () => {
    fake.state.storedMessages = [message({ position: 0, role: "USER", content: "Hello" })];
    fake.state.lastPosition = 0;
    generateReply.mockResolvedValue("A stored answer");

    const result = await generateAssistantReply(userId, conversationId);

    // The provider receives only the stored conversation and the server-resolved
    // catalog key — never any client value.
    expect(generateReply).toHaveBeenCalledWith([{ role: "user", content: "Hello" }], {
      model: "gpt-4o-mini",
    });
    expect(fake.state.created).toEqual([
      { conversationId, role: "ASSISTANT", content: "A stored answer", position: 1 },
    ]);
    expect(result).toMatchObject({
      ok: true,
      message: { role: "ASSISTANT", content: "A stored answer", position: 1 },
    });
  });

  it("sends the whole stored history and stores nothing for a conversation the caller does not own", async () => {
    fake.state.conversation = null;

    expect(await generateAssistantReply(userId, conversationId)).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(generateReply).not.toHaveBeenCalled();
    expect(fake.state.created).toEqual([]);
  });

  it("refuses to reply to an empty conversation or a turn that already has a reply", async () => {
    expect(await generateAssistantReply(userId, conversationId)).toEqual({
      ok: false,
      reason: "nothing-to-reply-to",
    });

    fake.state.storedMessages = [
      message({ position: 0, role: "USER" }),
      message({ position: 1, role: "ASSISTANT" }),
    ];
    expect(await generateAssistantReply(userId, conversationId)).toEqual({
      ok: false,
      reason: "already-replied",
    });
    expect(generateReply).not.toHaveBeenCalled();
    expect(fake.state.created).toEqual([]);
  });

  it("stores nothing when the provider fails, times out, or is not configured", async () => {
    fake.state.storedMessages = [message({ position: 0, role: "USER" })];

    generateReply.mockRejectedValueOnce(new AiProviderError("timeout"));
    expect(await generateAssistantReply(userId, conversationId)).toEqual({
      ok: false,
      reason: "generation-failed",
    });

    generateReply.mockRejectedValueOnce(new AiProviderError("http-error", { status: 429 }));
    expect(await generateAssistantReply(userId, conversationId)).toEqual({
      ok: false,
      reason: "generation-failed",
    });

    generateReply.mockRejectedValueOnce(new AiNotConfiguredError());
    expect(await generateAssistantReply(userId, conversationId)).toEqual({
      ok: false,
      reason: "not-configured",
    });

    // An empty provider answer is never stored either.
    generateReply.mockResolvedValue("   ");
    expect(await generateAssistantReply(userId, conversationId)).toEqual({
      ok: false,
      reason: "generation-failed",
    });

    expect(fake.state.created).toEqual([]);
  });

  it("keeps exactly one assistant row when the answer to a turn already exists", async () => {
    fake.state.storedMessages = [message({ position: 0, role: "USER" })];
    fake.state.lastPosition = 0;
    generateReply.mockResolvedValue("Only reply");

    const first = await generateAssistantReply(userId, conversationId);
    expect(first.ok).toBe(true);
    expect(fake.state.created).toHaveLength(1);

    // A retry of the same turn: the newest stored message is no longer that user
    // message, so the transaction refuses to write a second reply.
    fake.state.storedMessages = [
      message({ position: 0, role: "USER" }),
      message({ id: "cmreply000000000000001", position: 1, role: "ASSISTANT" }),
    ];
    expect(await generateAssistantReply(userId, conversationId)).toEqual({
      ok: false,
      reason: "already-replied",
    });
    expect(fake.state.created).toHaveLength(1);
  });

  it("never stores a reply when another writer moved the conversation on", async () => {
    fake.state.storedMessages = [message({ position: 0, role: "USER" })];
    fake.state.lastPosition = 0;
    generateReply.mockResolvedValue("Late reply");
    // By insert time the newest row is a different message than the one answered.
    fake.state.racedLatest = { id: "cmsomeoneelse0000000", position: 1 };

    expect(await generateAssistantReply(userId, conversationId)).toEqual({
      ok: false,
      reason: "already-replied",
    });
    expect(fake.state.created).toEqual([]);
  });

  it("still reports a retryable failure when the position write collides", async () => {
    fake.state.storedMessages = [message({ position: 0, role: "USER" })];
    generateReply.mockResolvedValue("Raced reply");
    vi.spyOn(fake.db, "$transaction").mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    await expect(generateAssistantReply(userId, conversationId)).rejects.toMatchObject({
      code: "P2002",
    });
    expect(fake.state.created).toEqual([]);
  });
});

describe("model selection for a reply", () => {
  it("uses the model the user selected", async () => {
    models.state.key = "claude-3.7-sonnet";
    fake.state.storedMessages = [message({ position: 0, role: "USER", content: "Hello" })];
    fake.state.lastPosition = 0;
    generateReply.mockResolvedValue("Answered by the chosen model");

    await generateAssistantReply(userId, conversationId);

    expect(generateReply).toHaveBeenCalledWith([{ role: "user", content: "Hello" }], {
      model: "claude-3.7-sonnet",
    });
  });

  it("carries the same model through the streaming path, alongside the abort signal", async () => {
    models.state.key = "gpt-4o";
    fake.state.storedMessages = [message({ position: 0, role: "USER", content: "Hello" })];
    fake.state.lastPosition = 0;
    streamReply.mockImplementation(async function* () {
      yield { type: "delta", text: "Streamed" };
    });

    const controller = new AbortController();
    const prepared = await prepareReply(userId, conversationId);
    if (!prepared.ok) throw new Error("expected a prepared reply");
    // Draining the stream is enough here; the assertion is about the provider call.
    for await (const event of streamAssistantReply(userId, prepared, {
      signal: controller.signal,
    }))
      void event;

    expect(streamReply).toHaveBeenCalledWith([{ role: "user", content: "Hello" }], {
      model: "gpt-4o",
      signal: controller.signal,
    });
  });

  it("exposes the resolved key on the prepared turn, so every path uses one decision", async () => {
    models.state.key = "claude-3.5-haiku";
    fake.state.storedMessages = [message({ position: 0, role: "USER", content: "Hello" })];

    const prepared = await prepareReply(userId, conversationId);

    expect(prepared).toMatchObject({ ok: true, modelKey: "claude-3.5-haiku" });
  });

  it("takes the model from the session, never from a caller-supplied option", async () => {
    models.state.key = "gpt-4o";
    fake.state.storedMessages = [message({ position: 0, role: "USER", content: "Hello" })];
    fake.state.lastPosition = 0;
    generateReply.mockResolvedValue("Stored answer");

    // The public signatures accept only a user id and conversation id: there is no
    // parameter through which a model (or any provider identifier) could arrive.
    await generateAssistantReply(userId, conversationId);
    expect(generateAssistantReply.length).toBe(2);
    expect(generateReply).toHaveBeenCalledWith(expect.anything(), { model: "gpt-4o" });
  });
});

describe("streaming assistant reply generation", () => {
  /** A provider stream scripted as text pieces and failures, in order. */
  function scripted(parts: (string | Error)[]) {
    return async function* () {
      for (const part of parts) {
        if (part instanceof Error) throw part;
        yield { type: "delta" as const, text: part };
      }
    };
  }

  async function collectStream(signal?: AbortSignal) {
    const prepared = await prepareReply(userId, conversationId);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("expected a prepared reply");

    const events: Awaited<ReturnType<typeof streamAssistantReply>> extends AsyncGenerator<
      infer Event
    >
      ? Event[]
      : never[] = [];
    for await (const event of streamAssistantReply(userId, prepared, signal ? { signal } : {}))
      events.push(event);
    return events;
  }

  it("streams deltas and stores exactly one row with the accumulated text", async () => {
    fake.state.storedMessages = [message({ position: 0, role: "USER", content: "Hello" })];
    fake.state.lastPosition = 0;
    streamReply.mockImplementation(scripted(["Stream", "ed ", "answer"]));

    const events = await collectStream();

    expect(events.slice(0, 3)).toEqual([
      { type: "delta", text: "Stream" },
      { type: "delta", text: "ed " },
      { type: "delta", text: "answer" },
    ]);
    // The provider receives only the stored history and the server-resolved model
    // key, never anything from a client.
    expect(streamReply).toHaveBeenCalledWith([{ role: "user", content: "Hello" }], {
      model: "gpt-4o-mini",
    });
    // Exactly one row, containing the accumulated text, with a server-derived role
    // and position — and the final event carries that stored row.
    expect(fake.state.created).toEqual([
      { conversationId, role: "ASSISTANT", content: "Streamed answer", position: 1 },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: { role: "ASSISTANT", content: "Streamed answer", position: 1 },
    });
  });

  it("stores nothing when the stream fails after it already sent text", async () => {
    fake.state.storedMessages = [message({ position: 0, role: "USER" })];
    fake.state.lastPosition = 0;
    streamReply.mockImplementation(
      scripted(["A partial answer", new AiProviderError("network-error")]),
    );

    const events = await collectStream();

    expect(events[0]).toEqual({ type: "delta", text: "A partial answer" });
    expect(events.at(-1)).toEqual({ type: "failed", reason: "generation-failed" });
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(fake.state.created).toEqual([]);
  });

  it("stores nothing for an empty stream, empty deltas, or an unconfigured provider", async () => {
    fake.state.storedMessages = [message({ position: 0, role: "USER" })];

    streamReply.mockImplementation(scripted([]));
    expect((await collectStream()).at(-1)).toEqual({
      type: "failed",
      reason: "generation-failed",
    });

    streamReply.mockImplementation(scripted(["   ", "\n"]));
    expect((await collectStream()).at(-1)).toEqual({
      type: "failed",
      reason: "generation-failed",
    });

    // The adapter reports an empty provider answer by throwing; the service keeps
    // that meaning instead of inventing a message.
    streamReply.mockImplementation(scripted([new AiProviderError("empty-response")]));
    expect((await collectStream()).at(-1)).toEqual({
      type: "failed",
      reason: "generation-failed",
    });

    streamReply.mockImplementation(scripted([new AiNotConfiguredError()]));
    expect((await collectStream()).at(-1)).toEqual({ type: "failed", reason: "not-configured" });

    expect(fake.state.created).toEqual([]);
  });

  it("keeps one assistant row per turn when a second stream answers the same turn", async () => {
    fake.state.storedMessages = [message({ position: 0, role: "USER" })];
    fake.state.lastPosition = 0;
    streamReply.mockImplementation(scripted(["Only reply"]));

    const first = await collectStream();
    expect(first.at(-1)).toMatchObject({ type: "done" });
    expect(fake.state.created).toHaveLength(1);

    // The turn now has an answer: a repeat is refused before the provider is called.
    fake.state.storedMessages = [
      message({ position: 0, role: "USER" }),
      message({ id: "cmreply000000000000001", position: 1, role: "ASSISTANT" }),
    ];
    streamReply.mockClear();
    const prepared = await prepareReply(userId, conversationId);
    expect(prepared).toEqual({ ok: false, reason: "already-replied" });
    expect(streamReply).not.toHaveBeenCalled();
    expect(fake.state.created).toHaveLength(1);
  });

  it("ends a losing stream safely when another writer stored the reply first", async () => {
    fake.state.storedMessages = [message({ position: 0, role: "USER" })];
    fake.state.lastPosition = 0;
    streamReply.mockImplementation(scripted(["Late ", "reply"]));
    // Between streaming and storing, somebody else answered the same turn.
    fake.state.racedLatest = { id: "cmsomeoneelse0000000", position: 1 };

    const events = await collectStream();

    expect(events.slice(0, 2)).toEqual([
      { type: "delta", text: "Late " },
      { type: "delta", text: "reply" },
    ]);
    expect(events.at(-1)).toEqual({ type: "failed", reason: "already-replied" });
    expect(fake.state.created).toEqual([]);
  });

  it("writes nothing when the client cancelled the stream", async () => {
    fake.state.storedMessages = [message({ position: 0, role: "USER" })];
    fake.state.lastPosition = 0;
    streamReply.mockImplementation(scripted(["Never stored"]));

    const controller = new AbortController();
    controller.abort();
    const events = await collectStream(controller.signal);

    // The fake provider ignores the signal and still yields; the service must not
    // turn that text into a stored reply, and it never claims a completion.
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(fake.state.created).toEqual([]);
  });

  it("reaches no provider for a conversation the caller does not own", async () => {
    fake.state.conversation = null;

    expect(await prepareReply(userId, conversationId)).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(streamReply).not.toHaveBeenCalled();
    expect(fake.state.created).toEqual([]);
  });
});
