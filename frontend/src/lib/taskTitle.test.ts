/**
 * A Task is named after what it is about.
 *
 * The title was the first 80 characters of whatever you typed. Paste the S3
 * error you are staring at — this product's most common opening move — and the
 * Task was called `<?xml version="1.0" encoding="UTF-8"?> <Error>…`
 * in the task list and every list it ever appeared in.
 */
import { describe, it, expect } from "vitest";
import { deriveTaskTitle } from "./taskTitle";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>AccessDenied</Code><Message>Access Denied</Message><RequestId>ABC123</RequestId></Error>`;

describe("naming a session after an error", () => {
  it("names the S3 REST body by its code, not its preamble", () => {
    expect(deriveTaskTitle(XML)).toBe("AccessDenied");
  });

  it("adds the bucket when the body names one", () => {
    const withBucket = XML.replace("</Error>", "<BucketName>acme-logs</BucketName></Error>");
    expect(deriveTaskTitle(withBucket)).toBe("AccessDenied · acme-logs");
  });

  it("finds the bucket in an s3:// URI when the body does not carry one", () => {
    expect(deriveTaskTitle(`${XML}\ns3://acme-production-logs/logs/2026/08/x.gz`)).toBe(
      "AccessDenied · acme-production-logs",
    );
  });

  it("reads botocore's own sentence, which is what a traceback pastes", () => {
    expect(
      deriveTaskTitle(
        "An error occurred (NoSuchBucket) when calling the HeadBucket operation: Not Found",
      ),
    ).toBe("NoSuchBucket");
  });

  it("reads the JSON shape too", () => {
    expect(deriveTaskTitle('{"Error": {"Code": "SignatureDoesNotMatch"}}')).toBe(
      "SignatureDoesNotMatch",
    );
  });
});

describe("naming a session after a question", () => {
  it("keeps a typed question as it was typed", () => {
    const q = "why does acme-logs return 403 on every list call?";
    expect(deriveTaskTitle(q)).toBe(q);
  });

  it("skips a lone XML preamble to reach the line that says something", () => {
    expect(deriveTaskTitle('<?xml version="1.0"?>\nthe bucket denies list')).toBe(
      "the bucket denies list",
    );
  });

  it("cuts a long question at a word, and says it cut", () => {
    const long =
      "why does the production bucket in eu-west-1 deny every list call from the analytics role but not from my laptop";
    const out = deriveTaskTitle(long)!;
    expect(out.length).toBeLessThanOrEqual(61);
    expect(out.endsWith("…")).toBe(true);
    // Not mid-word.
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
    expect(out.slice(0, -1).endsWith(" ")).toBe(false);
  });

  it("collapses the whitespace a paste brings with it", () => {
    expect(deriveTaskTitle("   why   is   this   denied   ")).toBe("why is this denied");
  });

  it("has nothing to say about nothing, and says so", () => {
    expect(deriveTaskTitle("")).toBeNull();
    expect(deriveTaskTitle("   \n  ")).toBeNull();
    expect(deriveTaskTitle(null)).toBeNull();
    expect(deriveTaskTitle("{")).toBeNull();
  });
});
