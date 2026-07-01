---
name: storageops-workbench-investigation
description: >
  The general method for running any object-storage investigation in this
  workbench: turn a vague ask into a grounded answer by chaining read-only tools,
  recording what you find, and proposing next steps. Use when the request has no
  single obvious category, spans several buckets/providers, or you need to decide
  which specialist skill to load next. Not a substitute for the domain skills —
  it's how you drive them.
domains: [method]
trigger_keywords:
  - investigate
  - where do I start
  - overall health
  - audit my storage
  - not sure what's wrong
---

# Workbench Investigation Method

You are a read-only investigator with a real tool loop. Most questions are
answered not by one tool but by a short adaptive chain: observe, narrow, verify,
report. This skill is the backbone; the domain skills (`storageops-*`) supply the
specifics for each branch.

## The loop

```
1. Frame     → restate the concrete question + success criterion. If the target
               (provider/bucket/key/time-range) is ambiguous AND tools can't
               resolve it, ask one sharp question; otherwise pick the obvious one
               and say which you picked.
2. Orient    → what's already known? Reuse agent_memory + the deterministic
               summary before re-deriving. list_providers / list_buckets to see
               the surface.
3. Probe     → chain the cheapest read-only tools that discriminate between
               hypotheses (head_bucket → list_objects → head_object → the config
               readers → the live probes). Load a specialist skill with
               read_skill when the branch is clear.
4. Verify    → before asserting a high-severity conclusion, confirm it with a
               second tool or angle. Measure, don't guess (e.g. latency →
               measure_request_latency, not intuition).
5. Ground    → answer in your own words, marking tool-verified facts vs.
               inferences vs. assumptions; list evidence_used and honest
               evidence_gaps.
6. Persist   → note_fact / record_finding / note_open_question so the next turn
               builds on this one instead of repeating it.
7. Propose   → offer next-action proposals for anything heavier or data-moving
               (an auditable run, an evidence import) — never auto-run those.
```

## Choosing the next specialist skill

- Permission / 403 → `storageops-security-iam-policy` (public exposure lives
  there too).
- "Slow" → `storageops-performance-diagnosis` (measure first).
- Bill too high / bucket huge → `storageops-lifecycle-cost` (+ versions /
  multipart data-level tools).
- Config posture across logging/versioning/notification → `storageops-observability-audit`.
- Whole-account picture → `storageops-account-posture`.
- Protocol / endpoint / addressing / provider quirks → `storageops-s3-protocol-compatibility`.
- Unknown category → `storageops-triage` classifies first.

## Investigate with your read-only tools

- `survey_account` / `review_bucket_config` — the broad, bounded read-only runs
  when the question is about the account or a whole bucket's posture.
- `list_*` / `head_*` / config readers — the fine-grained probes for a specific
  hypothesis.
- `analyze_uploaded_file` (after `list_uploaded_files`) — when the user attached
  a log or inventory export; for data still in a bucket, propose an import.
- `read_run_result` — pick up a backgrounded run's result in a later turn.

## What to report

The concrete answer, the chain that produced it (so it's reproducible), what is
tool-verified vs. assumed, the gaps you couldn't close read-only, and a short set
of proposed next steps. Prefer finishing the investigation over narrating a plan.
