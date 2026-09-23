import type { PetShapeId } from "../types";

/**
 * The placeholder silhouettes: small, original, inline SVG. Deliberately simple —
 * this task proves the framework carries several pet definitions, not that it can
 * draw finished characters. No external asset, no generated art, no provider.
 *
 * Every species uses the same class names (`pet-body`, `pet-head`, `pet-ear`,
 * `pet-eye`, `pet-mouth`, `pet-tail`, `pet-mark`), so the pose rules in the
 * stylesheet work for all of them and a new animal is drawn once, in one place.
 * Colours come from the palette tokens, so both themes work without a second set
 * of artwork.
 *
 * The whole subtree is decoration: the renderer gives it one accessible name and
 * marks it hidden, so a screen reader hears "Yori, a cat" and not forty nodes.
 */

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function Cat() {
  return (
    <>
      <path className="pet-tail" d="M46 56c12 0 16-10 10-18-2 7-5 11-10 18Z" />
      <ellipse className="pet-body" cx="32" cy="48" rx="16" ry="12" />
      <path className="pet-ear" d="M17 27 18.5 11.5 30 20.5Z" />
      <path className="pet-ear" d="M47 27 45.5 11.5 34 20.5Z" />
      <path className="pet-mark" d="M20.6 23.4 21.4 16.4 26.6 20.6Z" />
      <path className="pet-mark" d="M43.4 23.4 42.6 16.4 37.4 20.6Z" />
      <circle className="pet-head" cx="32" cy="29" r="15" />
      <ellipse className="pet-eye" cx="26" cy="28" rx="2.1" ry="2.7" />
      <ellipse className="pet-eye" cx="38" cy="28" rx="2.1" ry="2.7" />
      <path className="pet-nose" d="M30 33.4h4L32 35.8Z" />
      <path className="pet-mouth" d="M28.4 38q3.6 2.8 7.2 0" {...STROKE} />
      <g className="pet-whiskers" {...STROKE} strokeWidth={1.2}>
        <path d="M11 29.5h6M11 33.5h6M47 29.5h6M47 33.5h6" />
      </g>
    </>
  );
}

function Fox() {
  return (
    <>
      <path className="pet-tail" d="M47 55c11 1 15-9 9-17-3 6-5 9-9 17Z" />
      <ellipse className="pet-body" cx="31" cy="48" rx="15" ry="12" />
      <path className="pet-ear" d="M15.5 28 16.5 9.5 30.5 20.5Z" />
      <path className="pet-ear" d="M48.5 28 47.5 9.5 33.5 20.5Z" />
      <path className="pet-mark" d="M20 24 20.6 15.6 26.6 20.6Z" />
      <path className="pet-mark" d="M44 24 43.4 15.6 37.4 20.6Z" />
      <circle className="pet-head" cx="32" cy="28" r="14.5" />
      <ellipse className="pet-mark" cx="32" cy="35.5" rx="7.5" ry="5" />
      <ellipse className="pet-eye" cx="26" cy="27" rx="2.1" ry="2.7" />
      <ellipse className="pet-eye" cx="38" cy="27" rx="2.1" ry="2.7" />
      <path className="pet-nose" d="M30 34.4h4L32 36.8Z" />
      <path className="pet-mouth" d="M29 39q3 2.2 6 0" {...STROKE} />
    </>
  );
}

function Rabbit() {
  return (
    <>
      <circle className="pet-tail" cx="48" cy="50" r="4.2" />
      <ellipse className="pet-body" cx="31" cy="49" rx="15" ry="11" />
      <rect
        className="pet-ear"
        x="21.5"
        y="3"
        width="7.5"
        height="24"
        rx="3.75"
        transform="rotate(-13 25.2 15)"
      />
      <rect
        className="pet-ear"
        x="35"
        y="3"
        width="7.5"
        height="24"
        rx="3.75"
        transform="rotate(13 38.8 15)"
      />
      <rect
        className="pet-mark"
        x="23.6"
        y="7"
        width="3.3"
        height="16"
        rx="1.65"
        transform="rotate(-13 25.2 15)"
      />
      <rect
        className="pet-mark"
        x="37.1"
        y="7"
        width="3.3"
        height="16"
        rx="1.65"
        transform="rotate(13 38.8 15)"
      />
      <circle className="pet-head" cx="32" cy="32" r="13.5" />
      <ellipse className="pet-eye" cx="26.5" cy="31" rx="2.1" ry="2.7" />
      <ellipse className="pet-eye" cx="37.5" cy="31" rx="2.1" ry="2.7" />
      <path className="pet-nose" d="M30 35.6h4L32 38Z" />
      <path className="pet-mouth" d="M29 40.6q3 2.2 6 0" {...STROKE} />
    </>
  );
}

/**
 * The silhouette for a registered shape id. Exhaustive over `PetShapeId`, so a new
 * species without a drawing is a compile error rather than an empty picture.
 */
const SHAPES: Record<PetShapeId, () => React.JSX.Element> = {
  cat: Cat,
  fox: Fox,
  rabbit: Rabbit,
};

export function PetShape({ shape }: { shape: PetShapeId }) {
  const Shape = SHAPES[shape];
  return Shape ? <Shape /> : null;
}

/**
 * The marks a state adds around the pet — sleep, thought, excitement. All three are
 * always in the tree and shown or hidden by the pose class, so switching state
 * never mounts or unmounts nodes and nothing depends on motion to be understood.
 */
export function PetStateMarks() {
  return (
    <>
      <g className="pet-effect pet-effect-sleep" aria-hidden="true">
        <text x="47" y="17" fontSize="9" fontWeight="600">
          z
        </text>
        <text x="53" y="9" fontSize="7" fontWeight="600">
          z
        </text>
      </g>
      <g className="pet-effect pet-effect-thought" aria-hidden="true">
        <circle cx="46" cy="17" r="1.7" />
        <circle cx="51" cy="12" r="2.3" />
        <circle cx="56.5" cy="6.5" r="3" />
      </g>
      <g className="pet-effect pet-effect-spark" aria-hidden="true">
        <path d="M11 13.5 12.5 17 16 18.5 12.5 20 11 23.5 9.5 20 6 18.5 9.5 17Z" />
        <path d="M52 21 53.2 23.6 55.8 24.8 53.2 26 52 28.6 50.8 26 48.2 24.8 50.8 23.6Z" />
      </g>
    </>
  );
}
