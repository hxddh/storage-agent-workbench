/**
 * Pure-helper tests for the turn runner. These functions gate how a raw
 * sidecar/provider error is turned into user-facing guidance and how the offline
 * error-triage path is triggered — both easy to regress and previously untested.
 */
import { describe, it, expect } from "vitest";
import { cleanError, looksLikeError } from "./useTurnRunner";
import type { TFunc } from "../i18n";

// A fake translator: returns the key so assertions can match on the key name
// without depending on the actual copy.
const t = ((key: string) => key) as unknown as TFunc;

describe("cleanError", () => {
  it("strips the ApiError/Error and 'Session assistant failed' prefixes", () => {
    expect(cleanError("ApiError: boom", t)).toBe("boom");
    expect(cleanError("Session assistant failed: nope", t)).toBe("nope");
  });

  it("maps auth errors to the key hint (turn kind)", () => {
    expect(cleanError("401 Unauthorized", t)).toBe("thread.errKey");
    expect(cleanError("invalid api key", t)).toBe("thread.errKey");
  });

  it("maps a PROVIDER-shaped 404 to the model hint", () => {
    expect(cleanError("model gpt-x does not exist (404)", t)).toBe("thread.err404");
    expect(cleanError("the provider returned 404 not found", t)).toBe("thread.err404");
  });

  it("does NOT map a bare 'not found' / '404' with no provider context (FE9 regression)", () => {
    // "session not found" is a turn error when a session was deleted mid-turn —
    // it must NOT send the user to fix a model name/base URL.
    const out = cleanError("session not found", t);
    expect(out).not.toBe("thread.err404");
    expect(out).toBe("session not found");
  });

  it("maps network/timeout errors", () => {
    expect(cleanError("connection reset", t)).toBe("thread.errNetwork");
    expect(cleanError("request timed out", t)).toBe("thread.errNetwork");
  });

  it("does NOT apply model hints for kind='load' (neutral message)", () => {
    // A session-load failure gets the cleaned message, never the model hints.
    expect(cleanError("model foo 404", t, "load")).toBe("model foo 404");
  });

  it("truncates very long messages", () => {
    const long = "x".repeat(400);
    const out = cleanError(long, t);
    expect(out.length).toBeLessThanOrEqual(281);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("looksLikeError", () => {
  it("recognizes S3/XML error bodies and stack traces", () => {
    expect(looksLikeError("<Error><Code>AccessDenied</Code></Error>")).toBe(true);
    expect(looksLikeError("SignatureDoesNotMatch")).toBe(true);
    expect(looksLikeError("Traceback (most recent call last):")).toBe(true);
    expect(looksLikeError("botocore.exceptions.ClientError")).toBe(true);
  });

  it("recognizes an HTTP 5xx status next to error context", () => {
    expect(looksLikeError("the server returned 503 Service Unavailable")).toBe(true);
    expect(looksLikeError("HTTP 500 Internal Server Error")).toBe(true);
  });

  it("does NOT treat a bare number in prose as an error (no false trigger)", () => {
    expect(looksLikeError("I have 404 objects in this bucket")).toBe(false);
    expect(looksLikeError("how much does 500 GB cost?")).toBe(false);
    expect(looksLikeError("list the first 200 keys")).toBe(false);
  });
});
