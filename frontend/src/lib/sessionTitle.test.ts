/**
 * A conversation is named after what it is about.
 *
 * The title was the first 80 characters of whatever you typed. Paste the S3
 * error you are staring at — this product's most common opening move — and the
 * investigation was called `<?xml version="1.0" encoding="UTF-8"?> <Error>…`
 * in the rail, the window header and every list it ever appeared in.
 */
import { describe, it, expect } from "vitest";
import { deriveSessionTitle } from "./sessionTitle";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>AccessDenied</Code><Message>Access Denied</Message><RequestId>ABC123</RequestId></Error>`;

describe("naming a session after an error", () => {
  it("names the S3 REST body by its code, not its preamble", () => {
    expect(deriveSessionTitle(XML)).toBe("AccessDenied");
  });

  it("adds the bucket when the body names one", () => {
    const withBucket = XML.replace("</Error>", "<BucketName>acme-logs</BucketName></Error>");
    expect(deriveSessionTitle(withBucket)).toBe("AccessDenied · acme-logs");
  });

  it("finds the bucket in an s3:// URI when the body does not carry one", () => {
    expect(deriveSessionTitle(`${XML}\ns3://acme-production-logs/logs/2026/08/x.gz`)).toBe(
      "AccessDenied · acme-production-logs",
    );
  });

  it("reads botocore's own sentence, which is what a traceback pastes", () => {
    expect(
      deriveSessionTitle(
        "An error occurred (NoSuchBucket) when calling the HeadBucket operation: Not Found",
      ),
    ).toBe("NoSuchBucket");
  });

  it("reads the JSON shape too", () => {
    expect(deriveSessionTitle('{"Error": {"Code": "SignatureDoesNotMatch"}}')).toBe(
      "SignatureDoesNotMatch",
    );
  });
});

describe("naming a session after a question", () => {
  it("keeps a typed question as it was typed", () => {
    const q = "why does acme-logs return 403 on every list call?";
    expect(deriveSessionTitle(q)).toBe(q);
  });

  it("skips a lone XML preamble to reach the line that says something", () => {
    expect(deriveSessionTitle('<?xml version="1.0"?>\nthe bucket denies list')).toBe(
      "the bucket denies list",
    );
  });

  it("cuts a long question at a word, and says it cut", () => {
    const long =
      "why does the production bucket in eu-west-1 deny every list call from the analytics role but not from my laptop";
    const out = deriveSessionTitle(long)!;
    expect(out.length).toBeLessThanOrEqual(61);
    expect(out.endsWith("…")).toBe(true);
    // Not mid-word.
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
    expect(out.slice(0, -1).endsWith(" ")).toBe(false);
  });

  it("collapses the whitespace a paste brings with it", () => {
    expect(deriveSessionTitle("   why   is   this   denied   ")).toBe("why is this denied");
  });

  it("has nothing to say about nothing, and says so", () => {
    expect(deriveSessionTitle("")).toBeNull();
    expect(deriveSessionTitle("   \n  ")).toBeNull();
    expect(deriveSessionTitle(null)).toBeNull();
    expect(deriveSessionTitle("{")).toBeNull();
  });
});
