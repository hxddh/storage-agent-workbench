"""v0.63.0 — a single word walked through the destructive-proposal filter.

`FORBIDDEN_PHRASES` matches a CONTIGUOUS token sequence, so one word in the
middle defeated it. Measured against the real filter, before the fix:

| proposed action_type | accepted? |
| --- | --- |
| `delete_objects` | blocked ✓ |
| `delete_all_objects` | **accepted** |
| `recursive_delete` | **accepted** |
| `purge_all_objects` | **accepted** |

Rule 8 names *recursive delete* and *mass object mutation* explicitly, and the
module's own docstring says a proposal "must never even *suggest* a
mutating/dangerous operation". A surviving proposal renders as a chip under the
answer — a button offering to do the thing the rules forbid.

Nothing could have executed it: there is no destructive tool in the product, and
`is_forbidden_tool` gates only proposal labels. What was broken is the promise,
and the chip in front of the user.

The verb list is only safe if it catches no legitimate name, so the last test
holds it against the ACTUAL registered tools and action types rather than
against the comment next to it.
"""
from __future__ import annotations

import re
import pathlib

import pytest

from app.agent_runtime import guardrails
from app.sessions import next_actions

# The four that walked through, plus phrasings a model reaches for naturally.
SNEAKY = [
    "delete_all_objects",
    "recursive_delete",
    "purge_all_objects",
    "remove_every_version",
    "empty_the_bucket_completely",
    "abort_all_multipart_uploads",
    "drop_the_lifecycle_rule",
    "revoke_public_access",
    "disable_versioning",
    "overwrite_the_policy",
    "wipe_prefix",
    "erase_old_versions",
    "expire_everything_now",
    "prune_noncurrent_versions",
    "rename_the_bucket",
    "terminate_replication",
]

STILL_BLOCKED = [
    "delete_objects", "delete_bucket", "put_bucket_policy", "put_bucket_acl",
    "put_object", "create_bucket", "run_sql", "shell", "exec_python",
]

STILL_ALLOWED = [
    # Every special action type the product actually routes.
    *sorted(next_actions.SPECIAL_ACTION_TYPES),
    # Free-form labels a model plausibly proposes for read-only work.
    "review_bucket_security", "check_bucket_encryption", "compare_to_last_survey",
    "list_object_versions", "list_upload_parts", "import_inventory_file",
    "measure_request_latency", "preview_object", "inspect_endpoint_tls",
]


@pytest.mark.parametrize("slug", SNEAKY)
def test_a_destructive_label_is_refused_wherever_the_verb_sits(slug):
    assert next_actions._safe_action_type(slug) is None, slug


@pytest.mark.parametrize("slug", SNEAKY)
def test_such_a_proposal_is_dropped_entirely(slug):
    assert next_actions.normalize_proposal({"action_type": slug, "title": "Clean up"}) is None


@pytest.mark.parametrize("slug", STILL_BLOCKED)
def test_what_was_already_blocked_stays_blocked(slug):
    assert guardrails.is_forbidden_tool(slug), slug


@pytest.mark.parametrize("slug", STILL_ALLOWED)
def test_a_legitimate_action_type_still_survives(slug):
    assert next_actions._safe_action_type(slug) == slug, slug


def test_no_real_tool_name_is_caught_by_the_verb_list():
    """The verb list is a denylist over free-form model output, so its whole
    safety argument is that it collides with nothing this product legitimately
    names. Checked against the registered tools, not against a comment.
    """
    src = "\n".join(
        pathlib.Path(p).read_text()
        for p in sorted(pathlib.Path("app/agent_runtime").glob("session_*tools.py"))
    )
    # Every @function_tool-decorated function: that registration IS the whitelist.
    names = re.findall(r"@function_tool\s*\n\s*def (\w+)\(", src)
    assert len(names) > 20, f"expected the real tool set, found {names}"
    caught = [n for n in names if guardrails.is_forbidden_tool(n)]
    assert caught == [], caught


def test_the_verb_list_and_the_phrase_list_do_not_contradict_each_other():
    """A verb listed as destructive on its own makes its phrases redundant, and a
    redundant phrase is a place where the two lists can later disagree."""
    phrase_words = {w for phrase in guardrails.FORBIDDEN_PHRASES for w in phrase}
    overlap = phrase_words & guardrails.DESTRUCTIVE_VERBS
    # `delete` is deliberately in both: the phrases predate the verb list and are
    # kept as documentation of the specific S3 operations rule 8 names.
    assert overlap <= {"delete"}, overlap
