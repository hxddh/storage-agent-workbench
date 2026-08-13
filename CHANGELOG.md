# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow semantic versioning once it reaches 1.0.

## [Unreleased]

### Changed — the `jump to latest` flake now reports why, because nobody can reproduce it

`landing.spec.ts › 'jump to latest' actually reaches the latest` fails on CI
every so often: the test scrolls the thread to the top and the rescue button
never appears. Measured on a developer machine — 1 failure in 23 full-file runs
while the machine was loaded, 0 in 16 against `main`'s sidecar, 0 in 20 run
alone. Every deliberate attempt to provoke it **passed**: 6 runs scrolling with
no settle wait, 6 with a wheel gesture, 8 full-file runs under 6 CPU hogs.

There is a plausible mechanism — `scrollToBottom` re-jumps every frame until the
thread's height settles, and `onScroll` ignores scroll events while that run is
in flight, so a *programmatic* scroll made mid-run would be both undone and
never measured, where a real user's wheel gesture cancels the run first through
`releaseToUser`. The sibling test that scrolls by wheel does not flake, which
fits. But it is a story, not evidence, and the same kind of story was wrong
three times about the v0.78.0 torn row. Changing the test to match the theory
would most likely just hide the failure and make the next one harder to read.

So the test now records the scroller's position every frame and, on failure,
reports a trace built to tell the candidates apart: whether the thread scrolled
itself back to the bottom (the convergence run), whether it stayed put with the
button still absent (the pin state), or whether the height was still growing
(the test moved too early). The failure path was exercised deliberately — by
pointing the assertion at a locator that cannot exist — rather than left as
diagnostic code that first runs on the day it is needed.

Review caught the flaw in that plan: the suite's per-test deadline is 30s, and
this test can spend most of it before the assertion even starts, so on a loaded
CI box Playwright would kill it mid-`catch` and print a generic timeout — losing
the trace in exactly the run it exists for. The test now buys explicit headroom.
Demonstrated both ways: with an assertion deliberately outlasting the old
deadline, the unfixed test reports `Test timeout of 30000ms exceeded` and zero
diagnostic lines; the fixed one reports the full trace.

This does not fix the flake, and the test can still fail. The next occurrence
will say what happened.

### Fixed — the fallback lock v0.78.0 shipped was the hazard it was guarding against

`db.transaction()` returned one **process-wide** lock for a connection the
module had not wrapped. Held across a write section, that is exactly the shape
that deadlocks two writing connections — the defect caught in review on #163 —
so the single construct built to prevent it would have silently reintroduced it
for anyone passing a bare `sqlite3.Connection`.

Nothing in `app/` could reach it: `connect()` is the only place a connection is
opened and it always wraps. That is what made it worth removing rather than
documenting — an unreachable trap is one nobody trips until they do, and it
would have failed as a 30-second stall, not as an error pointing anywhere useful.

`db.transaction()` now refuses such a connection with a `TypeError` naming the
fix. Five test fixtures were passing bare connections into threaded tool code
and are now wrapped the way the app wraps them; they were the only callers.

### Changed — the commit guard reads the package, not a list of file names

The structural guard from v0.59.0 scanned four hardcoded module names — the four
that held `conn.commit()` when it was written. A **new** module in
`app/agent_runtime`, which is the likeliest way an unguarded commit would
actually arrive, was never looked at, and the guard's own "did I check
everything" assertion passed anyway. It now globs the package. Verified by
dropping a module with an unguarded commit into it: the old form passed, the new
form names the file and line.

### Docs — a known gap that had stopped being true, and a direction that misled

`roadmap.md` claimed the E2E suite "covers the credential-free paths only" and
that a model-backed turn was "deliberately out of scope". Eleven of the 22 specs
drive a full model-backed turn against a scripted local endpoint, and have for
some time. The real gap is narrower and worth stating precisely: nothing runs
against a live provider key or a live bucket, so provider-specific behavior is
only ever found by hand — and v0.78.0 is the standing example of what the
doubles can hide.

The Direction section led with notarization + auto-update, which are blocked on
purchasing signing credentials. Leading with them dressed a spending decision up
as the next engineering step and pushed the work that can actually be done down
the page. They move to Known gaps; Direction now lists only what is actionable.

## [0.78.0] - 2026-08-12

_Two failures that reported themselves as something else: a tool call that died
on a row another thread was reading, and an SDK upgrade blamed for a broken test
double._

Both were long-standing, both had been investigated before, and both had left
the same kind of trail — a plausible message with the evidence stripped out of
it. The Agents SDK's `default_tool_error_function` discards the traceback; a 30s
Playwright timeout hides the error banner the page is already showing. In each
case the fix was cheap once the real evidence was in hand.

### Fixed — `openai-agents` 0.20.0 was never broken; the test double was

v0.77.0 took 0.20.0, measured it, and reverted it: `analyze.spec.ts` went 5/5
fail on 30s timeouts, the full Playwright suite 27 failed / 101 passed in 15.2
minutes, and "the cause inside 0.20.0 is not yet identified". The cause was not
inside 0.20.0.

Driving one real turn through a live uvicorn + SSE sidecar on 0.20.0 — no
browser, so the sidecar's own output was visible — the turn completed normally.
The browser run's page snapshot then showed what the timeout had hidden, sitting
in an error banner on the start surface:

> Model reused a completed tool call ID for a different invocation. Use a unique
> call ID for each tool invocation.

`e2e/fake-model.ts` emitted the constant `id: "call_fake_1"` for **every** tool
call, so a two-step turn reused one completed call's ID for a different tool. No
real model does that. 0.20.0 added a check for it
(`agents/run_internal/tool_planning.py`) and correctly refused the turn; 0.19.4
had no such check and let the malformed conversation through. The symptom read
as "the turn never starts" because the failure lands before the thread leaves
the start surface, with the question still in the composer.

The double now mints a unique ID per invocation. With that one-line change and
nothing else:

| | `analyze.spec.ts` | full Playwright suite | sidecar suite |
| --- | --- | --- | --- |
| **0.20.0**, before | 5/5 fail | 27 failed / 101 passed, 15.2 min | 1481 passed |
| **0.20.0**, after | **5/5 pass** | **128/128, 3.3 min** | **1481 passed** |
| 0.19.4, after (no regression) | 5/5 pass | 128/128, 3.3 min | 1481 passed |

`requirements.lock` therefore moves to `openai-agents==0.20.0`. The three SDK
facts v0.55.0's tool gating depends on — `get_all_tools` called inside the run
loop, `is_enabled` honoured, `FunctionTool` unfrozen — are still asserted by
`test_v056_deps_and_detail.py` and still hold.

### Fixed — the tool call that died on a row another thread was reading

`test_many_concurrent_pairs_lose_no_audit_or_call_row` had been failing on CI a
few times a release — always the same way, never locally, and with nothing to go
on:

```
AssertionError: 1 call(s) returned an error, first: 'An error occurred while
running the tool. Please try again. Error: tuple index out of range'
```

That message is the Agents SDK's `default_tool_error_function`, which
stringifies whatever the tool body raised and discards the traceback. Handing
the test a `failure_error_function` that keeps the stack named the throw site on
the first reproduction: `row["id"]` in `_row_to_out`, on a **torn row**.

Two tool bodies share the turn's one connection — the SDK dispatches each sync
tool with `asyncio.to_thread` — and two threads stepping statements on a single
`sqlite3.Connection` can hand back a `sqlite3.Row` whose description carries
more columns than the row has values. `sqlite3.threadsafety` is 3, but that says
the SQLite *library* is serialized; CPython's per-connection bookkeeping is not.
It reproduces with no app code involved, and only on Pythons newer than the
developer machines — which is the whole reason it lived in CI. Tears per 6000
forced-concurrent rounds on one in-memory connection:

| | 3.11 | 3.12 (CI) | 3.13 |
| --- | --- | --- | --- |
| write under the lock, read unguarded (the shipped code) | 0 | 1 | 2 |
| **two pure reads, no writer at all** | 0 | **3** | **10** |

The second row is the one that matters: `db.WRITE_LOCK` guarded writes, so no
amount of write locking could have closed this. `db.connect()` now returns a
`SerializedConnection` that runs **every** statement under the connection's lock
and drains the statement before releasing it, so no caller can be left fetching
rows outside the lock. Explicit write sections stay, as
`with db.transaction(conn):`: a per-statement lock cannot know that an INSERT and
its commit belong together.

**The lock is per connection, and that is not a detail.** The first cut used one
process-wide lock and deadlocked two writing connections: A's INSERT opens a
SQLite write transaction and releases the lock, B's INSERT takes the lock and
parks inside `sqlite3_step` waiting for A, and A's `commit()` — the only thing
that would end the wait — cannot get the lock back. Nothing moves until B's
`busy_timeout` expires, B fails with `database is locked`, and every other
statement in the process queues behind it; in production that wait is 30
seconds. Two connections is the normal shape, not a corner case — every request
opens one and a turn's worker owns another for its lifetime. Caught in review
before release, reproduced (8.0s stall on an 8s timeout), fixed, and pinned by
`test_two_writing_connections_do_not_deadlock_each_other`.

The user-visible symptom was an agent told a read-only tool had failed when it
had in fact succeeded, and an audit trail that quietly did not hold (rule 17).

## [0.77.0] - 2026-08-11

_A count we were already making and throwing away — and an SDK upgrade that did
not survive contact with the real stack._

### Changed — dependency refresh

| package | from | to |
| --- | --- | --- |
| `boto3` / `botocore` | 1.43.65 | 1.43.68 |
| `pyarrow` | 25.0.0 | 25.0.1 |
| `ruff` | 0.16.1 | 0.16.2 |
| `vite` · `postcss` · `@types/node` · `@testing-library/jest-dom` | — | latest patch |

### Not upgraded — `openai-agents` 0.20.0 breaks the agent turn

0.20.0 was taken, measured, and **reverted**. It passes the sidecar's 1475
in-process tests and both of the risks the lockfile names — the changed SDK
default model cannot reach us (`agent_service.py` always constructs an explicit
`OpenAIChatCompletionsModel`), and the `is_enabled` source assertion still holds
— and then fails the moment a turn runs through the real uvicorn + SSE path:

| | `analyze.spec.ts` alone | full Playwright suite |
| --- | --- | --- |
| **0.20.0** | **5/5 fail**, 30s timeouts | **27 failed** / 101 passed, 15.2 min |
| **0.19.4** | **5/5 pass**, 16.7s | **128/128 pass**, 3.1 min |

Everything else held constant. At the failure the sidecar reports *Connected*
and the session row is created, but the question is still sitting in the composer
and the thread never leaves the start surface — the turn never begins. The cause
inside 0.20.0 is not yet identified; the pin stays at 0.19.4 until it is.

This is the lockfile doing its job. Its header predicted a bad 0.20 would be
"first visible as a broken release"; it was instead visible as a broken E2E run.
The in-process suite is not sufficient evidence for an agent-SDK bump, and that
is now written down.

`cryptography` 50.0.0 is also available and deliberately not taken: it is the
secret vault's AES-256-GCM dependency and a major version deserves its own
release.

### Fixed — a model-call count we were discarding

Many OpenAI-compatible endpoints omit `usage` on streamed responses. The turn
footer correctly refuses to invent token counts for them, but showed *nothing
else*, so a one-shot answer and a six-step investigation rendered identically as
a bare em dash. `_usage_snapshot()` was summing the SDK's model-call count and
then throwing it away along with the zeroed tokens.

Token fields are now returned as `null` rather than `0` — the renderer decides
"were tokens reported?" by formatting them, and `0` formats as `"0"`, which would
put a confident `↑0 ↓0` on screen. An unreported count is not a zero, and that
distinction is the whole reason the footer says "—" at all. The call count renders
only when tokens are absent.

**This change has no visible effect yet, and saying otherwise would be a lie.**
The count is only non-zero from `openai-agents` 0.20.0, which is blocked above —
measured on a turn of one tool step plus one answer step, 0.19.4 reports
`requests=0` and 0.20.0 reports `requests=2`. The code and its tests are correct
under 0.19.4; the payoff arrives with the SDK.

### Changed test

`test_usage_stays_unavailable_when_nothing_was_reported` asserted the whole
snapshot was `None` — the behaviour that discarded the count. It now pins the
sharper contract (tokens unavailable, requests reported), with a new sibling
covering `requests=0` still returning `None`.

### Verification

- `sidecar`: 1475/1475 pytest, `ruff check app` clean, lockfile regenerated then
  re-pinned to `openai-agents==0.19.4`.
- `frontend`: 255/255 unit, `tsc --noEmit` + E2E typecheck clean; i18n 416 keys
  per locale, no missing key, no placeholder mismatch.
- Playwright E2E on the shipped dependency set: **128/128 pass in 3.1 min** —
  the same baseline as before this release, which is itself the confirmation
  that the 27 failures and the 15.2-minute run belonged to 0.20.0 and nothing
  else.

## [0.76.0] - 2026-08-11

_Every read-only tool, against every way a real endpoint misbehaves._

No product code changed in this release. It exists so that the class of defect
v0.74.0 fixed cannot come back.

### Added — a real-socket endpoint fixture and a tool × failure-shape matrix

v0.74.0 fixed three defects found by pointing the real client at a real socket
for one afternoon. All three lived in code with substantial unit coverage —
`get_object_lock_status` alone had 21 test references — because every existing
test feeds a **coded** error through a Stubber, which constructs botocore's
parsed error dict directly and therefore always hands the tool a well-formed
`<Code>`. That is the one shape which cannot expose a missing HTTP-status
fallback, a dead guard, or an empty error report.

`tests/fake_endpoint.py` serves seven shapes that real deployments produce:

| shape | why it is different |
| --- | --- |
| code-less `501` / `405` | an nginx / CDN / gateway answering with an HTML body — botocore parses no `<Code>` |
| code-less `403` | auth failure and permission denial are genuinely indistinguishable; the tool must not guess |
| `200` with an empty body | a plain web server at the wrong URL; parses as valid-but-empty for nearly every operation |
| truncated XML `200` | raises `ParseError`, **not** `ClientError` — a branch most tools never exercise |
| HTML `500` | a retryable failure with no S3 payload |
| connection reset | not a `ClientError` at all |

`tests/test_v076_endpoint_matrix.py` runs **18 read-only tools × 7 shapes = 126
cases**, asserting invariants rather than per-tool expectations:

| # | invariant |
| --- | --- |
| I1 | a tool never raises — a failure is a returned shape, not a traceback |
| I2 | a failure names its cause; an empty code *and* empty message *and* no status is not a report |
| I3 | a failure never leaves a determined verdict standing |
| I4 | no path echoes an access key, secret key or session token |
| I5 | a capability gap is never dressed up as a *successful* positive finding |

I3 is the generalization of v0.74.0's worst bug: `retention_status: "none"` —
"no retention, cleanly deletable" — about an object the call never reached.

A meta-test pins the matrix against the agent's own `_TOOL_GROUPS` table, so
adding a tool to `object_forensics` or `storage_pileup` without adding it here
fails rather than leaving a silent hole.

### Verified against the bug it exists to prevent

A passing suite proves nothing on its own. Re-introducing the three v0.74.0
defects makes the matrix fail on **6 of the 7 shapes** — including
`truncated_xml`, `html_500` and `reset`, three that were never probed by hand
when those defects were found and fixed. Restored, it is green again.

### Findings

The matrix reports **no new defects** against current code. That is the result,
stated plainly rather than dressed up: its value is the revert experiment above
and the coverage it makes permanent, not a fresh bug count.

### Verification

- `sidecar`: 1474/1474 pytest (1346 + 128 new), `ruff check` clean.
- `frontend`: untouched this release; not re-run locally.

## [0.75.0] - 2026-08-11

_The answer kept its shape._

Reported from the shipped app: *"输出格式不优雅了…表格没有了，内容很杂乱"* — the output
stopped being tidy, a session's tables were gone, the content was a mess. Two
separate causes.

### Fixed — one unbreakable token dragged the whole thread sideways

This product's prose is full of tokens with no break opportunity: object keys,
`arn:aws:s3:::…/very/deep/prefix/name.json.gz`, endpoint URLs, presigned URLs,
checksums. The prose container declared no `overflow-wrap`, so one of them set
the paragraph's content width and the thread became horizontally scrollable.

Measured at a 1280px viewport, on an answer containing a single 300-character
token:

| | before | after |
| --- | --- | --- |
| thread `scrollWidth` (column is 1036px) | **2881 px** | 1036 px |
| prose elements overflowing their own column | 1 | 0 |
| wide table still scrolls in its own box | yes | yes |

Every answer had to be read by scrolling right, and a wide table was carried
off-screen along with everything else — which is what "tables are gone, content
is a mess" is from the reader's side. The container now sets `break-words` and
`min-w-0`; the wide-table wrapper still scrolls in place, so the wrap is not paid
for by flattening tables.

**This was masked until v0.73.0, by v0.73.0's own subject.** `.thread-item`
carried `content-visibility: auto`, which implies `contain: paint` — the overflow
was being *clipped*, so the text was silently unreachable instead of visibly
misplaced. Removing that (on its own measurements, for a different bug) exposed
the real defect underneath. Re-adding the containment would only hide it again,
and hiding an answer is worse than wrapping it. Verified both ways: with the
containment restored the sideways scroll is 0, without it 1845px.

### Fixed — tables an agent writes that the renderer dropped

Measured by rendering a corpus of 32 real answer shapes and asking the DOM what
came out: 27 produced a table, now 30. The two that still do not are the two
that are not tables (a `===` separator, a header row with no pipes).

- **A single-column table never parsed.** The separator test required a cell on
  both sides of a pipe, and `| --- |` ends at the closing pipe with nothing
  after it. "Which buckets are public?" is a one-column answer; its rows fell
  through to paragraph text as literal `| acme-logs |` lines.
- **A table inside a blockquote never parsed.** A quote's body was rendered as
  one `<p>` per line, so any block inside it — table, list, code fence — came out
  as literal text. It now goes through the shared recursive block renderer, the
  same way list items already did.

### Why the suites were green throughout

jsdom has no layout, so the unit suite could not see an element overflow — the
entire first half of this is invisible to it by construction. That half is now
an E2E test (`e2e/layout.spec.ts`) that measures real geometry in a real
browser, at two viewport widths; 3 of its 4 cases fail against the previous
code, and 4 of the 15 new unit cases do.

### Verification

- `frontend`: 128/128 E2E, 251/251 unit, `tsc --noEmit` + E2E typecheck clean.
- `sidecar`: untouched this release; not re-run locally.

## [0.74.0] - 2026-08-10

_What the tools said about providers they had never actually reached._

### Fixed — an object nobody could inspect was reported as cleanly deletable

`get_object_lock_status` answers *"why can't I delete this object?"*. On a hard
error it carried a guard meant to flip its optimistic defaults to `unknown`,
with a comment saying that reporting `retention_status: "none"` would read as
"exists and is cleanly deletable" — the exact wrong answer for a mistyped key.

The guard was dead. It tested `"retention_mode" not in result` for a key that
`base` seeds as `None` on every call, so the condition was always false and the
flip never ran. Measured, before the fix:

| provider response | reported |
| --- | --- |
| `NoSuchKey` — a mistyped key | **`retention_status: "none"`** |
| `NoSuchBucket` — the wrong bucket | **`retention_status: "none"`** |
| `InternalError` 500 — a provider fault | **`retention_status: "none"`** |
| a bare gateway error | **`retention_status: "none"`** |

Now `unknown`, and the guard tests the value rather than the key's presence. A
genuinely determined "no lock configured" is still `none` — that distinction is
the whole point.

### Fixed — a capability gap with no error code was called a hard failure

Rule 18 says a provider capability gap is `Provider unsupported`, never a hard
failure. `_is_unsupported` implements that as *code* `NotImplemented`/
`MethodNotAllowed`/… **or** a bare HTTP 501/405 — because an nginx or CDN in
front of an S3-compatible service answers with an HTML body and no S3 XML, so
botocore has no `<Code>` to parse.

Nine call sites used that helper. Three did not:

- `get_object_lock_status`, both the retention and the legal-hold branch, matched
  the code set only. A code-less 501/405 became a hard failure.
- the account survey's `head_bucket` checked `http == 501` and not 405 — so one
  response produced two verdicts inside a single snapshot: `head_bucket_status:
  "error"` while `versioning` / `encryption` / `lifecycle` / `logging` all said
  `provider_unsupported` for the identical 405.

### Fixed — a failure that said nothing at all

A code-less gateway failure left botocore with neither a code nor a message, and
the tool returned `error_code: ""`, `error_message_sanitized: ""` — a failure the
agent cannot explain and the user cannot act on. The message now names the HTTP
status.

`error_code` itself is deliberately **not** synthesized: its emptiness is
load-bearing. `test_credentials` refuses to call a code-less 403 "valid
credentials" precisely because the code is falsy, and filling it in from the
status would have silently inverted that. A test pins it.

### Why the suite could not see any of it

Every existing test for these paths feeds a **coded** error through a Stubber
(`NotImplemented` + 501) — the one shape that cannot expose a missing
HTTP-status fallback. And the existing hard-error test asserted only
`success is False` and the error code, never the statuses, so the
"cleanly deletable" answer sat under a passing test. The new tests drive the
real client against a real socket answering like a gateway; 8 of the 13 fail
against the previous code.

### Verification

- `sidecar`: 1346/1346 pytest (1333 + 13 new), `ruff check app` clean.

## [0.73.0] - 2026-08-09

_Scrolling down never arrived._

### Fixed — opening a conversation left you three screens above the newest message

Reported from the shipped app: *"界面一直玩下拉。就会无限白屏"* — you keep scrolling
down, you never get there, and what you scroll through is blank.

The thread went to the bottom with a one-shot
`scrollIntoView({ behavior: "smooth" })`. A smooth scroll animates toward a
target measured **when it starts**. A thread of real answers is still working
out its own height at that moment — long markdown, tables and collapsed turns
all resolve after the first layout — so the animation finished short of a bottom
that had since moved, and never corrected. Worse, the scroll events it emitted
went through the thread's own `onScroll`, which measures "am I at the bottom?"
— mid-flight the answer is no, so **the app unpinned the very user it was
scrolling for**, and the follow-up that would have fixed it never ran.

Measured on a 40-turn session of realistically-sized answers:

| | before | after |
| --- | --- | --- |
| distance from the newest message after opening | **1530 px** (2.7 viewports), stable at 3 s | **0 px** |
| after clicking "jump to latest" | **1717 px** — *further away than before the click* | **0 px** |
| "jump to latest" offered after landing | yes | no |

Going to the bottom now converges instead of animating once: jump, re-measure
next frame, jump again, until the height holds still for three consecutive
frames or a 90-frame budget runs out. It is bounded by frames rather than by
clock, so it cannot spin, and a real scroll gesture (`wheel` / `touchmove` /
`keydown`) hands control straight back — following the conversation must not
become a trap for someone scrolling up to re-read a tool result.

### Fixed — `content-visibility` on thread items, removed on measurement

`.thread-item` carried `content-visibility: auto` with
`contain-intrinsic-size: auto 96px`, added to skip layout/paint for off-screen
items in a long history. Both halves failed measurement:

- **96 px does not fit the content.** Real items are bimodal — a collapsed old
  turn measures 36–65 px, an expanded answer with a table measured 1616 px, a
  45× spread no single constant covers. On a thread of realistic answers the
  scroll container reported 6310 px and grew to 9927 px as items were actually
  laid out, so the scrollbar under-reported the conversation by **52%** until
  you had scrolled through all of it — which is also what made the bottom
  recede while you chased it.
- **It bought nothing.** Scripted scroll over 400 items / 34622 px — precisely
  the case it was written for — measured p50 16.6 ms either way, with the tail
  *worse* with it on: p90 19.6 vs 17.9 ms, p99 29.8 vs 27.4 ms, max 31.7 vs
  27.9 ms. Same at 60 items. The thread already bounds its own DOM by paging
  ("load earlier"), which is the optimization that does work.

### Why the suite could not see either one

`longthread.spec.ts` opens a 30-turn session and passes, because its seeded
answers are one line each — 36–65 px, small enough that the container barely
grows after first layout. Every scroll assumption in the app had only ever been
exercised against content that never moves. The seeder now takes a `"tall"`
shape (heading, paragraphs, a 24-row table, a list) and `landing.spec.ts` drives
it; all three of its cases fail against the previous code.

### Verification

- `frontend`: 124/124 E2E (Playwright, real sidecar + production bundle),
  236/236 unit, `tsc --noEmit` and the E2E project typecheck clean.
- `sidecar`: 1333/1333 pytest, `ruff check app` clean.

## [0.72.0] - 2026-08-09

_The answer streamed, then the turn persisted nothing._

### Fixed — the content disappeared when the turn settled

Reported from the shipped app: the answer streams in, and when the turn settles
it is gone.

The live bubble and the persisted message come from **two different objects**.
The stream is built from the accumulated text deltas; what got stored was
`result.final_output`, with no guard:

```python
final_text = getattr(result, "final_output", "") or ""
```

The client keeps its streamed bubble only until the thread reloads the turn from
the server — at which point the persisted message replaces it. So an empty
finalization never failed loudly. It silently replaced text the user had watched
arrive with nothing.

Measured by driving **both** turn endpoints and reading the stored row back
(`assistant: ''` on each). Four realistic inputs persisted an empty answer:

| model output | persisted before |
| --- | --- |
| `final_output` empty — a server that streams `delta.content` but returns an empty aggregate | **empty** |
| `final_output` is `None` | **empty** |
| the answer wrapped entirely in `<think>…</think>` | **empty** |
| the answer is only the contract JSON block | **empty** |

The first two are provider behaviour this app does not control, and **none** of
the four is a shape a scripted test double produces — which is why 1300+ tests
were green while the shipped app lost answers.

The cancel path already rebuilt the answer from the streamed text. The success
path — the overwhelmingly common one — did not. That asymmetry was the bug.

The guard now lives inside `_finalize_contract`, **after** the parse, so every
call site is covered: a parsed answer wins (it is authoritative); otherwise the
sanitized streamed text, exactly as the cancel path does it; otherwise a message
saying the model returned nothing readable. Never an empty bubble — that is
indistinguishable from a broken app.

### Fixed — reasoning that appeared after the turn settled

The persist-time chain-of-thought stripper removed only **paired** `<think>`
blocks. The live stripper correctly holds back an unclosed one, so the user read
a clean answer while it streamed — and then the model's raw reasoning appeared in
its place once the thread reloaded the turn. Unclosed openers are now stripped
too, so hidden reasoning never reaches the answer by either route.

### Changed — an empty answer is no longer a valid outcome

`test_an_empty_answer_is_persisted_as_an_empty_answer_not_a_crash` asserted
`content == ""`. Surviving a silent model is still the point, but storing an
empty message is the other half of the defect above, so the floor is now "says
something".

### Checks

`pytest -q` 1333 passed · `ruff check app` clean · `vitest run` 236 passed ·
`playwright test` 121 passed · `tsc --noEmit` and `npm run build` clean · CI 7/7.
The 10 new sidecar tests fail 10/10 against the unfixed code, and
`e2e/persisted.spec.ts` (4) reproduces the symptom in a browser.

## [0.71.0] - 2026-08-09

_The predicted defect was not there; the two that were are both in our own
tooling._

### Added — the four review lenses, against endpoints that cannot answer

v0.70.0 found the account survey saying "No publicly exposed buckets detected"
for a check that never ran. The bucket review produces the same **shape** of
output — a verdict the agent narrates — from the same config sub-resources, so
it was the obvious next place to look for that bug.

**It is not there.** Measured against three endpoints, the review distinguishes
all three states in its own `overall_status`:

| endpoint | `overall_status` | findings |
| --- | --- | --- |
| minimal S3-compatible (`501 NotImplemented`) | `provider_limited` | 33 × "Provider unsupported", named aspect by aspect |
| credentials without access (403) | `partial_access` | 33 × "Access denied reading …" |
| an endpoint that answers | `reviewed` | `[Good] Not public (policy verdict + ACL check)` |

The clean verdict states its own basis, and `_unsupported_findings` even covers
the unexpected-error case with a comment that reads like the lesson v0.70.0 had
to learn the hard way: a read error "is NOT 'no problem'".

`e2e/review.spec.ts` (3 tests) pins it. Pinning good behaviour is worth doing
precisely because the survey shows how quietly this property is lost: the data
was honest there too, and one collapsed branch one level up turned "could not
check" into "nothing wrong".

### Fixed — the release shipped placeholder notes without complaining

`release.yml` fell back to `See [CHANGELOG.md](CHANGELOG.md).` when the version
had no CHANGELOG section — pointing at a file that, by definition, did not
document the release. **v0.70.0 shipped exactly that way**, and nothing anywhere
said so. A missing section is always an authoring mistake and is trivially
fixable *before* the tag exists, so the release is the right thing to stop. It
now fails with a message naming the missing section.

### Changed — a race detector that failed without evidence

`test_many_concurrent_pairs_lose_no_audit_or_call_row` failed once on CI
(239/240) and has not reproduced in **34 local runs**, including six parallel
copies under contention. Three candidate mechanisms were measured and
**disproven**: the test is faithful to production (the SDK gives each concurrent
sync tool body its own thread — measured, two distinct thread ids, both off the
event loop); a read racing a commit on the shared connection does not raise (0
errors in 4000 rounds); and leaked fixtures were ruled out on a clean sidecar.

The failure remains **unexplained**. Rather than theorise a fourth time, the
detector now captures every invocation's return value and asserts none raised or
returned an error, so the next occurrence names the dead call and carries its
message instead of printing `239 == 240`.

### Checks

`pytest -q` 1323 passed · `ruff check app` clean · `vitest run` 236 passed ·
`playwright test` 117 passed · `tsc --noEmit` and `npm run build` clean · CI 7/7.

## [0.70.0] - 2026-08-08

_"No publicly exposed buckets detected" was also what the survey said when it
never looked._

Documented after the fact: v0.70.0 shipped with placeholder release notes
because this section was missing at tag time. That gap is what the v0.71.0
release-workflow fix above now prevents.

### Fixed — a clean bill of health for a check that never ran

The account survey's public-exposure line is not a UI string: it lands in the
run's `final_summary`, the agent reads it, and narrates it to the user as a
security conclusion.

It had **two** branches — exposed, or "No publicly exposed buckets detected" —
and none for *could not determine*, so a bucket whose policy/ACL probes never
**answered** fell into the reassuring one. Measured in a browser against four
endpoints; three produced the identical verdict:

| endpoint | exposure probes | verdict (before) |
| --- | --- | --- |
| minimal S3-compatible (`501 NotImplemented`) | **never ran** | "No publicly exposed buckets detected." |
| AWS creds without `s3:GetBucketPolicyStatus` (403) | **never ran** | "No publicly exposed buckets detected." |
| full AWS, genuinely private | ran | "No publicly exposed buckets detected." |
| full AWS, one bucket public | ran | "PUBLIC EXPOSURE: 1 bucket(s)…" |

The first two are not corner cases. MinIO, Ceph and garage — the S3-compatible
systems this product exists to diagnose — answer 501 to most bucket-config
sub-resources, and a least-privilege AWS role routinely lacks
`s3:GetBucketPolicyStatus`. **Rule 18** is exactly this: a capability gap is
reported, never silently resolved into a verdict.

`account_tools` already modelled it honestly — `publicly_exposed` is `None` when
the probes do not both answer. The collapse was one level up. `exposure_note()`
now has three outcomes, names the buckets and the reason, publishes a
warning-severity finding, and does not let the severe case swallow a remaining
gap.

### Added — the agent's heavy path, end to end

Of 43 agent tools, four had ever run end to end. `e2e/survey.spec.ts` (6 tests)
adds the stateful ones and **found nothing else broken**: `load_tools`
progressive disclosure, `survey_account` spawning a real run,
`query_account_profile` answering from the persisted profile with no new S3
calls and no raw keys, and — verified in a browser for the first time —
CLAUDE.md's rule that an agent-invoked run **never surfaces as a run card**.

`e2e/fake-s3.ts` grew realistic sub-resource behaviour (`full` / `unsupported` /
`denied`, per-bucket `policyStatus` and ACL, and the 404 codes AWS really
returns for unset configuration).
`tests/test_v070_exposure_undetermined.py` (10 tests) pins the branch against the
**production** function.

### Fixed — the E2E harness now fails loudly when a stray sidecar owns the port

A sidecar leaked from an interrupted run held the port; later runs talked to that
stranger while the state file sat empty, so `seedSession`'s bare `JSON.parse`
threw and exactly the four seeding specs failed with `Unexpected end of JSON
input`. The guard read `exited` at a single instant — a race — so it now confirms
**identity, not timing**: our sidecar creates `app.db` in the data dir we just
made for it, and a stranger never touches it.

## [0.69.0] - 2026-08-08

_The settings drawer again — v0.68.0 fixed how its controls are NAMED; this is
how they report what is CHOSEN._

### Fixed — selection state that existed only as a colour

Theme, Language, and the two provider tabs each carried the active option in
`bg-accent` and nothing else. Measured in a browser, all four buttons came back
`aria-pressed=null aria-checked=null aria-current=null`, with no group name
either:

| control | active option conveyed by |
| --- | --- |
| Language (English / 简体中文) | `bg-accent`, nothing else |
| Theme (Dark / Light) | `bg-accent`, nothing else |
| Model Providers / Cloud Providers | the button `variant`, nothing else |

So a screen reader announced "English, button" and "简体中文, button" with no way
to tell which one the app is using — and forced-colours / high-contrast mode
loses the accent entirely, leaving no signal at all.

`aria-pressed` is the app's OWN pattern for this: the composer's attach-type
toggle and the session inspector's filter chips both set it. These two controls
had simply diverged from it. The visible caption above each group is now the
group's accessible name (`role="group"` + `aria-labelledby`) rather than
unattached text.

`e2e/a11y.spec.ts` (5 tests) reads the state the way assistive tech does, not by
class name. 5/5 fail against the unfixed code.

### Added — the app in Chinese, rendered by a test for the first time

All fifteen prior E2E specs open with `localStorage.setItem("saw.lang", "en")`.
Deliberate — assertions on English copy are stable — but it meant the Simplified
Chinese UI had never been rendered by any test, in a product whose users work in
Chinese.

`e2e/zh.spec.ts` (5 tests) drives it: the start surface, the rail and its ⋯
menu, the settings drawer down to the provider form, a finished turn's own
footer and trace, and switching language mid-session then surviving a reload.

**Nothing was found broken.** The dictionaries check out too — parsing the
actual `const en` / `const zh` object ranges gives **414 keys each, zero missing
on either side, zero placeholder mismatches**; the only three shared values
(`Head Bucket`, `Base URL`, `Endpoint URL`) are terms Chinese operators use in
English anyway, and `prov.fAccessKey` / `prov.fSecretKey` stay English on
purpose because that is what the consoles and SDKs call them. Those are now
pinned so a well-meaning future translation does not make them unfindable.

An earlier pass of this analysis reported 147 keys missing from Chinese. That
was a bad file split, not a real gap — recorded here because the corrected
number is the one that matters.

### Checks

`pytest -q` 1313 passed · `vitest run` 236 passed · `playwright test` 108 passed
· `tsc --noEmit` and `npm run build` clean.

## [0.68.0] - 2026-08-08

_Connecting to storage had never been driven end to end, and the form you do it
in named its own fields wrong._

### Added — browser → sidecar → boto3 → a real S3 socket

`e2e/fake-s3.ts` is the Node counterpart of v0.66.0's `tests/fake_s3.py`: a
socket that answers S3 XML, reachable from the Playwright process the way
`fake-model.ts` is. With it, `e2e/connect.spec.ts` (9 tests) drives the whole
chain for the first time in this repo.

`providers.spec.ts` creates a provider whose endpoint points nowhere — right for
its security assertions, but it left the question a user asks FIRST on a fresh
install unanswered by any test: *does this connection work?*
`CloudProviderTester`, the panel that answers it, had **no coverage of any
kind** — not a unit test, not a browser test.

**On this surface nothing was found broken.** What now holds, measured:

| | |
| --- | --- |
| the happy path | Test Connection reaches the endpoint and reports which one answered; List Objects returns the bucket's real keys; the agent answers "what is in acme-logs?" from a listing that came off the socket |
| the failure path | a 404 arrives as `NoSuchBucket`, not a blank card; a 403 `SignatureDoesNotMatch` is named, not swallowed — an operator with a wrong endpoint sees this panel and nothing else, so what it says IS the diagnosis |
| the rules | `max-keys` is on the WIRE, not applied after the response (rule 12); 100 real objects summarise to ≤20 samples while the count stays truthful (rule 16); no secret reaches the DOM or the API after a call that actually signed with it (rules 1/2/4); a bucket outside the configured allowlist is refused **without the endpoint being contacted at all** |

### Fixed — form controls were named by their own hint text

`Field` wrapped a `<label>` around the control *and* the hint. A wrapping label
with no `for` contributes its whole subtree to the control's accessible name, so
measured in a browser against the real Add-cloud-provider form:

| control | announced as |
| --- | --- |
| Provider | `ProviderAWS S3Alibaba Cloud OSSTencent Cloud COSBaidu BOSVolcengine TO…` |
| Access key ID | `Access key IDStored only in the encrypted local vault — never shown ag…` |
| Secret access key | `Secret access keyStored only in the encrypted local vault — never show…` |

A `<select>` is the worst case: its own option list becomes part of its name, so
a screen-reader user hears every preset read out before anything useful.

`Field` backs 25 controls across the add-provider form and the evidence-import
dialog, 12 of them with a hint — the two forms a user must complete before the
app does anything at all.

Fixed the ordinary way: `<label for>` names the control, and the hint attaches
with `aria-describedby`, which is what a hint IS — a description, announced
after the name, not part of it. An explicit `id` on the control still wins.

### Checks

`pytest -q` 1313 passed · `vitest run` 236 passed · `tsc --noEmit` and
`npm run build` clean. The fix was confirmed to fail against the unfixed code
first (2 of 5 new `Field` tests).

## [0.67.0] - 2026-08-07

_Read the report the app actually produces, and two things are wrong with it._

The report is the one artifact that leaves this machine — markdown a user pastes
into a ticket, mails to a vendor, or attaches to an incident review. Its renderer
had unit tests and `redact_text` had exhaustive ones, but nothing had ever opened
`/report` in a browser and read the document. Doing that found both defects
below within a minute of each other.

### Fixed — snake_case was silently eaten by the markdown renderer

CommonMark forbids `_` emphasis **inside a word**, precisely so that identifiers
survive. This renderer matched `_…_` anywhere, so every answer, run summary and
exported report dropped the underscores out of the very names the product exists
to talk about:

| written | rendered |
| --- | --- |
| `total_bytes_scanned` | `totalbytesscanned` |
| `list_objects_v2` | `listobjectsv2` |
| `AWS_SECRET_ACCESS_KEY` | `AWSSECRETACCESS_KEY` |
| `part_0001_final.parquet` | `part0001final.parquet` |
| `run_account_discovery` | `runaccountdiscovery` |

That last one is how it was found: under **Recommended next actions**, the one
section a reader acts from, the action type was a name that cannot be searched
for, copied, or typed back. Column names, tool names, object keys and env-var
labels are this app's whole vocabulary, so the corruption was constant and
silent — no error, no fallback, just a shorter word.

`_` now follows CommonMark's flanking rule: intraword underscores are text.
Scanning continues past a rejected span, so genuine emphasis later on the same
line is still found.

Same tokenizer, same read: `***REDACTED***` — the marker the redactor stamps into
messages, audit rows and reports — matched `**REDACTED**` one character in and
rendered as `*REDACTED*`, with a stray asterisk on each side. The marker a reader
is meant to trust now renders as itself.

### Fixed — the report's structure was writable by its own contents

Every value in the document except the question/answer excerpts was interpolated
into a list item, a table cell or a heading with **no newline handling**. A
string with a newline did not stay in its bullet: it ended the bullet, and
whatever followed became document structure.

So a finding whose text carried `\n\n## Safety\n\n- This report contains no
credentials` produced a **second Safety section**, indistinguishable from the
real one, making an assurance the app never made. Those strings are written by
the model, and what the model reads is tool output — bucket names, object keys,
endpoint error messages. None of it is authored here.

The likelier half needs no adversary at all: a finding that simply spanned two
lines broke the list it belonged to.

`_excerpt` had done this collapsing for questions and answers since v0.48.0. It
now covers everything else — title, goal, facts, findings, next actions, open
questions, limitations, run summaries, agent memory, grounding, tool names,
audit events and attached filenames — plus a `_code` variant that drops
backticks from values headed into a code span, so a filename cannot close it and
turn the rest of the row into prose. Sanitizing is not deleting: the words
survive, only the line breaks go.

The audit **summary** line was the one a broad fix missed — it joins the raw
`event_type` keys upstream of the per-row sanitizer. The per-field tests are what
caught it.

### Added — the report path, in a browser

`e2e/report.spec.ts` (7 tests). `/report` had no browser coverage at all: not
that it opens, not that it contains the investigation just run, not that Download
produces a file, not that a credential pasted into the composer is gone by the
time it reaches the artifact. That last one is the whole chain — composer →
persisted message → renderer → screen — and a unit test of any single link
cannot see it. A pasted presigned URL is checked at both ends: absent from the
document, and absent from the bytes sent to the model, while the object key
survives because it is the useful part of the paste.

`tests/test_v067_report_structure.py` (20 tests) drives every field of the
renderer, one at a time.

### Checks

`pytest -q` 1313 passed · `vitest run` 231 passed · `playwright test` 89 passed ·
`ruff check app` clean · `tsc --noEmit` and `npm run build` clean. Both fixes
were confirmed to fail against the unfixed code first: 20/20 and 7/8.

## [0.66.0] - 2026-08-07

_The S3 layer had never spoken HTTP._

### Added — the read-only S3 tools, driven against a real socket

Everything below the tools was covered with a botocore `Stubber`, which replaces
the client's response **after** the request is built. That covers response
handling and nothing else: it never serializes a request, never signs one, never
sees a URL, and **cannot tell path-style from virtual-host addressing** — the
single most common S3-compatible misconfiguration, and the thing this product
exists to diagnose.

`tests/fake_s3.py` is a socket that answers S3 XML. It does not verify
signatures — a double that re-implemented SigV4 would be testing botocore, not
this app — and implements only the read-only operations the whitelist uses. What
it buys is the request half.

**Nothing was found broken.** 19 tests, all passing, over both halves:

| | |
| --- | --- |
| the request boto3 **built** | path-style puts the bucket in the path; `max-keys=1` is on the wire (rule 12 bounds the *request*, not a post-filter); a prefix is applied at the endpoint; the access key is signed into `Authorization`, never a query param |
| real HTTP → this app's shape | a live listing returns the real objects; a 404 is a structured failure, not an exception; `GetBucketLocation` answers where the bucket lives |
| the rules | at most 20 sample keys out of 100 real ones (rule 16); `NotImplemented` is `Provider unsupported`, never broken credentials (rule 18); no credential value survives into a result even when the endpoint echoes both back in an error (rules 1/15) |

The flagship probe gets its own test. botocore never virtual-hosts against an IP
endpoint — it silently sends the identical path-style URL — so probing both would
report "both work" on the single most common S3-compatible setup (MinIO/Ceph on
an `IP:port`). The fake endpoint **is** an IP, which is what makes this testable
at all: the probe must say it cannot be tested rather than answer wrongly. It
does.

### Corrected — two assertions of mine that were wrong about the product

Written, run, failed, and then read the code rather than "fixing" it:

- **`AccessDenied` on ListBuckets is not a credentials failure.** Plenty of S3
  deployments deny `s3:ListAllMyBuckets` to perfectly valid credentials, and
  reporting that as "your credentials are broken" would send an operator to
  rotate keys that were never the problem. `test_credentials` deliberately
  returns success with *authenticated (ListBuckets denied)*. Both sides are now
  pinned — including that a genuine auth-failure **code** at the same 403 is
  still a failure.
- **`NotImplemented` is a capability gap, not an error** (rule 18). Same shape.

### Fixed — the double read every S3 sub-resource as a plain listing

`parse_qs` drops valueless keys by default, and S3 sub-resources are exactly
that: `?location`, `?versions`, `?uploads`. So `GET /bucket?location` fell
through to the object-listing branch and returned a `ListBucketResult`, which
boto3 parsed into a region of `"\n  "`. A defect in the test double, found
because the assertion was written against the real answer rather than against
whatever came back.

Sidecar: 1274 → 1293.

## [0.65.0] - 2026-08-07

_Two capabilities that had never been driven end to end, and a sweep for the
defect class behind the Stop button._

### Added — attach a file, ask about it, get an answer, in a browser

The pieces were covered separately: the sidecar suite tests the upload endpoint
and the DuckDB engine directly, and `attach.spec.ts` covers the picker. What
nothing covered was the path a user actually takes — pick a file, ask, watch the
agent find the upload, run the local analysis, and answer from real numbers.

The scripted model is **reactive** for this. `analyze_uploaded_file` takes the id
that `list_uploaded_files` just returned, so a constant script cannot call it;
the double now reads that id out of the tool result the way a model does. Without
it, the only testable shape is a tool call with constant arguments — which is not
what the agent does, and would have made this test a decoration.

`e2e/analyze.spec.ts` asserts, against the real stack: the answer arrives; the
trace shows both tools **in the order they ran**; the DuckDB result handed to the
model carries this file's real numbers (120 rows, `GLACIER`, storage classes) so
the analysis is not a guess; **at most 20 object keys reach the model** out of 120
distinct ones (rule 16 — aggregates, not a row dump); and the whole exchange
survives a reload.

### Added — redirecting a running turn is tested

Pressing Enter while an answer streams does not queue and does not no-op: it
cancels the running turn and sends the new one, keeping what the first had
already produced. Real machinery — a cancel, a wait for the turn to settle, a
latest-wins payload, a composer that must not be left holding text it already
sent — and no browser coverage.

`e2e/steer.spec.ts` covers all of it, plus the thing the UI cannot show: the
redirected turn is not left **registered server-side**, asked of the sidecar
directly, because a turn nobody is running is what the next question would wait
behind. **Everything passed** — reported because "we checked and it holds" is a
result, and because steering shares `stop()` with the Stop button, which turned
out never to have worked at all (v0.64.0). Steering was unaffected only because
it passes a session id explicitly.

### Checked — the Stop button's defect class does not recur

The Stop button broke because a function with an optional first parameter was
handed to `onClick`, which called it with the click event. Every
`onX={someFunction}` binding in the components was re-read: the rest take no
meaningful first argument, so the event is simply ignored. **No second
instance.** Worth stating that the type system cannot catch this —
`(x?: string) => void` is assignable to `() => void` — so the only defence is
not passing such a function bare.

E2E: 72 → 82.

## [0.64.0] - 2026-08-07

_The other file this product ingests was read as the wrong one, on both sides._

### Fixed — a conversation could stay invisible for as long as the window was open

The thread fetched its session ONCE on open and never again. Reload the app in
the moment between a turn ending and the worker committing it — reliably
reachable by pressing Stop and reloading — and that single fetch came back
empty, so the investigation was not there. Measured, with the app and the server
asked at the same time:

```
UI-EMPTY: true | SERVER-MESSAGES: 2
AFTER-5S: UI-EMPTY: true | SERVER-MESSAGES: 2
```

The data was safe. The window simply never asked again. This is the shape of
"the history is all gone" that survives a correct backend.

An existing session that loads EMPTY now gets one more look, 1.2 s later, once
per session. A genuinely empty session pays a single request; the alternative is
a conversation the user cannot get back to without clicking somewhere else and
back. Reproduced at 3-in-6 before the fix, 8-in-8 after.

**What it is NOT:** the server was checked first, in isolation, and keeps
everything — the partial answer with its stopped marker, the question, the
released turn handle — whether the cancel lands after 50 ms or a second, and
even when the client hangs up mid-stream (`test_v065_cancelled_turn_is_kept.py`,
12 tests). Separating the two is what turned an intermittent browser symptom
into a one-line cause.

### Fixed — the E2E seeded three sessions with the same name

`seedSession` numbered its titles from a module-level counter, and Playwright
runs each spec file in its own process — so three files each produced "seeded
investigation 1" and a rail assertion found four rows where it expected one. It
passed locally and failed on CI, which is the worst way for a fixture to be
wrong: it reads as a product failure. Titles are random now.

### Fixed — the Stop button never stopped anything

`Thread` passed the runner's `stop` straight to the button:

```tsx
onStop={runner.stop}          // React calls it with the CLICK EVENT
```

`stop(sessionId?: string)` then did `turnsRef.current.get(<SyntheticEvent>)`,
found nothing, and took its silent early return. So pressing Stop **did nothing
at all**: no cancel request reached the server, the stream was never aborted, the
model kept generating, the tokens kept being spent, and the full answer arrived
minutes later over the one the user had tried to stop. No error appeared
anywhere, because nothing failed — the wrong lookup simply missed.

Measured before the fix: after clicking Stop, the network log contained **no**
`POST /sessions/{id}/turns/{turn_id}/cancel`, and the answer streamed to
completion. After: the cancel lands, the partial answer is persisted, the thread
says *Stopped by user*, and the turn takes seconds instead of running out the
clock. Three of the four new tests fail against the unfixed code.

`stop` is now also defensive about its argument, because handing it to `onClick`
is exactly how it gets misused, and a silent miss is the worst possible way to
find out.

### Added — interrupting a turn is tested

`e2e/interrupt.spec.ts`: Stop replaces Send while streaming; pressing it ends the
turn and says who ended it; the partial answer is kept and survives a reload; and
a stopped turn does not block the next question (the server-side turn handle has
to be released, or the next one waits behind a turn nobody is running).

The scripted model gained a `deltaDelayMs` knob. A model that answers instantly
leaves no window to press Stop in — which is why this could not be tested
before, rather than why it was skipped.

E2E: 68 → 72.

### Added — a real agent turn, in a browser, at last

Every E2E spec runs with no model provider — deliberately, because the offline
paths must work on a fresh install. The consequence was that the app's **main**
path had never been driven from a browser at all: nothing ever watched a question
become a streamed answer and then a persisted turn with a footer and actions
under it. That is precisely where the v0.63.0 bug was felt, and no browser test
could reach it.

`e2e/fake-model.ts` is a local OpenAI-compatible endpoint (the node counterpart
of `sidecar/tests/fake_model.py`). `e2e/agent.spec.ts` now covers, against the
real stack: the answer arriving without the metadata block leaking into the
prose, the finished turn keeping its footer and expanding to the trace, copy /
edit / branch on the question, the agent's proposal rendering as a chip, a second
turn appending rather than replacing, both exchanges surviving a reload, and no
credential value reaching the model.

### Changed — the app no longer says "nothing here" while it is loading

Two changes, both about the same moment: reopening the app.

- The open investigation is read from local storage **at mount** instead of after
  the session list returns. It used to wait on that fetch, so a returning user
  watched the empty start surface until it came back.
- `isEmpty` did not distinguish "a session is open and its content is still
  loading" from "this is a new chat", so the start surface — *How can I help with
  your storage?* — rendered over an investigation that was right there. For
  someone who has just been told their history vanished, that is the worst
  possible sentence to flash.

**Stated honestly:** this was found as a 1-in-6 flake in which the new reload
test caught the start surface on screen. Neither reverting the change nor
delaying `/sessions` reproduces it on this machine, so the flake's cause is
**not proven** — these are defensible improvements and a guard for the
behaviour, not a demonstrated fix for that failure.

### Fixed — a leaked sidecar made the E2E fail several layers from the cause

If an interrupted run left a sidecar holding the port, the new one exited with
"address already in use" while the health probe passed against the stranger. The
suite then seeded one data directory and talked to another, surfacing as
`no such table: sessions`. Global setup now notices that its own child exited and
says so.

E2E: 61 → 68.

### Fixed — an object inventory was silently parsed as access logs

`detect_log_format` called a CSV "access-log csv" when its header shared **one**
token with the access-log column list. An S3 inventory header is
`bucket,key,size,storage_class,last_modified` — `key` and `size` are both on that
list. So an inventory attached as access logs was ingested with the object key as
the request path and the object size as bytes sent: no status, no method, no
timestamp, no row rejected, and nothing said. The user got a table of request
metrics in which every number was meaningless.

An inventory is the *other* file this product ingests, which makes it the one
false positive that matters. It is now identified by the columns only an
inventory has (`storage_class`, `version_id`, `is_latest`, `e_tag`,
`is_delete_marker`, `replication_status`, …) and **only** when the header carries
no request-shaped column — an access-log export may legitimately name a
`storage_class` alongside a status, and that is still a log. `import_access_logs`
refuses such a file with a message that names the fix, rather than producing a
plausible-looking table of nonsense.

### Fixed — `catalog.csv` was auto-typed as an access log

The frontend half of the same defect. `inferDatasetType` ran a name hint before
the extension rule — deliberately, because `access-logs.parquet` is a columnar
log export that the extension alone gets wrong — but the hint was
`name.includes("log")`. Measured:

| filename | typed as | should be |
| --- | --- | --- |
| `catalog.csv` | **access log** | inventory |
| `logistics-export.csv` | **access log** | inventory |
| `backlog.csv` · `dialog.csv` | **access log** | inventory |
| `logical-inventory.parquet` | **access log** | inventory |
| `accessories.csv` | **access log** | inventory |

`logical-inventory.parquet` is the one that says it: the filename contains the
word *inventory* and it still went to the log engine. Matching is now on word
boundaries, with the run-together spellings (`accesslog`, `accesslogs`) named
explicitly rather than reached by accident. The rule moved to `datasetType.ts`
with its own tests — it was a closure inside `Thread.tsx` and could not be tested
at all.

### Fixed — an inferred file type could not be corrected

The type chip rendered as a plain label once inferred, and as a pair of buttons
only when nothing could be inferred. So the case where the guess is **wrong** was
exactly the case with no way to say so. It is now always a two-way choice with
the current one marked; the "Analyze as:" prompt appears only when there is
genuinely nothing to go on.

### Added — the attachment path is tested through a browser at last

"Analyze the file you attached" is a headline capability whose browser half had
**no** coverage: the sidecar suite tests the upload endpoint and the DuckDB
engine directly, and no E2E ever picked a file. `e2e/attach.spec.ts` drives the
hidden file input, inference for each extension, the ambiguous-type prompt,
correcting an inferred type, the send button's dependence on an attachment, and
that the file actually reaches the sidecar — asked of the sidecar directly rather
than through the page, whose origin is the preview server.

E2E: 52 → 61.

## [0.63.0] - 2026-08-06

_Every investigation that called a tool became unopenable. The test suite was
green because its fixtures described the schema instead of the writer._

### Fixed — a session that ran a tool answered 500 and could not be opened

`SessionMessageOut.tool_activity` was declared `list[dict[str, str]]` back when a
trace row really was four strings. v0.56.0 then started recording what a call
actually did:

| field | written since | type |
| --- | --- | --- |
| `duration_ms` | v0.56.0 | `int \| None` |
| `ok` | v0.55.0 | `bool` |
| `args` | v0.53.0 | `dict` |

Pydantic v2 does not coerce any of those into `str`, so the response model
raised and **`GET /sessions/{id}` returned 500 for every session containing a
completed tool call** — that is, every real investigation. Measured, not
inferred: the same rows served fine from `GET /sessions/{id}/messages`, which
returns a plain dict and is therefore unvalidated.

What that looked like in the app, and why both reported symptoms follow from it:

- **The thread stopped growing.** `Thread.reload()` deliberately keeps the
  previous content on a failed refresh rather than blanking a populated thread,
  so `detail` froze at the state before the first tool call. Every later answer
  was persisted and never displayed.
- **The three actions under an answer disappeared.** With the reload failing,
  the finished answer stayed on screen as the *live streaming* bubble. The turn
  footer, copy / edit / branch and the proposal chips all hang off a persisted
  message, so none of them rendered.
- **The failure named the wrong layer.** An unhandled exception escapes outside
  `CORSMiddleware`, so the browser got a response with no
  `Access-Control-Allow-Origin` and reported `TypeError: Failed to fetch`. A
  broken endpoint read as an unreachable sidecar.

`ToolActivityOut` now types the row against its producer, with `extra="allow"`
so a field the writer adds reaches the reader instead of being dropped
(`audit_error`, present only when a rule-17 audit write failed, is exactly such
a field — its presence is the signal).

### Fixed — relaunching the app opened a blank page

`activeId` started as `null` and nothing restored it, so quitting the app — or
any reload — landed on the empty "New chat" surface with the conversation
sitting unread in the rail. An investigation here runs over days, which makes
"where was I" the app's most common first question. The open session id is now
remembered, and restored only onto a session that still exists.

### Fixed — one corrupt column no longer takes a whole session down

`list_messages` decoded five JSON columns with a bare `json.loads` inside the row
loop, so a single unreadable value made the entire conversation unopenable.
A damaged trace now degrades to an empty trace.

### Fixed — an unhandled server fault answers a readable 500

It carries the exception *type* and nothing else (a message can quote the
request that produced it), with the CORS grant the browser needs to read the
status at all. The traceback still goes to the local log.

### Added — the conversation is a landmark, and the suite finally reads it

The shell had no `<main>`: a screen reader could not skip the rail, and a test
asserting "in the thread" had nothing to scope to. It had been matching the
**rail**, which repeats every session title — the ordering assertion in this
work passed against a thread that showed the opposite until it was rescoped.

`e2e/history.spec.ts` covers what nothing covered: a second exchange that must
not erase the first, history across a reload, chronological order, a 12-exchange
conversation where every turn must be present, old answers that collapse and
reopen, the newest answer's footer, and copy / edit / branch on a user message.
`e2e/seed.ts` writes a realistic multi-turn session into the sidecar's own
SQLite, because the composer path without a model provider can only produce
triage cards and therefore exercised none of the message rendering.

**Why 1142 passing tests missed a 500 on the app's main endpoint.** Every
existing fixture built `tool_activity` from all-string dicts — encoding the
schema's assumption rather than the writer's real output — and no test in any
suite opened a session that had called a tool.

### Fixed — a collapsed turn repeated the question instead of the answer

Collapsing hides only the assistant half of an old turn, so the user's message
is still rendered in full directly above the collapsed row — which was labelled
with that same question. Scrolling back through thirty turns showed your own
words twice, one line apart, and never what the agent concluded. The row now
carries the answer's first claim, with the markdown stripped (`answerGist`); the
question remains the fallback for a stopped turn that persisted no answer.

### Fixed — a case with no summary could not be read

`error_triage_cases.summary` is nullable while `TriageCaseOut.summary` is `str`,
and the router used `.get("summary", "")` — which returns the stored `None`, not
the default. Same shape of defect as the one above, on a read-only endpoint.

### Fixed — the summary loader had the same unguarded decode

`get_summary` decoded five JSON columns with a bare `json.loads`, and it is read
by the same endpoint. One damaged column now costs its own field.

### Fixed — a destructive proposal could reach the thread as a chip

`FORBIDDEN_PHRASES` matches a **contiguous** token sequence, which one word in
the middle defeats. Measured against the real filter, before the fix:

| proposed `action_type` | accepted? |
| --- | --- |
| `delete_objects` | blocked ✓ |
| `delete_all_objects` | **accepted** |
| `recursive_delete` | **accepted** |
| `purge_all_objects` | **accepted** |

Rule 8 names *recursive delete* and *mass object mutation* explicitly, and the
module's own docstring says a proposal "must never even *suggest* a
mutating/dangerous operation". A surviving proposal renders as a chip under the
answer — a button offering exactly what the rules forbid.

Scope, stated plainly: **nothing could have executed it.** There is no
destructive tool in the product, and `is_forbidden_tool` gates only proposal
labels — it is not on the tool-call path, where the curated `@function_tool`
registration is the whitelist. What was broken is the promise, and the chip in
front of the user.

`DESTRUCTIVE_VERBS` now refuses a label carrying `delete` / `remove` / `purge` /
`destroy` / `wipe` / `erase` / `drop` / `truncate` / `empty` / `clear` / `reset` /
`abort` / `terminate` / `revoke` / `disable` / `overwrite` / `rename` / `expire` /
`prune` / `detach` / `unset` wherever the verb sits. A denylist over free-form
model output is only safe if it collides with nothing legitimate, so a test
holds it against the **actual registered tools** — parsed from the
`@function_tool` decorators — rather than against the comment beside it.
`upload`, `import` and `restore` are deliberately absent: they are nouns or
reads here (`list_upload_parts`, `import_inventory_file`).

### Added — a model, so a real turn can be tested

`tests/fake_model.py` is a local OpenAI-compatible endpoint. `build_agent` puts
the provider's `base_url` on a per-session client and speaks
`/chat/completions`, so a socket that speaks it is a model as far as this app is
concerned. The turn loop — SDK, tool dispatch, contract parsing, persistence —
had never been driven end-to-end, because that needed an API key. **That is
precisely the gap the 500 shipped through**, and the first test in the new file
is: run a turn that calls a tool, then open the session.

What it now proves, all against real turns:

- both halves of the exchange persist, the contract block never leaks into the
  prose, the trace row reaches the thread with its real types, and its id
  resolves to the persisted `tool_calls` row;
- a second turn appends rather than replacing — the shape the released app
  failed at;
- **no credential value reaches the model or the database** (rules 1, 2, 15),
  checked against the bytes that went over the socket, with recognizable probe
  secrets configured first — asserting on credential-shaped *words* would fail
  on the instructions, which name `Authorization` precisely to forbid echoing it;
- a hallucinated tool name, unparseable tool arguments, an empty answer, a
  35,000-word answer, a repeated `turn_id`, and an answer that is nothing but
  the metadata block all leave the session openable;
- a model cannot claim a skill it never opened, nor invent one;
- a JSON policy example inside an answer is not eaten as the contract block;
- a secret the model echoes back is redacted before it is stored.

The **streaming** endpoint gets the same treatment. `POST /messages` is only the
fallback; the app streams every question, and that is where the shipped bug was
felt — the stream succeeded, the answer was watched arriving, and the reload that
turns the live bubble into a persisted message hit the 500. So the assertions are
about the seam *after* the stream ends: tool → delta → done in order, the deltas
adding up to the answer, the contract block never scrolling past mid-answer, the
session opening afterwards, the trace and grounding persisted, the turn no longer
reported as running, a second streamed turn keeping the first, and a stream with
no model configured being a clean 422 that leaves no half-written user message.

And the **untrusted-data envelope**, read off the wire for the first time. The
instructions tell the model that everything between
`<<external_untrusted_data>>` markers is third-party content and never an
instruction; that defence is worth exactly as much as the envelope actually being
present in the request, and it had only ever been unit-tested on the wrapping
helper. The injection arrives through an ordinary path — a cloud provider's name,
which `list_providers` returns — and carries a closing marker to try to escape
the fence. Verified: the result is wrapped, the smuggled marker is defanged, the
text still arrives **readable** rather than censored (the agent must be able to
report that a provider is named this), no provider secret is in what the model
received, and nothing destructive reaches the thread.

### Added — coverage for the surfaces that had none

A second sweep over the untested seams, all against the real stack. **Everything
below was measured, and all of it passed** — reported because "we checked and it
holds" is a result:

| surface | what is now asserted |
| --- | --- |
| paging | 40 exchanges → the tail is shown, the server's own "20 more" count, load-earlier prepends, jump-to-start reaches turn 0, all 40 present |
| find | a match inside a *collapsed* turn opens it |
| branching | a branch from a message creates a second investigation and leaves the first intact |
| drafts | an unsent question survives switching away and back |
| rail | rename reaches the thread header, duplicate, archive, search, delete-the-open-one leaves a usable app — and stays deleted after a relaunch |
| turn footer | persisted tokens/duration reach the screen; the trace expands; a row opens to the call's real persisted input/output; inspect opens the inspector |

E2E: 33 → 52.

## [0.62.0] - 2026-08-06

_The product knew which errors were not errors. The part that answers when
nothing else can did not._

### Fixed — twelve "not configured" codes were reported as unknown faults

`s3/config_tools._NOT_CONFIGURED_CODES` already encodes exactly which S3 codes
mean *there is no such configuration on this bucket*, and the config-reading path
uses it to report `not_configured` rather than an error. The offline triage
playbooks knew **none of the twelve**:

| pasted code | triage said |
| --- | --- |
| `NoSuchLifecycleConfiguration` | **unknown** |
| `NoSuchTagSet` | **unknown** |
| `ObjectLockConfigurationNotFoundError` | **unknown** |
| `NoSuchBucketPolicy` | **unknown** |
| `ReplicationConfigurationNotFoundError` | **unknown** |
| `AccessDenied` *(control)* | authz ✓ |
| `NoSuchBucket` *(control)* | routing ✓ |

That lands on the worst possible reader. Offline triage is what runs when **no
model provider is configured** — an operator holding a pasted error with no agent
to ask, which is the most degraded state this product supports. For these codes
the true answer is *nothing is broken; this bucket simply has no lifecycle rule*.
Answering `unknown` turns a benign fact into a suspected fault, while the
product's own neighbouring path had the right answer all along.

All twelve now resolve to a new `not_configured` category that says plainly what
is absent and what its absence means — no lifecycle rule means nothing expires,
no public-access block means policy and ACL decide exposure alone. The entries
are **generated from `_NOT_CONFIGURED_CODES` itself** rather than retyped, and a
test walks that set, so the two lists cannot drift apart.

A separate test asserts `not_configured` and `provider_unsupported` never share a
code: one says the bucket has no such setting, the other says the endpoint has no
such API, and conflating them sends the reader down the wrong path.

### Added — ten more codes an operator actually pastes

`InvalidArgument`, `XAmzContentSHA256Mismatch`,
`AuthorizationQueryParametersError`, `IllegalLocationConstraintException`,
`EntityTooLarge`, `MalformedXML`, `OperationAborted`, `BucketNotEmpty`,
`RequestHeaderSectionTooLarge`, `CrossLocationLoggingProhibited`, plus
`KMS.KMSInvalidStateException`.

Several are **write-path** codes. This product performs no writes — but offline
triage exists for errors the user hit *anywhere*: in aws-cli, in rclone, in their
own application. Refusing to explain a write error would be answering a question
nobody asked. `BucketNotEmpty` is the one where a reader could infer the product
will clear the bucket for them, so it says the opposite explicitly, and a test
holds that line.

Coverage went from **30 codes to 53**. Tests assert every new entry names a cause
and a next check (a label is not an answer), proposes only non-mutating actions,
and never names a tool that does not exist.

### Verified — two hypotheses that turned out wrong

- **rule 18 has gaps** — false. All nine capability-sensitive tools
  (`get_object_lock_status`, `get_object_acl`, `get_object_tagging`,
  `get_object_attributes`, `list_object_versions`, `list_multipart_uploads`,
  `list_upload_parts`, `get_bucket_location`, `test_conditional_get`) route
  through the `provider_unsupported` classifier.
- **the per-step prefix grew again** — false. Still 19,148 chars (~4,787 tokens),
  unchanged since v0.58.0.

One correction to the assessment that produced this release: the triage was first
counted at 27 codes by grepping the source. The real figure was **30** — aliases
are entries too. The measurement was redone against `_BY_CODE` itself.

## [0.61.0] - 2026-08-06

_Paying twice for the same method, firing without a ceiling, drawing the wrong
shape, and only ever being able to copy a whole investigation._

### Fixed — the skill body was paid for twice, every turn

v0.54.0 put the most recently read skill into the STABLE half of the context
(`active_skill_block`) precisely so a multi-turn investigation would stop
re-reading the same method. The only thing enforcing that was a sentence in the
instructions — *"do not read_skill it again"* — and `read_skill` contained no
check whatsoever. A model that re-read paid for the body **twice in one turn**:
once in the cached context prefix, once as a tool result that then rides every
later step.

Measured across the shipped skills: 20 bodies totalling **65,224 chars**, mean
**3,261**, largest **5,966** (`storageops-security-iam-policy`).

The in-turn dedupe (`_call_key`) does not cover this — it catches the same call
twice *within* one turn, and this is a cross-turn repeat. That was verified
before concluding the gap was real.

`read_skill` now returns a short pointer when the requested skill is the one
already in context. The active skill is resolved **once, at tool-build time**,
and that timing is the whole trick: no tool has run yet, so the newest
`read_skill` row necessarily belongs to a previous turn. Resolving inside the
tool would also see this turn's own row and refuse the first, legitimate read.

### Fixed — a step could fire unlimited concurrent tool calls

v0.54.0 turned on `parallel_tool_calls`. The SDK's
`max_function_tool_concurrency` default is `None`, documented as *"starts ALL
function tool calls emitted in a turn"* — so a model emitting fifteen
`head_object` calls fired fifteen concurrent requests at the endpoint, with
nothing in between.

That is the opposite of the discipline this product applies elsewhere: the
account survey bounds its own probes to `_PROBE_WORKERS = 4`, for exactly the
reason that an unbounded fan-out at a self-hosted MinIO or Ceph endpoint turns a
diagnostic into a load test. One path was disciplined and the other was not.

The ceiling is **6** — above the survey's 4, because this is one step of an
interactive turn rather than a bulk walk and overlapping latency is why parallel
calls are on at all. The SDK queues the remainder rather than dropping it:
nothing is lost, only paced. A test asserts the SDK still exposes the knob, so a
lock bump cannot silently remove the bound.

### Fixed — the keyboard focus ring drew the wrong shape

The global `:focus-visible` rule forced `border-radius: 0.5rem` on everything it
touched, which is correct for exactly one shape. Measured across the focusable
elements, **24 are a different one**: 10 `rounded-full` pills and dot buttons, 8
`rounded-md`, 6 `rounded`. A keyboard user tabbing through the rail or the
composer saw an 8px-cornered box drawn around a fully round button, at every
stop.

The fix is to declare **no radius at all**: `box-shadow` already follows the
element's own `border-radius`, so removing the override is what makes the ring
follow the shape.

`border-radius: inherit` was tried first and is wrong — `inherit` takes the
*parent's* radius, and this rule's specificity ties Tailwind's `.rounded-*`
utilities while coming later in source order, so it would have replaced every
element's real radius with its container's. That reasoning is recorded in the
CSS so the next person does not repeat it.

### Added — branch a new investigation from a point in the thread

Whole-session `fork` has existed since v0.28.0. What was missing is the
Cursor-style *take it from here*: an investigation that went wrong at exchange 30
could only be duplicated whole and then unwound by hand.

`fork(..., up_to_message_id=…)` keeps everything through that message and drops
what followed; `POST /sessions/{id}/fork?from_message_id=…` exposes it, and a
branch icon sits beside edit on every user message. Both threads survive on
purpose — the original is the record of what was actually asked, not a draft,
which is what makes this different from the in-place edit next to it.

Three decisions worth stating rather than leaving to be discovered:

- the **message cut uses `rowid`**, which is exact;
- memory, datasets and run links have only `created_at`, so a row written in the
  **same second** as the branch message is carried rather than dropped — erring
  toward keeping a fact the agent established is the recoverable direction;
- an **unknown message id is a 404**, never a silent whole-session fork: quietly
  doing something else would hand back a session that looks right and is not.

The new session is titled `(branch)` rather than `(fork)`, so a rail full of
copies can still be read.

## [0.60.0] - 2026-08-06

_What the product promises about your data, and what it actually did._

### Fixed — twelve credential query parameters reached the model prompt (rule 1 + rule 15)

Rule 15 requires "sensitive query parameters" to be redacted. Measured against
`redact_text`, twelve credential-bearing names passed through untouched:

`password` · `passwd` · `pwd` · `secret` · `client_secret` · `access_token` ·
`refresh_token` · `credential` · `credentials` · `auth` · `session` · `sessionid`

The damaging path is the most ordinary one this product has. An operator pastes
a failing URL from a self-hosted MinIO or Ceph endpoint:

```
Getting 403 from https://minio.internal:9000/acme-logs/report.csv
  ?password=Pr0d-M1nio-R00t&access_token=eyJhbGciOiJIUzI1NiJ9.payload.sig
```

That string reached the LLM prompt **verbatim** — rule 1, not just rule 15 — and
was persisted the same way, because `add_message`'s persistence boundary calls
the same redactor. There was no second line of defense: `_contains_secret()`
returns `False` for this shape, and `assert_no_secrets_in_context` guards only
the context block, which the user's message is appended *after*.

Two new rules cover it: one anchored to `?`/`&` for URLs, one for the same
credentials pasted as a config line. Both accept a vendor prefix, which is what
`MINIO_ROOT_PASSWORD=` needs — `\b` does not match between `_` and `PASSWORD`,
so the canonical MinIO root-password variable, this product's single most likely
paste, went straight through the first version of the fix too.

Two names were deliberately **excluded**. `key` is the OBJECT key in an S3 URL,
and masking it would destroy the most useful fact in a diagnostic paste;
`Expires`/`se`/`sp`/`sv` are SAS expiry and permission metadata, not secrets, and
the secret of that family (`sig`) was already covered. Over-redaction destroys
the diagnostic this product exists to produce as surely as under-redaction leaks.
Nine ordinary-prose cases were checked to confirm the new rules change none of
them.

### Added — rule 15 is a test now, not a memory

`test_redaction.py` has twenty-odd good tests, organised by PATTERN: each covers
a shape somebody thought of. Nothing walked rule 15's list and asserted every
category on it was covered. `?password=` was never redacted not because anyone
judged it safe, but because no test existed to say otherwise.

The new suite is table-driven on purpose — one row per rule-15 category, plus
every leaking parameter name, plus the over-redaction cases. The requirement is
the test, so the next category that drifts fails CI. Verified: **31 of its 48
assertions fail** against the unfixed redactor.

### Fixed — deleting an investigation did not delete it

`sessions.delete()` promised in its own docstring that every child row is deleted
explicitly as well as by FK cascade, "so the behavior is identical if PRAGMA
foreign_keys is ever off". Four cascading tables had no explicit delete —
`error_triage_cases`, `session_agent_memory`, `session_datasets`,
`turn_metrics` — so the stated property held only while the pragma did.

`tool_calls` was worse. Its only foreign key is `run_id -> runs`, so a
conversational tool call (`run_id IS NULL`) had **no cascade and no explicit
delete**. Worse still, `data_maintenance.prune_audit_logs` skips any row carrying
a `session_id`, on the stated grounds that it is "reachable through its session
(cascade-equivalent: the session's own delete path)" — which was not true. Three
paths closed at once: no FK, no explicit delete, and a prune predicate that could
never match them. Those rows survived forever.

The weight is not disk — about 14 KiB for a 20-turn investigation. It is that a
user who deleted an investigation kept its sanitized tool inputs and outputs, the
bucket names and object-key prefixes, in SQLite permanently. The explicit delete
also makes the prune's stated reasoning true rather than aspirational.

`audit_logs` is deliberately still kept: an append-only security trail bounded by
its own retention window (rule 17), not user content a session owns. A test
asserts that, so removing it would have to be a decision rather than a side
effect.

### Verified — three hypotheses that turned out to be wrong

Recorded because a version's value includes what it ruled out:

- **uploaded files leak on delete** — false. `routers/sessions.py` `rmtree`s the
  whole session directory, so a 2 GiB upload does go.
- **repositories and routers share connections like the tool path did** (the gap
  v0.59.0's own PR flagged as next) — false. `get_conn` opens a fresh connection
  per request; the account-survey pool gives each worker its own read-only
  connection; the SSE worker uses its own `wconn`. All three multi-thread sites
  were already correct, and the concurrency line closed with v0.59.0.
- **destructive S3 operations present** — none anywhere in the tree.

One pre-existing over-redaction was found and deliberately **not** changed:
`X-Amz-SignedHeaders=host` is masked by the presigned-URL rule although it is not
a secret. It predates this release and is left alone to keep the diff on the
actual defect.

## [0.59.0] - 2026-08-06

_The lock was in the right place for two files and absent from the two that
needed it most._

### Fixed — eleven unguarded commits on the shared turn connection

v0.55.0 added `db.WRITE_LOCK` for a specific reason: parallel tool calls share
ONE connection, and a connection has ONE transaction, so thread A's `commit()`
commits B's half-written work and B's own `commit()` then raises
`cannot commit - no transaction is active`.

The lock reached `session_tools`' bookkeeping and the five memory tools. It
never reached `session_action_tools` or `session_analysis_tools`, which held
**eleven unguarded `conn.commit()` calls** between them — on agent-callable
tools (`survey_account`, `review_bucket_config`, `read_run_result`,
`list_uploaded_files`, `analyze_uploaded_file`, `aggregate_uploaded_file`, …)
that run in parallel with the guarded ones, on the same connection.

An unguarded `commit()` is worse than an unguarded INSERT: it commits whatever
transaction is open, including another thread's lock-held work in progress.

Measured against the unfixed code over 120 forced pairs:

| | |
| --- | --- |
| calls that died | **12 of 240 — 5.0%** |
| the rate that motivated the lock in v0.55.0 | 2 of 240 — 0.8% |
| memory rows nonetheless present | **120 of 120** |

That last row is the expensive part. The write **landed** and the agent was told
it had not. An agent that believes `note_fact` failed records the fact again, or
tells the user it could not save a finding that is sitting in the database — and
rule 17's audit trail disagrees with reality for the same reason.

All eleven sites, plus `runs_repo.create` and `sessions_repo.link_run`, now take
the existing lock. **This is not a change to the concurrency model.** The lock is
held for the microseconds of the write while the S3 and DuckDB calls it brackets
stay entirely outside it, so v0.54.0's parallel tool calls keep their benefit.
The worst site was the post-wait commit in `_execute_run`, which fires after
minutes of waiting on an inline run and so was maximally likely to land
mid-write.

### Fixed — a failed audit write no longer kills the tool, and no longer hides

`rec`'s audit write sat unprotected while the `note` persist block beside it had
always been best-effort. A bookkeeping failure therefore failed the read-only
tool the user actually asked for — *after* the S3 work was done, so the cost was
paid and the answer thrown away.

Swallowing it silently is the other wrong answer: rule 17 requires tool calls to
be recorded, and a gap nobody can see reads as "nothing happened". So the failure
is carried to `note`, which puts it on the live trace row (a ⚠ with the reason on
hover) and stores it on the persisted call. The `tool_calls` row is still written
either way, so the call itself stays recorded; what is marked is that its
`audit_logs` entry is missing. Absent on every healthy call — its presence, not
its value, is the signal.

### Added — the coverage is guarded structurally, not just behaviourally

Six tests. Which of them detect a bug is stated in the file rather than implied:
the three race tests and two of the three audit tests were each verified to
**fail** against the unfixed code and pass after;
`test_a_healthy_call_carries_no_audit_noise` passes either way by design — it is
a non-regression guard for the clean path.

The behavioural tests are probabilistic; a lucky run could pass. The third is
not: it reads the source and fails on any `conn.commit()` in the tool modules
that sits outside a `with db.WRITE_LOCK:` block, so the eleven sites cannot come
back quietly. It also asserts it actually found the four modules, so a rename
cannot turn it into a guard over nothing.

One implementation note worth keeping: the collision barrier in those tests runs
at a **50 ms** timeout, and that is load-bearing. After the fix the two bodies
can no longer be inside `audit.record` together — that is precisely what the fix
does — so the barrier can only ever time out, and the 10 s timeout it was
written with turned a passing run into a twenty-minute hang.

## [0.58.0] - 2026-08-06

_The gate that only ever opened, the mistake that ended the turn, the search
that was never there, and three scales still drifting._

### Fixed — the tool gate ratcheted open and never closed

v0.55.0 seeded each turn's unlocked tool groups from the session's **entire**
`tool_calls` history. A group touched once therefore stayed open for every later
turn, so a long investigation converged on carrying every schema forever and a
trivial follow-up question paid the same as the scan that opened them.

Measured on the shipped tool set:

| unlocked | schema block | ~tokens |
| --- | --- | --- |
| cold (core only, 14 tools) | 8,507 chars | 2,126 |
| everything (43 tools) | 34,826 chars | 8,706 |
| **ratchet delta** | **26,319 chars** | **6,579 per step — ~52,600 on an 8-step turn** |

Per group: object_forensics 6,961 · bucket_config 4,699 · account_wide 4,343 ·
uploaded_files 3,796 · storage_pileup 3,673 · endpoint_probes 2,847.

The seed is now a **window** — the last 40 tool calls — rather than the whole
session. 40 is chosen against the product's own numbers: a typical turn runs ~8
calls, so the window spans roughly five turns of real work (a continuing
investigation never re-unlocks), while a single heavy survey turn still keeps
everything it just used. Decaying by wall-clock instead would misread how these
sessions are worked — an operator leaves a thread open for hours and comes back
mid-investigation. Nothing is lost when the window slides past a group:
`load_tools` still reaches it in one cheap call, which is the whole design.

Ordering breaks ties by `rowid`, not `created_at` alone: the column has
one-second resolution and a turn fires many calls inside one second, so a
timestamp-only window would slice a burst at an arbitrary point.

### Fixed — calling a locked tool destroyed the whole turn

The same v0.55.0 gate created a second, worse problem. The SDK defaults
`RunConfig.tool_not_found_behavior` to `"raise_error"`, and a tool disabled by
`is_enabled` is genuinely "not found" to the runtime. The agent is **told those
tools exist** — `tool_group_catalog()` lists every group in the instructions —
so naming one before unlocking it is a predictable move, not a hallucination.
It raised `ModelBehaviorError`, which this product does not classify as
recoverable, so one wrong tool name discarded an entire investigation's evidence
and surfaced a raw error. That shipped in three releases.

The behaviour is now `"return_error_to_model"` with a formatter that makes the
correction actionable rather than merely non-fatal — it names the group and the
exact call, `load_tools(group="storage_pileup")`, and says nothing gathered is
lost. Three cases stay distinct: a known tool in a locked group gets the unlock;
a known tool in an **already open** group is told so explicitly, because sending
it to re-unlock would loop; an unrecognised name falls through to the SDK's own
message, since inventing a group would be a confident lie. The formatter runs
inside the SDK's error path and never raises.

### Added — find inside one investigation

The command palette searched session **titles**. Nothing searched what was
actually said, so eighty turns into a bucket investigation there was no way back
to the line where the retention rule was named — the one thing a long thread is
for.

`⌘F` / `Ctrl+F` opens a find bar over the thread: match count across the whole
conversation, `Enter` / `Shift+Enter` to step, wrap at both ends, `Esc` to close.
A match inside a **collapsed old turn expands it**, because finding something
the user then cannot see would be worse than not finding it. The matching is
literal, not a RegExp — an object key or an ARN routinely contains `*`, `(`, `[`
— and highlighting returns segments rather than HTML, since the thread renders
model and tool text this product deliberately never treats as markup.

### Changed — three more scales stopped drifting

v0.56.0 gave the UI a type scale and v0.57.0 guarded it. Three others were still
loose, all the same class of problem one layer down:

| | before | after |
| --- | --- | --- |
| corner radii | **10 distinct** — 7 named + `[3px]` `[5px]` `[22px]` | one declared 8-step scale |
| stacking layers | 8 values, **4 arbitrary** (`z-[60]` `[70]` `[75]` `[80]`) | 7 **named** layers |
| motion | `transition-all` ×9 | the properties each element actually animates |

The existing radius and z-index **values are unchanged on purpose**: renumbering
would have silently restyled a hundred elements and risked a stacking regression
with no way to verify short of looking at every screen. What changed is that
both are now declared — so they can be enumerated, named and guarded — and the
inline values were migrated onto them. `sm` (3px) and `3xl` (22px) exist because
the UI genuinely needed an inline mark and a composer pill, not to round out a
table. A layer now has a name to reason about: `z-toast` above `z-shortcuts`
above `z-palette` above `z-wizard` above `z-drawer`.

`transition-all` animates every property an element has, including ones that
change for reasons unrelated to the interaction — which is how a hover ends up
animating a layout shift. Each of the nine now lists what it means to animate.

`design-tokens.test.ts` grew from 3 checks to 8, covering all three. Each new
guard was **verified to fail** on reintroduced drift before being trusted.

### Verified — the dependency floor is already at the top

Every locked runtime dependency was checked against PyPI and all eleven key
packages are already latest: openai-agents 0.19.4, openai 2.53.0, fastapi
0.141.1, uvicorn 0.52.1, boto3/botocore 1.43.65, duckdb 1.5.5, pyarrow 25.0.0,
pandas 3.0.5, pydantic 2.13.4, httpx 0.28.1. Nothing to upgrade — so this
release spent the dependency work on SDK surface that was installed and unused
instead, which is where the two defects above were found.

`ModelSettings.truncation="auto"` was evaluated and **deliberately not adopted**:
it lets the endpoint silently drop the middle of the conversation, which
contradicts the product's own rule that a cut is always stated. The existing
finalize pass handles overflow explicitly and says so in the answer.

## [0.57.0] - 2026-08-06

_The turn's cost had a new shape, the answer had no shape at all, and the
frontend was a generation behind._

### Changed — 81% of the tool-output bill was re-sending what was already read

After v0.56.0 the measured 8-tool turn costs 94,817 input tokens and the split
had flipped — the fixed prefix 34%, **tool outputs 33%**, no longer a distant
third. Splitting that 33%:

| | chars | ~tokens |
| --- | --- | --- |
| first delivery of each result | 23,100 | 5,775 |
| **re-sends of consumed output** | **100,900** | **25,225 — 81%** |

An 8,000-char skill body or a 1000-key listing page read at step 3 is re-sent at
full price on steps 4 through 9.

v0.54.0 deferred this as "riskier, wants its own release" because it meant
rewriting history mid-turn. The SDK has a first-class hook for exactly this —
`RunConfig.call_model_input_filter` hands over the input list about to go to the
model and takes back a modified one — which is what makes it safe now rather
than surgery on SDK internals.

A result older than two later results and larger than 1,200 chars keeps its
first 800 characters. Measured on one request's accumulated outputs: **23,580 →
10,339 chars, −56%**; modelled across the turn, ~−60% of tool-output cost.

Two things it must not break, both handled:

- the **untrusted-data envelope survives** around the head that remains (it is
  still third-party data, SEC4), while the accounting line sits outside it — the
  same inside/outside split the budget notes use;
- **the cut is stated in the item**, never silent, so a compacted listing can
  never be mistaken for a complete one and reported as the whole bucket.

v0.54.0's dedupe pointer told the model its earlier result was "above in the
conversation" — only partly true once that result may be compacted. The wording
was corrected rather than left to mislead.

### Changed — the finalize pass no longer reads instructions it cannot act on

It runs with `tools=[]` — it exists to write an answer from work already done —
yet was handed the full 6,235-char system prompt, 8 of whose 25 lines teach tool
selection, group unlocking and probe sequencing. `FINALIZE_INSTRUCTIONS` is
**3,431 chars (−45%)** and keeps every safety rule **verbatim** plus all
answer-shape guidance. A shorter prompt is never a reason to relax a safety rule.

### Fixed — the answer had no document structure

Headings rendered as `<div>`. A long diagnostic report — this product's main
output — therefore had no heading levels for a screen reader, no anchors to link
a section, and nothing for a browser's "jump to heading" to find.

They are real `<h1>`–`<h6>` now, each with a stable id derived from its own text
(`#sec-why-it-is-large`), so a deep link survives edits elsewhere in the answer.
Answers with three or more top-level sections also get an outline; answers with
fewer do not, because an outline above three paragraphs is clutter, and h3s are
excluded because listing them makes the outline a second copy of the answer.

### Fixed — "inspect this turn" was a wall-clock guess

v0.55.0 gave every activity record the same id as its persisted `tool_calls`
row. The inspector still matched by time window — which also catches a
concurrently running inline run's rows, since those land in the same wall-clock
span. Tool rows now match by id; audit rows, which genuinely have no id, still
use the window.

### Changed — the whole frontend moved up a generation

Every package was a major version behind. All of it, in one isolated commit so a
regression has one place to look:

| | from | to |
| --- | --- | --- |
| React / React DOM | 18.3 | **19.2** |
| Vite | 5.4 | **8.2** |
| Tailwind CSS | 3.4 | **4.3** |
| TypeScript | 5.9 | **7.0** |
| Vitest | 2.1 | **4.1** |
| jsdom | 25 | **30** |
| @testing-library/jest-dom | 6 | **7** |

`npm outdated` is now empty. Three real breaks, each fixed rather than
suppressed: React 19 types `useRef<T>(null)` as `RefObject<T | null>` (the ref
genuinely IS null before mount, and React 18's type quietly claimed otherwise);
Tailwind 4 replaces the three `@tailwind` directives with one `@import` and moves
its PostCSS plugin to a separate package, with the JS config kept via `@config`
so the product type scale and token remaps carry over unchanged — verified in the
built CSS, not assumed; TypeScript 7 stopped resolving `@types/node` implicitly,
which the file-reading guard tests need.

A fourth break surfaced only in CI: the new generation needs a newer **Node**
than CI was running. jsdom 30 declares `engines.node: ^22.22.2 || …` and its
undici 8 declares `>=22.19.0`, but all eight `setup-node` sites across `ci.yml`
and `release.yml` pinned **Node 20** — where `worker_threads.markAsUncloneable`
does not exist, having landed in 22.10 and never been backported. npm does not
enforce `engines` without `engine-strict`, so `npm ci` succeeded and the
mismatch appeared only as `webidl.util.markAsUncloneable is not a function`
inside the vitest worker, reported as eleven unrelated-looking "failed to start
worker" errors. It passed locally on Node 22.22.2. All eight sites now pin 22.

### Added — the Node floor is declared, and CI is held to it

The deeper fault was that nothing said what Node this frontend needs, so nothing
could check it. `frontend/package.json` now declares
`engines.node: ">=22.22.2"`, and a guard test asserts two things: that the
declared floor is no lower than the strictest floor any installed package
requires (max-of-floors is a sound lower bound on the true intersection), and
that every `node-version:` across every workflow is at least that major. The
guard was verified to fail — with `ci.yml: node-version 20 < 22` — before being
trusted. It compares majors; a within-major floor still relies on `setup-node`
resolving `"22"` to the latest 22.x, which the test says plainly rather than
implying coverage it does not have.

### Added — the design tokens are enforced, not merely applied

v0.56.0 migrated 157 arbitrary font sizes onto a scale. Nothing stopped the
158th. A guard test now fails on any arbitrary text size and on any bare spacing
step Tailwind does not define.

That second check earned itself immediately: `w-6.5` and `w-13`, written during
this very release, are **not** Tailwind steps and compiled to nothing at all —
typecheck passed, build passed, and the elements silently lost their size. The
guard was verified to fail on both classes of drift before being trusted. Eight
further spacing values moved onto real steps; the seventeen that remain are
bespoke glyph and content bounds, deliberately left as visible arbitrary values.

## [0.56.0] - 2026-08-05

_Four fronts: what we depend on, what a turn costs, what a step actually did,
and what the whole thing looks like._

### Fixed — the Python stack had no lockfile, and three environments disagreed

The frontend has `package-lock.json` and Rust has `Cargo.lock`; the sidecar had
only pyproject's deliberately loose ranges, resolved at INSTALL time. So:

| | openai-agents |
| --- | --- |
| the environment v0.55.0 was developed and tested in | **0.17.8** |
| the environment CI validated it in | **0.19.4** |
| a packaged build | whatever was newest that day |

Both passed, which was luck. v0.55.0's entire token saving rests on `is_enabled`
being re-evaluated on every step, and `>=0.17,<1` would have let a 0.20 that
changed it in silently — first visible as a broken release.

`sidecar/requirements.lock` pins the 64-package runtime closure, generated by
`scripts/lock-sidecar-deps.py` from an environment the suite is green in. All
nine `pip install` sites across `ci.yml` and `release.yml` install with `-c`,
each verified to resolve against its job's working directory. The pyproject
ranges stay: they say what the code SUPPORTS, the lock records what was VERIFIED.
A test asserts every declared runtime dependency is pinned, that no "pin" is
secretly a range, and that the three SDK facts v0.55.0 relies on still hold.

Upgraded to current and re-verified: openai-agents 0.17.8 → 0.19.4, openai
2.44.0 → 2.53.0, fastapi 0.139.0 → 0.141.1, uvicorn 0.50.2 → 0.52.1,
boto3/botocore 1.43.41 → 1.43.65, duckdb 1.5.4 → 1.5.5, pyarrow 24 → 25,
pandas 3.0.3 → 3.0.5.

### Added — a tool call finally has a time limit

The SDK has offered `timeout_seconds` all along and nothing set it, so no tool
call had ANY wall-clock bound. That is the one failure this product is least
entitled to have: it diagnoses storage endpoints, and an endpoint that completes
a TCP handshake and then goes silent is a routine finding — one that could hold a
turn open for as long as the socket lived, with the user watching a spinner.

120s per probe; 900s for the survey/review/analysis tools that walk many buckets
in one call. `timeout_behavior="error_as_result"`, so a timeout arrives as a tool
RESULT the agent can reason about — "this probe never came back" is itself a
diagnosis — instead of killing a turn that had already established plenty.

### Added — the investigator pins its own temperature

Never set, so every endpoint applied its own default (typically 1.0, and not
consistent across providers). An operator comparing today's answer to last
week's is entitled to assume the difference is the bucket, not the decoder. 0.2
rather than 0: a strict-greedy decode makes some models loop on a failing tool
call instead of trying another approach, and adaptive investigation is the whole
product. Overridable per provider.

### Changed — the skills catalog carries one sentence per skill

After v0.55.0 shrank the tool block, the catalog was the second-largest per-step
cost: **7,542 chars (~1,886 tokens), 33% of the prefix**, for 20 skills of which
a turn loads at most one or two.

Each entry is now the description's first SENTENCE. Cutting at a sentence rather
than a character count is the difference between compression and damage: a
160-char cut measured 8 points smaller but sliced mid-list, straight through the
error codes that make a skill findable (`…expired presigned URLs,…`). Every entry
keeps a complete, self-contained sentence — the shortest is 70 chars — and
`read_skill(name)` still returns the full method, which is far richer than any
description.

Per-step fixed cost across the last three releases:

| | chars | ~tokens |
| --- | --- | --- |
| v0.54.0 | 49,135 | 12,284 |
| v0.55.0 | 22,696 | 5,674 |
| **v0.56.0** | **19,560** | **4,890 (−60% from v0.54.0)** |

`INSTRUCTIONS` was deliberately **not** trimmed. Every line is either a safety
invariant or teaching that prevents a costlier mistake (re-probing, re-reading,
a wrong claim). Cutting 1,500 tokens there to save tokens would be the wrong
trade in exactly the way this product cannot afford.

### Added — open a step and see what it actually sent and got back

Every call's sanitized input and output has been persisted since v0.45.0, and
v0.55.0 gave the thread row the same id as its `tool_calls` row — but none of it
was reachable from the thread. A reader who wanted to know what
`list_objects · acme-logs` was called with had to open the whole-session
inspector and scroll to a guessed time window.

Trace rows in both the live trace and the finished-turn footer are now
expandable in place, mouse or keyboard, fetching one row on demand from a new
`GET /sessions/{id}/activity/{call_id}`. Nothing new is exposed: the row was
redacted on write and is the same one `/activity` already returned in bulk. The
endpoint is scoped to the session in the path, so a call id from another session
is a 404 rather than a cross-session read. A pruned row reads as "no longer
available", never as an empty payload that would look like the call sent nothing.

### Changed — the UI has a type scale

There wasn't one. A count across the components found **157 uses of arbitrary
pixel sizes spanning fourteen distinct values** — 9.5, 10, 10.5, 11, 11.5, 12,
12.5, 13, 13.5, 14, 14.5, 15, 16 and 23px — alongside 70 uses of Tailwind's own
steps. Half-pixel neighbours like 10.5 against 11 are invisible to a reader and
guarantee that two panels built a week apart never line up.

Eight steps now, each with a line-height chosen for its job rather than
inherited, and all 157 arbitrary values migrated to their nearest step — so the
scale is what the UI actually uses, not an aspiration. Colour needed no work: a
check found **zero** raw hex values bypassing the theme tokens, and both themes
were already complete.

## [0.55.0] - 2026-08-05

_v0.53.0 shrank each payload; v0.54.0 bounded the turn and stopped paying twice.
Both worked on the wrong 32%. This release measures the whole prefix and goes
after the part nobody had looked at._

### The measurement that reframed the problem

Everything the model receives **before any of this turn's own content**:

| fixed prefix | chars | ~tokens |
| --- | --- | --- |
| 42 tool descriptions | 19,552 | 4,888 |
| 42 parameter schemas | 11,765 | 2,941 |
| tool names + wrapping | 4,204 | 1,051 |
| system prompt | 5,175 | 1,294 |
| skills catalog | 7,542 | 1,886 |
| answer contract | 897 | 224 |
| **total, re-sent every step** | **49,135** | **~12,284** |

On a realistic 8-tool turn (9 model requests):

| component | input tokens | share |
| --- | --- | --- |
| **fixed prefix** | **91,566** | **57%** |
| skills catalog + contract | 18,988 | 12% |
| session context | 19,285 | 12% |
| tool outputs | 31,522 | 20% |

The earlier "~5,196-token prefix" figure counted only the prose and omitted the
tool block entirely. The real number is 12,284, and **69% of a turn is fixed,
unchanging bytes** — while the last two releases optimized the other 31%.

### Added — progressive tool disclosure

A turn calls 3–8 tools. All 42 schemas were sent on every step regardless. Now
a CORE set (orientation, the two probes every investigation starts from, skills,
memory) is always exposed and the rest are grouped — `object_forensics`,
`endpoint_probes`, `storage_pileup`, `bucket_config`, `uploaded_files`,
`account_wide` — behind the SDK's per-tool `is_enabled`, which
`Agent.get_all_tools` re-evaluates on **every step**. `load_tools(group)` opens
one and its tools are callable on the very next step. Nothing is ever
permanently hidden, and a tool belonging to no group stays visible: the default
fails **open**, so a tool added later merely misses the saving instead of
silently vanishing.

Three things keep the unlock from costing more than it saves:

- **Reading a skill opens what its method names.** A skill that says "call
  `get_bucket_config_summary`" unlocks `bucket_config` as it loads — derived from
  the skill TEXT, so an edited skill cannot drift out of sync with what it can
  reach.
- **A session remembers what it has used.** Groups whose tools appear in this
  session's persisted `tool_calls` start open. Memory, not planning — the tools
  genuinely ran.
- **An attached file opens the file tools.** The file is a fact, not a guess.

Measured on the same 8-tool turn:

| scenario | input tokens | vs v0.54.0 |
| --- | --- | --- |
| v0.54.0 (all 42 schemas) | 201,838 | |
| core only, no unlock needed | 142,351 | **−29%** |
| one group unlocked (+1 round trip) | 161,312 | **−20%** |
| worst case: every group unlocked | 197,615 | −2% |

The tool block itself goes from 35,521 chars to 7,996 core-only (**−77%**) or
12,382 with a group open (**−65%**).

### Changed — Pydantic's schema titles are gone

Every parameter carried `"title": "Provider Id"` beside `"provider_id"`, and each
schema a `"title": "head_bucket_args"`. **3,601 chars, 30% of all parameter-schema
bytes**, restating the key in title case — re-sent on every step of every turn.
Titles are not part of the strict function-calling contract
(`additionalProperties` / `required` are, and both are untouched).

### Changed — the loaded skill method rides along instead of being re-read

`read_skill` returns a ~3,300-char method body that lives in that turn's
conversation and is gone by the next one — the replay keeps only
`read_skill · storageops-lifecycle-cost → loaded`. So a multi-turn investigation
on one topic re-read the same method **every turn**: a full round-trip to fetch
text the agent had already been given. The most recent one now travels in the
context's **stable** half — the part v0.54.0 ordered so a prompt cache can serve
it, where a tool result never lands.

### Fixed — the thread replay grew with the SQUARE of the context window

`_elastic_replay_caps` multiplied message COUNT *and* per-message LENGTH by the
same window factor. A 1M-window model got 96 × 12,000 = **1,152,000 chars
(~288,000 tokens), re-sent on every step**, for a window 7.8× the baseline. The
budget is now a single area, spent on count first and on length with what is
left: **672,000 chars (~168,000 tokens), −42%**. A 128k model is bit-for-bit
unchanged.

### Added — the prompt-cache ask, and the ability to check it landed

The fixed prefix is byte-identical across steps and across the turns of one
investigation, which is exactly what prompt caching is for, and **nothing in this
app had ever asked for it**. `prompt_cache_retention` is now requested (24h, so
the entry survives the gap between a user's questions, not just between steps).
Best-effort with the same capability memory as `stream_options`: an endpoint that
rejects it is never asked again, and only a complaint that NAMES the parameter
counts — a real bug must never hide behind a cost optimization. Whether it lands
is observable, not assumed: v0.53.0 already records `cached_input_tokens`.

### Fixed — failed tool calls rendered as successes

The thread decided a call had failed with `/^(error|failed)\b/` against the
result text. Measured against the failure shapes this product actually produces:

| result summary | shown as failed? |
| --- | --- |
| `AccessDenied · req 8A9F2C1B` | ✗ no |
| `NoSuchBucket` | ✗ no |
| `SignatureDoesNotMatch` | ✗ no |
| `failed` | ✓ yes |

The three most common failures in an object-storage workbench all rendered
green, and the `⚠ N failed` badge under-counted. The sidecar had computed the
verdict exactly all along and written it to `tool_calls.status` — it now travels
with the record as `ok`.

### Added — every call carries its identity and its measured cost

`duration_ms` has been measured and persisted since v0.45.0 and never sent, so
"which step was slow" was answerable only in the database. It is now on every row
(rounded, and omitted under 100ms where it would be jitter). Each call also
carries an `id` — the same id as its persisted `tool_calls` row.

### Fixed — parallel tool calls corrupted each other's bookkeeping

v0.54.0 enabled `parallel_tool_calls`, and the Agents SDK dispatches a sync tool
with `asyncio.to_thread` — so two tool bodies genuinely run at once. Two things
assumed they could not:

- The open-call slot that `rec()` opens and `note()` closes was a **single shared
  dict**, on the stated assumption that "the agent runs tools sequentially within
  a turn". The second `rec()` cleared the first call's state, and the first
  `note()` then found nothing: no arguments, no duration, and a persisted input
  of `{}`. It is now keyed per thread.
- The UI resolved a completed record to its "started" row by `(tool, target)` —
  identical for two concurrent `get_bucket_config_detail` calls on one bucket,
  which differ only by `aspect`. It now matches on the call id, falling back to
  the old key only for pre-v0.55.0 history.

### Changed — a deep turn no longer floods the thread

`LiveTrace` rendered every row with no cap, and a turn may run up to
`_MAX_TURNS = 60` tools. The head now folds to a "show N earlier steps" line
with the six newest kept visible — **except failures, which are never folded
away**.

### Fixed — parallel tool calls could kill a tool call outright (rule 17)

Two tool bodies now genuinely run at once, and they share the request's SQLite
connection. A connection has ONE transaction, so they shared that too: one
call's `commit()` committed the other's half-written work, and the other's own
`commit()` then raised **"cannot commit - no transaction is active"** — straight
out of the tool. The agent saw a failed call for work that had actually
succeeded, and rule 17's "every tool call is recorded" quietly did not hold.

`busy_timeout` did not help: it coordinates separate *connections*, not two
threads on one. Write-then-commit sections are now serialized by `db.WRITE_LOCK`
— an INSERT plus a commit, held for microseconds, while the S3 call they bracket
(the slow part, and the point of parallelism) stays outside it.

Measured over 120 forced-concurrent pairs: **2 of 240 calls died** before,
0 after. The regression test drives that same 120-pair barrier, because an
earlier single-pair version passed 8/8 locally and only failed in CI — it was a
coin flip, not a detector.

### Fixed — CI's macOS job died on a bundle it never shipped

`cargo tauri build` on macOS ran **every** bundler, while the Linux job scopes to
`--bundles deb` and the Windows job to `--bundles nsis`. The extra one was the
DMG, and Tauri's `bundle_dmg.sh` drives Finder through AppleScript to lay out the
disk-image window — a GUI session a headless runner does not reliably provide. It
started hanging on 2026-08-05 (two consecutive failures at the same step, 9.5s
and 111s on identical input — a hang, not a deterministic error), and its
non-zero exit took the job down **before** the steps that carry its actual value:
the `.app` artifact and `verify-runtime-macos.sh`.

macOS is now scoped like the other two. Nothing that ships is left unbuilt — the
Release workflow builds and uploads the real DMG itself (and did for v0.54.0),
and this job never treated the DMG as a deliverable: its upload has always read
"+ DMG if the bundler produced one" with `if-no-files-found: warn`.

### Fixed — a blind title strip would have broken `record_finding`

Caught by its own test before it shipped: `title` is a JSON-Schema keyword in one
position and an ordinary parameter NAME in another — `record_finding(title,
severity)`. Deleting every key called `title` removed the **parameter** while
`required` still demanded it, which would have made the tool uncallable and
quietly cost the agent its ability to record findings. The walk is now
schema-aware, descending only through keywords whose values are themselves
schemas.

## [0.54.0] - 2026-08-05

_v0.53.0 made each payload smaller. This release attacks the three structural
reasons a turn was expensive no matter how small the payloads got. Every number
below was measured against the running app._

### Added — a per-turn budget denominated in tokens, not characters

The only per-turn ceiling was a **character** budget on cumulative tool output.
But the Agents SDK re-sends the entire accumulated conversation on every step,
so a linear character budget buys a **quadratic** bill: the same 200k-char
budget costs roughly 406k tokens at 10 steps, 781k at 20, and 1.55M at 40. At
`_MAX_TURNS = 60`, a single question could legitimately spend ~3.5M tokens with
nothing in the product objecting.

`turn_token_budget()` adds the bound denominated in what a turn actually costs,
read from the SDK's live per-run usage before each tool call:

| model window | per-turn token budget |
| --- | --- |
| 128k (gpt-4o) | 640,000 |
| 200k (claude-3-5-sonnet) | 1,000,000 |
| ≤120k | 600,000 (floor) |
| ≥800k | 4,000,000 (ceiling) |

Hitting it is not an error — the same soft shape as the char bound: a
`budget_exhausted` status naming `spent_tokens` and `budget_tokens`, plus the
one-click "continue investigation" proposal the turn already offered when it was
cut short. **On an endpoint that reports no usage at all, nothing changes**: the
character budget stays the bound, and the turn says so rather than treating
"unreported" as zero.

The footer now shows the share of that budget the turn used, and the inspector
persists it (`turn_metrics.budget_tokens`, migration 23) so a reload still tells
the truth.

### Changed — independent probes now go out together

`parallel_tool_calls` was off, so eight independent read-only probes cost eight
sequential model requests, **each one re-sending everything before it**. Modelled
on a realistic 8-tool turn (measured fixed prefix 5,196 tokens, context 59,700,
tool outputs 91,540):

| how the 8 calls batch | input tokens across the turn | |
| --- | --- | --- |
| one per request (before) | 995,994 | |
| three dependent phases | 431,222 | −57% |
| all eight at once | 221,332 | −78% |

Real turns land between the middle and bottom rows, since some probes genuinely
depend on earlier ones.

Some OpenAI-compatible gateways mishandle parallel calls and answer with a
sequencing 400. That is now remembered per endpoint (`base_url|model`, the same
key the `stream_options` capability memory uses): the failure happens at most
once per process, that turn still recovers through the tool-less finalize pass,
and every later turn on that endpoint asks for sequential calls. A 400 that is
*not* a sequencing error is never attributed here — a real bug must not degrade
into an invisible capability downgrade.

### Changed — an identical call inside one turn is answered from the conversation

A read-only probe called twice with the same arguments in the same turn returns
the same bytes, and paying for them again **also carries them for every
remaining step**. The second call now returns a `repeat_call` pointer to the
earlier result, and the underlying S3 request is not made either.

`measure_request_latency` is exempt: repetition *is* the measurement there, and
deduping it would turn a second sample into a copy of the first — a fabricated
number, which is worse than the tokens it saves.

### Changed — the prompt is ordered so a provider's cache can actually hold

Prompt caching matches on the **prefix** and stops at the first differing byte.
The old layout put the volatile thread replay in the middle of the context, in
front of the skill catalog and provider list — neither of which had changed — so
one new message invalidated all of it. The order is now most-stable-first: skill
catalog → configured providers → session/summary/agent memory → thread replay →
this turn's attachments and question.

Measured across two consecutive turns of the same session:

| | shared cacheable prefix, before | after |
| --- | --- | --- |
| session below the 24-message replay cap | 4,257 chars (36%) | 11,912 (100%) |
| session above it, replay window sliding | 1,691 chars (12%) | 9,346 (64%) |

### Changed — the replayed tool trace states each call once

On a 20-turn session, **92% of the `tools_run` lines in the replay block were
byte-identical repeats** of a line already present in an earlier message: the
agent re-lists providers and re-heads the same bucket each turn, and every
turn's trace was replayed in full alongside all the previous ones. Reading
`head_bucket · acme-logs → 200` for the ninth time teaches the model nothing and
costs the same tokens on every step.

The first occurrence is kept; later verbatim repeats are dropped and counted
with a terse `[+N repeats]` entry — a trace that silently looked shorter than
the turn really was would be a lie about what ran. What the marker means is
explained **once**, in the instructions, which is the part of the prompt a cache
serves.

### Changed — a list page ships each object key once

`list_objects_v2` returned every page's keys three times over: `sample_keys`
(the first 20), `keys` (the whole page), and `objects` (the first 100, each
entry repeating its key beside size/storage-class/mtime). On a 1000-key page
that is **63,343 chars → 56,998 (−10%)** of pure repetition, re-sent on every
later step of the turn.

`sample_keys` is dropped (it is a strict prefix of `keys`; the S3 layer still
returns it for the run executors that read it), and `objects[i]` now describes
`keys[i]` positionally, flagged by `objects_align_with_keys` and taught in the
tool docstring. Both removals are verified against the actual payload first — if
the shapes ever stop lining up, nothing is removed, because dropping the key
field from a misaligned list would mis-attribute every size to the wrong object.

### Changed — a successful request no longer carries failure-escalation material

v0.52.0 attached the diagnostic block to every response, including the ones that
worked. A 200 carries no diagnosis: `host_id` is an opaque ~100-char base64 blob
and `headers_sanitized` a dozen routing/date/content-type entries — **499 chars
→ 33 per successful call**.

The success shape keeps what stays actionable: the request id, a **non-zero**
retry count (the explanation for a slow "successful" call — botocore retries
throttling silently), and the bucket region when the provider volunteered it.
**Nothing is dropped on the failure path**, where every one of those fields is
the escalation material v0.52.0 added them for.

### Fixed — every budget wrapper thought it was the last tool in the list

The tool-name used for de-duplication and for the latency exemption was read off
the installer's loop variable *inside* the closure, so every wrapped tool would
have resolved to the name of the last tool in the list. Caught by its own test
before it shipped; the name is now bound at wrap time.

## [0.53.0] - 2026-08-05

_What a turn costs, and what the thread says while it runs. Every number below
was measured against the running app before anything changed._

### Fixed — the live trace showed the same calls twice, and never said what they did

While a turn ran, the thread rendered a `LiveProgress` summary line ("5 checks
run · list_objects · acme-logs") **stacked directly on top of** a
`ToolActivityList` showing those same calls as rows. That is the duplication
v0.49.0 removed from the *finished* state, still present in the live one — two
components, one event stream.

There is now one growing list whose newest row carries the spinner. Codex and
Cursor both settle here for the same reason: the rows **are** the progress
indicator, so a counter above them adds nothing they do not already show.

Each row also gained the arguments that decide what the call meant. A row used
to read:

```
list_objects · acme-logs
```

whether the call was `list_objects(prefix="logs/2026/08/", max_keys=1000)` or a
recursive walk of the entire bucket. Those arguments had been written to
`tool_calls` since v0.45.0 — they were simply never put on the SSE stream. Now:

```
list_objects · acme-logs   logs/2026/08/ ·1000 ·recursive
```

Only the distinguishing arguments are shown: `bucket`/`key` are already the
row's target and `provider_id` is an opaque id a reader cannot use. They go
through the same redaction as everything else that reaches the UI. `recursive`
also had to start being recorded — the tool translates it to a delimiter, so it
had never reached `rec()` at all.

### Fixed — 14% of the context block was indentation

`render_context_text` used `json.dumps(context, indent=2)`. Measured on a
40-turn session:

```
context (indent=2)      43,547 chars  ~10,886 tokens
context (compact)       37,520 chars  ~ 9,380 tokens
whitespace overhead      6,027 chars  (14%)
```

The context is re-sent on **every step** of a multi-step turn, so a nine-request
turn was paying roughly 13k tokens for spaces. Tool results had the same problem
at smaller scale (one full `list_objects` page: 75,603 chars against 73,794).

Both are compact now, and `ensure_ascii=False` keeps CJK as characters rather
than six-byte escapes. Models parse compact JSON identically; the indentation
only ever helped a human reading a debug dump, and the inspector still
pretty-prints at the point a human actually reads it.

Six tool descriptions were also trimmed — the fixed prompt prefix is
instructions + **every** tool schema, re-sent per step:

| | before | after |
| --- | ---: | ---: |
| `get_bucket_config_detail` | 2,169 | 1,123 |
| five listing/object tools | 3,837 | 3,170 |
| **fixed per request** | 22,506 chars (~5,626 tok) | 20,787 (~5,196) |

Every behavioural rule the descriptions carried — paging semantics, the
`policy_status` ≠ ACL trap, "listing only, aborting is a mutation" — is still
there. Combined: **~2,050 tokens per request, ~18k on a nine-request turn.**

### Added — the two numbers that explain the bill

The SDK's `Usage` has carried `input_tokens_details.cached_tokens` and
`output_tokens_details.reasoning_tokens` since usage capture landed in v0.45.0.
Nothing read either.

They matter more than the totals do. The fixed prefix is ~5k tokens re-sent on
every step, and cached input is typically an order of magnitude cheaper — so
whether the endpoint caches it is the single biggest factor in a turn's price,
and it was unobservable. Reasoning tokens are output the user pays for and never
sees as text.

The footer now reads `↑12.4k (80%⚡) ↓840 (+320⋯)`, and both are persisted
(migration 22) and rolled up per session.

Both are **NULL when the endpoint did not report them** — "this endpoint does
not say" and "nothing was cached" are different facts. That distinction needed a
separate writer: the existing `_n` helper coalesces a missing key to `0`, which
is right for the core counts (always present when usage is) and would have
silently answered the first question with the second. A genuine `0` is stored as
`0`, because a cold cache is the measurement worth acting on.

### Verified

`sidecar`: 852 tests pass (16 new, `tests/test_v053_token_economy.py`),
`ruff check app` clean. `frontend`: 125 unit tests pass (15 new,
`src/components/trace.test.tsx`), `npm run typecheck` (app + e2e) and
`npm run build` clean. Migration 22 is additive and append-only; no tool
behaviour changed.

## [0.52.0] - 2026-08-05

_The diagnostic core rather than the chat surface. Backend only — no UI, schema
or migration change._

### Fixed — a live failure threw away everything that made it actionable

`_client_error_fields` is the shape **every** live S3 tool returns on failure.
Running a real botocore `ClientError` through it:

```
live error fields: {'error_code': 'PermanentRedirect',
                    'error_message_sanitized': 'The bucket is in this region: us-west-2.',
                    'status_code': 301}
has request id  : False
has host id     : False
has retry count : False
```

botocore hands over `RequestId`, `HostId`, `RetryAttempts` and the full response
headers on that same object. All discarded. `_sanitized_headers()` existed but
was called exactly once in the repository — on `head_bucket`'s **success** path.

That matters because when an S3-compatible gateway returns a 500 or 503 the
agent cannot explain, the only remaining move is "take the request id to your
provider". The id was in hand and dropped. The product already knew this
mattered: the **offline** triage parser has always extracted `request_id` from
pasted error text. One product, two standards.

The failure shape now carries:

| Field | Answers |
| --- | --- |
| `request_id` / `host_id` | "what do I give my provider's support desk?" |
| `retry_attempts` | "why did a request that succeeded take four seconds?" |
| `headers_sanitized` | the `server` banner, and `x-amz-bucket-region` on a 301 |

`retry_attempts` is captured on the **success** path too: boto3 retries
throttling transparently, so a rate-limited turn previously reported success with
no explanation for the pause.

Redaction needed no new work — it already keeps the diagnostic headers and
strips the dangerous ones, now asserted rather than assumed:

```
x-amz-request-id       -> 8A9F2C1B4D6E0000
x-amz-bucket-region    -> us-west-2
authorization          -> ***REDACTED***
set-cookie             -> ***REDACTED***
```

It went in the shared helper on purpose: 15+ call sites inherit it and there is
no per-tool variant to drift. A turn's one-line trace now reads
`InternalError · req 8A9F2C1B4D6E0000`.

### Added — `get_bucket_location`, the cheap probe that was missing

Region/endpoint mismatch is the most common misconfiguration in S3-compatible
setups. Diagnosing it cost a full `get_bucket_config_summary` — 15+ API calls —
because there was no cheap probe: the agent's 30 tools had no way to ask where a
bucket lives.

One read-only call, reported next to the configured region and endpoint so the
result is a verdict rather than a fact to interpret. Four things keep it honest:

- an empty `LocationConstraint` is `us-east-1` **on AWS** — treating it as
  unknown would make the most common region the one we cannot report;
- on a custom endpoint an empty answer means the provider does not partition by
  region, and is reported as unknown rather than invented as `us-east-1`;
- `region_mismatch` is `null` when either side is unknown — an unset region on a
  custom endpoint is normal, not a fault;
- a 301 on the way in **still answers the question**, from the
  `x-amz-bucket-region` header (now captured) rather than by parsing prose.

`provider_unsupported` on a gateway without the API (rule 18). The
`PermanentRedirect` / `AuthorizationHeaderMalformed` / `SignatureDoesNotMatch` /
`NoSuchBucket` playbooks now point at it instead of the 15-call review.

The guard test that existed to keep the playbooks from naming a
`get_bucket_location` that did not exist was inverted rather than deleted: it now
scrapes the registered tools and asserts every tool-shaped token in every
playbook is one of them.

### Added — the access-log columns that were parsed and never read

`latency_ms` and `bytes_sent` have been in the table since the engine's first
version. Nothing read them, so "why is it slow" and "why is it expensive" — the
two questions people bring an access log to answer — had no numbers behind them.

- **latency percentiles** (p50/p95/p99/max), not an average: the mean hides the
  tail, and the tail is what gets reported as "it's slow";
- **egress**: total bytes served plus the keys that account for them (a single
  hot key served uncached is a different problem from broad traffic);
- **errors by prefix**: which part of the bucket is failing, ordered by error
  count so a 100%-failing prefix with three requests does not outrank an outage;
- **error rate by hour**: a flat 2% and a 2% that was 40% for one hour are
  different incidents;
- **top talkers** on the ingest-masked client IP (rule 15).

Every one is `null` — absent, never zero — when the format carries no such
field. A "p95 = 0 ms" would be a false claim about performance. Three new
findings ride on them (long latency tail, egress concentrated on one key, errors
concentrated in one prefix), each requiring a minimum sample and, for the prefix
finding, a rate genuinely above the bucket average rather than merely high.

### Verified

`sidecar`: 836 tests pass (22 new, `tests/test_v052_actionable_failures.py`),
`ruff check app` clean. No frontend change was needed — the request id reaches
the trace and the inspector through the existing sanitized tool-call record.

## [0.51.0] - 2026-08-05

_A serious pass over what a session actually exposes. Three silences, each
verified against the running app before being fixed._

### Fixed — the agent's own memory was invisible, and uncorrectable

The agent records what it learns as it investigates (`note_fact` /
`record_finding` / `note_open_question`) and **replays that memory into the
context of every later turn**. Probing a real session showed where it surfaced:

```
GET /sessions/{id} keys: [created_at, findings, goal, id, message_total,
                          messages, primary_bucket, provider_id, runs,
                          status, summary, title, updated_at]
detail exposes agent_memory: False        ← the endpoint returned none of it
rows actually in DB: 3
report contains fact          : False     ← the report rendered findings only
report contains finding       : True
report contains open_question : False
```

So a wrong fact — "bucket acme-logs is path-style only" — steered the rest of the
investigation with nothing on screen to reveal it, and only the agent could fix
its own items (`update_agent_memory` / `resolve_agent_memory` existed in the
repository with no route and no UI).

Now: `GET /sessions/{id}` returns `agent_memory`; the inspector shows all three
kinds and lets the user **correct** an item's text or **resolve** it (closed, not
deleted — it leaves the agent's context, the row survives for the audit trail);
and the report gained "What the agent established" and "What the agent left
open" beside the findings it already had.

Text is redacted by the repository on write, exactly like the agent's own writes
— this text goes into a prompt — and both operations are audited as
`session.memory_edit` / `session.memory_resolve` with `by: user`, so a later
reader can tell which premises the agent derived and which a human overrode.

Two neighbours of the same question:

- **Attached evidence** is listed (`attached_files`, without filesystem paths —
  the app data dir carries the OS username). Once the composer's chip cleared,
  there had been no way to see what files the session held.
- **Context reach**: `context_messages` reports how many of `message_total` the
  agent actually replays for the configured model (24–96, elastic). When it is
  lower, the UI says so. The agent is then working from its memory and the
  summary rather than a re-read of the conversation, and a reader who assumes
  otherwise misjudges every later answer.

While wiring the report, a second silent truncation surfaced: the repository
tail-caps active memory at 50 for the prompt, so a session with 60 facts rendered
50 and claimed completeness. The report now fetches beyond the replay cap and
states the remainder from a true count (`count_agent_memory`).

### Fixed — a reload during a turn showed an idle session

Run state lives in the client's memory (that is what lets a turn keep streaming
while you work in another session). The cost: reloading the app — or opening the
session in a second window — mid-turn showed **nothing running** while the worker
kept generating and kept spending, and the answer surfaced only if the user
happened to reload later. There was no endpoint to ask, either: `turn_guard`
already tracked `session → handle`, but nothing exposed it.

`GET /sessions/{id}/turn` now reports `{running, turn_id, started_at, age_ms}`.
The thread asks once per session switch and once per return-to-foreground, then
polls only while a turn is known to be running — a turn cannot start without this
client's knowledge except through those two doors. It states the fact and the
elapsed time (there is no stream to re-attach to, and inventing partial text
would be worse than saying nothing) and reloads the thread when the turn ends.

`TurnHandle` gained `started_at` for display and a monotonic clock for the age,
so a wall-clock jump cannot make a live turn look hours old.

### Fixed — an unsent question was destroyed by switching sessions

The composer was one piece of component state, cleared unconditionally on every
session switch (`setText("")`) and never persisted: writing a long question,
switching to another investigation to check something, and coming back lost it,
as did quitting mid-sentence. Drafts are now per session in `localStorage`,
including for a chat that does not exist yet — the most common case, since a
fresh chat has no session id until the first message is sent.

They stay client-side deliberately: a draft is UI state, never sent anywhere, and
persisting it server-side would put unsent user text into the audit surface.

### Added — "inspect" lands on the turn you clicked

The turn footer's `onOpenInspector` took no argument, so from turn 7 of 30 you
arrived at the top of a whole session's timeline with no marker for which rows
were yours. It now passes the turn's wall-clock window (question → answer);
matching rows are highlighted and the first is scrolled into view. Timestamps are
fixed-width ISO-8601 Z, so the comparison is a string compare.

### Added — the thread speaks to a screen reader

The only `aria-live` region in the app was the toast host: a streaming answer, a
finished turn and a failed turn were all silent. A polite live region now reports
state transitions — working, answer ready, turn failed, stopped, model provider
needed. State transitions, not the token stream: narrating an answer character by
character is worse than silence, and the finished answer is already in the normal
reading order.

### Verified

`sidecar`: 814 tests pass (11 new, `tests/test_v051_agent_knowledge.py`).
`frontend`: 110 unit tests pass (19 new, `src/components/knowledge.test.tsx`),
plus 3 new E2E specs; `npm run typecheck` (app + e2e) and `npm run build` clean.
No migration, no change to any tool, and no new data leaves the machine.

## [0.50.0] - 2026-08-05

_What an answer is allowed to look like. Frontend, plus one line of agent
instruction — no API, schema or tool behaviour changed._

### Added — the markdown the agent writes, actually rendered

The renderer is hand-written and dependency-free, which is the right trade for a
desktop app under a CSP that blocks external resources — but it had only ever
grown the syntax someone needed at the time. Rendering a realistic answer through
it showed seven forms arriving as literal text or quietly flattened:

| Written | Rendered before | Rendered now |
| --- | --- | --- |
| `##### Note` | `##### Note` | a heading (h5/h6) |
| `~~gone~~` | `~~gone~~` | ~~gone~~ |
| `- [x] done` | `[x] done` | a checked box |
| `https://docs.aws…` | plain text | a link |
| nested list | flattened to one level | nested |
| `1.` `2.` | `<ul>` + typed-out numbers | a real `<ol start=…>` |
| `--:` in a table | discarded, always left | right-aligned |

Nesting matters most: a two-level list of buckets-and-their-findings was
flattened into peers, losing which finding belonged to which bucket. `<ol>`
matters for a different reason — the numbers were painted as text inside a
`<ul>`, so they looked right and announced wrong, and a list starting at `3.`
renumbered itself from 1. Alignment matters because a right-aligned numeric
column is how a reader compares magnitudes down a column at all.

An item's indented content is now re-parsed as blocks, so a fenced command
inside a numbered step works — which is how half of this product's answers are
shaped ("1. run this: ```bash…").

No HTML is injected, before or after: `<script>alert(1)</script>` is still text,
and only `http(s):`/`mailto:` links are ever clickable.

### Added — syntax highlighting for the four languages this product emits

Bucket policies, S3 error bodies, `aws s3api` reproductions and the audit log's
analysis SQL were all one flat grey. `frontend/src/lib/highlight.ts` is a ~200
line tokenizer covering `json` / `xml` / `bash` / `sql` and their aliases;
anything else, and any block over 20 000 characters, renders exactly as before.

It is a tokenizer, not a parser — nothing is validated and no claim about
correctness is implied. A test asserts the tokens rejoin to the byte-identical
source, because a rule that matched ahead of the cursor would silently drop the
text in between. Shell command names (`aws`, `curl`, `mc` — not in any keyword
list, since they are whatever the user has installed) are found positionally:
first word of a line or pipeline segment.

No library, no CDN theme: the CSP forbids the second and the first would add
hundreds of KiB to a desktop binary to colour a policy document.

### Added — a chart for the tables that are measures

The aggregate tools return a measure per group; the agent writes it as a table.
A column of numbers answers "what is the value for X" but not "which one is the
problem". When a table has a non-numeric first column and a column that parses
as a number in **every** row, the UI now draws ranked bars above it — or a column
chart when the categories are a time series.

Three rules keep it honest:

- The chart is derived from the table already on screen, never a second source.
  Nothing extra is sent to the model and no raw row is exposed; if the numbers
  are wrong the chart is wrong identically.
- The table stays, unchanged, below it. A bar shows ratio, not magnitude.
- Ambiguity draws nothing: a status matrix, a column carrying one `Provider
  unsupported` cell, negative values, an all-zero column, or more than 40 rows.

Drawn with layout boxes rather than SVG — bars are rectangles, and CSS already
solves responsive width, truncation and theme colour.

### Changed

- The session agent's instructions now state what its answer surface renders,
  and that a measure-per-group belongs in a table with the group first and one
  plain numeric column. Six lines; the capability is worthless if the writer
  does not know it exists.
- Seven syntax-palette CSS variables added to **both** themes, re-picked against
  the light code slab rather than inverted. `theme.tokens.test.ts` now computes
  their WCAG contrast against `--code-bg` (AA body, ≥4.5:1) and asserts the
  slots stay distinguishable from one another.
- Table rows use `bg-elevated/30` for zebra striping instead of a white overlay.

### Verified

`frontend`: 91 unit tests (27 new, `src/components/markdown.test.tsx`),
`tsc --noEmit` clean, `npm run build` clean. `sidecar`: 803 tests pass.

## [0.49.0] - 2026-08-05

_A structural review of what a session actually shows. Frontend only — no API,
schema or agent behaviour changed._

### Fixed — one answer carried three descriptions of the same work

Rendering a real turn with five tool calls and measuring it: **6 clickable
controls**, and the same tool count stated **twice, in two vocabularies, on
opposite sides of the answer**:

| | Position | Wording | Expanded |
| --- | --- | --- | --- |
| Tool trace | **above** the answer | `Ran 5 checks · 4 tools` | tool · target · result |
| Metrics strip | **below** the answer | `5 tool calls (4)` | tool · bar · count |

Plus a third expander (`Why this answer`). Each arrived in a different release —
the footer in v0.45.0, the collapsible trace in v0.46.0 — and each was reasonable
alone. Together they made a reader look in two places to learn they described the
same five calls.

Codex, Claude Code, Cursor and Dia all converge on **one metadata affordance per
turn**, and on showing process in **execution order** rather than split before
and after the answer. This release does that:

- **One line under each answer**: `5 checks · 12.4s · ↑4.2k ↓380 · inspect`.
- **One expansion**: the numbered trace in execution order (never re-sorted by
  name or duration — the sequence is what explains what led to what), with the
  grounding directly beneath the calls it rests on.
- The live trace during streaming is unchanged: there the rows *are* the progress
  indicator, which is a different job.

Six controls per turn become three; two vocabularies become one.

### Added — evidence links to the call it names

An evidence line that names a tool the turn actually ran (`head_bucket returned
200`) now carries a chip; hovering it highlights that row in the trace above.
Evidence naming no tool — or naming one the turn did not run — gets no chip: a
fabricated citation would be worse than none.

### Changed — old turns collapse

Beyond the six most recent exchanges, a turn collapses to one line (its question
plus its check count) and reopens on click, sticky for the session. Scrolling
back through a long investigation is now scannable rather than a wall of prose.

### Changed — session findings left the timeline

Deterministic session findings rendered at the **bottom of the thread**, where
standing session state reads as the newest event. They moved into the inspector,
next to the rest of the session's cross-cutting record.

## [0.48.0] - 2026-08-05

_The report finally documents the investigation. Plus a correction to v0.47.0's
own notes, and the loose ends it left._

### Fixed — the session report documented none of the work

The report predates the v0.20 shift to an agent-first product: it drew only from
**linked runs**, and the conversational agent's work is deliberately never linked
as a run card. Measured on a real six-turn investigation — probe the bucket, hit
a 403, explain the cause — the report rendered **1244 characters, almost all
boilerplate**, with `Evidence used: —`, `Timeline of runs: No runs linked yet`,
`Key findings: —`, `Agent-recorded findings: None recorded`. The one document
meant to leave the app documented nothing.

Meanwhile v0.45–v0.47 had built a genuinely complete record — tool trace, per-turn
cost, session audit trail — that lived only in the inspector. The report now
draws on it:

- **Investigation** — each turn's question, an excerpt of the answer, and the
  grounding the agent claimed (*grounded in* / *not verified*), plus that turn's
  tool count and duration.
- **Tools run** — a table of which read-only tools ran, how often, how many
  failed, and how long they took.
- **Cost** — turns, wall-clock, and tokens **only when the provider reported
  them**; otherwise an explicit "not reported".
- **Audit trail** — rule 17's events for the session, summarised then listed.
- The executive summary now counts turns and tool calls, not just linked runs.

Every section is bounded (40 turns, 600-char answer excerpts, 25 tools, 30 audit
rows) and **states when it truncates** — a report that silently dropped half an
investigation would be worse than one that admitted it covered nothing. The
newest turns are kept, not the oldest. Redaction is unchanged: the whole document
is still redacted on render, and every input was sanitized on write.

### Fixed — a rationale in v0.47.0's notes that was not true

v0.47.0's changelog, PR and `docs/api.md` all justified keeping the unbounded
`list_messages` branch with "the report builder needs the whole thread". **The
report builder did not take messages at all** — the branch had no caller. It has
a real one now (the report genuinely wants the whole investigation), and the
documentation says something true.

### Fixed — seven more audit events were still unreachable

v0.47.0's AST guard covered four agent-tool modules, so a new `audit.record`
elsewhere could still omit `session_id`. Widened to sweep the whole app, it
immediately found seven: `error_triage.case`, `run.create`, `run.start`,
`session.dataset.upload`, `session.turn.cancel`, and two that are correctly
run-scoped (`session.delete`, `run.delete`) and are now explicitly exempt with
the reason. `run.start` resolves its session through a new
`session_id_for_run` lookup — a run outside a session has none, which is a real
answer rather than a guess.

### Changed — the inspector pages each stream separately

"Load more" advanced both streams together, so a session with 4000 tool calls
and 30 audit events paged the short stream to its end on the first click and then
kept offering more for a stream with nothing left. Each stream now advertises and
advances its own remainder.

### Added — jump to the start of a long thread

"Load earlier" moves 60 messages at a time; a thousand-turn session was ~17
clicks to reach the beginning. **Jump to start** pulls the remaining pages in
sequence and lands at the top.

## [0.47.0] - 2026-08-04

_Finishing v0.45.0's observability properly — including a data-loss regression it
introduced — and bounding the thread so a long investigation stays cheap._

### Fixed — the retention sweep was deleting live sessions' tool calls

`prune_audit_logs` aged out `tool_calls WHERE run_id IS NULL`. When that was
written, `run_id IS NULL` meant "an ad-hoc Test-Connection probe, owned by
nobody". **From v0.45.0 it also describes every tool call the conversational
agent makes**, so past the retention window the sweep destroyed a *live*
session's rule-17 tool trace: the inspector's timeline emptied while
`turn_metrics` still reported the calls — two numbers in one UI disagreeing,
with the evidence gone.

The predicate is now `run_id IS NULL AND session_id IS NULL` — genuinely
unreachable rows only. Regression tests pin both directions: a live session's
calls survive, and truly ownerless old rows are still swept.

### Fixed — most of the session audit trail was still unreachable

v0.45.0 added `session_id` to `audit_logs` but only two call sites set it.
**21 did not** — every uploaded-file analysis, all six working-memory writes,
`read_run_result` / `compare_to_last_survey` / `query_account_profile`, report
generation, and the next-action approval events. The inspector's audit timeline
showed a fraction of what a session did while looking complete. All of them are
session-scoped now, enforced by an AST test over the agent-tool modules.

(`session.delete` deliberately stays payload-only: the session is ceasing to
exist, so a session-scoped row could only be read back through a session that is
gone.)

### Fixed — the per-turn footer no longer lags the answer

The SSE `done` event has carried `metrics` since v0.45.0 and nothing consumed
it; the footer only appeared once the post-turn reload persisted the row. The
live copy now fills the gap, and the persisted one takes over when it arrives.

### Changed — the thread is paged

`list_messages` was unbounded. A 300-turn investigation measured **0.98 MiB of
JSON**, re-sent on every session open *and* every turn (the worker fetched the
whole history to build a context the agent caps at 96 messages anyway).

- Threads open to their last 60 messages with `message_total` alongside, so a
  partial thread is never presented as complete; **"Load earlier" pages
  backwards**, anchoring the scroll so prepending doesn't yank the reader.
- `GET /sessions/{id}/messages` takes `limit` + `before` and returns
  `total` / `has_more`.
- The per-turn context fetch is bounded by the agent's own replay ceiling.
- Measured after: **100 KiB** on open, flat as the session grows. The unbounded
  form survives for the report builder, which summarises the whole investigation.

### Added — the inspector pages

Past 500 rows it said "truncated" and offered nothing. It now shows
`Showing N of M` with a **Load more** that pages forward through both streams.

### Fixed — contrast, measured rather than eyeballed

A WCAG pass over the v0.46.0 tokens found `--gray-600` at **2.60:1** (dark) and
**2.63:1** (light) — below the 3.0 floor, and it carries the per-turn metrics
footer and every timestamp. Raised to 3.2:1 in both themes, same hue, lightness
only, so the neutral ramp keeps its ordering. The semantic status tints all
cleared AA already. Tests now compute the ratios and fail below the floor.

### Changed — one shortcut registry

`src/shortcuts.ts` is the single source for both the key handler and the help
sheet, which were two hand-maintained lists that could disagree — an
undocumented binding or a documented one that does nothing. The platform
modifier resolves once, and bare-key shortcuts no longer swallow modified chords.

## [0.46.0] - 2026-08-04

_Interface and interaction. The design system was sound; what let it down was a
light theme half the components opted out of, a tool trace that buried the
answer, and a shell you could not adjust. Frontend only — no API, schema or
agent behaviour changed._

### Fixed — the light theme was a half-finished feature

Surfaces went through CSS variables and inverted correctly, but **14 components
bypassed them** with hardcoded dark-theme values: every error and warning banner
(`bg-red-950` + `text-red-300`), the code block (`bg-[#0a0a0c]`), status pills,
and every overlay scrim. In light mode those rendered dark slabs with pale text
on a white page — not a matter of taste, simply unreadable. Status colour had
never entered the token system at all.

- `danger` / `warn` / `success` / `code` / `scrim` are now **semantic tokens**,
  defined separately for each theme (light gets tinted surfaces with dark
  foregrounds — not the dark values inverted, which is a different problem).
- **121 hardcoded colour usages replaced** across 19 files; zero remain.
- A unit test fails the build on any new raw palette step of a status hue, any
  literal hex, or a semantic token defined in only one theme.

### Added — the thread reads like Codex now

- **The tool trace collapses.** A deep investigation ran twenty rows pinned above
  the answer, pushing the answer itself off screen. It now collapses to
  `Ran 12 checks · 5 tools`, with failures still counted in the collapsed
  summary — and stays open while streaming, where the rows *are* the progress.
- **Jump to latest.** Scrolling up during a turn silently detached auto-scroll
  with no indication and no way back. A pill now appears when you leave the
  bottom, and says whether the agent is still writing.
- **Message actions** on hover: copy, edit-and-send-again, ask-again. Both
  re-ask actions seed the composer and open a **new turn** — they never rewrite a
  persisted message, because the thread is the audit record that the session
  inspector and turn metrics describe.
- **Long pastes clamp.** The most common user message here is a full S3 error
  body; one used to fill the viewport. Now clamped visually with "show more" —
  nothing is truncated.

### Added — a shell you can adjust

- **Collapsible sidebar** (`⌘\` / the header button) and **drag-to-resize**,
  both persisted. Collapsed keeps new-chat, status and settings.
- **Sessions group by calendar day** — Today / Yesterday / Last 7 days / Last 30
  days / Older — rather than one flat list of relative timestamps. Boundaries are
  local midnights, so "23h ago at 9am" correctly reads as *yesterday*.
- **One toast surface** replaces the bespoke fixed error bar and its inline twin.
  Errors persist until dismissed (a failure you blinked past is one you will hit
  again); successes auto-dismiss; the stack is capped at four.
- **`?` opens a keyboard-shortcut sheet.** Every shortcut already existed and
  none were written down anywhere in the product.
- **Focus traps** on the palette, settings drawer, inspector and shortcut sheet,
  with focus restored on close, plus `aria-modal`. Tab used to walk straight out
  of a modal into the composer hidden behind the scrim.

## [0.45.0] - 2026-08-04

_Session observability. The product recorded a rule-17 audit trail it could never
read back, and never recorded what a turn cost at all. This release makes an
investigation legible: what ran, in what order, how long it took, and — when the
provider actually reports it — how many tokens it burned._

### Added — you can now see what a session did

- **Per-turn metrics footer.** Under each answer: wall-clock duration, the number
  of completed tool calls, and token usage. Expanding the tool count shows
  *which* tools ran and how often, with a proportional bar per tool — the
  difference between "7 calls" and understanding the shape of the investigation.
- **Session inspector** (`⌘I` / `Ctrl+I`, or the header button). A right
  slide-over with an overview band (tool calls, time in tools, tokens, audit
  events) over **one** merged timeline of tool calls and audit events. The
  filters are additive chips, deliberately **not** tabs: the two streams
  interleave, and tabs would destroy the ordering that explains what led to what.
  Each tool row expands in place to its sanitized input/output.
- **Investigation record export** — copy or download the inspector's contents as
  Markdown.
- **Three read-only endpoints**: `GET /sessions/{id}/activity`, `/audit`, and
  `/overview`. Bounded (500 rows/request) and each response reports its own
  truncation, so a partial timeline can never look complete.

### Fixed — the audit trail was write-only in practice

`tool_calls` and `audit_logs` carried no `session_id`. Rule 17 says every tool
call and approval is recorded, and they were — but a conversational turn's rows
were orphaned the moment they were written, retrievable only by run, and an
agent turn has no run. Migration 20 adds the column (plus indexes) and the
session agent's own tool wrapper now writes a `tool_calls` row per call with its
measured duration, which it previously did not do at all.

### Added — token usage, measured or absent

- `ModelSettings.include_usage` is now set, because the Agents SDK only requests
  streamed usage for the *official* OpenAI client — any custom `base_url` (this
  app's normal case) silently got no usage at all.
- An endpoint that **rejects** the parameter is remembered per `base_url|model`
  and never asked again; that turn recovers through the existing finalize pass
  rather than failing. Provider compatibility outranks a metrics field.
- Usage is summed across **both** model runs in a turn (the tool loop and the
  finalize pass), because the turn paid for both.
- Migration 21 adds `turn_metrics`. Token columns are **NULL** when the provider
  said nothing — never 0. The UI renders that as an explicit "not reported by the
  provider", and a session where only some turns reported is labelled *partial*
  so a floor is never presented as a total. **Nothing is ever estimated.**

## [0.44.0] - 2026-08-04

_No product-code changes. Four releases of security work had landed without the
documentation that describes the security posture ever being updated, so this
release makes the docs true again and closes the last remaining Known gap._

### Fixed — documentation had gone stale in a way that mattered

`docs/security.md` was last touched before v0.39. Measured against it, the
following had **zero** mentions despite all shipping in v0.40–v0.43: the
untrusted-data envelope, the launcher identity nonce, the single-instance guard,
the vault write guard, the Windows watchdog, the `tauri.localhost` CORS origins,
Azure SAS / session-token / `private_key` redaction, and path-boundary prefix
scoping. That document is what a reader trusts to learn *what this app actually
protects against*, so it was not merely incomplete — it was wrong.

- **`docs/security.md`** now covers: path-boundary prefix scope; the
  untrusted-data envelope (including which two categories stay outside it and
  why); the concrete non-AWS redaction shapes and the bare-secret pair rule; why
  streaming is redacted separately and more eagerly; the strip→redact→strip
  chain-of-thought ordering; secret-shaped filenames; the launcher's
  readiness + identity handshake and why there is no `8765` fallback; the
  single-instance guard and the vault's write-time re-read; the packaged webview
  CORS origins (and why widening them costs nothing); the platform-split parent
  watchdog; and the data-dir hard-fail.
- **`docs/architecture.md`** now documents the survey's concurrent probing —
  specifically that probing is concurrent while recording is **not**, which is
  the whole design — and gains a Testing section describing the three layers and
  why the E2E specs live in their own TypeScript project.
- **`docs/tools.md`**: `read_run_result`'s `wait_seconds`, `survey_account`'s
  `max_buckets` and 100-bucket default cap, and `get_object_lock_status`'s
  `unknown` states (`none` is only meaningful when `success` is true).
- **`docs/roadmap.md`**: current state, the test layers, and honest gaps —
  notarization and auto-update are blocked on signing credentials, i.e. a
  decision before an implementation.

Every factual claim added was cross-checked against the code it describes (20
assertions covering marker strings, env var names, worker counts, cap values,
and function signatures).

### Added — the E2E harness is type-checked

The Playwright specs sat outside `tsc --noEmit` (its `include` is `"src"`), and
Playwright compiles them with esbuild, which strips types **without** checking
them — verified by planting a deliberate `const x: number = "string"` and
watching the gate pass. They now have their own project (`tsconfig.e2e.json`,
with `@types/node` for the builtins the app bundle never imports), and
`npm run typecheck` runs both. This closes the last item on the Known-gaps list.


## [0.43.0] - 2026-08-04

_Finishes what v0.42 started: the one audit finding it left unfixed (a silent
credential-loss path), the survey concurrency it deferred, and more E2E
coverage._

### Fixed — the vault could silently lose a credential

- **A save rewrites the whole vault file from an in-memory cache that was loaded
  once and never re-read.** Two app instances over the same data dir — which
  nothing prevented — meant the second one's save persisted its stale map and
  **deleted the credential the first had just stored, with no error anywhere.**
  Writes now compare the vault's (mtime, size) against what the cache was
  decrypted from and re-read when it changed. Reads are untouched: they still
  come straight from the cache, so the guard costs a `stat` on save only.
- **Added a single-instance guard** (`tauri-plugin-single-instance`). A second
  launch now focuses the running window instead of starting a second sidecar
  over the same SQLite database and secret vault — closing the above at its
  source rather than only surviving it.

### Changed — the account survey probes buckets concurrently

- Per-bucket probing is network-bound (a dozen-ish S3 round trips each) and ran
  fully serially, so a 100-bucket account paid 100 × latency end to end. Probes
  now run in a bounded pool (4 workers, measured ~3.9× on 12 buckets).
- **Only the probes are parallel.** Every database write, every `tool_call` /
  audit row, and every SSE event still happens on the run thread, sequentially,
  in the original bucket order — so the per-bucket transaction isolation from
  v0.40 and the recorded ordering are unchanged. Workers open their own
  connections and use them purely to read the provider row and build the
  (globally cached, request-thread-safe) boto3 client.
- A probe that fails is captured per bucket and re-raised on the run thread, so
  it produces exactly the error row it did when the work ran inline.
- `run_tool` grew an optional `duration_ms`. Without it, recording a call whose
  work already happened in the pool would have written a ~0 ms audit row for
  something that took seconds — the concurrency would have made the audit trail
  lie. The real elapsed time is threaded through instead.
- Worker count is deliberately small: this is one desktop app against one
  account, and a wide fan-out invites provider-side `SlowDown` throttling, which
  would make the survey slower and noisier rather than faster.

### Added — E2E coverage

- Cloud-provider creation, asserting **end to end** that the plaintext secret
  appears neither in the DOM nor in the API response (rule 2/4 — SQLite holds
  only a `keyring://` ref — verified through the real stack, not just a vault
  unit test), plus persistence across reload.
- Session rename round-tripping through SQLite, and the command palette's
  open/Escape handling.
- The provider spec cleans up the row it creates: the suite shares one sidecar,
  and a leftover provider silently invalidates the first-run-wizard test, which
  asserts first-install behaviour.

### Known gaps

- The E2E specs remain outside `tsc --noEmit` (`include: ["src"]`); Playwright
  compiles them with esbuild, which strips types without checking them, so type
  errors there surface as test failures rather than at the typecheck gate.


## [0.42.0] - 2026-07-29

_An end-to-end smoke harness (the integration seam unit tests can't reach) plus
a targeted audit of two never-mined surfaces: the Tauri Rust shell and the
StorageOps skill pack. The shell audit found a **critical Windows defect** that
would kill the desktop app seconds after launch._

### Added — E2E smoke harness

- The app had 759 unit tests and **zero coverage of the seam between them**:
  composer → HTTP → SQLite → SSE → rendered card. A Playwright suite now drives
  the real stack — a live sidecar (started against a throwaway data dir) plus the
  production frontend bundle — and runs in CI between the unit gates and the
  desktop builds (`npm run test:e2e`).
- Deliberately credential-free: it exercises the offline paths a user hits on a
  fresh install (deterministic error triage with no model provider, session
  persistence across reload, settings drawer, first-run wizard), so it needs no
  model key or cloud account and cannot go flaky on a provider.

### Fixed — desktop shell (Tauri)

- **CRITICAL (Windows): the sidecar's parent-watchdog terminated the app it was
  guarding.** The watchdog polled `os.kill(parent_pid, 0)` as a liveness probe —
  correct on POSIX, but on Windows CPython maps every signal except
  CTRL_C/CTRL_BREAK to `OpenProcess` + `TerminateProcess`, so the sidecar
  hard-killed the Tauri app about two seconds after launch. The subsequent
  `OpenProcess` failure then raised a plain `OSError` the handler didn't catch,
  killing the watchdog thread and leaving the sidecar running as exactly the
  orphan it exists to prevent. Windows now waits on a `SYNCHRONIZE` process
  handle (also immune to PID reuse); POSIX keeps the real signal-0 probe.
- **The launcher now verifies the sidecar before trusting the port.** Nothing
  checked that the spawned child stayed alive (a sidecar that died at startup
  left the user on a "starting…" spinner forever, because the frontend maps every
  pre-first-success failure back to "starting"), and nothing checked *who* was
  listening — the webview would send the auth token to any local process
  squatting the port that could answer `{"status":"ok"}`. The shell now polls
  `/health` for a per-launch nonce it passed to its own child, watching
  `try_wait()` for early exit, and only then publishes the URL and token.
- The free-port helper no longer falls back to **8765** — the documented dev
  default, and therefore the most likely address of a stale sidecar from an
  earlier crashed run (different token, different data dir). It fails loudly.
- Teardown handles `RunEvent::Exit` as well as `ExitRequested` (a window-manager
  close or OS logout skipped the only cleanup path), reaps the child, and matches
  on `lock()` instead of unwrapping — a poisoned mutex would have panicked
  *during shutdown*.
- A failure to resolve the app data dir aborts startup instead of degrading to an
  empty string, which the sidecar treats as unset — falling back to a path
  **inside the packaged bundle**, writing the SQLite DB and secret vault into the
  signed app.
- `save_report` uses `create_new(true)` and 1000 candidate names: the old
  `exists()`-then-`write()` was racy, and after 99 collisions it fell through and
  **overwrote the user's existing file** — the opposite of its contract.
- CORS: added `http(s)://tauri.localhost`, the origin Tauri v2 serves the
  packaged app from on Windows and Android. Every call carries the
  `X-Sidecar-Token` header, so it is preflighted — without this the packaged
  Windows app could not reach its own sidecar at all. The token gate remains the
  real authorization boundary.

### Fixed — skill teaching drift

The agent loads StorageOps skills to learn method; several taught tool behavior
that v0.39–v0.41 changed, so it was being taught to reach wrong conclusions:

- **Access logs**: the analyzer has no requester dimension at all, but the skill
  promised "top requesters" — the agent would mislabel `top_user_agents` or claim
  it couldn't answer. It now teaches `aggregate_uploaded_file` grouped by
  `client_ip_masked` for "who is accessing", and the `truncated` lower-bound rule.
- **Credentials**: `test_credentials` returning `success: true` no longer proves
  the keys work — rule-18 degradation returns success with
  `identity_hint: "Provider unsupported"`, and a list-denied account returns
  `"authenticated (ListBuckets denied)"`. The skill now teaches reading
  `identity_hint`, not `success`.
- **Version/upload pileup**: on providers without these listings the tools return
  `success: true, provider_unsupported: true` and **zero counts** — the skill read
  that as "no abandoned uploads / no old versions", a clean bill of health for
  something never measured. It now requires checking `provider_unsupported`, and
  treats a truncated page as a lower bound rather than a bucket total.
- **Object lock**: `"none"` is only a real answer when `success: true`; after
  v0.41 a nonexistent object yields `unknown` + `success: false`, which must not
  be read as "unlocked".
- `review_bucket_performance_profile` is taught with its `prefix` argument (it
  lists, so a prefixless call is denied on a prefix-scoped provider);
  `survey_account`'s 100-bucket default cap and `truncated` flag are taught;
  `read_run_result` is taught with `wait_seconds`; `preview_object` is taught its
  gzip/parquet handling.
- **Code fix:** `survey_account` advertised `max_buckets` up to 2000 and clamped
  to 2000, but `RunCreate` caps at 500 — a model taking the docstring at its word
  got a `ValidationError` instead of a larger survey. Both now say 500.

### Known gaps

- Bounded concurrency for the per-bucket survey loop was scoped for this release
  and deliberately deferred: it touches the account-discovery executor's
  per-bucket transaction isolation and its audit-row ordering, and belongs in its
  own change rather than riding along with 20 unrelated fixes.
- The E2E specs are compiled by Playwright (esbuild, no type check) and sit
  outside `tsc --noEmit`, whose `include` is `src`. Type errors there surface as
  test failures rather than at the typecheck gate.


## [0.41.0] - 2026-07-21

_The prompt-injection envelope (SEC4, deferred from v0.40) plus a fresh
adversarial mining round over the streaming lifecycle, budget arithmetic, event
bus, migrations, and frontend — including two empirically-reproduced live-stream
secret leaks, now closed._

### Security

- **Untrusted-data envelope (SEC4).** Every data-deriving tool output the model
  sees is wrapped in `<<external_untrusted_data>>` … `<<end_external_untrusted_data>>`
  markers; literal markers inside a payload are defanged so content can't fake an
  early close and smuggle text outside the envelope. `read_skill` and the memory
  tools stay unwrapped (first-party instruction/ack text); the budget wrapper's
  runtime status notes stay outside. The system prompt now anchors the
  data-never-instructions rule on the exact markers.
- **Live-stream secret leaks closed (both reproduced by execution).** The
  128-char stream holdback was beaten by patterns recognizable only near their
  END: a JWT streamed its header+payload un-redacted until the signature arrived,
  and a bare secret key echoed before its `AKIA…` hint left over SSE whole. The
  stream sanitizer now (a) never emits a still-growing long secret-alphabet
  token, and (b) eagerly masks standalone 40-char base64ish tokens in the LIVE
  view only (the persisted answer applies the precise rules and corrects any
  over-redaction).
- **Hidden reasoning can no longer persist.** Sanitize order was redact→strip;
  a credential-shaped token abutting `</think>` made redaction eat the close tag
  and the whole think-block persisted to SQLite/UI (reproduced). Now
  strip→redact→strip at all three persist sites.
- **Secret-shaped filenames never reach disk or SQLite.** A file named
  `AKIA…-backup.csv` had its name redacted in the display column but persisted
  verbatim in `stored_path` (and raw in the run-scoped datasets table). Both
  upload routes now swap secret-shaped names for generated ones; the run-scoped
  repository redacts its display columns.
- Error text hardening: the runs router / run-service SSE error path and
  `/health/selfcheck` now scrub absolute paths (`scrub_paths`) like the sessions
  router; `scrub_paths` ignores degenerate (short/relative) data-dir prefixes and
  `data_dir()` resolves relative overrides, so error prose is never mangled.

### Agent runtime / streaming

- A turn cancelled while a recoverable provider error was in flight now honors
  the cancel: partial answer + `stopped: true`, instead of launching a fresh
  post-Stop finalize model call that dropped the stopped flag.
- The streaming worker's pre-`try` window (connect / prior-turn wait / summary
  refresh / snapshot) is now covered by the finally that resolves the turn
  handle — a failure there previously left the handle unresolved (next turn
  waited the full 120 s), the SSE without `_DONE`, and the connection leaked.
- The blocking driver drains its event loop (cancel + gather + shutdown asyncgens)
  before closing it, matching the streaming worker.
- Small-window model budgets are clamped to half the window: an operator-declared
  8k/16k local model (llama.cpp / vLLM / Ollama) no longer gets `max_tokens=16384`
  (a guaranteed vLLM 400) or a 200k-char tool budget 3× its whole context.
  128k/200k models are byte-for-byte unchanged.

### Event bus / runs

- The run-SSE absolute backstop is wall-clock based — a run that keeps
  publishing without ever marking done can no longer stream forever.
- Event-buffer truncation is no longer silent: a subscriber whose cursor fell
  behind the retention window gets a synthetic `truncated` event.
- `publish`/`mark_done` no longer mint zombie bus entries for unknown/evicted
  run ids.
- `DELETE /runs/{id}` returns 409 while the run is executing (deleting under a
  live executor re-created orphaned files after the rmtree).
- Startup reconciliation fails only `running` runs; `pending`
  (created-but-never-executed, or the retry revert target) stays retryable.
- `run_sync` closes the SSE stream when the run row vanished in the start race.

### S3 tools / providers

- `get_object_lock_status` no longer reports success + "no retention / no legal
  hold" for a nonexistent object/bucket — hard errors flip the statuses to
  `unknown` with `success: false` (the old answer read as "cleanly deletable"
  for a mistyped key).
- Rule-18: `test_credentials` and `list_buckets` treat a code-less bare HTTP
  501/405 as `Provider unsupported` instead of a credential failure.
- **A stale STS session token can now be cleared**: an explicit empty
  `session_token` on provider update deletes the stored secret (the UI omits
  untouched fields, so "" is always deliberate) — previously rotating from
  temporary to permanent credentials kept signing with the dead token forever,
  with no way out short of deleting the provider. The settings drawer grows a
  "clear saved session token" checkbox.
- `error_triage.list_for_session` pushes its bound into SQL (the summary refresh
  re-read every case + finding to use ten).

### Migrations

- `_create_sig` parses the CREATE column block with paren-depth awareness — a
  future append-only rebuild migration containing `CHECK (… IN ('a','b'))` or
  `DEFAULT (strftime(…))` no longer mis-fragments the recovery signature (which
  could have made crash-recovery replay a non-idempotent rebuild on every boot).

### Frontend

- **IME composition guard** (zh/ja/ko input): Enter committing a candidate no
  longer sends half-composed text — or, during a streaming turn, silently
  CANCELS the user's own turn via the redirect path. Guarded in the composer,
  session rename, and command palette.
- Composer clears reliably after send: the raw-vs-trimmed compare left pasted
  text (trailing newline) in the box, arming the redirect path so a second Enter
  cancelled the running turn and re-sent a duplicate.
- A steer that settles after the user switched sessions stashes the steered text
  as the ORIGINAL session's `failedText` instead of overwriting the visible
  session's composer; `stop()` targets the steered session's flight explicitly.
- Evidence-import dialog: the ghost Cancel button now respects the busy guard
  (every other dismissal already did), and Escape while typing in a field no
  longer destroys the form.
- Model-provider test failures render in red/amber, not success-green.
- Thread finding severities and enum labels are localized (zh users saw raw
  English tokens); `access-logs.parquet` / `s3_access_log.csv` are auto-typed
  access-log (name hints now beat the extension mapping).


## [0.40.0] - 2026-07-20

_Security-floor and correctness hardening from an adversarial mining round: three
more secret shapes are redacted, prefix scoping now matches at a path boundary,
ingestion is bounded against oversized/hostile inputs, run executors persist and
degrade truthfully, and provider-credential failures surface cleanly instead of
as opaque 500s._

### Security

- **Prefix scope now matches at a path boundary, not a raw prefix.** A provider
  restricted to `allowed_prefixes=["logs"]` previously admitted
  `logs-private/secret` via a plain `startswith` — a different top-level path.
  `check_scope` now matches only an exact equal or a `/`-delimited child
  (`logs` / `logs/…`, never `logs-private/…`), and drops empty-string prefix
  entries so a stray `""` can't silently unrestrict the bucket.
- **Three more secret shapes are redacted** in logs/reports/traces/UI: Azure
  Blob **SAS `sig=`** HMAC query params, temporary-credential **session tokens**
  (`FQoG`/`FwoG`/`IQoJ…`), and `private_key = <value>` assignments (GCP
  service-account / TLS keys) — labels kept, values masked.
- The session agent's appended provider block (name + endpoint URL, added after
  `build_session_context` and therefore outside `assert_no_secrets_in_context`)
  now routes both fields through `redact_text`, closing the one place a
  credential-bearing endpoint string could reach the prompt unredacted.

### Ingestion bounds

- `_nonempty_lines` reads via a bounded `readline(_MAX_LINE_CHARS)` loop with a
  cumulative-bytes ceiling, so a single multi-GiB line (or a giant file) can no
  longer be slurped whole into one Python string and OOM the sidecar.
- Free-text group-by labels in the access-log and inventory analyzers are clipped
  to `_LABEL_LEN` before they reach the model context / report prose.
- Finding cells are HTML-escaped in **both** report writers (`analysis_report`
  and `report`), so a crafted finding title/detail can't inject markup
  (`<img onerror=…>`) into a generated report.
- A **future-dated** object (clock skew or a garbage `9999` date) now lands in
  the `unknown` age bucket instead of being mis-bucketed as freshly modified
  (`0-7d`).
- The per-run DuckDB session applies a best-effort `memory_limit` / `threads`
  ceiling, so an unbounded analytical query can't exhaust host RAM and take the
  desktop app down.
- A managed evidence combine now enforces a **cumulative decompressed-output
  budget** across all parts (`_COMBINE_MAX_OUT_BYTES`), closing the gap where
  thousands of individually-under-cap gzip members could still sum to a
  disk-filling total (decompression-bomb defense in depth).

### Run executors

- `recent_run_ids_for_provider` joins on `runs.status = 'completed'`, so a
  crashed/partial survey's snapshot is never read back as the newest — which had
  made "what changed" report un-scanned buckets as removed and posture answers
  come from a truncated set.
- Per-bucket persistence in the account-discovery run is wrapped in a
  savepoint-style try/except: one bucket's write failure rolls back that bucket
  and records a warning finding instead of aborting the whole survey.
- Report generation in the diagnostic, config-review, and account-discovery runs
  is wrapped in `require_success`, so a failed report write fails the run loudly
  instead of silently completing without an artifact.
- A region-mismatch HeadBucket (`301` / `PermanentRedirect`) surfaces a distinct
  `region_mismatch` status instead of a generic access failure.

### Provider credentials

- The encrypted-vault temp file is forced to `0600` via `fchmod` before any
  ciphertext is written, so a leftover `.tmp` (whose pre-existing perms `O_CREAT`
  would otherwise keep) can never be briefly group/world-readable.
- A malformed stored credential reference now raises a clear
  `CredentialResolutionError` ("re-enter the credential") instead of a raw
  `ValueError` surfacing as an opaque 500.

## [0.39.0] - 2026-07-17

_Test coverage, not behavior: a frontend test harness (the frontend had zero
tests) and a provider-compatibility matrix that pins rule-18 degradation. No
product code changes — this locks in the v0.37/v0.38 fixes and the
S3-compatible contract against regression._

### Added — frontend test harness

- **The frontend had no tests at all**, despite a substantial turn-runner / store
  state machine that the v0.38 fixes leaned on. Added a Vitest + Testing-Library
  (jsdom) harness (`npm test`, wired into CI between lint and build) and an
  initial suite:
  - `useTurnRunner` pure helpers — `cleanError` (incl. the FE9 guard: a bare
    "not found"/"404" with no provider context is NOT rewritten to the model-404
    hint) and `looksLikeError` (no false trigger on "I have 404 objects").
  - the `sessionRuns` store — patch/merge, functional patches, the `failedText`
    round-trip (FE2), and the drop-guard (a deleted session's late writes can't
    resurrect its entry, and abort/cancel fire).
  - a turn-runner flow test (api mocked) — a turn that fails while another session
    is visible stashes the message as `failedText`; a failure on the visible
    session restores it into the composer.
  - The production build is unaffected (Vitest config is separate from
    `vite.config.ts`; the bundle is byte-identical).

### Added — provider-compatibility matrix (rule 18)

- Most S3 tests stub AWS-shaped happy paths; the S3-**compatible** contract
  (R2 / MinIO / GCS-XML / B2 / Ceph deviations) had little direct coverage. A new
  `test_provider_compat.py` pins the degradation contract across the real
  deviation shapes (coded `NotImplemented` / `MethodNotAllowed` /
  `NotSupported` / `Unsupported`, and code-less `501` / `405` gateway
  rejections):
  - the central detectors (`_is_unsupported`, `config_tools._read`) map every gap
    shape to `provider_unsupported`, and keep a genuine permission error
    (`AccessDenied` / `403`) DISTINCT (never masked as a capability gap);
  - each object-level read tool (`get_object_tagging` / `_acl` / `_attributes`,
    `list_object_versions` / `list_multipart_uploads`) degrades to a successful
    probe with the gap flagged — never a raise, never `success=false`, never a
    leaked credential;
  - all four `review_bucket_*` engines, run against a provider that implements
    NONE of the config surface, return findings (not a crashed run).
  - The matrix also documents (and pins) an existing inconsistency: the object
    tools express the gap three ways — `tagging_status`/`acl_status`/
    `attributes_status` strings vs a boolean `provider_unsupported`. Left as-is
    (both are documented and agent-read); the tests lock current behavior.

## [0.38.0] - 2026-07-17

_A four-angle sweep (concurrency, API-layer robustness, audit coverage, and
teaching-vs-tool drift) plus a frontend UX pass. No security-floor bound changes._

### Fixed — concurrency

- **A failed turn no longer makes the session hang 120 s on its next turn.** On a
  clean failure (the common fresh-install "no model key" case), the blocking
  handler called `turn_guard.discard()`, which dropped the turn from the registry
  but left the session's active-turn pointer on a handle whose `done_event` was
  never set — so the next message waited the full `_PRIOR_TURN_WAIT_S` (120 s) on
  an event nothing would resolve, and an attached fallback waited 150 s then
  returned a bogus 409. `discard()` now resolves the handle and clears the
  session-active pointer.
- **A retried run gets a fresh event stream.** Re-running a failed run (the atomic
  claim allows `failed → running`) reused the event-bus entry via `setdefault`,
  so a new SSE subscriber replayed the OLD run's terminal events and `done=True` —
  it saw the prior failure and disconnected while the new executor published into
  an already-done buffer. `bus.create()` now resets a previously-done entry.
- **A cross-session `turn_id` collision can't deliver one session's result to
  another.** `set_result`/`fail` ignored the handle's session binding (only the
  readers enforced it); they now replace a foreign-session handle with a fresh one
  bound to the writer, so `get_result` (already session-bound) can never return
  another session's payload.
- **A turn sent without a client `turn_id` no longer bypasses per-session
  serialization.** The server now synthesizes one, so two rapid messages on a
  session always serialize (thread order + a shared dataset import were otherwise
  raceable).

### Fixed — API layer

- **An upload named `.` / `..` no longer 500s.** `Path("..").name == ".."`, so the
  temp-then-rename targeted the parent directory; the sanitizer now maps `.`/`..`/
  empty to a safe default.
- **`GET /runs/{id}/events` 404s an unknown run** instead of streaming an
  instantly-"done" empty timeline that reads as a finished run.
- **A run that fails to launch after the atomic claim reverts to `pending`**
  instead of wedging as `running` (blocking every retry until the next restart).
- **Upload racing a session delete no longer orphans a directory tree + 500s** —
  the insert re-verifies the session and, on the FK violation, deletes the
  just-written file/tree and returns a clean 409.
- **Error responses/SSE no longer leak absolute filesystem paths.** A new
  `config.scrub_paths` collapses the app data dir and OS home dir (username, the
  `app.db` path) out of surfaced `OSError`/`sqlite` messages — `redact_text`
  scrubbed secrets but not paths.

### Fixed — audit coverage (rule 17)

- The DuckDB **dataset import** is audited at the import itself, not only as a
  side effect of a successful analyze/aggregate (an import-then-failed-aggregate
  left no trail); the **diagnostic** executor routes report generation through the
  same audited path as the other four executors (it wrote `report.md` untracked);
  the **session report** endpoint, **run create/start**, `compare_to_last_survey`,
  and `list_uploaded_files` now record audit rows.

### Fixed — agent teaching drift (from the v0.37 tool changes)

- `test_conditional_get` docstring, the data-consistency skill, the S3-layer
  docstring, and the UI trace label all still taught **"HTTP 200 → the object
  changed"** — but v0.37 made 200-with-the-same-ETag mean "the provider ignored
  If-None-Match" (unchanged + `provider_unsupported`). An agent following the old
  text would report a spurious data change. All four now key off `etag_matches`.
- `list_objects` docstring dropped the stale "echoed keys capped at 500 /
  `keys_truncated_in_context`" teaching (the full ≤1000-key page is echoed now);
  the lifecycle-cost skill documents the new REQUIRED `prefix` for
  `list_multipart_uploads` on a prefix-scoped provider; `query_account_profile`'s
  `public_buckets` help now says policy-verdict AND/OR ACL (it always included
  ACL); the `skills_used` contract cap tracks `_MAX_SKILL_LOADS` (10 → 20).

### Fixed — data race

- A **re-upload during an in-flight analysis** can't stamp a stale table as
  imported: `mark_imported` is guarded by the expected `stored_path`, so an
  import of a since-overwritten file loses instead of silently serving the wrong
  data.

### Fixed — frontend

- **Stop during a slow tool call no longer makes the whole turn vanish.** The
  fixed 800 ms wait raced the server's persist, so the reload found no new message
  and wiped the streamed partial; it now waits until the persisted (stopped)
  answer is visible.
- A turn that **fails while you're viewing another session** keeps the message
  (restored into that session's composer on return) instead of losing it.
- A **proposal-chip click during a streaming turn** no longer wipes an unsent
  composer draft; **switching sessions** no longer flashes the previous session's
  messages under the new one; **renaming the open session** refreshes the thread
  header; the **blocking fallback** preserves the "Stopped by user" marker; a
  post-turn reload that loses to a session switch no longer mislabels a healthy
  session as stalled.
- Byte sizes render as **KiB/MiB/GiB** (they used 1024 divisors with KB/MB
  labels — two unit systems in one card after v0.37 relabeled the backend); the
  model-404 error hint only fires for provider-shaped errors (a "session not
  found" turn error no longer sends you to fix a model name); the evidence-import
  dialog closes on **Escape** (idle only) and its ✕ is disabled mid-import;
  blanking a model-provider name shows a friendly message instead of a raw 422.

### Tests

- New `test_v0380_fixes.py` (concurrency, path scrubbing, filename sanitizer,
  stale-import guard, bus reset, reconciler); existing diagnostic/SSE/cap tests
  updated where behavior intentionally changed (report-gen tool call, skills cap).

## [0.37.0] - 2026-07-17

_Four-angle audit batch: crash-recovery completeness, agent enumeration truth,
provider compatibility, engine correctness, de-ossification, and redaction
depth. Every security-floor bound is untouched (one is tightened)._

### Fixed

- **An evidence import interrupted by a crash no longer wedges forever.** The
  download runs in-process, so a hard kill mid-download left the row `importing`
  — a state that could never get back to `confirmed` (re-run) or `planned`
  (re-confirm). Startup reconciliation now fails orphaned `importing` imports
  (and their files), mirroring what it already did for runs.
- **`list_objects` no longer makes keys 501–1000 of a page unreachable.** The
  per-call echo cap (500) sat below the S3 page size (1000) while `next_token`
  advanced past the whole page — so any enumeration with `max_keys > 500`
  silently lost the tail keys with no way to page back to them. The echo cap now
  equals the page cap (a full 1000-key page is ~50 KB, inside the elastic
  tool-output budget that still backstops it).
- **The final answer is never truncated silently.** The one unmarked cut in the
  codebase: the answer contract was hard-sliced at 48 000 chars with no marker —
  in post-processing that promises "write out EVERY item". The cap is now
  model-elastic (≥ 4 chars/token of the completion budget, so it can never cut
  an answer the model was allowed to emit) and, when hit, appends an explicit
  `[TRUNCATED …]` marker.
- **`test_conditional_get` no longer misreports "object changed" on providers
  that ignore `If-None-Match`.** Many S3-compatible providers return `200`
  (ignoring the conditional header) instead of `304`; the tool mapped any `200`
  to `etag_matches: false` even with an identical ETag. It now compares
  quote-normalized ETags: equal on `200` → "unchanged + conditional requests
  unsupported" (rule 18), different → genuinely changed.
- **`list_multipart_uploads` works on prefix-scoped providers.** The wrapper
  exposed no `prefix`, so any provider with `allowed_prefixes` always denied the
  root listing, making the abandoned-upload cost diagnostic unreachable there.
  It now takes a `prefix`, passed to both the scope check and the S3 `Prefix=`.
- **`get_object_lock_status` no longer reads a malformed call as "no lock".**
  The broad `InvalidRequest` code was blanket-mapped to "none"; only its
  object-lock flavor ("Bucket is missing Object Lock Configuration") means that.
  Other `InvalidRequest`s now surface as errors instead of "cleanly deletable".
- **Inventory engine:** no more `Storage-class skew: 'None' covers 100%` finding
  when the inventory simply has no storage_class column (the same null-group
  guard hot-key/hot-prefix already had); `average_object_size` uses floor
  division so multi-PB totals keep int64 precision above 2^53.
- **DuckDB layer:** a read-only open of a missing analytical DB is a clean
  "nothing imported yet" error instead of creating a stray empty `.duckdb` via a
  writable fallback; writer-side lock contention now gets the same friendly
  retryable message readers already had.
- **`session_datasets` dedupe matches NULL filenames** (`IS`, not `=`), so a
  re-uploaded nameless file can't create two rows pointing at one on-disk path.

### Security

- **A pasted bare AWS access-key/secret-key PAIR is now fully scrubbed.** The
  secret-key redaction rule is label-anchored (so bucket/object names aren't
  blanket-mangled), which let a bare 40-char SK pasted alongside its `AKIA…` key
  id survive redaction, be persisted, and re-enter the next turn's prompt. A
  narrow rule now masks bare 40-char base64 tokens ONLY when the text also
  carries an AWS access-key-ID shape — ordinary 40-char strings without that
  hint remain untouched.
- **`session_messages` JSON columns (`tool_activity`, `grounding`,
  `proposed_actions`) pass through `redact()` at the persistence boundary**,
  like every sibling repository — defense in depth for rule 14; the agent
  runtime still sanitizes upstream.

### Changed (de-ossification — no security-floor change)

- **The completion budget's only upper bound is the model's real provider
  max-output.** The module-wide 32 768 ceiling is gone: the per-model clamp
  already existed, so the ceiling only ever bit models whose real output cap is
  higher (claude-3-7 / gemini-2.5 at 64k, o-series at 100k) — starving long
  enumerations on exactly the models that could hold them.
- **The survey/config-review summary echoed to the agent scales with the model
  window** (floor 2000 chars, ceiling 16k) instead of a flat 2000.
- **The deterministic session summary scales too:** the persisted store holds up
  to 200 facts/findings (was 50) and the context echo is model-elastic (floor
  50), matching the agent-memory de-ossification; the human-readable digest
  stays at 50 entries with an explicit "+N more" note.
- **Size labels are binary to match the binary math** (KiB/MiB/GiB, thresholds
  like `<4KiB`/`128KiB-1MiB`): the divisors were always 1024-based; only the
  labels said KB/MB.
- Docs: note that gated larger context windows (e.g. Claude 1M beta) should be
  declared via the model provider's explicit `context_window` override.

### Tests

- 20 new regression tests (`test_v0370_fixes.py`) covering every item above;
  existing tests updated where behavior intentionally changed (full-page echo,
  provider-cap-only completion budget, object-lock message flavor).

## [0.36.0] - 2026-07-17

_Migration crash-recovery: a partially-applied table-rebuild no longer wedges the
app or loses data._

### Fixed

- **A table-rebuild migration interrupted mid-way now recovers instead of
  wedging the app forever.** Two migrations rebuild a table by
  `CREATE <new> / INSERT..SELECT / DROP <final> / RENAME <new>→<final>`
  (`_M002` relaxing `tool_calls.run_id` to nullable, `_M004` reshaping
  `datasets`). `executescript` commits each statement implicitly and cannot roll
  back, so a crash — power loss, kill, OOM — between those statements leaves a
  partial state with the migration's version row unwritten. On the next boot the
  whole migration re-runs. `_M004` renames COLUMNS (`kind → dataset_type`), so
  once the rename has completed its `INSERT..SELECT` copies from the NEW-schema
  table and raises `no such column: kind` — **not** an idempotent marker — so
  every subsequent boot failed and the app never started. `_apply_one` now calls
  a rebuild-aware recovery (`_recover_table_rebuild`) that recognizes each crash
  window from the on-disk schema: it finishes the rename when the data already
  lives in `<new>`, stops when the rebuilt shape is already in place, and
  otherwise drops the stale partial copy and re-runs the rebuild from the intact
  table. Detection compares full column signatures (including the `notnull`
  flag), so a constraint-only rebuild like `_M002` is distinguished from an
  un-rebuilt table even though its column names are unchanged — the naive fix
  (tolerating the error) would have DROPped the populated table and renamed an
  empty one in, silently losing rows. This holds even when the interim `<new>`
  table is already gone: the rebuilt shape is then parsed (name + `notnull`) from
  the migration text rather than compared by column names alone, so a future
  constraint-only rebuild can never be mistaken for already-applied.

### Tests

- **Every crash window of both rebuilds is covered.** New parametrized tests
  drive a crash after each statement of `_M002` (8 windows) and `_M004` (7
  windows), seed real rows first, then re-run the migration and assert the rows
  survive with the rebuilt shape (`kind → dataset_type`, `source_path →
  stored_path`, `run_id` now nullable). All windows recover with data intact.

## [0.35.0] - 2026-07-17

_Report-artifact hardening + an upgrade regression guard._

### Security

- **Saved Markdown reports escape their table cells.** Report tables interpolated
  object keys and user-agents — the most attacker-influenceable data in the
  product — straight between `|` delimiters with no escaping. An S3 key containing
  `|` misaligned the row's columns, a newline split one row into two (corrupting
  the rest of the table), and a key like `<img src=x onerror=…>` landed as stored
  HTML in the `.md` that executes when viewed in a renderer. (Credential redaction,
  applied to the whole document, does not cover these metacharacters.) All four
  report types now escape every cell — `|`, CR/LF, backticks, and `<`/`>` — at the
  render boundary.

### Tests

- **Regression guard for old-DB upgrades.** Added a test that seeds an
  old-schema database with rows in the tables later migrations REBUILD
  (`tool_calls` @ migration 002, `datasets` @ 004), runs a full upgrade, and
  asserts the data survives intact (`kind → dataset_type`, `source_path →
  stored_path`, counts preserved). This upgrade-on-real-data path was verified
  sound but previously had no coverage.

## [0.34.0] - 2026-07-16

_Analysis-engine correctness, lifecycle robustness, and agent de-ossification. A
three-angle audit (agent ossification, DuckDB engine math, state-machine
lifecycle) plus the reviewed third-party findings — bugs that misreported numbers,
wedged state forever, or needlessly boxed the agent in._

### Fixed — analysis engine correctness

- **Status codes and sizes are integers, not floats.** A single unparsed log line
  (or a missing inventory size) coerced the whole numeric column to float64 →
  DuckDB DOUBLE, so reports showed status codes as `404.0` and object sizes above
  2^53 lost precision (and `total_size` accumulated in DOUBLE). The integer columns
  are now built as nullable Int64, preserving both the label and the value.
- **Access-log error rates are "of requests", not "of lines".** `error_rate_4xx/5xx`
  and the 206/404/403 shares divided by every ingested line, including
  text-fallback rows with no status — diluting the rate by the unparsed fraction
  and silently under-reporting errors across the whole [0.5, 1.0) parsed band the
  truth guard allows. They now divide by the count of rows that actually parsed a
  status code.
- **Inventory average/small-object figures use consistent denominators.**
  `average_object_size` is now `total_size / object_count` (so the displayed
  total/count/avg triple reconciles), and `small_object_ratio` is computed over
  objects that HAVE a size (not diluted by null-size rows).
- **Object age bucketing is timezone-independent.** The DuckDB connection now pins
  `TimeZone='UTC'`, so `datediff` against `current_timestamp` no longer lands
  objects in the adjacent age bucket when the sidecar runs outside UTC.

### Fixed — lifecycle robustness

- **A failed dataset-persist no longer wedges an evidence import in `importing`
  forever.** The post-download persistence ran outside any try/except (and had no
  startup reconciler, unlike a run), so a DB error there left an import that could
  never be re-confirmed or re-run. It now reverts to `failed` and cleans up.
- **The blocking turn path resolves its turn handle on a persist failure**, like
  the streaming worker already did — otherwise a commit error left the handle
  un-done and non-evictable, stalling every subsequent turn in that session for
  120s until eviction.
- **The loser of a concurrent evidence-import claim fails its orphan run** instead
  of leaving a permanent session-unlinked `pending` row.
- **A `report_ready` publish failure can't downgrade a completed run to `failed`**,
  and the executor's failure branch refuses to overwrite a terminal state.

### Fixed — model provider & budget (reviewed findings)

- **The provider test no longer gives false green/red.** A 404/405 on `/models`
  (common on minimal proxies) was reported as a confident pass even though the key
  was never verified; and a valid empty `base_url` (which uses the OpenAI default,
  exactly like the real client) was flagged "configuration incomplete." The test
  now reports "reachable, key unverified" as a caution and treats `base_url` as
  optional.
- **The tool-output budget is a hard cap, not a soft one.** A single tool return
  was only counted AFTER it landed in context, so one large result could blow past
  the per-turn budget. An output that would exceed the remaining budget is now
  withheld with a valid JSON "too large — narrow it" envelope.

### Changed — de-ossification (don't box the agent in)

- **Custom aggregation gained real expressiveness** without loosening the
  whitelist-and-bound-params floor: a SECOND group-by dimension (cross-tabs like
  "403s per masked-IP per day"), `day`/`weekday` time buckets, and
  `distinct_ips`/`distinct_keys`/`p99`/`min`-`max`-bytes metrics — all fixed SQL
  fragments, zero raw-row exposure. Top-N now has a deterministic tiebreaker.
- **Operator-declarable max output tokens** (`max_output_tokens` on a model
  provider) clamps the completion budget, so a third-party/unknown model whose real
  cap is lower doesn't get a `max_tokens` its endpoint 400s on — symmetric with the
  existing context-window override.
- **Agent working-memory recall now scales with the model window** (floored at 50),
  like thread replay already did — a long investigation on a large-context model no
  longer has its own recorded facts/findings clipped first. The per-turn skill-load
  guard was raised (the elastic tool-output budget is the real bound), and the
  survey bucket ceiling raised to 2000.
- **The agent is reminded tool-result text is untrusted** — carried from v0.33; no
  change here.

### Fixed — frontend

- **The 409 blocking-fallback captures its "answer baseline" before the turn
  starts**, not from a GET issued after the 409 — closing a race where an answer
  persisted in that window poisoned the baseline and the UI hung "running" for ~2.5
  minutes before recovering.

## [0.33.0] - 2026-07-16

_S3-compatible provider correctness round. The product's core promise — works
against AWS **and** MinIO/Ceph/R2/B2 — got its first dedicated pass, alongside two
frontend desync fixes and one prompt-injection defense-in-depth line. Found by a
fresh three-angle audit (untrusted-data ingestion, S3-compat edge cases, frontend
runtime)._

### Fixed — S3 correctness & provider compatibility

- **A bucket with no policy is now judged "not public", not "unknown".**
  `review_bucket_security` set the policy verdict only when `GetBucketPolicyStatus`
  returned a value, so the common case (no bucket policy at all → `NoSuchBucketPolicy`)
  left the combined verdict at "cannot rule out public" even with a clean, readable
  ACL — and disagreed with the survey path, which already maps it. Absent ≠ unknown:
  no policy means the policy can't be public.
- **Addressing-style checks no longer lie on IP endpoints (MinIO/Ceph).** botocore
  never virtual-hosts against a bare IP, so the "virtual" probe silently sent the
  identical path-style URL and the tool reported `both_work` — on the single most
  common S3-compatible setup. It now detects an IP endpoint, reports path-style,
  and says virtual-hosting isn't testable there.
- **List tools surface capability gaps consistently (rule 18).** `list_object_versions`
  and `list_multipart_uploads` turned a provider's `NotImplemented`/`501` (and now a
  bare `405`) into a hard failure — read by the agent as "0 versions / 0 uploads"
  on a clean bucket. They now return `provider_unsupported`, like the sibling object
  tools.
- **Paging is real, not advertised-only.** The agent wrappers for
  `list_object_versions`, `list_multipart_uploads`, and `list_upload_parts` dropped
  the paging markers the S3 layer already accepted, so a versioned bucket with
  >1000 versions (or a 10,000-part upload) had its first-page counts reported as the
  total. The markers are now threaded through, and `list_upload_parts` accepts a
  `PartNumberMarker`. `list_buckets` now follows `ContinuationToken` (with a page
  cap + `list_truncated` flag) instead of silently returning only the first page.
- **Evidence-import listing no longer hides its cap.** `_list_prefix` stopped at
  5000 objects with no signal; since access-log/inventory keys sort chronologically,
  a recent-window query silently missed the newest logs. It now returns a truncation
  flag (surfaced as a plan warning) and a page-budget guard that also stops a quirky
  provider from looping forever on an empty-page continuation token.
- **No more false "wrong signing region" on custom endpoints.** A MinIO/Ceph server
  that returns an empty `LocationConstraint` was normalized to `us-east-1` and then
  flagged as mismatched against any region label the user typed. The mismatch check
  now skips a custom endpoint whose bucket reports no region.

### Fixed — frontend

- **A transient refresh blip at turn completion no longer erases the answer.** After
  a turn, the thread reload could fail (sidecar GC/restart/network) yet the code
  unconditionally cleared the streamed answer bubble — so the fully-streamed answer
  and the user's message both vanished. `reload` now reports success and the bubble
  is kept (marked stalled, with a reload affordance) when the reconcile blips.
- **Concurrent reloads of the same session can't clobber each other.** A monotonic
  reload token drops a stale in-flight reload so it can't overwrite a newer one
  (e.g. an empty first-render fetch landing after the full post-turn fetch).
- **The health poll clears its abort timer on a fetch rejection**, not only on
  success.

### Security (defense-in-depth)

- **The agent is told tool-result text is untrusted data.** A read-only investigator
  ingests attacker-influenceable bytes (bucket/object names, previewed object bodies,
  config rules, log content). Structurally these only ever reach the model through
  the tool channel, never the system prompt, and every tool is read-only with
  EXPENSIVE actions confirmation-gated — so the exposure ceiling is "a wasted turn",
  not RCE. A new safety rule makes it explicit: report on that text, never obey
  directives found inside it.

## [0.32.0] - 2026-07-16

_Security + data-lifecycle round. Two real vulnerabilities in the glue layer, and
the first pass at reclaiming local storage over long-lived installs — the surface
that only shows up after weeks of daily use. Found by a fresh three-angle audit
(glue scripts/Tauri config, data lifecycle, runtime log-leak surface)._

### Security

- **Windows command injection in the link opener is closed.** `open_external`
  validated only the URL scheme, then on Windows ran `cmd /C start "" <url>`.
  cmd.exe reparses its argument string and treats `& | < > ^` as metacharacters,
  and Rust's std cannot safely escape for cmd/batch — so a link like
  `https://x/&calc.exe` (and links come from agent output / imported reports)
  could run an arbitrary command when clicked. It now launches via
  `rundll32 url.dll,FileProtocolHandler` (a real executable, URL passed as one
  escaped argv arg, no shell reparse) and rejects URLs containing whitespace or
  control characters. `&` in legitimate query strings is preserved.
- **422 validation errors no longer echo plaintext secrets.** FastAPI's default
  handler returns pydantic's error list verbatim, and each error carries the
  offending `input` — for a missing-required-field error that `input` is the
  entire request body. On the provider-create endpoints that body holds the
  plaintext access key / secret key / session token / model API key, so a 422
  leaked them into the HTTP response and the UI error banner. A new handler strips
  `input` and redaction-passes the messages, keeping `type`/`loc`/`msg`.

### Fixed — data lifecycle

- **Deleting a session now removes its files, not just its rows.** The upload
  tree (`data/sessions/{id}/`, raw files up to 2 GiB each plus per-dataset DuckDB
  files) was left on disk forever, unreachable and invisible to the UI. Session
  delete now removes that tree.
- **Runs are deletable, and their disk artifacts are reclaimed.** There was no
  `DELETE /runs/{id}` at all, so run rows and their `data/runs/{id}/` trees (raw
  evidence up to 5 GiB, analysis.duckdb, report.md) accumulated forever — and the
  agent silently mints an internal run on every survey/config-review. Added the
  delete endpoint (row cascade + directory removal); session delete now also
  removes the internal ('agent'-origin) runs it spawned; and startup sweeps
  'agent'-origin runs whose session no longer exists. User-authored report runs
  are never auto-deleted.
- **The write-only audit trail is bounded.** `audit_logs` (and ad-hoc
  `run_id IS NULL` tool_calls) grew forever with zero read path. A startup pass
  ages out rows past a retention window — a full year by default, tunable via
  `STORAGE_AGENT_AUDIT_RETENTION_DAYS` (0 disables) — backed by new created_at
  indexes.
- **Session-rail enrichment no longer does N+1 counts**, and the cross-session
  message search is capped, so both stay flat as sessions and threads grow.
- **A failed evidence import cleans up after itself.** It left a partial combined
  file in the run's raw dir and the analysis run stuck `pending` until the next
  restart; the partial dir is now removed and the run is marked failed inline.

### Fixed — build & logging

- **The packaged sidecar reports the real release version.** `stamp-version.py`
  ran *after* `pip install` in the release jobs, but the sidecar reads its version
  from `importlib.metadata`, which is frozen at install time — so `/health` and
  the OpenAPI spec reported the pre-stamp `0.23.0`. Stamping now runs before the
  install. `/health` exposes the version, and the smoke test asserts the bundle
  resolved a real version (not the `0.0.0+source` fallback).
- **The packaged entrypoint scrubs `OPENAI_LOG`** and pins the httpx/openai/
  botocore loggers to WARNING, so a stray environment variable can't turn on
  verbose wire logging that would dump conversation content to the captured
  child stderr.
- **`app.__version__` derives from package metadata** instead of a hardcoded
  `0.1.0` literal that silently rotted.

## [0.31.0] - 2026-07-16

_Packaging-integrity + ops-robustness round. The least-audited surface — how the
app is bundled, released, and launched — plus two data-integrity fixes. The
security floor is untouched (and its packaging is now proven, not assumed)._

### Fixed — packaging & release integrity

- **The packaged bundle now proves it can actually run, not just answer
  `/health`.** A PyInstaller bundle can pass the liveness probe while silently
  missing a lazily imported native dependency — the OpenAI Agents SDK, a botocore
  S3 service model, the DuckDB/PyArrow engines, or the `cryptography` binding the
  AES-256-GCM secret vault decrypts with — because none of those load on the
  `/health` path. Added a deep self-check (`GET /health/selfcheck`) that imports
  and exercises each offline (no network, no credentials, no secrets), and made
  the release smoke test assert it. A broken bundle now fails the build instead
  of breaking in a user's hands.
- **`cryptography` is now collected in full by the PyInstaller spec.** The secret
  vault decrypts with it, and it ships a compiled `_rust` binding loaded lazily;
  it was riding only on PyInstaller's built-in hook. A bundle that can't open the
  vault is a security-floor break, so it is collected explicitly like the other
  native packages.
- **Releases publish atomically.** The workflow created a *published* GitHub
  Release up front, then uploaded assets from three parallel platform jobs — so a
  failure on any platform left a permanently half-populated public release.
  Releases are now created as a draft and published only after all three
  platforms succeed; a partial run leaves a reviewable draft, never a broken
  public download.

### Fixed — launch & data integrity

- **A missing/unspawnable sidecar no longer crashes with an opaque panic.** The
  Tauri launcher used `panic!`/`.expect()` for resource-dir resolution and
  sidecar spawn, which unwinds through the FFI boundary as an uninformative
  crash. It now returns a clear error from `setup` (and logs a precise
  diagnostic), so startup aborts cleanly with a debuggable message.
- **Numeric access-log timestamps are parsed instead of dropped.** Unix epochs
  (seconds / milliseconds / microseconds / nanoseconds, common in JSON and CDN
  logs) failed every text format and cast to NULL downstream, so every hour
  bucket became `'unknown'` and the log's entire time analysis vanished. They now
  normalize to UTC, gated on the exact digit widths a real epoch has (10/13/16/19)
  so compact wall-clock stamps like `202406251000` (yyyyMMddHHmm) parse as dates
  rather than being misread as far-future epochs, and small integers (ports,
  status codes) are never misread as timestamps.
- **Migration crash-recovery tolerates a re-inserted seed row.** The idempotent
  replay after a partial-apply crash only caught the `OperationalError` DDL cases
  (duplicate column / existing table); an `INSERT` that re-added a seed row would
  raise `IntegrityError` and wedge the runner. Both are now recognized as the
  same "already applied" signal — while a genuine constraint violation is still
  never swallowed.

### Changed — agent tool guidance

- **`survey_account` now flags itself as the costly live-scan path.** Its
  description steers the agent to the cheap persisted-profile readers
  (`query_account_profile`, `compare_to_last_survey`, both no new S3 calls) for
  account-wide posture and "what changed" questions, reserving the live survey
  for establishing or deliberately refreshing a profile.

## [0.30.0] - 2026-07-16

_The deep round: concurrency correctness, engine truth guards, "the survey
tells the whole truth", and a first full frontend hardening pass. Three fresh
audit angles (frontend deep-dive, concurrency/lifecycle, analysis-engine math)
plus the prior round's verified slate — all in one release. Security floor
untouched (and strengthened: PEM redaction, filename redaction)._

### Fixed — concurrency & lifecycle

- **Turns are now serialized per session.** The turn registry keyed only on
  turn_id, so a steer (cancel + resend) started the new turn while the cancelled
  one was still persisting: the new turn's context was missing the steered turn
  entirely, and its late writes landed AFTER the new turn's — permanently
  scrambled thread order. A new turn now auto-cancels the session's prior live
  turn and its worker waits (bounded) for the prior to finish persisting before
  snapshotting the thread. Cancellation is also observed at TOOL ENTRY (a chain
  of blocking S3 calls no longer runs minutes past Stop).
- **`POST /runs/{id}/message` claims the run atomically** — two concurrent
  POSTs (double-click/retry) both passed the check-then-act guard and raced two
  executors on one run row (duplicate tool_calls, report overwrites, terminal-
  status flapping). A conditional UPDATE lets exactly one through.
- **Uploads are temp-then-rename** — a mid-stream failure no longer leaves a
  truncated file at the path an existing dataset row references (silently
  analyzed later); partial files are cleaned up.
- **Shutdown hardening**: SSE emit no longer aborts the worker's persist chain
  when the main loop already closed; the worker's event loop cancels pending
  tasks + finalizes async generators before closing (leaked HTTP pools).

### Fixed — verdicts & truth

- **`publicly_exposed` now asserts True from a single proven signal.** Policy-
  public with the ACL unreadable — or ACL-public with `GetBucketPolicyStatus`
  provider-unsupported (the common non-AWS case) — previously yielded
  "indeterminate" on a provably public bucket.
- **Truncated-PEM redaction bypass closed** (confirmed by two independent
  audits): a key cut mid-body followed by a foreign END armor (a normal
  .pem-bundle partial paste) slipped past both rules. The lookahead now blocks
  only on a PRIVATE-KEY end armor and stops at the next BEGIN, so the following
  certificate is preserved.
- **Engine truth guards**: a mostly-unparsed access log now leads with an
  honest "Log mostly unparsed" warning instead of "0% errors" + hot-key
  findings fired on the null group (`parsed_fraction` metric, minimum-sample
  guards); an inventory with mostly-missing sizes warns instead of claiming
  "distributions look balanced" (`unknown_size_ratio`).
- **Survey-diff upgrade noise baselined**: fields only the newer survey has
  (schema growth) no longer flood the diff as None→value changes that could
  truncate a real became-public signal; security-relevant flips carry
  `"alert": true` and sort first (truncation can never cut them). 5xx triage
  aliases no longer duplicate the generic ServerError guidance; error-code
  tie-breaking is deterministic; user-chosen filenames are redacted at persist
  and prompt-embed.

### Added — the survey tells the whole truth

- **Per-bucket ACL exposure in the survey** — `acl_public` + combined
  `publicly_exposed` flags, with the ACL GET **skipped** under
  `BucketOwnerEnforced` (ACLs disabled — most modern buckets) and paid for
  twice over by deduplicating the two GETs the survey used to re-issue for
  evidence discovery.
- **The survey narrates public exposure**: summary counts (`public_buckets`,
  `acls_disabled_count`), a CRITICAL "PUBLIC buckets detected" finding, a
  public-exposure note in the final summary the agent reads, a **Public**
  column + security-summary rows in the account report, and public buckets
  join `buckets_needing_review`.
- **`review_bucket_config` returns real findings** — a bounded, severity-
  ordered digest (≤12 titles) in the tool result, instead of bare counts that
  forced the agent to re-run the five per-aspect reviews.
- **Routing honesty**: `survey_account` returns `has_prior_survey` (+ an
  explicit next-step nudge to `compare_to_last_survey`), accepts
  `max_buckets` (1–500) for large accounts, and echoes `truncated`;
  `query_account_profile` echoes `survey_truncated`.
- **Session report absorbs agent-recorded findings** (provenance-labeled) — a
  "became public" discovery no longer lives only in chat prose.
- **Triage**: `AccessControlListNotSupported` (ACLs on a BucketOwnerEnforced
  bucket — the modern classic), `NoSuchUpload`, `InvalidRange`;
  `InvalidObjectState` re-bridged to the lifecycle skill.
- **Skills re-taught (round three)**: `public_buckets` + became-public alerts
  in account-posture and security-iam-policy; account-wide filter mentions in
  observability-audit and lifecycle-cost.

### Fixed — frontend

- **Error boundary**: a render crash now shows an error + reload button
  instead of a permanent white screen.
- **Report download + external links work in the packaged app**: a core-only
  Tauri `save_report` command writes to Downloads (WKWebView ignores blob
  anchor downloads) and `open_external` opens https/mailto links (Tauri v2
  swallows target=_blank without a plugin); dev/browser keeps the old paths.
- **Steer text-loss trio**: a second steer during settle replaces the pending
  message (latest wins) instead of vanishing; a failed steer-upload restores
  the typed text; typing during the settle window is no longer wiped.
- **Provider fields are clearable**: blanking base URL / model / endpoint /
  region on edit now clears it ("" → NULL protocol) instead of silently
  reverting.
- Stale view errors clear when the next turn starts; Escape closes the report
  overlay; the import dialog ignores backdrop clicks while an import runs; a
  proposal chip click during a running turn steers instead of silently
  no-opping; slash-menu Escape keeps the typed text; the attachment size error
  auto-clears; code-block copy hardened (fallback + no unhandled rejection);
  transient triage-fetch failures no longer flash cards out of the thread;
  streaming no longer hides a legitimate ```json block in the answer;
  tool-timeline statuses and the palette hint are localized; i18n
  interpolation survives $-patterns in values.

## [0.29.0] - 2026-07-15

_Correction + coverage release: fix the v0.28.0 public-verdict over-claim, teach
the skills the new aspects, make "which buckets are public?" an account-wide
one-call answer, fill the classic error-triage holes, surface the operator
escape hatch in the UI, and land a batch of hardening/de-ossification micro-fixes._

### Fixed

- **`policy_status` no longer over-claims (false-negative risk).**
  `GetBucketPolicyStatus.IsPublic` evaluates only the **bucket policy** — not ACL
  grants — but v0.28.0 labeled it the "combined policy+ACL+PAB authoritative
  verdict". On a bucket public via its ACL the review emitted a GOOD "Not public
  (AWS authoritative verdict)"; with the ACL unreadable that false GOOD was the
  *only* verdict. Now: the fact is `policy_is_public` (policy-scoped finding
  text), and a combined `publicly_exposed` verdict is asserted **only when both**
  the policy verdict and the ACL were readable — an unreadable ACL yields an
  explicit "exposure cannot be ruled out" warning instead of a false GOOD. Tool
  description, docstrings, and docs all re-scoped.
- **Evidence-import planning no longer 500s on a broken credential.** The plan
  endpoint (the "Import access logs / inventory" proposal click) called
  `build_s3_client` unprotected; a missing vault value — exactly the case
  `CredentialResolutionError` targets — surfaced as a raw 500. Now a sanitized,
  actionable 424 (and other planning failures → sanitized 502, never a raw 500).
- **Max-output table: `gemini-2.5` (64k) and `deepseek-reasoner` (64k) entries**
  — both were caught by their families' 8k entries, provider-truncating long
  enumerations. `gemini-2.5-pro` now budgets 32768.
- **A stale session-token ref on a keyless provider no longer errors.** The
  token could never be used (no access/secret key → anonymous either way), so
  `CredentialResolutionError` now fires only for refs that would actually sign.
- **Truncated-PEM redaction (R-6).** A private key cut mid-paste (BEGIN armor,
  no END) previously leaked its partial body into persisted triage cases; a
  BEGIN-without-END fallback now redacts to end-of-text.
- **DuckDB lock → friendly error (R-7).** Reading a dataset mid-import surfaced
  a raw lock IOException; now "dataset is busy — retry in a moment".

### Added

- **Account-wide public posture.** The survey snapshot now reads
  `GetBucketPolicyStatus` + `GetBucketOwnershipControls` per bucket and persists
  `policy_is_public` / `object_ownership` / `acls_disabled` flags;
  `query_account_profile` gains a **`public_buckets`** filter ("which of my N
  buckets are public?" — one call, no re-scan); and the survey diff compares the
  new flags, so `compare_to_last_survey` can finally alert **"bucket X became
  public since the last survey"**.
- **Error-triage coverage batch.** `InvalidObjectState` (archived GLACIER/
  DEEP_ARCHIVE object → routes to `head_object`'s restore/storage-class fields),
  dotted **KMS codes** (`KMS.AccessDenied`/`KMS.DisabledException`/
  `KMS.NotFoundException` — the code regexes previously couldn't match a dot),
  `ExpiredToken`/`InvalidToken` (STS expiry), `NotImplemented`/`MethodNotAllowed`
  (rule-18 capability gap, not a failure), and playbooks for the four codes the
  parser knew but never mapped (`ServiceUnavailable`, `Throttling`,
  `InternalError`, `BadGateway` — previously "Could not classify").
- **Frontend: the v0.28.0 operator escape hatch is now reachable** — a
  "Context window" field on the model-provider form (clearing it resets to
  name-based inference; API accepts `0` to clear). Plus **Copy / Download .md**
  on the report overlay, and a client-side 2 GiB pre-check on attachments
  (instant clear message instead of a minutes-long upload → 413).
- **Skills re-taught the v0.28.0 aspects** (the v0.26 lesson, applied again):
  security-iam-policy routes "is it public?" through `policy_status`+`acl`+
  `ownership` and `review_bucket_security`'s combined verdict;
  replication-versioning's now-false "config review only shows whether
  object-lock is enabled" claim fixed (aspect `object_lock` returns the default
  retention); event-notification reads per-target rules via aspect
  `notification`; protocol-compatibility uses aspect `cors`; migration-sync
  teaches `get_object_attributes` checksums.

### Changed

- **De-ossification/hardening micro-batch:** the user-message prompt cap scales
  with the model window (floor 16k chars, ceiling 64k — pasted config/error
  dumps were clipped on large-window models); the tool-output budget gains a
  2M-char ceiling (an absurd declared window can't create an unbounded budget);
  `_MAX_FINDINGS` synced to the summary builder's 50 (was 30 — drift);
  `_MAX_REPLAY_TOOLS` locked to `_MAX_TURNS` by assertion (was 40 vs 60 — drift);
  the per-turn SSE queue is bounded (10k events, oldest dropped) so a stalled
  consumer can't grow memory without limit.
- **boto3 clients are cached** per (provider, addressing-override, config
  version) with explicit invalidation on provider update/delete — a deep
  40-probe turn no longer pays client construction + vault decrypt per call.
  The cache holds clients only, never plaintext secrets.

## [0.28.0] - 2026-07-15

_Public-posture visibility + budget-table de-ossification. The agent gains
AWS's authoritative "is this bucket public?" verdict and the modern
access-control posture, and the v0.27.0 depth elasticity is extended so it can't
silently re-ossify on a new model. Plus targeted correctness fixes._

### Added

- **Authoritative bucket public-posture, reachable at last.** `get_bucket_config_summary`
  read `GetBucketPolicyStatus`, `GetBucketOwnershipControls`, and
  `GetObjectLockConfiguration` but collapsed each to a bare status — the agent had
  **no path** to the actual values. Four new `get_bucket_config_detail` aspects
  surface them (read-only, sanitized):
  - `policy_status` — AWS's **authoritative `IsPublic`** verdict (the combined
    policy + ACL + public-access-block computation; use before hand-parsing the
    policy, which misses PAB-override semantics).
  - `ownership` — Object Ownership (`BucketOwnerEnforced` = ACLs disabled, the
    recommended posture).
  - `object_lock` — bucket-level WORM default (enabled + retention mode/days/years).
  - `acl` — bucket ACL grants reduced to grantee **KIND** + permission (no owner
    canonical id, display name, or email).
- **`review_bucket_security` now reports the authoritative verdict** — folds
  `IsPublic` (a CRITICAL finding when true) and Object Ownership (ACLs-disabled)
  into its facts + findings, instead of only a hand-computed public boolean.
- **Operator-declarable model context window.** A model provider can now carry an
  explicit `context_window` (tokens), overriding the built-in model→window table
  so a newly-shipped large-context model isn't throttled to the default. New
  nullable `model_providers.context_window` column (migration 17); optional on the
  create/update API; unset → inferred from the model name as before.

### Changed

- **Thread-replay context is now model-elastic.** How many prior messages and how
  many chars per message the agent re-sees (`_MAX_MESSAGES` / `_MAX_REPLAY_MSG`)
  were flat constants while the v0.27.0 tool-output budget scaled with the model
  window. They now scale with the window too — floored at the historical values
  (small models unchanged) and bounded above — so a large-context model keeps more
  of the thread on a long investigation.
- **Performance-profile sample widened.** `review_bucket_performance_profile`
  estimated the small-object ratio from a 100-object sample; raised to 1000 (the
  ListObjectsV2 page cap) — still a single bounded call and no body reads (the
  echoed sample stays capped at 20), just a far less noisy statistic.

### Fixed

- **Completion budget is clamped to each model's real max-output.** The
  per-turn `max_tokens` budget (16k–32k) exceeded some providers' output caps
  (gpt-4-turbo 4096, Gemini 8192, Claude 3.5 8192) → a hard 400. It's now clamped
  to a per-model max-output table; unknown models keep the historical floor.
- **No-credential edge: a configured-but-unresolvable credential now fails
  loudly.** When a provider had a credential *ref* stored but its vault value was
  missing (deleted secret / out-of-sync vault), the client silently downgraded to
  anonymous — surfacing later as a baffling `AccessDenied`. It now raises
  `CredentialResolutionError` telling the operator to re-enter the credential.
  (The genuine no-credentials case still signs anonymously, unchanged.)
- **CSV/TSV delimiter regression from v0.27.0.** The v0.27.0 single-read
  optimization could lock the parser onto a comma for a TSV whose header cell
  contained a comma, nulling every request field. The parser now tries the
  delimiter the header implies first (tab when the header contains a tab, matching
  the format detector), keeping the single-read win.

## [0.27.0] - 2026-07-15

_De-ossification + hotfix batch. The agent's investigation depth now scales to
the active model's context window instead of a single hardcoded constant, while
the security floor (byte/list/sample/ingest caps) stays pinned. Plus a set of
correctness fixes to posture queries, client credentials, and parsing._

### Changed

- **Agent depth is now model-elastic (`agent_runtime/model_budget.py`).** The
  per-turn tool-output budget — the PRIMARY governor of how deep an
  investigation goes — was a single hardcoded 200k-char constant chosen for "a
  modern 200k-token context". It throttled a 1M-context model to a quarter of the
  depth its window supports. The budget (and the completion-token cap) is now
  derived from the active model's context window, with the **historical values as
  a hard floor** — a 128k/200k deployment is byte-for-byte unchanged, a 1M model
  gets a proportionally deeper turn. This scales only how much *already-sanitized,
  bounded* tool output the model consumes; it touches **no** security-floor bound.
- **Cross-turn tool-trace replay now keeps the TAIL, not the head.** A deep
  turn's decisive probes and findings land at the end of the trace, but the
  replay summarizer sliced the *head* — so the next turn re-probed exactly what
  the previous one had just discovered (cross-turn amnesia). It now keeps the most
  recent calls (`_MAX_REPLAY_TOOLS` 15 → 40) and leads with a "+N earlier" marker.
- **Runaway-turn ceiling raised (`_MAX_TURNS` 40 → 60).** Real depth is governed
  by the elastic tool-output budget above; the turn count is only the
  runaway-loop safety stop, so it's set well clear of legitimate deep
  investigations.

### Fixed

- **`query_account_profile` posture filters read the real persisted values.**
  `access_issues` tested `access_status not in (None, "ok", "accessible")`, but a
  healthy bucket persists `access_status="available"` — so the filter matched
  **every** healthy bucket (fully inverted). It now matches only
  `access_denied`/`error`. `missing_logging` / `no_versioning` used
  `*_enabled is False`, which is also False for `provider_unsupported` /
  `access_denied` (where the truth is UNKNOWN, not absent) — they now match only
  the confirmed-absent `not_configured` status.
- **No-credential providers now sign anonymously (UNSIGNED), never with the
  host's ambient AWS identity.** When a provider has no access/secret key,
  botocore previously fell back to the host's env-var / instance-metadata
  credentials — a confused-deputy: the operator configured "no credentials", so
  calls must not silently use the host identity. Calls are now explicitly
  anonymous (a genuinely public bucket still works; a private one fails clearly).
- **Custom-endpoint providers default to path-style addressing.** When
  `addressing_style` is genuinely unset, a custom endpoint (MinIO/Ceph on an
  IP/host without wildcard DNS) now defaults to path-style — virtual-hosting it
  fails every call. An explicit stored choice is never overridden.
- **CSV log parser stops at the first recognized delimiter.** It read (and
  re-decompressed, for `.gz`) the whole file once per candidate delimiter; it now
  breaks as soon as a delimiter splits the header into a recognized column.
- **`redact()` no longer corrupts benign binary.** A `bytes` value was always
  `decode("utf-8", "replace")`'d and re-encoded — lossily mangling non-UTF-8
  binary (→ U+FFFD) even when it held no secret. It now returns the original
  bytes untouched unless redaction actually matched a secret.

## [0.26.0] - 2026-07-15

_Capability uplift: teach the agent's playbooks the tools it already has, and
add the one account-wide question it structurally couldn't answer. No new S3
surface; read-only, bounded, sanitized throughout._

### Added

- **`query_account_profile(provider_id, filter)`** — a new read-only agent tool
  that answers account-WIDE posture questions ("which of my N buckets have no
  encryption / no public-access-block / no lifecycle / logging off / no
  versioning / access issues?") from the **already-persisted** account survey,
  with a filter whitelist. It returns the per-bucket config-flag matrix (region +
  logging/encryption/lifecycle/replication/policy/public_access_block/tagging/
  inventory status) — no new S3 call, no LLM, **statuses only** (never object
  keys or bodies). Previously this class of question forced N per-bucket reviews
  that blew the turn's tool-output budget; the data was persisted but unqueryable.
  Registered, provider-scoped, and audited.

### Changed

- **The StorageOps skills now teach the v0.24–v0.25 toolset.** Nine tools added
  since v0.24.13 were referenced by **zero** skills, so a skill-following agent
  still routed to the old method. Updated the affected decision trees to reach for
  the purpose-built tool:
  - `s3-protocol-compatibility` → `diagnose_presigned_url` (presigned 403s) +
    `get_bucket_config_summary`'s `region_mismatch` (the #1 SigV4 cause).
  - `security-iam-policy` → `get_object_acl` ("is THIS object public?", incl.
    AuthenticatedUsers), `get_bucket_config_detail` policy/PAB, and
    `query_account_profile` for account-wide exposure.
  - `data-consistency` → `test_conditional_get` (304/200 ETag freshness probe) +
    `head_object`'s new cache/replication/parts fields.
  - `lifecycle-cost` → `list_upload_parts` (size a stuck upload) + `list_objects`'
    per-key `objects[]`.
  - `observability-audit` → `get_bucket_config_detail` (metrics / notification /
    inventory / analytics aspects).
  - `replication-versioning` → `head_object` replication_status/version_id +
    `get_bucket_config_detail(replication)` + `get_object_attributes`.
  - `workbench-investigation` / `account-posture` → `query_account_profile`,
    `compare_to_last_survey`, `aggregate_uploaded_file`.
  - `eval-golden-cases` → a "reach for the purpose-built tool, don't hand-wave"
    check.

## [0.25.1] - 2026-07-15

_Security + regression hotfix from the next-round audit: one prefix-scope
bypass, four redaction gaps for non-AWS provider secrets, and six regressions
in the v0.25.0 batch (two in the brand-new presigned-URL parser). All read-only,
bounded, redacted; no behavior gates added._

### Security

- **Bucket config review no longer lists the bucket root outside
  `allowed_prefixes`.** The review gated at the bucket level (`listing=False`),
  but its `review_bucket_performance_profile` sub-tool LISTS objects — so a
  prefix-scoped provider had out-of-prefix object keys sampled and persisted
  into the stream, snapshot, and report. The performance profile is now gated
  with the stricter listing scope in BOTH the run executor and the standalone
  agent tool (skipped/denied when the provider restricts prefixes and none is
  in scope); the five bucket-metadata reviews still gate at the bucket level.
- **Redaction now covers non-AWS provider secret shapes** (this app targets
  S3-compatible incl. GCS/Azure): GCP service-account **PEM `private_key`**
  blocks (dict key + armored-block value pattern), Azure **`AccountKey=`**
  connection-string secrets, **basic-auth passwords in URLs**
  (`scheme://user:pass@host` → password masked, scheme/user/host kept), and
  **`bytes` values** inside a redacted structure (previously passed through
  unscrubbed). Non-secret URLs/bucket names are left untouched.

### Fixed

- **`diagnose_presigned_url` returns the correct key + addressing style for
  virtual-hosted URLs** (the default AWS presigned form). It previously derived
  bucket-vs-key from the path length, mislabelling `bucket.s3.region.amazonaws.com/
  a/b/c` as path-style and dropping the leading path segment from the key. Style
  is now decided from the HOST; a custom/unknown endpoint keeps the full path
  (never silently truncated).
- **`diagnose_presigned_url` no longer crashes on a millisecond-epoch V2
  `Expires`** — the conversion is guarded and reported as `malformed_expires`
  (the tool's contract is to always return a dict).
- **`region_mismatch` no longer false-positives** on providers whose region is a
  wildcard (`auto`, as R2 uses) or a legacy alias (`EU`≡eu-west-1, `US`≡us-east-1)
  — the exact S3-compatible providers the flag targets. It now normalizes aliases
  and skips wildcard/empty provider regions.
- **Access-log CSV parsing no longer depends on the `csv.Sniffer`.** v0.25.0
  switched to `sep=None`, which raises "Could not determine delimiter" on
  ambiguous/single-column CSVs → the log dropped to the null-field text fallback.
  It now tries comma then tab explicitly and keeps whichever splits into real
  columns.
- **Headerless-inventory detection won't mis-claim a GB-scale `size` column as
  an epoch timestamp.** A real date-shaped column wins `last_modified` first;
  an epoch column only claims it after `size` is already mapped.
- **The model-provider Test reports `ok=false` on an endpoint 5xx** (it set
  `endpoint_reachable=true` and computed `ok=true` while the detail said "server
  error").
- Removed a dead `_PRESIGNED_SECRET_PARAMS` constant.

### Changed

- Pure-read analysis (`analyze_inventory` / `analyze_access_logs` /
  `aggregate_uploaded_file`) opens DuckDB **read-only**, so it can't collide with
  a concurrent import that rebuilds the same table on another turn's worker
  thread (import stays read-write; falls back to a normal open if the DB doesn't
  exist yet).

## [0.25.0] - 2026-07-14

_One combined release fixing EVERY finding of the v0.24.19 deep-mining audit
(three parallel reviews: bug hunt, end-to-end flow trace, tool-coverage
analysis): 8 correctness bugs, 10 functional/usage defects, and the full
tool-coverage batch — 6 "already fetched, just dropped" field surfacings plus
3 new read-only tools. Security floor unchanged: everything remains read-only,
bounded, redacted; the new presigned-URL tool makes NO network call and drops
all credential material._

### Fixed — correctness

- **Bucket security review now flags `AuthenticatedUsers` ACL grants as public.**
  `_acl_public` matched only `AllUsers`, so a bucket ACL granting to
  AuthenticatedUsers (any AWS account — effectively public) was reported clean.
  Both group URIs now raise the CRITICAL finding, consistent with the
  object-level `get_object_acl`.
- **A summary whose reads ALL errored reports `overall_status='inconclusive'`.**
  It previously fell through to `"reviewed"` with zero aspects assessed.
- **Policy principals are matched EXACTLY against `'*'`.** `_policy_facts` used a
  substring test, so a partial-wildcard ARN like `role/deploy-*` produced a false
  CRITICAL "Anonymous s3:GetObject allowed". Now identical to `_detail_policy`.
- **Multi-part headerless inventory combine no longer drops a data row per part.**
  The no-manifest fallback assumed every part carried a header and skipped each
  subsequent part's first line — but S3 Inventory parts are headerless (and
  access-log parts are raw lines). The combiner now peeks at part 0 and only
  dedupes headers when a real header is present.
- **Headerless-inventory timestamp detection accepts date-only and epoch
  columns.** `2024-01-15` and unix-epoch (s/ms) modified columns were unmapped
  (age become 100% "unknown"; an epoch column could even steal the `size`
  mapping). Epochs are converted to ISO at import so DuckDB can cast them.
- **`get_object_attributes` can't misreport `checksum_algorithm="Type"`** — the
  algorithm is now extracted from a known-algorithm whitelist (the `Checksum`
  struct also carries `ChecksumType`, which a prefix match could grab).
- **Cancelling mid-answer can't leak a dangling ```` ```json ```` contract
  fence** into the persisted partial (the cancel path now applies the same
  contract holdback as the live stream sanitizer).
- **A code-less HTTP 403 on `test_credentials` is a failure again**, not
  "authenticated (ListBuckets denied)" — without an error code, auth failure
  can't be ruled out.

### Fixed — flows

- **Session file uploads stream to disk with a 2 GiB cap + HTTP 413.** The live
  composer endpoint buffered the ENTIRE attachment in RAM with no size limit
  (OOM on multi-GB inventories); the chunked/capped logic existed only on an
  endpoint the frontend never calls. Oversized uploads are refused cleanly and
  the partial file removed.
- **Gzipped access logs actually decompress.** `.gz` was accepted but read as
  raw bytes — every line became a null-field row and the analysis reported a
  confident "No anomalies detected" built from nothing.
- **`.tsv` files parse as tab-separated** in both the access-log and inventory
  importers (previously collapsed to one column by the comma reader), and the
  format detector recognizes TSV headers.
- **`.json` / `.jsonl` access logs are selectable in the composer** — the
  backend always parsed JSONL fully; the file picker just refused the extension.
- **Steering (Enter during a run) no longer silently drops a pending
  attachment** — a redirect now routes through the same dataset-upload path as
  send, or asks for the file type first.
- **The model-provider "Test" makes a real call.** It was a local config check
  that passed invalid keys (first turn then failed). It now probes
  `{base_url}/models` with the key (5s timeout) and classifies: key accepted /
  key rejected / endpoint unreachable / reachable-but-no-/models. No response
  body or secret is echoed.
- **Forked sessions keep run links** (read-only references), so run-dependent
  proposal cards (e.g. "import inventory" needing the discovery run) stay
  actionable instead of dead-ending with "run discovery first".
- **Deleting a session mid-turn cancels the server-side turn too** (best-effort)
  — the worker previously kept generating (and spending) against a deleted
  session.
- **Session reports list only completed runs** (in-flight ones are counted, not
  rendered as `(running) — —`), and RunDetail no longer leaks raw backend enums
  (`not_implemented`, run-type slugs, severity tokens) — all localized.

### Added — tool coverage

- **`head_object` surfaces its dropped diagnostic headers** — `replication_status`
  ("did it replicate?"), `restore` (GLACIER restore progress/expiry),
  `archive_status`, `parts_count`, `lifecycle_expiration` ("when will lifecycle
  delete this?"), `version_id`, `content_type`/`content_encoding`/`cache_control`
  (stale-read diagnosis), `website_redirect_location` — and accepts
  `version_id` to HEAD a specific version.
- **`list_objects` returns per-key detail** (`objects`: size / storage class /
  mtime for the first 100 entries), so size-distribution and storage-class
  sampling need one listing, not N× head_object.
- **`list_object_versions` returns `sample_versions`** with per-entry
  `version_id` / `is_latest` / `is_delete_marker` / size / storage class — the
  agent can now point at WHICH version is the pileup and inspect it.
- **The config summary exposes `bucket_region` + `region_mismatch`** (bucket
  LocationConstraint vs the provider's configured region) — the #1
  SignatureDoesNotMatch root cause, previously unreadable on the agent surface.
- **`review_bucket_lifecycle` surfaces `mfa_delete_enabled`** (same
  GetBucketVersioning response, previously dropped) — answers "why can't I
  delete this version?".
- **Two new config-detail aspects (15 total): `metrics` and `analytics`** —
  request-metrics configurations and storage-class-analysis (with reduced
  export destination), completing the observability skill's audit layers.
- **New tool `diagnose_presigned_url`** — pure PARSE of a user-pasted presigned
  URL (no network call): signature version, computed expired/valid, credential
  SCOPE (date/region/service — the key id and signature are dropped entirely),
  signed headers, addressing style, and a `problems` list. Turns "my presigned
  URL 403s" into a computation.
- **New tool `list_upload_parts`** — read-only ListParts for ONE in-progress
  multipart upload: parts, bytes accrued, first/last part times ("this abandoned
  upload holds N GB since June"). Listing only; no abort.
- **New tool `test_conditional_get`** — HeadObject + If-None-Match: 304 proves a
  cached ETag is still current (stale reads = cache/CDN), 200 returns the new
  ETag. No body either way.

## [0.24.19] - 2026-07-14

_Frontend UX pass (third of the usability sweep): five focused fixes where the
thread-first UI stranded the user or rendered a deliverable poorly. No backend
change; the settled thread-first shell is unchanged._

### Fixed

- **A stalled turn no longer spins forever.** When the client gave up polling a
  still-running turn (~150 s), the thread kept showing the "thinking" animation
  indefinitely — even though the answer was often already persisted server-side.
  It now shows a "this is taking longer than expected — the answer may already be
  ready" note with a **Reload** button that pulls the persisted result, instead
  of an eternal spinner. (New per-session `stalled` run-state flag.)
- **The turn-error banner offers Retry, not only "Open settings."** A failed turn
  restores the message into the composer, so a transient/network error now shows
  a **Retry** button (re-sends it) alongside Open settings — previously the only
  action was Open settings, which is irrelevant for a network/timeout error.
- **Reports render as Markdown, not raw monospace.** The report modal and the run
  report-preview showed structured Markdown inside a tiny `<pre>` block; both now
  render through the app's `Markdown` component — the headline "auditable report"
  is finally readable.
- **The composer's keyboard hint reflects what Enter does.** While a turn is
  running, Enter **redirects** the in-flight turn (cancel + resend), but the hint
  still read "⏎ Send"; it now reads "⏎ redirect current turn" so the behavior is
  discoverable and Enter can't surprise-cancel an investigation.
- **The Copy button no longer silently no-ops** where the async Clipboard API is
  unavailable (some WebViews): it falls back to a temp-textarea copy and only
  shows the "Copied" confirmation when the copy actually succeeded.

## [0.24.18] - 2026-07-14

_Turn-loop resilience: two deep-investigation dead-ends where a turn ended
abruptly instead of degrading into a grounded answer, plus the budget note's
shape. Isolated to the streaming/finalize path on purpose._

### Fixed

- **A transient provider error (429 rate-limit / 5xx) no longer discards the
  whole investigation.** Previously such an error re-raised and surfaced as a raw
  `Session assistant failed: Error code: 429 …`, throwing away the entire tool
  trace with no retry. It's now recoverable: the turn runs the existing tool-less
  finalize pass to synthesize a grounded best-effort answer from what it already
  gathered, marks it as interrupted, and offers a one-click "continue." The
  detector is deliberately narrow — a **provider-response** 429/5xx only; a raw
  transport/connection reset (no HTTP status) still propagates to the blocking
  fallback re-run, the pre-existing recovery for those.
- **The deepest turns — those that exhaust the per-turn tool-output budget (the
  primary depth governor) — are now marked cut-short with a "continue" proposal**,
  exactly like the max-turns ceiling. Before, hitting the tool-output budget let
  the model emit an ordinary `final` with no marker, so a best-effort partial
  answer could read as complete.

### Changed

- **The tool-output-budget note is a soft boundary, not a failure.** It was
  shaped as `{"error": …}` (reading to the model like a broken tool) and never
  said the budget is per-turn. It's now `{"status": "budget_exhausted",
  "next_step": …}` with an explicit "synthesize now; this resets if the user
  continues," so the agent finishes the answer instead of looping on alternatives
  or giving up.

## [0.24.17] - 2026-07-14

_Correctness hardening: six classes of "the tool succeeds but returns a wrong
answer" — the worst failure mode for a diagnostic product — plus reporting the
caps that were applied silently. All message/classification changes; no new
machinery, no gates, security floor unchanged._

### Fixed

- **`get_object_acl` now judges "is this object public?" over EVERY grant**, not
  just the 20 echoed back. A public `AllUsers`/`AuthenticatedUsers` grant past
  position 20 previously left `is_public: false` — silently hiding the exact
  security signal the tool exists for. The returned `grants` sample stays capped
  at 20; `grant_count` reports the true total. *(Regression from v0.24.16.)*
- **Object tools classify "provider doesn't support this" as `provider_unsupported`,
  not a hard error** (rule 18). `get_object_acl` / `get_object_tagging` /
  `get_object_attributes` / `get_object_lock_status` now share the wider
  unsupported-code set (`+NotSupported/Unsupported`) and honor a bare HTTP 501,
  matching `config_tools`. An S3-compatible provider lacking object ACLs/tagging
  was previously surfaced as a broken call. *(Partly a regression from v0.24.16.)*
- **Access-log CSV files with valid-but-unrecognized headers are no longer
  silently misparsed.** `detect_log_format` recognized only a tiny header token
  set (`method/status/path/key/timestamp/time`); a valid CSV log headed e.g.
  `ts,verb,uri,status,size,ua,ip` was detected `unknown`, then ingested by the
  universal text parser as raw null-field rows — producing a misleadingly clean
  "No anomalies detected." The detector now matches the **full** set of columns
  the CSV parser actually supports, by **exact header-cell match** (so short
  tokens like `ip`/`ts` can't false-positive on arbitrary prose). Same class of
  bug as the v0.24.14 headerless-inventory fix.
- **Config-read errors surface as a finding instead of vanishing.** A genuine
  read error (e.g. a transient 5xx reading the bucket policy) produced **no
  finding**, so `review_bucket_*` / `get_bucket_config_summary` silently implied
  the aspect was clean. Errored reads now emit a `Warning` ("Could not read …")
  and appear in the summary's new `error_items`, marking the aspect *unassessed*.
- **`test_credentials` no longer reports valid credentials as broken** when a
  provider returns `Forbidden`/`AllAccessDisabled`/a non-standard 403 on
  ListBuckets — it now uses the same denied-code set as `list_buckets` (genuine
  auth-failure codes still fail correctly even though they, too, are 403).
- **Applied caps are reported, never silent.** `list_objects` returns
  `max_keys_requested`/`max_keys_applied`, and `measure_request_latency` now
  reports the caller's real `samples_requested` alongside the clamped
  `samples_applied` (it previously echoed only the clamped value).

### Changed

- **Clearer, less-dead-ending agent/user messages.** Bucket-scope denials now
  list the allowed bucket names (like prefix denials already did) instead of only
  a count; per-turn probe-budget messages drop the "ask the user which object
  matters most" framing (the agent should pick the most relevant object itself)
  and note the budget resets next turn; the `list_objects` tool description now
  documents the `keys_truncated_in_context` echo cap; the ORC-inventory message
  is plain English; and `review_bucket_observability`'s inventory note points to
  the now-available `get_bucket_config_detail` aspect instead of "future work."

## [0.24.16] - 2026-07-14

_Config-read coverage (Tier 2/3): four more read-only bucket-config aspects and
three object-level read tools the investigator was missing. All read-only,
provider_unsupported on gap, secret-safe (no owner id / canonical id / email
ever leaves the ACL tool), reusing the existing `_read` / detail-extractor and
`get_object_*` machinery._

### Added

- **Four more bucket-config aspects.** `get_bucket_config_summary` and
  `get_bucket_config_detail` now also cover `website` (static-hosting index/error
  documents, redirect host reduced to a hostname, routing-rule count),
  `intelligent_tiering` (per-config status, filter, tiering days/access-tiers —
  the modern cost-tiering posture), `accelerate` (Transfer Acceleration status),
  and `request_payment` (Requester Pays vs BucketOwner). `get_bucket_config_detail`
  now dispatches 13 aspects, up from 9.
- **Object-level read tools: `get_object_acl`, `get_object_tagging`,
  `get_object_attributes`.** Bucket-level review can't answer object-scoped
  questions, so the agent gains three read-only object tools:
  - `get_object_acl` — "is THIS object public?" / "who is granted what?" An
    object can be public even under a locked-down bucket. Grantees are reduced to
    a KIND (`public-all-users` / `authenticated-users` / `canonical-user` /
    `log-delivery` / `email-user`) so **no owner id, canonical id, or email
    leaks**; a grant to AllUsers/AuthenticatedUsers sets `is_public` with the
    granted permissions.
  - `get_object_tagging` — the object's tag set (keys and values redacted; tags
    drive lifecycle/cost-attribution/tag-scoped policies), bounded to 20 tags.
  - `get_object_attributes` — checksum algorithm, multipart part count, storage
    class, and size in one read-only GetObjectAttributes (no body), for "how was
    this large object assembled?" / checksum / storage-class checks. Not
    universally implemented → `attributes_status='provider_unsupported'` on gap
    (fall back to `head_object`).

  All three honor the same allowed_buckets + allowed_prefixes scope as the other
  object tools, are audited, and download no object body.

## [0.24.15] - 2026-07-14

_Config-read coverage (Tier 1): the security/compliance APIs a review agent
needs but the tools didn't call, plus rule detail for five more aspects. All
read-only, provider_unsupported on gap, reuse the existing `_read` machinery._

### Added

- **Authoritative "is this bucket public?" + modern access-control posture.**
  `get_bucket_config_summary` now also reads `policy_status`
  (GetBucketPolicyStatus — the authoritative IsPublic, instead of inferring from
  PAB+ACL+policy), `ownership` (GetBucketOwnershipControls — Object Ownership /
  whether ACLs are disabled), and bucket-level `object_lock`
  (GetObjectLockConfiguration — WORM/compliance, which previously only existed
  per-object).
- **`get_bucket_config_detail` now covers 9 aspects, not 4.** Added rule detail
  for `lifecycle` (per-rule prefix/status, transitions, expiration,
  noncurrent/abort-MPU cleanup), `encryption` (SSE algorithm + reduced KMS key +
  bucket-key), `public_access_block` (the four block/ignore/restrict booleans),
  `policy` (per-statement effect/actions/`is_public` — the principal is reduced
  to `*`/`specific`, so no account id or raw ARN ever leaks), and `inventory`
  (per-config schedule/destination/format/included-versions/optional-fields).
  The detail surface previously stopped at replication/notification/cors/logging,
  forcing the agent to ask the user for config it can read itself.

_Correctness: analyze a raw, headerless S3 Inventory CSV — the industry-standard
format the importer previously mis-parsed._

### Fixed

- **Headerless inventory CSVs now analyze correctly.** S3 Inventory delivers
  **headerless** CSV files — the column schema lives in the manifest, not the
  file. The importer assumed a header row (`pandas` `header=0`), so a raw
  inventory CSV attached directly (no manifest) had its first data row consumed
  as a "header" and its columns mis-mapped, producing empty/garbage analysis.
  `import_inventory_file` now detects whether row 0 is a real header (a generic
  upload, or the header the managed-import path synthesizes from the manifest
  `fileSchema`) and, when it isn't, **maps columns to fields by value shape**
  (integer → size, ISO timestamp → last_modified, known storage-class token →
  storage_class, path-like → key, single repeated value → bucket) — so a raw S3
  inventory export analyzes regardless of column order. The per-turn ingest cap
  now counts DATA rows, never a header line. (The managed-import path already
  synthesized a header from the manifest and is unchanged; Parquet/ORC carry
  their own schema and were never affected.)

_Prompt guidance only — makes two existing capabilities feel native. No new
tools, no behavior gates._

### Changed

- **The agent proactively surfaces "what changed" after a survey.** After
  `survey_account`, if the provider has an earlier survey, the agent now calls
  `compare_to_last_survey` and tells the user what changed since last time
  (reusing persisted snapshots — no new scan), instead of waiting to be asked.
- **The agent escalates a truncated preview to full analysis instead of guessing.**
  When `preview_object` truncates a large object and the answer needs its full
  content, the agent now proposes the confirmed evidence import (for a bucket
  file) or uses `analyze_uploaded_file` (for an attached file) so the whole file
  is analyzed deterministically — rather than answering from the 1 MiB head.

## [0.24.12] - 2026-07-12

_Capability + de-ossification: lift a couple of small-context-era clips that
were throttling the agent, and add two new read-only capabilities. Every lifted
bound is arbitrary/non-security — the list hard cap, per-turn preview/range
budgets, no-write, and confirmed-data-moving floor are unchanged._

### Changed

- **The agent sees much more of the conversation.** The context clip was a
  small-context-era relic: only the last **12** messages, each cut to **1000**
  chars, so on a long investigation the agent lost the thread and re-derived
  earlier conclusions. Raised to **24** messages × **4000** chars — still tiny
  under a modern context window, no longer amnesiac.
- **`list_objects` default page size 50 → 200.** The timid default forced many
  round-trips for distribution/count questions (while `list_object_versions`
  already defaulted to 1000). The hard cap stays **1000** (== the S3 cap, the
  security floor); only the default moved.

### Added

- **`compare_to_last_survey` — "what changed since last time?"** A deterministic
  diff of a provider's two most recent account surveys: buckets added/removed,
  per-bucket config-aspect changes (versioning / encryption / lifecycle /
  logging / replication / policy / public-access / tagging / inventory), and
  evidence-source changes. Computed from **already-persisted, sanitized** snapshot
  data — no new S3 calls, no LLM, no raw rows. Needs two completed surveys.
- **`preview_object` returns a `structure` summary for CSV/JSON.** Alongside the
  raw text preview, a CSV/TSV preview now carries its **columns** and a JSON/JSONL
  preview its **top-level keys**, parsed from the SAME preview bytes (no extra
  fetch) — so the agent gets a clean schema without re-parsing the head.
- **Live progress rollup while the agent streams.** A compact "N checks run ·
  latest: …" line above the streaming answer, so a long investigation reads as
  making progress at a glance. Evidence/progress only — never a plan (frontend,
  derived from the live tool trace; no new LLM/backend).

## [0.24.11] - 2026-07-08

_Execution-time interaction: redirect a running investigation without losing its
work — inspired by the "steer mid-run" pattern in agentic browsers, composed
entirely from capabilities the app already had._

### Added

- **Redirect a streaming turn ("steer").** While the agent is investigating, you
  can now type a new direction and send it to **redirect the turn instead of
  killing it**. A ⏎ (or the new redirect button next to Stop) cancels the current
  turn — its partial answer and tool trace are preserved — and immediately
  resends your text as a fresh turn whose context **replays the cancelled turn's
  tool trace** (the 0.24.7 mechanism), so the agent continues from what it
  already probed toward the new ask instead of restarting from scratch. Purely a
  frontend orchestration over existing pieces (cancel + send + trace replay): no
  SDK in-run injection, no new backend, no new subsystem. A load-bearing timing
  gate reopens the turn only after the partial has persisted, so the redirect is
  always trace-aware. Stop (halt and keep the partial) is unchanged.

_Turns a raw provider 400 into a graceful, grounded answer._

### Fixed

- **A tool-call sequencing 400 now recovers via finalize instead of surfacing
  raw.** Some OpenAI-compatible providers reject the reconstructed message list
  with `400 … "An assistant message with 'tool_calls' must be followed by tool
  messages responding to each 'tool_call_id'"` (e.g. a provider that emits
  multiple tool calls despite `parallel_tool_calls=False`). The stream loop only
  recovered from max-turns / context-overflow, so this 400 was re-raised to the
  user. It is now recognized (`_is_tool_call_sequence_error`) and treated as
  recoverable: the tool-less finalize pass rebuilds from a fresh prompt (no
  `tool_calls` history) and the turn returns a grounded best-effort answer with a
  continue-investigation offer — **not** marked as a context cutoff, since
  context isn't why it failed. The underlying SDK/provider sequencing mismatch is
  upstream; this is the graceful in-app recovery.

## [0.24.9] - 2026-07-08

_Robustness fixes from an adversarial bug hunt. No new capability, no
architecture change; each closes a real defect the happy path didn't exercise._

### Fixed

- **Streaming turn de-dup is now symmetric with the blocking path.** The
  blocking `POST /sessions/{id}/messages` already attaches to an in-flight turn
  instead of re-running it, but `POST /messages/stream` discarded the
  registry's `created` flag and spawned a worker unconditionally — so two
  concurrent stream POSTs (or a stream retry) for the same `turn_id` double-ran
  the agent and persisted duplicate messages + double model spend. The stream
  endpoint now declines a duplicate `turn_id` with 409, so the client falls back
  to the blocking path (which attaches to the owner).
- **The streaming worker always resolves its turn handle.** `except Exception`
  missed a `BaseException` (e.g. `CancelledError`) out of the run, and a clean
  run yielding no final data also left the handle unresolved — either way
  `done_event` never set, leaking a non-evictable handle and hanging a blocking
  fallback the full in-progress wait. The worker's `finally` now fails an
  unresolved handle as a backstop.
- **Config-review agent tools return an error string instead of raising.**
  `get_bucket_config_detail`, the `review_bucket_*` tools, and the inline
  `survey_account` / `review_bucket_config` tools built their S3 client / ran
  their engine outside any try, so a malformed endpoint or a transient failure
  raised out of the tool body (the SDK swallowed it into a generic message).
  They now catch and return a **redacted** error the agent can actually diagnose
  and narrate — matching every tool in `s3/tools.py`.
- **Context-overflow detection no longer misreads unrelated errors.**
  `_is_context_overflow` matched generic phrases ("context window", "input is
  too long") anywhere in an exception, so an unrelated 5xx/connection error
  carrying such text was reclassified into a fabricated "context filled up"
  cut-short answer recorded as success. Generic phrases are now trusted only on
  a bad-request-class (HTTP 400) provider error; specific phrases
  ("maximum context length", `context_length_exceeded`) still match anywhere.
- **`fork` keeps a message's grounding + proposed-action cards.** The fork copy
  selected only a subset of columns, silently dropping `grounding` and
  `proposed_actions` (migration 16), so a forked thread lost its grounding
  blocks and next-action cards despite the docstring's "copies its full message
  thread". Both columns are now copied verbatim.
- **`_arn_resource` never leaks an account id, even on a truncated ARN.** The
  account-stripping only ran for a standard 6-field ARN; a shorter / non-standard
  ARN (e.g. `arn:aws:sns:region:account` with no resource) passed through with
  the account id intact. It now reduces to the service label in that case.

## [0.24.8] - 2026-07-07

_Documentation-only: a full review of the docs cleared the stale/inaccurate
spots. No app or sidecar behavior changes._

### Documentation

- **sidecar/README:** "runs (deterministic + agent planner)" → "deterministic
  runs (rule-based — no LLM planner)"; the run-planner LLM was removed in 0.20.0
  and every other doc already reflected that.
- **tools.md (`test_range_get`):** dropped the reference to the removed
  `AGENT_MAX_RANGE_BYTES` guardrails constant (only the S3-layer `MAX_RANGE_BYTES`
  4 MiB cap applies now), and corrected the per-turn budget from 8 to 12 to match
  `_MAX_RANGE_GETS`.
- **release-template.md:** fixed the checksum filenames (per-platform
  `SHA256SUMS-<platform>.txt`, not a single `SHA256SUMS.txt`) and the verify
  command; dropped the stale "Linux/Windows experimental / attached only when
  produced" framing (all three platforms ship every release); noted that
  `release.yml` auto-generates the notes from the CHANGELOG.
- **security.md:** reframed "that is a future phase / manual operator action" to
  point at the already-implemented, confirmation-gated managed evidence import
  flow; "no agent in this phase" → "deterministic by design".
- **architecture.md:** fixed a "the persisted the evidence source" typo and added
  `get_bucket_config_detail` (0.24.6) to the session tool list.

## [0.24.7] - 2026-07-07

_Autonomy: cross-turn continuity of what the agent already probed — the last
remaining high-leverage, non-bloat lever. Each turn now sees a bounded trace of
earlier turns' read-only tool calls, so it stops re-running the same checks._

### Changed

- **Prior assistant turns replay a `tools_run` trace into the next turn's
  context.** Each message already persists its `tool_activity` (the one-line
  per-call trace the UI shows); it was thrown away on replay, so a new turn
  couldn't see what earlier turns had already checked and re-derived / re-probed.
  The context now surfaces a bounded (≤15 lines/turn, `started`-records excluded)
  `tools_run` trace per recent assistant message, and the instructions tell the
  agent to consult it and re-fetch only when it needs fuller detail than the
  one-line result. This is cheap continuity — already-persisted, already-sanitized
  data (redacted again defensively), no summarization / compaction / new
  subsystem — and it makes the 0.24.5 "continue investigation" resume actually
  aware of the prior turn's work. It also lightens the reliance on the agent
  manually curating memory for continuity.

_Assessment note: a capability audit found the read-only tool set otherwise
complete and the depth bounds already recalibrated (0.24.4); this closes the last
non-bloat autonomy gap. Further autonomy gains (within-turn context compaction,
a confirmed-write "operator" path) require either the compaction subsystem or a
policy change to the read-only floor — both deliberately out of scope here._

## [0.24.6] - 2026-07-07

_Autonomy: fills the one real capability gap in the read-only tool set — the
config-review tools already read replication / notification / CORS config but
collapsed it to a status/boolean, forcing the agent to ask the user for JSON it
could read itself. One new sanitized reader closes it. No new attack surface (the
GETs already ran); no write tool._

### Added

- **`get_bucket_config_detail(provider_id, bucket, aspect)`** — one read-only tool
  returning the sanitized RULE detail for `aspect ∈ {replication, notification,
  cors, logging}`: per-rule status / filter / delete-marker replication /
  destination for replication; target type + resource + events + prefix/suffix
  filter for notification; allowed origins/methods/headers for CORS; the access-log
  target for logging. This is the detail three StorageOps skills'
  (replication-versioning, event-notification, s3-protocol-compatibility) decision
  trees depend on and previously couldn't obtain. ARNs are reduced to a resource
  label (account id stripped), every value is redacted, output is bounded to 20
  rules, and a provider lacking the API returns `status='provider_unsupported'`
  (rule 18). Reuses the proven `config_tools._read` path (hard-asserts a
  `get_`/`list_`/`head_` prefix) — the underlying GETs already run in the config
  review, so this adds no new S3 surface.
- **`head_object` now reports server-side-encryption state** (`server_side_encryption`
  + a reduced `sse_kms_key_ref` — KMS key id/alias only, no account id/ARN), which
  the security-iam-policy skill needs to reason about "why can't I read this
  KMS-encrypted object".

_A capability audit found the read-only tool set otherwise ~85% complete (17/20
skills fully served); everything else on the usual "add get_X?" list (public-access
-block, versioning flag, encryption on/off, object-lock, tagging, object ACL) is
already covered, so nothing redundant was added._

## [0.24.5] - 2026-07-07

_Autonomy: a turn cut short by its depth/context ceiling now offers a one-click
"continue investigation" so a deep investigation can be resumed instead of
silently stopping — a suggestion the user confirms, reusing the existing
next-action-proposal machinery. No new subsystem; no security change._

### Added

- **"Continue investigation" on a cut-short turn.** When a turn ends via the
  finalize pass (it hit the step ceiling or the model's context window before the
  agent naturally concluded), the result now carries a `continue_investigation`
  next-action proposal. One click sends a localized "pick up where you left off"
  prompt back to the agent, which resumes from its own (marked cut-short) prior
  answer. It's a proposal — nothing runs automatically; the user confirms by
  clicking, and it's deduped so a turn never doubles it. Implemented by reusing the
  proposal → conversational-handoff path (the frontend already one-clicks an
  unrecognized action_type); the only new surface is the injected proposal + its
  localized label.

## [0.24.4] - 2026-07-07

_Autonomy: lets the read-only agent run a genuinely DEEP investigation in a single
turn instead of being cut short by conservative per-turn caps — a bounds
recalibration, not new architecture. No security floor changed; no write tool
added._

### Changed

- **Turn depth is now governed by the elastic tool-output budget, not an arbitrary
  step count.** The per-turn cumulative tool-output budget (raised 150k → 200k
  chars) is the real, usage-elastic governor of how deep a turn goes; the raw
  step-count ceiling (`_MAX_TURNS` 24 → 40) is demoted to a runaway-loop safety
  stop set well above what a real investigation needs. Net effect: a shallow-output
  but deep probe (many small `head_object`/`list`/latency calls across buckets) is
  no longer terminated at an arbitrary step number, while a heavy-output turn is
  still bounded by real context use — and the context-overflow → finalize path
  added in 0.24.0 remains the backstop, so going deeper can't become a hard
  failure.
- **Forensic per-turn tool budgets raised** for deep comparisons in one turn:
  `preview_object` 12 → 16 objects and 16 → 24 MiB; `test_range_get` 8 → 12 calls;
  `read_skill` 8 → 10 skills (with the `skills_used` contract cap raised to match).
  The 1 MiB-per-call preview cap, the no-recursion / no-bulk-download rules, and
  the per-call range cap are unchanged — these stay probes, not downloaders.

_These are bounds, not gates: every one still enforces a code-level ceiling; they
are tuned upward now that the turn's context-overflow path fails safe. The
categorical read-only posture and all rule 1–18 security invariants are unchanged._

## [0.24.3] - 2026-07-07

_Patch: security + correctness fixes from a third bug hunt targeting three
subsystems not deeply audited before — the DuckDB analysis engine, the S3 tool
layer, and packaging/sidecar launch. The bounds, redaction, whitelist, and
destructive-op blocking all held up under direct testing; these fix the gaps that
didn't._

### Security

- **The agent's tools now enforce `allowed_prefixes`, not just `allowed_buckets`.**
  A provider scoped with `allowed_prefixes=["logs/"]` gave the conversational
  agent — the only surface that reads object *content* — zero prefix protection:
  it could `preview_object`/`head_object`/`list` outside the prefix and stream that
  content into the model. All agent tools now route through the same `check_scope`
  as the `/tools` endpoints and run executors (bucket + prefix, listing-aware).
- **The per-launch sidecar auth token is now from the OS CSPRNG** (`getrandom`),
  not a splitmix64 stream seeded from the clock, PID, and ephemeral ports — those
  are locally observable/low-entropy, so the token that gates the loopback API
  against a *different local user* was guessable. It is now 128 real bits.
- **The app-data directory is created `0700` and the SQLite DB `0600`** regardless
  of the process umask (previously the DB was world-readable at umask 022 and the
  whole dir world-writable at umask 000); the vault `.unreadable` ciphertext backup
  is written `0600` (was `0644`). The vault key/ciphertext themselves were already
  `0600`.
- **Aggregate group-bys on object-key-like dimensions (`key`, `path`) are clamped
  to 20 groups** — a group-by on a near-unique column otherwise returned up to 50
  individual object keys to the model, above the rule-16 sample cap.

### Fixed

- **CLF / combined access-log timestamps are normalized**, so hour-bucketing works
  for that (documented, supported) format — previously every hour bucket came back
  `'unknown'` because the CLF date failed the DuckDB timestamp cast. Timezone-aware
  timestamps are now bucketed by UTC instead of by local wall-clock.
- **Large object sizes keep full int64 precision** — sizes/bytes were parsed via
  `int(float(...))`, losing precision above 2^53 (~9 PB); they now parse as integers
  directly (float only for genuinely fractional values like a latency).
- `stamp-version.py`'s "exactly one version line" guard now actually counts matches
  first (the previous `count=1` substitution could never report a duplicate, so a
  stray `version = "…"` line could get stamped instead of the package version).

### Verified sound (no change needed)
The aggregate whitelist (no SQL injection / no raw-SQL path — identifiers only from
constants, values always bound), the S3 bounds (preview 1 MiB + gzip-bomb + parquet
footer, range 4 MiB, list caps, per-turn budgets), destructive-op blocking, secret
redaction, the auth-gate exempt-path matching and constant-time compare, and the
vault `0600` files were all attacked directly and held.

## [0.24.2] - 2026-07-07

_Patch: reliability + correctness fixes from a second adversarial bug hunt
targeting the paths that unit tests stub out (the same blind spot that hid the
0.24.1 crash). No behavior/API changes for the happy path._

### Fixed

- **Multi-session concurrency was silently single-threaded (frontend).** The
  turn-runner used instance-global flags (`submittingRef`, `uploading`) shared
  across all sessions: while session A ran a turn (or uploaded a file), sending
  in session B was dropped with no error/spinner, or B's composer was locked.
  Both are now per-session; the double-submit guard releases the instant the turn
  registers instead of being held for the whole turn — sessions run concurrently
  again, as designed.
- **Blocking fallback could hang 150 s and report a bogus "turn still in
  progress".** When the streaming worker errored after the SSE stream dropped, it
  only removed the turn registration without waking the attached fallback waiter,
  which then blocked the full in-progress timeout. `turn_guard` now has an
  explicit `fail()` state that wakes waiters immediately with the error. The
  blocking handler is also wrapped so any unexpected exception always resolves the
  turn (no dangling "running" handle that would hang a later same-turn retry).
- **A still-running turn could be evicted from the turn registry** under high
  turn volume (>256 concurrent turns between start and finish), letting a fallback
  re-run it concurrently (duplicate messages, double spend). Running handles are
  now protected from eviction, and recorded results are session-bound even after a
  recreate, closing a cross-session read.
- **Multi-member (concatenated) gzip evidence was silently truncated** — the
  bounded gunzip decoded only the first gzip member and dropped the rest (a
  regression from the old `gzip.decompress`), yielding a confidently partial
  analysis. It now decodes every member. The decompression-bomb ratio guard was
  also raised (200→1000) so legitimately high-ratio files aren't false-positived.
- **`allowed_prefixes` scope was bypassable by an empty/None listing prefix** —
  a `list_objects` with no prefix enumerated the whole bucket root, outside the
  allowed prefixes, on the `/tools` endpoint and in the diagnostic run. An
  unprefixed listing is now denied when `allowed_prefixes` is set (bucket-level
  ops like head-bucket are unaffected).
- Smaller fixes: a per-turn AsyncOpenAI client no longer leaks if the SDK run
  fails during setup (caller now owns closing it); deleting a session mid-turn
  aborts its stream instead of leaking an orphan turn and resurrecting store
  state; the 409/in-progress path no longer clears the user's message before the
  turn actually persists; a 0-byte inventory CSV imports as empty instead of
  erroring; a stale run-detail poll interval is cleared on SSE reconnect.

## [0.24.1] - 2026-07-07

_Patch: fixes a crash introduced in 0.24.0._

### Fixed

- **Blocking-fallback turn crashed with "no running event loop".** 0.24.0
  converged the blocking `POST /messages` turn onto the streaming implementation,
  but started the Agents SDK run (`Runner.run_streamed`, which schedules its loop
  via `asyncio.create_task`) *before* entering the event loop. Any turn that used
  the blocking path — most visibly when the SSE stream dropped because the user
  switched sessions mid-turn, so the client fell back to `POST /messages` — failed
  with `Session assistant failed: no running event loop`. The SDK run is now
  started from inside the running loop. (The whole loop path is monkeypatched in
  tests, which is why this shipped; a regression test now drives the real loop and
  pins the invariant.)

## [0.24.0] - 2026-07-07

_Architecture / code / docs review remediation: closes a turn-lifecycle
correctness class (connection ownership, cancellation, fallback races), hardens
every large-file path against OOM, plugs redaction/secret-in-log gaps, and removes
the last carcasses of the retired dual-track design — without loosening any
security floor. Adds real turn cancellation and live-delta redaction as new
agent-native capabilities._

### Added

- **Real turn cancellation.** `POST /sessions/{id}/turns/{turn_id}/cancel` stops a
  running turn: the streaming worker observes a cancel event, cancels the Agents
  SDK run, and persists the **partial** answer (sanitized) with a `_[stopped by
  user]_` marker; the `done` SSE event carries `stopped: true`. The frontend Stop
  button now drives this instead of only aborting the local fetch, and keeps the
  partial answer visible. Inline-run waits and `read_run_result` polling also break
  out early on cancel.
- **In-progress turn registry.** `turn_guard` now tracks running turns (not only
  completed ones) and is session-bound. The blocking fallback for a turn that is
  still streaming server-side **waits** for it (up to 150 s) and returns the
  persisted result, or `409 "turn still in progress"` on timeout — instead of
  re-running the whole turn concurrently (which duplicated messages and doubled
  model/S3 spend).
- **Live-delta sanitization.** Streamed answer tokens are now redacted and
  chain-of-thought-stripped in flight (streaming-safe: unclosed `<think>` blocks
  and the answer-contract JSON are held back, plus a short tail so a secret
  completing across deltas can't leak an un-redacted prefix) — the UI stream now
  honors the same rule-15 invariant the persisted answer already did.
- **Per-turn cumulative tool-output budget** (~150k chars): once a turn's tool
  results exceed it, further tool calls ask the agent to synthesize instead of
  returning more data. Context-length overflow now triggers the tool-less finalize
  pass (a partial, marked answer) rather than a hard failure the fallback repeats.
- **Agent-memory lifecycle.** `update_memory_item` / `resolve_memory_item` tools
  (plus dedup of exact-duplicate adds and ids in replay) let the agent correct a
  wrong fact or close an answered question — memory is no longer write-only.
- **Live tool-start events.** `tool` SSE records now carry `status: "started"`
  before `"completed"`, so the UI shows "running <tool>…" instead of only a
  keepalive during long tool calls.
- **Provider scope enforcement outside the agent.** New `s3/scope.py::check_scope`
  is enforced in the surviving `/tools` endpoints (403) and the run executors
  (per-bucket for account discovery); `allowed_buckets`/`allowed_prefixes` were
  previously honored only by the agent's session tools.
- Sidecar local authentication is now documented (previously only in the
  CHANGELOG); `SAW_DB_PATH` and the auth env var are documented in packaging docs.

### Fixed

- **CRITICAL — request-scoped SQLite connection closed under running tools.** The
  streaming worker opened its own connection only for the final persist; every
  in-flight tool call still bound the request-scoped connection, which FastAPI
  closes on client disconnect / Stop / idle-watchdog. The worker now owns its
  connection for the whole turn (tools included), so a disconnect can no longer
  silently strip the agent of all tools mid-investigation and persist a degraded
  answer.
- **Auth token leaked into access logs.** The packaged sidecar now runs uvicorn
  with `access_log=False` (the SSE `?token=` query param was being logged in
  plaintext); the token check is constant-time (`hmac.compare_digest`); redaction
  now masks bare `token=`/`api_key=` values.
- **Large-file OOM paths.** Inventory import now caps rows *at read time*
  (`nrows`) instead of after loading the whole CSV into RAM; evidence import
  streams parts to disk, combines out-of-core (DuckDB), and uses a bounded gunzip
  that refuses decompression bombs; dataset upload streams to disk in chunks with
  a 2 GiB cap (413 over limit).
- **Turn failure no longer eats the user's message.** On a clean failure the
  composer text is restored (was cleared and lost). The blocking-fallback timeout
  was raised past the server's wait window so a long multi-tool turn isn't aborted
  client-side while the server is still finishing it.
- **Run-card SSE no longer doubles on reconnect** (events reset on each connect;
  the completion close-race is fixed); the model chip shows the **active** provider
  instead of the newest; duplicate submits (double-Enter during upload / fresh
  session) are guarded; auto-scroll no longer detaches mid-stream.
- **Naive-timestamp evidence-import plan** no longer 500s (inputs normalized to
  UTC). **account_discovery** now fails the run when `list_buckets` fails (was
  reported as a healthy empty account); **diagnostic** reports `completed` when its
  probes ran even if the target is unhealthy (`failed` = executor failure only).
- **Redaction gaps:** base64 Bearer tokens are fully masked (charset now includes
  `/ + =`); `X-Goog-Signature`/`X-Goog-Credential` presigned params are covered.
  Object keys / bucket names are stored verbatim (redaction could mangle a key so
  the later fetch 404s).
- **keyring_store** persists to disk before mutating the in-memory blob (no
  memory/disk divergence on a failed write); the write-only negative cache was
  removed. Cross-table timestamps are unified to ISO-8601 `Z`; report paths are
  stored relative to the data dir (readers still accept legacy absolute rows).
- **Concurrency guards:** re-executing a running/completed run returns 409; the
  evidence-import confirmed→importing transition is atomic; unknown run types and
  pre-executor exceptions now mark the run `failed` instead of leaving it `pending`
  forever. `analyze_uploaded_file` reuses an already-imported dataset instead of
  re-ingesting every call; per-turn AsyncOpenAI clients are closed.

### Changed

- **Slimmed the session-agent system prompt.** Safety rules are stated once
  (no longer injected a second time as context JSON), tool-by-tool advice that
  merely restated tool descriptions was removed, and prescriptive routing
  decision-trees that second-guessed the model were dropped — keeping the security
  constraints and answer-contract requirements. Less ossification, more autonomy.
- **Converged the two turn implementations.** The blocking `answer()` path now
  drives the same streaming implementation to completion instead of a duplicate
  loop, removing the divergence that caused the fallback races.
- **Extracted a shared run-executor harness** (`runs/_common.py`): all five
  executors now share status-transition / report / SSE / failure scaffolding
  instead of copy-pasting ~30 lines each.
- Frontend `Thread` split into a `Composer` component and a `useTurnRunner` hook;
  the run-transcript UI is now fully translated (en/zh).

### Removed

- **The planner vestige of the retired dual-track design:** `runs/planner.py` and
  the canned "Plan" section it injected into diagnostic reports; error-triage no
  longer stamps `planner_mode`. Dead guard constants/functions
  (`AGENT_MAX_RANGE_BYTES`, `sanitize_output_for_agent`, `assert_report_sanitized`,
  the `FORBIDDEN_TOOLS` alias, the `sample_bucket_objects` branch) and the
  parsed-but-unused keyword-router frontmatter (`trigger_keywords`/`auto_route`/
  `priority`/`keyword_blob`) are gone.
- **Shrank the legacy `/tools` HTTP surface** to the two endpoints the UI actually
  uses (`head-bucket`, `list-objects-v2`, both now scope-checked); the underlying
  read-only S3 functions remain as agent tools.
- Frontend dead code: unused `refreshSessionSummary`, the `service` prop, and
  retired i18n keys.

## [0.23.0] - 2026-07-02

_Agent-autonomy pass: closes the capability ceilings and last silent-truncation
found in the agent-native review — without loosening any security floor (no write
tool, no raw SQL, no raw rows to the model, data-moving work still confirmed).
Also fixes two Codex-review P2s: re-uploads now rebuild the DuckDB table (no stale
aggregate), and the implicit oldest-provider is flagged `active` so the UI badge
matches the agent's choice._

### Added

- **`aggregate_uploaded_file` — constrained, parameterized analysis.** The agent
  can now answer arbitrary aggregate questions about an uploaded log/inventory
  ("top masked IPs by 4xx count", "total bytes per storage class") by choosing a
  metric + group-by + equality/status-range filters **from a hard whitelist**
  (`analysis/aggregate.py`). It never supplies SQL; only grouped aggregates
  (≤50 groups, redacted labels) return — never raw rows. All values are bound as
  DuckDB parameters and the real SQL is audited (rule 17). Removes the biggest
  residual ossification: the agent was locked to a fixed metric set.
- **Active model-provider selection.** `POST /model-providers/{id}/activate` and
  an `active` flag let the agent use a chosen provider; previously it always used
  the oldest one, so adding a second provider silently did nothing. With no
  selection the oldest remains the default (unchanged for single-provider
  installs); deleting the active provider clears the selection.
- **Parquet + gzip previews.** `preview_object` decompresses `.gz` objects within
  the same byte bound and returns a `.parquet` STRUCTURE preview (schema + row
  counts from the footer via one bounded suffix-range GET — never the body),
  instead of dead-ending at "binary, not previewed".
- `read_run_result(wait_seconds)` — the agent can wait in-turn (≤60s) for a
  backgrounded survey/review to finish instead of asking the user to send another
  message.

### Changed

- **The user's message is no longer silently truncated.** A long paste is cut at
  16000 chars (was a silent 2000) with an explicit `[TRUNCATED: N more…]` marker
  so the agent knows it saw a prefix — the same "no silent caps" rule as ingestion.
- **Raised the autonomy ceilings** that were forcing deep investigations to give
  up early: agent turn budget 16→24; per-turn object-preview budget 8→12 calls /
  8→16 MiB; latency-probe budget 6→8; skill-load budget 6→8; list-objects context
  echo 200→500 keys. All remain code-enforced bounds (never human-approval gates).
- **Inline survey/review timeout 60s→180s** so a real account survey completes in
  one turn instead of being split across two; the session SSE stream now emits
  keepalives during the wait so the client connection stays alive.
- The forbidden-tool denylist no longer bare-blocks the tokens `sql`/`query`
  (which would ossify against the constrained aggregate tool); only genuine
  raw-SQL-execution phrases (`run_sql`, `execute_query`, …) are blocked.

## [0.22.1] - 2026-07-02

### Changed

- **The file-ingestion row cap is no longer silent.** `import_access_logs` /
  `import_inventory_file` now return `truncated` + `ingest_cap`, and the
  `analyze_uploaded_file` tool surfaces a `truncated`/`rows_analyzed` note (and
  the deterministic run summaries a matching line) when a file exceeds the
  in-memory cap — so the agent reports the metrics as a lower bound over the
  analyzed rows, never as the whole file. Honors the agent-native "no silent
  caps" rule that the v0.22.0 memory bound had brushed against.

## [0.22.0] - 2026-07-02

_Architecture-review remediation: closes the findings from the deep v0.21.1
review across the security layer, agent runtime, S3/runs layer, API/data layer,
frontend, and docs/CI. No change to the single-agent loop or the read-only
security floor. Minor-bumped (not a patch) because the packaged sidecar now
**requires** the launcher's auth token — a behavior change for any external
caller._

### Security

- **Sidecar now requires a shared-secret token when the launcher sets one.** The
  local API bound `127.0.0.1` but relied on CORS alone, so any other local
  process could drive cloud operations with the user's stored credentials. Tauri
  now generates a per-launch token, passes it via `STORAGE_AGENT_AUTH_TOKEN`, and
  the sidecar rejects any request missing it (`X-Sidecar-Token` header, or a
  `token` query param for header-less SSE). Auth stays open when the variable is
  unset (dev/browser/tests).
- **Redaction closes value-level gaps (rule 15).** `redact_text` now also masks
  labeled AWS secret keys / session tokens, cookies, bare `Signature=…`, and
  common third-party tokens (GitHub/Slack/Google/JWT) in free-text — so a
  previewed `.env`-style object body can't leak them into the model context.
- **Vault key-file creation is now crash/race-safe** (fsync + complete-read
  retry so a losing creator never adopts a partial key), and
  `strip_chain_of_thought` strips paired `<think>…</think>` blocks without
  truncating a legitimate answer that merely contains "reasoning:".

### Fixed

- **Reloaded threads keep their grounding + proposed-action chips.**
  `SessionMessageOut` was silently dropping the `grounding`/`proposed_actions`
  columns migration 016 persists, so the v0.21.0 transparency cards never
  rendered after reload; both fields are now serialized (frontend also renders
  them live from the stream).
- **Streaming turns persist on a dedicated DB connection.** The worker thread had
  been writing through the request-scoped connection, which a client disconnect
  could close mid-write and lose the turn; it now opens its own connection and
  completes server-side regardless of the client, and the client stream ends
  promptly on disconnect (Stop button + timeout on the frontend).
- **The six bucket-config-review tools reach the model with real descriptions**
  (setting `__doc__` after `function_tool` was a no-op; now sets the FunctionTool
  fields directly) so tool selection no longer runs on names alone.
- **The answer contract parser no longer eats a JSON example in the prose** — it
  now consumes the last fenced block that actually carries contract keys, leaving
  bucket-policy/CORS/lifecycle JSON examples intact in the answer.
- **Account discovery reports denied buckets correctly.** `access_status` was
  gated on `not region`, which is almost never true (region falls back to the
  provider's), so fully-denied buckets showed as "available"; the mapping now
  keys off the HeadBucket status directly.
- **Bucket names are no longer run through redaction** before being reused as
  `Bucket=` API arguments (a token-shaped name could be mangled to
  `***REDACTED***`, breaking every per-bucket follow-up).
- `preview_object` reports a zero-byte object (416 InvalidRange) as an empty
  preview, and `get_object_lock_status` treats `InvalidRequest` (bucket without
  Object Lock) as "no lock" rather than a hard error.
- Corrected the agent prompt that described `list_objects.key_count` as "the true
  total" — it is the per-page count, and reporting it as the bucket total misled.
- Frontend: RunDetail SSE reconnect + stale-fetch guards, and a failed session
  load now shows an explicit error/retry instead of an empty new-chat surface.

### Changed

- **Run SSE event buffers are bounded** (per-run event cap with offset-preserving
  eviction, plus eviction of finished runs) so a chatty run or reconnect loop
  can't grow memory without limit.
- Memory-recording and uploaded-file-analysis tools now commit their audit rows
  (no lingering write transaction across model latency) and audit the analysis /
  `read_run_result` invocations (rule 17). Run executors record an honest
  analysis descriptor instead of a fake `SELECT …` string.
- Evidence-import approval JSON is built with `json.dumps` bound as a parameter;
  `_read` hard-asserts a read-only method prefix; the migration runner recovers
  idempotently from a partial-apply retry; file ingestion is row-bounded.
- A strict Content-Security-Policy replaces the null CSP in the Tauri shell.
- Docs realigned with code (api.md, data-model.md, tools.md, CLAUDE.md tool
  name), version stamping covers all four manifests, CI uses `npm ci` + a ruff
  gate, and the release tag targets the built commit.

## [0.21.1] - 2026-07-02

### Changed

- **Loosened the AI-SDK upper bounds so new agent-SDK features flow in.** Dropped
  the redundant `openai<3` (`openai-agents` already constrains openai to
  `<3,>=2.36`) → now `openai>=2.40`. Relaxed `openai-agents>=0.17,<0.18` →
  `>=0.17,<1`: every 0.x feature minor (0.18, 0.19, …) is adopted automatically,
  and only the 1.0 boundary — a pre-1.0 SDK's likely rewrite — stays a
  human-reviewed bump. Trade-off accepted: a breaking 0.x minor could land
  silently (tests stub the agent loop, so CI may not catch a real Runner API
  break); the `<1` guard blocks only the single most-likely-to-break jump.

## [0.21.0] - 2026-07-02

_"还债与收敛" — closes every finding verified in a third-party v0.20.11 review:
documentation debt, dead guardrail ceremony, grounding-lost-on-reload, skill
gaps, stale triage names, four frontend UX gaps, and legacy-API/dependency
hygiene. Two findings were closed the agent-native way rather than as the review
literally suggested — the dead tool-allowlist ceremony was **deleted** (not
wired), and the proposal `action_type` naming was **documented** (not renamed) —
both to avoid re-introducing churn/ossification. No change to the single-agent
loop, the bounds-not-gates safety model, or the read-only security floor._

### Build / API hygiene

- **Pinned the fast-moving AI SDKs for reproducibility.** `openai` and
  `openai-agents` had only `>=` floors far below the installed versions, so CI
  (which installs from `pyproject`, no lockfile) could silently pull a breaking
  release. Bounded to the tested range: `openai>=2.40,<3`,
  `openai-agents>=0.17,<0.18` (pre-1.0 → cap at the next minor).
- **`POST /runs` documented as internal/testing.** It is not a user surface (the
  frontend never calls it; the agent drives runs via `run_service`, evidence
  import creates its run server-side). Clarified in the `runs` router docstring
  and `docs/api.md`; kept because the deterministic run layer is the
  reproducibility/security floor and the test suite creates runs through it.
- **Removed the dead `not_implemented` run branch.** `run_type` is a `RunType`
  Literal (FastAPI 422s anything else) and every value is executable, so the
  fall-through placeholder was unreachable; replaced with a defensive 422.

### Frontend

- **Attach-only send.** The composer's send button (and Enter) were disabled
  whenever the text was empty, even with a file attached — so "analyze this file"
  with no typed message was impossible. Send is now enabled when either text or an
  attachment is present.
- **Session findings surface in the thread.** A read-only, collapsible
  `FindingsCard` renders the persisted deterministic session findings the API
  already held — previously visible only in the report.
- **EvidenceImportDialog is localized.** Its ~25 hard-coded English strings now go
  through `t()` with full en/zh entries (title, plan fields, buttons, hints).
- **Removed the dead `SidecarStatus` component.** The `.tsx` component was never
  rendered (only the same-named *type* from `useSidecarHealth` is used); deleted
  to cut confusion. The health hook itself is unchanged.

### Fixed

- **Stale tool name in triage playbooks.** The offline error-triage `next_checks`
  suggested `get_bucket_location`, which is not a tool the agent exposes;
  replaced with `get_bucket_config_summary` (which reads region/location) across
  all affected playbook entries.

### Changed

- **Offline triage now points at the specialist skill.** Each triage category
  maps to the StorageOps skill whose method applies (`authz` →
  security-iam-policy, `routing`/`auth` → s3-protocol-compatibility, etc.), and
  the triage result carries a `suggested_skills` pointer (derived, not persisted).
  Deterministic triage can't `read_skill` itself, but this lets a session agent
  jump straight to the right method and tells an offline user which skill covers
  their case. Unmapped categories fall back to `storageops-triage`.
- **Documented the proposal `action_type` → execution mapping** in
  `next_actions.py` (report §P3). The `run_*` slugs are internal/audit-only (the
  user only ever sees the proposal title + a localized prompt), so they are kept
  stable rather than renamed — a comment now records what each actually does
  (e.g. `run_diagnostic` → the agent's adaptive probe chain, not a run).

### Skills

- **Filled the verified skill gaps (18 → 20 skills).** Two genuinely-missing
  methods added: `storageops-workbench-investigation` (the general observe →
  probe → verify → ground → propose loop, previously only implicit in the agent
  prompt) and `storageops-observability-audit` (logging + notifications + metrics
  + inventory + tagging as one coherent audit, catching "logging enabled but
  delivered nowhere" gaps). The two partially-covered areas were **expanded in
  place, not fragmented**: a public-exposure pass added to
  `storageops-security-iam-policy` and a provider capability matrix added to
  `storageops-s3-protocol-compatibility` (with registry routing updated).
- **Tool hints where they were missing.** `preview_object` referenced from
  `cli-sdk-diagnosis` + `data-consistency`; `list_uploaded_files` referenced from
  `access-log-analysis` + `inventory-analysis`; `storageops-triage` decision tree
  now routes to account-posture / inventory / observability / evidence-reporting /
  workbench-investigation.
- **`skills_used` cap raised 3 → 6** to match the per-turn `read_skill` budget, so
  a turn that legitimately loaded several skills reports all of them (the
  bound-to-actual-`read_skill` honesty filter is unchanged).

### Added

- **Grounding + proposed actions now persist per assistant turn (survive
  reload).** Migration 16 adds `session_messages.grounding` and
  `.proposed_actions` (sanitized JSON). Previously the transparency payload
  (`evidence_used` / `evidence_gaps` / `skills_used`) and the turn's next-action
  proposals rode only the transient SSE `done` event, so a page reload dropped
  them and a historical turn could no longer show *why* it said what it said. The
  backend now stores them on the assistant message and returns them from
  `GET /sessions/{id}/messages`; the frontend renders the grounding card +
  proposal chips **per assistant message** from the persisted data (a single
  source of truth) instead of a transient bottom block. `tool_activity` (already
  persisted) is unchanged; `evidence_used` remains the model's self-report, kept
  distinct from the mechanical tool trace.

### Removed

- **Dead guardrail ceremony (`check_tool_allowed`, `ALLOWED_TOOLS`,
  `approval_category`).** These were never called on the live agent path — a
  redundant static allowlist that had to be hand-synced with the real tool
  registration, plus a `max_keys > 1000` "approval" category that could never
  trigger (the agent's list size is clamped by `bound_tool_args`, not gated).
  Keeping them would have re-introduced an ossification point (adding a read-only
  tool would require editing a second list) that violates the project's
  "bounds, not gates" line. The tool **whitelist is the curated
  `@function_tool` registration** in `session_tools` / `session_action_tools` /
  `session_analysis_tools` / `session_memory_tools`; the forbidden-token/phrase
  **denylist** (`is_forbidden_tool`, still live in proposal-slug sanitization) is
  the defense-in-depth net and is now asserted over the *real registered* tool
  set in `test_agent.py` (which also gained the 0.20.9–11 tools). `bound_tool_args`
  and all sanitization/secret-assertion helpers are unchanged. No runtime
  behavior change for the agent.

### Documentation

- **Truth-up pass on stale docs (no behavior change).** A third-party review
  found the docs describing an older, runs-first design. Corrected across
  `architecture.md`, `security.md`, `tools.md`, `api.md`, `product.md`, the skill
  registry header, and three module docstrings:
  - Skill count 16 → 18; removed references to the deleted `skills/selection.py`
    lexical selector and the removed `read_skill` "tools-disabled preamble"
    (`read_skill` returns a frontmatter-stripped, length-bounded body).
  - Reframed the product flow from "Goal → Evidence → Runs → …" to agent-first
    (agent drives; runs are the auditable/security floor beneath it); noted that
    only `origin !== 'agent'` runs card in the thread.
  - Documented the 0.20.9–0.20.11 tools in `tools.md`
    (`list_object_versions`, `list_multipart_uploads`, `measure_request_latency`,
    `get_object_lock_status`) and corrected "cannot download object bodies" to the
    bounded `preview_object` / `test_range_get` exception.
  - `api.md`: SSE `done` event documents the grounding fields
    (`evidence_used` / `evidence_gaps` / `skills_used`, added 0.20.8).
  - Removed stale mentions of a preview endpoint / `NewRunForm` / an
    interpretation-only triage Agent (triage is deterministic; interpretation is
    the session agent in-thread).
  - Noted registry `trigger_keywords` / `domains` / `auto_route` are parsed but
    currently unconsumed (no offline selector).

## [0.20.11] - 2026-07-01

### Added

- **`measure_request_latency` — the agent can now MEASURE latency, not just guess
  at it.** Performance diagnosis previously had no way to time anything: the
  bucket performance profile only inferred small-file overhead from object-size
  metadata. This tool fires a bounded set of lightweight head round-trips
  (HeadBucket, or HeadObject on a named key — never an object body) and returns
  min/p50/p95/max/mean milliseconds, turning "it's slow" into numbers. It is a
  diagnostic probe, not a load test: the per-call sample count is hard-capped
  (≤10) and probe runs are bounded per turn. The `storageops-performance-diagnosis`
  skill now points at it as the first step for any speed complaint.
- **`get_object_lock_status` — object-level retention + legal-hold read.** Answers
  "why can't I delete/overwrite this object?" by reading one object's actual
  retention mode + retain-until date (`GetObjectRetention`) and legal-hold status
  (`GetObjectLegalHold`). Bucket config review could only show *whether*
  object-lock is enabled on the bucket, never a specific object's lock. Read-only;
  a missing lock, or a provider that doesn't implement object-lock, is reported as
  a normal `none` / `provider_unsupported` state rather than a hard failure. The
  `storageops-replication-versioning` skill references it for object-lock puzzles.

Both tools are read-only, sanitized, and enforce safety through code-level bounds
(sample caps, per-turn budgets) rather than confirmation gates — the agent-native
"bounds not gates" line. No object bodies are read by either; no write path is
added. 9 new tests (Stubber-backed); full suite 295 passing.

## [0.20.10] - 2026-06-30

### Added

- **Two read-only data-level tools the agent was missing — version pileup and
  abandoned multipart uploads.** Config review could only see *whether* versioning
  and cleanup rules exist, never the actual data behind unexplained bucket
  size/cost. The agent now has:
  - `list_object_versions` — the real noncurrent-version + delete-marker pileup
    (counts, current vs noncurrent bytes, ≤20 sample keys) — the concrete answer
    to "why is my versioned bucket so large/expensive?".
  - `list_multipart_uploads` — incomplete/abandoned multipart uploads (a common
    silent cost leak: parts billed but invisible in a normal listing). **List
    only** — aborting is a mutation and stays out; the agent proposes a lifecycle
    rule instead.
  - Both are read-only, bounded (≤1000/page + paging, ≤20 sample keys), sanitized,
    inline (no confirmation — same tier as `list_objects`), and report
    `Provider unsupported` cleanly on S3-compatible providers that lack them. The
    lifecycle-cost and replication-versioning skills gained capability hints
    pointing at them.

## [0.20.9] - 2026-06-30

### Added

- **`preview_object` — the agent can now read a bounded preview of an object's
  content.** Previously the agent could enumerate keys and read metadata
  (`head_object`) but could not look *inside* an object. It now has a read-only
  `preview_object(provider_id, bucket, key)` tool: a single bounded Range GET
  (hard cap 1 MiB/call), text-only (binary/oversized objects are reported, not
  decoded), redaction-passed, never persisted, and bounded per turn (a few
  objects / a few MiB) so it can't be looped into a bulk download. This makes
  "what's inside this manifest / config / log object?" answerable inline.
  - **Agent-native by bounds, not a gate:** no per-call confirmation (that would
    ossify the loop) — safety is code-enforced caps + sanitization + audit, the
    same model as the other read-only probes.
  - **Security rule #11 updated** accordingly: from "no object bodies by default"
    to "no *bulk* body downloads, with `preview_object` as the one bounded,
    audited, per-turn-capped exception." Bulk/recursive/full-object downloads
    remain prohibited; evidence import (GB-scale) still requires confirmation.

## [0.20.8] - 2026-06-30

### Fixed

- **Interrupted runs no longer report as forever-running.** A run left
  `pending`/`running` when the app quit mid-flight (in-process run threads can't
  survive a restart) is now reconciled to `failed` (interrupted) on startup, so
  `read_run_result` and run cards don't show it as perpetually running.

### Added

- **The agent now shows what its answer is grounded in.** A compact, collapsed
  "Why this answer" affordance under a turn surfaces the contract's
  `evidence_used`, `evidence_gaps` ("not yet verified" — what the agent couldn't
  confirm / needs from you), and `skills_used`. The backend already produced
  these; they were being dropped. Transparency only — no new capability, and the
  agent stays a read-only investigator.

## [0.20.7] - 2026-06-30

### Fixed

- **Clicking a suggested next-step no longer drops the literal text "None" into
  the composer.** A proposal with an explicit null `title`/`reason` was stringified
  as Python `str(None)` → `"None"` in `normalize_proposal` (the `get(k, "")`
  default only applies to *absent* keys, not present-but-null ones), which then
  surfaced as the `ask_user_for_context` composer prefill. Null/None now coerces
  to `""`, so `title` falls back to the action-type label and `reason` becomes
  `None` (and the prefilled question is always a real sentence).

## [0.20.6] - 2026-06-30

### Added

- **Two StorageOps skills for gaps the tools already supported** (catalog now 18):
  - `storageops-inventory-analysis` — how to read an inventory for capacity and
    object-shape (size/count, size histogram, prefix and storage-class
    distribution, small-object ratio, largest objects) via `analyze_uploaded_file`
    (attached file) or a confirmed `plan_inventory_import` (+ `read_run_result`).
    The fact layer beneath the lifecycle/cost decision.
  - `storageops-account-posture` — how to use `survey_account` for an account-wide
    landscape + config posture (logging / inventory / lifecycle / public-access-
    block per bucket) and where to look first, with `read_run_result` for a
    backgrounded survey. The no-error audit entry point (vs triage's error path).
  - Both are written agent-native: on-demand knowledge with adaptive decision
    trees and capability hints, **not** fixed pipelines (account-posture explicitly
    says not to reflexively review every bucket); app-native tool names only;
    guidance-only. `eval-golden-cases` gains a "coverage honesty" check (don't
    assert a feature absent when `access_denied`; snapshot ≠ trend; visible vs
    total buckets). Routing relies on the distinct catalog descriptions.

## [0.20.5] - 2026-06-30

Skill-pack hygiene from a coverage review — agent-native (skills stay on-demand
knowledge the agent reasons over, never control flow); no new skills yet.

### Changed

- **Protocol skill now routes CORS to a real tool.** `storageops-s3-protocol-compatibility`
  listed CORS in its triggers but never told the agent how to inspect it; it now
  points a CORS failure at the read-only `review_bucket_security` (which reads the
  bucket's CORS rules) — as a conditional capability hint, not a mandatory step.
- **Access-log skill names `read_run_result`.** When a `plan_access_log_import`
  finishes in the background, the skill now says to pick the result up with
  `read_run_result(run_id)` instead of re-importing.
- **Skill catalog wording is less run-centric** — "run a survey/review inline, or
  propose a confirmed import" rather than "propose confirmed runs".

### Removed

- **Dead skill-injection path.** Deleted `skills/selection.py` (the lexical
  selector) and `skills.context.build_skill_context` / `WRAPPER_PREAMBLE` — the
  legacy eager-injection path superseded by the live catalog + `read_skill`
  progressive disclosure. Nothing in production used them (offline triage is
  deterministic and loads no skills); only their own tests did. Tests trimmed
  accordingly, keeping live-path coverage (catalog, `read_skill`, frontmatter
  stripping).

## [0.20.4] - 2026-06-30

### Fixed

- **A step-budget (`max_turns`) limit no longer breaks the session.** Previously
  a complex investigation that exhausted the turn budget surfaced a hard
  "Max turns (16) exceeded" error, lost the whole turn, showed a misleading "open
  settings" action, and (because the failed stream fell back to the blocking
  turn) re-ran the entire agent a second time. Now, when the budget is reached,
  the agent makes one **tool-less finalize call** that synthesizes a grounded
  best-effort answer from the investigation so far (explicitly marked as possibly
  incomplete, with an offer to continue). The turn budget is unchanged and still
  bounded (N tool-loop turns + 1 tool-less finalize); the client never sees a
  max-turns error and never double-runs. The agent is also instructed to converge
  and checkpoint findings (`record_finding` / `note_fact`) as it works, so a
  "continue" follow-up resumes from real context.
- **The model chip refreshes after first-run configuration.** Adding the first
  model provider through the Settings drawer (e.g. via the first-run wizard)
  changed neither sidecar-readiness nor the active session, so the composer chip
  stayed on "Add model" until a session switch — even though chat already worked.
  The chip now re-fetches when the Settings drawer closes.

## [0.20.3] - 2026-06-30

### Fixed

- **The thread no longer looks frozen while the agent is generating.** After the
  tool trace appears, the post-tools / between-rounds wait (often the longest,
  with no streamed text yet) showed only a lone blinking caret. It now shows an
  explicit animated "Working… (still running)" indicator until the answer starts
  streaming.
- **Error-triage next-step chips survive a reload / session-switch.** The
  deterministic `safe_next_actions` were only on the POST response, so reopening
  a session showed empty chips. `GET /error-triage/{id}` and
  `GET /sessions/{id}/error-triage` now re-derive them deterministically from the
  stored (already redacted) input — no new storage, no migration.

### Changed

- **Tool-name consistency (`§2.4`).** The error-triage playbooks, `docs/tools.md`,
  and the `CLAUDE.md` whitelist now use the agent-facing tool names
  (`test_addressing_style`, `inspect_endpoint_tls`) that the SKILL.md bodies and
  agent instructions already use — so guidance never names a tool the agent
  can't call. (The underlying S3-layer functions keep their names:
  `test_path_style_vs_virtual_host`, `inspect_tls`.)
- **`read_run_result` is now listed in the agent's main tool instructions**, not
  only in the survey-timeout note — so the agent knows it can re-read a
  backgrounded survey/review/import result in a later turn instead of re-running.
- **Stale docs/docstrings** aligned to the single-agent model: `architecture.md`
  (removed "analysis narrators"; skill context is catalog + `read_skill`
  progressive disclosure, not eager 1–3 selection; triage flow has no "optional
  Agent interpretation"); `skills/__init__.py`, `skills/context.py`,
  `skills/contract.py` (no "triage Agent" / eager-injection framing);
  `pyproject.toml` (no "agent planner mode"); `summary_builder.py` comment
  (proposals are free-form, not a fixed allowlist).

## [0.20.2] - 2026-06-30

Post-v0.20 review cleanup — no behavior change beyond stronger redaction.

### Security

- **Shared redactor now scrubs model API keys (`sk-…`).** Defense-in-depth: a
  model key pasted into the chat or echoed in a provider error is masked
  everywhere the shared redactor runs (session messages, audit logs, reports),
  not just on the triage path. Aligns with security rule #15.

### Removed (dead code from the v0.20 single-agent migration)

- `analysis/drilldown.py` + its test — the bounded-aggregate tools whose only
  consumer (the deleted in-run analysis narrator) is gone.
- `runs/analysis_report.py`: `agent_analysis_md` + `render_agent_report` (the
  "Agent Interpretation" / "Agent mode" report sections) and the now-empty
  `agent_section` parameter on the dataset-report renderers.
- Frontend dead API: `uploadDataset` (run-scoped upload) and `listDatasets`.
- `next_actions.ALLOWED_ACTION_TYPES` dead back-compat alias.

### Changed (stale docs / comments)

- `docs/architecture.md`: `account_discovery` description no longer claims an
  "Agent mode 422 / future phase" — it's the agent's `survey_account` tool.
- `CLAUDE.md`: dropped the dead `optimization_report` capability bullet.
- `agent_runtime/__init__.py`, `guardrails.py`, `main.py`: docstrings no longer
  describe an "agent planner mode" (there is one conversational agent).
- `next_actions.normalize_proposal` docstring: clarified it accepts any safe
  free-form action_type (not a fixed allowlist).
- Frontend `RunEvent`: removed the never-emitted `plan` / `tool_selected` types.
- Stripped historical "(Phase NN)" provenance tags from module docstrings
  (migration provenance comments kept).

## [0.20.1] - 2026-06-30

### Fixed

- **Empty-state subtitle no longer overpromises.** "Read-only by default — I'll
  ask before running anything" became "Read-only and never destructive — I'll
  ask before moving any data" (zh equivalent): the agent runs read-only checks
  itself; only cloud data-moving work is confirmation-gated.
- **Backgrounded survey/review now resumes via `read_run_result`.** When an
  inline survey/review exceeds the time budget, the timeout note and the agent
  instructions now tell the agent to call `read_run_result(run_id)` in a later
  turn instead of re-running the survey.
- **Triage `safe_next_actions` are now clickable.** `TriageCard` renders the
  deterministic next-check proposals as one-click chips (same handoff as agent
  proposals), instead of dropping a field the API already returned.
- **Doc residual:** `docs/security.md` "Graded execution" no longer references
  the removed `autonomous_readonly`/`assisted` autonomy policy.

## [0.20.0] - 2026-06-30

**Single-agent architecture.** This release finishes the agent-native migration
by eliminating the dual-track design: there is now exactly **one** LLM in the
product — the conversational session agent. Everything under `runs/` is pure
deterministic compute the agent invokes as a tool or saves as an auditable
report artifact. No second "run-planner" LLM, no in-run interpretation
narrators, no `planner_mode` switch. The deterministic engines, DuckDB, the S3
read-only whitelist, output sanitization, and the confirm gate on data-moving
work are all kept — they are the security floor.

### Removed

- **The run-planner agent.** Deleted `agent_runtime/tool_registry.py`,
  `prompts.py`, `context_builder.py`, `result_parser.py`, and the
  `agent_service.run_agent` / `ToolInvoker` machinery. `agent_service.py` now
  keeps only `build_agent` / `get_model_credentials` for the conversational
  agent.
- **In-run interpretation narrators.** Deleted
  `agent_runtime/analysis_agent.py` (the `access_log_analysis` /
  `inventory_analysis` narrator, which used the `analysis/drilldown.py` aggregate
  tools) and `error_triage/triage_agent.py`. Analysis and triage are
  deterministic-only; the conversational agent narrates the sanitized result if
  asked. (`analysis/drilldown.py` was left orphaned and is removed in 0.20.2.)
- **`planner_mode`.** Dropped from the API (`RunCreate`/`RunSummary`/`RunDetail`,
  `ErrorTriageRequest`), the run SSE `run_started` event, the frontend types, and
  the run-detail UI. `run_service.run_sync` always dispatches a run to its
  deterministic executor; the `runs.planner_mode` SQLite column is retained
  (defaulting to `'deterministic'`) only because the schema is append-only and is
  no longer read or written.
- **The `optimization_report` run type** (never implemented as a real executor);
  an unknown `run_type` is now a clean 422.

### Changed

- **Runs expose only their real tool trace, findings, and summary** — no canned
  step "plan" event and no agent-authored prose section in reports.
- **Evidence import is reached through the agent**, not a separate panel —
  `AccountProfilePanel` is now a read-only profile view.

### Added

- **`read_run_result(run_id)`** tool — lets the agent pick up a backgrounded
  survey/review/import result in a later turn (status + sanitized summary; only
  runs linked to the current session) instead of re-running.

## [0.19.29] - 2026-06-30

Cleanup pass resolving the verified-true items from a code/skills review — no
new behavior, all agent-native consistency, dead-code removal, and small fixes.

### Fixed

- **Slash `/logs` and `/inventory` now open the file picker** (like the
  empty-state chips), instead of seeding a prompt the agent has no file to act on.
- **The model chip recovers from a transient sidecar blip** — `refreshModel`
  retries a few times instead of getting stuck on "Add model" until a refresh.
- **Sending an ambiguous-type attachment gives feedback** (a "choose a type"
  hint) rather than a silent no-op.

### Changed

- **`skills_used` is bound to skills actually loaded** via `read_skill` this turn
  — the model can no longer *claim* a skill it never opened (keeps the report
  honest).
- **Skill selection is robust to spacing/punctuation** — a keyword like
  `SignatureDoesNotMatch` matches `"Signature Does Not Match"` / `"access-denied"`
  without a hard-coded error→skill map (still metadata-driven).
- **`read_skill` has a per-turn budget** (max 6 loads) so a loop can't pull every
  skill body into context.
- **The deterministic session report labels its "next actions"** as rule-derived
  suggestions, distinct from the agent's own proposals.
- Refreshed stale `SKILL.md` guidance (access-log, lifecycle-cost, performance,
  security-iam, migration, replication) to the current tools: local files →
  `analyze_uploaded_file` inline; config/account → `review_bucket_config` /
  `survey_account`; only cloud imports stay confirmed.

### Removed

- Dead `/sessions/{id}/actions/preview` endpoint + `preview()` + the frontend
  `ActionPreviewResult` type.

### Docs

- Rewrote `docs/architecture.md` to the agent-native model (no autonomy toggle,
  no `new_run` form, free-form proposals, `origin='agent'` runs hidden from the
  thread); fixed the `session_agent` module header (attached files analyzed
  inline) and the inline-survey timeout note.

## [0.19.28] - 2026-06-29

Completes the agent-native rebuild: the conversational agent is the **sole**
operating surface, and no rigid/ossified pipeline remains. Deterministic engines
survive only as the security/reproducibility floor the agent invokes (and as
opt-in auditable reports) — never a UI-fired flow or a card mid-conversation.

### Changed

- **No run card ever appears from a conversation.** The agent's own read-only
  survey/review tools (`survey_account`, `review_bucket_config`) now record runs
  with `origin='agent'` (migration 15) that the thread filters out — the agent
  narrates the result inline instead. This removes the stray deterministic
  `account_discovery` card that could fire mid-chat (e.g. while analyzing an
  uploaded log).
- **Retired the agent-autonomy toggle entirely.** The agent is always a fully
  autonomous read-only investigator; the `assisted`/`autonomous_readonly` setting,
  its endpoint, and its Settings UI are gone. Read-only investigation always runs;
  cloud data-moving work still always requires confirmation.
- **The agent stays on the user's request.** New instructions stop it from firing
  cloud probes (credentials, account survey) for a local-file task — it analyzes
  the attached file and answers, touching the cloud only when asked.
- **Removed the retired `new_run` form handoff** from next-action proposals:
  investigation/diagnosis/config/account/analysis proposals route back to the
  agent conversationally; only evidence import, the saved report, and a context
  question get a purpose-built flow.

### Fixed

- Uploading a file no longer loses it if the upload fails (the composer is
  cleared only after success).
- Forking a session now copies its uploaded datasets and their files on disk.
- Re-uploading the same filename reuses the dataset row instead of leaving
  duplicate records pointing at one overwritten file.
- A streamed turn that ends without a completion event now reconciles via the
  blocking fallback instead of showing an empty next-steps list.
- Empty-state "Analyze access logs" / "Inventory" chips open the file picker.

### Removed

- Dead code: `agent_runtime/autonomy.py`, the `/settings/autonomy` endpoint, the
  frontend `previewSessionAction`, and stale docs/comments (README confirmation
  wording, composer "two modes", the M012 "OS keychain" note, the "Phase 17
  allowlist" comment).

## [0.19.27] - 2026-06-29

This release removes the ossified, fixed-pipeline flows so the conversational
agent is the sole driver throughout. The deterministic compute that remains is
the security/reproducibility floor the agent invokes — never a reflex the UI
fires or a canned plan the agent is marched through.

### Changed

- **No more canned "plan" pipelines.** Every run executor (access-log, inventory,
  diagnostic, config-review, account-discovery) used to publish a hardcoded
  step-list as a "plan" event — the rigid card you'd see regardless of the data
  or your question. Removed everywhere; runs now expose only their real tool
  trace, findings, and summary, and the run-detail "Agent plan" card is gone.
- **The agent proposes free-form next steps, not a fixed menu.** Next-action
  proposals are no longer capped to 9 hardcoded `action_type`s (anything else
  used to be silently dropped). The agent now suggests any concrete next step in
  its own words; well-known ones keep a one-click affordance, the data-moving
  imports still route through the confirm-before-download planner, and anything
  else is handed back to the agent to carry out conversationally. A
  forbidden/destructive token in a proposal is still rejected outright.
- **Uploading a file is now agent-native — no more canned analysis run.**
  Attaching a log/inventory file in a session and asking "分析下" used to bypass
  the conversational agent entirely and fire a fixed deterministic
  `access_log_analysis` run (a rigid 5-step plan, `planner: deterministic`, a
  templated one-line summary). The file is now attached to the **session**, and
  your message goes to the conversational agent as a normal turn. The agent
  discovers the upload (`list_uploaded_files`), analyzes it locally with a new
  read-only `analyze_uploaded_file` tool (same DuckDB engine, sanitized
  aggregates only — ≤20 sample keys, no raw rows), and answers conversationally.
  If the file isn't actually a recognized access log/inventory (e.g. a generic
  app log with no HTTP fields), the agent says so instead of reporting empty
  metrics as if they were real. The deterministic analysis run still exists as an
  explicit, auditable capability.

### Added

- `POST /sessions/{id}/datasets/upload` — attach a data file to a session for
  agent-native analysis (migration 14: `session_datasets`).
- Session agent tools `list_uploaded_files` / `analyze_uploaded_file`
  (`agent_runtime/session_analysis_tools.py`), always available (local,
  read-only, sanitized).

## [0.19.26] - 2026-06-29

### Fixed

- **Log analysis no longer crashes on plain `.log`/`.txt` files.** Uploading a
  generic application log and asking the agent to "分析一下" used to surface a
  `ParserError` (the CSV fallback choked on ragged lines). The access-log parser
  now ingests any non-empty text line as a raw row, the CSV path skips malformed
  lines instead of raising, and a truly empty file produces a clear, friendly
  message instead of a cryptic stack trace. `.txt`/`.log` are fully supported.
- **Finished/failed runs show what they actually did.** Opening a run that had
  already terminated (e.g. a failed `diagnostic`) showed an empty timeline and a
  misleading "Waiting for plan…". The run detail now seeds its timeline from the
  persisted tool calls and falls back to the saved summary/error and report when
  no live stream replays, so a terminal run is never blank.

### Changed

- **The agent diagnoses adaptively instead of firing a canned pipeline.** Removed
  the architectural "ossification" where connectivity/credential/addressing
  questions reflexively triggered a fixed `diagnostic` run. Under the autonomous
  policy the in-chat agent now investigates with its own read-only tools
  (`test_credentials`, then branching to addressing/TLS/head-bucket/list/range
  checks) and explains the root cause. The deterministic `diagnostic` run still
  exists as an explicit, auditable report when you want a saved artifact.
- **Removed the out-of-place "梳理账号" (Discover account) button from Settings.**
  Account discovery belongs in a conversation, not the provider settings list;
  the orphaned button and its plumbing are gone.

## [0.19.25] - 2026-06-29

### Fixed

- **No more dangling user message on a failed turn.** The blocking message path
  used to persist your message before calling the agent, so a clean failure (no
  model key → 422) left a question with no answer in the thread. It now persists
  the message and answer together only on success — matching the streaming path.
- **Forking a session keeps the agent's memory.** `fork` now copies the agent's
  recorded facts/findings/open-questions, so a branched conversation doesn't lose
  context. (Deleting a session already cleaned memory up via cascade.)
- **Account discovery from Settings lands in a conversation.** The Discover
  button now spins up a session and opens it, so the run lives in a timeline
  instead of as an orphaned, invisible run.

### Changed

- README intro reconciled with the autonomy model (it no longer says the agent
  "never runs an action on its own"; it never *mutates* and always confirms
  data-moving steps, but can run read-only checks itself).
- The "enumerate completely" guidance now accounts for paginated object listings
  (page via the continuation token; for very large buckets report the exact count
  + a sample and offer an inventory analysis instead of pasting thousands of keys).
- Agent context fact cap aligned with the summary builder (50); stale
  "interpretation-only / assisted+" docstrings corrected to the live
  tool-calling, autonomous-read-only reality.
## [0.19.24] - 2026-06-29

### Fixed

- **"database is locked" during autonomous turns.** When the agent ran a
  read-only run itself (e.g. account discovery) during a chat turn, the turn's
  connection held the SQLite write lock across slow S3 calls (an uncommitted
  audit row), starving the run's background writes until they failed — which the
  agent then narrated as "tools locked / database contention." Session tools now
  commit their audit row immediately, keeping the write transaction tiny.
  `account_discovery` stays fully inline and autonomous. (Reproduced + regression
  test.)

### Added

- **Attach a dataset to analyze, right in the chat composer** (Codex/Cursor
  style). A 📎 button (and the "analyze inventory / access logs" suggestions)
  let you pick a local inventory (CSV/Parquet) or access-log file; the type is
  inferred from the file (with an Inventory/Access-logs toggle when ambiguous),
  and a session-bound analysis run streams inline as a thread card. This replaces
  the removed run-form file picker — the "analyze inventory/access logs" proposals
  now actually work end to end instead of dead-ending in a plain message.
## [0.19.23] - 2026-06-29

### Fixed

- **No more duplicate runs or messages when a stream drops mid-turn.** Each chat
  turn now carries a client turn id; if the streaming attempt breaks and the
  blocking fallback re-runs it, the server dedups — it won't re-persist a turn
  the stream already completed, and the agent reuses (rather than re-creates) any
  read-only run the failed attempt had already started.
- **Session-switch race.** Switching sessions while one is still loading no
  longer lets the slow response overwrite the now-current session's view.
- **Run detail race + silent load failure.** Opening runs quickly no longer lets
  a stale fetch overwrite the current run, and a failed load now shows an error
  instead of hanging on "Waiting for plan…".
- **Session actions surface failures.** Rename / pin / archive / delete / fork
  failures now show a banner instead of being silently ignored; a failed
  send-while-sidecar-not-ready keeps your text and shows the error.
- **Slow runs keep streaming.** The run event stream now sends heartbeats and
  stays open while a run is active (with an absolute backstop), instead of
  dropping the live timeline after 120s of silence on a slow run.
- **Unreadable secret vault is explained.** If the vault can't be decrypted,
  Settings now shows a clear warning (and how to recover) instead of just showing
  keys as "not set".
- **Inline runs that time out no longer mislead the agent.** When a read-only run
  exceeds the inline budget and continues in the background, the tool result
  tells the agent it's still running so it won't state premature findings.
- Internal: `may_execute` now matches the actually-inline-executable tools
  (`generate_session_report` is proposable, not auto-run) — no behavior change,
  removes a latent policy/tool inconsistency.

## [0.19.22] - 2026-06-29

### Fixed

- **Agent memory now surfaces the most recent learnings, not the oldest.** In a
  long session, facts/findings recorded past the per-kind cap were dropped from
  the agent's context while stale early ones lingered; the context now keeps the
  newest items, and the memory query is bounded so it can't grow without limit.
- **Inline read-only runs can no longer make a chat turn hang indefinitely.**
  When the agent runs a read-only run itself (autonomous mode), it's now bounded
  by a wall-clock timeout — a heavy/slow run (e.g. account discovery over a large
  account) keeps going in the background and the turn proceeds instead of
  stalling.
- **Object enumeration can't flood the model context.** `list_objects` now caps
  the number of keys returned to the agent per call (the exact count is still
  reported and paging via the continuation token still works), so walking a huge
  bucket page-by-page won't blow up context/cost.
- **An unreadable secret vault is preserved, not silently discarded.** If the
  vault can't be decrypted (e.g. the key file was lost), the original is backed
  up as `secrets.enc.unreadable` and a warning is logged, instead of quietly
  starting blank and overwriting it on the next save.

## [0.19.21] - 2026-06-29

### Fixed

- **Configured model and cloud providers can now be deleted.** The Delete button
  in Settings → Providers relied on the browser's `window.confirm`, which is a
  no-op in the Tauri webview, so the confirmation never returned and the delete
  never fired. Replaced it with the same inline two-step confirm (Cancel /
  Confirm delete) the session rail already uses, and surfaced any backend error.

## [0.19.20] - 2026-06-29

### Added

- **The Agent now has working memory.** As it investigates, it can record
  durable facts, findings, and open questions (`note_fact` / `record_finding` /
  `note_open_question`) into per-session memory, which is fed back into later
  turns. Previously its live discoveries evaporated once the message window
  rolled — only deterministic run artifacts persisted. Memory is sanitized
  (no secrets/raw rows) and audited like all agent output.
- **The Agent can enumerate large buckets.** `list_objects` now supports
  continuation tokens and recursive (delimiter-free) listing, so it can page
  through a bucket with more than 1000 objects instead of being capped at a
  single page. Each call is still bounded; paging is explicit, never automatic.

### Changed

- **The Agent now self-verifies high-severity conclusions.** Before asserting a
  security exposure, outage cause, or data-at-risk claim, it confirms it with a
  tool; if it can't, it presents the claim as a hypothesis with lowered
  confidence and records the gap rather than stating it as fact.

## [0.19.19] - 2026-06-29

### Fixed

- **"Key saved" no longer lies after the vault migration.** A provider's
  `has_api_key` / `has_access_key` / … flags were derived from the leftover
  reference in SQLite, so after the keychain→vault move (0.19.18) providers
  showed their keys as present even though the secret wasn't carried over — and
  the agent would then fail mid-run. The flags now reflect whether the secret
  actually exists in the vault, so a not-yet-re-entered key correctly shows as
  missing and prompts you to add it.

## [0.19.18] - 2026-06-29

### Changed

- **Secrets moved from the OS keychain to a cross-platform encrypted vault — no
  more repeated authorization prompts.** Because the app is ad-hoc-signed, the
  macOS Keychain re-prompted on every update (and the Linux Secret Service can
  prompt or be missing). Secrets now live in a single AES-256-GCM file whose
  master key is protected by the strongest *non-prompting* mechanism per OS
  (Windows DPAPI; an owner-only `0600` key file on macOS/Linux). The app no
  longer prompts to authorize key access on any platform. *One-time note: after
  updating, re-enter your model API key and cloud credentials once — they aren't
  migrated automatically (migrating would have triggered the very keychain
  prompt we're removing). They're never prompted for again.*
- **Settings polish.** The Providers section header no longer dwarfs the other
  settings sections (consistent type scale); all UI copy uses "Agent" rather
  than the Chinese "智能体".
- **Agent autonomy simplified to two options** — 协助 (Assisted: proposes
  read-only runs to confirm) and 自主 (Autonomous: runs read-only checks itself),
  defaulting to **Autonomous**. Data-moving work still always requires
  confirmation.

### Security

- Secrets are still never written to SQLite, logs, reports, traces, or model
  prompts, and cloud access remains read-only with no write/destructive
  capability. On macOS/Linux the vault's key file sits beside the data with
  owner-only perms (a deliberate local-first tradeoff for prompt-free operation;
  a future Developer-ID signature could re-enable the macOS keychain prompt-free).

## [0.19.17] - 2026-06-29

### Added

- **The agent can now act, not just advise (autonomy policy).** A new setting
  (Settings → Agent autonomy: advisory / assisted / autonomous read-only,
  default **assisted**) lets the in-chat agent EXECUTE read-only runs itself —
  diagnostics, bucket config review, account discovery — and fold the findings
  into its answer, instead of only proposing a form you then drive. The runs are
  real, audited, read-only, and appear in the timeline.
- **The analysis narrator can drill down.** Instead of being frozen to one
  pre-computed view, it can ask bounded follow-up aggregate questions over the
  already-local dataset (e.g. "which prefixes carry the 5xx?").

### Changed

- **Graded list sampling instead of a silent 100-key clamp.** A deliberate
  larger request is honored up to a bounded 1000 (matching the storage layer's
  own cap); only a full scan beyond that needs a confirmed run.

### Security

- **No weakening — the envelope is unchanged and enforced in code, below the
  autonomy setting.** Data-moving work (downloads, large scans, dataset
  analysis) and any mutating op always require confirmation; there is still no
  write/destructive capability anywhere. Drill-down runs only whitelisted
  GROUP BY / COUNT shapes with bound parameters (no free SQL, raw rows, or object
  bodies). The forbidden-tool guard now matches whole name tokens, so legitimate
  read-only tools aren't blocked by an incidental substring while real dangers
  still are.

## [0.19.16] - 2026-06-28

### Changed

- **Keychain access no longer floods you with prompts.** All secrets (model API
  key, cloud access/secret keys, session tokens) are now consolidated into a
  single OS Keychain item instead of one item per secret. macOS prompts **once**;
  picking "Always Allow" then covers every secret the app reads — removing the
  friction that made "secrets only in the Keychain" painful, with no change to
  the guarantee (secrets never leave the Keychain, never touch SQLite/logs/
  reports/model prompts). Secrets stored by older versions are migrated forward
  automatically on first read, so existing keys keep working. (The remaining
  one prompt per app version is inherent to ad-hoc signing.)
- **One model-client builder for every LLM path.** The conversational session
  agent, the agent-planner runs, and the analysis/error-triage narrators now all
  build their model client through a single `agent_service.build_agent` with a
  per-run client, eliminating a process-global SDK client that could race across
  concurrent runs.
- **Run events renamed to mode-neutral names** (`plan`, `summary`,
  `final_summary`, `run_started`, `tool_selected`) so deterministic runs no
  longer emit misleading `agent_*` event names.

### Removed

- Deleted the dead `RunsView` left over from the retired three-column UI.

> Note: versions 0.19.12–0.19.15 were never released — there are no entries for
> them and the history jumps from 0.19.16 straight back to 0.19.11.

## [0.19.11] - 2026-06-28

### Changed

- **Reverted the empty-state suggestions to a single row of chips.** A 2×3
  icon-card grid was tried and removed — the chips are cleaner and more
  consistent.

### Fixed

- Documentation: removed stale "first launch ~1 minute" wording (cold start is a
  few seconds since the one-dir sidecar) and brought the changelog and the
  GitHub Release notes up to date with accurate, per-version content.

## [0.19.10] - 2026-06-28

### Added

- **Session search.** A search box in the rail filters chats live by title
  (reveals matching archived chats; clearable; shows a "no matches" state).

### Changed

- **"New chat" restyled** to a quiet rail-consistent row with a `⌘N` shortcut
  hint, matching Codex/Cursor (replacing a bordered pill that clashed with the
  flat list).

## [0.19.9] - 2026-06-28

### Changed

- **License is now Apache-2.0** (added `LICENSE` + `NOTICE`).
- **Positioning broadened** from "diagnostics" to object storage **operations,
  analytics, and management** across README, app metadata, and the first-run
  wizard.
- **Chinese name → 云存储 Agent** (was "存储智能体").
- Minor UI polish: empty-state spacing and an icon-button settings-drawer close.

## [0.19.8] - 2026-06-28

### Fixed

- **Fewer macOS keychain prompts.** The sidecar now caches resolved secrets in
  process (invalidated on save/delete), so the keychain — and its authorization
  prompt — is hit at most once per secret per launch instead of on every agent
  run. Click **Always Allow** once to silence it for a build.

## [0.19.7] - 2026-06-28

### Fixed

- **Cold start cut from ~60s to a few seconds.** The Python sidecar is now built
  as a PyInstaller **one-dir** bundle shipped as a Tauri resource (instead of
  one-file + `externalBin`). One-file self-extracted its whole archive on every
  launch and macOS Gatekeeper re-scanned it each time; one-dir keeps libraries at
  a stable path scanned once. macOS sealing switched to a single deep ad-hoc sign
  (no hardened runtime).

### Changed

- Rewrote README and the `docs/` set for the current shipping state; removed
  stale phase-era docs.

## [0.19.6] - 2026-06-28

### Fixed

- **Session rename / pin / archive were unresponsive.** The sidecar CORS config
  rejected the `PATCH` preflight, so those requests never reached the backend;
  added `PATCH`/`OPTIONS` to the allowed methods.
- Replaced `window.prompt` (rename) and `window.confirm` (delete) — no-ops in the
  Tauri webview — with an inline rename field and an inline delete confirm.
- Removed a redundant brand-mark tile from the empty state.

## [0.19.5] - 2026-06-28

Session management + elegant next-step chips.

### Added

- **Session management.** Each chat in the rail now has a ⋯ menu: **rename**,
  **pin/unpin**, **duplicate (fork)**, **archive/unarchive**, and **delete**.
  Pinned chats sort into a "Pinned" group at the top; archived chats move to a
  collapsible "Archived" section. Fork copies a chat's full message thread into a
  new chat so you can branch a conversation. (New `pinned` column; new
  `DELETE /sessions/{id}` and `POST /sessions/{id}/fork` endpoints.)

### Changed

- **Suggested next steps are now compact chips** (ChatGPT/Cursor-style) instead
  of stacked full-width bordered cards — a subtle "Suggested next steps" label
  followed by small clickable pills. One click still hands the task to the agent
  in the conversation.

## [0.19.4] - 2026-06-28

Icon fix + Linux & Windows installers.

### Fixed

- **App icon showed a white border/card** in Launchpad/Finder. The icon PNG had
  been rasterized onto a white background instead of transparent corners, so
  macOS drew a white square behind the rounded mark. Re-rasterized with proper
  alpha (transparent corners) and regenerated all bundle icons.

### Added

- **Linux (x64 `.deb`) and Windows (x64 NSIS `-setup.exe`) release builds.** The
  release workflow now builds and publishes all three desktop platforms
  (macOS arm64 + Linux + Windows) to one GitHub Release, each with a stable
  asset name and a per-platform `SHA256SUMS-*.txt`. Linux/Windows builds are
  unsigned (Windows may trigger a SmartScreen "unknown publisher" prompt — use
  More info → Run anyway; Linux installs via `dpkg -i`).

### Notes

- Release jobs are decoupled (a `prepare` job creates the release; each platform
  uploads to it), and every platform stamps its bundle version from the tag via
  `scripts/stamp-version.py`. Windows/Linux are still pre-1.0 and unsigned; see
  docs/signing.md for the path to signed/notarized builds.

## [0.19.3] - 2026-06-28

New brand logo + agent-native next steps. Ad-hoc signed (not notarized), macOS arm64.

### Changed

- **New logo** — an object-storage bucket with an agent spark — across the app
  (session rail, empty-state hero) and all bundle icons (dock / Finder / About).
- **Next-step suggestions are now agent-native.** Clicking a suggested step used
  to walk you through "preview → prepare → a full New Run form" (planner mode,
  max-buckets, glob patterns, a prompt field) — the legacy Analysis-Run admin
  flow bolted onto the chat. Now a single click hands the task back to the agent
  in the conversation: it investigates live with its read-only tools and answers
  inline, no modal. Steps that genuinely need an external file (evidence imports)
  still open their purpose-built dialog; reports just render.

### Removed

- The New Run configuration modal from the suggestion handoff, and the redundant
  two-button "preview / prepare" step.

## [0.19.2] - 2026-06-28

Correct version display + documented signing path. Ad-hoc signed (not
notarized), macOS arm64.

### Fixed

- **The app reported version 0.1.0** (e.g. in the About box). The macOS bundle
  version comes from `tauri.conf.json`, not the release tag, and it was never
  updated. Bumped it, and the release workflow now stamps the bundle version
  from the release tag at build time, so the version is always correct.

### Added

- **`docs/signing.md`** — how macOS signing/notarization works here, what a
  comparable app (omni-macos) does (Developer ID + notarytool, $99/yr Apple
  Developer Program), the extra hardened-runtime entitlements our Python sidecar
  needs, and the exact steps + CI secrets to turn on notarized, prompt-free
  releases. Added `scripts/macos-entitlements.plist` scaffolding for that path.
- Clearer first-launch instructions in the release notes (the one-time
  `xattr -dr com.apple.quarantine` / right-click → Open step).

### Notes

- Frictionless (no Gatekeeper prompt) distribution still requires Apple
  notarization, which needs a paid Apple Developer ID — there is no free
  workaround. The pipeline is ready to notarize once those credentials are added
  as CI secrets; until then, builds remain ad-hoc signed with the documented
  one-time open step.

## [0.19.1] - 2026-06-28

Fixes a truncation bug in agent answers. Ad-hoc signed (not notarized), macOS arm64.

### Fixed

- **Long enumerations were silently cut to ~8 rows.** Asking the agent to list
  all buckets (or any long list) returned only the first ~500 characters — a
  96-row table came back as 8 rows, and the agent would even claim the result
  was "truncated by a length limit" or propose re-running the tool. Root cause:
  the chain-of-thought stripper applied to every answer ended with a hard
  `text[:500]` cap, so it — not the documented answer limit — was the binding
  constraint. The stripper now only removes reasoning markers and leaves length
  to the real caps; answer caps were also raised (12000 → 48000 chars) and an
  explicit generous model `max_tokens` is set. The instructions now explicitly
  require complete enumeration. Verified live: "list all my buckets" now returns
  all 96 rows. Regression tests added.

## [0.19.0] - 2026-06-28

First formal (non-prerelease) release of the 0.19.0 line. Adds full multi-language
support and a light theme. Ad-hoc signed (not notarized — Gatekeeper still
requires a right-click → Open on first launch), macOS arm64.

### Added

- **Multi-language UI (English + 简体中文).** A dependency-free i18n layer with a
  language switcher in Settings → Appearance. Language is auto-detected from the
  OS on first run and remembered per device. The whole product surface is
  localized — session rail, the thread (greeting, composer, suggestions, slash
  commands, tool/run/triage/proposal cards, errors), command palette, first-run
  wizard, and the full model/cloud provider settings — and the suggestion prompts
  themselves localize so a Chinese user sends Chinese.
- **Light theme.** A second theme alongside dark, switchable in Settings →
  Appearance and remembered per device (applied before first paint, no flash).
  All surfaces, the accent, and the neutral text ramp are driven by CSS variables
  so both themes stay consistent across every screen.

### Notes

- This is a formal release, but signing is unchanged from the pre-releases:
  **ad-hoc signed, not Apple-notarized.** First launch: right-click the app →
  Open (or allow it in System Settings → Privacy & Security), then it opens
  normally. The bundled sidecar is validated on first extraction, so first launch
  can take up to ~1 minute.
- A few deep, rarely-used flows (the new-run form, evidence-import dialog,
  account-profile panel, run transcript) are not yet localized; the i18n layer is
  in place to extend them.

## [0.19.0-pre.9] - 2026-06-28

A Codex/Cursor-grade start view and agent-driven next steps. Ad-hoc signed
(not notarized), pre-1.0, macOS arm64.

### Changed

- **New-chat view rebuilt as a centered, composer-forward "start" screen**
  (Codex/Cursor): the composer is the centerpiece — greeting above, suggestion
  chips below — instead of a greeting at the top with the composer pinned to the
  bottom over an empty void. In an active conversation the composer drops to the
  bottom and turns scroll above it.
- **Composer refined** to match the references: a model-picker pill (with
  chevron), `⏎ send · ⇧⏎ newline` hints, and a circular send button that fills
  with the accent only when there's text.

### Fixed

- **Next-step proposals are now agent-driven, not canned.** A generic
  "Run account discovery" chip used to reappear after *every* answer when the
  agent itself proposed nothing — even after a one-line definitional reply. The
  thread now shows the agent's own proposals once it has answered, and only
  falls back to the session's default next steps before the first turn.

## [0.19.0-pre.8] - 2026-06-28

Skills become real Agent Skills. Ad-hoc signed (not notarized), pre-1.0,
macOS arm64.

### Changed

- **Skills now follow the Agent Skills paradigm (progressive disclosure).** The
  agent's context carries a compact catalog (name + description for all 16
  StorageOps skills); it loads a skill's full method on demand via a new
  read-only `read_skill` tool — instead of a keyword matcher pre-stuffing full
  skill bodies into every prompt. The model chooses; context stays lean.
- **Removed the self-contradictory "tools/scripts disabled" skill wrapper.** It
  pre-dated the tool-using agent and told it not to do what it now does.
- **Rewrote all 16 SKILL.md bodies + the registry to be app-native.** They were
  written for a different runtime (helper scripts, `references/` files, foreign
  tools, a foreign output contract). Each now keeps its decision tree but maps
  its workflow to the agent's real read-only tools (`test_credentials`,
  `head_object`, `test_addressing_style`, `inspect_endpoint_tls`,
  `review_bucket_*`, …) and confirmed runs, and reports facts-vs-inference like
  the rest of the app.

### Fixed

- Frontmatter trimmed to `name` + `description`; dropped `recommended_tools`,
  `estimated_tokens`, and other foreign-runtime metadata. A guard test now fails
  the build if foreign-runtime artifacts reappear in the pack.

## [0.19.0-pre.7] - 2026-06-27

A more capable agent and a markdown-grade thread. Ad-hoc signed (not
notarized), pre-1.0, macOS arm64.

### Changed

- **The chat agent gets the full read-only diagnostic toolset.** It called
  itself a diagnostician but could only list/head/review; it can now also run
  `test_credentials` (auth/403 root cause), `head_object` (per-key
  metadata/404), `test_range_get` (range support/latency), `test_addressing_style`
  (virtual-hosted vs path-style — SignatureDoesNotMatch / endpoint), and
  `inspect_endpoint_tls` (TLS handshake/expiry), plus the
  `review_bucket_performance_profile` review that was missing from chat. It
  chains probes across up to 16 turns (was 8). Every tool stays read-only,
  scoped, bounded, audited, and secret-safe.
- **Markdown answers rendered to Codex/Cursor grade.** Horizontal rules now
  render as dividers (were literal `---`), plus blockquotes, links, italics,
  refined tables (uppercase headers, zebra rows) and heading rhythm. Tool-trace
  rows stay on one line with truncation so long bucket names don't wrap.

### Fixed

- Sending the first message in a new chat no longer flashes the empty state —
  the optimistic user turn + thinking/streaming bubble is preserved when the
  session is created mid-send. Next-step proposals are hidden while a turn is in
  flight.

## [0.19.0-pre.6] - 2026-06-27

Streaming agent answers. Ad-hoc signed (not notarized), pre-1.0, macOS arm64.

### Added

- **Streaming chat (SSE).** The agent's turn now streams live: read-only tool
  traces appear as they run and the answer types in token-by-token, with a
  caret while it writes (Codex/Cursor-style). New endpoint
  `POST /sessions/{id}/messages/stream`.
- **Automatic, lossless fallback.** Some OpenAI-compatible providers (notably
  DeepSeek) mishandle streaming when a turn makes tool calls and abort mid-stream;
  on any stream error the client transparently falls back to the blocking turn,
  so the answer is always correct. The stream endpoint persists nothing until it
  completes, so the fallback never duplicates the turn. Explanatory (no-tool)
  answers stream end-to-end on all providers.

### Fixed

- Parallel tool calls are disabled for streaming runs, which avoids a class of
  malformed follow-up messages with chat-completions providers.

## [0.19.0-pre.5] - 2026-06-27

The in-chat agent becomes a real agent. Ad-hoc signed (not notarized),
pre-1.0, macOS arm64.

### Changed

- **The chat agent now investigates live.** It was interpretation-only (no
  tools); it now uses read-only tools — `list_providers`, `list_buckets`,
  `head_bucket`, bounded `list_objects`, `get_bucket_config_summary`, and
  `review_bucket_*` — choosing the provider/bucket itself and answering from
  real results (e.g. "列出我的 bucket" lists them directly). All guardrails
  remain: no destructive/mutating operations exist, scans are bounded, every
  call is audited, credentials stay in the OS keychain and never reach the
  model, and anything that moves data or runs a large/analysis job stays a
  confirmed run.
- **Inline tool-call transparency** (Codex/Cursor-style): each answer shows the
  read-only tools it ran, e.g. `list_buckets · Baidu BOS → 96 buckets`,
  persisted with the message.
- One-pick cloud setup, ⌘K palette, slash commands, live "thinking" state, and
  richer markdown (carried from pre.4 line).

### Fixed

- Next-step proposals are actionable: `prepare` falls back to the configured
  provider (auto-binds the only one) and run proposals always open the run form.
- Stray green focus ring recolored to the indigo accent; composer double-ring
  removed; model chip refetches when the sidecar connects.
- Provider auth/404 failures no longer show "Add a model API key"; they show an
  actionable message with an Open settings action.

## [0.19.0-pre.4] - 2026-06-27

Restores agent mode in the packaged app and adds Codex/Cursor-style
interactions. Ad-hoc signed (not notarized), pre-1.0, macOS arm64.

### Fixed

- **Agent mode was broken in the packaged app** ("OpenAI Agents SDK is not
  available in this environment"). The PyInstaller spec listed `agents` /
  `openai` as bare hidden imports, which isn't enough — they import submodules
  at import time, so the one-file bundle failed to load them (dev worked because
  the venv had everything). The spec now collects `agents`, `openai`, and
  `griffe` in full. Verified on a freshly built bundle.
- Provider auth/404 failures no longer show "Add a model API key" (which implied
  none was configured). The needs-key prompt fires only on the real "no model
  provider configured" case; other failures show an actionable message with an
  Open settings action.

### Added

- **⌘K command palette** — quick-switch chats, New chat, Settings; type-to-filter
  with arrow/enter/esc. Global shortcuts ⌘K, ⌘N (new chat), Esc (close overlays).
- **Composer slash commands** — `/` opens a menu: `/diagnose`, `/logs`,
  `/inventory`, `/config`, `/account`, `/optimize` seed a prompt; `/report`
  generates the chat report.
- **Live "agent is working" state** — the user turn appears instantly and an
  animated indicator with rotating status replaces the send spinner until the
  reply lands.
- **Richer markdown** in agent replies — fenced code blocks with a language label
  and Copy button, headings, tables, lists; plus a hover Copy on agent messages.

## [0.19.0-pre.3] - 2026-06-27

UI/UX pass toward Codex/Cursor conventions, plus simpler cloud setup.
Ad-hoc signed (not notarized), pre-1.0, macOS arm64 primary target.

### Changed

- Dropped "investigation" terminology — it's "New chat" / "Recent" / chat now.
- Rail: flat brand mark, quiet New-chat row, recent list with a left accent bar
  on the active chat + relative time, compact status + settings footer.
- Thread: slim header with the chat title and a model badge (shows the configured
  provider model); a fresh chat shows just the canvas and composer.
- Messages: user turns are a subtle right-aligned bubble; agent turns are clean
  labeled prose (markdown). Runs are collapsible tool-call blocks, triage is a
  tool-style block, and next-step proposals are light action chips.
- Composer (Cursor-style): a rounded panel with a model chip and send row.
- **One-pick cloud-provider setup.** Choosing a provider (AWS S3, Alibaba OSS,
  Tencent COS, Baidu BOS, Volcengine TOS, Cloudflare R2, Backblaze B2, Google
  Cloud Storage, or Custom) fills in endpoint / addressing / signature; you enter
  region (or the R2 account id) plus access key + secret key. Endpoint override,
  addressing, signature, session token, mode, and bucket/prefix allowlists move to
  a collapsed Advanced section. Provider-panel copy is now English throughout.

### Notes

- After configuring read-only S3 credentials, the agent can enumerate the
  account's buckets and snapshot each bucket's configuration (account discovery),
  then review security / lifecycle / cost / performance per bucket — listing all
  buckets requires the `s3:ListAllMyBuckets` permission.

## [0.19.0-pre.2] - 2026-06-27

Second pre-release; supersedes the withdrawn v0.19.0-pre.1. Ad-hoc signed
(not notarized), pre-1.0, macOS arm64 primary target.

### Changed

- **Rebuilt the desktop UI into a thread-first agentic workbench (Codex/Cursor
  style).** A single conversation thread with a slim session rail and **one
  unified composer** — the agent routes intent; offline error triage is an
  automatic fallback, not a separate mode. Tool runs, triage cases, and
  next-action proposals render as inline cards; nothing runs without
  confirmation.
- Reframed the product around the agent's **full capability surface** — diagnose
  errors, analyze access logs, inventory & capacity, review bucket configuration,
  map the account, and find optimizations — rather than error triage alone. A
  capability-forward empty state seeds the composer.
- First-run wizard → inline settings drawer for model- and cloud-provider setup.
- Refined the visual language to a **near-monochrome dark palette** with a single
  restrained accent, flat marks, hairline borders, and markdown agent answers.
- Retired the previous tabbed admin-panel shell (Home / Sessions / Providers /
  Runs / Datasets / Reports nav, sidebar, context panel).

### Fixed

- **macOS bundle "app is damaged" / broken code-signature seal.** The build now
  ad-hoc seals the `.app` after bundling (`scripts/sign-macos-app-bundle.sh`),
  rebuilds the DMG from the sealed app, and gates on `codesign --verify --deep
  --strict`. Sealing intentionally does **not** enable the hardened runtime —
  under it the PyInstaller Python sidecar can't load its bundled framework and
  never starts.
- **Third-party OpenAI-compatible model providers (e.g. DeepSeek) now work.** The
  agent honors the provider `base_url` with the Chat Completions API; the SDK's
  trace upload to OpenAI is disabled.
- First-message next-action proposals were dropped on a new investigation.
- Removed stale "Phase 01 / bootstrap only" copy.

### Security

- Secrets stay in the OS keychain / keyring; never in SQLite, logs, reports, or
  model prompts.
- The agent no longer uploads traces or prompts to OpenAI's tracing backend.
- Read-only S3 by default; no destructive operations; bounded, sanitized agent
  context; chain-of-thought not persisted.

### Notes

- **v0.19.0-pre.1 was withdrawn** after product smoke: the UI was not yet a
  usable agent-first workbench and the macOS seal was broken. Both are fixed here.
- **First macOS launch is slow (up to ~1 min):** macOS validates the freshly
  ad-hoc-signed one-file sidecar on first extraction; later launches are fast. The
  window shows "Sidecar: Connecting" until ready.
- Notarization / Apple Developer ID signing remain out of scope for these
  pre-1.0 builds.

## [0.19.0-pre.1] - 2026-06-27 [WITHDRAWN]

Withdrawn after product smoke failed (see Unreleased → Notes). Unsigned, pre-1.0,
macOS arm64.

### Added

- Local-first desktop Storage Agent Workbench through Phase 19.
- Read-only S3-compatible diagnostics.
- Account discovery and bucket configuration review.
- Managed evidence import for inventory and access logs (plan → confirm → run).
- DuckDB-based inventory and access-log analysis.
- Session-centered investigation workspace.
- Safe next-action handoff (review → prepare → confirm).
- S3 / object-storage error triage assistant.
- Bundled StorageOps skills-only context injection.
- Markdown reports.

### Security

- Secrets stay in the OS keychain / keyring.
- No plaintext secrets in SQLite, logs, reports, or model prompts.
- No generic shell or arbitrary subprocess.
- No destructive S3 operations.
- No StorageOps tools/scripts imported or executed.
- No public skill API.
- Agent context is bounded and sanitized.
- Chain-of-thought is not persisted.

### Packaging

- macOS arm64 unsigned desktop build path.
- Linux x64 and Windows x64 experimental CI builds.
- Manual `workflow_dispatch` GitHub Release workflow added for pre-release
  publication (no signing, no notarization).

[Unreleased]: https://github.com/hxddh/storage-agent-workbench/compare/v0.23.0...HEAD
[0.23.0]: https://github.com/hxddh/storage-agent-workbench/compare/v0.22.1...v0.23.0
[0.22.1]: https://github.com/hxddh/storage-agent-workbench/compare/v0.22.0...v0.22.1
[0.22.0]: https://github.com/hxddh/storage-agent-workbench/compare/v0.21.1...v0.22.0
[0.21.1]: https://github.com/hxddh/storage-agent-workbench/compare/v0.21.0...v0.21.1
[0.21.0]: https://github.com/hxddh/storage-agent-workbench/compare/v0.20.11...v0.21.0
[0.20.11]: https://github.com/hxddh/storage-agent-workbench/compare/v0.20.10...v0.20.11
[0.20.10]: https://github.com/hxddh/storage-agent-workbench/compare/v0.20.9...v0.20.10
[0.20.9]: https://github.com/hxddh/storage-agent-workbench/compare/v0.20.8...v0.20.9
[0.20.8]: https://github.com/hxddh/storage-agent-workbench/compare/v0.20.7...v0.20.8
[0.20.7]: https://github.com/hxddh/storage-agent-workbench/compare/v0.20.6...v0.20.7
[0.20.6]: https://github.com/hxddh/storage-agent-workbench/compare/v0.20.5...v0.20.6
[0.20.5]: https://github.com/hxddh/storage-agent-workbench/compare/v0.20.4...v0.20.5
[0.20.4]: https://github.com/hxddh/storage-agent-workbench/compare/v0.20.3...v0.20.4
[0.20.3]: https://github.com/hxddh/storage-agent-workbench/compare/v0.20.2...v0.20.3
[0.20.2]: https://github.com/hxddh/storage-agent-workbench/compare/v0.20.1...v0.20.2
[0.20.1]: https://github.com/hxddh/storage-agent-workbench/compare/v0.20.0...v0.20.1
[0.20.0]: https://github.com/hxddh/storage-agent-workbench/compare/v0.19.29...v0.20.0
[0.19.29]: https://github.com/hxddh/storage-agent-workbench/compare/v0.19.28...v0.19.29
[0.19.28]: https://github.com/hxddh/storage-agent-workbench/compare/v0.19.27...v0.19.28
[0.19.27]: https://github.com/hxddh/storage-agent-workbench/compare/v0.19.26...v0.19.27
[0.19.26]: https://github.com/hxddh/storage-agent-workbench/compare/v0.19.25...v0.19.26
[0.19.25]: https://github.com/hxddh/storage-agent-workbench/compare/v0.19.24...v0.19.25
[0.19.24]: https://github.com/hxddh/storage-agent-workbench/compare/v0.19.23...v0.19.24
[0.19.23]: https://github.com/hxddh/storage-agent-workbench/compare/v0.19.22...v0.19.23
[0.19.22]: https://github.com/hxddh/storage-agent-workbench/compare/v0.19.21...v0.19.22
[0.19.21]: https://github.com/hxddh/storage-agent-workbench/compare/v0.19.20...v0.19.21
[0.19.20]: https://github.com/hxddh/storage-agent-workbench/compare/v0.19.19...v0.19.20
[0.19.19]: https://github.com/hxddh/storage-agent-workbench/compare/v0.19.18...v0.19.19
[0.19.18]: https://github.com/hxddh/storage-agent-workbench/compare/v0.19.17...v0.19.18
[0.19.17]: https://github.com/hxddh/storage-agent-workbench/compare/v0.19.16...v0.19.17
[0.19.16]: https://github.com/hxddh/storage-agent-workbench/compare/v0.19.11...v0.19.16
[0.19.11]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.11
[0.19.10]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.10
[0.19.9]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.9
[0.19.8]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.8
[0.19.7]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.7
[0.19.6]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.6
[0.19.5]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.5
[0.19.4]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.4
[0.19.3]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.3
[0.19.2]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.2
[0.19.1]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.1
[0.19.0]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0
[0.19.0-pre.9]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.9
[0.19.0-pre.8]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.8
[0.19.0-pre.7]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.7
[0.19.0-pre.6]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.6
[0.19.0-pre.5]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.5
[0.19.0-pre.4]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.4
[0.19.0-pre.3]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.3
[0.19.0-pre.2]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.2
[0.19.0-pre.1]: https://github.com/hxddh/storage-agent-workbench/releases/tag/v0.19.0-pre.1
