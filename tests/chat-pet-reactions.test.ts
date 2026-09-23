import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createChatPetReactions } from "../src/features/chat/pet-reactions";
import {
  CHAT_PHASE_REACTIONS,
  isPetReactionEvent,
  PET_REACTION_EVENTS,
  type PetReactionEvent,
} from "../src/features/pets/reactions";

/**
 * The chat → pet boundary on its own.
 *
 * These tests are about the two guarantees the streaming code cannot make by itself:
 * that one generation reports one coherent sequence, and that a generation which has
 * already ended cannot be followed by a different ending from a late callback. The
 * shell's own wiring is covered in `chat-shell-pet-reactions.test.tsx`.
 */

type Dispatch = (event: PetReactionEvent) => void;

let dispatched: PetReactionEvent[];
let dispatch: Mock<Dispatch>;

beforeEach(() => {
  dispatched = [];
  dispatch = vi.fn<Dispatch>((event) => {
    dispatched.push(event);
  });
});

describe("chat lifecycle to pet reaction events", () => {
  it("reports each lifecycle moment as the documented reaction event", () => {
    const reactions = createChatPetReactions(dispatch);

    reactions.messageSent();
    reactions.generationStarted();
    reactions.firstContent();
    reactions.completed();

    expect(dispatched).toEqual([
      "user-started-message",
      "thinking",
      "response-started",
      "response-completed",
    ]);
  });

  it("reports a failure and a cancellation as their own events", () => {
    const failed = createChatPetReactions(dispatch);
    failed.generationStarted();
    failed.failed();

    const cancelled = createChatPetReactions(dispatch);
    cancelled.generationStarted();
    cancelled.cancelled();

    expect(dispatched).toEqual(["thinking", "response-error", "thinking", "cancelled"]);
  });

  it("reuses the existing chat-phase mapping instead of a second vocabulary", () => {
    const reactions = createChatPetReactions(dispatch);

    reactions.messageSent();
    reactions.generationStarted();
    reactions.firstContent();
    reactions.completed();
    expect(dispatched).toEqual([
      CHAT_PHASE_REACTIONS["composer-submit"],
      CHAT_PHASE_REACTIONS["request-started"],
      CHAT_PHASE_REACTIONS["stream-started"],
      CHAT_PHASE_REACTIONS["stream-completed"],
    ]);
  });

  it("only ever emits events from the declared vocabulary", () => {
    const reactions = createChatPetReactions(dispatch);
    reactions.messageSent();
    reactions.generationStarted();
    reactions.firstContent();
    reactions.failed();

    expect(dispatched.length).toBeGreaterThan(0);
    for (const event of dispatched) {
      expect(isPetReactionEvent(event)).toBe(true);
      expect(PET_REACTION_EVENTS).toContain(event);
    }
  });
});

describe("one generation, one sequence", () => {
  it("reports the response starting once however many deltas arrive", () => {
    const reactions = createChatPetReactions(dispatch);
    reactions.generationStarted();

    reactions.firstContent();
    reactions.firstContent();
    reactions.firstContent();

    expect(dispatched).toEqual(["thinking", "response-started"]);
    expect(dispatched.filter((event) => event === "response-started")).toHaveLength(1);
  });

  it("lets a completed generation report no other outcome", () => {
    const reactions = createChatPetReactions(dispatch);
    reactions.generationStarted();
    reactions.firstContent();
    reactions.completed();

    // A stale callback arriving after the stream was stored must change nothing.
    reactions.failed();
    reactions.cancelled();
    reactions.firstContent();

    expect(dispatched).toEqual(["thinking", "response-started", "response-completed"]);
  });

  it("never lets a failed generation be followed by a success reaction", () => {
    const reactions = createChatPetReactions(dispatch);
    reactions.generationStarted();
    reactions.failed();

    reactions.completed();
    reactions.firstContent();

    expect(dispatched).toEqual(["thinking", "response-error"]);
    expect(dispatched).not.toContain("response-completed");
  });

  it("never lets a cancelled generation be followed by a success reaction", () => {
    const reactions = createChatPetReactions(dispatch);
    reactions.generationStarted();
    reactions.firstContent();
    reactions.cancelled();

    reactions.completed();
    reactions.failed();

    expect(dispatched).toEqual(["thinking", "response-started", "cancelled"]);
    expect(dispatched).not.toContain("response-completed");
    expect(dispatched).not.toContain("response-error");
  });

  it("treats a cancellation and a failure as mutually exclusive", () => {
    const reactions = createChatPetReactions(dispatch);
    reactions.cancelled();
    reactions.failed();

    expect(dispatched).toEqual(["cancelled"]);
  });

  it("keeps the guards scoped to one generation, not to the adapter's caller", () => {
    const first = createChatPetReactions(dispatch);
    first.generationStarted();
    first.firstContent();
    first.completed();

    // A retry creates its own reporter, so it gets a full sequence of its own.
    const second = createChatPetReactions(dispatch);
    second.generationStarted();
    second.firstContent();
    second.completed();

    expect(dispatched.filter((event) => event === "response-completed")).toHaveLength(2);
  });
});
