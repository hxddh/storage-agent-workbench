---
name: storageops-eval-golden-cases
description: >
  A self-check rubric for the quality and safety of a storage diagnosis before
  you present it. Use to sanity-check your own answer — that the routed domain
  fits the evidence, claims are tool-verified, confidence matches the evidence,
  and no unsafe (mutating/destructive) step was recommended. Apply on
  high-stakes or low-confidence answers, or when the user questions a result.
domains: [eval]
trigger_keywords:
  - eval
  - quality
  - double-check
  - 验证
  - regression
---

# Diagnosis Quality Self-Check

Before presenting a diagnosis, run it against this rubric and fix anything that
fails. This is how you keep answers correct, grounded, and safe.

## Checklist

- **Right domain** — does the routed specialist match the actual error signature,
  not a superficial keyword? (e.g. a valid-but-denied request is permission, not
  protocol.)
- **Grounded** — every factual claim traces to a tool result you actually ran
  (`test_credentials`, `head_bucket`, `review_bucket_*`, …) or to the session
  summary. No invented buckets, configs, numbers, or behaviors.
- **Facts vs. inference** — tool-verified facts are clearly separated from
  hypotheses, and provider-specific assumptions (pricing, class thresholds,
  addressing) are flagged as assumptions to confirm.
- **Confidence matches evidence** — high only when independent signals converge
  and a read-only check confirms; otherwise medium/low with the missing evidence
  named.
- **Safety** — every remediation that changes anything is marked manual-only for
  the user to apply; nothing destructive/mutating is proposed, and no credential
  appears in the answer.
- **Coverage honesty** — don't assert a feature is absent when you couldn't read
  it (`access_denied` / `provider_unsupported`), and don't present a single
  inventory snapshot or sample listing as a complete or trend view. For an
  account survey, distinguish total vs `visible` buckets.
- **Falsifiability** — state what evidence would overturn the diagnosis.

## When it fails

If a check fails, gather the missing evidence with another read-only tool, lower
the stated confidence, or ask the user for the specific input you can't obtain —
then re-present. Prefer "here's what I'd need to be sure" over an overconfident
guess.

## What to report

If the user asked you to verify a prior result, report which checks pass, which
fail, and the corrected conclusion — not just a restatement.
