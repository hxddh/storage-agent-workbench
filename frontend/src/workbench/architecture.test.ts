import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const absent = (relative: string) => expect(existsSync(new URL(relative, import.meta.url))).toBe(false);

describe("v0.93 Agent-native ownership boundaries", () => {
  it("physically removes the v0.92 navigation and deep-surface shell", () => {
    absent("./InvestigationNavigation.tsx");
    absent("./SurfaceTabs.tsx");
    absent("./SteeringSurface.tsx");
    absent("./SteeringSurface.test.tsx");
    absent("./steering.css");
    absent("./workbench-accessibility.css");
    absent("../components/SessionRail.tsx");
    absent("../components/SessionInspector.tsx");
    absent("../components/SessionInspectorImplementation.tsx");
    absent("./EvidenceWorkspace.tsx");
    absent("./RunsWorkspace.tsx");
    absent("./ReportWorkspace.tsx");
  });

  it("has one Agent steering input with delegate/steer/stop semantics", () => {
    const composer = source("../components/Composer.tsx");
    expect(composer).toContain('data-testid="agent-composer"');
    expect(composer).toContain("Delegate");
    expect(composer).toContain("Steer");
    expect(composer).toContain("onStop");
    expect(composer).not.toContain("Ask Storage Agent");
  });

  it("keeps Agent Task as the primary work area while Review stays contextual", () => {
    const shell = source("./WorkbenchShell.tsx");
    expect(shell).toContain("taskContent: ReactNode");
    expect(shell).toContain("agent-task-content");
    expect(shell).toContain("<AgentReviewPanel");
    expect(shell).not.toContain("timeline: ReactNode");
    expect(shell).not.toContain("<SurfaceTabs");
    expect(shell).not.toContain('role="tabpanel"');
    expect(shell).not.toContain("agent-task-start-heading");
  });

  it("makes AgentTaskNavigation the application boundary, not a session/chat rail", () => {
    const app = source("../App.tsx");
    const navigation = source("./AgentTaskNavigation.tsx");
    const model = source("./navigationModel.ts");
    const e2e = source("../../e2e/task-navigation.spec.ts");
    expect(app).toContain('import { AgentTaskNavigation } from "./workbench/AgentTaskNavigation"');
    expect(app).toContain("<AgentTaskNavigation");
    expect(app).not.toContain("SessionRail");
    expect(navigation).toContain('data-testid="agent-task-navigation"');
    expect(navigation).toContain('data-testid="task-navigation-toggle"');
    expect(navigation).not.toContain('data-testid="session-rail"');
    expect(navigation).not.toContain('data-testid="rail-');
    expect(model).toContain("DEFAULT_TASK_NAV_WIDTH");
    expect(model).toContain("clampTaskNavigationWidth");
    expect(model).not.toContain("DEFAULT_RAIL_WIDTH");
    expect(model).not.toContain("clampRailWidth");
    absent("../../e2e/rail.spec.ts");
    expect(e2e).toContain('test.describe("Agent task navigation"');
  });

  it("uses Review and Execution commands instead of v0.92 application surfaces", () => {
    const model = source("./model.ts");
    const commands = source("./commands.ts");
    const shell = source("./WorkbenchShell.tsx");
    expect(model).not.toContain("WorkSurface");
    expect(model).not.toContain("initialWorkbenchState");
    expect(model).not.toContain("workbenchReducer");
    expect(commands).toContain("openAgentReview");
    expect(commands).toContain("openAgentExecution");
    expect(shell).toContain("publishAgentCommands");
    expect(shell).not.toContain("openWorkbench");
  });

  it("renders contextual Evidence, Execution and Report artifacts", () => {
    const evidence = source("./EvidenceReview.tsx");
    const execution = source("./ExecutionReview.tsx");
    const report = source("./ReportArtifact.tsx");
    const review = source("./AgentReviewPanel.tsx");
    expect(evidence).toContain("export function EvidenceReview");
    expect(evidence).toContain('data-testid="evidence-review"');
    expect(execution).toContain("export function ExecutionReview");
    expect(report).toContain("export function ReportArtifact");
    expect(review).toContain("<EvidenceReview");
    expect(review).toContain("<ExecutionReview");
    expect(review).toContain("<ReportArtifact");
    expect(review).not.toContain("Workspace");
  });

  it("uses Direction and Work Result as the task-content primitives", () => {
    absent("../components/AnswerDocument.tsx");
    absent("../components/AnswerDocument.test.tsx");
    const result = source("../components/AgentTaskResult.tsx");
    const boundary = source("../components/TaskContent.tsx");
    expect(result).toContain('data-testid="direction-event"');
    expect(result).toContain('data-testid="work-result"');
    expect(result).toContain('data-work-result="true"');
    expect(result).toContain("Work Result");
    expect(result).toContain("openAgentReview");
    expect(result).toContain("openAgentExecution");
    expect(result).not.toContain("AnswerDocument");
    expect(boundary).toContain('from "./AgentTaskResult"');
    expect(boundary).not.toContain("AnswerDocument");
  });

  it("promotes completed tool work to Execution Summary with no footer shim", () => {
    absent("../components/TurnFooter.tsx");
    absent("../../e2e/turnfooter.spec.ts");
    const execution = source("../components/ExecutionSummary.tsx");
    const task = source("../components/AgentTaskImplementation.tsx");
    const e2e = source("../../e2e/execution-summary.spec.ts");
    expect(execution).toContain("export function ExecutionSummary");
    expect(execution).toContain('data-testid="execution-summary"');
    expect(execution).toContain('data-testid="execution-step-open"');
    expect(task).toContain('from "./ExecutionSummary"');
    expect(task).toContain("<ExecutionSummary");
    expect(task).not.toContain("TurnFooter");
    expect(e2e).toContain('test.describe("Execution Summary"');
  });

  it("uses task/execution DOM contracts rather than thread/timeline contracts", () => {
    const task = source("../components/AgentTaskImplementation.tsx");
    const boundary = source("../components/AgentTask.tsx");
    expect(task).toContain('data-testid="task-scroll"');
    expect(task).toContain("task-item-");
    expect(task).toContain('data-direction=');
    expect(task).toContain('data-testid="execution-link"');
    expect(task).toContain('data-testid="remote-execution"');
    expect(task).toContain('data-testid="task-status"');
    expect(task).not.toContain('data-testid="thread-scroll"');
    expect(task).not.toContain("thread-item-");
    expect(task).not.toContain('data-question=');
    expect(task).not.toContain('data-testid="timeline-run-link"');
    expect(task).not.toContain('data-testid="remote-turn"');
    expect(task).not.toContain('data-testid="turn-status"');
    expect(boundary).toContain("[data-testid='task-scroll']");
    expect(boundary).toContain("[data-direction]");
    expect(boundary).not.toContain("[data-testid='thread-scroll']");
    expect(boundary).not.toContain("[data-question]");
  });

  it("uses AgentTask as the only public task boundary", () => {
    absent("../components/Thread.tsx");
    absent("../components/ThreadImplementation.tsx");
    const app = source("../App.tsx");
    const boundary = source("../components/AgentTask.tsx");
    const implementation = source("../components/AgentTaskImplementation.tsx");
    expect(app).toContain('import { AgentTask } from "./components/AgentTask"');
    expect(app).toContain("<AgentTask");
    expect(boundary).toContain('matches(event, "nextStep")');
    expect(boundary).toContain('matches(event, "prevStep")');
    expect(boundary).toContain('from "./AgentTaskImplementation"');
    expect(implementation).toContain("export function AgentTaskImplementation");
    expect(implementation).not.toContain("export function Thread");
  });

  it("uses task-native keyboard contracts", () => {
    const shortcuts = source("../shortcuts.ts");
    const app = source("../App.tsx");
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
  });

  it("keeps persisted session/runtime ownership out of the task renderer", () => {
    const task = source("../components/AgentTaskImplementation.tsx");
    expect(task).not.toContain("getSessionTurnState");
    expect(task).not.toContain("getSessionMessages");
    expect(task).not.toContain("AUTOSCROLL_FRAME_BUDGET");
    expect(task).not.toContain("SessionInspector");
    expect(task).not.toContain("getSessionReport");
    expect(task).not.toContain("function Overlay");
  });

  it("has exactly one semantic j/k owner without capture-phase suppression", () => {
    const boundary = source("../components/AgentTask.tsx");
    const implementation = source("../components/AgentTaskImplementation.tsx");
    expect(boundary).toContain('matches(event, "nextStep")');
    expect(boundary).not.toContain("stopImmediatePropagation");
    expect(implementation).not.toContain('matches(event, "nextStep")');
    expect(implementation).not.toContain("stepTurn");
  });

  it("physically removes the generic conversation renderer", () => {
    absent("../components/TaskContentImplementation.tsx");
    const boundary = source("../components/TaskContent.tsx");
    const result = source("../components/AgentTaskResult.tsx");
    expect(boundary).not.toContain("TaskContentImplementation");
    expect(boundary).not.toContain("export *");
    expect(result).toContain("AgentResultRenderer");
    expect(result).toContain("S3ErrorArtifact");
    expect(result).not.toContain("ProvenTurnRenderer");
  });

  it("uses task-native styling with no v0.92 compatibility stylesheets", () => {
    absent("../workspace-overhaul.css");
    absent("../run-workspace.css");
    const main = source("../main.tsx");
    const taskCss = source("../agent-task.css");
    const executionCss = source("../execution-review.css");
    expect(main).toContain('import "./agent-task.css"');
    expect(main).toContain('import "./execution-review.css"');
    expect(main).not.toContain("workspace-overhaul.css");
    expect(main).not.toContain("run-workspace.css");
    expect(taskCss).toContain('[data-testid="task-scroll"]');
    expect(taskCss).toContain('[data-testid="execution-summary"]');
    expect(taskCss).not.toContain("thread-scroll");
    expect(taskCss).not.toContain("turn-activity");
    expect(executionCss).toContain('[data-testid="execution-detail"]');
    expect(executionCss).not.toContain("run-workspace-root");
    expect(executionCss).not.toContain("position: fixed");
  });
});
