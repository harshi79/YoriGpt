import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PetRenderer } from "../src/features/pets/components/pet-renderer";
import { findPet, resolvePet } from "../src/features/pets/catalog";
import { petTreatment } from "../src/features/pets/animations";
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
});
