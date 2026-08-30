"""Deterministic storage-class / lifecycle cost simulator.

Pure functions over already-bounded inventory aggregates, current lifecycle
facts, and a local price table. No model, no DuckDB, no raw object rows.

Outputs always carry coverage (how many objects/bytes, snapshot time) and
uncertainty. Missing inventory or an unconfirmed price table is an explicit
gap — never a fabricated dollar figure or trend.
"""

from __future__ import annotations

from typing import Any

from ..security.redaction import redact_text

_HORIZON_DAYS = (0, 30, 90, 180, 365)
_GIB = 1000 ** 3  # billed GB ≈ 10^9; labelled as an estimate

# Mid-points for the inventory age buckets. ``unknown`` does not age.
_AGE_MIDPOINT_DAYS = {
    "0-7d": 4,
    "8-30d": 19,
    "31-90d": 60,
    "91-180d": 135,
    "181-365d": 273,
    "365d+": 420,
}

_STANDARD_ALIASES = {
    "": "STANDARD",
    "none": "STANDARD",
    "null": "STANDARD",
    "standard": "STANDARD",
}


def _clip(value: Any, n: int = 200) -> str:
    return redact_text(str(value or ""))[:n]


def _gap(code: str, message: str) -> dict[str, str]:
    return {"kind": "gap", "code": code, "message": _clip(message, 400)}


def _norm_class(value: Any) -> str:
    raw = str(value or "").strip()
    key = raw.lower()
    if key in _STANDARD_ALIASES:
        return _STANDARD_ALIASES[key]
    return raw.upper().replace("-", "_") or "STANDARD"


def _num(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def coverage_from_inventory(inventory: dict[str, Any] | None,
                            *, as_of: str | None = None) -> dict[str, Any]:
    inv = inventory or {}
    count = int(_num(inv.get("object_count")))
    total = int(_num(inv.get("total_size")))
    return {
        "object_count": count,
        "bytes": total,
        "inventory_as_of": as_of or inv.get("as_of") or inv.get("captured_at"),
        "unknown_age_ratio": _num(inv.get("unknown_age_ratio")),
        "unknown_size_ratio": _num(inv.get("unknown_size_ratio")),
        "class_bytes_estimated": False,
        "age_class_independence": True,
        "note": ("Class×age joint is not observed; bytes are split by age-count "
                 "share. This is an estimate, not a bill."),
    }


def _class_bytes(inventory: dict[str, Any]) -> tuple[dict[str, int], bool]:
    """Bytes per storage class. Prefer explicit ``size``; else allocate total
    size by object-count share and mark the allocation as estimated."""
    dist = inventory.get("storage_class_distribution") or []
    total = int(_num(inventory.get("total_size")))
    counted = int(_num(inventory.get("object_count"))) or 1
    out: dict[str, int] = {}
    estimated = False
    has_size = any(isinstance(row, dict) and "size" in row for row in dist)
    for row in dist:
        if not isinstance(row, dict):
            continue
        klass = _norm_class(row.get("value"))
        count = int(_num(row.get("count")))
        if has_size:
            size = int(_num(row.get("size")))
        else:
            size = int(total * (count / counted)) if counted else 0
            estimated = True
        out[klass] = out.get(klass, 0) + max(0, size)
    if not out and total:
        out["STANDARD"] = total
        estimated = True
    return out, estimated


def _age_shares(inventory: dict[str, Any]) -> dict[str, float]:
    dist = inventory.get("object_age_distribution") or []
    counts: dict[str, int] = {}
    for row in dist:
        if not isinstance(row, dict):
            continue
        bucket = str(row.get("bucket") or "unknown")
        counts[bucket] = counts.get(bucket, 0) + int(_num(row.get("count")))
    total = sum(counts.values()) or 1
    return {k: v / total for k, v in counts.items()}


def _pools(inventory: dict[str, Any]) -> tuple[list[dict[str, Any]], bool]:
    class_bytes, estimated = _class_bytes(inventory)
    shares = _age_shares(inventory)
    if not shares:
        shares = {"unknown": 1.0}
    pools: list[dict[str, Any]] = []
    for klass, nbytes in class_bytes.items():
        for bucket, share in shares.items():
            size = int(nbytes * share)
            if size <= 0:
                continue
            pools.append({
                "storage_class": klass,
                "age_bucket": bucket,
                "age_days": _AGE_MIDPOINT_DAYS.get(bucket),
                "bytes": size,
            })
    return pools, estimated


def _normalize_candidates(raw: Any) -> list[dict[str, Any]]:
    if not raw:
        return []
    if isinstance(raw, dict):
        raw = raw.get("rules") or raw.get("candidates") or [raw]
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or item.get("type") or "").lower()
        if kind not in ("transition", "expiration", "abort_mpu"):
            if item.get("storage_class") and item.get("days"):
                kind = "transition"
            else:
                continue
        after = int(_num(item.get("after_days") or item.get("days") or item.get("Days")))
        out.append({
            "id": _clip(item.get("id") or f"{kind}-{after}", 80),
            "kind": kind,
            "from_class": _norm_class(item.get("from_class") or item.get("source") or "STANDARD"),
            "to_class": _norm_class(item.get("to_class") or item.get("storage_class") or ""),
            "after_days": max(0, after),
            "prefix": _clip(item.get("prefix") or "", 200),
        })
    return out[:20]


