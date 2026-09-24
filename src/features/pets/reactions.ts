import { resolvePersonalityForPet, resolvePet } from "./catalog";
import { INITIAL_PET_STATE, toPetState, type PetState } from "./state";
import { isPetPersonality, type PetPersonalityDefinition } from "./types";

/**
 * The reaction engine: application events in, existing pet states out.
 *
 * This module is a pure function of its inputs. It has no React, no timers, no
 * network, no database, and no AI: the same pet, personality, event, and current state
 * always produce the same reaction, which is what makes it testable with synthetic
 * events and what keeps a pet's behavior predictable. Real chat events reach it only as
 * one of the vocabulary items below — never as a stream, a request, or model output.
 *
 * It deliberately reuses the existing state vocabulary from `state.ts` rather than
 * inventing a second one: where an event has no exact match, the closest existing state
 * is used and the choice is written down in the mapping below.
 *
 * Personalities change those outcomes, and they do it as **local behavior metadata**:
 * the trait tags and the two hints each catalog definition already carries are read
 * into a small temperament, and the temperament — never a personality id, and never
 * anything a client supplied — decides which existing state an event resolves to. Same
 * inputs, same output, every time: no randomness, no timers, no learning, no memory,
 * and no generated language. This engine sends no messages to either AI provider;
 * the separate server-side instruction builder reads the same catalog metadata for
 * response style without affecting any visual transition.
 *
 * The chat lifecycle reaches this engine through `CHAT_PHASE_REACTIONS` below, via the
 * small adapter in `features/chat/pet-reactions.ts`. That is the only caller with real
 * events behind it, and it changes nothing here: no provider, prompt, or request,
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
 * How a personality behaves, derived from the metadata the catalog already declares —
 * its trait tags and its two hints. Nothing here is stored, persisted, or sent
 * anywhere, and no personality is named: this is a *reading* of the definition, so a
 * fifth personality would behave according to its own metadata with no edit here.
 */
type Temperament = {
  /** Shows a good outcome at full strength (`excited`) rather than warmly (`happy`). */
  expressive: boolean;
  /** The user's own company is part of what this personality reacts to. */
  sociable: boolean;
  /** New information is what this personality leans toward. */
  inquisitive: boolean;
  /** The state this personality tends toward when it has nothing to do. */
  resting: PetState;
};

function temperamentOf(personality: PetPersonalityDefinition): Temperament {
  return {
    // Either hint of energy is enough: a high-motion personality, or one the catalog
    // tags `energetic`, cannot help but show a good outcome at full strength.
    expressive:
      personality.hints?.motionLevel === "high" || personality.traits.includes("energetic"),
    sociable: personality.traits.includes("sociable"),
    inquisitive: personality.traits.includes("inquisitive"),
    resting: personality.hints?.restingState ?? INITIAL_PET_STATE,
  };
}

/**
 * The states that can plausibly mean "waiting for an answer". A personality resting at
 * `idle` would read as inattention and one resting at `sad` as distress, so neither is
 * used for a wait; they pay attention instead.
 */
const WAITING_STATES: readonly PetState[] = ["thinking", "happy", "sleeping"];

/** How a pet waits while an answer is on the way, from its resting hint. */
function waitingState(resting: PetState): PetState {
  return WAITING_STATES.includes(resting) ? resting : "thinking";
}

/** Why the waiting pet shows the state it does. Keyed by state, never by personality. */
function waitingReason(state: PetState): string {
  switch (state) {
    case "sleeping":
      return "An answer is on the way; a drowsy pet keeps dozing.";
    case "happy":
      return "An answer is on the way, and this pet is enjoying the wait.";
    default:
      return "An answer is on the way, so the pet is paying attention.";
  }
}

