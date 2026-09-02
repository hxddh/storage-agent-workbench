import type { Lang } from "../i18n";

/**
 * The one greeting line above the Composer on the empty start surface.
 *
 * It rotates by the hour of day — a morning line, a daytime line, an evening
 * line, a late one — so the window does not read the same sentence at every
 * launch, while the surface itself stays exactly one line plus the Composer.
 * Every variant is a question about work to delegate; none is marketing copy.
 */
export const START_GREETINGS: Record<Lang, readonly string[]> = {
  en: [
    "Good morning. What should the Agent work on?",
    "What should the Agent work on?",
    "What should the Agent look into this evening?",
    "Working late? Hand the Agent a storage question.",
  ],
  zh: [
    "早上好。让 Agent 处理什么？",
    "让 Agent 处理什么？",
    "今晚让 Agent 看看什么？",
    "还在忙？把存储问题交给 Agent。",
  ],
};

/** 5–11 morning · 11–18 day · 18–23 evening · 23–5 late. */
export function startGreetingIndex(hour: number): number {
  if (hour >= 5 && hour < 11) return 0;
  if (hour >= 11 && hour < 18) return 1;
  if (hour >= 18 && hour < 23) return 2;
  return 3;
}

export function pickStartGreeting(lang: Lang, now: Date = new Date()): string {
  const lines = START_GREETINGS[lang] ?? START_GREETINGS.en;
  return lines[startGreetingIndex(now.getHours())] ?? lines[0];
}
