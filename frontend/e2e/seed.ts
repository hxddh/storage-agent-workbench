import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { STATE_FILE } from "./global-setup";

/**
 * Put a long, realistic conversation into the E2E sidecar's database.
 *
 * Everything else in this suite drives the app through the composer, which
 * without a model provider can only produce offline triage cards. That path
 * never creates an assistant MESSAGE, so it exercises none of the Task's
 * Work Result rendering: collapsing, ordering
 * across many turns. A multi-turn Task is the product's main surface and had
 * no coverage at all.
 *
 * Seeding writes the same rows a real turn writes, through the sidecar's own
 * SQLite file, so the app then loads them over the real HTTP + repository path.
 * It is deliberately not a fixture the frontend can see: the render is asserted
 * against what the server actually returns.
 */

const PY = `
import json, sqlite3, sys, uuid
db, n, title = sys.argv[1], int(sys.argv[2]), sys.argv[3]
# "tall": answers the SIZE a real agent writes — headings, paragraphs, a wide
# table, a list. The default one-line answer is ~36-65px tall, which is roughly
# what the Task document's layout assumptions were tuned against; a real answer with a
# table measured 1616px. Anything about scrolling, height or landing position is
# untestable against the short shape, because the short shape never makes the
# container grow after first layout.
shape = sys.argv[4] if len(sys.argv) > 4 else "short"
conn = sqlite3.connect(db)
sid = "e2e-" + uuid.uuid4().hex[:12]
conn.execute(
    "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)",
    (sid, title, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
)
cols = {r[1] for r in conn.execute("PRAGMA table_info(session_messages)")}
def call_id(i):
    return "call-%s-%03d" % (sid, i)

def answer_text(i):
    if shape != "tall":
        return "ANSWER-%02d bucket-%d denies list because the policy omits s3:ListBucket." % (i, i)
    rows = "\\n".join(
        "| bucket-%03d-%02d | %d | %d GiB | STANDARD | %s |" % (i, k, k * 137, k * 41, "yes" if k % 3 else "no")
        for k in range(24)
    )
    paras = "\\n\\n".join(
        "Paragraph %d of the finding for bucket-%03d. The bucket policy omits "
        "s3:ListBucket for the caller principal, so every list call returns 403 "
        "AccessDenied while head_object on a known key still succeeds." % (p, i)
        for p in range(4)
    )
    return ("ANSWER-%02d\\n\\n## Finding %02d — bucket-%03d denies list\\n\\n%s\\n\\n"
            "| bucket | objects | size | class | versioned |\\n"
            "| --- | --- | --- | --- | --- |\\n%s\\n\\n"
            "- point one about lifecycle\\n- point two about replication\\n"
            "- point three about logging\\n- point four about encryption\\n") % (i, i, i, paras, rows)

for i in range(n):
    ts = "2026-01-01T00:%02d:00Z" % (i * 2)
    # The row shape session_tools.note() really writes: mixed types, not the
    # all-string dict every unit fixture used.
    activity = json.dumps([
        {"id": call_id(i), "tool": "head_bucket", "target": "bucket-%d" % i,
         "result": "200", "args": {"bucket": "bucket-%d" % i}, "ok": True,
         "duration_ms": 40, "status": "completed"},
    ])
    for role, body, act in (
        ("user", "QUESTION-%02d why does bucket-%d return 403" % (i, i), None),
        ("assistant", answer_text(i), activity),
    ):
        row = {
            "id": "m-%s-%s" % (sid, uuid.uuid4().hex[:8]),
            "session_id": sid,
            "role": role,
            "content": body,
            "created_at": ts,
        }
        if act is not None and "tool_activity" in cols:
            row["tool_activity"] = act
        keys = ",".join(row)
        conn.execute(
            "INSERT INTO session_messages (%s) VALUES (%s)" % (keys, ",".join("?" * len(row))),
            tuple(row.values()),
        )
        if role != "assistant":
            continue
        # The persisted call behind the trace row, under the SAME id — that is
        # what makes a footer row expandable in place (v0.56.0).
        conn.execute(
            "INSERT INTO tool_calls (id, run_id, session_id, tool_name,"
            " input_json_sanitized, output_json_sanitized, status, duration_ms, created_at)"
            " VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)",
            (call_id(i), sid, "head_bucket",
             json.dumps({"bucket": "bucket-%d" % i}),
             json.dumps({"success": True, "status": 200}), "success", 40, ts),
        )
        # What the turn cost, so the footer renders numbers rather than dashes.
        conn.execute(
            "INSERT INTO turn_metrics (id, session_id, turn_id, message_id, model, requests,"
            " input_tokens, output_tokens, total_tokens, duration_ms, tool_calls, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            ("tm-" + row["id"], sid, "turn-%d" % i, row["id"], "test-model", 2,
             1200, 300, 1500, 2400, 1, ts),
        )
conn.commit()
print(sid)
`;

