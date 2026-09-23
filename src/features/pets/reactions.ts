import { resolvePersonalityForPet, resolvePet } from "./catalog";
import { INITIAL_PET_STATE, toPetState, type PetState } from "./state";
import { isPetPersonality, type PetPersonalityDefinition } from "./types";

/**
 * The reaction engine: application events in, existing pet states out.
 *
 * This module is a pure function of its inputs. It has no React, no timers, no
 * network, no database, and no AI: the same pet, personality, event, and current state
 * always produce the same reaction, which is what makes it testable with synthetic
 * events and what keeps a pet's behavior predictable. Nothing here is connected to
 * OpenRouter, streaming, or real chat events yet — see `CHAT_PHASE_REACTIONS` for the
 * seam a later task will use.
 *
 * It deliberately reuses the existing state vocabulary from `state.ts` rather than
 * inventing a second one: where an event has no exact match, the closest existing state
 * is used and the choice is written down in the mapping below.
 *
 * The chat lifecycle reaches this engine through `CHAT_PHASE_REACTIONS` below, via the
 * small adapter in `features/chat/pet-reactions.ts`. That is the only caller with real
 * events behind it, and it changes nothing here: no OpenRouter, no prompt, no request,
 * and no natural language enters this module from either direction.
 */

/**
 * The whole event vocabulary. Intentionally small — these are the moments a companion
 * can plausibly react to, not every application event.
 */
export const PET_REACTION_EVENTS = [
  "idle",
  "user-started-message",
  "thinking",
  "response-started",
  "response-completed",
  "response-error",
  "cancelled",
  "successful-action",
] as const;

export type PetReactionEvent = (typeof PET_REACTION_EVENTS)[number];

/** True for exactly the declared events. */
export function isPetReactionEvent(value: unknown): value is PetReactionEvent {
  return typeof value === "string" && (PET_REACTION_EVENTS as readonly string[]).includes(value);
}

/** Short labels for the playground's reaction controls. */
export const PET_REACTION_EVENT_LABELS: Record<PetReactionEvent, string> = {
  idle: "Settle",
  "user-started-message": "User Message",
  thinking: "Start Thinking",
  "response-started": "Response Started",
  "response-completed": "Response Complete",
  "response-error": "Response Error",
  cancelled: "Cancel",
  "successful-action": "Saved",
};

/**
 * How long a temporary reaction lasts before the pet settles back to idle. Modest on
 * purpose: long enough to notice, short enough not to nag. One place to adjust them.
 */
export const PET_REACTION_DURATIONS = {
  /** A brief acknowledgement. */
  brief: 1_600,
  /** A little longer, so a failure is actually seen before the pet settles. */
  lingering: 2_400,
} as const;

/**
 * What a reaction resolves to.
 *
 * `durationMs` is `null` for a reaction that holds until the next event, and a number
 * of milliseconds for one that settles back to `idle` on its own. `reason` is a short,
 * deterministic description — useful for a demo caption and for tests, never prose fed
 * to a model.
 */
export type PetReaction = {
  state: PetState;
  durationMs: number | null;
  reason: string;
};

/**
 * Everything the mapping looks at. Each field is optional and untyped on purpose: the
 * engine is called with values that may come from storage, a prop, or a test fixture,
 * so an unknown pet, an unknown personality, a missing current state, or an event that
 * is not in the vocabulary must all degrade safely instead of throwing.
 */
export type PetReactionContext = {
  pet?: unknown;
  personality?: unknown;
  event?: unknown;
  currentState?: unknown;
};

function hold(state: PetState, reason: string): PetReaction {
  return { state, durationMs: null, reason };
}

function brief(state: PetState, reason: string): PetReaction {
  return { state, durationMs: PET_REACTION_DURATIONS.brief, reason };
}

function lingering(state: PetState, reason: string): PetReaction {
  return { state, durationMs: PET_REACTION_DURATIONS.lingering, reason };
}

/** The id inside a personality id or definition; `undefined` when there is neither. */
function personalityIdOf(personality: unknown): string | undefined {
  if (typeof personality === "string") return personality;
  if (isPetPersonality(personality)) return (personality as PetPersonalityDefinition).id;
  return undefined;
}

