import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("server-only", () => ({}));

/**
 * The service is exercised against a fake Prisma client so the query filters,
 * the server-derived fields, and the position-conflict retry can be inspected
 * directly. Real database behavior is covered by the PostgreSQL suite.
 */
const fake = vi.hoisted(() => {
  const state = {
    conversation: { id: "cmconversation000000001", title: "New chat", createdAt: new Date(), updatedAt: new Date() } as
      | { id: string; title: string; createdAt: Date; updatedAt: Date }
      | null,
    lastPosition: null as number | null,
    latestId: "cmuserturn0000000000001",
    racedLatest: null as { id: string; position: number } | null,
    storedMessages: [] as { id: string; role: string; content: string; position: number; createdAt: Date; updatedAt: Date }[],
    conflictAttempts: 0,
    everyAttemptConflicts: false,
    ownedCount: 1,
    calls: {
      updateMany: [] as unknown[],
      messageFindFirst: [] as unknown[],
      messageCreate: [] as unknown[],
      messageFindMany: [] as unknown[],
    },
  };

  const tx = {
    conversation: {
      updateMany: async (args: unknown) => {
        state.calls.updateMany.push(args);
        if (state.conflictAttempts > 0 || state.everyAttemptConflicts) {
          state.conflictAttempts -= 1;
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "test",
            meta: { target: ["conversationId", "position"] },
          });
        }
        return { count: state.ownedCount };
      },
    },
    message: {
      findFirst: async (args: unknown) => {
        state.calls.messageFindFirst.push(args);
        if (state.racedLatest) return state.racedLatest;
        return state.lastPosition === null
          ? null
          : { id: state.latestId, position: state.lastPosition };
      },
      create: async (args: { data: Record<string, unknown> }) => {
        state.calls.messageCreate.push(args);
        const now = new Date("2026-09-23T10:00:00.000Z");
        return { id: "cmmessage0000000000001", createdAt: now, updatedAt: now, ...args.data };
      },
    },
  };

  const db = {
    conversation: {
      findFirst: async (args: unknown) => {
        void args;
        return state.conversation;
      },
    },
    message: {
      findMany: async (args: unknown) => {
        state.calls.messageFindMany.push(args);
        return state.storedMessages;
      },
    },
    $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
  };

  return { state, db };
});

vi.mock("../src/server/db/client", () => ({ getDb: () => fake.db }));

const { createUserMessage, createAssistantMessage, listMessages, MESSAGE_LIST_LIMIT } = await import(
  "../src/server/messages/service"
);

const userId = "cmuser00000000000000001";
const conversationId = "cmconversation000000001";

beforeEach(() => {
  fake.state.conversation = {
    id: conversationId,
    title: "New chat",
    createdAt: new Date("2026-09-23T09:00:00.000Z"),
    updatedAt: new Date("2026-09-23T09:00:00.000Z"),
  };
  fake.state.lastPosition = null;
  fake.state.latestId = "cmuserturn0000000000001";
  fake.state.racedLatest = null;
  fake.state.storedMessages = [];
  fake.state.conflictAttempts = 0;
  fake.state.everyAttemptConflicts = false;
  fake.state.ownedCount = 1;
  fake.state.calls = {
    updateMany: [],
    messageFindFirst: [],
    messageCreate: [],
    messageFindMany: [],
  };
});