/**
 * Seed a session with `exchanges` user+assistant pairs; returns its id.
 *
 * The title is unique per call because the sidecar's data dir lives for the
 * whole run: a shared title makes every rail assertion ambiguous, and a test
 * that deletes "the" session leaves the other copies behind and reports a
 * product failure that is really a fixture collision.
 *
 * Random, not a counter. A counter is per-MODULE, and Playwright runs each spec
 * file in its own process — so three files each produced "seeded task
 * 1" and a rail assertion found four rows where it expected one. That surfaced
 * as a flaky product failure on CI and passed locally, which is the worst way
 * for a fixture to be wrong.
 */
export function seedSession(
  exchanges: number,
  title = `seeded task ${randomUUID().slice(0, 8)}`,
  shape: "short" | "tall" = "short",
): {
  id: string;
  title: string;
} {
  // A bare JSON.parse here reports "Unexpected end of JSON input" and nothing
  // else, from four specs at once, with the actual cause — a leaked sidecar
  // holding the port, so this run never recorded its own data dir — nowhere on
  // screen. Say what happened and what to do about it.
  const raw = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, "utf8") : "";
  if (!raw.trim()) {
    throw new Error(
      `the E2E sidecar state file (${STATE_FILE}) is missing or empty, so this ` +
        `run does not know which data dir to seed. It is usually left behind by ` +
        `an interrupted run: stop any stray sidecar (pkill -f "uvicorn app.main"), ` +
        `delete ${STATE_FILE}, and run again.`,
    );
  }
  const { dataDir } = JSON.parse(raw) as { dataDir: string };
  const id = execFileSync(
    process.env.E2E_PYTHON || "python3",
    ["-c", PY, `${dataDir}/app.db`, String(exchanges), title, shape],
    { encoding: "utf8" },
  ).trim();
  return { id, title };
}

function dataDir(): string {
  const raw = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, "utf8") : "";
  if (!raw.trim()) {
    throw new Error(
      `the E2E sidecar state file (${STATE_FILE}) is missing or empty, so this ` +
        `run does not know which data dir to seed.`,
    );
  }
  return (JSON.parse(raw) as { dataDir: string }).dataDir;
}

const INTERRUPTED_PY = `
import sqlite3, sys, uuid
conn = sqlite3.connect(sys.argv[1])
sid, direction = sys.argv[2], sys.argv[3]
eid = "exec-" + uuid.uuid4().hex[:12]
conn.execute(
    "INSERT INTO agent_tasks (id, title, status, created_at, updated_at)"
    " VALUES (?, ?, 'needs_attention', datetime('now'), datetime('now'))"
    " ON CONFLICT(id) DO UPDATE SET status='needs_attention'",
    (sid, "seeded"),
)
conn.execute(
    "INSERT INTO task_executions (id, task_id, direction, kind, status,"
    " created_at, updated_at, finished_at)"
    " VALUES (?, ?, ?, 'direction', 'interrupted', datetime('now'), datetime('now'), datetime('now'))",
    (eid, sid, direction),
)
conn.commit()
print(eid)
`;

/** A durable interrupted execution the Resume card can recover. */
export function seedInterruptedTask(
  title = `interrupted task ${randomUUID().slice(0, 8)}`,
): { id: string; title: string; executionId: string } {
  const { id } = seedSession(1, title, "short");
  const executionId = execFileSync(
    process.env.E2E_PYTHON || "python3",
    ["-c", INTERRUPTED_PY, `${dataDir()}/app.db`, id, "why does acme-logs return 403?"],
    { encoding: "utf8" },
  ).trim();
  return { id, title, executionId };
}