/**
 * The reaction for one event, given the pet, its personality, and the state the pet is
 * already in.
 *
 * Personality enters only through metadata the catalog already declares — the trait
 * tags and the two hints — and never through a personality id, so the mapping below
 * names no personality and stays one readable switch:
 *
 * - `motionLevel: "high"`, or the `energetic` trait, makes a personality
 *   **expressive**: a good outcome is `excited` where a restrained pet manages `happy`.
 * - the `sociable` trait means the user's own company is worth reacting to, so an
 *   expressive *and* sociable pet greets `user-started-message` with `excited`.
 * - the `inquisitive` trait turns that same greeting into attention — `thinking`, the
 *   vocabulary's only "paying attention" state — instead of a celebration.
 * - `restingState` decides how the pet waits while an answer is on the way, and
 *   whether a cancellation is an opportunity to doze.
 *
 * With the catalog as it stands, that yields four companions that are observably
 * different on the same events (`brief`/`hold`/`lingering` are the durations):
 *
 * | event                  | calm     | playful  | curious  | sleepy   |
 * | ---------------------- | -------- | -------- | -------- | -------- |
 * | `user-started-message` | happy    | excited  | thinking | happy    |
 * | `thinking`             | thinking | thinking | thinking | thinking |
 * | `response-started`     | thinking | happy    | thinking | sleeping |
 * | `response-completed`   | happy    | excited  | excited  | happy    |
 * | `successful-action`    | happy    | excited  | excited  | happy    |
 * | `response-error`       | sad      | sad      | sad      | sad      |
 * | `cancelled`            | idle     | idle     | idle     | sleeping |
 * | `idle`                 | idle     | idle     | idle     | idle     |
 *
 * Two events deliberately do **not** vary, because varying them would misinform:
 * `response-error` is always `sad` (a failure must read the same however bouncy or
 * drowsy the pet is, and never as something positive), and `thinking` is always
 * `thinking` (it reports that processing is really happening). `cancelled` is never
 * positive either — the most a drowsy pet gets out of it is a nap.
 *
 * The current state is consulted once, for `cancelled`: a pet already asleep is not
 * woken by a request that stopped. Everything else resolves from the event and the
 * personality metadata alone, so the whole mapping stays small enough to read at a
 * glance.
 *
 * Documented compromises where no existing state is an exact match:
 * - `response-started` has no "attentive" state, so a waiting pet shows `thinking`
 *   (the closest existing state to "paying attention to something in progress") unless
 *   its personality rests somewhere that reads as waiting just as well.
 * - `user-started-message` for an inquisitive pet reuses that same `thinking`, since
 *   interest and attention look the same in this vocabulary.
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
  const temperament = temperamentOf(personality);

  switch (event) {
    case "idle":
      return hold(INITIAL_PET_STATE, "Nothing is happening, so the pet settles.");

    case "cancelled":
      // Nothing left to wait for. A drowsy personality takes the chance to doze, and a
      // pet that was already asleep is not woken; everyone else settles back.
      if (temperament.resting === "sleeping" || currentState === "sleeping")
        return hold("sleeping", "The request was cancelled; a drowsy pet dozes through it.");
      return hold(INITIAL_PET_STATE, "The request was cancelled, so the pet settles back.");

    case "user-started-message":
      // The acknowledgement, and the clearest place personalities part company: company
      // is the exciting part for a sociable pet with energy to spare, an inquisitive one
      // wants to know where this is going, and anyone else is simply pleased.
      if (temperament.sociable && temperament.expressive)
        return brief("excited", "You started writing, and this pet is all ears.");
      if (temperament.inquisitive)
        return brief(
          "thinking",
          "You started writing, and this pet wants to know where it is going.",
        );
      return brief("happy", "You started writing.");

    case "thinking":
      // Real processing, which every personality shows the same way: nothing else in
      // the vocabulary says "working something out".
      return hold("thinking", "Something is being worked out.");

    case "response-started": {
      // Waiting is where the resting hint belongs: a drowsy pet dozes, a playful one
      // enjoys itself, and a pet that rests at attention keeps paying it.
      const waiting = waitingState(temperament.resting);
      return hold(waiting, waitingReason(waiting));
    }

    case "response-completed":
    case "successful-action":
      // Both mean "that went well"; only how strongly the personality shows it differs.
      return temperament.expressive
        ? brief("excited", "That went well, and this pet cannot sit still.")
        : brief("happy", "That went well.");

    case "response-error":
      // The one reaction that must not depend on personality: a failure reads the same
      // however bouncy the pet is, and never as something positive.
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