/**
 * The reaction for one event, given the pet, its personality, and the state the pet is
 * already in.
 *
 * Personality enters through the two hints the catalog already declares — no extra
 * schema, and only two rules:
 *
 * - `motionLevel: "high"` (playful) turns an acknowledgement into `excited` where a
 *   calmer pet only manages `happy`.
 * - `restingState: "sleeping"` (sleepy) keeps a drowsy pet dozing through
 *   `response-started` instead of perking up to `thinking`.
 *
 * The current state is consulted once, for `cancelled`: a request cancelled while the
 * pet was asleep does not wake it. Everything else resolves from the event alone, so
 * the whole mapping stays small enough to read at a glance.
 *
 * Documented compromises where no existing state is an exact match:
 * - `response-started` has no "attentive" state, so a waiting pet shows `thinking`
 *   (the closest existing state to "paying attention to something in progress").
 * - `successful-action` shares the positive reaction with `response-completed`, since
 *   both mean "that went well" and `happy`/`excited` already say it.
 * - `idle` always resolves to the literal `idle` state — it is an explicit settle
 *   signal, not "whatever this personality rests at".
 */
export function resolveReaction(context: PetReactionContext): PetReaction {
  const event = isPetReactionEvent(context.event) ? context.event : "idle";
  const pet = resolvePet(context.pet);
  const personality = resolvePersonalityForPet(pet.id, personalityIdOf(context.personality));
  const currentState = toPetState(context.currentState);

  const energetic = personality.hints?.motionLevel === "high";
  const drowsy = personality.hints?.restingState === "sleeping";
  const positive = energetic ? "excited" : "happy";

  switch (event) {
    case "idle":
      return hold(INITIAL_PET_STATE, "Nothing is happening, so the pet settles.");

    case "cancelled":
      if (currentState === "sleeping")
        return hold("sleeping", "The request was cancelled; a dozing pet stays asleep.");
      return hold(INITIAL_PET_STATE, "The request was cancelled, so the pet settles back.");

    case "user-started-message":
      return brief(
        positive,
        energetic ? "You started writing, and this pet is all ears." : "You started writing.",
      );

    case "thinking":
      return hold("thinking", "Something is being worked out.");

    case "response-started":
      return drowsy
        ? hold("sleeping", "An answer is on the way; a drowsy pet keeps dozing.")
        : hold("thinking", "An answer is on the way, so the pet is paying attention.");

    case "response-completed":
    case "successful-action":
      return brief(
        positive,
        energetic ? "That went well, and this pet cannot sit still." : "That went well.",
      );

    case "response-error":
      // The only non-positive state in the vocabulary, so an error always reads the
      // same way — a failure should not depend on how bouncy the pet is.
      return lingering("sad", "Something went wrong, and the pet feels it.");
  }
}

/**
 * The chat lifecycle, mapped onto the vocabulary above.
 *
 * Consumed by the adapter in `features/chat/pet-reactions.ts`, which the chat shell
 * reports real stream phases to. The mapping itself stays here so the names a chat
 * phase resolves to live next to the events they produce, and so no second vocabulary
 * can grow on the chat side. Nothing in this module makes a request or reads a stream.
 */
export const CHAT_PHASE_REACTIONS = {
  "composer-submit": "user-started-message",
  "request-started": "thinking",
  "stream-started": "response-started",
  "stream-completed": "response-completed",
  "stream-error": "response-error",
  "stream-cancelled": "cancelled",
} as const satisfies Record<string, PetReactionEvent>;

export type ChatPhase = keyof typeof CHAT_PHASE_REACTIONS;

/** The reaction event for a chat phase. */
export function reactionForChatPhase(phase: ChatPhase): PetReactionEvent {
  return CHAT_PHASE_REACTIONS[phase];
}

/** True for exactly the declared chat phases. */
export function isChatPhase(value: unknown): value is ChatPhase {
  return typeof value === "string" && Object.hasOwn(CHAT_PHASE_REACTIONS, value);
}
