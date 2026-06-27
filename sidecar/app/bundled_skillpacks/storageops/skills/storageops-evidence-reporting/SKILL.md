---
name: storageops-evidence-reporting
description: >
  Turn a completed diagnosis into a clear, evidence-based report or summary. Use
  when the user asks for a write-up, summary, or "diagnostic report". It does not
  diagnose — it structures existing findings, separates tool-verified facts from
  inference, scores confidence, and routes a formal report to the app's report
  generator.
domains: [reporting]
trigger_keywords:
  - report
  - summary
  - 总结
  - 诊断报告
---

# Evidence-Based Reporting

Format and quality-check findings the specialist skills produced. Match the depth
to the audience and never overstate confidence.

## Structure to produce

- **Summary** — one-line conclusion and the affected layer.
- **Evidence** — what each tool returned (e.g. `test_credentials → ok`,
  `review_bucket_security` findings), clearly marked tool-verified vs. inferred.
- **Root cause** — with a confidence level and what would falsify it.
- **Remediation** — concrete steps, each marked manual-only when it changes
  anything; the user applies them, the app never does.
- **Open questions / limitations** — missing evidence, provider assumptions.

## Confidence

- **high** — multiple independent tool results converge and a read-only check
  confirmed it.
- **medium** — consistent with the evidence but unconfirmed or with plausible
  alternatives.
- **low** — single weak signal; say what to gather next.

## In the app

For a persistent, shareable document, propose `generate_session_report` — it
renders the session's runs, findings, and triage into a Markdown report. You do
not need to redact by hand: the app strips secrets (keys, tokens, Authorization
headers, signed-URL params) from everything it persists or renders. Still, never
paste a credential into your answer, and if the user's pasted evidence contains
one, flag it for rotation.

## What to report

A report matched to the audience (operator-facing vs. quick summary), grounded in
the session's tool-verified evidence, with confidence that matches the evidence
and every mutating step marked manual-only.
