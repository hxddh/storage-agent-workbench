# Documentation

These pages describe the behavior of the **36.0.0** tree. They are not a
roadmap and not a substitute for the code.

| File | What it is |
|---|---|
| [product.md](product.md) | Tasks as conversations, Home, Check account, access evidence, memory and limits |
| [architecture.md](architecture.md) | Processes, runtime flow, modules and storage layout |
| [data-model.md](data-model.md) | Host tables, pi tables, datasets and retention |
| [tools.md](tools.md) | The twelve tools grouped by capability, citations, change_plan, code mode and limits |
| [security.md](security.md) | Secrets, scope, redaction, evidence and the trust boundary |
| [iam.md](iam.md) | The read-only IAM actions and what each one enables |
| [capabilities.md](capabilities.md) | Provider capability matrix |
| [design.md](design.md) | Tokens, type, the conversation layout, motion and accessibility |
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

- **Task** — one conversation with the agent: the user's messages and, between
  them, what the agent did and said, with its entries, memory and a composer.
- **Turn** — one user message and the agent's work on it: thoughts, tool calls,
  text, a question or a confirmation. A message sent while the agent works is a
  steer; it joins the running turn.
- **Step** — one tool call or reasoning summary, shown as a compact line where it
  happened. Opening it shows the call's shaped result.
- **Answer** — the agent's text, normal Markdown. A turn can hold several texts
  between tool calls. The agent may link a call as `[1](#ev-<id>)`; the link
  opens that step in place. The app never writes into it.
- **Reading record** — the counts of one account survey in a turn, kept as the
  agent's memory. It holds no verdict and is never shown in the window.
- **Thought** — a provider-supplied reasoning summary, never a fabricated chain
  of thought. An omitted summary stays visibly omitted.
- **Risk** — the user-facing problem proved by a reading. An **Issue** is its
  durable database record; the word Issue is not shown in the window.
- **Check** — **Check account** puts a message in the composer for the user to
  send; a scheduled check sends a one-line message naming its account. Both are
  turns like any other and need a model.
- **Estate** — remembered bucket posture, Issues, notes, changes and reading
  records.
- **Reading** — one settled account survey with its coverage and whether it was
  complete.
- **Change plan** — deterministic, user-applied change text grouped into steps,
  with baseline, manual blockers and residual risks.
- **Blind spot** — a read that was denied, unsupported, failed or not attempted;
  it never counts as clean.
- **Grant** — an access statement or ACL entry. It is evidence, not a complete
  authorization decision.

The run page of 35.x (scope line, Findings and Not checked strips, earlier
runs, the trace reducer) and the scripted, model-free check and re-check were
removed in 36.0.
