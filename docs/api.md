# API

Default base URL:

```text
http://127.0.0.1:8765
```

## Health

### GET /health

Response:

```json
{
  "status": "ok",
  "service": "storage-agent-sidecar"
}
```

## Future model provider APIs

```text
GET /model-providers
POST /model-providers
PUT /model-providers/{id}
DELETE /model-providers/{id}
POST /model-providers/{id}/test
```

## Future cloud provider APIs

```text
GET /cloud-providers
POST /cloud-providers
PUT /cloud-providers/{id}
DELETE /cloud-providers/{id}
POST /cloud-providers/{id}/test
```

## Future run APIs

```text
GET /runs
POST /runs
GET /runs/{run_id}
POST /runs/{run_id}/message
GET /runs/{run_id}/events
GET /reports/{run_id}
```

## Future tool APIs

```text
POST /tools/test-credentials
POST /tools/head-bucket
POST /tools/list-objects-v2
POST /tools/head-object
POST /tools/test-range-get
POST /tools/test-path-style-vs-virtual-host
POST /tools/inspect-tls
```

## Future SSE event types

```json
{"type":"agent_plan","content":"..."}
{"type":"tool_call_started","tool_name":"head_bucket","tool_call_id":"..."}
{"type":"tool_call_finished","tool_name":"head_bucket","status":"success","output":{}}
{"type":"agent_message","content":"..."}
{"type":"finding","severity":"warning","title":"...","detail":"..."}
{"type":"report_ready","run_id":"...","report_path":"..."}
{"type":"error","message":"..."}
```
