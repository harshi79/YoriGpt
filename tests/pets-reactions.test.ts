import { describe, expect, it, vi } from "vitest";
import {
  CHAT_PHASE_REACTIONS,
  isChatPhase,
  isPetReactionEvent,
  PET_REACTION_DURATIONS,
  PET_REACTION_EVENT_LABELS,
  PET_REACTION_EVENTS,
  reactionForChatPhase,
  resolveReaction,
  type PetReactionEvent,
} from "../src/features/pets/reactions";
import { listAvailablePets } from "../src/features/pets/catalog";
import { PET_PERSONALITIES } from "../src/features/pets/types";
import { INITIAL_PET_STATE, isPetState, PET_STATES, type PetState } from "../src/features/pets/state";

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

/**
 * Personality differentiation, written down as data.
 *
 * This is the same table the resolver's own documentation carries: for each personality,
 * the state every event in the vocabulary must resolve to. Keeping it as one table means
 * a deliberate change to the mapping shows up here as a readable diff, and it means every
 * personality is checked against every event instead of a spot-check or two. Nothing in
 * this file names a personality inside production code — the table only states what the
 * catalog's metadata should produce.
 */
const EXPECTED_MATRIX: readonly {
  personality: string;
  pet: string;
  states: Record<PetReactionEvent, PetState>;
}[] = [
  {
    // Restrained: pleased about the good things, attentive while waiting, and it settles
    // when a request stops. Never excited, because nothing in its metadata says energetic.
    personality: "calm",
    pet: CAT,
    states: {
      idle: "idle",
      "user-started-message": "happy",
      thinking: "thinking",
      "response-started": "thinking",
      "response-completed": "happy",
      "successful-action": "happy",
      "response-error": "sad",
      cancelled: "idle",
    },
  },
  {
    // Bouncy: the user's company excites it, a good outcome excites it, and even waiting
    // for an answer is fun. Still settles on a cancellation — nothing good happened.
    personality: "playful",
    pet: FOX,
    states: {
      idle: "idle",
      "user-started-message": "excited",
      thinking: "thinking",
      "response-started": "happy",
      "response-completed": "excited",
      "successful-action": "excited",
      "response-error": "sad",
      cancelled: "idle",
    },
  },
  {
    // Engaged: a new message is something to look into rather than to celebrate, waiting
    // is attention, and a good answer — being energetic — lands at full strength.
    personality: "curious",
    pet: CAT,
    states: {
      idle: "idle",
      "user-started-message": "thinking",
      thinking: "thinking",
      "response-started": "thinking",
      "response-completed": "excited",
      "successful-action": "excited",
      "response-error": "sad",
      cancelled: "idle",
    },
  },
  {
    // Resting: warm but never loud, dozing while an answer is on the way, and taking a
    // cancellation as a chance to go back to sleep.
    personality: "sleepy",
    pet: CAT,
    states: {
      idle: "idle",
      "user-started-message": "happy",
      thinking: "thinking",
      "response-started": "sleeping",
      "response-completed": "happy",
      "successful-action": "happy",
      "response-error": "sad",
      cancelled: "sleeping",
    },
  },
];

/** Reactions that settle on their own, and the events that hold until the next one. */
const TEMPORARY_EVENTS = [
  "user-started-message",
  "response-completed",
  "successful-action",
] as const;
const HELD_EVENTS = ["idle", "thinking", "response-started", "cancelled"] as const;

function resolve(
  personality: string,
  pet: string,
  event: PetReactionEvent,
  currentState?: string,
) {
  return resolveReaction({ pet, personality, event, currentState });
}

