/* A small hand-drawn icon set: 20px grid, 1.6 stroke, round caps. */

const PATHS: Record<string, string> = {
  box: "M3.5 6.5 10 3l6.5 3.5v7L10 17l-6.5-3.5v-7ZM3.5 6.5 10 10l6.5-3.5M10 10v7",
  truck: "M2.5 5h9v8h-9zM11.5 8h3l3 3v2h-6M5.5 15.5a1.5 1.5 0 1 0 0-.01M14.5 15.5a1.5 1.5 0 1 0 0-.01",
  alert: "M10 3 2.5 16.5h15L10 3ZM10 8.5v3.5M10 14.2v.3",
  graph: "M4.5 5.5a1.5 1.5 0 1 0 0-.01M15.5 4.5a1.5 1.5 0 1 0 0-.01M15.5 15.5a1.5 1.5 0 1 0 0-.01M6 6l8 7.8M6 5.3l8-.6",
  chat: "M3.5 4.5h13v8.5H9l-4 3v-3H3.5z",
  search: "M8.8 14a5.2 5.2 0 1 0 0-10.4 5.2 5.2 0 0 0 0 10.4ZM12.6 12.6 16.5 16.5",
  plus: "M10 4v12M4 10h12",
  x: "M5 5l10 10M15 5 5 15",
  check: "M4 10.5 8 14.5 16 6",
  logout: "M8 4H4.5v12H8M12 6.5 15.5 10 12 13.5M15.5 10H7.5",
  arrowRight: "M4 10h12M11.5 5.5 16 10l-4.5 4.5",
  layers: "M10 3 2.5 7 10 11l7.5-4L10 3ZM2.5 10.5 10 14.5l7.5-4M2.5 14 10 18l7.5-4",
  shield: "M10 2.5 4 5v4.5c0 4 2.6 6.6 6 8 3.4-1.4 6-4 6-8V5l-6-2.5Z",
  database: "M10 3c3.6 0 6 1 6 2.3S13.6 7.6 10 7.6 4 6.6 4 5.3 6.4 3 10 3ZM4 5.3v9.4C4 16 6.4 17 10 17s6-1 6-2.3V5.3M4 10c0 1.3 2.4 2.3 6 2.3s6-1 6-2.3",
  info: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM10 9v4.5M10 6.5v.3",
  ban: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM5 5l10 10",
  clock: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM10 6.5V10l2.5 2",
  doc: "M5.5 2.5h6l3 3v12h-9zM11.5 2.5v3h3M7.5 10h5M7.5 13h5",
  trash: "M4 6h12M8 6V4h4v2M5.5 6l.8 10.5h7.4L14.5 6",
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
