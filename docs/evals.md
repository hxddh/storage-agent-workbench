# Evals

Behaviour is pinned by executable tests that drive the real code paths. There is no live model and no live cloud in the CI gates (an opt-in real-model eval exists, below): the model is a scripted OpenAI-compatible endpoint (`sidecar/tests/fake_model.py`, `frontend/e2e/fake-model.ts`) and storage is a real S3 server (moto, `sidecar/tests/live_s3.py`) or a hostile-endpoint double (`tests/fake_endpoint.py`, `e2e/fake-s3.ts`).

| Behaviour | Where |
| --- | --- |
| A Direction runs the real Agents SDK loop into items; the task is named; a user rename wins | `sidecar/tests/test_v500_runtime.py` |
| Tools are items; the conclusion is a conclusion item; the model reads tool output inside the untrusted-data envelope; the UI never gets `model_output` | same |
| Forks: a new version of a Direction; the model sees only its branch; switching branches | same |
| Stop keeps the partial turn; queued Directions run in order and can be withdrawn; steer reaches the running loop; steer with nothing running is a new Direction | same |
| No model → a failed turn with *Open Settings*; step-budget overrun → finalized answer; restart → one continuation | same |
| Scope refusal is a tool output the model reads; the report is conclusion-first with Safety (en/zh); the SSE stream replays then follows | same |
| Both model backends build (Responses: deferred namespaces, tool search, compaction, `store=False`; Chat: all tools, usage) | `test_v500_backends.py` |
| The estate: rules, lifecycle, digest; the golden task survey → review → Issues → fix → Verify → recurred against a real S3 server | `test_v500_estate.py` |
| The watch: off by default, one task only when something new, bounded, stops when turned off, keeps three surveys | `test_v500_watch.py` |
| The v4 importer; attached logs analyzed without raw rows reaching the model; undiscovered import sources refused; triage redacts; compaction folds by Turn | `test_v500_importer_files.py` |
| Every read-only tool against every hostile endpoint shape never raises, never leaks a credential, never claims a verdict after a failure | `test_v076_endpoint_matrix.py`, `test_v066_s3_over_http.py`, `test_v084_live_s3.py` |
| The MCP server exposes only the stateless read-only subset, scope-checked and audited | `test_v113_mcp_bridge.py` |
| v6: a call's stop signal (Stop or its own timeout); task state follows the head branch; the bucket page (posture history, timeline); notes (redaction, audit, the digest); accept with a reason; fix packs (CLI · Terraform · document, hostile names quoted); the impact preview from an S3 server access log and its honest gaps; the Agent's `note` and `fix_preview` in a real streamed turn | `test_v600_kernel.py` |
| A real model, opt-in: survey + review leave a grounded estate with a conclusion and no secret echoed; a scope refusal is honoured | `tests/live_eval/` (`STORAGE_AGENT_LIVE_EVAL=1`, `STORAGE_AGENT_EVAL_API_KEY`; the manual *Live model eval* workflow) |
| The window contract (one submit path, the window's parts, no raw colours, copy parity, native menu parity, Quick Ask) | `frontend/src/contracts.test.ts` |
| The reducer and projections; the Result, Work log, Resume, versions, the Composer's Delegate/Steer/Stop | `frontend/src/store/*.test.ts`, `frontend/src/surfaces.test.tsx` |
| The estate view: an account's buckets, the bucket page, notes, *Ask about this bucket* never submits, accept with a reason, the fix pack and its impact preview | `frontend/src/estate/estate.test.tsx` |
| The real window against the real Sidecar: first run, result-first task with side pane, ⌘K, steer/stop, fork, estate, settings, Chinese, WCAG AA contrast in both themes | `frontend/e2e/*.spec.ts` |

## Adding a case

1. Deterministic behaviour (a rule, a gap shape, redaction): a unit test next to the engine.
2. Anything the model loop sees, emits or persists: a streamed-path test with `FakeModel` — never a stub of the runner.
3. Anything that talks to storage: moto (`live_s3_endpoint`) or `fake_endpoint.py` — never live cloud.
4. Anything the user sees: a surface test, and an E2E spec when it crosses the Sidecar.
