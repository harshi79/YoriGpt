import { describe, expect, it } from "vitest";
import {
  CHAT_PHASE_REACTIONS,
  isChatPhase,
  isPetReactionEvent,
  PET_REACTION_DURATIONS,
  PET_REACTION_EVENTS,
  reactionForChatPhase,
  resolveReaction,
} from "../src/features/pets/reactions";
import { INITIAL_PET_STATE, isPetState, PET_STATES } from "../src/features/pets/state";

/**
 * The reaction engine, exercised as the pure function it is: no React, no timers, no
 * network. Everything here is deterministic — the same pet, personality, event, and
 * current state must always produce the same reaction — and every result must land on
 * the existing state vocabulary rather than inventing a second one.
 */

const CAT = "yori-cat"; // calm by default; also offers sleepy and curious
const FOX = "ember-fox"; // curious by default; also offers playful

const POSITIVE = new Set(["happy", "excited"]);

describe("the reaction event vocabulary", () => {
  it("accepts exactly the declared events", () => {
    for (const event of PET_REACTION_EVENTS) expect(isPetReactionEvent(event)).toBe(true);
    expect(isPetReactionEvent("nope")).toBe(false);
    expect(isPetReactionEvent(undefined)).toBe(false);
    expect(isPetReactionEvent(42)).toBe(false);
  });

  it("resolves every declared event to an existing state, deterministically", () => {
    for (const event of PET_REACTION_EVENTS) {
      const first = resolveReaction({ pet: CAT, personality: "calm", event });
      const second = resolveReaction({ pet: CAT, personality: "calm", event });

      // Deterministic: identical inputs, identical output, including the reason.
      expect(second).toEqual(first);
      // No second state system: the result is always one of the six existing states.
      expect(isPetState(first.state), event).toBe(true);
      expect(PET_STATES).toContain(first.state);
      expect(typeof first.reason, event).toBe("string");
      expect(first.reason.length, event).toBeGreaterThan(0);
      // Either it holds (null) or it settles after a modest, positive duration.
      if (first.durationMs !== null) {
        expect(first.durationMs, event).toBeGreaterThan(0);
        expect(first.durationMs, event).toBeLessThan(10_000);
      }
    }
  });
});

describe("the reaction mapping", () => {
  it("maps a thinking event to a thinking-related state that holds", () => {
    const reaction = resolveReaction({ pet: CAT, personality: "calm", event: "thinking" });
    expect(reaction.state).toBe("thinking");
    // Waiting on an answer is open-ended, so it holds until the next event.
    expect(reaction.durationMs).toBeNull();
  });

  it("maps a completed response to a positive state", () => {
    const reaction = resolveReaction({ pet: CAT, personality: "calm", event: "response-completed" });
    expect(POSITIVE.has(reaction.state)).toBe(true);
    // …and it is temporary, so the pet settles back rather than staying delighted.
    expect(reaction.durationMs).toBe(PET_REACTION_DURATIONS.brief);
  });

  it("maps a successful action to the same positive reaction", () => {
    const completed = resolveReaction({ pet: CAT, personality: "calm", event: "response-completed" });
    const saved = resolveReaction({ pet: CAT, personality: "calm", event: "successful-action" });
    expect(saved.state).toBe(completed.state);
  });

  it("maps an error to a non-positive state that lingers", () => {
    const reaction = resolveReaction({ pet: CAT, personality: "calm", event: "response-error" });
    expect(reaction.state).toBe("sad");
    expect(POSITIVE.has(reaction.state)).toBe(false);
    // Long enough to be seen before the pet settles.
    expect(reaction.durationMs).toBe(PET_REACTION_DURATIONS.lingering);
    expect(reaction.durationMs).toBeGreaterThan(PET_REACTION_DURATIONS.brief);
  });

  it("maps a cancellation back to idle", () => {
    const reaction = resolveReaction({ pet: CAT, personality: "calm", event: "cancelled" });
    expect(reaction.state).toBe(INITIAL_PET_STATE);
    expect(reaction.durationMs).toBeNull();
  });

  it("maps idle to the idle state", () => {
    const reaction = resolveReaction({ pet: CAT, personality: "calm", event: "idle" });
    expect(reaction.state).toBe(INITIAL_PET_STATE);
  });

  it("does not wake a sleeping pet for a cancelled request", () => {
    // The one rule that consults the current state.
    const reaction = resolveReaction({
      pet: CAT,
      personality: "calm",
      event: "cancelled",
      currentState: "sleeping",
    });
    expect(reaction.state).toBe("sleeping");
  });
});

