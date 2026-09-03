import type { Lang } from "../i18n";

/**
 * The one greeting line above the Composer on the empty start surface (v1.15).
 *
 * A single static line per language. Time-of-day rotation was chatbot
 * hospitality, not a native window — the window reads the same at every
 * launch. The empty start is exactly this line plus the Composer.
 */
export const START_GREETINGS: Record<Lang, readonly string[]> = {
  en: ["What should the Agent work on?"],
  zh: ["让 Agent 处理什么？"],
};

/**
 * @deprecated v1.15 removed the rotating engine hint. The empty start is one
 * greeting line plus the Composer; engine discoverability lives in the
 * command palette, not in a painted suggestion. Kept as a no-op alias so
 * older imports fail loudly at the type level rather than silently.
 */
export const START_HINTS: Record<Lang, readonly string[]> = {
  en: [],
  zh: [],
};

/** @deprecated v1.15 — the hint line is gone; always returns "". */
export function pickStartHint(_lang: Lang, _now: Date = new Date()): string {
  return "";
}

/** @deprecated v1.15 — the greeting no longer rotates; always 0. */
export function startGreetingIndex(_hour: number): number {
  return 0;
}

export function pickStartGreeting(lang: Lang, _now: Date = new Date()): string {
  const lines = START_GREETINGS[lang] ?? START_GREETINGS.en;
  return lines[0] ?? "What should the Agent work on?";
}
