"""Fix packs and their impact preview.

A fix is text the user applies with their own credentials — Storage Agent never
writes to storage. Each fix comes in the forms people apply changes with: the
AWS CLI command, a Terraform resource, and the API document itself.

Before applying it, the user sees what the fix would change, from evidence the
estate already holds: the bucket's recorded posture and the access logs attached
or imported for it. The preview is deterministic and aggregate-only (counts, a
time range, a few prefixes); raw log rows never leave DuckDB. When the evidence
cannot answer the question, the preview says so — it never guesses.
"""

from __future__ import annotations

import json
import re
import sqlite3
from typing import Any

from ..security.redaction import redact_text

# --- formats ---------------------------------------------------------------------------

_DOC_NAME = {
    "public_access_block": "PublicAccessBlockConfiguration",
    "default_encryption": "ServerSideEncryptionConfiguration",
    "lifecycle": "LifecycleConfiguration",
}


def _tf_string(value: str) -> str:
    """An HCL string literal: JSON escaping plus HCL's own interpolation markers."""
    return json.dumps(value).replace("${", "$${").replace("%{", "%%{")


def _tf_name(bucket: str) -> str:
    name = re.sub(r"[^A-Za-z0-9_]", "_", bucket)[:60] or "bucket"
    return name if name[0].isalpha() or name[0] == "_" else f"b_{name}"


def _tf_lifecycle_rule(rule: dict[str, Any]) -> str:
    body = [f"    id     = {_tf_string(str(rule.get('ID', 'rule')))}", '    status = "Enabled"', "    filter {}"]
    if "AbortIncompleteMultipartUpload" in rule:
        days = int(rule["AbortIncompleteMultipartUpload"]["DaysAfterInitiation"])
        body.append(f"    abort_incomplete_multipart_upload {{\n      days_after_initiation = {days}\n    }}")
    if "NoncurrentVersionExpiration" in rule:
        days = int(rule["NoncurrentVersionExpiration"]["NoncurrentDays"])
        body.append(f"    noncurrent_version_expiration {{\n      noncurrent_days = {days}\n    }}")
    return "  rule {\n" + "\n".join(body) + "\n  }"


def terraform(fix: dict[str, Any], bucket: str, *, endpoint_url: str | None = None,
              region: str | None = None) -> str | None:
    kind, doc = fix.get("kind"), fix.get("document") or {}
    name, b = _tf_name(bucket), _tf_string(bucket)
    if kind == "public_access_block":
        body = (f'resource "aws_s3_bucket_public_access_block" "{name}" {{\n  bucket = {b}\n\n'
                + "\n".join(f"  {k} = {'true' if doc.get(v) else 'false'}" for k, v in (
                    ("block_public_acls      ", "BlockPublicAcls"), ("ignore_public_acls     ", "IgnorePublicAcls"),
                    ("block_public_policy    ", "BlockPublicPolicy"), ("restrict_public_buckets", "RestrictPublicBuckets")))
                + "\n}")
    elif kind == "default_encryption":
        rule = (doc.get("Rules") or [{}])[0]
        algo = rule.get("ApplyServerSideEncryptionByDefault", {}).get("SSEAlgorithm", "AES256")
        body = (f'resource "aws_s3_bucket_server_side_encryption_configuration" "{name}" {{\n  bucket = {b}\n\n'
                f"  rule {{\n    apply_server_side_encryption_by_default {{\n      sse_algorithm = {_tf_string(algo)}\n"
                f"    }}\n    bucket_key_enabled = {'true' if rule.get('BucketKeyEnabled') else 'false'}\n  }}\n}}")
    elif kind == "lifecycle":
        rules = "\n\n".join(_tf_lifecycle_rule(r) for r in doc.get("Rules") or [])
        body = f'resource "aws_s3_bucket_lifecycle_configuration" "{name}" {{\n  bucket = {b}\n\n{rules}\n}}'
    else:
        return None
    head = []
    if endpoint_url:
        # A custom endpoint belongs in the provider block the user already has.
        head = ["# This bucket lives on a custom S3 endpoint; your aws provider needs:",
                f"#   endpoints {{ s3 = {_tf_string(endpoint_url)} }}",
                "#   s3_use_path_style = true"]
        if region:
            head.append(f"#   region = {_tf_string(region)}")
    return "\n".join([*head, "", body]) if head else body


