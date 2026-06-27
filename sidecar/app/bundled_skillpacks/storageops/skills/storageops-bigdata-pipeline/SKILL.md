---
name: storageops-bigdata-pipeline
description: >
  Diagnose Spark/Hive/Flink/Presto failures on object storage (S3A).
  Covers committer race conditions (FileOutputCommitter V1 vs S3A committers),
  partition discovery, small-file amplification, connection pool exhaustion,
  and table format issues (Iceberg/Delta/Hudi). Use when user reports
  Spark job failures, FileNotFoundException, FileAlreadyExistsException,
  or slow analytics queries on S3-backed tables.
maturity: mature
mode: light_heavy
estimated_tokens: 1400
trigger_keywords:
  - Spark
  - Hive
  - Flink
  - Presto
  - Trino
  - EMR
  - FileNotFoundException
  - FileAlreadyExistsException
  - committer
  - S3A
  - partition discovery
  - small files
  - Iceberg
  - Delta Lake
  - Hudi
recommended_tools:
  - scan_secrets
  - detect_domain
  - search_memory
---

# Big Data Pipeline Diagnosis

The most common S3 big-data failures are committer race conditions (V1 default), small-file amplification, and connection pool exhaustion. Always identify the committer type first — it determines the entire diagnosis path.

> **Scope boundary:** this skill owns Spark/Hive/Flink committer, partition-discovery, and table-format issues. `storageops-cli-sdk-diagnosis` owns SDK/Hadoop-version-specific bugs; `storageops-performance-diagnosis` owns general throughput tuning (multipart, concurrency, throttling). Route version-pinned defects and raw throughput complaints to those skills.

## Decision Tree

```
Spark/Hive job failure →
  ├─ "FileNotFoundException: Output directory does not exist"?
  │   ├─ Using FileOutputCommitter V1 (default)? → V1 commit race (Step 2)
  │   └─ Using S3A committer? → Check fs.s3a.committer configuration
  ├─ "FileAlreadyExistsException"?
  │   ├─ V1 committer + speculative execution? → Task duplication + V1 conflict
  │   └─ S3A committer? → Task attempt collision → Check magic committer
  ├─ Job succeeds but reads wrong data?
  │   ├─ Hive MSCK? → Partition not discovered (Step 3)
  │   └─ Iceberg/Delta? → Snapshot isolation issue (Step 6)
  ├─ Slow queries, no errors?
  │   ├─ Thousands of small files? → Small-file amplification (Step 4)
  │   └─ Normal file count? → Connection pool (Step 5) or S3Guard (Step 7)
  └─ Non-AWS (BOS/OSS/COS)? → Committer compatibility may differ (Step 2)
```

## Workflow

### Step 1: Identify Stack and Committer
Extract from config: engine (Spark/Hive/Flink), committer type (`mapreduce.fileoutputcommitter.algorithm.version`, `fs.s3a.committer.name`), and table format (Iceberg/Delta/Hudi/plain).

When a `spark-defaults.conf`, Hadoop `*-site.xml`, or driver log is available, run
`python3 scripts/analyze_committer.py --conf <file> --json` (or `--xml`/`--stdin`)
to get the committer type and object-storage risk deterministically, then reason
over its verdict instead of inferring the committer by eye.

### Step 2: Committer Protocol Diagnosis
- **FileOutputCommitter V1** (default): Known to cause `FileNotFoundException` and task duplication on S3. The `_temporary` → final rename is NOT atomic on object storage. **Recommend**: switch to S3A committer (`fs.s3a.committer.name=magic`).
- **S3A Committers** (magic/staging/partitioned): See `references/committer-guide.md` for configuration matrix.

### Step 3: Partition Discovery
- **Hive**: `MSCK REPAIR TABLE` is slow on S3 with many partitions. Check if partitions exist at expected paths. See `references/partition-discovery.md`.
- **Spark**: `spark.sql.parquet/pathGlobFilter` may miss new partitions.

### Step 4: Small-File Amplification
High partition count × small files per partition causes excessive LIST/HEAD requests. For analytics, files <128MB per partition cause I/O overhead. Recommendation: compaction job or `spark.sql.files.maxPartitionBytes`.

### Step 5: Connection Pool
Default S3A pool is 256 connections per JVM. Exhaustion causes hangs. Check `fs.s3a.connection.maximum` and thread count.

### Step 6: Table Format Issues
- **Iceberg**: Check `write.format.default`. Snapshot expiration may cause missing data.
- **Delta**: `_delta_log` concurrency. Optimistic concurrency conflicts on concurrent writes.
- **Hudi**: Timeline server and compaction scheduling.

### Step 7: S3Guard/DynamoDB Consistency (EMR)
S3Guard provides consistent listing on S3. If using EMR with consistent view disabled, stale listings cause `FileNotFoundException`.

