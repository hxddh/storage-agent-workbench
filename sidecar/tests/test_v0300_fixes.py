"""Tests for the v0.30.0 correctness + truth batch.

F1 — publicly_exposed: a single TRUE signal (policy public with ACL unreadable,
     or ACL public with policy_status provider-unsupported) proves exposure.
F2 — truncated-PEM redaction no longer bypassed by a following foreign END armor.
F3 — 5xx code entries no longer duplicated by the generic ServerError entry.
F4 — survey diff: fields only the NEW survey has are baselined (not changes);
     a real became-public flip carries alert=true and sorts first.
F5 — user-chosen filenames are redacted at persist.
T2 — engine truth guards: unparsed log / unknown-size inventory lead with an
     honest warning instead of clean-looking metrics.
Survey — conditional ACL read (skipped under BucketOwnerEnforced), acl_public
     flag, evidence discovery reuses the snapshot's reads (GET dedupe), summary
     carries public counts + a critical finding.
C-1 — turn_guard.register_session_turn serializes turns per session.
"""
import sqlite3
from typing import Any

from botocore.exceptions import ClientError

from app import config

ALL_USERS = "http://acs.amazonaws.com/groups/global/AllUsers"


def _err(code: str, http: int = 400) -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": code}, "ResponseMetadata": {"HTTPStatusCode": http}},
        "Get")


class FakeS3:
    def __init__(self, behaviors: dict[str, Any]):
        self.behaviors = behaviors
        self.calls: list[str] = []

    def __getattr__(self, method):
        def _call(**kwargs):
            self.calls.append(method)
            beh = self.behaviors.get(method)
            if isinstance(beh, ClientError):
                raise beh
            if beh is None:
                raise _err("NotImplemented", 501)
            return beh
        return _call


def _db():
    c = sqlite3.connect(str(config.db_path()))
    c.row_factory = sqlite3.Row
    return c


def _provider(client):
    return client.post("/providers/clouds", json={
        "name": "demo", "provider_type": "s3-compatible",
        "endpoint_url": "https://minio.example.com", "region": "us-east-1",
        "addressing_style": "path", "access_key": "AKIAEXAMPLE", "secret_key": "shhh"}).json()["id"]


# ============================ F1: publicly_exposed ==========================






# ============================ F2: PEM bypass ================================


def test_truncated_pem_followed_by_cert_is_redacted():
    from app.security.redaction import redact_text
    t = ("-----BEGIN RSA PRIVATE KEY-----\nMIIEowSECRETBODY\n"
         "-----BEGIN CERTIFICATE-----\ncertdata\n-----END CERTIFICATE-----")
    out = redact_text(t)
    assert "SECRETBODY" not in out          # the bypass shape is closed
    assert "certdata" in out                # the non-secret cert survives
    full = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY----- tail"
    o2 = redact_text(full)
    assert "abc" not in o2 and "tail" in o2  # full-block behavior unchanged


# ============================ F3: 5xx dedup =================================


def test_5xx_code_entry_not_duplicated_by_generic_entry():
    from app.error_triage import parser, playbooks
    p = parser.parse("HTTP/1.1 500 <Code>InternalError</Code>")
    m = playbooks.match(p)
    titles = [e["title"] for e in m]
    assert len([t for t in titles if "5xx" in t or "InternalError" in t]) == 1


# ============================ F4: diff baseline + alert =====================




# ============================ F5: filename redaction ========================




# ============================ T2: truth guards ==============================


def test_unparsed_log_leads_with_honest_warning(tmp_path):
    from app.analysis import access_logs
    src = tmp_path / "app.log"
    src.write_text("random unstructured line without any request shape\n" * 20)
    ddb = tmp_path / "a.duckdb"
    access_logs.import_access_logs(src, ddb, "unknown")
    m = access_logs.analyze_access_logs(ddb)
    assert m["parsed_fraction"] == 0.0
    f = access_logs.derive_findings(m)
    assert [x["title"] for x in f] == ["Log mostly unparsed"]  # no fake hot-key/clean claims


def test_inventory_unknown_sizes_lead_with_warning(tmp_path):
    from app.analysis import inventory
    src = tmp_path / "inv.csv"
    # header with keys but no size column values
    src.write_text("bucket,key,size,last_modified,storage_class\n"
                   + "\n".join(f"b,k{i},,2026-01-01T00:00:00Z,STANDARD" for i in range(10)) + "\n")
    ddb = tmp_path / "i.duckdb"
    inventory.import_inventory_file(src, ddb)
    m = inventory.analyze_inventory(ddb)
    assert m["unknown_size_ratio"] > 0.5
    titles = [x["title"] for x in inventory.derive_findings(m)]
    assert "Inventory mostly missing sizes" in titles
    assert "No capacity concerns detected" not in titles


# ============================ Survey: ACL + dedupe + summary ================








# ============================ C-1: session serialization ====================


