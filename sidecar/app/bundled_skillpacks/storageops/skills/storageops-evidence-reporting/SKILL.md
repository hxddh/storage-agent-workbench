---
name: storageops-evidence-reporting
description: >
  Transform diagnostic findings into structured, audience-appropriate reports.
  Supports four templates: customer-facing report, internal engineering note,
  reproduction checklist, and formal diagnosis report. Applies consistent
  confidence scoring, evidence quality assessment, and redaction/safety review.
  Use after specialist Skills have completed their diagnosis — this skill
  formats and polishes, it does NOT diagnose.
maturity: core
mode: light_heavy
estimated_tokens: 1200
trigger_keywords:
  - generate report
  - customer report
  - engineering note
  - diagnosis report
  - reproduction steps
  - format diagnosis
  - evidence summary
  - confidence scoring
recommended_tools:
  - scan_secrets
  - search_memory
---

# Evidence-Based Reporting

This skill consumes diagnostic output from specialist skills and produces audience-appropriate reports. It does NOT perform diagnosis — it formats and quality-checks existing findings.

## Decision Tree

```
Need a report →
  ├─ For customer/external? → Customer Report (templates/customer-report.md)
  │   └─ Must be: non-technical summary, clear next steps, NO internal speculation
  ├─ For internal engineering team? → Engineering Note (templates/internal-engineering-note.md)
  │   └─ Must include: technical details, debugging steps, root cause evidence chain
  ├─ For reproduction? → Reproduction Checklist (templates/reproduction-checklist.md)
  │   └─ Must include: step-by-step commands, expected vs actual output
  └─ For formal record? → Diagnosis Report (templates/diagnosis-report.md)
      └─ Must include: complete evidence chain, confidence scoring, limitations
```

## Workflow

### Step 1: Collect Diagnostic Outputs
Gather outputs from all specialist skills that were invoked. Each should have a one-line conclusion, evidence list, and root cause.

### Step 2: Select Template
Match audience to template. Read the template file for section structure.

### Step 3: Redaction Checklist
Run `scan_secrets` on all diagnostic outputs before including in any report. Redact: access keys, secret keys, session tokens, signed URLs with credentials, internal IPs if customer-facing.

### Step 4: Confidence Scoring
Apply consistent confidence scoring across all findings:
- **High (≥0.8)**: Multiple independent evidence sources converge on same root cause, validation command confirmed
- **Medium (0.5–0.8)**: Evidence consistent with root cause but missing validation or alternative explanations possible
- **Low (<0.5)**: Single evidence source, alternative explanations likely, recommend further data collection
See `references/reporting-best-practices.md` for scoring methodology.

### Step 5: Quality Gates
Before finalizing: every recommendation marked manual-only if destructive, no credentials in report, confidence matches evidence quality, report matches audience needs. Run `python3 scripts/report_contract_validator.py --file <draft.md>` for a deterministic check that the required sections are present, a confidence value is well-formed, no credentials leak, and no destructive/unsafe recommendation slipped in — fix anything it flags before delivering.

### Step 6: Feedback Loop
Before delivering any report, run `scan_secrets` on the full report text. If credentials are found: **"⚠️ CREDENTIAL_LEAK: The report contains credentials that MUST be redacted before sharing."** — do not deliver the report until redacted. After report generation, ask: **"Does this report match your audience and format expectations? Would you like me to regenerate with a different template?"** If the report is for a customer and contains technical speculation: go back to Step 2 and switch to Customer Report template.

## User Interaction

### When to ask the user:
- **"Who is the audience for this report? (Customer, internal engineering, QA for reproduction, or formal record?)"** — determines template selection
- **"Should I include complete technical details, or a non-technical summary?"** — customer vs engineering level
- **"Should I append the raw diagnostic output as an appendix?"** — for internal reports

### When to inform the user:
- Before including any output: **"I will run a credential scan and redact any sensitive information before finalizing."**
- After report generation: **"Review the report carefully before sharing. All sensitive internal details (account IDs, IPs, ARNs) have been redacted."**

## Output Contract — include these fields

Varies by template. Core Diagnosis Report structure:

```markdown
# Diagnosis: [one-line conclusion]
**Confidence**: high | medium | low (score: 0.0–1.0)
**Date**: [timestamp]

## Summary
[One paragraph for broader audience]

## Key Evidence
| # | Evidence | Source | Confidence Impact |
|---|----------|--------|-------------------|
| 1 | [description] | [where from] | +X (increases because...) |
| 2 | ... | ... | −X (decreases because...) |

## Root Cause Analysis
1. **Primary** (confidence: X%): [explanation + supporting evidence IDs]
2. **Alternative** (confidence: Y%): [explanation — if applicable]

## Remediation
1. **[action]** (manual-only | safe) — Risk: [low/medium/high]
2. ...

## Limitations
- [what this diagnosis does NOT cover]
- [what additional evidence would improve confidence]
```

## Examples

### Example 1: Customer-facing report from performance diagnosis
**Input**: Performance diagnosis found: "s5cmd 429 from excessive concurrency (256 workers)". Customer asks for report.
**Report type**: Customer Report  
**Output**: Non-technical summary: "Your sync tool was sending too many simultaneous requests, causing rate limiting. Reducing parallelism from 256 to 16 resolved the issue." No internal speculation, no alternative theories.

### Example 2: Internal engineering note from security diagnosis
**Input**: Security diagnosis found cross-account policy gap. Engineering team needs details.
**Report type**: Engineering Note  
**Output**: Full policy chain trace, specific policy statement IDs, IAM role ARNs, CloudTrail event IDs, reproduction commands.

### Example 3: Reproduction checklist from CLI/SDK diagnosis
**Input**: rclone ETag mismatch on BOS. QA needs exact reproduction steps.
**Report type**: Reproduction Checklist  
**Output**: Step-by-step: (1) rclone v1.65.0, (2) BOS bucket bj, (3) `rclone copy 50MB-file BOS:bucket --s3-upload-concurrency 4`, (4) expected MD5=X, actual MD5=Y, (5) workaround `--s3-use-multipart-etag=false` resolves.

## References
- `references/reporting-best-practices.md` — Confidence scoring methodology, evidence rules | **Read when:** computing confidence scores or evaluating evidence quality
- `scripts/report_contract_validator.py` — Deterministic Output-Contract check (required sections, confidence, redaction, no destructive recommendations); run `python3 scripts/report_contract_validator.py --file <draft.md>` | **Run when:** finalizing a report in Step 5, before delivery
- `templates/customer-report.md` — Customer-facing report template | **Read when:** audience is external/customer, need non-technical summary
- `templates/internal-engineering-note.md` — Internal engineering note template | **Read when:** audience is internal engineering team, need full technical details
- `templates/reproduction-checklist.md` — Reproduction checklist template | **Read when:** QA or engineering needs exact step-by-step reproduction steps
- `templates/diagnosis-report.md` — Formal diagnosis report template | **Read when:** need a formal documented diagnosis for record-keeping or escalation