describe("creating a user message", () => {
  it("scopes permission to the owner and derives every stored field", async () => {
    fake.state.lastPosition = 4;

    const result = await createUserMessage(userId, conversationId, "Hello there");

    // Ownership is part of the query itself, never a check after a read.
    expect(fake.state.calls.updateMany).toEqual([
      { where: { id: conversationId, userId }, data: { updatedAt: expect.any(Date) } },
    ]);
    expect(fake.state.calls.messageFindFirst[0]).toMatchObject({
      where: { conversationId },
      orderBy: { position: "desc" },
    });

    // The client supplied the text only: role, position, and owner come from here.
    const create = fake.state.calls.messageCreate[0] as { data: Record<string, unknown> };
    expect(create.data).toEqual({
      conversationId,
      role: "USER",
      content: "Hello there",
      position: 5,
    });
    expect(create.data).not.toHaveProperty("userId");
    expect(create.data).not.toHaveProperty("id");

    expect(result).toMatchObject({
      ok: true,
      message: { role: "USER", content: "Hello there", position: 5 },
    });
  });

  it("reports a conversation the caller does not own without writing a message", async () => {
    fake.state.ownedCount = 0;

    expect(await createUserMessage(userId, conversationId, "Hello")).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(fake.state.calls.messageCreate).toEqual([]);
  });

  it("retries a losing position race and stores the retried position", async () => {
    fake.state.conflictAttempts = 1;
    fake.state.lastPosition = 1;

    const result = await createUserMessage(userId, conversationId, "Raced");

    expect(result).toMatchObject({ ok: true, message: { position: 2 } });
    // One rejected attempt, one successful write: no duplicate position is kept.
    expect(fake.state.calls.messageCreate).toHaveLength(1);
    expect(fake.state.calls.updateMany).toHaveLength(2);
  });

  it("gives up safely when every attempt conflicts", async () => {
    fake.state.everyAttemptConflicts = true;

    await expect(createUserMessage(userId, conversationId, "Never stored")).rejects.toMatchObject({
      code: "P2002",
    });
    expect(fake.state.calls.messageCreate).toEqual([]);
  });
});

describe("listing messages", () => {
  it("returns null for a conversation the caller does not own, without reading messages", async () => {
    fake.state.conversation = null;

    expect(await listMessages(userId, conversationId)).toBeNull();
    expect(fake.state.calls.messageFindMany).toEqual([]);
  });

  it("returns the stored messages oldest first and reports a capped read", async () => {
    const rows = Array.from({ length: MESSAGE_LIST_LIMIT + 1 }, (_, index) => ({
      id: `cmessage${index}`,
      role: "USER",
      content: `Message ${index}`,
      position: MESSAGE_LIST_LIMIT - index,
      createdAt: new Date("2026-09-23T10:00:00.000Z"),
      updatedAt: new Date("2026-09-23T10:00:00.000Z"),
    }));
    fake.state.storedMessages = rows;

    const page = await listMessages(userId, conversationId);

    expect(page?.truncated).toBe(true);
    expect(page?.messages).toHaveLength(MESSAGE_LIST_LIMIT);
    // Newest-first from the database becomes ascending positions for the UI.
    expect(page?.messages[0].position).toBe(1);
    expect(page?.messages.at(-1)?.position).toBe(MESSAGE_LIST_LIMIT);
    expect(fake.state.calls.messageFindMany[0]).toMatchObject({
      where: { conversationId },
      orderBy: { position: "desc" },
      take: MESSAGE_LIST_LIMIT + 1,
    });
  });
});

describe("creating an assistant message", () => {
  it("derives the ASSISTANT role and the next position", async () => {
    fake.state.lastPosition = 0;
    fake.state.latestId = "cmuserturn0000000000001";

    const result = await createAssistantMessage(
      userId,
      conversationId,
      "A provider answer",
      "cmuserturn0000000000001",
    );

    expect(fake.state.calls.updateMany[0]).toEqual({
      where: { id: conversationId, userId },
      data: { updatedAt: expect.any(Date) },
    });
    const create = fake.state.calls.messageCreate[0] as { data: Record<string, unknown> };
    // The text is the only caller-supplied value; the role is fixed here.
    expect(create.data).toEqual({
      conversationId,
      role: "ASSISTANT",
      content: "A provider answer",
      position: 1,
    });
    expect(result).toMatchObject({ ok: true, message: { role: "ASSISTANT", position: 1 } });
  });

  it("refuses to write a second reply for the same turn", async () => {
    fake.state.lastPosition = 1;
    fake.state.racedLatest = { id: "cmreply000000000000001", position: 1 };

    expect(
      await createAssistantMessage(userId, conversationId, "Duplicate", "cmuserturn0000000000001"),
    ).toEqual({ ok: false, reason: "stale" });
    expect(fake.state.calls.messageCreate).toEqual([]);
  });

  it("reports another user's conversation as not found", async () => {
    fake.state.ownedCount = 0;

    expect(
      await createAssistantMessage(userId, conversationId, "Answer", "cmuserturn0000000000001"),
    ).toEqual({ ok: false, reason: "not-found" });
    expect(fake.state.calls.messageCreate).toEqual([]);
  });
});
