/**
 * v3.1.0 — the outputs made real: one findings list shared by the Result and
 * the Evidence pane, a report in the reader's language, truthful chrome when
 * the runtime is offline, and the design system finished (no raw colour or
 * type utilities left in components).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { unifyFindings } from "../lib/findings";
import type { Conclusion, TaskFinding } from "../types";
import type { ProvenanceFinding } from "../viz/types";

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const conclusion: Conclusion = {
  answer: "acme-logs denies list because its policy omits s3:ListBucket.",
  findings: [
    { title: "Versioning is off", severity: "low" },
    { title: "Bucket policy omits s3:ListBucket", severity: "high", detail: "Every list call returns 403." },
  ],
  next_steps: [],
};

const recorded = (id: string, title: string, severity: string): TaskFinding => ({
  id, title, severity, source_run_id: null, category: null, confidence: "high", kind: null,
  interpretation: null, status: "open", created_at: null,
});

describe("v3.1 one findings model", () => {
  it("joins the conclusion and the recorded findings, deduplicated, most severe first", () => {
    const merged = unifyFindings(conclusion, [
      recorded("f1", "Bucket  policy omits s3:ListBucket", "critical"),
      recorded("f2", "No AbortIncompleteMultipartUpload rule", "warning"),
    ]);
    expect(merged.map((f) => [f.title, f.severity, f.source])).toEqual([
      ["Bucket policy omits s3:ListBucket", "high", "conclusion"],
      ["No AbortIncompleteMultipartUpload rule", "medium", "recorded"],
      ["Versioning is off", "low", "conclusion"],
    ]);
    // A conclusion finding the work also recorded takes the record's id, so
    // its evidence link and the Evidence pane row agree.
    expect(merged[0].id).toBe("f1");
    expect(merged[2].id).toBe("conclusion-0");
  });

  it("says 'No direct evidence' only when the chains were read and none backs the finding", () => {
    const read = unifyFindings(conclusion, [], []);
    expect(read.every((f) => f.provenance === null)).toBe(true);
    const live = unifyFindings(conclusion, []);
    expect(live.every((f) => f.provenance === undefined)).toBe(true);
    expect(source("./TaskResult.tsx")).toContain('data-testid="finding-no-evidence"');
  });

  it("keeps each finding's evidence chain when one was recorded", () => {
    const chain = { id: "f2", title: "No AbortIncompleteMultipartUpload rule", severity: "medium", gap: null } as unknown as ProvenanceFinding;
    const merged = unifyFindings(null, [chain], [chain]);
    expect(merged[0].provenance).toBe(chain);
  });

  it("is the one list both surfaces read, and the Evidence count follows it", () => {
    // The Result and the pane call the same function over the task's complete
    // recorded findings (the provenance projection is capped; it only joins
    // chains by id).
    expect(source("./TaskDocument.tsx")).toContain("taskFindings({ ...details, conclusion: resultConclusion })");
    expect(source("./TaskDetails.tsx")).toContain("details.projection.detail?.findings ?? details.provenance?.findings");
    const details = source("./TaskDetails.tsx");
    expect(details).toContain("export function taskFindings(");
    expect(details).toContain('if (kind === "evidence") return taskFindings(details).length');
    expect(source("../agent/EvidenceReview.tsx")).toContain("findings: UnifiedFinding[]");
    // The separate list of provenance marks under the figures is gone.
    expect(source("./TaskDocument.tsx")).not.toContain("<ProvenanceMark");
  });
});

describe("v3.1 report", () => {
  it("asks for the report in the reader's language", () => {
    expect(source("../api/tasks.ts")).toContain("?lang=${encodeURIComponent(lang)}");
    expect(source("../agent/useAgentTaskProjection.ts")).toContain("getTaskReport(taskId, lang)");
  });

  it("⌘I toggles the side pane instead of re-opening Evidence", () => {
    expect(source("./AgentTask.tsx")).toContain("toggleAgentArtifacts();");
    // A selection with nothing behind it settles on the output shown, so it loads.
    expect(source("./TaskDetails.tsx")).toContain("if (selection && kind && kind !== selection.kind) open(kind);");
  });
});

describe("v3.1 truthful chrome", () => {
  it("says the runtime is offline instead of asking for a model", async () => {
    vi.resetModules();
    vi.doMock("../api", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../api")>()),
      listModelProviders: () => Promise.reject(new Error("connection refused")),
    }));
    const { ModelChip } = await import("./ModelChip");
    const { I18nProvider } = await import("../i18n");
    render(<I18nProvider><ModelChip /></I18nProvider>);
    await waitFor(() => expect(screen.getByTestId("model-chip")).toHaveAttribute("data-offline", "true"));
    expect(screen.getByTestId("model-chip")).toHaveTextContent("Runtime offline");
    expect(screen.queryByText("Set up a model…")).toBeNull();
  });
});

describe("v3.1 figures", () => {
  it("every light-theme series clears 3:1 (re-stepped, same hues)", () => {
    const css = source("../index.css");
    for (const value of ["--viz-2: #e05a26", "--viz-3: #11906a", "--viz-4: #ad7d00", "--viz-5: #d24e86"]) {
      expect(css).toContain(value);
    }
  });
});

describe("v3.1 design system, finished", () => {
  const RAW = /\b(text-gray-[0-9]+|text-(?:2xs|xs|sm|base|lg|xl|prose)|bg-(?:panel|canvas|elevated|hover|sidebar|code|scrim|danger[a-z-]*|warn[a-z-]*|success[a-z-]*|accent[a-z-]*)|border-(?:edge|edge-strong|danger[a-z-]*|warn[a-z-]*)|text-(?:danger|warn[a-z-]*|success|accent[a-z-]*))\b/g;
  const root = join(process.cwd(), "src");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, out);
      else if (path.endsWith(".tsx") && !/\.test\.tsx$/.test(path)) out.push(path);
    }
    return out;
  };

  it("leaves no raw colour or type utility in a component — surfaces compose ui-* and semantic classes", () => {
    const offenders: string[] = [];
    for (const path of walk(root)) {
      for (const match of readFileSync(path, "utf8").match(RAW) ?? []) offenders.push(`${path.slice(root.length)}: ${match}`);
    }
    expect(offenders).toEqual([]);
  });

  it("drops the 13px and 15px aliases: five sizes, five names", () => {
    const css = source("../index.css");
    for (const alias of ["--text-xs:", "--text-base:", "--text-lg:"]) expect(css).not.toContain(alias);
    const tailwind = source("../../tailwind.config.js");
    expect(tailwind).not.toMatch(/\bxs:\s*\[/);
    expect(tailwind).not.toMatch(/\bbase:\s*\[/);
  });
});