def formats(fix: dict[str, Any], bucket: str, *, endpoint_url: str | None = None,
            region: str | None = None) -> list[dict[str, str]]:
    out = [{"format": "cli", "label": "AWS CLI", "text": fix["command"]}]
    tf = terraform(fix, bucket, endpoint_url=endpoint_url, region=region)
    if tf:
        out.append({"format": "terraform", "label": "Terraform", "text": tf})
    if fix.get("document"):
        out.append({"format": "json", "label": _DOC_NAME.get(fix.get("kind", ""), "JSON"),
                    "text": json.dumps(fix["document"], indent=2)})
    return out


# --- impact preview ---------------------------------------------------------------------

_T = {
    "en": {
        "anon_seen": "{anon} of {total} requests to this bucket in the attached access logs were anonymous "
                     "({first} – {last}). Blocking public access refuses requests like these.",
        "anon_none": "None of the {total} requests to this bucket in the attached access logs "
                     "({first} – {last}) were anonymous.",
        "anon_prefixes": "Anonymous requests went mostly to: {prefixes}.",
        "no_logs": "Cannot tell who reads this bucket anonymously: no S3 server access log for it has been "
                   "attached or imported. Ask the Agent to import its access logs, or attach one.",
        "log_format": "Attached access logs for this bucket are not in the S3 server access log format, "
                      "so anonymous requests cannot be told apart.",
        "logs_truncated": "The access logs were truncated at ingest; counts are a lower bound.",
        "public_now": "The bucket is publicly exposed now (last check {when}).",
        "sse_new_only": "Only objects written after the change are encrypted; existing objects stay as they "
                        "are until rewritten. Reads are unaffected.",
        "sse_writers": "Writers that set their own encryption header keep doing so.",
        "lc_replace": "The bucket already has lifecycle rules (last check {when}): this command REPLACES them. "
                      "Merge the new rule into the existing configuration first.",
        "lc_none": "The bucket has no lifecycle rules (last check {when}); nothing is replaced.",
        "lc_unknown": "Cannot tell whether the bucket has lifecycle rules — the last check could not read them.",
        "mpu": "Multipart uploads left incomplete for more than 7 days are aborted; their parts stop being billed.",
        "noncurrent": "Noncurrent object versions older than 30 days are deleted permanently.",
        "versioning_off": "Versioning is not enabled (last check {when}), so there are no noncurrent versions today.",
        "versioning_on": "Versioning is {status} (last check {when}): older versions will start expiring.",
    },
    "zh": {
        "anon_seen": "附带的访问日志中，此存储桶的 {total} 个请求里有 {anon} 个是匿名请求（{first} – {last}）。"
                     "开启公共访问阻止会拒绝这类请求。",
        "anon_none": "附带的访问日志中，此存储桶的 {total} 个请求（{first} – {last}）没有匿名请求。",
        "anon_prefixes": "匿名请求主要访问：{prefixes}。",
        "no_logs": "无法判断谁在匿名读取此存储桶：尚未附加或导入它的 S3 服务器访问日志。可以让 Agent 导入访问日志，或手动附加。",
        "log_format": "此存储桶附带的访问日志不是 S3 服务器访问日志格式，无法区分匿名请求。",
        "logs_truncated": "访问日志在导入时被截断；计数为下限。",
        "public_now": "此存储桶当前处于公开暴露状态（上次检查 {when}）。",
        "sse_new_only": "只有变更后写入的对象会被加密；已有对象在重写前保持不变。读取不受影响。",
        "sse_writers": "自行设置加密请求头的写入方不受影响。",
        "lc_replace": "此存储桶已有生命周期规则（上次检查 {when}）：该命令会替换它们。请先把新规则合并进现有配置。",
        "lc_none": "此存储桶没有生命周期规则（上次检查 {when}）；不会替换任何内容。",
        "lc_unknown": "无法判断此存储桶是否已有生命周期规则——上次检查未能读取。",
        "mpu": "超过 7 天未完成的分段上传将被中止，其分段不再计费。",
        "noncurrent": "超过 30 天的非当前版本将被永久删除。",
        "versioning_off": "版本控制未开启（上次检查 {when}），目前没有非当前版本。",
        "versioning_on": "版本控制状态为 {status}（上次检查 {when}）：旧版本将开始过期。",
    },
}

