/**
 * The pet state vocabulary: the states a pet can be in, and nothing else.
 *
 * This module is deliberately dumb. It holds the list, a guard, a safe fallback,
 * and human labels — no timers, no transition rules, no knowledge of how a state
 * looks. What a state *looks* like lives in `animations.ts`, and when a state may
 * follow another is a later task's business; keeping the two apart means behavior
 * can grow without touching the vocabulary or the renderer.
 *
 * Nothing here reaches the network, the database, or the AI: a pet state is not
 * connected to replies, streaming, or sentiment at this step.
 */

/** Every state a pet can be in, in the order the playground lists them. */
export const PET_STATES = [
  "idle",
  "happy",
  "thinking",
  "sleeping",
  "sad",
  "excited",
] as const;

export type PetState = (typeof PET_STATES)[number];

/** Where every pet starts. A fresh renderer is never in an invented state. */
export const INITIAL_PET_STATE: PetState = "idle";

/** True for exactly the six supported states. */
export function isPetState(value: unknown): value is PetState {
  return typeof value === "string" && (PET_STATES as readonly string[]).includes(value);
}

/**
 * The state a value means, falling back to the initial one. Anything unknown —
 * a removed state, a typo, a value from a future client — resolves to `idle`
 * instead of throwing or rendering an undefined treatment.
 */
export function toPetState(value: unknown): PetState {
  return isPetState(value) ? value : INITIAL_PET_STATE;
}

/** Short names for the controls and captions. */
export const PET_STATE_LABELS: Record<PetState, string> = {
  idle: "Idle",
  happy: "Happy",
  thinking: "Thinking",
  sleeping: "Sleeping",
  sad: "Sad",
  excited: "Excited",
};
