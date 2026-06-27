---
name: storageops-lifecycle-cost
description: >
  Analyze object storage lifecycle policies and costs. Covers storage class
  transitions (STANDARD→IA→ARCHIVE→DEEP_ARCHIVE), lifecycle rule evaluation,
  cost amplification from small files, minimum storage duration charges,
  retrieval fees, and intelligent tiering. Use when user asks about storage
  costs, lifecycle configuration, or tiering strategy.
maturity: mature
mode: light_heavy
estimated_tokens: 1400
trigger_keywords:
  - storage cost
  - lifecycle policy
  - storage class
  - STANDARD_IA
  - ARCHIVE
  - tiering
  - retrieval cost
  - minimum storage duration
  - cost optimization
  - intelligent tiering
recommended_tools:
  - scan_secrets
  - detect_domain
  - search_memory
---

# Lifecycle & Cost Analysis

Diagnose why storage costs are higher than expected, and recommend lifecycle strategies. Most cost surprises come from: minimum storage duration penalties, small-file overhead (each file = 1 billable object), and retrieval fees on archived data. Treat class thresholds, minimum durations, and prices as provider-specific assumptions until confirmed.

> **Scope boundary:** this skill owns lifecycle/storage-class structural cost (transitions, minimum durations, minimum billable size, multipart waste). The small-file *throughput* penalty (slow PUT/GET, 429/SlowDown) belongs to `storageops-performance-diagnosis`. Request-level cost attribution derived from access logs (per-prefix LIST/GET counts) belongs to `storageops-access-log-analysis`. Route here when the concern is billed storage, tiering, or lifecycle rules — not transfer speed or log-derived request volume.

## Decision Tree

```
Cost concern →
  ├─ "Why is my storage bill so high?" →
  │   ├─ Many small files? → Minimum billable size may amplify storage
  │   ├─ Objects in wrong tier? → IA objects accessed frequently → retrieval costs
  │   ├─ Previous versions accumulating? → Versioning costs (each version = separate billable object)
  │   └─ Incomplete multipart uploads? → Orphaned parts still billable
  ├─ "What lifecycle rules should I set?" →
  │   ├─ Know access pattern? → Match transition timing to provider minimum-duration rules
  │   └─ Unknown access pattern? → Intelligent Tiering (auto-moves based on access)
  ├─ "Should I use IA or Intelligent Tiering?" →
  │   ├─ Predictable access pattern? → Manual lifecycle (cheaper)
  │   └─ Unpredictable access? → Intelligent Tiering (monitoring fee < retrieval mistakes)
  └─ No cost data at all? → Request: bucket inventory, total objects, size distribution, storage class breakdown
```

## Workflow

### Step 1: Inventory the Storage
Identify: total object count, total size, size distribution (P10/P50/P90), storage class per object, versioning status (each version = separate object). See `references/inventory-cost-analysis.md`.

### Step 2: Calculate Current Cost
Breakdown: storage cost (GB-month per class), request cost (PUT/GET/LIST), retrieval cost (IA/ARCHIVE), minimum duration penalties. See `references/pricing-assumptions.md`, `references/storage-class.md`, and `references/request-cost.md` before quoting any concrete price.

### Step 3: Identify Cost Amplification
- **Small files** under minimum billable size: objects may round up to a provider-specific billing floor.
- **Premature transitions**: IA/archive classes often have minimum-duration rules. Transitioning earlier can create penalty charges.
- **Retrieval costs**: ARCHIVE retrieval is expensive (per-GB + per-request). Bulk retrieval is cheapest.
- **Versioning**: Each version = full object cost. Noncurrent versions in IA still billable.
- **Incomplete multipart**: Orphaned parts billed at STANDARD rate until deleted.

When a lifecycle configuration is available, run the simulator to surface these structurally (no money): `python3 scripts/lifecycle_rule_simulator.py --file <lifecycle.json> --object-age-days <d> --avg-object-size <s>`. It reports applicable transitions/expirations, `min_duration_risks` (wasted DAYS), `size_penalty` (amplification MULTIPLIER vs minimum billable BYTES), missing `AbortIncompleteMultipartUpload`, and rule conflicts.

### Step 4: Recommend Lifecycle Strategy
- **Hot data**: STANDARD
- **Warm data**: IA or Intelligent Tiering, after confirming access pattern and minimum duration
- **Cold data**: ARCHIVE or provider equivalent, after confirming retrieval risk
- **Frozen data**: DEEP_ARCHIVE or provider equivalent, when retrieval latency is acceptable
- Add rule to delete incomplete multipart uploads after 7 days

### Step 5: Estimate Savings
Monthly savings = current cost − projected cost after lifecycle. Include minimum duration risk in calculation.

### Step 6: Feedback Loop
Run `python3 scripts/small_object_analyzer.py --file <inventory.csv>` to quantify the small-object penalty with precision. Confirm the provider's current minimum billable sizes before turning object counts into money. If the savings estimate has more than 30% uncertainty after analysis, go back to Step 1 and ask the user: *"Can you provide actual billing data (per-bucket per-class cost breakdown) so I can calibrate the estimate?"*

## User Interaction

### When to ask the user
- *"How many objects are in the bucket, and what is the approximate size distribution (P10 / P50 / P90)?"*
- *"Do you have an S3 Inventory report or a CSV with key, size, and storage class?"*
- *"Is versioning enabled? How many noncurrent versions exist?"*
- *"Can you share the lifecycle XML configuration currently applied to this bucket?"*