describe("the mapping, personality by personality", () => {
  for (const entry of EXPECTED_MATRIX) {
    describe(`${entry.personality} on ${entry.pet}`, () => {
      for (const event of PET_REACTION_EVENTS) {
        it(`resolves "${event}" to "${entry.states[event]}"`, () => {
          expect(resolve(entry.personality, entry.pet, event).state).toBe(entry.states[event]);
        });
      }
    });
  }

  it("covers every personality the catalog declares", () => {
    expect(EXPECTED_MATRIX.map((entry) => entry.personality).sort()).toEqual(
      [...PET_PERSONALITIES].sort(),
    );
  });

  it("keeps the durations the same for every personality", () => {
    for (const entry of EXPECTED_MATRIX) {
      const label = entry.personality;
      for (const event of TEMPORARY_EVENTS)
        expect(resolve(label, entry.pet, event).durationMs, `${label}/${event}`).toBe(
          PET_REACTION_DURATIONS.brief,
        );
      expect(resolve(label, entry.pet, "response-error").durationMs, label).toBe(
        PET_REACTION_DURATIONS.lingering,
      );
      for (const event of HELD_EVENTS)
        expect(resolve(label, entry.pet, event).durationMs, `${label}/${event}`).toBeNull();
    }
  });
});

describe("where personalities part company, and where they must not", () => {
  it("celebrates the user's company when playful, and merely acknowledges it when calm", () => {
    expect(resolve("calm", CAT, "user-started-message").state).toBe("happy");
    expect(resolve("playful", FOX, "user-started-message").state).toBe("excited");
  });

  it("enjoys waiting when playful, and pays attention when calm", () => {
    expect(resolve("calm", CAT, "response-started").state).toBe("thinking");
    expect(resolve("playful", FOX, "response-started").state).toBe("happy");
  });

  it("stays restrained on a good outcome when calm, and shows it fully when playful", () => {
    for (const event of ["response-completed", "successful-action"] as const) {
      expect(resolve("calm", CAT, event).state, event).toBe("happy");
      expect(resolve("playful", FOX, event).state, event).toBe("excited");
    }
  });

  it("settles after a cancellation when calm, and dozes off when sleepy", () => {
    expect(resolve("calm", CAT, "cancelled").state).toBe(INITIAL_PET_STATE);
    expect(resolve("sleepy", CAT, "cancelled").state).toBe("sleeping");
  });

  it("looks into a new message when curious, and celebrates it when playful", () => {
    expect(resolve("curious", CAT, "user-started-message").state).toBe("thinking");
    expect(resolve("playful", FOX, "user-started-message").state).toBe("excited");
  });

  it("watches an incoming answer when curious, and enjoys it when playful", () => {
    expect(resolve("curious", CAT, "response-started").state).toBe("thinking");
    expect(resolve("playful", FOX, "response-started").state).toBe("happy");
  });

  it("is not simply playful in a different coat: curious differs on two events", () => {
    const curious = PET_REACTION_EVENTS.map((event) => resolve("curious", CAT, event).state);
    const playful = PET_REACTION_EVENTS.map((event) => resolve("playful", FOX, event).state);
    const differences = curious.filter((state, index) => state !== playful[index]);
    expect(differences).toEqual(["thinking", "thinking"]);
  });

  it("acknowledges a new message warmly when calm, and curiously when curious", () => {
    expect(resolve("calm", CAT, "user-started-message").state).toBe("happy");
    expect(resolve("curious", CAT, "user-started-message").state).toBe("thinking");
  });

  it("is restrained about a good outcome when calm, and energetic when curious", () => {
    expect(resolve("calm", CAT, "response-completed").state).toBe("happy");
    expect(resolve("curious", CAT, "response-completed").state).toBe("excited");
  });

  it("keeps watch while waiting when calm, and dozes when sleepy", () => {
    expect(resolve("calm", CAT, "response-started").state).toBe("thinking");
    expect(resolve("sleepy", CAT, "response-started").state).toBe("sleeping");
  });

  it("shares calm's restraint about good outcomes with sleepy, but not its waiting", () => {
    for (const event of ["response-completed", "successful-action", "user-started-message"] as const)
      expect(resolve("sleepy", CAT, event).state, event).toBe(
        resolve("calm", CAT, event).state,
      );
    expect(resolve("sleepy", CAT, "response-started").state).not.toBe(
      resolve("calm", CAT, "response-started").state,
    );
  });

  it("is awake and loud when playful, resting and quiet when sleepy", () => {
    expect(resolve("playful", FOX, "user-started-message").state).toBe("excited");
    expect(resolve("sleepy", CAT, "user-started-message").state).toBe("happy");
    expect(resolve("playful", FOX, "response-started").state).toBe("happy");
    expect(resolve("sleepy", CAT, "response-started").state).toBe("sleeping");
    expect(resolve("playful", FOX, "response-completed").state).toBe("excited");
    expect(resolve("sleepy", CAT, "response-completed").state).toBe("happy");
    expect(resolve("playful", FOX, "cancelled").state).toBe(INITIAL_PET_STATE);
    expect(resolve("sleepy", CAT, "cancelled").state).toBe("sleeping");
  });

  it("stays engaged when curious, and rests when sleepy", () => {
    expect(resolve("curious", CAT, "user-started-message").state).toBe("thinking");
    expect(resolve("sleepy", CAT, "user-started-message").state).toBe("happy");
    expect(resolve("curious", CAT, "response-completed").state).toBe("excited");
    expect(resolve("sleepy", CAT, "response-completed").state).toBe("happy");
    expect(resolve("curious", CAT, "response-started").state).toBe("thinking");
    expect(resolve("sleepy", CAT, "response-started").state).toBe("sleeping");
    expect(resolve("curious", CAT, "cancelled").state).toBe(INITIAL_PET_STATE);
    expect(resolve("sleepy", CAT, "cancelled").state).toBe("sleeping");
  });

  it("gives every pair of personalities an observable difference", () => {
    const vectors = EXPECTED_MATRIX.map((entry) => ({
      personality: entry.personality,
      states: PET_REACTION_EVENTS.map((event) => resolve(entry.personality, entry.pet, event).state).join(
        ",",
      ),
    }));

    for (const [index, left] of vectors.entries())
      for (const right of vectors.slice(index + 1))
        expect(left.states, `${left.personality} vs ${right.personality}`).not.toBe(right.states);
  });

  it("reports a failure the same way for every personality", () => {
    for (const entry of EXPECTED_MATRIX)
      expect(resolve(entry.personality, entry.pet, "response-error").state, entry.personality).toBe(
        "sad",
      );
  });

  it("shows real processing the same way for every personality", () => {
    for (const entry of EXPECTED_MATRIX)
      expect(resolve(entry.personality, entry.pet, "thinking").state, entry.personality).toBe(
        "thinking",
      );
  });

  it("treats an explicit settle signal the same way for every personality", () => {
    for (const entry of EXPECTED_MATRIX)
      expect(resolve(entry.personality, entry.pet, "idle").state, entry.personality).toBe(
        INITIAL_PET_STATE,
      );
  });

  it("never turns a cancellation into a positive reaction", () => {
    const currentStates: unknown[] = [...PET_STATES, "asleep", undefined];
    for (const entry of EXPECTED_MATRIX) {
      for (const currentState of currentStates) {
        const reaction = resolve(entry.personality, entry.pet, "cancelled", currentState as string);
        const label = `${entry.personality}/${String(currentState)}`;
        expect(POSITIVE.has(reaction.state), label).toBe(false);
        // Either it settles, or a drowsy pet takes the opportunity to doze.
        expect([INITIAL_PET_STATE, "sleeping"], label).toContain(reaction.state);
        expect(reaction.durationMs, label).toBeNull();
      }
    }
  });
});

