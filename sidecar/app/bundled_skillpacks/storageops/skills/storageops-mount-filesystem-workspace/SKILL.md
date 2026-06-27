---
name: storageops-mount-filesystem-workspace
description: >
  Diagnose issues with object storage mounted as a filesystem (rclone mount,
  s3fs, goofys, JuiceFS). Covers POSIX semantic mismatches (no atomic rename,
  no symlinks, no locks), metadata amplification from stat/list-heavy workloads,
  cache consistency, and workspace/IDE performance on mounted storage. Use when
  user reports slow `ls`, `git` failures, file corruption, or high latency on
  mounted object storage.
maturity: mature
mode: light_heavy
estimated_tokens: 1300
trigger_keywords:
  - rclone mount
  - s3fs
  - goofys
  - JuiceFS
  - fuse
  - mounted storage
  - mount performance
  - mount corruption
  - git on s3
  - IDE slow
  - workspace on object storage
  - stat latency
  - filesystem emulation
recommended_tools:
  - scan_secrets
  - detect_domain
  - search_memory
---

# Mount & Filesystem Workspace Diagnosis

Object storage is NOT a POSIX filesystem. Almost every mount issue stems from a semantic mismatch: tools (git, compilers, IDEs) expect POSIX behaviors that object storage doesn't provide natively.

> **Scope boundary:** this skill owns FUSE mount performance (stat/HEAD amplification, cache tuning) and POSIX semantic gaps (rename/lock/mmap/symlink). `storageops-performance-diagnosis` owns network-layer throughput (429/SlowDown, multipart, bandwidth saturation) — route a slow mount caused by raw throughput there. `storageops-data-consistency` owns cache-coherence *correctness* (is the data wrong?); this skill handles cache coherence only as a mount-tuning trade-off (is the data stale because the cache TTL is too high?).

## Decision Tree

```
Mount issue →
  ├─ "ls takes forever on a directory" → Metadata amplification (Step 3)
  ├─ "git status takes forever" → Stat amplification (Step 3 + Step 4)
  ├─ "file corruption on write" → Atomic rename missing (Step 4)
  ├─ "compiler/IDE won't work" → Lock/mmap/fcntl unsupported (Step 4)
  ├─ "stale data" → Cache coherence issue (Step 4)
  ├─ rclone mount specifically? → See rclone tuning (references/fuse.md)
  ├─ s3fs specifically? → See s3fs tuning (references/fuse.md)
  └─ Unknown mount tool? → Ask: which mount tool, what filesystem operations fail
```

## Workflow

### Step 1: Identify Mount Type
rclone mount (VFS-based), s3fs (FUSE), goofys (FUSE, read-optimized), JuiceFS (metadata engine + object storage). Each has different capabilities.

### Step 2: Classify the I/O Pattern
- **Read-heavy**: IDE file watchers, git status, compilers reading headers
- **Write-heavy**: build artifacts, database files, log files
- **Stat-heavy**: `ls -la`, file managers, rsync dry-run
- **Metadata-heavy**: git operations, package managers (npm, pip), find

### Step 3: Measure Metadata Amplification
A single `ls` on a directory with 1000 files = 1000 HEAD/GET requests to object storage API. Git status = stat() on every file in the repo. This is the #1 performance killer. See `references/object-storage-as-filesystem.md`.

When you can name the tool, workload, and rough file count, run
`python3 scripts/mount_workload_analyzer.py --tool <s3fs|goofys|juicefs|rclone> --workload <git|npm|build|ide|database|ls-find|read-only> --files <N> --rtt-ms <RTT> --json`
for a metadata-amplification estimate, the unsupported-POSIX list, and a
suitability hint. Treat its output as evidence to weigh, not a verdict to adopt:
it uses a generic workload→amplification model, so reconcile it with the specific
mount (e.g. JuiceFS's metadata engine or a cache-heavy s3fs config can change the
conclusion) before recommending.

### Step 4: Check POSIX Semantic Mismatches
| Operation | POSIX Expectation | Object Storage Reality | Impact |
|-----------|------------------|----------------------|--------|
| Atomic rename | `rename(a,b)` is atomic | Not atomic (copy+delete) | File corruption during writes |
| Symlinks | Native kernel support | Emulated via metadata | `npm install` failures |
| File locks | `flock()` / `fcntl()` | Not supported | Database corruption, build failures |
| mmap | Kernel page cache | Not supported | ML model loading failures |
| Directory listing | `getdents()` is fast | N×HEAD/GET requests | Slow `ls`, git, IDE |

### Step 5: Tune the Mount
- **rclone mount**: `--vfs-cache-mode writes --vfs-cache-max-age 1h --dir-cache-time 5m`
- **s3fs**: `-o stat_cache_expire=300 -o enable_noobj_cache -o use_cache=/tmp/s3fs`
- **General**: Set `--attr-timeout` and `--dir-cache-time` high enough to reduce stat calls