# The first fields of an S3 server access log line: owner, bucket, [time], ip, requester.
_S3_LOG = r"^\S+ (\S+) \[[^\]]+\] \S+ (\S+) "
# ... then request id, operation, key: the key's first path segment is its prefix.
_S3_KEY = r"^\S+ \S+ \[[^\]]+\] \S+ \S+ \S+ \S+ ([^/\s]+/?)"
_MAX_DATASETS = 20


def _anonymous_requests(conn: sqlite3.Connection, provider_id: str, bucket: str) -> dict[str, Any]:
    """Aggregate anonymous-request counts for one bucket across its access logs."""
    from ..analysis import access_logs, duck
    from ..engines import datasets

    rows = conn.execute(
        "SELECT * FROM datasets WHERE dataset_type = 'access_log' AND status IN ('ready', 'analyzed') "
        "AND (bucket IS NULL OR (bucket = ? AND (provider_id IS NULL OR provider_id = ?))) "
        "ORDER BY created_at DESC LIMIT ?", (bucket, provider_id, _MAX_DATASETS)).fetchall()
    out: dict[str, Any] = {"datasets": 0, "total": 0, "anonymous": 0, "first": None, "last": None,
                           "prefixes": [], "other_format": False, "truncated": False}
    prefixes: dict[str, int] = {}
    table = access_logs.TABLE_NAME
    for r in rows:
        ds = datasets.get(conn, r["id"])
        if ds is None:
            continue
        try:
            ds = datasets.ensure_ingested(conn, ds)
            con = duck.connect(datasets.duckdb_path(ds), read_only=True)
        except Exception:  # noqa: BLE001 — an unreadable dataset is no evidence
            continue
        try:
            q = (f"SELECT count(*) FILTER (WHERE regexp_extract(raw_sanitized, '{_S3_LOG}', 1) = ?), "
                 f"count(*) FILTER (WHERE regexp_extract(raw_sanitized, '{_S3_LOG}', 1) = ? "
                 f"AND regexp_extract(raw_sanitized, '{_S3_LOG}', 2) = '-'), "
                 f"min(timestamp) FILTER (WHERE regexp_extract(raw_sanitized, '{_S3_LOG}', 1) = ?), "
                 f"max(timestamp) FILTER (WHERE regexp_extract(raw_sanitized, '{_S3_LOG}', 1) = ?), "
                 f"count(*) FILTER (WHERE regexp_extract(raw_sanitized, '{_S3_LOG}', 1) = '') FROM {table}")
            total, anon, first, last, unparsed = con.execute(q, [bucket] * 4).fetchone()
            if total:
                out["datasets"] += 1
                out["total"] += int(total)
                out["anonymous"] += int(anon or 0)
                out["first"] = min(filter(None, [out["first"], first])) if first else out["first"]
                out["last"] = max(filter(None, [out["last"], last])) if last else out["last"]
                out["truncated"] = out["truncated"] or bool((ds.get("detail") or {}).get("truncated"))
                if anon:
                    for prefix, n in con.execute(
                            f"SELECT regexp_extract(raw_sanitized, '{_S3_KEY}', 1) p, count(*) c FROM {table} WHERE regexp_extract(raw_sanitized, "
                            f"'{_S3_LOG}', 1) = ? AND regexp_extract(raw_sanitized, '{_S3_LOG}', 2) = '-' "
                            f"GROUP BY p ORDER BY c DESC LIMIT 3", [bucket]).fetchall():
                        prefixes[str(prefix)] = prefixes.get(str(prefix), 0) + int(n)
            elif unparsed and r["bucket"] == bucket:
                out["other_format"] = True  # a log for this bucket we cannot read requesters from
        except Exception:  # noqa: BLE001
            continue
        finally:
            con.close()
    out["prefixes"] = [redact_text(p)[:120] or "/" for p, _ in sorted(prefixes.items(), key=lambda x: -x[1])[:3]]
    return out


