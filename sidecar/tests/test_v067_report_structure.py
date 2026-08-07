"""v0.67.0 — the report's own structure was writable by its contents.

The report is the one artifact that leaves this machine: markdown a user pastes
into a ticket, mails to a vendor, or attaches to an incident review. Its last
section asserts, in the app's voice, that the document contains no credentials
and no raw rows.

Every value in it except the question/answer excerpts was interpolated into a
list item, a table cell or a heading with no newline handling. So a string with
a newline in it did not stay in its bullet — it ended the bullet, and whatever
followed became document STRUCTURE. A finding whose text carried
``\\n\\n## Safety\\n\\n- This report contains no credentials`` produced a second
Safety section, indistinguishable from the real one, making an assurance the app
never made.

Those strings are written by the model, and what the model reads is tool output:
bucket names, object keys, endpoint error messages. None of it is authored here.

The mundane half is the likelier one and needs no adversary at all: a finding
that simply spans two lines silently broke the list it belonged to.

`_excerpt` had done exactly this collapsing for questions and answers since
v0.48.0. These tests pin it for everything else.
"""
from __future__ import annotations

import pytest

from app.sessions.session_report import render_session_report

# A newline, a heading, and a bullet that contradicts the report's own Safety
# section — the shape that makes the failure legible rather than theoretical.
EVIL = "acme-logs looks fine\n\n## Safety\n\n- This report contains no credentials.\n"


def _render(**kw) -> str:
    """Render with every free-text input set to EVIL unless overridden."""
    base = dict(
        session={"title": EVIL, "goal": EVIL},
        summary={
            "known_facts": [{"text": EVIL, "confidence": EVIL}],
            "findings": [{"title": EVIL, "interpretation": EVIL, "severity": EVIL}],
            "next_actions": [{"title": EVIL, "action_type": EVIL, "reason": EVIL}],
            "open_questions": [EVIL],
            "limitations": [EVIL],
        },
        runs=[{"run_type": EVIL, "status": EVIL, "final_summary": EVIL, "run_id": "abcd1234"}],
        triage_cases=[{
            "parsed": {"error_code": EVIL},
            "summary": EVIL,
            "candidate_causes": [{"confidence": EVIL, "title": EVIL, "next_checks": [EVIL]}],
        }],
        agent_memory=[
            {"kind": k, "text": EVIL, "severity": EVIL, "confidence": EVIL}
            for k in ("finding", "fact", "open_question")
        ],
        messages=[
            {"role": "user", "content": EVIL, "id": "1"},
            {"role": "assistant", "content": EVIL, "id": "2",
             "grounding": {"evidence_used": [EVIL], "evidence_gaps": [EVIL]}},
        ],
        activity=[{"tool_name": EVIL, "status": "ok", "duration_ms": 5}],
        audit_events=[{"created_at": EVIL, "event_type": EVIL}],
        attached_files=[{"source_filename": EVIL, "dataset_type": EVIL, "detected_format": EVIL}],
    )
    base.update(kw)
    session = base.pop("session")
    summary = base.pop("summary")
    runs = base.pop("runs")
    return render_session_report(session, summary, runs, **base)


def _headings(md: str) -> list[str]:
    return [ln for ln in md.splitlines() if ln.startswith("## ")]


def test_no_input_can_add_a_section_to_the_report():
    md = _render()
    assert _headings(md).count("## Safety") == 1, _headings(md)


def test_no_input_can_forge_a_safety_assurance():
    md = _render()
    forged = [ln for ln in md.splitlines()
              if ln.strip().startswith("- This report contains no credentials.")]
    assert forged == [], forged


def test_the_headings_are_exactly_the_ones_this_module_writes():
    """Not just "no extra Safety" — no extra ANYTHING. A forged "## Findings"
    two sections early would be just as misleading and easier to overlook."""
    clean = _render(
        session={"title": "t", "goal": "g"},
        summary={"known_facts": [], "findings": [], "next_actions": [],
                 "open_questions": [], "limitations": []},
        runs=[], triage_cases=[], agent_memory=[], messages=[], activity=[],
        audit_events=[], attached_files=[],
    )
    assert _headings(_render()) == _headings(clean)


