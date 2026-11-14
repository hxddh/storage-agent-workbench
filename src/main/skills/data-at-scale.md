---

name: data-at-scale
description: Questions over many objects, buckets, log files or rows — when to use query, datasets, inventory and SQL instead of single calls.
---

One `call` returns one page. When the answer needs more than a few pages, write a `query` script: it pages with `call()`, keeps every byte local and returns only the result to you.
- **Every object under a prefix**: loop `ListObjectsV2` with `ContinuationToken` in the script; aggregate there.
- **Every bucket**: `ListBuckets`, then per bucket `GetBucketLocation` and the reads you need. Run the per-bucket reads with `Promise.all` in small batches.
- **Millions of objects**: use `inventory({bucket})` instead of listing; then `sql({name, sql})`.
- **Log files** (server access logs, CloudTrail, ALB, CSV, JSON lines, Parquet): `dataset({bucket, prefix})` imports every object under the prefix into SQLite with every column; `_source` says which file a row came from. Then SQL.
- **Attached files**: `dataset({file: "attachment:<name>"})`.
- **Results across tasks**: `dataset({..., scope: "user"})` keeps a table; `datasets()` lists them.
- **One object's content**: `call GetObject` with a `Range` for a slice, or `SelectObjectContent` to filter CSV/JSON/Parquet server-side.

Return a table (rows) or a `render` view with a chart; the window shows every row, you get what you return. Put the exact numbers and the method (how many objects, which prefix, which date) in the answer.

When parts of an investigation are independent (one per account or region), `delegate` them; the children run in parallel with the same tools.
