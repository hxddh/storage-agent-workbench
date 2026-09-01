---
name: my-local-runbook
description: A starter user skill — copy this directory to STORAGE_AGENT_DATA_DIR/skills/ or STORAGE_AGENT_SKILLS_DIR and edit it. Keep it to guidance text only.
---

# My Local Runbook

This is an example **user skill** for Storage Agent. Put your team's
runbook, checklists, and tribal knowledge here — the Agent will load it
on demand via `read_skill("my-local-runbook")` when it fits the user's
problem.

## When to use

- Your user has a recurring storage problem (e.g. "MinIO presigned URL 403s after 5 min")
- You want the Agent to follow your team's approved steps first

## Method

1. Describe symptoms to collect (error code, endpoint, bucket, key, headers)
2. Run the relevant read-only probes (`head_bucket`, `get_bucket_location`, `test_addressing_style`, `preview_object`)
3. Compare config (`get_bucket_config_summary`) with observed behavior
4. Summarize findings, cite evidence, note gaps

## Boundaries

- Read-only, bounded, sanitized — same as every other skill
- No shell, no raw boto3, no secrets in output
- Keep bodies under 8k chars; frontmatter is stripped before the Agent sees it
