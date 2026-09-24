import { reactionForChatPhase, type ChatPhase, type PetReactionEvent } from "../pets/reactions";

/**
 * The single boundary between the chat lifecycle and the pet behavior engine.
 *
 * The chat shell reports *what actually happened* — a message was stored, a reply was
 * requested, the first provider text arrived, the stream finished, failed, or was
 * cancelled — and this module turns each of those into one event from the existing
 * reaction vocabulary. It knows nothing about pets, states, personalities, or timers,
 * and the engine knows nothing about chat: neither side grows a second vocabulary.
 *
 * It exists for one reason beyond naming: **one generation produces one coherent
 * sequence.** A reply request has a single outcome, but it is reached from several
 * places (a submit, a retry, an abort caused by navigation, a stale callback from a
 * replaced stream), and React can call a render-phase callback more than once. So the
 * adapter remembers what it has already said for the generation it was created for:
 *
 * - the first content event is reported once, however many deltas arrive;
 * - once an outcome has been reported, no other outcome can follow it, so a cancelled
 *   or failed generation can never be followed by a success reaction from a late
 *   callback;
 * - once the generation has been *replaced*, nothing at all can follow — not even a
 *   first-content event from a delta that was already in flight — because the newer
 *   generation is the one the companion is following now.
 *
 * A new instance is created per generation, which is what scopes those guarantees to
 * one reply instead of to the component's lifetime. The instance is retired in the
 * same step as the request it belongs to (see `superseded` and `cancelled`), so a
 * generation that is no longer current has no route back to the pet: no timer, no
 * second state, and nothing to clean up later.
 *
 * Client-side only. No network, no database, no persistence, and nothing here reaches
 * a provider: the events describe the chat, they are never sent anywhere.
 */
export type ChatPetReactions = {
  /** The user's message was stored, so their turn really did begin. */
  messageSent: () => void;
  /** A reply request was actually issued. */
  generationStarted: () => void;
  /** The first real assistant content arrived. */
  firstContent: () => void;
  /** The stream completed and the server confirmed the stored reply. */
  completed: () => void;
  /** Generation ended in a failure the chat already reports as an error. */
  failed: () => void;
  /** The active generation was aborted. */
  cancelled: () => void;
  /**
   * A newer generation replaced this one. Seals the reporter *without* reporting:
   * the replacement is authoritative from here and announces itself, so the
   * generation going away must not settle, fail, or celebrate in its name.
   */
  superseded: () => void;
};

/**
 * Binds the lifecycle reporters to one dispatch function.
 *
 * `dispatch` is the behavior controller's own function, so every event this module
 * produces goes through the same deterministic mapping the `/pets` playground uses.
 */
export function createChatPetReactions(
  dispatch: (event: PetReactionEvent) => void,
): ChatPetReactions {
  /** Whether the first content event has been reported for this generation. */
  let contentReported = false;
  /** Whether this generation has already reported how it ended. */
  let outcomeReported = false;

  const report = (phase: ChatPhase) => {
    if (outcomeReported) return;
    dispatch(reactionForChatPhase(phase));
  };

  const outcome = (phase: ChatPhase) => {
    if (outcomeReported) return;
    outcomeReported = true;
    dispatch(reactionForChatPhase(phase));
  };

  return {
    messageSent: () => report("composer-submit"),
    generationStarted: () => report("request-started"),
    firstContent: () => {
      if (contentReported) return;
      contentReported = true;
      report("stream-started");
    },
    completed: () => outcome("stream-completed"),
    failed: () => outcome("stream-error"),
    cancelled: () => outcome("stream-cancelled"),
    // Sealed like an outcome, but silent: the newer generation's own reports are what
    // the companion follows, so nothing is dispatched on the way out.
    superseded: () => {
      outcomeReported = true;
    },
  };
}