const INVENTORY = JSON.stringify({
  type: "inventory",
  metrics: {
    object_count: 100,
    total_size: 100000000000,
    unknown_age_ratio: 0,
    unknown_size_ratio: 0,
    as_of: "2026-08-01T00:00:00Z",
    storage_class_distribution: [
      { value: "STANDARD", count: 100, size: 100000000000 },
    ],
    object_age_distribution: [
      { bucket: "0-7d", count: 20 },
      { bucket: "365d+", count: 80 },
    ],
  },
});

const COST_SIM = JSON.stringify({
  kind: "simulation",
  estimate: true,
  gaps: [],
  coverage: {
    object_count: 100,
    bytes: 100000000000,
    inventory_as_of: "2026-08-01T00:00:00Z",
    unknown_age_ratio: 0,
    note: "Estimate, not a bill.",
  },
  timeline: [
    {
      day: 0,
      candidate_class_bytes: { STANDARD: 100000000000 },
      baseline_class_bytes: { STANDARD: 100000000000 },
      baseline_monthly_cost: { usd_per_month: 2.3, estimate: true },
      candidate_monthly_cost: { usd_per_month: 2.3, estimate: true },
    },
    {
      day: 365,
      candidate_class_bytes: { STANDARD: 20000000000, STANDARD_IA: 80000000000 },
      baseline_class_bytes: { STANDARD: 100000000000 },
      baseline_monthly_cost: { usd_per_month: 2.3, estimate: true },
      candidate_monthly_cost: { usd_per_month: 1.2, estimate: true },
    },
  ],
  monthly_cost_delta: { usd_per_month_at_365d: -1.1, estimate: true, horizon_days: 365 },
});

const LIFECYCLE = JSON.stringify({
  facts: { has_abort_mpu: false, has_transition: false, has_expiration: false },
  findings: [{ title: "No AbortIncompleteMultipartUpload rule", severity: "warning" }],
});

