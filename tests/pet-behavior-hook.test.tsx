// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePet } from "../src/features/pets/catalog";
import { PetRenderer } from "../src/features/pets/components/pet-renderer";
import { PET_REACTION_DURATIONS, PET_REACTION_EVENTS } from "../src/features/pets/reactions";
import { usePetBehavior } from "../src/features/pets/use-pet-behavior";

/**
 * The behavior controller against a real React root in jsdom, so the parts a pure
 * function cannot cover are actually exercised: that a dispatch reaches the renderer,
 * that a temporary reaction settles on its own, that timers are cleared, and that
 * nothing can update state after unmount.
 *
 * The harness is driven by real clicks rather than by reaching into the hook, so the
 * test goes through the same path a user's click would. Fake timers keep it
 * deterministic — no test here waits in real time — and nothing touches the network,
 * the database, or the AI.
 */

const CAT = "yori-cat";
const FOX = "ember-fox";

function Harness({ pet, personality }: { pet?: string; personality?: string }) {
  const behavior = usePetBehavior({ pet, personality });
  return (
    <>
      {/* The renderer is presentational: it only ever receives the resolved state. */}
      <PetRenderer pet={resolvePet(pet)} personality={personality} state={behavior.state} />
      <output className="t-last">{behavior.lastEvent ?? ""}</output>
      <button type="button" className="t-reset" onClick={() => behavior.reset()}>
        reset
      </button>
      <button type="button" className="t-hold" onClick={() => behavior.holdState("sleeping")}>
        hold
      </button>
      {PET_REACTION_EVENTS.map((event) => (
        <button
          key={event}
          type="button"
          className={`t-event-${event}`}
          onClick={() => behavior.dispatch(event)}
        >
          {event}
        </button>
      ))}
    </>
  );
}

let container: HTMLDivElement;
let root: Root;

function mount(pet: string, personality?: string) {
  act(() => {
    root.render(<Harness pet={pet} personality={personality} />);
  });
}

function click(selector: string) {
  const element = container.querySelector<HTMLButtonElement>(selector);
  if (!element) throw new Error(`nothing mounted at ${selector}`);
  act(() => {
    element.click();
  });
}

function dispatchEvent(event: string) {
  click(`.t-event-${event}`);
}

function renderedState(): string | null {
  return container.querySelector(".pet-renderer")?.getAttribute("data-state") ?? null;
}

function lastEvent(): string {
  return container.querySelector(".t-last")?.textContent ?? "";
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

describe("the behavior controller", () => {
  it("starts idle and hands that state to the renderer", () => {
    mount(CAT, "calm");
    expect(renderedState()).toBe("idle");
    expect(lastEvent()).toBe("");
  });

  it("resolves a dispatched event into the renderer", () => {
    mount(CAT, "calm");

    dispatchEvent("thinking");

    expect(renderedState()).toBe("thinking");
    expect(lastEvent()).toBe("thinking");
  });

  it("lets a temporary reaction settle back to idle on its own", () => {
    mount(CAT, "calm");

    dispatchEvent("response-completed");
    expect(renderedState()).toBe("happy");

    // Just before the duration elapses the reaction is still showing.
    advance(PET_REACTION_DURATIONS.brief - 1);
    expect(renderedState()).toBe("happy");

    advance(1);
    expect(renderedState()).toBe("idle");
  });

  it("holds a reaction that has no duration until the next event", () => {
    mount(CAT, "calm");

    dispatchEvent("thinking");
    advance(PET_REACTION_DURATIONS.lingering * 4);

    expect(renderedState()).toBe("thinking");
  });

  it("reset settles immediately and cancels the pending settle timer", () => {
    mount(CAT, "calm");

    dispatchEvent("response-error");
    expect(renderedState()).toBe("sad");

    click(".t-reset");
    expect(renderedState()).toBe("idle");
    expect(lastEvent()).toBe("");

    // The cancelled timer must not fire later and re-run a settle.
    advance(PET_REACTION_DURATIONS.lingering * 2);
    expect(renderedState()).toBe("idle");
  });

  it("lets a newer event replace a pending reaction", () => {
    mount(CAT, "calm");

    dispatchEvent("response-error");
    expect(renderedState()).toBe("sad");

    dispatchEvent("response-completed");
    expect(renderedState()).toBe("happy");

    // One brief duration is enough, because only one settle timer is outstanding.
    advance(PET_REACTION_DURATIONS.brief);
    expect(renderedState()).toBe("idle");
  });

  it("pins a state directly for the playground's manual controls, with no timer", () => {
    mount(CAT, "calm");

    click(".t-hold");
    expect(renderedState()).toBe("sleeping");

    advance(PET_REACTION_DURATIONS.lingering * 4);
    expect(renderedState()).toBe("sleeping");
  });

  it("resets when the pet changes, so no stale behavior survives", () => {
    mount(CAT, "calm");
    dispatchEvent("thinking");
    expect(renderedState()).toBe("thinking");

    mount(FOX, "curious");

    expect(renderedState()).toBe("idle");
    expect(lastEvent()).toBe("");
  });

  it("resolves reactions for the new personality, not the old one", () => {
    mount(CAT, "calm");
    dispatchEvent("response-started");
    expect(renderedState()).toBe("thinking");

    // Same pet, different personality: the drowsy rule applies now.
    mount(CAT, "sleepy");
    expect(renderedState()).toBe("idle");

    dispatchEvent("response-started");
    expect(renderedState()).toBe("sleeping");
  });

  it("resets when the personality changes", () => {
    mount(CAT, "sleepy");
    dispatchEvent("response-started");
    expect(renderedState()).toBe("sleeping");

    mount(CAT, "calm");
    expect(renderedState()).toBe("idle");
  });

  it("resolves an unusable pet or personality to a safe default instead of throwing", () => {
    mount("nope", "nope");

    expect(renderedState()).toBe("idle");
    dispatchEvent("thinking");
    expect(renderedState()).toBe("thinking");
  });

  it("clears the pending timer on unmount and never updates state afterwards", () => {
    mount(CAT, "calm");

    dispatchEvent("response-completed");
    expect(renderedState()).toBe("happy");

    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    act(() => {
      root.unmount();
    });

    // Unmounting cancels the outstanding settle timer.
    expect(clearSpy).toHaveBeenCalled();

    // Letting time run past the duration must not throw or warn: the guard bails out.
    expect(() => {
      advance(PET_REACTION_DURATIONS.brief * 2);
    }).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();

    // The DOM is gone; nothing was written back into it.
    expect(container.querySelector(".pet-renderer")).toBeNull();
  });
});
