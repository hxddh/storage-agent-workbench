import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const absent = (relative: string) => expect(existsSync(new URL(relative, import.meta.url))).toBe(false);

describe("v1.06.0 native Agent ownership boundaries", () => {
  it("physically removes the v0.92 navigation and deep-surface shell", () => {
    absent("./InvestigationNavigation.tsx");
    absent("./SurfaceTabs.tsx");
    absent("./SteeringSurface.tsx");
    absent("./SteeringSurface.test.tsx");
    absent("./steering.css");
    absent("./agent-accessibility.css");
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
    expect(composer).not.toContain('t("thread.');
    expect(composer).not.toContain("<kbd");
    expect(composer).not.toContain("group-focus-within/composer");
    expect(composer).not.toContain("attach-type-inventory");
    expect(composer).not.toContain("attach-type-access_log");
    expect(composer).not.toContain("Analyze as:");
  });

  it("keeps Agent Task as the primary work area while Review is a light overlay", () => {
    const shell = source("./AgentShell.tsx");
    expect(shell).toContain("taskContent: ReactNode");
    expect(shell).toContain("agent-task-content");
    expect(shell).toContain("<AgentReviewPanel");
    expect(source("./AgentReviewPanel.tsx")).toContain("agent-review-overlay");
    expect(shell).not.toContain('data-testid="agent-task-review"');
    expect(shell).not.toContain("showReview");
    expect(shell).not.toContain("agent-task-header");
    expect(shell).not.toContain("agent-task-title");
    expect(shell).not.toContain("data-focus");
    expect(shell).not.toContain("focus.toggle");
    expect(shell).not.toContain("agent-live-status");
    expect(shell).not.toContain("agent-task-breadcrumb");
    expect(shell).not.toContain("timeline: ReactNode");
    expect(shell).not.toContain("<SurfaceTabs");
    expect(shell).not.toContain('role="tabpanel"');
    expect(shell).not.toContain("agent-task-start-heading");
  });

  it("makes AgentTaskNavigation a quiet chronological title list", () => {
    const app = source("../App.tsx");
    const navigation = source("./AgentTaskNavigation.tsx");
    const model = source("./navigationModel.ts");
    const e2e = source("../../e2e/task-navigation.spec.ts");
    expect(app).toContain('import { AgentTaskNavigation } from "./agent/AgentTaskNavigation"');
    expect(app).toContain("<AgentTaskNavigation");
    expect(app).not.toContain("SessionRail");
    expect(app).not.toContain("onTogglePin");
    expect(app).not.toContain("onFork");
    expect(app).not.toContain("onToggleArchive");
    expect(navigation).toContain('data-testid="agent-task-navigation"');
    expect(navigation).toContain('data-testid="task-navigation-toggle"');
    expect(navigation).toContain("agent-task-list");
    expect(navigation).not.toContain("agent-task-queue");
    expect(navigation).not.toContain("{copy.needsYou}");
    expect(navigation).not.toContain("{copy.recent}");
    expect(navigation).not.toContain("task-queue-needs-you");
    expect(navigation).not.toContain("task-queue-running");
    expect(navigation).not.toContain('data-testid="session-rail"');
    expect(navigation).not.toContain('data-testid="rail-');
    expect(navigation).not.toContain("Search tasks");
    expect(navigation).not.toContain("menu.pin");
    expect(navigation).not.toContain("menu.duplicate");
    expect(navigation).not.toContain("menu.archive");
    expect(navigation).not.toContain("<kbd");
    expect(model).toContain("DEFAULT_TASK_NAV_WIDTH");
    expect(model).toContain("clampTaskNavigationWidth");
    expect(model).toContain("onRename");
    expect(model).toContain("onDelete");
    expect(model).not.toContain("onTogglePin");
    expect(model).not.toContain("onFork");
    expect(model).not.toContain("DEFAULT_RAIL_WIDTH");
    expect(model).not.toContain("clampRailWidth");
    absent("../../e2e/rail.spec.ts");
    expect(e2e).toContain('test.describe("Agent task navigation"');
    expect(e2e).not.toContain("Duplicate");
    expect(e2e).not.toContain("Archive");
    expect(e2e).not.toContain("Search tasks");
  });

  it("uses Review and Execution commands instead of v0.92 application surfaces", () => {
    const model = source("./model.ts");
    const commands = source("./commands.ts");
    const shell = source("./AgentShell.tsx");
    expect(model).not.toContain("WorkSurface");
    expect(model).not.toContain("initialWorkbenchState");
    expect(model).not.toContain("workbenchReducer");
    expect(model).not.toContain("focus.toggle");
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
    expect(evidence).not.toContain("agent-document-heading");
    expect(evidence).not.toContain("agent-section-index");
    expect(execution).toContain("export function ExecutionReview");
    expect(execution).not.toContain("agent-document-heading");
    expect(report).toContain("export function ReportArtifact");
    expect(report).not.toContain("agent-document-heading");
    expect(report).not.toContain("agent-os-command");
    expect(review).toContain("<EvidenceReview");
    expect(review).toContain("<ExecutionReview");
    expect(review).toContain("<ReportArtifact");
    expect(review).toContain("agent-review-overlay");
    expect(review).toContain("useDismissOnEscape");
    expect(review).not.toContain('data-testid="decision-history"');
    expect(review).not.toContain("Workspace");
    expect(review).not.toContain("agent-review-eyebrow");
  });

  it("uses Direction and Work Result directly with no message adapter", () => {
    absent("../components/AnswerDocument.tsx");
    absent("../components/AnswerDocument.test.tsx");
    absent("../components/TaskContent.tsx");
    absent("../components/TaskContentImplementation.tsx");
    const result = source("../components/AgentTaskResult.tsx");
    const task = source("../components/AgentTaskImplementation.tsx");
    expect(result).toContain('data-testid="direction-event"');
    expect(result).toContain('data-testid="work-result"');
    expect(result).toContain('data-work-result="true"');
    expect(result).toContain("openAgentReview");
    expect(result).toContain("openAgentExecution");
    expect(result).not.toContain("AnswerDocument");
    expect(result).not.toContain("onBranch");
    expect(result).not.toContain("onRerun");
    expect(result).not.toContain("redirect-direction");
    expect(task).toContain('import { AgentTaskResult } from "./AgentTaskResult"');
    expect(task).toContain("<AgentTaskResult");
    expect(task).not.toContain("MessageCard");
    expect(task).not.toContain("TaskContent");
  });

  it("uses Agent Next Action and explicit Decision boundaries", () => {
    const action = source("../components/AgentDecisionCard.tsx");
    const task = source("../components/AgentTaskImplementation.tsx");
    const artifacts = source("../components/AgentRuntimeArtifacts.tsx");
    expect(action).toContain("export function AgentNextAction");
    expect(action).toContain('data-testid="agent-decision-required"');
    expect(action).toContain('data-testid="agent-decline-action"');
    expect(action).toContain('data-testid="decision-impact"');
    expect(task).toContain('import { AgentNextAction } from "./AgentDecisionCard"');
    expect(task).toContain("<AgentNextAction");
    expect(task).toContain("runner.resume");
    expect(task).toContain('data-testid="task-resume"');
    expect(task).not.toContain('data-testid="task-verify"');
    expect(task).not.toContain('data-testid="task-verify-action"');
    expect(task).toContain('data-testid="queued-direction"');
    expect(task).not.toContain("ProposalCard");
    expect(artifacts).toContain("<AgentNextAction");
    expect(artifacts).not.toContain("ProposalCard");
    expect(artifacts).not.toContain("ThinkingBubble");
    expect(artifacts).not.toContain("GroundingCard");
  });

  it("shows real tool work in the document, not an Execution Summary wall", () => {
    absent("../components/TurnFooter.tsx");
    absent("../../e2e/turnfooter.spec.ts");
    absent("../components/ExecutionSummary.tsx");
    const result = source("../components/AgentResultRenderer.tsx");
    const task = source("../components/AgentTaskImplementation.tsx");
    const e2e = source("../../e2e/execution-summary.spec.ts");
    expect(result).toContain("LiveTrace");
    expect(result).toContain("toolActivity?.length");
    expect(task).not.toContain('from "./ExecutionSummary"');
    expect(task).not.toContain("<ExecutionSummary");
    expect(task).not.toContain("TurnFooter");
    expect(task).not.toContain("ThinkingBubble");
    expect(e2e).toContain('getByTestId("live-trace")');
    expect(e2e).not.toContain("execution-summary-toggle");
  });

  it("uses Execution Steps and Execution Detail rather than timeline/run-detail renderers", () => {
    absent("../components/ToolTimeline.tsx");
    absent("../components/RunDetail.tsx");
    absent("../components/RunDetailImplementation.tsx");
    const steps = source("../components/ExecutionSteps.tsx");
    const detail = source("../components/ExecutionDetailImplementation.tsx");
    expect(steps).toContain("export interface ExecutionStep");
    expect(steps).toContain("export function ExecutionSteps");
    expect(steps).toContain('data-testid="execution-step"');
    expect(detail).toContain('from "./ExecutionSteps"');
    expect(detail).toContain("executionSteps");
    expect(detail).toContain("<ExecutionSteps");
    expect(detail).not.toContain("ToolTimeline");
    expect(detail).not.toContain("TimelineItem");
    expect(detail).not.toContain("RunDetailImplementation");
  });

  it("uses task/execution DOM contracts rather than thread/timeline contracts", () => {
    const task = source("../components/AgentTaskImplementation.tsx");
    const boundary = source("../components/AgentTask.tsx");
    expect(task).toContain('data-testid="task-scroll"');
    expect(task).toContain("task-item-");
    expect(task).toContain('data-direction=');
    expect(task).not.toContain('data-testid="execution-link"');
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

  it("recovers a dropped event stream only by sequence number", () => {
    const impl = source("../hooks/useTurnRunnerImplementation.ts");
    const api = source("../api.ts");
    expect(impl).toContain("followExecutionEvents");
    expect(impl).toContain("resumeTaskExecution");
    expect(impl).not.toContain("waitForPersistedTurn");
    expect(impl).not.toContain("postSessionMessage");
    expect(impl).not.toContain("getSessionTurnState");
    expect(api).toContain("StreamDisconnectedError");
    expect(api).toContain("after=<last seq>");
  });

  it("reloads the task document when a background Execution settles without a live follow", () => {
    const doc = source("../hooks/useSessionDocument.ts");
    expect(doc).toContain("loadedSettledExecId");
    expect(doc).toContain("discoverPolls");
    expect(doc).toContain("Catch-up");
    expect(doc).toContain("void reload(sessionId)");
    expect(doc).toContain("followExecutionEvents");
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
    expect(app).toContain('matches(event, "stop")');
    expect(app).toContain('matches(event, "focusComposer")');
    const palette = source("../components/CommandPalette.tsx");
    expect(palette).toContain('data-testid="command-palette"');
    expect(palette).not.toContain("review-overview");
    expect(palette).not.toContain("review-evidence");
    expect(palette).not.toContain("review-execution");
    expect(palette).not.toContain("review-report");
    expect(palette).not.toContain("New investigation");
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
    const viewport = source("../hooks/useTaskViewport.ts");
    const nav = source("../lib/taskNavigation.ts");
    const taskCss = source("../agent-task.css");
    expect(boundary).toContain('matches(event, "nextStep")');
    expect(boundary).not.toContain("stopImmediatePropagation");
    expect(boundary).toContain("scrollTo");
    expect(boundary).not.toContain("scrollIntoView");
    expect(boundary).toContain("RELEASE_TASK_FOLLOW_EVENT");
    expect(viewport).toContain("RELEASE_TASK_FOLLOW_EVENT");
    expect(nav).toContain("TASK_STEP_SCROLL_MARGIN = 72");
    expect(taskCss).toContain("scroll-margin-top: 72px");
    expect(implementation).not.toContain('matches(event, "nextStep")');
    expect(implementation).not.toContain("stepTurn");
  });

  it("uses native Agent result and error artifacts", () => {
    const result = source("../components/AgentTaskResult.tsx");
    expect(result).toContain("AgentResultRenderer");
    expect(result).toContain("S3ErrorArtifact");
    expect(result).not.toContain("ProvenTurnRenderer");
    expect(source("../components/S3ErrorArtifact.tsx")).not.toContain("branch-task");
    expect(source("../components/S3ErrorArtifact.tsx")).not.toContain("redirect-direction");
  });

  it("uses task-native styling with no workbench command-center layer", () => {
    absent("../workspace-overhaul.css");
    absent("../run-workspace.css");
    absent("./command-center.css");
    const main = source("../main.tsx");
    const taskCss = source("../agent-task.css");
    const executionCss = source("../execution-review.css");
    const shellCss = source("./agent-shell.css");
    expect(main).toContain('import "./agent-task.css"');
    expect(main).toContain('import "./execution-review.css"');
    expect(main).not.toContain("workspace-overhaul.css");
    expect(main).not.toContain("run-workspace.css");
    expect(main).not.toContain("command-center.css");
    expect(taskCss).toContain('[data-testid="task-scroll"]');
    expect(taskCss).not.toContain('[data-testid="execution-summary"]');
    expect(taskCss).not.toContain("thread-scroll");
    expect(taskCss).not.toContain("turn-activity");
    expect(shellCss).toContain("agent-review-overlay");
    expect(shellCss).not.toContain(".agent-task-header");
    expect(shellCss).not.toContain('data-focus="true"');
    expect(executionCss).toContain('[data-testid="execution-detail"]');
    expect(executionCss).not.toContain("run-workspace-root");
    expect(executionCss).not.toContain("position: fixed");
  });

  it("does not ship a slash SKU catalog; tools are discovered by the model", () => {
    const task = source("../components/AgentTaskImplementation.tsx");
    const composer = source("../components/Composer.tsx");
    expect(task).not.toContain("delegate-suggestion");
    expect(task).not.toContain("SuggestionIcon");
    expect(composer).not.toContain('cmd: "checkup"');
    expect(composer).not.toContain('cmd: "cost"');
    expect(composer).not.toContain('cmd: "drift"');
    expect(composer).not.toContain("const SLASH");
    expect(composer).not.toContain("onSlashReport");
  });

  it("matches a live pending Direction only to the current turn", () => {
    const task = source("../components/AgentTaskImplementation.tsx");
    expect(task).toContain("isCurrentPersistedDirection");
    expect(task).toContain("pendingMatchesPersistedDirection");
    expect(task).toContain("if (!sessionId || !pending || busy) return");
    expect(task).not.toContain("pendingAlreadyPersisted");
    expect(task).toContain("{pending && !hideLiveDirection ?");
    expect(task).toContain("isCurrentPersistedWorkResult");
    expect(task).toContain("{pending && !hideLiveWorkResult ?");
    expect(task).toContain("<WorkingRow");
    expect(task).not.toContain("ThinkingBubble");
  });

  it("does not treat a cached task document as a successful server load", () => {
    const doc = source("../hooks/useSessionDocument.ts");
    expect(doc).toContain("shownIdRef");
    expect(doc).toContain("if (id !== shownIdRef.current) setEarlier([])");
    expect(doc).toContain("if (failed && loadedIdRef.current !== id)");
    const restore = doc.slice(doc.indexOf("Restore a cached document"));
    const restoreBlock = restore.slice(0, restore.indexOf("void reload(sessionId)"));
    expect(restoreBlock).toContain("shownIdRef.current = sessionId");
    expect(restoreBlock).not.toContain("loadedIdRef.current = sessionId");
  });

  it("keeps Settings free of a storage price spreadsheet", () => {
    const settings = source("../components/SettingsDrawer.tsx");
    expect(settings).not.toContain('data-testid="settings-price-table"');
    expect(settings).not.toContain("PriceTableSection");
    expect(settings).not.toContain("getPriceTable");
  });

  it("does not present plans, baselines, drift, or revisit as Review destinations", () => {
    const review = source("./AgentReviewPanel.tsx");
    const model = source("./model.ts");
    expect(review).not.toContain('data-testid="remediation-plan-status"');
    expect(review).not.toContain('data-testid="task-baselines"');
    expect(review).not.toContain('data-testid="task-drift"');
    expect(review).not.toContain('data-testid="task-revisit"');
    expect(review).not.toContain('(["overview", "evidence", "execution", "report"] as const)');
    expect(model).toContain('export type ReviewSurface = "evidence" | "execution" | "report"');
    expect(model).not.toContain('"overview"');
    expect(review).not.toContain("Workspace");
    expect(review).not.toContain("remediation-plan-page");
  });

  it("renders deterministic SVG figures from provenance inside the latest Work Result", () => {
    const pkg = source("../../package.json");
    const figures = source("../viz/AnalysisFigures.tsx");
    const extract = source("../viz/extract.ts");
    const task = source("../components/AgentTaskImplementation.tsx");
    expect(pkg).not.toMatch(/recharts|chart\.js|d3|plotly|nivo|visx|highcharts/i);
    expect(figures).toContain('data-testid="analysis-figures"');
    expect(figures).toContain("Cost axis withheld");
    expect(extract).toContain("Never invent a day the runtime did not emit");
    expect(task).toContain("task-analysis-figures");
    expect(task).toContain("figures={latest");
    expect(task).not.toContain("task-document-figures");
    expect(source("../agent-task.css")).not.toContain("data-split");
    expect(source("./AgentReviewPanel.tsx")).not.toContain("review-overview-figures");
    expect(source("./AgentReviewPanel.tsx")).not.toContain("AnalysisFigures");
  });

  it("projects finding provenance into Review Evidence without a new surface", () => {
    const evidence = source("./EvidenceReview.tsx");
    const mark = source("../viz/ProvenanceMark.tsx");
    const api = source("../api.ts");
    expect(api).toContain("/agent-tasks/${taskId}/provenance");
    expect(mark).toContain("No direct evidence chain");
    expect(mark).toContain("openAgentReview(\"evidence\"");
    expect(evidence).toContain("finding-${finding.id}");
    expect(evidence).toContain("No direct evidence chain");
    expect(source("./model.ts")).toContain('export type ReviewSurface = "evidence" | "execution" | "report"');
  });

  it("makes the empty start the Composer, with no first-run wizard", () => {
    const app = source("../App.tsx");
    const task = source("../components/AgentTaskImplementation.tsx");
    const shell = source("./AgentShell.tsx");
    expect(app).not.toContain("FirstRunWizard");
    expect(app).not.toContain("FirstRunFlow");
    absent("../components/FirstRunFlow.tsx");
    absent("../hooks/useFirstRun.ts");
    absent("../lib/firstRun.ts");
    expect(task).not.toContain("FirstRunFlow");
    expect(task).not.toContain("showFirstRun");
    expect(task).not.toContain("agent-first-run");
    expect(task).toContain("void runner.submit");
    expect(task).toContain("{composer}");
    expect(task).not.toContain("delegate-suggestion");
    expect(shell).not.toContain("ConnectionMark");
    expect(shell).not.toContain("agent-native-command");
    expect(shell).not.toContain("Ready to delegate");
    expect(shell).not.toContain("onOpenPalette");
    expect(shell).not.toContain("sidecarStatus");
  });

  it("physically removes leftover workbench product objects", () => {
    absent("../components/AgentMemory.tsx");
    absent("../lib/activityDensity.ts");
    absent("../components/ExecutionSummary.tsx");
    absent("./command-center.css");
    const ui = source("../components/ui.tsx");
    const i18n = source("../i18n.tsx");
    const copy = source("./agentCopy.ts");
    const model = source("./navigationModel.ts");
    expect(ui).not.toContain("BrandMark");
    expect(i18n).not.toContain("menu.pin");
    expect(i18n).not.toContain("menu.duplicate");
    expect(i18n).not.toContain("menu.archive");
    expect(i18n).not.toContain("wizard.welcomeTitle");
    expect(i18n).not.toContain("sugg.checkup");
    expect(i18n).not.toContain("settings.priceTitle");
    expect(i18n).not.toContain("attach.pickType");
    expect(i18n).not.toContain("grounding.title");
    expect(i18n).not.toContain("think.working");
    expect(i18n).not.toContain('"thread.');
    expect(copy).not.toContain("noScope");
    expect(copy).not.toContain("commandPalette");
    expect(model).not.toContain("dayBucket");
    expect(model).not.toContain("DAY_BUCKETS");
  });

  it("removes leftover chat-transcript contracts from the native Agent window", () => {
    const runner = source("../hooks/useTurnRunnerImplementation.ts");
    const css = source("../index.css");
    const result = source("../components/AgentResultRenderer.tsx");
    const task = source("../components/AgentTaskImplementation.tsx");
    const empty = source("../components/EmptyState.tsx");
    expect(runner).not.toContain("New chat");
    expect(runner).not.toContain('t("thread.');
    expect(runner).toContain('t("common.untitled")');
    expect(css).not.toContain("thread-prose");
    expect(css).not.toContain("thread-bleed");
    expect(css).not.toContain("empty-state-art");
    expect(result).toContain('t("task.working")');
    expect(result).not.toContain("think.working");
    expect(task).toContain("<WorkingRow label={taskCopy.liveWorking}");
    expect(task).not.toContain("think.working");
    expect(empty).not.toContain("empty-state-art");
    expect(empty).not.toContain("<svg");
  });
});