### When to inform the user
- Before recommending a lifecycle change: *"This rule will apply to ALL objects matching the prefix. Noncurrent versions will also be affected if versioning is on."*
- After cost projection: *"These are estimates based on storage class pricing only. Request costs (PUT/GET/LIST) and data transfer are NOT included unless you provide access logs."*

## Output Contract — include these fields

```markdown
## Summary
[one-line diagnosis]
**Route**: storageops-lifecycle-cost
**Confidence**: high | medium | low (depends on inventory completeness)
**Evidence Quality**: sufficient | partial | insufficient
**Primary Diagnosis**: root_cause_type=[min-billable-size|premature-transition|orphaned-multipart|noncurrent-bloat|rule-conflict], affected_layer=[lifecycle|storage_class|request|multipart]

## Key Evidence
- Objects: [count], total: [size]; storage-class distribution: [breakdown]
- Versioning: [enabled/disabled], noncurrent: [count]
- Amplification found: **[issue]** — [structural factor, e.g. Nx min-billable-size penalty / wasted days], expressed in days/bytes/multipliers (never money)

## Remediation
1. Rule: [transition STANDARD→IA after X days]
2. Rule: [transition IA→ARCHIVE after Y days]
3. Rule: [delete incomplete multipart after 7 days]
4. ...

## What Would Falsify This
- [inventory/age/size evidence that would overturn the amplification finding]

## Risks / Open Questions
- [incomplete inventory, provider-specific min-billable/min-duration differences, versioning blast radius]
```

## Examples

### Example 1: Small files in IA destroying savings
**Input**: 10M objects × 1KB in STANDARD_IA. Bill = much higher than expected.
**Diagnosis**: The IA class may have a provider-specific minimum billable object size. Tiny objects can be billed as much larger objects, creating large amplification.
**Recommendation**: Archive small files into larger objects (tar/gz), or switch to STANDARD if frequently accessed.

### Example 2: Premature ARCHIVE transition
**Input**: Lifecycle rule moves objects to ARCHIVE after 30 days. Retrieval costs are 3× storage savings.
**Diagnosis**: The archive class may have a longer minimum-duration rule than the transition age. Early retrieval or deletion can erase storage savings.
**Recommendation**: Align transitions with provider minimum-duration rules. Prefer bulk retrieval for archived objects when latency permits.

### Example 3: Orphaned multipart parts
**Input**: Bill shows 500GB of storage but only 200GB of visible objects.
**Diagnosis**: 300GB of incomplete multipart upload parts, billed at STANDARD rate indefinitely.
**Recommendation**: Add lifecycle rule: `AbortIncompleteMultipartUpload` after 7 days. Immediate savings: 300GB/month.

## What Would Falsify This
- The simulator reports `size_penalty` null or a multiplier under ~10% — small files are not the cost driver; look at total volume, versioning, or retrieval instead.
- Billed storage equals the sum of actual object sizes with no minimum-duration `wasted_days` — there is no lifecycle structural penalty; the cost is simply real data growth.
- Objects transitioned long ago and never deleted/re-transitioned before the minimum duration — premature-transition penalty does not apply.

## Risks / Open Questions
- Provider-specific minimum durations and minimum billable sizes differ from the dated AWS defaults encoded here (e.g. OSS/BOS/COS); confirm before quoting `wasted_days` or multipliers.
- IA/archive retrieval charges can exceed the storage savings from transitioning — confirm access frequency before recommending a tier change.
- Intelligent-Tiering monitoring/automation overhead may outweigh savings for small or predictable workloads.

## References
- `references/pricing-assumptions.md` — Dated assumptions for minimum durations, billable sizes, and price quoting | **Read when:** user asks for concrete savings, prices, or lifecycle timing recommendations
- `references/storage-class.md` — Per-class cost model (STANDARD, IA, ARCHIVE, DEEP_ARCHIVE) and provider equivalents | **Read when:** user needs to compare storage class costs for a specific provider, or asks "what does IA cost vs STANDARD?"
- `references/lifecycle.md` — Lifecycle rule schema, transition constraints | **Read when:** user provides a lifecycle XML configuration to parse, or asks "what lifecycle options do I have?"
- `references/inventory-cost-analysis.md` — How to get object inventory for cost analysis | **Read when:** user doesn't have an inventory report but needs cost analysis — this explains how to generate one
- `references/request-cost.md` — Per-request (PUT/GET/LIST/HEAD) cost model and per-provider differences (BOS/OSS/COS/AWS) | **Read when:** user's cost concern is API request charges (e.g., high-frequency LIST) or multi-cloud request-cost comparison
- `references/intelligent-tiering.md` — Intelligent-Tiering monitoring overhead and break-even reasoning | **Read when:** user weighs Intelligent-Tiering against a static class for an unpredictable access pattern
- `scripts/small_object_analyzer.py` — Deterministic per-object minimum-billable-size penalty from a CSV inventory | **Run when:** an inventory CSV is available and you need to quantify small-object amplification
- `scripts/lifecycle_rule_simulator.py` — Deterministic lifecycle simulator for minimum-duration, size, multipart, and rule-conflict risks | **Run when:** a lifecycle configuration is available and you need structural cost risks before recommending changes