def _apply_rules(pools: list[dict[str, Any]], rules: list[dict[str, Any]],
                 extra_days: int) -> list[dict[str, Any]]:
    """Project pools ``extra_days`` into the future under ``rules``."""
    next_pools: list[dict[str, Any]] = []
    for pool in pools:
        age = pool["age_days"]
        nbytes = int(pool["bytes"])
        klass = pool["storage_class"]
        if age is None:
            next_pools.append({**pool, "bytes": nbytes})
            continue
        effective = int(age) + extra_days
        expired = False
        for rule in rules:
            if rule["kind"] == "expiration" and effective >= rule["after_days"]:
                if rule["from_class"] in ("STANDARD", klass, ""):
                    expired = True
                    break
            if (rule["kind"] == "transition"
                    and effective >= rule["after_days"]
                    and klass == rule["from_class"]
                    and rule["to_class"]):
                klass = rule["to_class"]
        if expired or nbytes <= 0:
            continue
        next_pools.append({
            "storage_class": klass,
            "age_bucket": pool["age_bucket"],
            "age_days": effective,
            "bytes": nbytes,
        })
    return next_pools


def _sum_by_class(pools: list[dict[str, Any]]) -> dict[str, int]:
    out: dict[str, int] = {}
    for pool in pools:
        klass = pool["storage_class"]
        out[klass] = out.get(klass, 0) + int(pool["bytes"])
    return out


def _monthly_cost(class_bytes: dict[str, int], rates: dict[str, Any]) -> dict[str, Any]:
    storage_rates = rates.get("storage_gb_month") or {}
    if not isinstance(storage_rates, dict) or not storage_rates:
        return {"kind": "gap", "code": "price_unconfirmed",
                "message": "No storage-class monthly rates in the price table."}
    usd = 0.0
    missing: list[str] = []
    for klass, nbytes in class_bytes.items():
        rate = storage_rates.get(klass)
        if rate is None:
            rate = storage_rates.get("STANDARD")
            missing.append(klass)
        usd += (nbytes / _GIB) * _num(rate)
    return {
        "usd_per_month": round(usd, 4),
        "currency": "USD",
        "estimate": True,
        "missing_class_rates": sorted(set(missing))[:12],
        "gb_divisor": _GIB,
    }


