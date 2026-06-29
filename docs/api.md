# API

The sidecar binds localhost on a port chosen at launch. In the packaged app the
Tauri shell starts it on a free port and exposes the URL to the frontend; in dev
it defaults to `http://127.0.0.1:8765` (override with `VITE_SIDECAR_URL`). Paths
below are relative to that base.

## Health

### GET /health

Response:

```json
{
  "status": "ok",
  "service": "storage-agent-sidecar"
}
```

## Model provider APIs

```text
GET /model-providers
POST /model-providers
PUT /model-providers/{id}
DELETE /model-providers/{id}
POST /model-providers/{id}/test
```

## Cloud provider APIs

```text
GET /cloud-providers
POST /cloud-providers
PUT /cloud-providers/{id}
DELETE /cloud-providers/{id}
POST /cloud-providers/{id}/test
```

## Run APIs

```text
GET /runs
POST /runs
GET /runs/{run_id}
POST /runs/{run_id}/message
GET /runs/{run_id}/events
GET /reports/{run_id}
```

## Tool APIs

```text
POST /tools/test-credentials
POST /tools/head-bucket
POST /tools/list-objects-v2
POST /tools/head-object
POST /tools/test-range-get
POST /tools/test-path-style-vs-virtual-host
POST /tools/inspect-tls
```

## Run SSE event types

Run events use mode-neutral names (the same shape for deterministic and
agent-planner runs):

```json
{"type":"run_started","planner_mode":"deterministic"}
{"type":"plan","content":"..."}
{"type":"tool_selected","tool_name":"head_bucket","reason":"..."}
{"type":"tool_call_started","tool_name":"head_bucket","tool_call_id":"..."}
{"type":"tool_call_finished","tool_name":"head_bucket","status":"success","output":{}}
{"type":"summary","content":"..."}
{"type":"finding","severity":"warning","title":"...","detail":"..."}
{"type":"guardrail_passed","name":"..."}
{"type":"guardrail_blocked","name":"...","message":"..."}
{"type":"report_ready","run_id":"...","report_path":"..."}
{"type":"final_summary","content":"..."}
{"type":"error","message":"..."}
```

The session message stream (`POST /sessions/{id}/messages/stream`) emits
`delta` (answer text), `tool` (a sanitized `{tool, target, result}` trace), and
a final `done` (`{message_id, proposed_actions}`) — or `error`.
