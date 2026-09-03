/** One optical icon set for the native window. 16px, 1.6 stroke, rounded joins. */

const PATHS: Record<string, string> = {
  sidebar: "M3.5 5.5A2 2 0 0 1 5.5 3.5h13a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z|M9.5 3.5v17",
  compose: "M12 20h9|M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z",
  plus: "M12 5v14|M5 12h14",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  more: "M5 12h.01|M12 12h.01|M19 12h.01",
  close: "M18 6 6 18|M6 6l12 12",
  arrowUp: "M12 19V5|M5 12l7-7 7 7",
  arrowRight: "M5 12h14|M13 6l6 6-6 6",
  arrowDown: "M12 5v14|M19 12l-7 7-7-7",
  stop: "M7 7h10v10H7z",
  chevron: "M9 6l6 6-6 6",
  check: "M20 6 9 17l-5-5",
  copy: "M9 9h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2z|M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z|M21 21l-4.3-4.3",
  command: "M9 9V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2z|M9 17v-2a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2z|M5 9H3|M21 9h-2|M5 17H3|M21 17h-2",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6",
  tool: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z",
  shield: "M12 3 4.5 6v5.8c0 4.8 3.2 7.7 7.5 9.2 4.3-1.5 7.5-4.4 7.5-9.2V6z|M9.2 12.2 11 14l3.8-4",
  play: "M8 5v14l11-7z",
  chip: "M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z",
  globe: "M4 7h16M4 17h16M9 7c1 4 3 7 6 10",
  alert: "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z|M12 9v4|M12 17h.01",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z|M12 11v5|M12 8h.01",
  x: "M18 6 6 18|M6 6l12 12",
  paperclip: "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48",
  refresh: "M21 12a9 9 0 1 1-2.64-6.36|M21 3v6h-6",
  table: "M3 5h18v14H3z|M3 10h18|M9 10v9",
  storage: "M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3z|M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5|M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z|M12 1v2|M12 21v2|M4.2 4.2l1.4 1.4|M18.4 18.4l1.4 1.4|M1 12h2|M21 12h2|M4.2 19.8l1.4-1.4|M18.4 5.6l1.4-1.4",
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, stroke = 1.6, className }: { name: IconName; size?: number; stroke?: number; className?: string }) {
  const d = PATHS[name] ?? "";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      {d.split("|").map((path, index) => <path key={index} d={path} />)}
    </svg>
  );
}
