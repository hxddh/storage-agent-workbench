---
name: storageops-migration-sync
description: >
  Plan and troubleshoot cross-provider object storage migrations and ongoing
  sync. Covers strategy selection (server-side copy, direct transfer, offline),
  time/cost estimation, ETag and metadata compatibility across providers,
  integrity verification, and rollback planning. Use when user plans to move
  data between object storage providers or set up ongoing cross-provider sync.
maturity: mature
mode: light_heavy
estimated_tokens: 1300
trigger_keywords:
  - migrate storage
  - cross-provider migration
  - sync buckets
  - move data between clouds
  - transfer to BOS
  - transfer to OSS
  - transfer to COS
  - storage migration
  - bucket migration
  - rclone sync
recommended_tools:
  - scan_secrets
  - detect_domain
  - search_memory
---

# Cross-Provider Migration & Sync

Choose the right migration strategy based on data volume, network bandwidth, and provider compatibility. The three strategies trade speed vs cost vs complexity.

> **Scope boundary:** this skill owns cross-provider migration planning, sync integrity/checksum verification, and transfer-strategy selection. `storageops-cli-sdk-diagnosis` owns single-tool bugs (an rclone/s5cmd flag or version defect). `storageops-data-consistency` owns ETag semantics and format (what an ETag means and how it is computed); route a multipart ETag-format mismatch surfaced *during migration* here, but the underlying ETag definition there.

## Decision Tree

```
Migration planning →
  ├─ Same provider, same region? → Server-side copy (fastest, no data transfer cost)
  ├─ Cross-provider (AWS→BOS, OSS→COS, etc)?
  │   ├─ <1TB? → Direct client transfer with rclone (simplest)
  │   ├─ 1TB–100TB? → Direct transfer with parallel workers + bandwidth reservation
  │   └─ >100TB? → Offline transfer (Snowball/DataSync appliance)
  ├─ Ongoing sync needed (not one-time)? → rclone sync + notification trigger
  ├─ Delta only (not full copy)? → rclone sync only
  └─ Strict consistency required? → Must verify every object checksum post-migration
```

## Workflow

### Step 1: Characterize the Migration
- **Source**: provider, region, bucket size, object count, file size distribution
- **Destination**: provider, region, available bandwidth
- **Constraints**: time window, cost budget, downtime tolerance, consistency requirement

### Step 2: Select Strategy
- **Server-side copy**: same provider only. No data transfer cost. Fastest. Example: `aws s3 sync s3://src/ s3://dst/`
- **Direct client transfer**: cross-provider. rclone with parallel workers. Cost = compute + bandwidth. Example: `rclone sync source: remotedest: --transfers 32`
- **Offline transfer**: >100TB or limited bandwidth. Ship physical device.

### Step 3: Time & Cost Estimation
- **Time** = data volume / effective throughput (with overhead: 70-85% of line rate for small files)
- **Cost** = compute (EC2/similar × hours) + bandwidth (egress charges) + API requests (LIST/PUT/GET)
- Cross-provider egress can be the dominant cost — check both providers' egress pricing

### Step 4: Cross-Provider Compatibility Check
- **ETag format**: AWS multipart ETag includes `-N` suffix. BOS uses different format. rclone `--s3-use-multipart-etag` flag affects integrity checks.
- **Metadata**: x-amz-meta-* headers may have different length limits or encoding rules across providers.
- **ACL/Policy**: Bucket policies and ACLs don't transfer between providers — must recreate.
- See `references/cross-provider-compatibility.md`.

### Step 5: Dry-Run Validation
Before full migration, test with 1000 representative objects:
- Time a sample transfer → validate throughput estimate
- Compare checksums → verify ETag compatibility
- Test metadata preservation → verify custom headers survive

### Step 6: Integrity Verification
Post-migration: compare object count, total size, and sample checksums. For strict consistency, verify every object (rclone `--checksum`).

When a sync/copy failed or corrupted, run
`python3 scripts/sync_log_analyzer.py --log rclone.log --json` (or `--stdin`) on
the rclone/s5cmd/obsutil log: it classifies the dominant error (checksum
mismatch vs access denied vs not found vs throttle), reports transfer counts, and
flags a destructive (deleting) sync. Reason over that summary — e.g. a checksum
mismatch is usually a cross-provider ETag-format difference, not real corruption.

### Step 7: Feedback Loop
Run `python3 scripts/migration_cost_estimator.py` with object count and size to validate time/cost estimates against actuals. If the dry-run fails or stalls, ask the user: "Did you run a dry-run with `--dry-run`? What error messages did you see? What is your current transfer rate?" If confidence < medium after diagnosis, go back to Step 3 (Time & Cost Estimation) and request more detailed bandwidth/topology data.

## User Interaction

### Ask the user for:
- Source and destination providers, regions, and approximate data volume
- Available bandwidth and any time window constraints
- Whether this is a one-time migration or ongoing sync
- Dry-run results: error messages, transfer rate, ETag mismatch patterns

### Inform the user that:
- Cross-provider egress fees can dominate total cost. Confirm provider, source region, destination, and current pricing before quoting numbers.
- ETag format differences between providers may cause false checksum failures on multipart objects
- A dry-run with 1000 representative objects is strongly recommended before committing to the full migration
- For >100TB, offline transfer (appliance) is often cheaper and faster than network transfer