### Step 6: Feedback Loop
After tuning, ask the user to test: **"Run the same operation that was slow before and measure the time. Also: `ls -la` on the previously slow directory, and `time git status` if git was the issue."** If performance doesn't improve: **"Check if the cache directory is writable and has sufficient space (`df -h /tmp`). Mount logs often reveal cache write failures."** If the POSIX mismatch is the root cause and cannot be worked around, recommend: **"Consider JuiceFS for full POSIX compatibility, or restructure your workflow to do writes locally and sync only final output to the mount."** If confidence < medium, go back to Step 1 and ask for the exact mount command and mount logs.

## User Interaction

### When to ask the user:
- **"What mount tool and version are you using? Share the exact mount command."** — mount options are the primary tuning surface
- **"What operation is slow or failing? How many files/directories are involved?"** — quantifies metadata amplification
- **"Are you doing writes, reads, or both on the mount?"** — determines if writes mode is needed

### When to inform the user:
- **"Object storage is NOT a POSIX filesystem. Operations like atomic rename, symlinks, and file locking are NOT supported natively."**
- **"Mount cache tuning is a trade-off: higher cache times = better performance but potential stale data."**

## Output Contract — include these fields

```markdown
## Summary
[one-line diagnosis]
**Route**: storageops-mount-filesystem-workspace
**Mount type**: [tool + version]
**Confidence**: high | medium | low
**Evidence Quality**: sufficient | partial | insufficient
**Primary Diagnosis**: root_cause_type=[metadata-amplification|posix-mismatch|cache-coherence|tool-bug], affected_layer=[fuse-client|mount-cache|object-store-api|workload]

## Key Evidence
- Mount command: [sanitized]; failing operation: [e.g. git status, npm install]
- Latency observed: [operation → time]
- Stat amplification: [N files × HEAD/GET per operation]; POSIX mismatch: [unsupported op]

## Remediation
1. **[mount option change]** — [expected effect]
2. **[workflow change]** — [e.g. object-storage SDK for writes, mount for reads]
3. **[alternative tool]** — [JuiceFS for POSIX-heavy workloads]
```

## What Would Falsify This
- `ls`/`git status` is fast after raising `--dir-cache-time`/`--attr-timeout` — confirms metadata amplification rather than a network or tool bug.
- The failing operation does no rename, lock, mmap, or symlink (pure sequential read/write) — rules out a POSIX semantic mismatch as the cause.
- The same workload runs cleanly on a local SSD path with identical tool versions — isolates the failure to the mount layer, not the application.

## Risks / Open Questions
- Raising cache TTLs (`--attr-timeout`, `--dir-cache-time`) trades freshness for speed; on a bucket written by other clients this can serve stale data and is unsafe for coordinated read-write workloads.
- s3fs/goofys cache directories that fill the local disk cause silent write failures; available space on the cache path (e.g. `/tmp`) is often unknown and must be confirmed.
- JuiceFS depends on a separate metadata engine (Redis/DB); its POSIX guarantees and failure modes differ from rclone/s3fs, and the metadata engine's own availability becomes a new single point of failure across BOS/OSS/COS deployments.

## Examples

### Example 1: git status takes 45 seconds
**Input**: rclone mount with a git repo of 5000 files. `git status` = 45s.
**Diagnosis**: Metadata amplification — git stat()s every file in the working tree. 5000 HEAD requests to S3 = ~45s at ~9ms RTT.
**Recommendation**: `--dir-cache-time 1h --attr-timeout 1h --vfs-cache-mode full`. Expect git status <3s after cache warm.

### Example 2: npm install failures
**Input**: npm install on mounted storage. Errors: `ENOTEMPTY`, `EEXIST`, `EPERM`.
**Diagnosis**: npm uses atomic rename for package installation. rclone mount rename is NOT atomic.
**Recommendation**: Use local filesystem for node_modules, mount for source code only. Or use `--vfs-cache-mode full`.

### Example 3: Build corruption on parallel make
**Input**: make -j8 on mounted directory. Random corruption in output binaries.
**Diagnosis**: Parallel writes to same file. Object storage has no `O_EXCL` or file locking. Multiple processes overwriting simultaneously.
**Recommendation**: Build locally, sync output to mount. Or reduce to `make -j1`. For production: JuiceFS with full POSIX emulation.

## References
- `scripts/mount_workload_analyzer.py` — Offline mount/workspace suitability analyzer (metadata amplification, POSIX gaps, verdict) | **Run when:** deciding whether a workload (git/npm/build/ide/database) belongs on an object-storage mount, or explaining why a mount is slow/unsafe
- `references/fuse.md` — FUSE mount tuning, rclone VFS cache modes, and s3fs options by workload | **Read when:** user uses any FUSE-based mount tool (rclone mount, s3fs, goofys) and needs cache/option tuning or reports performance/corruption issues
- `references/posix-semantics.md` — POSIX vs object storage behavior matrix | **Read when:** user reports git, npm, compilers, or other POSIX-dependent tools failing on mount
- `references/object-storage-as-filesystem.md` — Quantifying and reducing stat/HEAD amplification | **Read when:** user reports slow `ls`, `git status`, or file managers on mount
- `references/workspace-layout.md` — What lives in a dev workspace and which parts suit an object-storage mount | **Read when:** laying out a workspace across mount vs local disk
- `references/agent-sandbox-storage.md` — Storage patterns for ephemeral agent/sandbox environments | **Read when:** the workload is an agent sandbox or CI/ephemeral environment backed by object storage