describe("the catalog metadata behind the differences", () => {
  // Every personality as the catalog declares it, paired with a pet that offers it.
  const definitions = listAvailablePets().flatMap((pet) =>
    pet.personalities.map((personality) => ({ petId: pet.id, personality })),
  );

  function expressiveOf(personality: (typeof definitions)[number]["personality"]) {
    return (
      personality.hints?.motionLevel === "high" || personality.traits.includes("energetic")
    );
  }

  it("covers all four declared personalities", () => {
    const offered = [...new Set(definitions.map((entry) => entry.personality.id))].sort();
    expect(offered).toEqual([...PET_PERSONALITIES].sort());
  });

  it("shows a good outcome at full strength only where motion or the energetic trait says so", () => {
    for (const { petId, personality } of definitions) {
      for (const event of ["response-completed", "successful-action"] as const) {
        const state = resolveReaction({ pet: petId, personality: personality.id, event }).state;
        expect(state, `${petId}/${personality.id}/${event}`).toBe(
          expressiveOf(personality) ? "excited" : "happy",
        );
      }
    }
  });

  it("greets the user by the sociable and inquisitive traits", () => {
    for (const { petId, personality } of definitions) {
      const expected =
        personality.traits.includes("sociable") && expressiveOf(personality)
          ? "excited"
          : personality.traits.includes("inquisitive")
            ? "thinking"
            : "happy";
      expect(
        resolveReaction({ pet: petId, personality: personality.id, event: "user-started-message" })
          .state,
        `${petId}/${personality.id}`,
      ).toBe(expected);
    }
  });

  it("waits the way the resting hint says, and never as inattention or distress", () => {
    for (const { petId, personality } of definitions) {
      const resting = personality.hints?.restingState ?? INITIAL_PET_STATE;
      const expected = resting === "sleeping" || resting === "happy" ? resting : "thinking";
      const state = resolveReaction({ pet: petId, personality: personality.id, event: "response-started" })
        .state;
      expect(state, `${petId}/${personality.id}`).toBe(expected);
      expect([INITIAL_PET_STATE, "sad"], `${petId}/${personality.id}`).not.toContain(state);
    }
  });

  it("takes a cancellation as a chance to doze only where the resting hint is sleep", () => {
    for (const { petId, personality } of definitions) {
      const drowsy = personality.hints?.restingState === "sleeping";
      expect(
        resolveReaction({ pet: petId, personality: personality.id, event: "cancelled" }).state,
        `${petId}/${personality.id}`,
      ).toBe(drowsy ? "sleeping" : INITIAL_PET_STATE);
    }
  });

  it("keeps the resting hint out of a settle signal, out of real processing, and out of a failure", () => {
    for (const { petId, personality } of definitions) {
      const label = `${petId}/${personality.id}`;
      expect(
        resolveReaction({ pet: petId, personality: personality.id, event: "idle" }).state,
        label,
      ).toBe(INITIAL_PET_STATE);
      expect(
        resolveReaction({ pet: petId, personality: personality.id, event: "thinking" }).state,
        label,
      ).toBe("thinking");
      expect(
        resolveReaction({ pet: petId, personality: personality.id, event: "response-error" }).state,
        label,
      ).toBe("sad");
    }
  });
});

