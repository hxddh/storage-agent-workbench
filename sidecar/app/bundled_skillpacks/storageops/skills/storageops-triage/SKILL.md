---
name: storageops-triage
description: >
  First-contact triage for any object storage issue. Classifies by domain
  (permission, performance, protocol, network, cost, mount, CLI/SDK, bigdata,
  consistency, notification, replication, migration), assesses severity and
  evidence completeness, routes to specialist Skills. Use when user reports an
  S3/storage error without a clear diagnostic category.
maturity: core
mode: light_heavy
estimated_tokens: 1400
trigger_keywords:
  - object storage
  - S3 error
  - storage issue
  - storage problem
  - bucket issue
  - BOS
  - OSS
  - COS
  - GCS
recommended_tools:
  - scan_secrets
  - detect_domain
  - search_memory
---

# Triage — First-Contact Classification

Classify the problem domain, assess severity, check evidence completeness, and route to the correct specialist Skill. Do NOT attempt deep diagnosis here — that is for the specialist skill.

## Decision Tree

```
User reports storage issue →
  ├─ Has error message/status code? → Classify by error signature
  │   ├─ 403 AccessDenied / 401 Unauthorized → storageops-security-iam-policy
  │   ├─ 429 SlowDown / 503 SlowDown → storageops-performance-diagnosis
  │   ├─ 400 Bad Request / SignatureDoesNotMatch / InvalidArgument → storageops-s3-protocol-compatibility
  │   ├─ Connection refused / timeout / DNS → storageops-network-endpoint-access
  │   ├─ SDK exception (Python/Java/Go) → storageops-cli-sdk-diagnosis
  │   ├─ Spark/Hive/Flink error → storageops-bigdata-pipeline
  │   ├─ Event missing / Lambda not triggered → storageops-event-notification
  │   ├─ Replication lag / version missing → storageops-replication-versioning
  │   └─ Unclear → continue triage
  ├─ Has performance complaint (slow, not error)? → storageops-performance-diagnosis
  ├─ Has cost complaint? → storageops-lifecycle-cost
  ├─ Has mount complaint? → storageops-mount-filesystem-workspace
  ├─ Has consistency complaint (stale read, missing object)? → storageops-data-consistency
  ├─ Has migration question? → storageops-migration-sync
  ├─ Has access logs / log analysis question? → storageops-access-log-analysis
  └─ No evidence at all → Ask clarifying questions, do NOT guess domain
```

## Workflow

### Step 1: Extract Error Signature
From the user's input, extract: error code (HTTP status), error message, tool name and version, and whether the issue is persistent or intermittent.

### Step 2: Classify by Domain
Match against the decision tree above. If multiple domains match, note all with confidence ranking. The `detect_domain` tool can help classify by error signature patterns.

`detect_domain` also reports a best-effort `provider` (aws/bos/oss/cos/gcs/azure/obs/minio) detected from the endpoint, vendor headers, or CLI — even when the user never names it. When it reports a non-AWS provider, carry that into routing and tell the specialist to apply that provider's quirks (e.g. `provider_quirks_ref`); object-storage misdiagnosis most often comes from applying AWS assumptions to a non-AWS provider. Treat the detected provider as a hint to verify (endpoints can be proxied/CNAME'd), not a fact.

### Step 3: Evidence Completeness Check
Assess what evidence is present and what's missing for the target specialist skill. Run `python3 scripts/evidence_completeness_checker.py --domain <domain> --stdin` (piping the user's text) to get a deterministic present/missing list and a readiness score against `references/required-evidence.md`, then act on its verdict:
- **ready** (≥0.8): route immediately
- **partial** (0.5–0.8): route but ask for the specific missing items it lists
- **insufficient** (<0.5): ask the missing items / clarifying questions from `references/triage-questions.md` before routing

### Step 4: Severity Assessment
| Severity | Criteria |
|----------|----------|
| critical | Production data loss, security breach, complete outage |
| high | Significant performance degradation, partial outage |
| medium | Isolated errors, workaround available |
| low | Cosmetic, informational, planning question |

### Step 5: Route
Output the recommended specialist skill(s) and what evidence to gather before invoking it.