### Step 8: Feedback Loop
If the diagnosis points to a committer issue:
- **Controlled test**: Recommend testing with a different committer (e.g., V1 → magic) on a small subset of data before full redeployment.
- If confidence is **medium or low**, ask the user: *"Can you share the Spark UI screenshot of the failed stage? What is the partition count and output file count?"* This helps distinguish committer races from partition/metadata issues.
- If the user's fix resolves the issue, ask them to confirm so the diagnosis can be added to the knowledge base.

## User Interaction

### When to ask the user:
- *"What engine and version are you using?"* (Spark/Hive/Flink/Presto + version)
- *"What committer is configured? Share your `core-site.xml` or Spark config."*
- *"Can you share the Spark UI screenshot of the failed stage?"*
- *"What is the approximate partition count and output file count?"*

### When to inform the user:
- Before recommending a committer change: *"This change requires a cluster restart and should be tested in staging first."*
- After diagnosis: *"The recommended config change only takes effect for new jobs — existing running jobs will still use the old committer."*

## Output Contract — include these fields

```markdown
## Summary
[one-line diagnosis]
**Route**: storageops-bigdata-pipeline
**Confidence**: high | medium | low
**Evidence Quality**: sufficient | partial | insufficient
**Primary Diagnosis**: root_cause_type=[committer-race|partition-discovery|small-files|connection-pool|table-format|s3guard], affected_layer=[committer|metadata|filesystem-client|table-format]

## Key Evidence
- Engine: [Spark 3.x / Hive 3.x]; committer: [V1 / magic / staging / partitioning]
- Table format: [plain / Iceberg / Delta / Hudi]
- Explanation with config evidence: [finding]

## Remediation
1. **[config change]** — `fs.s3a.committer.name=magic` (manual-only, test in staging)
2. ...

## What Would Falsify This
- [evidence that would make the diagnosis unlikely]

## Risks / Open Questions
- [missing config, production risk, provider-specific caveat]
```

## Examples

### Example 1: V1 committer race
**Input**: Spark job on EMR, 100 tasks writing to S3. Error: `FileNotFoundException: Output directory s3://bucket/output/_temporary does not exist`.
**Diagnosis**: FileOutputCommitter V1 race — task 1 deleted `_temporary` while task 2 was still writing.  
**Recommendation**: `fs.s3a.committer.name=magic`, `spark.sql.sources.commitProtocolClass=org.apache.spark.sql.execution.datasources.SQLHadoopMapReduceCommitProtocol`

### Example 2: Small-file amplification
**Input**: Athena query on 500K files × 10KB across 1000 partitions. Query takes 8 min for simple COUNT.
**Diagnosis**: Small-file amplification — 500K S3 LIST/HEAD per query  
**Recommendation**: Compaction job to merge into 128MB files, target 5000 files total. Expect query time <30s.

### Example 3: Cross-provider Iceberg
**Input**: Iceberg table on BOS, writes succeed but reads return stale data after compaction.
**Diagnosis**: BOS Iceberg catalog may not support atomic rename required by Iceberg commit protocol  
**Recommendation**: Use Hive catalog with BOS, test snapshot isolation under concurrent writes.

## What Would Falsify This
- `analyze_committer.py` (or the config) shows an S3A committer (magic/staging) already active, ruling out a FileOutputCommitter V1 `_temporary` rename race.
- The failure reproduces on a single task with no speculative execution and no concurrent writers, making a committer/task-collision race unlikely versus a genuine missing input path.
- Output file count is small and partition count is modest, so a small-file/LIST-amplification hypothesis cannot explain the slow query.

## Risks / Open Questions
- Without `spark-defaults.conf`/`*-site.xml` and the driver log, the committer and connection-pool settings are inferred, not confirmed — confidence should stay medium.
- A committer change requires a cluster restart and only affects new jobs; validate on a data subset before full rollout to avoid corrupting production output.
- On BOS/OSS/COS the S3A magic committer and atomic-rename guarantees differ from AWS — confirm provider committer support via `references/provider-compatibility.md` before recommending it.

## References
- `references/committer-guide.md` — S3A committer configuration matrix | **Read when:** user reports FileNotFoundException, FileAlreadyExistsException, or mentions committer name
- `scripts/analyze_committer.py` — Offline committer/config analyzer (committer type + object-storage risk) | **Read when:** you have a spark-defaults.conf, Hadoop *-site.xml, or driver log and need to confirm the committer
- `references/partition-discovery.md` — Hive/Spark partition strategies | **Read when:** user reports stale/missing data after writes, or MSCK REPAIR TABLE slowness
- `references/connection-pool.md` — S3A connection pool tuning | **Read when:** user reports job hangs, timeout errors, or "Unable to execute HTTP request"
- `references/table-formats.md` — Iceberg/Delta/Hudi on object storage | **Read when:** user mentions Iceberg, Delta, or Hudi table format
- `references/provider-compatibility.md` — Non-AWS committer behavior | **Read when:** the provider is non-AWS (BOS/OSS/COS) — named by the user or reported by `detect_domain`
