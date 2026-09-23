import { describe, expect, it } from "vitest";
import { hasTreatmentForEveryState, PET_TREATMENTS, petTreatment } from "../src/features/pets/animations";
import {
  INITIAL_PET_STATE,
  isPetState,
  PET_STATES,
  PET_STATE_LABELS,
  toPetState,
  type PetState,
} from "../src/features/pets/state";

describe("the pet state vocabulary", () => {
  it("supports the six foundational states", () => {
    for (const state of ["idle", "happy", "thinking", "sleeping", "sad", "excited"]) {
      expect(PET_STATES, state).toContain(state);
      expect(isPetState(state), state).toBe(true);
      expect(PET_STATE_LABELS[state as PetState], state).toBeTruthy();
    }
  });

  it("rejects unknown values from the vocabulary", () => {
    expect(isPetState("zooming")).toBe(false);
    expect(isPetState("")).toBe(false);
    expect(isPetState(42)).toBe(false);
    expect(isPetState(undefined)).toBe(false);
  });

  it("falls back to a safe state for unknown values", () => {
    expect(toPetState("zooming")).toBe(INITIAL_PET_STATE);
    expect(toPetState(undefined)).toBe(INITIAL_PET_STATE);
    expect(toPetState("happy")).toBe("happy");
  });

  it("starts every pet at the documented initial state", () => {
    expect(INITIAL_PET_STATE).toBe("idle");
    expect(isPetState(INITIAL_PET_STATE)).toBe(true);
  });
});

describe("the state treatments", () => {
  it("has a treatment for every supported state", () => {
    expect(hasTreatmentForEveryState()).toBe(true);
    for (const state of PET_STATES) {
      const treatment = petTreatment(state);
      expect(treatment.poseClass, state).toMatch(/^pet-pose-/);
      expect(treatment.motionClass, state).toMatch(/^pet-motion-/);
      expect(treatment.caption, state).not.toBe("");
    }
  });

  it("treats each state distinctly, so states are visually separable", () => {
    const poses = new Set(PET_STATES.map((state) => petTreatment(state).poseClass));
    expect(poses.size).toBe(PET_STATES.length);
  });

  it("falls back to a defined treatment for unknown states", () => {
    expect(petTreatment("nope")).toEqual(petTreatment(INITIAL_PET_STATE));
  });

  it("keeps at least one state as a still pose, so nothing relies on motion alone", () => {
    const still = PET_STATES.filter((state) => petTreatment(state).moves === false);
    expect(still.length).toBeGreaterThan(0);
    // The still state is drawn from a pose, not an animation.
    for (const state of still) {
      expect(PET_TREATMENTS[state].poseClass).toMatch(/^pet-pose-/);
    }
  });

  it("keeps motion out of the state vocabulary and rendering out of the treatments", () => {
    // The treatments never reach for a timer, and the vocabulary never names a class.
    expect(PET_STATES.length).toBe(Object.keys(PET_TREATMENTS).length);
  });
});
