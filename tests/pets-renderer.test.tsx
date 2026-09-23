import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PetRenderer } from "../src/features/pets/components/pet-renderer";
import { findPet, resolvePet } from "../src/features/pets/catalog";
import { petTreatment } from "../src/features/pets/animations";
import { resolveReaction } from "../src/features/pets/reactions";
import type { PetDefinition } from "../src/features/pets/types";

const yori = resolvePet("yori-cat");

function render(pet: PetDefinition, props: Partial<React.ComponentProps<typeof PetRenderer>> = {}) {
  return renderToStaticMarkup(<PetRenderer pet={pet} {...props} />);
}

describe("the pet renderer", () => {
  it("renders the supplied pet with a stable, meaningful label", () => {
    const html = render(yori);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Yori, a cat"');
    expect(html).toContain('data-pet="yori-cat"');
    // The drawing itself is presentational: one name, no per-shape announcements.
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('aria-live');
  });

  it("supports the size variants", () => {
    expect(render(yori, { size: "sm" })).toContain("pet-renderer--sm");
    expect(render(yori, { size: "md" })).toContain("pet-renderer--md");
    expect(render(yori, { size: "lg" })).toContain("pet-renderer--lg");
  });

  it("changes the rendered state with the state prop", () => {
    const happy = render(yori, { state: "happy" });
    const sad = render(yori, { state: "sad" });
    expect(happy).toContain('data-state="happy"');
    expect(sad).toContain('data-state="sad"');
    expect(happy).toContain(petTreatment("happy").poseClass);
    expect(sad).toContain(petTreatment("sad").poseClass);
    expect(happy).not.toContain(petTreatment("sad").poseClass);
  });

  it("marks whether a state moves, so a reader never depends on animation", () => {
    expect(render(yori, { state: "sad" })).toContain('data-motion="off"');
    expect(render(yori, { state: "excited" })).toContain('data-motion="on"');
  });

  it("falls back to the initial state for an unknown state", () => {
    const html = render(yori, { state: "zooming" as never });
    expect(html).toContain('data-state="idle"');
    expect(html).toContain(petTreatment("idle").poseClass);
  });

  it("renders a labelled placeholder for an unavailable pet instead of crashing", () => {
    const retired = findPet("pip-rabbit");
    expect(retired).not.toBeNull();
    const html = render(retired as PetDefinition);
    expect(html).toContain("pet-renderer--missing");
    expect(html).toContain("A pet that is not available");
  });

  it("tolerates a malformed pet value without throwing", () => {
    const bad = { id: 123 } as unknown as PetDefinition;
    const html = render(bad);
    expect(html).toContain("pet-renderer--missing");
    expect(html).toContain('role="img"');
  });

  it("allows a caller-supplied label to override the default", () => {
    const html = render(yori, { label: "Yori, waiting patiently" });
    expect(html).toContain('aria-label="Yori, waiting patiently"');
  });

  it("defaults to the pet's classic appearance when none is supplied", () => {
    expect(render(yori)).toContain('data-appearance="classic"');
  });

  it("reflects a valid appearance as its palette, without extra markup", () => {
    const html = render(yori, { appearance: "night" });
    expect(html).toContain('data-appearance="night"');
    // The appearance re-tints the existing shapes; it adds no extra accessible node.
    expect(html.match(/role="img"/g)?.length).toBe(1);
  });

  it("falls back to the default palette for an unknown or other-pet appearance", () => {
    expect(render(yori, { appearance: "disco" })).toContain('data-appearance="classic"');
    // "ember" belongs to the fox, not the cat.
    expect(render(yori, { appearance: "ember" })).toContain('data-appearance="classic"');
  });

  it("omits the appearance on the missing-pet placeholder", () => {
    const retired = findPet("pip-rabbit") as PetDefinition;
    expect(render(retired)).toContain('data-appearance=""');
  });

  it("carries the resolved personality as data, defaulting to the pet's own", () => {
    // Omitted: the cat's declared default, not an invented value.
    expect(render(yori)).toContain('data-personality="calm"');
    // Supplied and offered by this pet: carried through.
    expect(render(yori, { personality: "sleepy" })).toContain('data-personality="sleepy"');
  });

  it("falls back to the pet default for an unknown or other-pet personality", () => {
    expect(render(yori, { personality: "disco" })).toContain('data-personality="calm"');
    // "playful" belongs to the fox, not the cat.
    expect(render(yori, { personality: "playful" })).toContain('data-personality="calm"');
  });

  it("omits the personality on the missing-pet placeholder", () => {
    const retired = findPet("pip-rabbit") as PetDefinition;
    expect(render(retired)).toContain('data-personality=""');
  });

  it("keeps one accessible label whatever the personality", () => {
    const html = render(yori, { personality: "curious" });
    expect(html).toContain('aria-label="Yori, a cat"');
    expect(html.match(/role="img"/g)?.length).toBe(1);
  });

  it("renders a state produced by the reaction engine, unchanged", () => {
    // The engine resolves; the renderer only draws. Whatever state comes out must
    // arrive on the markup as that state, with the matching pose — no behavior logic
    // lives here.
    const reaction = resolveReaction({
      pet: "ember-fox",
      personality: "playful",
      event: "response-completed",
    });
    const fox = resolvePet("ember-fox");

    const html = render(fox, { state: reaction.state, personality: "playful" });
    expect(html).toContain(`data-state="${reaction.state}"`);
    expect(html).toContain(petTreatment(reaction.state).poseClass);
    // The accessible label still does not mention the state.
    expect(html).toContain('aria-label="Ember, a fox"');
  });
});
