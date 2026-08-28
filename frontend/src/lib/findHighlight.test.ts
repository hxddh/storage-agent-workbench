/**
 * Find counts occurrences, so find must be able to point at each one.
 *
 * The old counter summed occurrences and the old cursor stepped messages: an
 * answer with twelve mentions was one stop out of eight while the bar promised
 * twenty-nine. These tests are about the unit — one range per occurrence, in
 * reading order.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { findRanges } from "./findHighlight";

function root(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

const text = (r: Range) => r.toString();

describe("finding every occurrence", () => {
  it("finds each one in a paragraph, not just the paragraph", () => {
    const el = root("<p>bucket-003 denies list; bucket-003 head still works.</p>");
    const rs = findRanges(el, "bucket-003");
    expect(rs).toHaveLength(2);
    expect(rs.map(text)).toEqual(["bucket-003", "bucket-003"]);
  });

  it("returns them in reading order across elements", () => {
    const el = root("<p>alpha one</p><table><tr><td>alpha two</td></tr></table><p>alpha three</p>");
    const rs = findRanges(el, "alpha");
    expect(rs).toHaveLength(3);
    // Each range sits in the element it was found in, in order.
    expect(rs[0].startContainer.parentElement?.tagName).toBe("P");
    expect(rs[1].startContainer.parentElement?.tagName).toBe("TD");
  });

  it("is case-insensitive, like every find bar", () => {
    const el = root("<p>AccessDenied and accessdenied</p>");
    expect(findRanges(el, "AccessDenied")).toHaveLength(2);
  });

  it("does not overlap itself on a repeated term", () => {
    // "aa" in "aaaa" is two matches, not three: a find bar steps past what it
    // just matched.
    const el = root("<p>aaaa</p>");
    expect(findRanges(el, "aa")).toHaveLength(2);
  });

  it("ignores the find bar's own text", () => {
    const el = root('<p>bucket-003</p><div data-find-skip><input value="bucket-003">bucket-003</div>');
    expect(findRanges(el, "bucket-003")).toHaveLength(1);
  });

  it("has nothing to point at for an empty query", () => {
    const el = root("<p>anything</p>");
    expect(findRanges(el, "")).toHaveLength(0);
    expect(findRanges(el, "   ")).toHaveLength(0);
  });
});
