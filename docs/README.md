# Documentation

These pages describe the behavior of the **31.0.0** tree. They are not a
roadmap and not a substitute for the code.

| File | What it is |
|---|---|
| [product.md](product.md) | Tasks, runs, the optional plan, Markdown answers, Sources and the model-free check |
| [architecture.md](architecture.md) | Processes, runtime flow, modules and storage layout |
| [data-model.md](data-model.md) | Host tables, pi tables, datasets and retention |
| [tools.md](tools.md) | The twelve tools grouped by capability, final answer citations, change_plan, code mode and limits |
| [security.md](security.md) | Secrets, scope, redaction, evidence and the trust boundary |
| [iam.md](iam.md) | The read-only IAM actions and what each one enables |
| [capabilities.md](capabilities.md) | Provider capability matrix |
| [design.md](design.md) | Tokens, type, layout, motion and accessibility |
| [development.md](development.md) | Commands, tests and packaging |
| [release.md](release.md) | CI/release gates, signing, feeds and update path |

## Precedence

1. `CLAUDE.md` is the implementation contract and the first thing to read.
2. These pages describe current behavior and known limits.
3. If a page disagrees with the code or its tests, the code and tests win; fix
   the page in the same change.
4. `CHANGELOG.md` and published release notes are history. They may describe
   behavior that no longer exists and must not be used as current documentation.

## Vocabulary

- **Task** — the window's object: a user request or a deterministic account
  check, with durable entries and one run.
- **Run** — the agent's optional plan, its answer, one proof view and the
  evidence behind it.
- **Answer** — the agent's final assistant message, normal Markdown. It cites a
  tool result by its evidence id; the window renders the cited tool view. The
  model never authors a fact table.
- **Sources** — the one compact evidence index below the answer: Risks, Data,
  Change plan, Tool calls, Not checked, Checked again, Changes and Methods.
- **Method** — a `skill` workflow the agent loaded (access, change, inventory,
  capacity). It is documentation, not a check or storage evidence.
- **Risk** — the user-facing problem proved by a reading. An **Issue** is its
  durable database record; the word Issue is not shown in the window.
- **Check** — one read-only tool call, or one step of a model-free account
  check, shown under Tool calls.
- **Estate** — remembered bucket posture, Issues, notes, changes and reading
  records.
- **Reading** — one settled account survey with its coverage and whether it was
  complete. Re-verification is recorded as partial.
- **Change plan** — deterministic, user-applied change text grouped into steps,
  with baseline, manual blockers and residual risks.
- **Blind spot** — a read that was denied, unsupported, failed or not attempted;
  it never counts as clean.
- **Grant** — an access statement or ACL entry. It is evidence, not a complete
  authorization decision.
