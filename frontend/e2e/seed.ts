import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { STATE_FILE } from "./global-setup";

/**
 * Put a long, realistic conversation into the E2E sidecar's database.
 *
 * Everything else in this suite drives the app through the composer, which
 * without a model provider can only produce offline triage cards. That path
 * never creates an assistant MESSAGE, so it exercises none of the thread's
 * message rendering: collapsing, the turn footer, per-message actions, ordering
 * across many turns. A multi-turn thread is the product's main surface and had
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
conn = sqlite3.connect(db)
sid = "e2e-" + uuid.uuid4().hex[:12]
conn.execute(
    "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)",
    (sid, title, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
)
cols = {r[1] for r in conn.execute("PRAGMA table_info(session_messages)")}
def call_id(i):
    return "call-%s-%03d" % (sid, i)
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
        ("assistant", "ANSWER-%02d bucket-%d denies list because the policy omits s3:ListBucket." % (i, i), activity),
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
 * file in its own process — so three files each produced "seeded investigation
 * 1" and a rail assertion found four rows where it expected one. That surfaced
 * as a flaky product failure on CI and passed locally, which is the worst way
 * for a fixture to be wrong.
 */
export function seedSession(
  exchanges: number,
  title = `seeded investigation ${randomUUID().slice(0, 8)}`,
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
    ["-c", PY, `${dataDir}/app.db`, String(exchanges), title],
    { encoding: "utf8" },
  ).trim();
  return { id, title };
}
