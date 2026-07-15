---
name: storageops-account-posture
description: >
  Map an account's storage landscape and configuration posture across buckets —
  which buckets exist, which have logging / inventory / lifecycle / replication /
  public-access-block configured, and where to look first. Use when the user wants
  an account-wide overview or audit entry point and has NO specific error. A
  concrete error symptom goes to the triage skill; a single bucket's deep config
  goes to the review_bucket_* tools.
domains: [account, posture, audit]
trigger_keywords:
  - account overview
  - map my buckets
  - which buckets
  - audit
  - posture
  - where to start
  - list all buckets
---

# Account Posture & Landscape

Give the user the account-level picture and a sensible place to start — not a
deep audit of every bucket. This is the entry point when there's no specific
error: `storageops-triage` is for "I have an error, classify it"; this skill is
for "show me the landscape / what should I look at first".

## Decision tree

```
Account-wide question (no specific error) →
  run survey_account → from the profile, route to what's relevant:
  ├─ public-access-block missing / permissive policy → storageops-security-iam-policy
  ├─ logging or inventory not enabled               → observability gap (note it,
  │     and inventory is also what feeds capacity analysis)
  ├─ lifecycle absent + cost concern                → storageops-lifecycle-cost
  ├─ replication / versioning question              → storageops-replication-versioning
  └─ a bucket shows a concrete error                → storageops-triage
```

Pick what the user's goal calls for — **do not reflexively review every bucket**.
The survey gives the landscape; you decide where to go deeper.

## How this runs in the app

- `survey_account(provider_id)` runs the read-only account survey and persists a
  profile: `bucket_count` / `visible_count` (the account may hold buckets the
  credentials can't see), and per-bucket config flags — `logging_status`,
  `inventory_status`, `lifecycle_status`, `replication_status`,
  `public_access_block_status`, `policy_status` — plus detected `evidence_sources`
  (logging targets, inventory destinations). It reads the landscape; it is NOT a
  deep per-bucket audit.
- `query_account_profile(provider_id, filter)` — the account-wide posture query:
  reads the LATEST persisted survey and returns, per bucket, its region + config
  flags, filtered by posture (`missing_public_access_block`, `missing_encryption`,
  `missing_lifecycle`, `missing_logging`, `no_versioning`, `access_issues`, or
  `all`). This is how you answer "which of my N buckets have no X?" at scale —
  no re-scan, statuses only. Run `survey_account` first if none exists.
- `compare_to_last_survey(provider_id)` — "what changed since last time?" across
  the two most recent surveys.
- For one bucket's full configuration, use `review_bucket_config` /
  `review_bucket_*` instead of surveying the whole account.
- Large accounts: the survey can exceed the inline time budget and finish in the
  background — then read it with `read_run_result(run_id)`; don't re-run the
  survey.

Treat `provider_unsupported` / `access_denied` items as exactly that — report the
gap honestly rather than asserting a bucket lacks a feature you couldn't read.

## Ask the user (only what tools can't reveal)

- Which buckets are in scope, if not the whole account.
- Whether there's a specific bar to audit against (e.g. "every bucket must have
  logging + public-access-block"), so you can prioritise.

## What to report

The account landscape grounded in the profile — bucket counts (and any not
visible to the credentials), and which buckets have or lack logging / inventory /
lifecycle / public-access-block — then a short, prioritised list of where to look
first and a hand-off to the relevant specialist skill. Separate what the survey
verified from what couldn't be read.
