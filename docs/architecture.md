# Architecture

## Processes

```text
Electron main                            Renderer (sandboxed)
  app.ts      wiring, watches             App.tsx   state + layout
  ipc.ts      the only IPC surface   ⇄    Sidebar / Stream / Composer
  preload     contextBridge, CJS           Settings
  pi-durable  harness, tasks, entries
  tools       ten read-only tools
  estate      rules, issues, fixes
  s3          AWS SDK v3 reads
  analysis    SQLite per dataset
                     │
        storage-agent.db (node:sqlite)
        pi_* tables + host tables
```

There is no HTTP server, no sidecar, no port and no token. The renderer never
touches the filesystem, the database or a credential; it calls the preload
surface, which is exactly `AgentApi` in `src/shared/contract.ts`.

## Runtime flow

1. `app.whenReady` opens the database, builds services, opens the harness and
   registers IPC.
2. `harness.createConversation()` creates one conversation per task; every new
   conversation receives the configured model.
3. `submit` writes a `sa.user` entry and runs pi's generation task. A running
   call is projected from `pi.live.tools` (name, target, progress, start time);
   when it settles it becomes a `pi.tool-result` entry carrying `details` (the UI
   view), and the row is replaced in place.
4. The open task is watched with `conversation.watch()`. Each frame appends new
   entries and pushes the live state to the window through `agent:event`.
5. `harness.watchTaskGraph()` supplies working state for the sidebar.
6. `conversation.abort()` stops a run; pi keeps what was committed.
7. pi compacts when the model's context window fills; compaction appears as a
   divider in the stream.
8. When a task settles, its requests and answers are written to `search_docs`.
   Tasks without rows are backfilled in the background at startup.

The window never receives `entry.model` (the provider-facing messages). The
mapper in `runtime/harness.ts` projects entries into `UiEntry`, extracting only
the answer text and the tool details.

## Modules

| Module | Responsibility |
|---|---|
| `main/db.ts` | schema, migrations (`user_version`), typed queries |
| `main/providers.ts` | account config, S3 clients, masking, connection test |
| `main/settings.ts` | `settings.json` (language, theme, model reference) |
| `main/security/vault.ts` | `safeStorage` or AES-256-GCM fallback |
| `main/security/redact.ts` | credential-shaped text removal, bounding |
| `main/runtime/model.ts` | pi-ai provider construction and a one-shot test |
| `main/runtime/agent.ts` | prompt sections, step-cap hooks, estate digest |
| `main/tools/policy.ts` | `agentTool()`: scope, timeout, audit, envelope, details |
| `main/s3/posture.ts` | one bounded snapshot per bucket |
| `main/s3/review.ts` | security, lifecycle and observability findings |
| `main/estate/rules.ts` | seven rules and tri-state evaluation |
| `main/estate/fixes.ts` | fix formats and impact preview |
| `main/analysis/*` | import (bounded, redacted) and whitelisted aggregates |
| `main/app.ts` | service wiring, watch tick, notifications |
| `main/window-state.ts` | window bounds in `window.json`, clamped to a display |
| `renderer/Sidebar.tsx` | task list, ⌘K search, rename, inline delete |
| `renderer/Stream.tsx` | entries, running calls, focus, copy/save |

## Storage layout

```
<userData>/
  storage-agent.db          app + pi_ tables + search_docs
  settings.json             non-secret settings
  window.json               window bounds
  .vault-key                only when no OS keyring (0600)
  staging/<token>/          files waiting for their message
  tasks/<conversation>/
    uploads/                attached logs and inventories
    datasets/<id>.sqlite    one analytical database per import
```

## Deliberate absences

No event-sourcing layer, no second queue, no SSE, no report generator, no trace
export, no MCP bridge, no skills loader, no subagents, no approval UI. pi owns
the durable loop; the product owns storage semantics.