def _when(ts: Any) -> str:
    return str(ts or "")[:16].replace("T", " ") or "?"


def impact(conn: sqlite3.Connection, issue: dict[str, Any], lang: str = "en") -> dict[str, Any] | None:
    """What applying the fix would change, from the evidence the estate holds.

    ``verdict``: ``low`` (evidence says nothing depends on what changes),
    ``caution`` (evidence says something does, or the change is destructive),
    ``unknown`` (the evidence cannot answer). Each point names its evidence."""
    from . import rules
    t = _T["zh" if str(lang).startswith("zh") else "en"]
    fix = rules.generate_fix(issue["code"], issue["bucket"])
    if fix is None:
        return None
    row = conn.execute("SELECT posture, last_checked_at FROM estate_buckets WHERE provider_id = ? AND bucket = ?",
                       (issue["provider_id"], issue["bucket"])).fetchone()
    posture = json.loads(row["posture"]) if row and row["posture"] else {}
    checked = _when(row["last_checked_at"]) if row else "?"
    points: list[dict[str, Any]] = []
    gaps: list[str] = []
    verdict = "low"

    if fix["kind"] == "public_access_block":
        if posture.get("publicly_exposed"):
            points.append({"text": t["public_now"].format(when=checked), "evidence": "posture"})
        a = _anonymous_requests(conn, issue["provider_id"], issue["bucket"])
        if a["total"]:
            span = {"first": _when(a["first"]), "last": _when(a["last"])}
            if a["anonymous"]:
                verdict = "caution"
                points.append({"text": t["anon_seen"].format(anon=a["anonymous"], total=a["total"], **span),
                               "evidence": "access_log", "count": a["anonymous"], "total": a["total"]})
                if a["prefixes"]:
                    points.append({"text": t["anon_prefixes"].format(prefixes=", ".join(a["prefixes"])),
                                   "evidence": "access_log"})
            else:
                points.append({"text": t["anon_none"].format(total=a["total"], **span),
                               "evidence": "access_log", "count": 0, "total": a["total"]})
            if a["truncated"]:
                gaps.append(t["logs_truncated"])
        else:
            verdict = "unknown"
            gaps.append(t["log_format"] if a["other_format"] else t["no_logs"])
    elif fix["kind"] == "default_encryption":
        points.append({"text": t["sse_new_only"], "evidence": "rule"})
        points.append({"text": t["sse_writers"], "evidence": "rule"})
    elif fix["kind"] == "lifecycle":
        status = posture.get("lifecycle_status")
        if status == "not_configured":
            points.append({"text": t["lc_none"].format(when=checked), "evidence": "posture"})
        elif status == "available":
            verdict = "caution"
            points.append({"text": t["lc_replace"].format(when=checked), "evidence": "posture"})
        else:
            verdict = "unknown" if verdict == "low" else verdict
            gaps.append(t["lc_unknown"])
        if issue["code"] == "no_abort_mpu":
            points.append({"text": t["mpu"], "evidence": "rule"})
        else:
            verdict = "caution"
            points.append({"text": t["noncurrent"], "evidence": "rule"})
            v = posture.get("versioning_status")
            if v in ("Enabled", "Suspended", "available"):
                points.append({"text": t["versioning_on"].format(status=v, when=checked), "evidence": "posture"})
            elif v == "not_configured":
                points.append({"text": t["versioning_off"].format(when=checked), "evidence": "posture"})
    return {"verdict": verdict, "points": points, "gaps": gaps}
