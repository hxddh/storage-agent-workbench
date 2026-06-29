# Product

## Goal

A local-first Storage Agent Workbench for object storage and S3-compatible
systems that helps users diagnose, analyze, and review storage workloads through
evidence-backed analysis runs.

## Primary users

- Cloud storage / SRE / ops engineers
- Data infrastructure engineers
- Developers debugging S3-compatible systems and access patterns

## Core jobs

1. Diagnose S3-compatible access and behavior issues.
2. Analyze access logs.
3. Analyze inventory, capacity, and object distribution.
4. Review bucket configuration.
5. Triage object-storage errors.
6. Generate evidence-backed Markdown reports.

## Product shape

A **thread-first agentic workbench** (Codex/Cursor-style), not a tabbed admin
panel:

- **Session rail** (left): "New investigation", the session list with
  rename / pin / archive / delete / fork, and a settings + sidecar-status footer.
- **Conversation thread** (center): a single sticky composer — you ask the agent
  (and can attach a log/inventory file for it to analyze inline). If no model key
  is configured and you paste a raw error, it falls back to offline deterministic
  triage. Messages and proposed next actions render as **inline cards**. The
  agent's own read-only surveys/reviews are narrated inline (not shown as run
  cards); only an explicit, user-requested auditable report appears as a card.
- **Settings drawer** (right slide-over): model- and cloud-provider management,
  plus a one-time first-run wizard on a fresh install.

Dark and light themes; English and 中文.

> Earlier phases used a three-column layout (Runs/Providers/Datasets/Reports/
> Settings + main run area + context panel). That shell was retired in favor of
> the thread-first design above; the underlying concepts (analysis runs, run
> types, providers) are unchanged — only the presentation moved into the thread.

## Run types

- `diagnostic`
- `access_log_analysis`
- `inventory_analysis`
- `bucket_config_review`
- `account_discovery`

## Non-goals

A generic chat assistant, a full S3 file browser, cloud sync, multi-user SaaS,
team RBAC, a workflow canvas, a plugin marketplace, automatic repair, destructive
operations, or arbitrary shell access.
