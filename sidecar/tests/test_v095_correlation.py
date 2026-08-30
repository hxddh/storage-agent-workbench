"""v0.95 — deterministic cross-evidence correlation.

Pure snapshot tests: bounded aggregates in, findings out. No DuckDB, no model,
no raw rows.
"""

from app.analysis.correlation import collect_snapshot, correlate_snapshot


def test_403s_with_failed_credentials_correlate():
    snap = collect_snapshot([
        ("analyze_uploaded_file", {
            "type": "access_log",
            "metrics": {"error_rate_4xx": 0.4, "share_403": 0.35, "share_404": 0.01,
                        "error_rate_5xx": 0.0, "total_requests": 1000},
        }),
        ("test_credentials", {"success": False, "error_code": "InvalidAccessKeyId"}),
        ("head_bucket", {"success": False, "status_code": 403}),
    ])
    titles = [f["title"] for f in correlate_snapshot(snap)]
    assert any("credential/addressing" in t for t in titles)
    for f in correlate_snapshot(snap):
        assert "evidence" in f
        assert f["kind"] == "inference"


def test_aged_inventory_without_lifecycle_correlates():
    snap = collect_snapshot([
        ("analyze_inventory", {
            "object_count": 100,
            "object_age_distribution": [{"bucket": "365d+", "count": 40},
                                        {"bucket": "30d", "count": 60}],
            "storage_class_distribution": [{"value": "STANDARD", "count": 100}],
        }),
        ("review_bucket_lifecycle", {
            "facts": {"lifecycle_status": "not_configured", "has_expiration": False,
                      "has_transition": False, "has_abort_mpu": False},
            "findings": [{"title": "No lifecycle configuration"}],
        }),
    ])
    titles = [f["title"] for f in correlate_snapshot(snap)]
    assert any("Aged inventory" in t for t in titles)


def test_multipart_without_abort_rule_correlates():
    snap = collect_snapshot([
        ("list_multipart_uploads", {"upload_count": 12, "uploads": [{}] * 12}),
        ("review_bucket_lifecycle", {
            "facts": {"lifecycle_status": "available", "has_abort_mpu": False,
                      "has_expiration": True, "has_transition": False},
            "findings": [{"title": "No AbortIncompleteMultipartUpload rule"}],
        }),
    ])
    titles = [f["title"] for f in correlate_snapshot(snap)]
    assert any("multipart" in t.lower() for t in titles)


def test_write_heavy_latency_tail_correlates():
    snap = collect_snapshot([
        ("analyze_access_logs", {
            "total_requests": 200,
            "error_rate_4xx": 0.01, "error_rate_5xx": 0.0,
            "share_403": 0.0, "share_404": 0.0, "range_share_206": 0.0,
            "method_distribution": [{"value": "PUT", "count": 80},
                                    {"value": "GET", "count": 120}],
            "latency": {"measured_requests": 200, "p50_ms": 40, "p95_ms": 900},
        }),
    ])
    titles = [f["title"] for f in correlate_snapshot(snap)]
    assert any("Write-heavy" in t for t in titles)


def test_no_silent_finding_on_empty_snapshot():
    assert correlate_snapshot(collect_snapshot([])) == []
