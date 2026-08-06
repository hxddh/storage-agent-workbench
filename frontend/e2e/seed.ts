import { execFileSync } from "node:child_process";
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
db, n = sys.argv[1], int(sys.argv[2])
conn = sqlite3.connect(db)
sid = "e2e-" + uuid.uuid4().hex[:12]
conn.execute(
    "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?,?,?,?)",
    (sid, "seeded multi-turn investigation", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
)
cols = {r[1] for r in conn.execute("PRAGMA table_info(session_messages)")}
for i in range(n):
    ts = "2026-01-01T00:%02d:00Z" % (i * 2)
    activity = json.dumps([
        {"tool": "head_bucket", "status": "ok", "target": "bucket-%d" % i, "result": "200", "duration_ms": 40},
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
conn.commit()
print(sid)
`;

/** Seed a session with `exchanges` user+assistant pairs; returns its id. */
export function seedSession(exchanges: number): string {
  const { dataDir } = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as { dataDir: string };
  return execFileSync(process.env.E2E_PYTHON || "python3", ["-c", PY, `${dataDir}/app.db`, String(exchanges)], {
    encoding: "utf8",
  }).trim();
}
