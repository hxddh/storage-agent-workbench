# Documentation

These pages describe the **43.0.0** tree. They are not a roadmap and not a
substitute for the code.

| File | What it is |
|---|---|
| [product.md](product.md) | Tasks as conversations, Home, the workspace, schedules, changes and Settings |
| [architecture.md](architecture.md) | Processes, runtime flow, schedules, approvals, MCP, modules and storage layout |
| [data-model.md](data-model.md) | Host tables and migrations, the workspace, pi entries, datasets and retention |
| [tools.md](tools.md) | The eleven tools, results, citations, skills and code mode |
| [security.md](security.md) | Secrets, approved changes, scope as authorization, redaction, identifiers and the trust boundary |
| [iam.md](iam.md) | IAM permissions for reads and for approved changes, and where each call goes |
| [capabilities.md](capabilities.md) | How S3-compatible endpoints are handled |
| [design.md](design.md) | Tokens, type, layout, Home, the conversation, motion and accessibility |
| [development.md](development.md) | Commands, tests, evaluation and packaging |
| [release.md](release.md) | CI and release jobs, signing, evaluation gates and updates |
| [v43.md](v43.md) | The 43 design as it was planned; history, not documentation |

## Precedence

1. `CLAUDE.md` is the implementation contract.
2. These pages describe current behaviour and known limits.
3. Where a page disagrees with the code or its tests, the code and tests win;
   fix the page in the same change.
4. `CHANGELOG.md`, published release notes and `v43.md` are history, not
   documentation.

## Vocabulary

- **Task**: one conversation with the agent, with its entries and a composer.
- **Turn**: one user message and the agent's work on it: thoughts, tool calls,
  text or a question. A message sent while the agent works is a **steer**; it
  joins the running turn.
- **Step**: one tool call or reasoning summary, shown as one line where it
  happened. Opening it shows the call's result and what the agent received.
- **Answer**: the agent's text, in Markdown. A turn can hold several texts
  between tool calls. The app never writes into it.
- **Thought**: a reasoning summary the provider returned, shown in full. When
  the provider returns none, the step says so.
- **Read**: one `call`: the service's response as JSON, or its error code,
  HTTP status and message. A 404 such as `NoSuchBucketPolicy` is an answer like
  any other.
- **Workspace**: the agent's own folder, kept across tasks — notes, skills,
  datasets, scripts, the board, exports — and its `db.sqlite`. The user can
  open it.
- **Skill**: a Markdown note on how to work a kind of question. Bundled skills
  ship with the app; the agent may write its own in the workspace.
- **View**: a declarative document a script returns or a board file holds.
  The app renders the blocks; the document is never HTML or code.
- **Board**: the views pinned on Home, one per `board/*.view.json` file.
- **Schedule**: a prompt the agent set to run on its own, once or on a
  cadence; each run is a turn in the schedule's own task, within a token
  budget.
- **Inbox**: what the agent told the user with `notify`, on Home.
- **Child agent**: a `delegate` run with the same tools and scope. Its answer
  returns as the parent step's result.
- **Change**: a write the agent proposed with `change`. It runs only when the
  user approves it in the window, on an account that allows changes, and can
  be rolled back. A change the app cannot make is text the agent writes for
  the user to apply.
