# Documentation

These pages describe the behavior of the **36.0.0** tree. They are not a
roadmap and not a substitute for the code.

| File | What it is |
|---|---|
| [product.md](product.md) | Tasks as conversations, Home, the reads, memory, Settings and limits |
| [architecture.md](architecture.md) | Processes, runtime flow, modules and storage layout |
| [data-model.md](data-model.md) | Host tables, pi tables, datasets and retention |
| [tools.md](tools.md) | The nine tools, citations, code mode and limits |
| [security.md](security.md) | Secrets, scope, redaction, account ids and the trust boundary |
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
  them, what the agent did and said, with its entries and a composer.
- **Turn** — one user message and the agent's work on it: thoughts, tool calls,
  text or a question. A message sent while the agent works is a steer; it joins
  the running turn.
- **Step** — one tool call or reasoning summary, shown as a compact line where it
  happened. Opening it shows the call's shaped result and what the agent
  received.
- **Answer** — the agent's text, normal Markdown. A turn can hold several texts
  between tool calls. The agent may link a call as `[1](#ev-<id>)`; the link
  opens that step in place. The app never writes into it.
- **Thought** — a provider-supplied reasoning summary, never a fabricated chain
  of thought. An omitted summary stays visibly omitted.
- **Read** — one API answer as a tool returns it: `{ status, value }` or
  `{ status, error }`. The status is `available`, `not_configured`,
  `access_denied`, `provider_unsupported`, `missing`, `region_mismatch` or
  `error`. A read is data; it carries no judgement.
- **Note** — a fact the agent chose to remember. Notes are the agent's memory
  between tasks; the user can forget them in Settings.
- **Change** — text the agent writes (a CLI command, a policy) for the user to
  apply. The app never runs it.

The run page of 35.x (scope line, Findings and Not checked strips, earlier
runs) and the scripted check were removed in 36.0, and so were the rule engine
and Issues, the `survey`, `estate`, `change_plan` and `accept_risk` tools,
deterministic change plans, reading records and posture history, scheduled
checks, **Check account** and demo storage. Older tasks still show their calls
to those tools.
