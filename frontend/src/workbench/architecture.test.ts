import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

describe("v0.93 Agent-native ownership boundaries", () => {
  it("physically removes the v0.92 page-navigation shell", () => {
    expect(existsSync(new URL("./InvestigationNavigation.tsx", import.meta.url))).toBe(false);
    expect(existsSync(new URL("./SurfaceTabs.tsx", import.meta.url))).toBe(false);
    expect(existsSync(new URL("./workbench-accessibility.css", import.meta.url))).toBe(false);
  });

  it("has exactly one Agent steering input", () => {
    expect(existsSync(new URL("./SteeringSurface.tsx", import.meta.url))).toBe(false);
    expect(existsSync(new URL("./SteeringSurface.test.tsx", import.meta.url))).toBe(false);
    expect(existsSync(new URL("./steering.css", import.meta.url))).toBe(false);
    const composer = source("../components/Composer.tsx");
    expect(composer).toContain('data-testid="agent-composer"');
    expect(composer).toContain("Delegate");
    expect(composer).toContain("Steer");
    expect(composer).not.toContain("Ask Storage Agent");
  });

  it("keeps legacy inspector overlays deleted", () => {
    expect(existsSync(new URL("../components/SessionInspector.tsx", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../components/SessionInspectorImplementation.tsx", import.meta.url))).toBe(false);
  });

  it("keeps the Agent task as the primary work area", () => {
    const shell = source("./WorkbenchShell.tsx");
    expect(shell).not.toContain("<SurfaceTabs");
    expect(shell).not.toContain('role="tabpanel"');
    expect(shell).not.toContain("timeline: ReactNode");
    expect(shell).not.toContain("agent-task-start-heading");
    expect(shell).toContain("taskContent: ReactNode");
    expect(shell).toContain("<AgentReviewPanel");
    expect(shell).toContain("agent-task-content");
  });

  it("makes AgentTaskNavigation the application boundary with no SessionRail adapter", () => {
    expect(existsSync(new URL("../components/SessionRail.tsx", import.meta.url))).toBe(false);
    const app = source("../App.tsx");
    expect(app).toContain('import { AgentTaskNavigation } from "./workbench/AgentTaskNavigation"');
    expect(app).toContain("<AgentTaskNavigation");
    expect(app).not.toContain("SessionRail");
  });

  it("uses task-navigation geometry and selectors rather than rail protocols", () => {
    const navigation = source("./AgentTaskNavigation.tsx");
    const model = source("./navigationModel.ts");
    expect(navigation).toContain('data-testid="agent-task-navigation"');
    expect(navigation).toContain('data-testid="task-navigation-toggle"');
    expect(navigation).not.toContain('data-testid="session-rail"');
    expect(navigation).not.toContain('data-testid="rail-');
    expect(model).toContain("DEFAULT_TASK_NAV_WIDTH");
    expect(model).toContain("clampTaskNavigationWidth");
    expect(model).not.toContain("DEFAULT_RAIL_WIDTH");
    expect(model).not.toContain("clampRailWidth");
    expect(existsSync(new URL("../../e2e/rail.spec.ts", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../../e2e/task-navigation.spec.ts", import.meta.url))).toBe(true);
  });

  it("uses review and execution commands rather than v0.92 application surfaces", () => {
    const model = source("./model.ts");
    const commands = source("./commands.ts");
    const shell = source("./WorkbenchShell.tsx");
    const result = source("../components/AnswerDocument.tsx");
    expect(model).not.toContain("WorkSurface");
    expect(model).not.toContain("initialWorkbenchState");
    expect(model).not.toContain("workbenchReducer");
    expect(commands).toContain("openAgentReview");
    expect(commands).toContain("openAgentExecution");
    expect(shell).toContain("publishAgentCommands");
    expect(shell).not.toContain("openWorkbench");
    expect(result).toContain("openAgentReview");
    expect(result).toContain("openAgentExecution");
    expect(result).not.toContain("openWorkbenchSurface");
    expect(result).not.toContain("openWorkbenchRun");
  });

  it("uses contextual reviews and artifacts, not v0.92 workspaces", () => {
    expect(existsSync(new URL("./EvidenceWorkspace.tsx", import.meta.url))).toBe(false);
    expect(existsSync(new URL("./RunsWorkspace.tsx", import.meta.url))).toBe(false);
    expect(existsSync(new URL("./ReportWorkspace.tsx", import.meta.url))).toBe(false);
    expect(existsSync(new URL("./EvidenceReview.tsx", import.meta.url))).toBe(true);
    expect(existsSync(new URL("./ExecutionReview.tsx", import.meta.url))).toBe(true);
    expect(existsSync(new URL("./ReportArtifact.tsx", import.meta.url))).toBe(true);
    const review = source("./AgentReviewPanel.tsx");
    expect(review).toContain("<EvidenceReview");
    expect(review).toContain("<ExecutionReview");
    expect(review).toContain("<ReportArtifact");
    expect(review).not.toContain("Workspace");
  });

  it("renders task history as Direction and Work Result primitives", () => {
    const content = source("../components/AnswerDocument.tsx");
    expect(content).toContain('data-testid="direction-event"');
    expect(content).toContain('data-work-result="true"');
    expect(content).toContain("Work Result");
    expect(content).not.toContain("chat bubble");
  });

  it("uses task-native keyboard contracts", () => {
    const shortcuts = source("../shortcuts.ts");
    const app = source("../App.tsx");
    const boundary = source("../components/Thread.tsx");
    expect(shortcuts).toContain('"newTask"');
    expect(shortcuts).toContain('"toggleTaskNavigation"');
    expect(shortcuts).toContain('"review"');
    expect(shortcuts).toContain('group: "task"');
    expect(shortcuts).not.toContain('"newChat"');
    expect(shortcuts).not.toContain('"toggleRail"');
    expect(shortcuts).not.toContain('"inspector"');
    expect(shortcuts).not.toContain('group: "chat"');
    expect(app).toContain('matches(event, "newTask")');
    expect(app).toContain('matches(event, "toggleTaskNavigation")');
    expect(boundary).toContain('matches(event, "nextStep")');
    expect(boundary).toContain('matches(event, "prevStep")');
  });

  it("keeps persisted session and viewport ownership out of the task renderer", () => {
    const thread = source("../components/ThreadImplementation.tsx");
    expect(thread).not.toContain("getSessionTurnState");
    expect(thread).not.toContain("getSessionMessages");
    expect(thread).not.toContain("AUTOSCROLL_FRAME_BUDGET");
    expect(thread).not.toContain("SessionInspector");
    expect(thread).not.toContain("getSessionReport");
    expect(thread).not.toContain("function Overlay");
  });

  it("has exactly one semantic j/k owner without capture-phase suppression", () => {
    const boundary = source("../components/Thread.tsx");
    const implementation = source("../components/ThreadImplementation.tsx");
    expect(boundary).toContain('matches(event, "nextStep")');
    expect(boundary).not.toContain("stopImmediatePropagation");
    expect(implementation).not.toContain('matches(event, "nextStep")');
    expect(implementation).not.toContain("stepTurn");
  });

  it("does not embed RunDetail in task content", () => {
    const cards = source("../components/ThreadCardsImplementation.tsx");
    expect(cards).not.toContain('import { RunDetail } from "./RunDetail"');
    expect(cards).not.toContain("export function RunCard");
    expect(cards).not.toContain("<RunDetail");
  });

  it("contains no modal-stretch compatibility CSS for deep work", () => {
    const workspace = source("../workspace-overhaul.css");
    const run = source("../run-workspace.css");
    expect(workspace).not.toContain('data-testid="session-inspector"');
    expect(workspace).not.toContain(".fixed.inset-0.z-floating");
    expect(run).not.toContain(".thread-item div:has");
    expect(run).not.toContain("position: fixed");
  });
});
