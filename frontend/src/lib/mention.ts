/**
 * `@` file-mention triggering (v1.16).
 *
 * One word-boundary rule shared by the completion listbox and the quiet
 * hints: a bare `includes("@")` fires on email addresses
 * (`user@example.com`), nagging about attachments the user never asked for.
 * An `@` only starts a mention at the start of the text or after
 * whitespace, with no whitespace inside the query.
 */

/** The mention query before `caret`, or null when the caret is not in one. */
export function mentionQueryAt(text: string, caret: number | null): string | null {
  if (caret == null || caret < 0 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const m = before.match(/(?:^|\s)@([^\s@]{0,64})$/);
  return m ? m[1] : null;
}

/** Whether the text ends in a mention trigger (for the quiet hint line). */
export function mentionTriggered(text: string): boolean {
  return /(?:^|\s)@[^\s@]*$/.test(text);
}
