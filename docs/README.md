# Documentation

> **Current baseline: Storage Agent v8.1.0.** Built on the v5 rewrite around one
> idea — *the estate is the object, Agent Tasks are how work is done, and one item
> stream is the truth* — v7 made a task one conversation; v8 is subtraction and
> correctness: the bugs a full review found are fixed, the Agent has 30 tools
> instead of 42, and the palette, the dollar estimate, dead endpoints and dead code
> are gone; v8.1 closes the review's remaining findings. See `docs/releases/8.1.0.md`.

## Source-of-truth order

1. The code, and its executable contracts: `frontend/src/contracts.test.ts`,
   `frontend/src/surfaces.test.tsx`, `frontend/src/estate/estate.test.tsx`,
   `sidecar/tests/test_v500_*.py`, `sidecar/tests/test_v600_kernel.py`, the
   Playwright suite in `frontend/e2e/`.
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
| **Conversation** | A task's page: every Turn on the branch, oldest first — the request, one activity line, the answer with its findings and figures. |
| **Estate** | What the work established about the user's storage: accounts, known buckets, their posture and how it changed, Issues, notes. |
| **Issue** | A deterministic observation about a bucket, with a lifecycle (open → fix proposed → resolved; recurred; accepted). |
| **Fix pack** | An Issue's fix as text the user applies — AWS CLI, Terraform, the API document — with an impact preview drawn from evidence (or an honest *cannot tell*). |
| **Note** | Something the user or the Agent wants remembered about the estate, an account or a bucket; visible and editable; every task starts with the most recent. |
| **Watch** | An opt-in, read-only sweep of one account on the Sidecar's clock that opens one task when something new turns up. |
| **Send / Add to the request / Stop** | The one control path: submit a Direction, steer the running Turn, end it. |

## Documents

| Document | What it specifies |
| --- | --- |
| `product.md` | What the product is for, the window, the home, the estate, the Task page, Quick Ask. |
| `architecture.md` | The runtime: items, turns and forks, the agent loop, tools, models, streaming, the estate, the shell. |
| `security.md` | The safety floor and how each rule is enforced. |
| `api.md` | Every Sidecar route and stream. |
| `data-model.md` | The SQLite schema, item payloads, datasets on disk, the v4 importer. |
| `tools.md` | Every Agent tool, its bounds and scope. |
| `design-tokens.md` | The design system's tokens. |
| `evals.md` | How behaviour is pinned in tests. |
| `install.md`, `packaging.md`, `release.md`, `release-smoke-test.md`, `signing.md` | Building, packaging, releasing. |

`history/` keeps earlier baselines (v4 under `history/v4/`) for reference only.
