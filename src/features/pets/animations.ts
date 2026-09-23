import { INITIAL_PET_STATE, isPetState, PET_STATES, type PetState } from "./state";

/**
 * What each state looks like.
 *
 * One row per state, and only rows: no timers, no state machine, no DOM access.
 * The renderer reads a row and puts the two class names on the markup; the
 * stylesheet (`src/app/globals.css`) owns the keyframes and the pose. That keeps
 * the state vocabulary (`state.ts`), the visual treatment (here), and the markup
 * (`components/pet-renderer.tsx`) three separate places, so a later task can add a
 * state by adding a row plus a keyframe — without editing the renderer.
 *
 * Every treatment is a CSS class and a pose, never a script: no canvas, no
 * animation library, no per-frame JavaScript.
 */

export type PetTreatment = {
  /** Applied to the renderer root; drives the static pose (eyes, mouth, marks). */
  poseClass: string;
  /** Applied to the renderer root; drives the movement, if the state has any. */
  motionClass: string;
  /** False when the state is a still pose, so nothing depends on motion. */
  moves: boolean;
  /** Plain words for the playground caption. */
  caption: string;
};

export const PET_TREATMENTS: Record<PetState, PetTreatment> = {
  idle: {
    poseClass: "pet-pose-idle",
    motionClass: "pet-motion-breathe",
    moves: true,
    caption: "Resting, and watching the conversation.",
  },
  happy: {
    poseClass: "pet-pose-happy",
    motionClass: "pet-motion-bounce",
    moves: true,
    caption: "Pleased about something.",
  },
  thinking: {
    poseClass: "pet-pose-thinking",
    motionClass: "pet-motion-ponder",
    moves: true,
    caption: "Turning something over.",
  },
  sleeping: {
    poseClass: "pet-pose-sleeping",
    motionClass: "pet-motion-doze",
    moves: true,
    caption: "Asleep for now.",
  },
  // A still pose on purpose: this state reads the same with motion switched off,
  // which is what the reduced-motion rule relies on.
  sad: {
    poseClass: "pet-pose-sad",
    motionClass: "pet-motion-still",
    moves: false,
    caption: "Feeling a little low.",
  },
  excited: {
    poseClass: "pet-pose-excited",
    motionClass: "pet-motion-wiggle",
    moves: true,
    caption: "Full of energy.",
  },
};

/**
 * The treatment for a state, tolerating anything: an unknown value gets the
 * initial state's treatment rather than `undefined`, so the renderer can put the
 * result straight onto the markup.
 */
export function petTreatment(state: unknown): PetTreatment {
  return PET_TREATMENTS[isPetState(state) ? state : INITIAL_PET_STATE];
}

/** True when every supported state has exactly one treatment. */
export function hasTreatmentForEveryState(): boolean {
  return PET_STATES.every((state) => PET_TREATMENTS[state] !== undefined);
}
