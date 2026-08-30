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

// These documents describe the product directly. Architecture/index docs are
// allowed to NAME a removed component when they explicitly say it must stay
// removed; the product-facing contract must not present those concepts at all.
const productContractDocs = [
  "README.md",
  "CLAUDE.md",
  "docs/product.md",
  "docs/roadmap.md",
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

  it("marks the v0.92 rebuild document as historical and superseded", () => {
    const historical = readRepo("docs/v0.92-agent-os-rebuild.md");
    expect(historical).toMatch(/historical/i);
    expect(historical).toMatch(/superseded by v0\.93/i);
  });

  it("keeps persistence vocabulary explicitly subordinate to product vocabulary", () => {
    const docsIndex = readRepo("docs/README.md");
    const architecture = readRepo("docs/architecture.md");
    expect(docsIndex).toContain("Historical compatibility vocabulary");
    expect(architecture).toMatch(/persistence.*compatib/i);
  });
});