describe("stability: the resolver stays a pure function", () => {
  it("returns an identical reaction for repeated identical inputs", () => {
    for (const entry of EXPECTED_MATRIX) {
      for (const event of PET_REACTION_EVENTS) {
        const first = resolve(entry.personality, entry.pet, event, "sleeping");
        const label = `${entry.personality}/${event}`;
        expect(resolve(entry.personality, entry.pet, event, "sleeping"), label).toEqual(first);
        expect(resolve(entry.personality, entry.pet, event, "sleeping"), label).toEqual(first);
      }
    }
  });

  it("consults the current state for cancellation only", () => {
    for (const entry of EXPECTED_MATRIX) {
      for (const event of PET_REACTION_EVENTS.filter((name) => name !== "cancelled")) {
        const label = `${entry.personality}/${event}`;
        expect(resolve(entry.personality, entry.pet, event, "sleeping"), label).toEqual(
          resolve(entry.personality, entry.pet, event, INITIAL_PET_STATE),
        );
      }
    }
  });

  it("lets a dozing pet stay asleep through a cancellation, whatever its personality", () => {
    for (const entry of EXPECTED_MATRIX)
      expect(
        resolve(entry.personality, entry.pet, "cancelled", "sleeping").state,
        entry.personality,
      ).toBe("sleeping");
  });

  it("schedules no timer and consults no clock or randomness", () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const intervals = vi.spyOn(globalThis, "setInterval");
    const random = vi.spyOn(Math, "random");
    const now = vi.spyOn(Date, "now");

    try {
      timers.mockClear();
      intervals.mockClear();
      random.mockClear();
      now.mockClear();

      for (const entry of EXPECTED_MATRIX)
        for (const event of PET_REACTION_EVENTS) resolve(entry.personality, entry.pet, event);

      expect(timers).not.toHaveBeenCalled();
      expect(intervals).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
      expect(now).not.toHaveBeenCalled();
    } finally {
      timers.mockRestore();
      intervals.mockRestore();
      random.mockRestore();
      now.mockRestore();
    }
  });

  it("does not mutate the context it is handed", () => {
    const context = {
      pet: CAT,
      personality: "curious",
      event: "response-completed",
      currentState: "thinking",
    };
    const before = { ...context };
    resolveReaction(context);
    expect(context).toEqual(before);
  });

  it("lets one resolution have no effect on the next", () => {
    const calls = EXPECTED_MATRIX.flatMap((entry) =>
      PET_REACTION_EVENTS.map((event) => ({ entry, event })),
    );

    // A full pass in one order, then the same calls again: every result must equal the
    // same resolution made in isolation, so nothing carries over between calls.
    for (const { entry, event } of calls) resolve(entry.personality, entry.pet, event);
    for (const { entry, event } of calls) {
      const label = `${entry.personality}/${event}`;
      expect(resolve(entry.personality, entry.pet, event), label).toEqual(
        resolveReaction({ pet: entry.pet, personality: entry.personality, event }),
      );
    }
  });

  it("resolves a personality definition exactly like its id", () => {
    const definition = listAvailablePets()
      .flatMap((pet) => pet.personalities)
      .find((personality) => personality.id === "curious");
    expect(definition).toBeDefined();

    for (const event of PET_REACTION_EVENTS)
      expect(resolveReaction({ pet: CAT, personality: definition, event }), event).toEqual(
        resolveReaction({ pet: CAT, personality: "curious", event }),
      );
  });
});

