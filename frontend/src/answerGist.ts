/**
 * The one line that stands for a collapsed answer.
 *
 * Collapsing hides only the assistant half of an old turn, so the user's
 * question is still rendered in full directly above the collapsed row. Labelling
 * that row with the question therefore printed the same sentence twice, one line
 * apart, and a reader scrolling back through thirty turns saw their own words
 * repeated instead of what the agent concluded.
 *
 * Answers are markdown, so the first line is often a heading, a bullet or a code
 * fence. What is wanted is the first line that carries a claim — with the markup
 * removed, because this renders as plain text inside a button.
 */

/** Lines that are structure rather than content. */
function isNoise(line: string): boolean {
  return (
    line === "" ||
    line.startsWith("```") ||
    line.startsWith("|") ||
    // A horizontal rule or a table separator: --- / *** / |---|---|
    /^[-*_|\s:]+$/.test(line)
  );
}

/** Strip the inline markup that would otherwise show up as literal characters. */
function unmark(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^>\s+/, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
}

/**
 * First meaningful line of an answer, or null when there is nothing to show
 * (an empty or stopped turn) so the caller can fall back to the question.
 *
 * `max` is a character cap, not an ellipsis budget: the row already truncates
 * with CSS, and this only keeps a pathological single-line answer from being
 * carried around in full.
 */
export function answerGist(content: string | null | undefined, max = 240): string | null {
  if (!content) return null;
  let fenced = false;
  // A heading is a section NAME — "Verdict", "Summary" — which is exactly the
  // uninformative label this exists to avoid. Keep the first one only as a
  // fallback for an answer that is nothing but headings.
  let heading: string | null = null;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    // Skip fenced blocks wholesale — the inside of a code fence is never a gist.
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced || isNoise(line)) continue;
    const text = unmark(line);
    if (!text) continue;
    if (line.startsWith("#")) {
      heading ??= text;
      continue;
    }
    return text.slice(0, max);
  }
  return heading ? heading.slice(0, max) : null;
}
