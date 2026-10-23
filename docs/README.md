# Documentation

> **Current release: Storage Agent v13.0.0; these canonical documents describe
> the current `main`.** Built on the v5 rewrite around one idea — *the Task is
> the window's object, the estate is the Agent's memory, and one item stream is
> the truth*. v7 made a task one conversation; v8 was subtraction and
> correctness; v9 kept state consistent; v10 made a small local model finish the
> work; v11 made the work legible; v12 made a turn one assistant article; v12.1
> settled the start. v13 removes storage and bucket from the window: Home is one
> sentence and one Composer, a Task is a result-first workspace, and the estate
> is reached through the Agent, not a resource browser. No schema, route or
> tool-set change. See `docs/releases/13.0.0.md`; release notes are history,
> these documents are the current specification.

## Source-of-truth order

1. The code, and its executable contracts: `frontend/src/contracts.test.ts`,
   `frontend/src/surfaces.test.tsx`, `frontend/src/tool/ResultView.test.tsx`,
   `sidecar/tests/test_v500_*.py`, `sidecar/tests/test_v600_kernel.py`,
   `sidecar/tests/test_v1100_agent_native.py`, `sidecar/tests/test_v1200_*.py`,
   `sidecar/tests/test_v1300_agent_workspace.py`, the Playwright suite in `frontend/e2e/`.
2. `CLAUDE.md` — the implementation contract.
3. The canonical documents below.
4. Release notes and the CHANGELOG — history, not specification.

When they disagree, the higher one wins; fix the lower one in the same PR.

## Vocabulary

| Concept | Meaning |
| --- | --- |
| **Task** | The unit of delegated work: a tree of Turns, read one branch at a time. |
| **Direction** | What the user asked — the heading of a Turn, in their words. Editing it sends a new version (a fork). |
| **Turn** | One Direction and the work it caused; queued, running, completed, failed, cancelled or interrupted. |
| **Item** | One entry of the append-only stream (message, tool call/progress/output, conclusion, steer, compaction, notice, error). Everything shown is projected from items. |
| **Workspace** | A task's page: every Turn on the branch, oldest first — the objective, deterministic result, interpretation, findings and quiet work receipt. |
| **Estate** | The Agent's memory of the user's storage: accounts, known buckets, posture, Issues and notes. It is data the Agent reads, not a window tree. |
| **Issue** | A deterministic observation about a bucket, with a lifecycle (open → fix proposed → resolved; recurred; accepted). |
| **Fix pack** | An Issue's fix as text the user applies — AWS CLI, Terraform, the API document — with an impact preview drawn from evidence (or an honest *cannot tell*). |
| **Note** | Something the Agent keeps in the estate's memory about an account or a bucket; every task starts with the most recent. The Agent writes it with the `note` tool; it is not a window navigation surface. |
| **Watch** | An opt-in, read-only sweep of one account on the Sidecar's clock that opens one task when something new turns up. |
| **Send / Add to the request / Stop** | The one control path: submit a Direction, steer the running Turn, end it. |

## Documents

| Document | What it specifies |
| --- | --- |
| `product.md` | What the product is for, the window, Home, the Task workspace, Evidence, Quick Ask and Connections. |
| `architecture.md` | The runtime: items, turns and forks, the agent loop, tools, models, streaming, the estate, the shell. |
| `security.md` | The safety floor and how each rule is enforced. |
| `api.md` | Every Sidecar route and stream. |
| `data-model.md` | The SQLite schema, item payloads, datasets on disk, the v4 importer. |
| `tools.md` | Every Agent tool, its bounds and scope. |
| `design-tokens.md` | The design system's tokens. |
| `evals.md` | How behaviour is pinned in tests. |
| `install.md`, `packaging.md`, `release.md`, `release-smoke-test.md`, `signing.md` | Building, packaging, releasing. |

`history/` keeps earlier baselines (v4 under `history/v4/`) for reference only.
