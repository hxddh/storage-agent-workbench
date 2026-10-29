# Documentation

These pages describe the **38.0.0** tree. They are not a roadmap and not a
substitute for the code.

| File | What it is |
|---|---|
| [product.md](product.md) | Tasks as conversations, Home, reads, memory, methods, views and Settings |
| [architecture.md](architecture.md) | Processes, runtime flow, modules and storage layout |
| [data-model.md](data-model.md) | Host tables, pi entries, datasets and retention |
| [tools.md](tools.md) | The ten tools, results, citations, memory and code mode |
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
- **Memory document**: arbitrary JSON the agent chose to remember, with a key,
  optional text and tags, and a task or user scope.
- **Method**: a reusable tool the agent wrote for itself: a JSON Schema and a
  read-only JavaScript body.
- **View**: a declarative document the agent composed with `render`. The app
  renders the blocks; the document is never HTML or code.
- **Child agent**: a `delegate` run with the same read-only tools, scope and
  memory. Its answer returns as the parent step's result.
- **Change**: text the agent writes (a CLI command, a policy) for the user to
  apply. The app never runs it.
