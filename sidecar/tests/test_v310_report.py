"""v3.1.0 — the Task report leads with the recorded conclusion.

The report is the artifact that leaves the app. Since v2.0 the model records
each turn's conclusion (answer · findings · next steps); the report ignored it
and printed counts and em dashes instead. It now opens on that conclusion,
keeps one findings list (conclusion + investigation, deduplicated, most severe
first), carries the Agent's next steps, speaks the reader's language, and
writes no section that has nothing behind it.
"""

from __future__ import annotations

import sqlite3

from app.migrations import apply_migrations
from app.repositories import sessions as repo
from app.sessions import session_report


def _db(goal: str | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    apply_migrations(conn)
    conn.execute(
        "INSERT INTO sessions (id, title, goal, status, created_at, updated_at) "
        "VALUES ('s1', 'acme-logs 403', ?, 'active', 'x', 'x')", (goal,))
    return conn


CONCLUSION = {
    "answer": "acme-logs denies list because its bucket policy omits s3:ListBucket.",
    "findings": [
        {"title": "Versioning is off", "severity": "low"},
        {"title": "Bucket policy omits s3:ListBucket", "severity": "high",
         "detail": "Every list call returns 403 AccessDenied."},
    ],
    "next_steps": ["Draft a policy fix for acme-logs"],
}


def _render(conn, lang: str | None = None) -> str:
    return session_report.render_session_report(
        dict(conn.execute("SELECT * FROM sessions WHERE id='s1'").fetchone()),
        {}, [],
        agent_memory=repo.list_agent_memory(conn, "s1"),
        messages=repo.list_messages(conn, "s1"),
        lang=lang,
    )


def _seed(conn) -> None:
    repo.add_message(conn, "s1", "user", "Why does acme-logs return 403 on list?")
    repo.add_message(conn, "s1", "assistant", "Full answer in Markdown.",
                     grounding={"evidence_used": ["get_bucket_policy returned 200"],
                                "evidence_gaps": ["IAM identity policy not readable"]},
                     conclusion=CONCLUSION)
    conn.commit()


def test_the_report_opens_on_the_recorded_conclusion():
    conn = _db()
    _seed(conn)
    md = _render(conn)
    headings = [ln for ln in md.splitlines() if ln.startswith("## ")]
    assert headings[:2] == ["## Goal", "## Conclusion"]
    assert CONCLUSION["answer"] in md.split("## Conclusion")[1].split("## ")[0]


def test_the_goal_falls_back_to_the_first_direction():
    conn = _db(goal=None)
    _seed(conn)
    md = _render(conn)
    assert md.split("## Goal")[1].split("## ")[0].strip() == "Why does acme-logs return 403 on list?"


def test_findings_are_one_list_most_severe_first_and_deduplicated():
    conn = _db()
    _seed(conn)
    # The Agent also recorded the same finding in memory mid-investigation.
    repo.add_agent_memory(conn, "s1", kind="finding", text="Bucket policy omits s3:ListBucket",
                          severity="high")
    conn.commit()
    body = _render(conn).split("## Findings")[1].split("## ")[0]
    bullets = [ln for ln in body.splitlines() if ln.startswith("- ")]
    assert len(bullets) == 2, bullets
    assert bullets[0].startswith("- **High** — Bucket policy omits s3:ListBucket")
    assert "403 AccessDenied" in bullets[0]
    assert bullets[1].startswith("- **Low** — Versioning is off")


def test_next_steps_and_gaps_come_from_the_record():
    conn = _db()
    _seed(conn)
    md = _render(conn)
    assert "- Draft a policy fix for acme-logs" in md.split("## Next steps")[1]
    coverage = md.split("## Coverage and gaps")[1].split("## ")[0]
    assert "get_bucket_policy returned 200" in coverage
    assert "IAM identity policy not readable" in coverage


def test_no_section_is_written_without_something_behind_it():
    conn = _db()
    _seed(conn)
    md = _render(conn)
    for empty in ("## Tools run", "## Analyses", "## Attached evidence", "## Error triage",
                  "## Rule-derived suggestions", "## Audit trail"):
        assert empty not in md
    assert "—\n" not in md


def test_the_report_speaks_chinese_when_asked():
    conn = _db()
    _seed(conn)
    md = _render(conn, lang="zh-CN")
    assert md.startswith("# 任务报告：acme-logs 403")
    for heading in ("## 目标", "## 结论", "## 发现", "## 下一步", "## 调查过程", "## 覆盖与缺口", "## 安全"):
        assert heading in md, heading
    assert "- **高** — Bucket policy omits s3:ListBucket" in md
    # The Agent's own words are reproduced as recorded, never translated.
    assert CONCLUSION["answer"] in md


def test_the_route_takes_the_reader_language(client):
    sid = client.post("/sessions", json={"title": "r"}).json()["id"]
    zh = client.get(f"/sessions/{sid}/report", params={"lang": "zh"}).json()
    en = client.get(f"/sessions/{sid}/report").json()
    assert zh["content"].startswith("# 任务报告：")
    assert en["content"].startswith("# Task report: ")