const OPTIMIZATION_PY = `
import json, sqlite3, sys, uuid
conn = sqlite3.connect(sys.argv[1])
sid = sys.argv[2]
mode = sys.argv[3]
inventory, lifecycle, cost_sim = sys.argv[4], sys.argv[5], sys.argv[6]
conn.execute(
    "INSERT INTO agent_tasks (id, title, status, created_at, updated_at)"
    " VALUES (?, ?, 'ready', datetime('now'), datetime('now'))"
    " ON CONFLICT(id) DO UPDATE SET status='ready'",
    (sid, "seeded"),
)
conn.execute(
    "INSERT INTO tool_calls (id, run_id, session_id, tool_name,"
    " input_json_sanitized, output_json_sanitized, status, duration_ms, created_at)"
    " VALUES (?, NULL, ?, 'analyze_inventory', '{}', ?, 'success', 12, datetime('now'))",
    ("tc-inv-" + sid[-8:], sid, inventory),
)
conn.execute(
    "INSERT INTO tool_calls (id, run_id, session_id, tool_name,"
    " input_json_sanitized, output_json_sanitized, status, duration_ms, created_at)"
    " VALUES (?, NULL, ?, 'review_bucket_lifecycle', '{}', ?, 'success', 8, datetime('now'))",
    ("tc-lc-" + sid[-8:], sid, lifecycle),
)
conn.execute(
    "INSERT INTO tool_calls (id, run_id, session_id, tool_name,"
    " input_json_sanitized, output_json_sanitized, status, duration_ms, created_at)"
    " VALUES (?, NULL, ?, 'simulate_storage_cost', '{}', ?, 'success', 9, datetime('now'))",
    ("tc-cost-" + sid[-8:], sid, cost_sim),
)
conn.execute(
    "INSERT INTO session_findings (id, session_id, source_run_id, category, severity, confidence, kind, title, interpretation, evidence_json, status, created_at)"
    " VALUES (?, ?, NULL, 'lifecycle', 'warning', 'high', 'inference', ?, ?, ?, 'active', datetime('now'))",
    ("fnd-" + sid[-8:], sid, "No AbortIncompleteMultipartUpload rule",
     "Incomplete multipart uploads are not aborted automatically.",
     json.dumps({"tool": "review_bucket_lifecycle"})),
)
if mode in ("review", "due", "catchup"):
    plan_id = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO remediation_plans (id, task_id, version, status, title,"
        " plan_json_sanitized, simulation_json_sanitized, created_at, updated_at)"
        " VALUES (?, ?, 1, 'proposed', 'Remediation plan',"
        " ?, ?, datetime('now'), datetime('now'))",
        (plan_id, sid,
         json.dumps({"actions": [{"id": "abort-mpu-7d", "kind": "abort_mpu", "after_days": 7,
                                  "title": "Abort incomplete multipart uploads after 7 days",
                                  "lifecycle_fragment": {"Rules": [{"ID": "abort-mpu", "Status": "Enabled",
                                    "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7}}]}}],
                      "checklist": ["Apply in your console"], "apply_in": "operator_console_or_cli",
                      "mutation": False}),
         json.dumps({"kind": "simulation", "coverage": {"object_count": 100, "bytes": 100000000000,
                     "inventory_as_of": "2026-08-01T00:00:00Z"}, "gaps": []})),
    )
    conn.execute(
        "INSERT INTO task_artifacts (id, task_id, artifact_type, title, ref_kind, ref_id,"
        " format, summary, status, created_at)"
        " VALUES (?, ?, 'remediation_plan', 'Remediation plan v1', 'remediation_plan', ?,"
        " 'json', '1 recommended action(s); status proposed', 'proposed', datetime('now'))",
        (uuid.uuid4().hex, sid, plan_id),
    )
    bid = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO task_baselines (id, task_id, version, snapshot_json_sanitized, created_at)"
        " VALUES (?, ?, 1, ?, datetime('now'))",
        (bid, sid, json.dumps({"inventory": {"object_count": 100, "total_size": 100000000000},
                               "findings": [{"title": "No AbortIncompleteMultipartUpload rule"}]})),
    )
    conn.execute(
        "INSERT INTO task_artifacts (id, task_id, artifact_type, title, ref_kind, ref_id,"
        " format, summary, created_at) VALUES (?, ?, 'baseline', 'Task baseline v1',"
        " 'task_baseline', ?, 'json', '100 objects', datetime('now'))",
        (uuid.uuid4().hex, sid, bid),
    )
    conn.execute(
        "INSERT INTO task_artifacts (id, task_id, artifact_type, title, ref_kind, ref_id,"
        " format, summary, payload_json_sanitized, created_at)"
        " VALUES (?, ?, 'drift_report', 'Drift report', 'drift_report', ?,"
        " 'json', 'added 0 / resolved 0 / still present 1',"
        " ?, datetime('now'))",
        (uuid.uuid4().hex, sid, bid,
         json.dumps({"kind": "drift", "estimate": True, "findings": {"added": [], "resolved": [],
                     "still_present": [{"title": "No AbortIncompleteMultipartUpload rule"}]},
                     "inventory_trend": {"object_count_delta": 0, "total_size_delta": 0,
                       "points": 2, "estimate": True, "note": "Two snapshots only."},
                     "coverage": {"object_count": 100}})),
    )
    note = "catch-up" if mode in ("due", "catchup") else None
    due = "2020-01-01T00:00:00Z" if mode == "due" else "2099-01-01T00:00:00Z"
    conn.execute(
        "INSERT INTO task_revisit_schedules (task_id, enabled, interval_days, next_due_at,"
        " last_catchup_note, created_at, updated_at) VALUES (?, 1, 7, ?, ?, datetime('now'), datetime('now'))",
        (sid, due, note),
    )
conn.commit()
print(sid)
`;

export function seedOptimizationTask(
  title = `cost review ${randomUUID().slice(0, 8)}`,
  mode: "inventory" | "review" | "due" | "catchup" = "inventory",
): { id: string; title: string } {
  const { id } = seedSession(1, title, "short");
  execFileSync(
    process.env.E2E_PYTHON || "python3",
    ["-c", OPTIMIZATION_PY, `${dataDir()}/app.db`, id, mode, INVENTORY, LIFECYCLE, COST_SIM],
    { encoding: "utf8" },
  );
  return { id, title };
}


