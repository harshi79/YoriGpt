"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { resolvePersonalityForPet, resolvePet } from "./catalog";
import { resolveReaction, type PetReactionEvent } from "./reactions";
import { INITIAL_PET_STATE, type PetState } from "./state";

/**
 * The client-side behavior controller: the one place that turns reaction events into a
 * resolved pet state.
 *
 * The engine (`reactions.ts`) is pure; this hook owns the only mutable parts — the
 * current state, the single settle timer, and the unmount guard. Keeping them here
 * means no component ever creates its own timer, so there is exactly one place a
 * timeout can leak and exactly one place that clears it.
 *
 * State is *derived*, not synced: the resolved state is stored together with the pet
 * and personality that produced it, and anything recorded for a different
 * configuration simply reads as `idle`. So changing pet or personality needs no effect,
 * no extra render pass, and cannot leave the previous companion's mood — or a stale
 * personality rule — behind.
 *
 * Client-side only. No network, no database, no OpenRouter: nothing here is persisted.
 */

/** What the controller holds: a reaction, and the configuration that produced it. */
type BehaviorRecord = {
  petId: string;
  personalityId: string;
  state: PetState;
  lastEvent: PetReactionEvent | null;
};

const NO_REACTION: BehaviorRecord = {
  petId: "",
  personalityId: "",
  state: INITIAL_PET_STATE,
  lastEvent: null,
};

export type PetBehavior = {
  /** The resolved state to hand straight to `<PetRenderer state={…} />`. */
  state: PetState;
  /** The last reaction event dispatched, or `null` when nothing is in effect. */
  lastEvent: PetReactionEvent | null;
  /** React to an application event. */
  dispatch: (event: PetReactionEvent) => void;
  /** Pin a state directly, with no timer. Used by the playground's manual controls. */
  holdState: (state: PetState) => void;
  /** Settle immediately and cancel any pending settle timer. */
  reset: () => void;
};

export type UsePetBehaviorOptions = {
  /** A pet id; anything unusable resolves to the catalog default. */
  pet?: unknown;
  /** A personality id; resolved for the pet above. */
  personality?: unknown;
};

export function usePetBehavior(options: UsePetBehaviorOptions = {}): PetBehavior {
  // Resolved every render, so the mapping can never act on a stale configuration.
  const pet = resolvePet(options.pet);
  const personality = resolvePersonalityForPet(pet.id, options.personality);

  const [record, setRecord] = useState<BehaviorRecord>(NO_REACTION);

  // One timer for the whole controller, plus a guard so a settle firing after unmount
  // can never update a component that is gone.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  // A mirror of the resolved state, for the mapping's "current state" input.
  const stateRef = useRef<PetState>(INITIAL_PET_STATE);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  // Cleanup on unmount: cancel the pending settle and stop accepting further ones.
  // No state is written here, so nothing can land after the component is gone.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, []);

  // A recorded reaction only counts while it belongs to the current configuration;
  // otherwise the pet is simply idle. This is what makes a pet or personality change
  // reset the behavior with no effect and no stale value.
  const active = record.petId === pet.id && record.personalityId === personality.id;
  const state = active ? record.state : INITIAL_PET_STATE;
  const lastEvent = active ? record.lastEvent : null;

  const dispatch = useCallback(
    (event: PetReactionEvent) => {
      const reaction = resolveReaction({
        pet: pet.id,
        personality: personality.id,
        event,
        currentState: stateRef.current,
      });

      // A reaction replaces whatever was pending: the newest event wins, and no two
      // settle timers are ever outstanding at once.
      clearTimer();
      stateRef.current = reaction.state;
      setRecord({
        petId: pet.id,
        personalityId: personality.id,
        state: reaction.state,
        lastEvent: event,
      });

      if (reaction.durationMs !== null) {
        timer.current = setTimeout(() => {
          timer.current = null;
          if (!alive.current) return;
          stateRef.current = INITIAL_PET_STATE;
          // Keeping the recorded ids means a settle that arrives after a configuration
          // change still resolves to idle rather than resurrecting the old pet's mood.
          setRecord((current) => ({ ...current, state: INITIAL_PET_STATE }));
        }, reaction.durationMs);
      }
    },
    [pet.id, personality.id, clearTimer],
  );

  const holdState = useCallback(
    (next: PetState) => {
      clearTimer();
      stateRef.current = next;
      setRecord({ petId: pet.id, personalityId: personality.id, state: next, lastEvent: null });
    },
    [pet.id, personality.id, clearTimer],
  );

  const reset = useCallback(() => {
    clearTimer();
    stateRef.current = INITIAL_PET_STATE;
    setRecord((current) => ({ ...current, state: INITIAL_PET_STATE, lastEvent: null }));
  }, [clearTimer]);

  return { state, lastEvent, dispatch, holdState, reset };
}