### Step 6: Feedback Loop
If the routed specialist skill fails to diagnose, the user may return with enhanced evidence. Re-run triage with the new evidence set — the decision tree may now match a different domain. If evidence is still insufficient after 2 rounds, escalate with: *"This issue requires deeper investigation. Can you provide: (1) full error log with timestamps, (2) exact tool + version, (3) approximate timeline of when the issue started?"*

## User Interaction

### Ask the user (in this order):
1. **Error message first** — *"What exact error message or status code are you seeing?"*
2. **Then tool** — *"What tool and version are you using (rclone, aws s3, s5cmd, SDK)?"*
3. **Then timeline** — *"When did this start? Is it persistent or intermittent?"*

### Inform the user:
- Before routing: *"This looks like a [domain] issue. I'm routing you to the specialist skill for deep diagnosis."*
- If evidence insufficient: *"I need more information before I can route this correctly. Here's what would help…"*
- After 2 rounds: *"We may need to escalate this. Would you like me to suggest next steps for manual investigation?"*

## Output Contract — include these fields

```markdown
# Triage: [one-line classification]
**Domain**: [primary domain] (confidence: high/medium/low)
**Severity**: critical | high | medium | low
**Evidence**: sufficient | partial | insufficient

## Key Observations
- [error code + tool + pattern]
- [what's known, what's missing]

## Routing
1. → **storageops-[domain]** — [rationale]
2. → **storageops-[domain]** — [if applicable, secondary]

## Evidence Gaps
- [ ] [missing item] — ask user for [specific request]

## Re-triage Check
After Step 6: if re-triaging, note what changed — new evidence? new symptom? different domain match?
```

## Examples

### Example 1: Clear error → direct route
**Input**: "s5cmd sync fails with `ERROR: SlowDown: Please reduce your request rate. status code: 429`"
**Diagnosis**: 429 throttling — performance domain  
**Route**: → **storageops-performance-diagnosis** (high confidence)  
**Evidence**: sufficient — has error code, tool (s5cmd), command (sync)

### Example 2: Ambiguous → triage needed
**Input**: "My S3 bucket is not working"
**Diagnosis**: No error signature — cannot classify  
**Route**: Ask: "What specific error do you see? What tool are you using? What command did you run?"

### Example 3: Multi-symptom → multi-route
**Input**: "rclone copy to BOS, getting 403 on some files, also very slow (2 MB/s on 1 Gbps link)"
**Diagnosis**: Multiple domains — permission + performance  
**Route**: 1→**storageops-security-iam-policy** (403 errors), 2→**storageops-performance-diagnosis** (slow)

## References
- `references/triage-questions.md` — Clarifying questions for each domain | **Read when:** user description is vague or missing key details (no error code / no tool name)
- `references/domain-signatures.md` — Error code → domain mapping | **Read when:** user provides an HTTP status code or error code string
- `references/severity-rubric.md` — Detailed severity criteria | **Read when:** classifying severity, especially if data loss or outage is mentioned
- `references/confidence-rubric.md` — How to compute confidence from evidence | **Read when:** multiple domains match with similar likelihood
- `references/provider-domains.md` — Provider-specific domain lookup (BOS/OSS/COS endpoints) | **Read when:** user mentions a specific provider (BOS/OSS/COS/GCS) or uses a provider-specific error format
- `references/diagnostic-decision-tree.md` — The top-level symptom→domain decision tree | **Read when:** the symptom is ambiguous and you need to walk from observation to candidate domain
- `references/error-code-encyclopedia.md` — S3 error codes grouped by class with their usual domain | **Read when:** the user provides an error code and you need its meaning and likely routing
- `references/issue-taxonomy.md` — Canonical category/subcategory taxonomy for issues | **Read when:** assigning a primary category or reconciling overlapping signals
- `references/required-evidence.md` — Minimum evidence each domain needs before a confident diagnosis | **Read when:** deciding whether enough evidence exists to route or to ask for more
- `scripts/evidence_completeness_checker.py` — Deterministic present/missing + readiness score for a domain's required evidence; run `python3 scripts/evidence_completeness_checker.py --domain <domain> --stdin` | **Run when:** deciding in Step 3 whether to route now or ask for more evidence
