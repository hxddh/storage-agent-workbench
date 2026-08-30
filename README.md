# Storage Agent

A local-first desktop **Agent for object storage and S3-compatible systems**.
Give it a storage goal or problem; it investigates with real read-only tools,
keeps working state across turns, accepts steering while it runs, stops for
explicit decisions when an operation moves cloud data, and produces durable
Work Results backed by Evidence and Execution records.

Storage Agent is not a chatbot wrapped around an admin console. The product is
organized around **Agent Tasks**:

**Direction → Execution → Decision (when required) → Work Result → Artifacts**

The Agent can diagnose S3 behavior, inspect account and bucket configuration,
analyze access logs and inventory, profile capacity/cost patterns, triage errors,
and generate durable reports. Secrets stay on the local device.

## Agent experience

The application has one primary object: the **active Agent Task**.

- **Agent Tasks** — active and recent work, with live states such as Working,
  Needs decision, Needs attention, and Ready.
- **Delegate** — describe the outcome you want. This starts or continues the
  current task rather than opening a chat.
- **Execution** — while the Agent is running, the UI shows real tool activity and
  keeps **Stop** and **Steer** available. No fake plan/checklist is invented when
  the runtime does not provide one.
- **Decision required** — confirmation-gated work is a blocking Agent state, not
  a passive suggestion. The Agent waits for an explicit user decision.
- **Direction** — additional user input changes or extends the task objective.
- **Work Result** — durable Agent output, rendered as technical work rather than
  as an assistant message bubble.
- **Artifacts / Review** — Evidence, Execution details and Reports open as
  contextual review beside the same active task; they are not application-level
  tabs that replace the Agent.

There is exactly one Agent input. At rest it delegates work; during execution it
becomes the steering control for the same running task.

## What it can do

1. Diagnose S3-compatible access, addressing, TLS and behavior issues.
2. Discover accounts and visible buckets with bounded read-only calls.
3. Review bucket configuration for security, lifecycle, observability, cost and
   performance concerns.
4. Analyze access logs and inventory locally with DuckDB.
5. Triage raw object-storage errors, including deterministic offline triage for
   supported error shapes.
6. Maintain durable task context, findings, evidence references and execution
   history across follow-up directions.
7. Generate evidence-backed Markdown Report artifacts.

## Safety model

Storage Agent deliberately has a narrower action surface than a general-purpose
computer-use Agent.

- **Local-first.** App state lives in the OS application-data directory. Network
  traffic goes only to providers that the user explicitly configures.
- **Secrets stay in an encrypted local vault.** Access keys, secret keys, session
  tokens and model API keys are never stored in SQLite, logs, reports or model
  prompts.
- **Read-only storage tools.** The Agent has no destructive or mutating S3 tool
  and no generic shell/arbitrary subprocess tool.
- **Autonomous read-only investigation.** Safe read-only checks can run without a
  confirmation click for every tool call.
- **Explicit decisions for cloud data movement.** Downloads, large/full scans,
  Evidence Import and similar data-moving operations pause at **Decision
  required** before execution.
- **Bounded and sanitized context.** Tool inputs/outputs, Evidence and durable
  records are sanitized; chain-of-thought is never persisted or exposed.
- **Truthful execution UI.** The interface shows runtime states that actually
  exist. It does not pretend to have multi-agent orchestration, worktrees,
  terminal control, a browser, or background workers that the backend does not
  provide.

See [docs/security.md](docs/security.md) for the full threat and safety model.

## Install

Download the installer for your platform from
[GitHub Releases](https://github.com/hxddh/storage-agent-workbench/releases).
Each release includes platform-specific SHA256 manifests.

| Platform | Asset |
| --- | --- |
| macOS (Apple Silicon) | `storage-agent-vX.Y.Z-macos-arm64.dmg` / `.app.zip` |
| Linux (x64) | `storage-agent-vX.Y.Z-linux-x64.deb` |
| Windows (x64) | `storage-agent-vX.Y.Z-windows-x64-setup.exe` |

The current builds are not distributed with Apple notarization or Windows
Authenticode signing, so the operating system may warn on first launch.

### macOS

After moving the app to `/Applications`, an unsigned downloaded build may need
its quarantine flag removed:

```bash
xattr -dr com.apple.quarantine "/Applications/Storage Agent.app"
open "/Applications/Storage Agent.app"
```

Finder **Right-click → Open** also works for the normal unidentified-developer
warning. If macOS specifically reports the downloaded app as damaged, use the
quarantine command above.

### Linux

```bash
sudo apt install ./storage-agent-*-linux-x64.deb
```

A WebKitGTK runtime is required and is pulled in by normal package dependencies
on supported distributions.

### Windows

Run `storage-agent-*-windows-x64-setup.exe`. SmartScreen may warn for the unsigned installer;
choose **More info → Run anyway** when you trust the downloaded artifact and its
checksum. WebView2 is required.

## Architecture vocabulary

The public product vocabulary is intentionally different from some historical
backend table/API names:

| Product | Persistence / API compatibility |
| --- | --- |
| Agent Task | `session` records/endpoints |
| Direction / Work Result | `session_messages` |
| Execution | `run` / `tool_call` records |
| Evidence / Artifact | evidence/report persistence |

`session` and `run` remain valid storage/API compatibility terms. They must not
be used to recreate a Chat/Session/Run-centered product shell. Frontend product
boundaries adapt them into Task / Execution / Review concepts.

## Quality gates

Every pull request runs:

- TypeScript typecheck, lint, unit and architecture-contract tests.
- Sidecar lint/import/tests with no cloud or model secrets.
- Real-Sidecar Playwright E2E, including durable Agent execution, steering,
  stopping, task concurrency, Evidence/Report Review, localization and safety.
- A real-state Agent visual-review gallery covering Delegate, Work Result,
  Execution, Working + Steer, Decision required, contextual Review, task
  navigation, narrow layout, runtime failure and Chinese UI.
- macOS Apple Silicon, Linux x64 and Windows x64 desktop build/runtime checks.

The architecture tests also reject the deleted Chat-era UI vocabulary and
components from production frontend source so the old shell cannot quietly grow
back.

## Documentation

- [docs/product.md](docs/product.md) — canonical Agent product model.
- [docs/architecture.md](docs/architecture.md) — Agent-native frontend/runtime
  ownership and persistence adapters.
- [docs/security.md](docs/security.md) — secret handling, read-only tools and
  confirmation boundaries.
- [docs/install.md](docs/install.md) — platform installation.
- [docs/release.md](docs/release.md) — release flow and platform support.
- [CHANGELOG.md](CHANGELOG.md) — historical release notes.

## License

[Apache License 2.0](LICENSE). You may use, modify and distribute this software,
including commercially, provided you preserve the copyright and `NOTICE`
attribution; the license includes an explicit patent grant.
