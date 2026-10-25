# Documentation

These pages describe the behavior of the **25.0.0** tree. They are not a
roadmap and not a substitute for the code.

| File | What it is |
|---|---|
| [product.md](product.md) | Tasks, brief, findings, checks and the model-free check |
| [architecture.md](architecture.md) | Processes, runtime flow, modules and storage layout |
| [data-model.md](data-model.md) | Host tables, pi tables, datasets and retention |
| [tools.md](tools.md) | The ten tools, code mode and their limits |
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
  check, with durable entries and one brief.
- **Brief** — the page projected from a task's tool results.
- **Check** — one read-only tool call, or one step of a model-free account
  check, shown as evidence under the brief.
- **Estate** — remembered bucket posture, Issues, notes and changes.
- **Finding** — a current problem proved by a reading; an Issue is the durable
  record behind a finding.
- **Blind spot** — a read that was denied, unsupported, failed or not attempted;
  it never counts as clean.
- **Grant** — an access statement or ACL entry. It is evidence, not a complete
  authorization decision.
