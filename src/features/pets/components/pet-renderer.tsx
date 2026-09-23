import { petTreatment } from "../animations";
import { resolveAppearanceForPet, resolvePersonalityForPet } from "../catalog";
import { INITIAL_PET_STATE, toPetState, type PetState } from "../state";
import {
  DEFAULT_PET_SIZE,
  isPetDefinition,
  petLabel,
  type PetDefinition,
  type PetSize,
} from "../types";
import { PetShape, PetStateMarks } from "./shapes";

type Props = {
  /** The pet to draw. Anything unusable degrades to a labelled placeholder. */
  pet: PetDefinition;
  /** Defaults to idle. */
  state?: PetState;
  /** Pixels live in the stylesheet; this only picks the size. */
  size?: PetSize;
  /** A catalog appearance id; unknown or other-pet values fall back to the default. */
  appearance?: string;
  /**
   * A catalog personality id, carried only as `data-personality` so future behavior
   * tasks have a resolved value to read. It changes nothing here yet: no pose, no
   * animation, no label — the renderer holds no personality logic.
   */
  personality?: string;
  /** Extra class for the place the pet is rendered (the chat empty state uses one). */
  className?: string;
  /** Overrides the default "Name, a species" label. */
  label?: string;
};

/**
 * Draws one pet. The only component that knows how a pet is rendered, and it knows
 * very little: which shape to ask for, which two classes the state maps to, and one
 * accessible name.
 *
 * - **One name, nothing else announced.** The root is `role="img"` with a stable
 *   label, so the whole SVG subtree is presentational: a screen reader hears
 *   "Yori, a cat" instead of forty shapes. The state is deliberately *not* part of
 *   the label — it changes often, and a name that changes under a reader is noise.
 *   Nothing here is a live region, so a state change never announces itself.
 * - **No behavior.** No timers, no effects, no listeners, no network, no storage.
 *   It is safe in a server component and costs nothing to re-render.
 * - **Extensible without redesign.** A future prop (an intensity, a direction, a
 *   second layer) is added here and in the treatment table; call sites keep working.
 */
export function PetRenderer({
  pet,
  state = INITIAL_PET_STATE,
  size = DEFAULT_PET_SIZE,
  appearance,
  personality,
  className = "",
  label,
}: Props) {
  const resolvedState = toPetState(state);
  const treatment = petTreatment(resolvedState);
  const classes = [
    "pet-renderer",
    `pet-renderer--${size}`,
    treatment.poseClass,
    treatment.motionClass,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  // Defensive on purpose: a pet can arrive from a stored key, a fixture, or a
  // catalog entry that was retired mid-session. None of those may throw mid-render.
  const usable = isPetDefinition(pet) && pet.available ? pet : null;
  const shape = usable?.asset.kind === "inline-svg" ? usable.asset.shape : null;
  const image = usable?.asset.kind === "image" ? usable.asset.src : null;
  // The palette a fixed stylesheet knows how to paint; an unknown or other-pet
  // appearance resolves to the pet's default look, never to arbitrary styling.
  const appearancePalette = usable ? resolveAppearanceForPet(usable.id, appearance).palette : "";
  // Resolved for the pet that is actually drawn, so a personality from another pet can
  // never appear on screen. Presentational only: nothing below reads it yet.
  const personalityId = usable ? resolvePersonalityForPet(usable.id, personality).id : "";

  return (
    <figure
      className={usable ? classes : `${classes} pet-renderer--missing`}
      role="img"
      aria-label={label ?? (usable ? petLabel(usable) : "A pet that is not available")}
      data-state={resolvedState}
      data-pet={usable?.id ?? ""}
      data-appearance={appearancePalette}
      data-personality={personalityId}
      data-motion={treatment.moves ? "on" : "off"}
    >
      <span className="pet-stage">
        {shape ? (
          <svg
            className="pet-svg"
            viewBox="0 0 64 64"
            aria-hidden="true"
            focusable="false"
            preserveAspectRatio="xMidYMid meet"
          >
            <g className="pet-figure">
              <PetShape shape={shape} />
              <PetStateMarks />
            </g>
          </svg>
        ) : image ? (
          // A raster pet: the figure already carries the name, so the image is
          // decoration. State marks are inline-SVG only for now.
          // eslint-disable-next-line @next/next/no-img-element
          <img className="pet-image" src={image} alt="" />
        ) : (
          <span className="pet-stage-empty" aria-hidden="true" />
        )}
      </span>
    </figure>
  );
}
