"""Tests for the v0.28.0 feature/hardening batch.

A1/A2 — authoritative public-posture visibility:
  - get_bucket_config_detail exposes policy_status (IsPublic), ownership
    (ObjectOwnership / ACLs-disabled), object_lock (bucket WORM default), and acl
    (grantee KIND + permission, no owner id/email).
  - review_bucket_security folds in the authoritative IsPublic verdict + Object
    Ownership.

B1 — model-budget de-ossification:
  - an operator-declared context_window overrides the substring table.
  - completion budget is clamped to the model's real provider max-output (closes
    the latent 400 on gpt-4-turbo / gemini), while unknown models keep the floor.

B2 — elastic thread-replay caps scale with the window, floored + capped.

CF — a configured-but-unresolvable credential raises instead of silently going
     anonymous.

CSV — a TSV whose header cell contains a comma still parses via tab (no regression
      from the v0.27.0 early-break).
"""
import sqlite3
from typing import Any

import pytest
from botocore.exceptions import ClientError

from app import config
from app.s3 import client_factory
from app.s3 import config_tools as ct

ALL_USERS = "http://acs.amazonaws.com/groups/global/AllUsers"
LOG_DELIVERY = "http://acs.amazonaws.com/groups/s3/LogDelivery"


def _err(code: str, http: int = 400) -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": code}, "ResponseMetadata": {"HTTPStatusCode": http}},
        "Get")


class FakeS3:
    def __init__(self, behaviors: dict[str, Any]):
        self.behaviors = behaviors
        self.calls: list[tuple[str, dict]] = []

    def __getattr__(self, method):
        def _call(**kwargs):
            self.calls.append((method, kwargs))
            beh = self.behaviors.get(method)
            if isinstance(beh, ClientError):
                raise beh
            if beh is None:
                raise _err("NotImplemented", 501)
            return beh
        return _call


def _provider(client):
    return client.post("/providers/clouds", json={
        "name": "demo", "provider_type": "s3-compatible",
        "endpoint_url": "https://minio.example.com", "region": "us-east-1",
        "addressing_style": "path", "access_key": "AKIAEXAMPLE", "secret_key": "shhh"}).json()["id"]


def _conn():
    c = sqlite3.connect(str(config.db_path()))
    c.row_factory = sqlite3.Row
    return c


# ==================== A1/A2: config detail aspects ==========================


def test_new_detail_aspects_registered():
    for aspect in ("policy_status", "ownership", "object_lock", "acl"):
        assert aspect in ct._DETAIL_ASPECTS
        assert aspect in ct._DETAIL_EXTRACTORS












# ======================= B1: model_budget ==================================






# ======================= B2: elastic replay caps ===========================




# ============================ CF: credential clarity =======================






# ============================ CSV: delimiter order =========================


def test_tsv_with_comma_in_header_cell_parses_via_tab(tmp_path):
    from app.analysis import access_logs
    # A tab-delimited log whose FIRST header cell contains a comma. The v0.27.0
    # early-break used to lock onto comma → all request fields null. Now tab wins.
    src = tmp_path / "log.tsv"
    src.write_text("ts,extra\tmethod\tpath\tstatus\tbytes\n"
                   "2026-07-15T10:00:00Z,x\tGET\t/a\t200\t10\n")
    rows = access_logs._parse_csv(src)
    assert len(rows) == 1
    assert rows[0]["method"] == "GET"
    assert rows[0]["status_code"] == 200
    assert rows[0]["path"] == "/a"
