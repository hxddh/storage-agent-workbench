import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(process.cwd(), "..");
const readRepo = (path: string) => readFileSync(join(repoRoot, path), "utf8");

const normativeDocs = [
  "README.md",
  "CLAUDE.md",
  "docs/README.md",
  "docs/product.md",
  "docs/architecture.md",
  "docs/roadmap.md",
];

// These documents directly define or accept/reject product behavior. Architecture
// and history docs are allowed to NAME a removed component when explicitly
// documenting that it is gone; product-contract docs must not present those
// concepts as current behavior.
const productContractDocs = [
  "README.md",
  "CLAUDE.md",
  "docs/product.md",
  "docs/roadmap.md",
  "docs/release-smoke-test.md",
];

const removedArchitecture: Array<[string, RegExp]> = [
  ["thread-first product model", /\bthread-first\b/i],
  ["SessionRail product boundary", /\bSessionRail\b/],
  ["Workbench shell product boundary", /\bWorkbenchShell\b/],
  ["v0.92 SurfaceTabs boundary", /\bSurfaceTabs\b/],
  ["v0.92 SteeringSurface boundary", /\bSteeringSurface\b/],
  ["InvestigationNavigation boundary", /\bInvestigationNavigation\b/],
  ["inline run-card product model", /\binline run card\b/i],
  ["new-investigation product action", /\bNew investigation\b/i],
];

