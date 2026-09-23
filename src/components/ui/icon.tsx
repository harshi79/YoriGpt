import type { SVGProps } from "react";

const paths = {
  plus: "M12 5v14M5 12h14",
  search: "m20 20-4.5-4.5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
  panel:
    "M9 3v18M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "m6 6 12 12M6 18 18 6",
  chevron: "m8 10 4 4 4-4",
  arrow: "M12 19V5m-6 6 6-6 6 6",
  arrowRight: "M5 12h14m-6-6 6 6-6 6",
  attach: "m9 13 6-6a2 2 0 0 1 3 3l-8 8a4 4 0 0 1-6-6l9-9a6 6 0 0 1 8 8l-9 9",
  chat: "M21 11a9 9 0 0 1-9 9 10 10 0 0 1-4-.8L3 21l1.8-5A9 9 0 1 1 21 11Z",
  edit: "m14 5 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14v6Z",
  idea: "M9 18h6M10 21h4M8 14a7 7 0 1 1 8 0c-1 1-1 2-1 2H9s0-1-1-2",
  plan: "M9 6h11M9 12h11M9 18h11m-17-6 1 1 2-2M3 6h2M3 18h2",
  book: "M12 5v15M3 4c4-1 7 0 9 1 2-1 5-2 9-1v15c-4-1-7 0-9 1-2-1-5-2-9-1V4Z",
  copy: "M8 8h12v13H8V8ZM16 8V3H3v13h5",
  check: "m5 12 4 4L19 6",
  user: "M5 21v-2a7 7 0 0 1 14 0v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  trash: "M5 7h14M10 7V5h4v2M6 7l1 13h10l1-13M10 11v6M14 11v6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
} as const;

export type IconName = keyof typeof paths;

export function Icon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}

/** Original geometric brand mark; no external assets. */
export function YoriMark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      width="32"
      height="32"
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M20 5v30M7 12.5l26 15M7 27.5l26-15"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinecap="round"
      />
      <circle cx="20" cy="20" r="5" fill="currentColor" />
    </svg>
  );
}