describe("personality-aware differences", () => {
  it("gives a high-motion personality a stronger positive reaction", () => {
    const calm = resolveReaction({ pet: CAT, personality: "calm", event: "response-completed" });
    const playful = resolveReaction({ pet: FOX, personality: "playful", event: "response-completed" });

    expect(calm.state).toBe("happy");
    expect(playful.state).toBe("excited");
    expect(playful.state).not.toBe(calm.state);
  });

  it("keeps a drowsy personality dozing while a response starts", () => {
    const calm = resolveReaction({ pet: CAT, personality: "calm", event: "response-started" });
    const sleepy = resolveReaction({ pet: CAT, personality: "sleepy", event: "response-started" });

    expect(calm.state).toBe("thinking");
    expect(sleepy.state).toBe("sleeping");
    expect(sleepy.state).not.toBe(calm.state);
  });

  it("still agrees on the states where personality should not matter", () => {
    // An error reads the same however bouncy the pet is.
    const calm = resolveReaction({ pet: CAT, personality: "calm", event: "response-error" });
    const playful = resolveReaction({ pet: FOX, personality: "playful", event: "response-error" });
    expect(playful.state).toBe(calm.state);
    expect(calm.state).toBe("sad");
  });
});

describe("invalid and missing input", () => {
  it("falls back safely for an unusable pet", () => {
    for (const pet of [undefined, null, "nope", 42, {}]) {
      const reaction = resolveReaction({ pet, personality: "calm", event: "thinking" });
      expect(isPetState(reaction.state)).toBe(true);
      expect(reaction.state).toBe("thinking");
    }
  });

  it("falls back safely for an unusable personality", () => {
    for (const personality of [undefined, null, "nope", 42, { id: "nope" }]) {
      const reaction = resolveReaction({ pet: CAT, personality, event: "response-completed" });
      expect(isPetState(reaction.state)).toBe(true);
      // The cat's default personality decides, so the reaction is the calm one.
      expect(reaction.state).toBe("happy");
    }
  });

  it("ignores a personality that belongs to another pet", () => {
    // "playful" is the fox's; on the cat it resolves to the cat's default instead.
    const reaction = resolveReaction({ pet: CAT, personality: "playful", event: "response-completed" });
    expect(reaction.state).toBe("happy");
  });

  it("resolves an unsupported event to a safe settle rather than throwing", () => {
    // Impossible through the typed API; still must not crash at runtime.
    const reaction = resolveReaction({ pet: CAT, personality: "calm", event: "teleport" as never });
    expect(reaction.state).toBe(INITIAL_PET_STATE);
  });

  it("tolerates a completely empty context", () => {
    const reaction = resolveReaction({});
    expect(reaction.state).toBe(INITIAL_PET_STATE);
    expect(reaction.durationMs).toBeNull();
  });

  it("tolerates a missing or malformed current state", () => {
    for (const currentState of [undefined, "nonsense", 7]) {
      const reaction = resolveReaction({ pet: CAT, personality: "calm", event: "cancelled", currentState });
      expect(reaction.state).toBe(INITIAL_PET_STATE);
    }
  });
});

describe("the chat phase seam", () => {
  it("maps every chat phase onto a declared reaction event", () => {
    for (const [phase, event] of Object.entries(CHAT_PHASE_REACTIONS)) {
      expect(isChatPhase(phase)).toBe(true);
      expect(reactionForChatPhase(phase as never)).toBe(event);
      expect(isPetReactionEvent(event)).toBe(true);
    }
  });

  it("rejects an unknown phase", () => {
    expect(isChatPhase("nope")).toBe(false);
    expect(isChatPhase(undefined)).toBe(false);
  });
});
