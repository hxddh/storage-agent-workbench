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

describe("v0.93 documentation contract", () => {
  it("anchors normative documentation to the current Agent Task architecture", () => {
    for (const path of normativeDocs) {
      const text = readRepo(path);
      expect(text, `${path} must name Agent Task`).toMatch(/Agent Task/);
    }
    expect(readRepo("docs/README.md")).toContain("v0.93.0");
    expect(readRepo("CLAUDE.md")).toContain("v0.93.0");
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
    expect(api).toMatch(/product-level.*Agent Task/i);
    expect(dataModel).toMatch(/Current migration head:\s*025/i);
    expect(dataModel).toContain("Product-to-persistence mapping");
    expect(security).toContain("Decision required");
    expect(security).toContain("STORAGE_AGENT_AUTH_TOKEN");
    expect(smoke).toContain("Agent Task product smoke");
    expect(smoke).toContain("one primary Agent composer");
  });

  it("marks historical v0.92 material as superseded rather than normative", () => {
    const rebuild = readRepo("docs/v0.92-agent-os-rebuild.md");
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
