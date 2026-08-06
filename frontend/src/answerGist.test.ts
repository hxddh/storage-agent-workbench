import { describe, expect, it } from "vitest";
import { answerGist } from "./answerGist";

describe("the label on a collapsed turn", () => {
  it("is the answer's first claim, not its markup", () => {
    expect(answerGist("## Verdict\n\nThe bucket policy omits s3:ListBucket.")).toBe(
      "The bucket policy omits s3:ListBucket.",
    );
  });

  it("reads through a leading bullet", () => {
    expect(answerGist("- **AccessDenied** comes from the policy, not the ACL.")).toBe(
      "AccessDenied comes from the policy, not the ACL.",
    );
  });

  it("skips a leading code fence entirely", () => {
    const md = "```json\n{\"Effect\": \"Deny\"}\n```\n\nThat statement is what denies the list.";
    expect(answerGist(md)).toBe("That statement is what denies the list.");
  });

  it("skips a table header and its separator", () => {
    const md = "| bucket | status |\n| --- | --- |\n\nAll four buckets allow listing.";
    expect(answerGist(md)).toBe("All four buckets allow listing.");
  });

  it("unwraps inline code and links", () => {
    expect(answerGist("`head_bucket` returned 200 for [acme-logs](https://x).")).toBe(
      "head_bucket returned 200 for acme-logs.",
    );
  });

  it("falls back to a heading only when the answer is nothing else", () => {
    // "Verdict" alone is the uninformative label this function exists to avoid,
    // so it is used only when there is no prose to prefer.
    expect(answerGist("## Verdict")).toBe("Verdict");
  });

  it("is null when there is nothing to stand for", () => {
    // A stopped turn persists an empty answer; the caller falls back to the
    // question rather than printing a blank row.
    expect(answerGist("")).toBeNull();
    expect(answerGist(null)).toBeNull();
    expect(answerGist("```\ncode only\n```")).toBeNull();
    expect(answerGist("---\n\n***")).toBeNull();
  });

  it("caps a pathological single-line answer", () => {
    expect(answerGist("x".repeat(5000))?.length).toBe(240);
  });
});
