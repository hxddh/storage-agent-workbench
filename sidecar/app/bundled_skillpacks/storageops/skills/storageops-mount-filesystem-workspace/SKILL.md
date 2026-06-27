---
name: storageops-mount-filesystem-workspace
description: >
  Diagnose object-storage mount problems — s3fs / goofys / rclone mount /
  JuiceFS. Object storage is not a POSIX filesystem, so most issues are semantic
  mismatches (no atomic rename, no file locks, no mmap) or metadata
  amplification (ls/git stat storms). Use when a mounted bucket is slow,
  corrupts files, or breaks tools that expect a real filesystem.
domains: [mount, filesystem]
trigger_keywords:
  - mount
  - FUSE
  - s3fs
  - goofys
  - JuiceFS
  - filesystem
  - workspace
---

# Mount & Filesystem Workspace Diagnosis

Almost every mount issue is a semantic mismatch: tools (git, compilers, IDEs,
databases) expect POSIX behavior that object storage doesn't provide. Identify
whether the problem is metadata amplification (slow) or a missing POSIX
guarantee (incorrect).

## Decision tree

```
Mount issue →
  ├─ "ls / git status is extremely slow"   → metadata amplification (N×HEAD per dir)
  ├─ "file corruption on write"             → no atomic rename (copy+delete)
  ├─ "compiler/IDE/db won't work"           → flock/fcntl/mmap unsupported
  ├─ "stale data"                           → cache TTL too high (tuning trade-off)
  └─ slow but raw throughput-bound          → storageops-performance-diagnosis
```

| POSIX expectation | Object-storage reality | Typical breakage |
|---|---|---|
| atomic `rename` | copy + delete (not atomic) | corruption during writes |
| `flock`/`fcntl` | unsupported | DB/build corruption |
| `mmap` | unsupported | model/file loaders fail |
| fast directory listing | N × HEAD/GET | slow ls, git, IDE |

## Investigate with your read-only tools

The mount lives on the user's machine, so the app can't inspect it directly — but
you can characterize the backing bucket, which drives amplification:

- `list_objects` (bounded) — sample the prefix/key layout and file count behind
  the mount; deep directories with many small objects explain stat storms.
- `review_bucket_performance_profile` — object size/count distribution that
  predicts metadata amplification.

## Ask the user (only what tools can't reveal)

- Which mount tool + version, and the failing filesystem operation.
- The workload (git, npm/pip, build, IDE, database) and rough file count + RTT.
- Current mount/cache options (e.g. s3fs `stat_cache`, rclone VFS cache mode).

## What to report

Whether the cause is metadata amplification (→ caching/`--vfs-cache` tuning, or
avoid the mount for that workload) or a hard POSIX gap (→ don't run that workload
on the mount; use a real FS or a metadata-engine like JuiceFS), which guarantees
are simply unavailable, and a low-risk way to validate (e.g. time `ls` with a
larger stat cache). Be explicit that mount findings are advisory — the app
cannot probe the mount itself.