describe("v1.17 documentation contract", () => {
  it("anchors normative documentation to the current Agent Task architecture", () => {
    for (const path of normativeDocs) {
      const text = readRepo(path);
      expect(text, `${path} must name Agent Task`).toMatch(/Agent Task/);
    }
    expect(readRepo("docs/README.md")).toContain("v1.16.0");
    expect(readRepo("docs/README.md")).toContain("v1.16.1");
    expect(readRepo("docs/README.md")).toContain("v1.17.0");
    expect(readRepo("docs/README.md")).toContain("v1.17.1");
    expect(readRepo("docs/README.md")).toContain("v1.17.2");
    expect(readRepo("docs/README.md")).toContain("v1.17.3");
    expect(readRepo("CLAUDE.md")).toContain("v1.16.0");
    expect(readRepo("CLAUDE.md")).toContain("v1.17.0");
    expect(readRepo("CLAUDE.md")).toContain("v1.17.1");
    expect(readRepo("CLAUDE.md")).toContain("v1.17.2");
    expect(readRepo("CLAUDE.md")).toContain("v1.17.3");
    expect(readRepo("docs/product.md")).toContain("Design rules");
    expect(readRepo("docs/product.md")).toContain("v1.17.0");
    expect(readRepo("docs/product.md")).toContain("v1.17.1");
    expect(readRepo("docs/product.md")).toContain("v1.17.2");
    expect(readRepo("docs/product.md")).toContain("v1.17.3");
    expect(readRepo("docs/architecture.md")).toMatch(/Current architecture baseline: Storage Agent v1\.17\.3/);
    expect(readRepo("docs/architecture.md")).toContain("Migration head **030**");
    expect(readRepo("docs/architecture.md")).not.toMatch(/Current architecture baseline: Storage Agent v1\.10\.0/);
    expect(readRepo("docs/architecture.md")).not.toMatch(/Migration head \*\*028\*\*/);
    expect(readRepo("docs/design-tokens.md")).toContain("--duration-fast");
    expect(readRepo("docs/design-tokens.md")).toContain("prefers-reduced-motion");
    expect(readRepo("docs/design-tokens.md")).toContain("--viz-1");
  });

  it("does not present retired Task IA as current in product-contract docs", () => {
    const retired: Array<[string, RegExp]> = [
      ["Approve/Decline as current buttons", /\bApprove\s*\/\s*Decline\b/],
      ["Review as a sheet", /Review is a \*\*sheet\*\*/],
      ["tinted Direction block", /quiet tinted block/],
      ["artifact chip row as current", /artifact chips \(Evidence/],
    ];
    for (const [label, pattern] of retired) {
      const offenders = productContractDocs.filter((path) => pattern.test(readRepo(path)));
      expect(offenders, `${label}: ${offenders.join(", ")}`).toEqual([]);
    }
  });

  for (const [label, pattern] of removedArchitecture) {
    it(`does not reintroduce ${label} in product-contract docs`, () => {
      const offenders = productContractDocs.filter((path) => pattern.test(readRepo(path)));
      expect(offenders, `${label}: ${offenders.join(", ")}`).toEqual([]);
    });
  }

  it("pins high-risk current docs to shipped runtime facts", () => {
    const api = readRepo("docs/api.md");
    const dataModel = readRepo("docs/data-model.md");
    const security = readRepo("docs/security.md");
    const smoke = readRepo("docs/release-smoke-test.md");

    expect(api).toContain("GET /agent-tasks");
    expect(api).toContain("/agent-tasks/{task_id}/provenance");
    expect(api).toContain("POST /agent-tasks/{task_id}/executions");
    expect(api).toContain("POST /agent-tasks/{task_id}/steer");
    expect(api).toContain("/decisions/{decision_id}/resolve");
    expect(api).toContain("queued_executions");
    expect(api).toContain("execution.events_truncated");
    expect(api).toContain("POST /agent-tasks/{task_id}/verify");
    expect(api).toContain("/remediation-plans");
    expect(api).toContain("/settings/price-table");
    expect(api).toMatch(/product-level.*Agent Task/i);
    expect(dataModel).toMatch(/Current migration head:\s*030/i);
    expect(dataModel).toContain("native_agent_titles_effort");
    expect(dataModel).toContain("native_agent_turn_items_approvals");
    expect(dataModel).toContain("turn_items");
    expect(api).toContain("message.completed");
    expect(api).toContain("approval.opened");
    expect(readRepo("docs/tools.md")).toContain("import_evidence");
    expect(readRepo("docs/product.md")).toContain("Waiting for approval");
    expect(api).toContain("reasoning_effort");
    expect(api).toContain("title_source");
    expect(readRepo("docs/architecture.md")).toContain("menu-command");
    expect(readRepo("docs/product.md")).toContain("Runtime task titles");
    expect(dataModel).toContain("task_executions");
    expect(dataModel).toContain("execution_events");
    expect(dataModel).toContain("task_decisions");
    expect(dataModel).toContain("task_context_versions");
    expect(dataModel).toContain("remediation_plans");
    expect(dataModel).toContain("task_baselines");
    expect(dataModel).toContain("task_revisit_schedules");
    expect(dataModel).toContain("storage_price_table");
    expect(dataModel).toContain("Product-to-persistence mapping");
    expect(dataModel).toContain("execution.events_truncated");
    expect(security).toContain("approval");
    expect(security).not.toContain("Decision required");
    expect(security).toContain("STORAGE_AGENT_AUTH_TOKEN");
    expect(security).toContain("price table");
    expect(smoke).toContain("Agent Task product smoke");
    expect(smoke).toContain("one primary Agent composer");
    expect(smoke).toContain("Resume");
    expect(smoke).not.toMatch(/A Task with a Remediation Plan exposes \*\*Verify\*\*/);
    expect(smoke).toContain("Settings contains model");
    expect(readRepo("docs/product.md")).toContain("Queued Direction");
    expect(readRepo("docs/product.md")).toContain("Remediation Plan");
    expect(readRepo("docs/product.md")).not.toContain("Composer `/` slash commands");
    expect(readRepo("docs/product.md")).not.toContain("Composer-native 60-second");
    expect(readRepo("docs/product.md")).not.toContain("Focus mode");
    expect(readRepo("docs/product.md")).not.toContain("live execution strip");
    expect(readRepo("docs/product.md")).not.toContain("Needs-you");
    expect(readRepo("docs/product.md")).not.toContain("command center");
    expect(readRepo("docs/product.md")).not.toContain("command-center");
    expect(readRepo("docs/product.md")).not.toContain("product card");
    expect(readRepo("docs/product.md")).not.toContain("New chat");
    expect(readRepo("CLAUDE.md")).not.toContain("Focus mode");
    expect(readRepo("CLAUDE.md")).not.toContain("command center");
    expect(readRepo("docs/architecture.md")).toContain("after=<last seq>");
    expect(readRepo("docs/architecture.md")).toContain("agent-artifacts-panel");
    expect(readRepo("docs/tools.md")).toContain("simulate_storage_cost");
    expect(readRepo("docs/roadmap.md")).not.toMatch(/Add ORC support/);
    expect(readRepo("docs/roadmap.md")).toContain("v1.17.0");
    expect(readRepo("docs/roadmap.md")).toContain("v1.17.1");
    expect(readRepo("docs/roadmap.md")).toContain("v1.17.2");
    expect(readRepo("docs/roadmap.md")).toContain("v1.17.3");
    expect(readRepo("docs/roadmap.md")).toContain("Codex window");
    expect(readRepo("docs/releases/1.13.0.md")).toContain("Honesty and completeness");
    expect(readRepo("docs/releases/1.14.0.md")).toContain("Interaction truth and content craft");
    expect(readRepo("docs/releases/1.15.0.md")).toContain("True Native Agent");
    expect(readRepo("docs/releases/1.16.0.md")).toContain("finished");
    expect(readRepo("docs/api.md")).toContain("events-page");
    expect(readRepo("docs/api.md")).toContain("traceparent");
    expect(readRepo("docs/api.md")).toContain("unknown");
    expect(readRepo("docs/security.md")).toContain("MCP-client threat model");
    expect(readRepo("docs/tools.md")).toContain("Bounds are not gates");
    expect(readRepo("docs/evals.md")).toContain("test_v113_eval_golden");
    expect(readRepo("docs/product.md")).toContain("v1.16");
    expect(readRepo("docs/product.md")).toContain("v1.17");
    expect(readRepo("docs/architecture.md")).toContain("v1.16.0");
    expect(readRepo("docs/architecture.md")).toContain("v1.17.0");
    expect(readRepo("docs/architecture.md")).toContain("v1.17.1");
    expect(readRepo("docs/architecture.md")).toContain("v1.17.2");
    expect(readRepo("docs/architecture.md")).toContain("v1.17.3");
    expect(readRepo("docs/releases/1.17.0.md")).toContain("Codex window");
    expect(readRepo("docs/releases/1.17.1.md")).toContain("Queue honesty");
    expect(readRepo("docs/releases/1.17.2.md")).toContain("Codex Search");
    expect(readRepo("docs/releases/1.17.3.md")).toContain("context economy");
    expect(readRepo("docs/data-model.md")).toContain("retry");
    expect(readRepo("docs/api.md")).toContain("PATCH .../executions/{eid}");
    expect(readRepo("docs/api.md")).toContain("lands on the waiting execution");
    expect(readRepo("docs/roadmap.md")).toContain("v1.16.0");
  });

  it("marks historical v0.92 material as superseded rather than normative", () => {
    const rebuild = readRepo("docs/history/v0.92-agent-os-rebuild.md");
    const release = readRepo("docs/releases/0.92.0.md");
    expect(rebuild).toMatch(/historical/i);
    expect(rebuild).toMatch(/superseded by v0\.93/i);
    expect(release).toMatch(/historical release snapshot/i);
    expect(release).toMatch(/superseded.*v0\.93/i);
  });

  it("keeps persistence vocabulary explicitly subordinate to product vocabulary", () => {
    const docsIndex = readRepo("docs/README.md");
    const architecture = readRepo("docs/architecture.md");
    expect(docsIndex).toContain("Historical compatibility vocabulary");
    expect(architecture).toMatch(/persistence.*compatib/i);
  });
});
