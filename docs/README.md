# Documentation

These pages describe the behavior of the **35.0.0** tree. They are not a
roadmap and not a substitute for the code.

| File | What it is |
|---|---|
| [product.md](product.md) | Tasks, runs, Work, the optional plan, Markdown answers, Sources and the model-free check |
| [architecture.md](architecture.md) | Processes, runtime flow, modules and storage layout |
| [data-model.md](data-model.md) | Host tables, pi tables, datasets and retention |
| [tools.md](tools.md) | The thirteen tools grouped by capability, final answer citations, change_plan, code mode and limits |
| [security.md](security.md) | Secrets, scope, redaction, evidence and the trust boundary |
| [iam.md](iam.md) | The read-only IAM actions and what each one enables |
| [capabilities.md](capabilities.md) | Provider capability matrix |
| [design.md](design.md) | Tokens, type, Work layout, motion and accessibility |
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

- **Task** — the window's object: durable history of one or more runs, with
  entries, memory and a composer.
- **Run** — one request or scripted check (account check, re-check) and
  everything it did: plan, calls, validations, answer, findings and what stayed
  unread. The task owns the durable history; the latest run owns its scope and
  evidence. Earlier runs stay compact under **Earlier in this task**.
- **Trace** — the run's one record: plan revisions, reasoning summary, live and
  completed calls with status, target, arguments, duration, shaped results and
  what the rules did, validations, steers, resumes and re-check comparisons. It
  is primary while the run works and folds to `Worked for …` after the answer.
- **Answer** — the agent's final assistant message, normal Markdown, or a
  scripted run's sentence written from its own calls. It cites a tool result by
  its evidence id; the window opens the cited result in place.
- **Findings / Not checked** — the two evidence strips: risks the run's readings
  prove (severity ordered, memory marked, accept on hover), and everything the
  reads left open. They stay visible even when the answer does not mention them.
- **Ledger** — the run's state derived from its durable entries: calls, names,
  evidence, coverage. Never kept in memory, so a restart rebuilds it.
- **Thought** — a provider-supplied reasoning summary, never a fabricated chain
  of thought. An omitted summary stays visibly omitted.
- **Method** — a `skill` workflow the agent loaded (access, change, inventory,
  capacity). It is documentation, not a check or storage evidence.
- **Risk** — the user-facing problem proved by a reading. An **Issue** is its
  durable database record; the word Issue is not shown in the window.
- **Check** — **Check account** is a scripted run of the read-only tools, with
  no model; a re-check replays a task's reads in the same task.
- **Estate** — remembered bucket posture, Issues, notes, changes and reading
  records.
- **Reading** — one settled account survey with its coverage and whether it was
  complete. A re-check is recorded as partial.
- **Change plan** — deterministic, user-applied change text grouped into steps,
  with baseline, manual blockers and residual risks.
- **Blind spot** — a read that was denied, unsupported, failed or not attempted;
  it never counts as clean.
- **Grant** — an access statement or ACL entry. It is evidence, not a complete
  authorization decision.
