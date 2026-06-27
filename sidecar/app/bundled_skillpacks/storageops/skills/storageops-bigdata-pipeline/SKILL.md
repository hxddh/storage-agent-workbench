---
name: storageops-bigdata-pipeline
description: >
  Diagnose Spark/Hive/Hadoop/Flink failures against object storage — output
  committer races (FileOutputCommitter V1 on S3), small-file amplification,
  partition discovery, connection-pool exhaustion, and table-format (Iceberg/
  Delta/Hudi) snapshot issues. Use for S3A/EMR job errors or slow jobs writing to
  buckets. Identify the committer first; it drives the whole diagnosis.
domains: [bigdata]
trigger_keywords:
  - Spark
  - Hive
  - Hadoop
  - S3A
  - EMR
  - committer
---

# Big Data Pipeline Diagnosis

The classic S3 big-data failures are committer races (the default
FileOutputCommitter V1 relies on atomic rename, which object storage lacks),
small-file amplification, and connection-pool exhaustion. Always identify the
committer first.

## Decision tree

```
Spark/Hive job issue →
  ├─ "Output directory does not exist" / FileNotFound → V1 commit race → use the S3A committer (magic)
  ├─ FileAlreadyExists → speculative execution + V1, or task-attempt collision
  ├─ succeeds but wrong/old data → partition not discovered (MSCK) or table-format snapshot
  ├─ slow, thousands of tiny files → small-file amplification → coalesce before write
  └─ slow, normal file count → connection pool / throughput → storageops-performance-diagnosis
```

## Investigate with your read-only tools

The job runs in the user's cluster, so the app inspects the *bucket* the job
writes to:

- `list_objects` (bounded) — sample the output prefix: many tiny part files or
  leftover `_temporary`/`_SUCCESS` markers confirm a committer/small-file
  problem.
- `review_bucket_performance_profile` — object size/count distribution that
  quantifies small-file amplification.
- `head_object` on `_SUCCESS` / part files — confirm what the job actually wrote.

## Ask the user (only what tools can't reveal)

- Engine + version and the committer config
  (`mapreduce.fileoutputcommitter.algorithm.version`, `fs.s3a.committer.name`).
- Table format (plain / Iceberg / Delta / Hudi) and whether speculative
  execution is on.
- The driver/executor error with the full stack trace.

## What to report

The committer/root cause (V1-rename-race / small-file / partition-discovery /
connection-pool), grounded in what the output prefix shows vs. the config the
user supplied, the fix (switch to the magic/staging S3A committer; coalesce
partitions; tune `fs.s3a.connection.maximum`) marked manual-only, and a note that
non-AWS providers may differ on committer support.
