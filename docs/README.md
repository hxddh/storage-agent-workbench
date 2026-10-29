# Documentation

These pages describe the **37.0.0** tree. They are not a roadmap and not a
substitute for the code.

| File | What it is |
|---|---|
| [product.md](product.md) | Tasks as conversations, Home, the reads, memory, Settings and limits |
| [architecture.md](architecture.md) | Processes, runtime flow, modules and storage layout |
| [data-model.md](data-model.md) | Host tables, pi entries, datasets and retention |
| [tools.md](tools.md) | The six tools, results, citations and code mode |
| [security.md](security.md) | Secrets, scope, redaction, account ids and the trust boundary |
| [iam.md](iam.md) | Read-only IAM permissions and where each read goes |
| [capabilities.md](capabilities.md) | How S3-compatible endpoints are handled |
| [design.md](design.md) | Tokens, type, layout, the conversation, motion and accessibility |
| [development.md](development.md) | Commands, tests, evaluation and packaging |
| [release.md](release.md) | CI and release jobs, signing, evaluation gates and updates |

## Precedence

1. `CLAUDE.md` is the implementation contract.
2. These pages describe current behaviour and known limits.
3. Where a page disagrees with the code or its tests, the code and tests win;
   fix the page in the same change.
4. `CHANGELOG.md` and published release notes are history, not documentation.

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
- **Note**: a fact the agent chose to remember between tasks.
- **Change**: text the agent writes (a CLI command, a policy) for the user to
  apply. The app never runs it.
