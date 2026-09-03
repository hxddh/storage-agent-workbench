/**
 * The Sidecar client, as one import for the application.
 *
 * Since v1.12 the client is split by responsibility and this file is the
 * barrel that keeps every existing `from "../api"` import working:
 *
 * - `api/client.ts`    — the HTTP primitive: auth header, timeouts, `ApiError`.
 * - `api/runtime.ts`   — the durable Agent Task runtime: executions, the
 *                        event stream (SSE, resume by sequence), steer / stop /
 *                        resume, decisions, on-demand compaction.
 * - `api/tasks.ts`     — the task record: task list, document, messages,
 *                        triage, datasets, activity, artifacts, provenance,
 *                        engine outputs.
 * - `api/settings.ts`  — settings, approval policy, instructions file, price
 *                        table, skills, observability export, MCP bridge.
 * - `api/providers.ts` — model + cloud providers and their inline probes.
 *
 * There is exactly one way to start work: `createTaskExecution` followed by
 * `followExecutionEvents`. Nothing here speaks to a session message endpoint,
 * a turn-cancel path, an evidence-import flow, or the `/runs` engine API.
 */
export * from "./api/client";
export * from "./api/runtime";
export * from "./api/tasks";
export * from "./api/settings";
export * from "./api/providers";