def current_rules_from_lifecycle(lifecycle: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Best-effort projection of already-applied lifecycle facts.

    The review tools expose booleans, not the full rule JSON. When the JSON is
    absent we cannot invent days-to-transition — that is a coverage gap, not a
    hidden default of 30/90/365.
    """
    facts = (lifecycle or {}).get("facts") if isinstance(lifecycle, dict) else {}
    facts = facts or lifecycle or {}
    rules_raw = (lifecycle or {}).get("rules") if isinstance(lifecycle, dict) else None
    if rules_raw:
        return _normalize_candidates(rules_raw)
    # Facts-only: we know WHETHER transitions exist, not WHEN. Simulator treats
    # current policy as "no timed movement we can prove".
    _ = facts
    return []


def simulate(*,
             inventory: dict[str, Any] | None,
             lifecycle: dict[str, Any] | None = None,
             candidates: Any = None,
             price_table: dict[str, Any] | None = None,
             inventory_as_of: str | None = None) -> dict[str, Any]:
    """Project storage-class mix and monthly cost under candidate rules.

    Returns ``kind="simulation"`` with coverage, or ``kind="gap"`` when the
    inputs cannot support a number.
    """
    gaps: list[dict[str, str]] = []
    inv = inventory if isinstance(inventory, dict) else None
    if not inv or int(_num((inv or {}).get("object_count"))) <= 0:
        return {
            "kind": "gap",
            "gaps": [_gap("no_inventory",
                          "No bounded inventory aggregate is attached to this Task. "
                          "Import or upload inventory before simulating cost.")],
            "coverage": coverage_from_inventory(inv, as_of=inventory_as_of),
            "timeline": [],
            "monthly_cost": None,
            "monthly_cost_delta": None,
        }

    prices = price_table if isinstance(price_table, dict) else {}
    confirmed = bool(prices.get("confirmed"))
    if not prices or not confirmed:
        gaps.append(_gap(
            "price_unconfirmed",
            "The local price table is still the example schedule and has not "
            "been confirmed against your bill. Class mix is projected; dollar "
            "figures are withheld rather than invented.",
        ))

    pools, estimated = _pools(inv)
    coverage = coverage_from_inventory(inv, as_of=inventory_as_of)
    coverage["class_bytes_estimated"] = estimated
    baseline_rules = current_rules_from_lifecycle(lifecycle)
    candidate_rules = _normalize_candidates(candidates)
    if not candidate_rules:
        candidate_rules = list(baseline_rules)

    timeline: list[dict[str, Any]] = []
    cost_now = None
    cost_end = None
    base_end = None
    for day in _HORIZON_DAYS:
        baseline_pools = _apply_rules(pools, baseline_rules, day)
        candidate_pools = _apply_rules(pools, candidate_rules, day)
        baseline_mix = _sum_by_class(baseline_pools)
        candidate_mix = _sum_by_class(candidate_pools)
        point: dict[str, Any] = {
            "day": day,
            "baseline_class_bytes": baseline_mix,
            "candidate_class_bytes": candidate_mix,
            "baseline_bytes": sum(baseline_mix.values()),
            "candidate_bytes": sum(candidate_mix.values()),
        }
        if confirmed:
            point["baseline_monthly_cost"] = _monthly_cost(baseline_mix, prices)
            point["candidate_monthly_cost"] = _monthly_cost(candidate_mix, prices)
        else:
            point["baseline_monthly_cost"] = None
            point["candidate_monthly_cost"] = None
        timeline.append(point)
        if day == 0 and confirmed:
            cost_now = point["candidate_monthly_cost"]
        if day == 365 and confirmed:
            cost_end = point["candidate_monthly_cost"]
            base_end = point["baseline_monthly_cost"]

    delta = None
    if confirmed and isinstance(cost_end, dict) and isinstance(base_end, dict):
        if "usd_per_month" in cost_end and "usd_per_month" in base_end:
            delta = {
                "usd_per_month_at_365d": round(
                    cost_end["usd_per_month"] - base_end["usd_per_month"], 4),
                "estimate": True,
                "horizon_days": 365,
            }

    abort = [r for r in candidate_rules if r["kind"] == "abort_mpu"]
    if abort:
        gaps.append(_gap(
            "abort_mpu_no_inventory",
            "Abort-incomplete-MPU rules are recorded in the plan but inventory "
            "aggregates do not include multipart bytes, so no MPU savings number "
            "is produced.",
        ))

    return {
        "kind": "simulation",
        "estimate": True,
        "gaps": gaps,
        "coverage": coverage,
        "candidates": candidate_rules,
        "baseline_rules": baseline_rules,
        "timeline": timeline,
        "monthly_cost": cost_now if confirmed else None,
        "monthly_cost_delta": delta,
        "uncertainty": [
            "Class×age joint distribution is assumed independent.",
            "Age buckets use mid-points, not per-object ages.",
            "Dollar figures use the local price table, not a live bill.",
        ],
    }
