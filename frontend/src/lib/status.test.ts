/**
 * A bucket nobody could read must not look like a bucket that is fine.
 *
 * The sidecar spent v0.80.0 through v0.82.0 making one distinction real: what
 * was ESTABLISHED (`available`, `not_configured` — we asked and got an answer)
 * versus what was UNDETERMINED (`access_denied`, `provider_unsupported`,
 * `error`, and a missing value — we did not). The UI then rendered all six as
 * the raw wire token in one of five colours, so the distinction lived only in
 * the backend and never reached the person reading the matrix.
 */
import { describe, it, expect } from "vitest";
import { isEstablished, statusClass, statusLabelKey } from "./status";

describe("established vs undetermined", () => {
  it("counts an answer as an answer", () => {
    // Both of these are things we found out. "Not configured" is a FINDING —
    // encryption being off is a fact about the bucket.
    expect(isEstablished("available")).toBe(true);
    expect(isEstablished("not_configured")).toBe(true);
  });

  it("counts every absence of an answer as one", () => {
    // None of these say anything about the bucket. "Denied" is a fact about our
    // credentials; "unsupported" is a fact about the provider.
    for (const s of ["access_denied", "provider_unsupported", "error", null, undefined]) {
      expect(isEstablished(s), String(s)).toBe(false);
    }
  });

  it("treats a status this build does not recognise as undetermined", () => {
    // The wire can grow a sixth value. Falling through to "we do not know" is
    // the truthful reading; anything else would be this UI inventing a verdict.
    expect(isEstablished("some_future_status")).toBe(false);
    expect(statusLabelKey("some_future_status")).toBe("posture.notChecked");
  });
});

describe("labels", () => {
  it("never renders the raw wire token", () => {
    // `access_denied` is a value, not a word to show a person.
    for (const s of ["available", "not_configured", "access_denied", "provider_unsupported", "error"]) {
      expect(statusLabelKey(s)).toMatch(/^posture\./);
      expect(statusLabelKey(s)).not.toContain("_");
    }
  });

  it("distinguishes never-checked from checked-but-unanswerable", () => {
    // These were gray-400 and gray-500 — the two cells that differ most read
    // almost the same.
    expect(statusLabelKey(null)).not.toBe(statusLabelKey("provider_unsupported"));
  });
});

describe("colour", () => {
  it("keeps 'not configured' a warning, because it is a finding", () => {
    expect(statusClass("not_configured")).toContain("warn");
  });

  it("does not paint an absence of information as a failure of the bucket", () => {
    // Denied and error are ours to fix; unsupported and unchecked are neither
    // good nor bad news about the bucket, so they stay neutral.
    expect(statusClass("provider_unsupported")).toContain("gray");
    expect(statusClass(null)).toContain("gray");
  });
});

describe("region_mismatch — the status the fallback nearly swallowed", () => {
  // A bucket that exists but lives in another region answers HeadBucket with a
  // 301. The survey brands that distinctly on purpose (`s3/account_tools.py`,
  // `runs/account_discovery_run.py`) rather than folding it into `error`,
  // because the bucket IS reachable — with the right region. The first version
  // of this module knew five tokens and sent everything else to "not checked",
  // which turned an actionable misconfiguration into "we never looked".
  it("is an answer, not an absence of one", () => {
    expect(isEstablished("region_mismatch")).toBe(true);
  });

  it("says what is wrong instead of claiming nobody checked", () => {
    expect(statusLabelKey("region_mismatch")).not.toBe(statusLabelKey(null));
    expect(statusLabelKey("region_mismatch")).toBe("posture.regionMismatch");
  });

  it("is a finding, so it carries a finding's colour", () => {
    expect(statusClass("region_mismatch")).toContain("warn");
  });

  // The fallback itself must stay — a status this build has never heard of is
  // genuinely undetermined, and that is the truthful reading.
  it("still sends a genuinely unknown token to undetermined", () => {
    expect(isEstablished("some_status_from_a_newer_sidecar")).toBe(false);
    expect(statusLabelKey("some_status_from_a_newer_sidecar")).toBe("posture.notChecked");
  });
});
