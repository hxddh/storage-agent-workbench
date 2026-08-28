/**
 * The app's signature input, parsed.
 *
 * A person opens this product because an S3 call failed, and the first thing
 * they do is paste the failure. It was rendered as a wall of angle brackets in
 * a grey bubble — a storage tool not recognising a storage error.
 */
import { describe, it, expect } from "vitest";
import { isMostlyError, parseS3Error } from "./s3error";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>AccessDenied</Code><Message>Access Denied</Message>
<RequestId>ABC123</RequestId><HostId>hOsT/id+==</HostId></Error>`;

describe("parsing what people paste", () => {
  it("reads the S3 REST body", () => {
    const e = parseS3Error(XML)!;
    expect(e.code).toBe("AccessDenied");
    expect(e.message).toBe("Access Denied");
    expect(e.requestId).toBe("ABC123");
    expect(e.hostId).toBe("hOsT/id+==");
  });

  it("reads botocore's sentence, operation and all", () => {
    const e = parseS3Error(
      "An error occurred (NoSuchBucket) when calling the HeadBucket operation: Not Found",
    )!;
    expect(e.code).toBe("NoSuchBucket");
    expect(e.operation).toBe("HeadBucket");
    expect(e.message).toBe("Not Found");
  });

  it("reads the JSON shape", () => {
    const e = parseS3Error('{"Error":{"Code":"SignatureDoesNotMatch","Message":"bad sig"}}')!;
    expect(e.code).toBe("SignatureDoesNotMatch");
    expect(e.message).toBe("bad sig");
  });

  it("finds the bucket and key wherever the body hides them", () => {
    expect(parseS3Error(XML.replace("</Error>", "<BucketName>acme-logs</BucketName></Error>"))!.bucket)
      .toBe("acme-logs");
    // <Resource> is the only place some providers put it.
    const res = parseS3Error(XML.replace("</Error>", "<Resource>/acme-logs/logs/x.gz</Resource></Error>"))!;
    expect(res.bucket).toBe("acme-logs");
    expect(res.key).toBe("logs/x.gz");
    // …and an s3:// URI pasted alongside counts too.
    expect(parseS3Error(`${XML}\ns3://other-bucket/a/b.json`)!.bucket).toBe("other-bucket");
  });

  it("is not fooled by prose that merely mentions an error", () => {
    expect(parseS3Error("the bucket keeps returning AccessDenied, why?")).toBeNull();
    expect(parseS3Error("")).toBeNull();
    expect(parseS3Error("<Error><Code></Code></Error>")).toBeNull();
  });
});

describe("deciding whether to replace the message with a card", () => {
  it("does for a pasted body", () => {
    expect(isMostlyError(XML, parseS3Error(XML)!)).toBe(true);
  });

  it("does for a bare botocore sentence", () => {
    const s = "An error occurred (NoSuchBucket) when calling the HeadBucket operation: Not Found";
    expect(isMostlyError(s, parseS3Error(s)!)).toBe(true);
  });

  it("does NOT when the error is quoted inside a real question", () => {
    // Replacing a paragraph with a card because it contains an error body would
    // be the tool overruling the person.
    const q =
      "I have been chasing this for two days across three roles and two regions, and I still " +
      "cannot work out whether it is the policy or the ACL. Here is what I get every time, " +
      "and note it only happens from the analytics role, never from my laptop: " +
      "An error occurred (AccessDenied) when calling the ListObjectsV2 operation: Denied";
    const e = parseS3Error(q)!;
    expect(e.code).toBe("AccessDenied");
    expect(isMostlyError(q, e)).toBe(false);
  });
});
