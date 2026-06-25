# Product

## Product goal

Build a local-first Storage Agent Workbench for object storage and S3-compatible systems.

The app should help users diagnose, analyze, and review object storage workloads through evidence-backed Analysis Runs.

## Primary users

- Cloud storage engineers
- SRE / ops engineers
- Data infrastructure engineers
- Developers debugging S3-compatible systems
- Engineers analyzing object storage access patterns and bucket layout

## Core jobs

1. Diagnose S3-compatible access and behavior issues.
2. Analyze access logs.
3. Analyze inventory, capacity, and object distribution.
4. Review bucket configuration.
5. Generate evidence-backed Markdown reports.

## Product shape

The interface should be Claude/Codex-like: task-oriented, run-oriented, and evidence-oriented.

It should use a three-column layout.

Left:

- Runs
- Providers
- Datasets
- Reports
- Settings

Middle:

- Current Analysis Run
- Agent plan
- Tool / Analysis Timeline
- Metrics
- Findings
- Report preview

Right:

- Provider context
- Bucket context
- Endpoint
- Region
- Mode
- Allowed prefixes
- Risk policy
- Approval status

## Run types

Initial run types:

- `diagnostic`
- `access_log_analysis`
- `inventory_analysis`
- `bucket_config_review`
- `optimization_report`

## MVP scope

MVP should support:

- Local desktop shell
- Python sidecar
- Health check
- Provider configuration in later phases
- Readonly S3-compatible diagnostics in later phases
- DuckDB-backed access log and inventory analysis in later phases
- Bucket config review in later phases
- Markdown reports in later phases

## Non-goals for MVP

- Generic chat assistant
- Full S3 file browser
- Cloud sync
- Multi-user SaaS
- Team RBAC
- Workflow canvas
- Plugin marketplace
- Automatic repair
- Destructive operations
- Arbitrary shell access
- GitHub Issues workflow
