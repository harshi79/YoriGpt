// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PetPlayground } from "../src/features/pets/components/pet-playground";
import { listAvailablePets } from "../src/features/pets/catalog";
import { PET_REACTION_DURATIONS } from "../src/features/pets/reactions";

/**
 * The playground's reaction demo, mounted in jsdom and driven by real clicks.
 *
 * The browser suite covers this page too (`tests/e2e/pets.spec.ts`), but it needs a
 * production build this environment cannot make, so the behaviour that matters most is
 * pinned here as well: that a dispatched event reaches the renderer, that the demo
 * compares the same event across the personalities the selected pet offers, and that
 * the comparison is read-only, local, and never announced. Fake timers keep it
 * deterministic, and nothing here touches the network or the database — an anonymous
 * playground persists nothing, which one test asserts rather than assumes.
 */

let container: HTMLDivElement;
let root: Root;

function mount(props: { pet?: string; personality?: string } = {}) {
  act(() => {
    root.render(
      <PetPlayground
        pets={listAvailablePets()}
        initialPetId={props.pet}
        initialPersonalityId={props.personality}
      />,
    );
  });
}

function group(label: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`no group labelled "${label}"`);
  return element;
}

/**
 * The label a person reads on a button. Pet and reaction buttons put the name in its own
 * span and carry a second line beside it (a species, a detail), so the whole text
 * content is not what the button is called.
 */
function labelOf(button: HTMLButtonElement): string {
  return (
    button.querySelector(".pets-choice-name")?.textContent ?? button.textContent ?? ""
  ).trim();
}

function click(label: string, inGroup: string) {
  const button = [...group(inGroup).querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => labelOf(candidate) === label,
  );
  if (!button) throw new Error(`no "${label}" button in "${inGroup}"`);
  act(() => {
    button.click();
  });
}

/** Fire one of the demo's synthetic events. */
function dispatch(label: string) {
  click(label, "Reaction demo");
}

function renderedState(): string | null {
  return container.querySelector(".pet-renderer")?.getAttribute("data-state") ?? null;
}

function note(): string {
  return container.querySelector(".pets-reaction-note")?.textContent ?? "";
}

function comparison(): HTMLElement | null {
  return container.querySelector<HTMLElement>(".pets-reaction-compare");
}

function comparedStates(): Record<string, string | null> {
  const items = [...container.querySelectorAll<HTMLElement>(".pets-reaction-compare-item")];
  return Object.fromEntries(
    items.map((item) => [item.dataset.personality ?? "", item.dataset.state ?? null]),
  );
}

function comparedCurrent(): string[] {
  return [
    ...container.querySelectorAll<HTMLElement>('.pets-reaction-compare-item[aria-current="true"]'),
  ].map((item) => item.dataset.personality ?? "");
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

describe("the playground's reaction demo", () => {
  it("waits for an event before it shows or compares anything", () => {
    mount();

    expect(renderedState()).toBe("idle");
    expect(note()).toBe("Dispatch an event to see how this pet reacts.");
    expect(comparison()).toBeNull();
  });

  it("resolves a dispatched event into the pet and into the note", () => {
    mount();

    dispatch("Response Complete");

    expect(renderedState()).toBe("happy");
    expect(note()).toBe("Response Complete → Happy");
    expect(comparison()?.dataset.event).toBe("response-completed");
  });

  it("compares that event across every personality the cat offers", () => {
    mount();

    dispatch("Response Complete");

    // Three personalities, three states read straight off the engine: the calm cat is
    // pleased, the curious one is energetic about a good answer, and the sleepy one is
    // pleased in its own quieter way.
    expect(comparedStates()).toEqual({ calm: "happy", sleepy: "happy", curious: "excited" });
    // The comparison follows the selected personality, not the pet's whole library.
    expect(comparedCurrent()).toEqual(["calm"]);
  });

  it("shows the waiting difference on the event that is only a wait", () => {
    mount();

    dispatch("Response Started");

    // Nothing is being processed yet, so this is the personalities' own resting
    // behaviour on show: the calm and curious cats pay attention, the sleepy one dozes.
    expect(comparedStates()).toEqual({ calm: "thinking", sleepy: "sleeping", curious: "thinking" });
    expect(renderedState()).toBe("thinking");
    // A wait is open-ended, so it holds rather than settling on a timer.
    advance(PET_REACTION_DURATIONS.lingering * 2);
    expect(renderedState()).toBe("thinking");
  });

  it("shows a fox's personalities instead once the fox is chosen", () => {
    mount();

    click("Ember", "Choose a pet");
    dispatch("User Message");

    // Ember offers curious and playful only, and they disagree about a new message:
    // one wants to know where it is going, the other is delighted by the company.
    expect(comparedStates()).toEqual({ curious: "thinking", playful: "excited" });
    expect(renderedState()).toBe("thinking");
  });

  it("marks the newly chosen personality as the current one", () => {
    mount();

    click("Curious", "Choose a personality");
    // Choosing settles the pet, so the comparison waits for the next event.
    expect(comparison()).toBeNull();

    dispatch("Response Started");

    expect(comparedCurrent()).toEqual(["curious"]);
    expect(comparedStates().curious).toBe("thinking");
    expect(renderedState()).toBe("thinking");
  });

  it("keeps the comparison readable after a temporary reaction settles", () => {
    mount();

    dispatch("Response Complete");
    advance(PET_REACTION_DURATIONS.brief);

    // The pet has settled; the line still describes what the event did, which is what
    // makes it worth reading rather than a flash of text.
    expect(renderedState()).toBe("idle");
    expect(note()).toBe("Response Complete → Idle");
    expect(comparedStates()).toEqual({ calm: "happy", sleepy: "happy", curious: "excited" });
  });

  it("gives way to the manual state controls", () => {
    mount();

    dispatch("Response Complete");
    click("Sleeping", "Pet state");

    // A pinned state is not a reaction, so there is no event left to compare.
    expect(renderedState()).toBe("sleeping");
    expect(comparison()).toBeNull();
  });

  it("announces nothing, and changes nothing the user cannot see", () => {
    mount();

    dispatch("User Message");

    // No live region anywhere on the page: a pet's mood is never spoken over the user.
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(comparison()?.getAttribute("role")).toBeNull();
    for (const item of container.querySelectorAll(".pets-reaction-compare-item"))
      expect(item.getAttribute("role")).toBeNull();
    // The comparison is text, not a second set of controls.
    expect(comparison()?.querySelector("button")).toBeNull();
  });

  it("keeps every reaction local for a visitor who is signed out", async () => {
    const fetches = vi.spyOn(globalThis, "fetch");

    mount();
    click("Sleepy", "Choose a personality");
    dispatch("Response Complete");
    dispatch("Cancel");
    click("Ember", "Choose a pet");
    dispatch("User Message");
    // Ember's default personality is curious, which looks into a new message.
    expect(renderedState()).toBe("thinking");

    // Let every settle timer run, in case one of them were to reach the network.
    advance(PET_REACTION_DURATIONS.lingering * 2);
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetches).not.toHaveBeenCalled();
    expect(renderedState()).toBe("idle");
  });
});