describe("personality combinations that cannot be used", () => {
  it("falls back to the pet's own default for a personality that pet does not offer", () => {
    // Ember offers curious and playful, so a stored "calm" resolves as curious does.
    for (const event of PET_REACTION_EVENTS)
      expect(resolve("calm", FOX, event), event).toEqual(resolve("curious", FOX, event));
  });

  it("falls back to the default pet for an unavailable or unknown pet id", () => {
    for (const pet of ["pip-rabbit", "nope", "", undefined, 42, null]) {
      for (const event of PET_REACTION_EVENTS) {
        const reaction = resolveReaction({ pet, personality: "sleepy", event });
        expect(reaction, `${String(pet)}/${event}`).toEqual(
          resolveReaction({ pet: CAT, personality: "sleepy", event }),
        );
      }
    }
  });

  it("stays safe when the pet, the personality, and the event are all unusable", () => {
    for (const event of [...PET_REACTION_EVENTS, "nope", "playful-greeting", undefined, 42, null]) {
      const reaction = resolveReaction({ pet: "nope", personality: "nope", event });
      expect(isPetState(reaction.state), String(event)).toBe(true);
      expect(PET_STATES, String(event)).toContain(reaction.state);
      expect(typeof reaction.reason, String(event)).toBe("string");
    }

    // An event outside the vocabulary settles rather than guessing at a reaction.
    expect(resolveReaction({ pet: "nope", personality: "nope", event: "nope" }).state).toBe(
      INITIAL_PET_STATE,
    );
  });

  it("never derives an event name from a personality", () => {
    for (const personality of PET_PERSONALITIES) {
      expect(isPetReactionEvent(`${personality}-reaction`)).toBe(false);
      expect(isPetReactionEvent(`personality:${personality}`)).toBe(false);
      for (const event of PET_REACTION_EVENTS) expect(event, event).not.toContain(personality);
    }

    // The vocabulary is still exactly the eight declared events, each with one label.
    expect(Object.keys(PET_REACTION_EVENT_LABELS).sort()).toEqual([...PET_REACTION_EVENTS].sort());
  });
});
