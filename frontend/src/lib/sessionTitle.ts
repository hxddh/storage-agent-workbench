/**
 * What to call a conversation, given how it started.
 *
 * The title was `text.slice(0, 80)`. For a typed question that is fine. For
 * this product's single most common opening move — paste the S3 error you are
 * staring at — it named the investigation
 *
 *   <?xml version="1.0" encoding="UTF-8"?> <Error><Code>AccessDenied</Code><Me
 *
 * in the rail, in the window header, and in every list the session ever appears
 * in. The information a person needs to recognise it later (the error code, and
 * which bucket) was in the string all along, just buried behind the preamble.
 *
 * Deliberately a pure function over the raw text, with no model call: it runs on
 * the first keystroke of a new session, offline, before any provider exists.
 */

import { parseS3Error } from "./s3error";

/** Longest title we will produce, before the ellipsis. */
const MAX = 60;

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Cut at a word boundary rather than mid-token, and say that we cut. */
function clip(s: string, max = MAX): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
}

/**
 * A name for the session that started with `text`.
 *
 * Returns null when there is nothing to name it after, so the caller keeps
 * whatever default it would have used.
 */
export function deriveSessionTitle(text: string | null | undefined): string | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;

  const err = parseS3Error(raw);
  if (err) {
    return clip(err.bucket ? `${err.code} · ${squash(err.bucket)}` : err.code);
  }

  // Not a recognised error body: the first line that carries something, which
  // for a typed question is the question. Markup-only lines (an XML preamble, a
  // lone brace) are skipped rather than shown — they are what made the old
  // title unreadable in the first place.
  for (const line of raw.split("\n")) {
    const s = squash(line);
    if (!s) continue;
    if (/^<\?xml/i.test(s)) continue;
    if (/^[{}[\]<>(),;]+$/.test(s)) continue;
    if (/^```/.test(s)) continue;
    return clip(s);
  }
  return null;
}