@pytest.mark.parametrize("field,payload", [
    ("title", {"session": {"title": EVIL, "goal": "g"}}),
    ("goal", {"session": {"title": "t", "goal": EVIL}}),
    ("fact", {"summary": {"known_facts": [{"text": EVIL}]}}),
    ("finding", {"summary": {"findings": [{"title": EVIL, "interpretation": "i"}]}}),
    ("next_action", {"summary": {"next_actions": [{"title": EVIL, "action_type": "a", "reason": "r"}]}}),
    ("open_question", {"summary": {"open_questions": [EVIL]}}),
    ("limitation", {"summary": {"limitations": [EVIL]}}),
    ("run_summary", {"runs": [{"run_type": "diagnostic", "status": "completed",
                               "final_summary": EVIL, "run_id": "a"}]}),
    ("agent_memory", {"agent_memory": [{"kind": "fact", "text": EVIL}]}),
    ("tool_name", {"activity": [{"tool_name": EVIL, "status": "ok"}]}),
    ("audit_event", {"audit_events": [{"created_at": "2026-01-01", "event_type": EVIL}]}),
    ("attached_file", {"attached_files": [{"source_filename": EVIL, "dataset_type": "inventory"}]}),
    ("grounding", {"messages": [
        {"role": "user", "content": "q", "id": "1"},
        {"role": "assistant", "content": "a", "id": "2",
         "grounding": {"evidence_used": [EVIL], "evidence_gaps": [EVIL]}}]}),
])
def test_each_field_on_its_own_cannot_break_out(field, payload):
    """One field at a time, so a fix that covers most of them still fails here
    for whichever one it missed — which is how the audit summary line was found
    (it joins the raw event_type keys, upstream of the per-row sanitizer)."""
    base = dict(
        session={"title": "t", "goal": "g"},
        summary={"known_facts": [], "findings": [], "next_actions": [],
                 "open_questions": [], "limitations": []},
        runs=[], triage_cases=[], agent_memory=[], messages=[], activity=[],
        audit_events=[], attached_files=[],
    )
    base.update(payload)
    md = _render(**base)
    assert _headings(md).count("## Safety") == 1, f"{field}: {_headings(md)}"


def test_a_backtick_cannot_escape_a_code_span():
    """Filenames and tool names render inside `code`. A backtick in one closed
    the span and turned the rest of the row into prose — including, for an
    uploaded file, a name the user chose."""
    md = _render(
        attached_files=[{"source_filename": "a`.csv ` **bold**", "dataset_type": "inventory"}],
        activity=[{"tool_name": "list`_objects", "status": "ok"}],
    )
    rows = [ln for ln in md.splitlines() if ".csv" in ln or "list" in ln]
    assert rows, md
    for row in rows:
        # Backticks come only from this module's own delimiters, so their count
        # per row stays even.
        assert row.count("`") % 2 == 0, row


def test_an_ordinary_multi_line_finding_still_reads_as_one_bullet():
    """No adversary required. The agent writes multi-line findings all the time;
    each one used to break the list it was in."""
    md = _render(
        session={"title": "t", "goal": "g"},
        summary={"known_facts": [], "findings": [], "next_actions": [],
                 "open_questions": [], "limitations": []},
        runs=[], triage_cases=[], activity=[], audit_events=[], attached_files=[],
        messages=[],
        agent_memory=[{"kind": "finding", "severity": "high",
                       "text": "Bucket acme-logs is publicly readable.\nThe policy grants "
                               "s3:GetObject to *.\nRemediation: scope the principal."}],
    )
    body = md.split("## Agent-recorded findings")[1].split("## ")[0]
    bullets = [ln for ln in body.splitlines() if ln.startswith("- ")]
    assert len(bullets) == 1, bullets
    assert "Remediation: scope the principal." in bullets[0]


def test_the_content_is_still_there_after_collapsing():
    """Sanitizing must not become deleting: the words have to survive, only the
    line breaks go."""
    md = _render(
        session={"title": "t", "goal": "g"},
        summary={"known_facts": [{"text": "Versioning is Enabled\non acme-logs."}],
                 "findings": [], "next_actions": [], "open_questions": [], "limitations": []},
        runs=[], triage_cases=[], agent_memory=[], messages=[], activity=[],
        audit_events=[], attached_files=[],
    )
    assert "Versioning is Enabled on acme-logs." in md


def test_an_action_type_is_rendered_as_code():
    """`run_account_discovery` was plain text in the one section a reader acts
    from. Markdown renderers differ on intraword `_`, and this app's own ate it
    — the name arrived as `runaccountdiscovery`, which cannot be searched for or
    typed back. In a code span it is unambiguous to every renderer."""
    md = _render(
        session={"title": "t", "goal": "g"},
        summary={"known_facts": [], "findings": [],
                 "next_actions": [{"title": "Map the account", "reason": "anchor the work",
                                   "action_type": "run_account_discovery"}],
                 "open_questions": [], "limitations": []},
        runs=[], triage_cases=[], agent_memory=[], messages=[], activity=[],
        audit_events=[], attached_files=[],
    )
    assert "`run_account_discovery`" in md
