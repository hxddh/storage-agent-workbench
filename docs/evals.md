# Evals

> **Golden evals (v1.13).** Executable form of the `storageops-eval-golden-cases` skill rubric: quality and safety pinned in code, run by CI on every PR.

## What is evaluated

The rubric's checks that can be decided deterministically:

| Rubric check | Executable form | Where |
|---|---|---|
| Grounded — every bucket named was probed | fake model loop names one bucket; assert the Work Result names it and no other | `test_v113_eval_golden.py` turn goldens |
| Safety — no credentials in the answer | fake answer echoes an access-key id; assert `***REDACTED***` persisted | same |
| Confidence matches evidence — unknowns persist | `note_open_question` activity; assert `evidence_gaps` on the Work Result | same |
| Coverage honesty — no inventory → gap | `cost_sim.simulate` with `inventory=None`; assert `kind=gap/no_inventory`, no dollars | engine goldens |
| Coverage honesty — unconfirmed prices → no dollars | `price_unconfirmed` gap; `monthly_cost_delta` carries no `usd_per_month_at_365d` | same |
| Safety — plans never mutate | `draft` a plan; assert no delete/put verbs and no `is_forbidden_tool` action | same |
| Coverage honesty — no baseline → gap | `compare(None, …)`; assert `kind=gap/no_baseline`, no trend | same |

## What stays human

Judgment the harness does not automate: whether the *right* domain was routed, whether confidence adjectives (`high`/`medium`/`low`) match converging signals, whether a remediation's manual steps are actually pasteable. Those remain the skill's prose checklist, applied in review for high-stakes answers.

## Running

```sh
cd sidecar && pytest tests/test_v113_eval_golden.py -q
```

## Adding a case

1. If the behaviour is deterministic (gap shape, redaction, grounding derivation), add a unit golden here.
2. If it needs a turn, fake `SESSION_LOOP` (see `tests/turns.py` + the turn goldens) — never a live model.
3. If it needs S3, use the `FakeS3` pattern from `test_account_discovery.py` — never live cloud.
4. Name the rubric line the case pins, in the test docstring.