## Output Contract — include these fields

```markdown
## Summary
[one-line migration plan / diagnosis]
**Route**: storageops-migration-sync
**Strategy**: server-side-copy | direct-transfer | offline-transfer
**Confidence**: high | medium | low
**Evidence Quality**: sufficient | partial | insufficient
**Primary Diagnosis**: root_cause_type=[strategy-mismatch|etag-incompatibility|metadata-loss|throughput-shortfall|destructive-sync], affected_layer=[source|destination|transfer-tool|provider-protocol]
**Estimated time**: [hours/days]

## Key Evidence
- Source: [provider/region], [object count] × [total size]; bandwidth: [Mbps/Gbps]
- File distribution: [P50/P90 file sizes]
- Compatibility issues found: **[issue]** — [mitigation]

## Remediation
- Recommended tool/flags: rclone `[specific flags for this migration]`
- Post-migration verification: object count (`rclone size` source vs dest), then an explicit checksum on a sample (never cross-provider raw multipart ETags)

## What Would Falsify This
- [size/checksum/metadata evidence that would overturn the diagnosis]

## Risks / Open Questions
- [destructive-sync blast radius, cross-provider ETag/metadata differences, throughput assumptions]
```

## What Would Falsify This
- Checksums match byte-for-byte on every sampled object after a multipart transfer — rules out an ETag-format incompatibility as the cause of reported "corruption."
- Object count and total size are identical on source and destination — rules out a partial/stalled migration and points at metadata or ACL gaps instead.
- The same rclone/s5cmd command succeeds on a single-provider (same-vendor) copy — isolates the failure to a cross-provider protocol difference, not the transfer tool itself.

## Risks / Open Questions
- Egress and request pricing are provider- and region-specific and change over time; a cost estimate is unreliable until current BOS/OSS/COS and source-side rates are confirmed.
- A `sync` (vs `copy`) can delete objects on the destination that are absent at the source — confirm the destination is empty or intended-to-mirror before running a non-dry-run sync.
- Custom `x-amz-meta-*` header length/encoding limits differ across BOS/OSS/COS; metadata that survives a 1000-object dry-run may still be silently truncated at scale.

## Examples

### Example 1: AWS → BOS, 50TB
**Input**: Move 50TB from AWS S3 us-east-1 to BOS bj. 1 Gbps link. Files: 10M objects × avg 5MB.
**Diagnosis**: Cross-provider, medium scale. Direct transfer with rclone.  
**Strategy**: Compute near the source running rclone. `--transfers 32 --checkers 64` is a starting point, then tune from dry-run metrics. Egress cost can dominate and must be calculated from current provider pricing. Time: roughly days at a sustained 1 Gbps before small-file overhead.
**Recommendation**: rclone sync with `--s3-use-multipart-etag=false` for BOS. Validate 1000 random objects post-transfer.

### Example 2: Same-provider intra-region, 500TB
**Input**: Copy 500TB from bucket-A to bucket-B, both AWS us-east-1.
**Diagnosis**: Same provider, same region — use server-side copy.  
**Strategy**: AWS S3 Batch Operations COPY job. Zero data transfer cost. Time: S3-managed (typically <24h for 500TB).
**Recommendation**: No rclone needed. Use S3 Batch Operations with inventory report. Validate with S3 inventory comparison.

### Example 3: Ongoing cross-provider sync
**Input**: Keep BOS bucket synced from AWS S3 (daily delta of ~10GB).
**Diagnosis**: Ongoing sync with delta only.  
**Strategy**: `rclone sync` on cron. Add S3 event notification → Lambda/Function Compute to trigger sync.
**Recommendation**: Rclone with `--checksum --transfers 16`. Monitor for ETag mismatch on multipart objects.

## References
- `scripts/sync_log_analyzer.py` — Offline rclone/s5cmd/obsutil log analyzer (error classification, counts, destructive-sync flag); run `python3 scripts/sync_log_analyzer.py --log <log> --json` (or `--stdin`) | **Run when:** a sync/copy failed or corrupted and you have the transfer log
- `scripts/migration_cost_estimator.py` — Offline time/cost estimator for a planned migration | **Run when:** validating a migration's time/cost against object count and size
- `references/migration-strategies.md` — Detailed comparison of all 3 strategies | **Read when:** user is uncertain about which migration approach to take (server-side vs direct vs offline)
- `references/rclone-migration-guide.md` — Rclone flags for cross-provider migration | **Read when:** user has selected rclone as the transfer tool and needs flag guidance
- `references/cross-provider-compatibility.md` — ETag, metadata, ACL compatibility matrix | **Read when:** user reports checksum mismatches, metadata loss, or ACL/permission issues after migration
- `references/integrity-verification.md` — Post-migration checksum strategies | **Read when:** user needs to verify migration completeness (object count, size, checksum comparison)
- `references/bandwidth-estimation.md` — Throughput calculation with overhead | **Read when:** user asks for time/cost estimates or reports slower-than-expected transfer rates
- `references/egress-cost-assumptions.md` — Dated assumptions for cross-provider egress, request, and compute cost estimates | **Read when:** user asks for migration cost estimates or compares transfer strategies
