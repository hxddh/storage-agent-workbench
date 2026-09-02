import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const absent = (relative: string) => expect(existsSync(new URL(relative, import.meta.url))).toBe(false);

/**
 * v1.09.0 — the native Agent window.
 *
 * The window is sidebar · title bar · one Task document · one Composer. The
 * v1.04–v1.08 web-app chassis (activity bar, status bar, Details inspector,
 * warm-editorial marketing chrome) and every earlier shell are physically gone.
 */
describe("v1.09.0 native Agent window boundaries", () => {
  it("physically removes every earlier shell", () => {
    // v0.92 surfaces
    absent("./InvestigationNavigation.tsx");
    absent("./SurfaceTabs.tsx");
    absent("./SteeringSurface.tsx");
    absent("../components/SessionRail.tsx");
    absent("../components/SessionInspector.tsx");
    absent("./EvidenceWorkspace.tsx");
    absent("./RunsWorkspace.tsx");
    absent("./ReportWorkspace.tsx");
    // v1.0x layers
    absent("../agent-task.css");
    absent("../work-result.css");
    absent("../execution-review.css");
    absent("./agent-shell.css");
    absent("./agent-state.css");
    absent("./agent-runtime.css");
    absent("./EvidenceActivity.tsx");
    absent("../components/EmptyState.tsx");
    absent("../components/SettingsDrawer.tsx");
    absent("../components/AnswerDocument.tsx");
    absent("../components/TaskContent.tsx");
    absent("../components/Thread.tsx");
    absent("../components/ThreadImplementation.tsx");
    absent("../components/TurnFooter.tsx");
    absent("../components/ExecutionSummary.tsx");
    absent("../components/ToolTimeline.tsx");
    absent("../components/RunDetail.tsx");
    absent("../components/AgentMemory.tsx");
    absent("../components/FirstRunFlow.tsx");
    absent("../workspace-overhaul.css");
    absent("../run-workspace.css");
    absent("./command-center.css");
  });

  it("composes the window as sidebar · title bar · task document, nothing else", () => {
    const app = source("../App.tsx");
    const shell = source("./AgentShell.tsx");
    const main = source("../main.tsx");
    expect(app).toContain('import { AgentTaskNavigation } from "./agent/AgentTaskNavigation"');
    expect(app).toContain('import { AgentTask } from "./components/AgentTask"');
    expect(app).toContain("<AgentTaskNavigation");
    expect(app).toContain("<AgentShell");
    expect(app).toContain("<AgentTask");
    expect(app).toContain("native-titlebar");
    expect(app).toContain("hasNativeTrafficLights");
    expect(app).not.toContain("ActivityBar");
    expect(app).not.toContain("detailsOpen");
    expect(app).not.toContain("Details");
    expect(app).not.toContain("tasks.length} tasks");
    expect(app).not.toContain("warm editorial");
    expect(app).not.toContain("Codex native");
    expect(app).not.toContain("<kbd");
    expect(app).not.toContain("SessionRail");
    expect(app).not.toContain("FirstRunWizard");
    expect(shell).toContain("taskContent: ReactNode");
    expect(shell).toContain("agent-task-content");
    expect(shell).toContain("<AgentReviewPanel");
    expect(shell).toContain("publishAgentCommands");
    expect(shell).not.toContain("navigation: ReactNode");
    expect(shell).not.toContain("agent-task-header");
    expect(shell).not.toContain("agent-live-status");
    expect(shell).not.toContain('role="tabpanel"');
    expect(main).toContain('import "./agent/native-shell.css"');
    expect(main).toContain('import "./agent/native-document.css"');
    expect(main).not.toContain("agent-task.css");
    expect(main).not.toContain("work-result.css");
  });

  it("keeps the sidebar a quiet chronological title list with Rename and Delete only", () => {
    const navigation = source("./AgentTaskNavigation.tsx");
    const model = source("./navigationModel.ts");
    const e2e = source("../../e2e/task-navigation.spec.ts");
    expect(navigation).toContain('data-testid="agent-task-navigation"');
    expect(navigation).toContain('data-testid="task-navigation-toggle"');
    expect(navigation).toContain('data-testid="task-navigation-new"');
    expect(navigation).toContain('data-testid="task-navigation-settings"');
    expect(navigation).toContain("native-task-list");
    expect(navigation).toContain("native-task-mark");
    expect(navigation).toContain('t("menu.rename")');
    expect(navigation).toContain('t("menu.delete")');
    expect(navigation).not.toContain("Search tasks");
    expect(navigation).not.toContain("menu.pin");
    expect(navigation).not.toContain("menu.duplicate");
    expect(navigation).not.toContain("menu.archive");
    expect(navigation).not.toContain("dayBucket");
    expect(navigation).not.toContain("<kbd");
    expect(navigation).not.toContain("EmptyState");
    expect(model).toContain("DEFAULT_TASK_NAV_WIDTH");
    expect(model).toContain("clampTaskNavigationWidth");
    expect(model).toContain("onRename");
    expect(model).toContain("onDelete");
    expect(model).not.toContain("onTogglePin");
    expect(model).not.toContain("onFork");
    expect(model).not.toContain("dayBucket");
    expect(e2e).toContain('test.describe("Agent task navigation"');
    expect(e2e).not.toContain("Duplicate");
    expect(e2e).not.toContain("Archive");
  });

  it("has one Agent input: attach + text + model + Delegate / Steer / Stop", () => {
    const composer = source("../components/Composer.tsx");
    const chip = source("../components/ModelChip.tsx");
    expect(composer).toContain('data-testid="agent-composer"');
    expect(composer).toContain("data-agent-state");
    expect(composer).toContain("delegateAction");
    expect(composer).toContain("steerAction");
    expect(composer).toContain("onStop");
    expect(composer).toContain("<ModelChip");
    expect(composer).toContain("Give the Agent a goal");
    expect(composer).toContain("给 Agent 一个目标");
    expect(composer).not.toContain("Ask Storage Agent");
    expect(composer).not.toContain("Ask anything");
    expect(composer).not.toContain('t("thread.');
    expect(composer).not.toContain("<kbd");
    expect(composer).not.toContain("attach-type-inventory");
    expect(composer).not.toContain("Analyze as:");
    expect(composer).not.toContain("const SLASH");
    expect(composer).not.toContain('cmd: "checkup"');
    // The model chip is backed by the real provider list; it never invents a model.
    expect(chip).toContain("listModelProviders");
    expect(chip).toContain("activateModelProvider");
    expect(chip).not.toContain("gpt-");
  });

  it("renders Direction, Execution and Work Result as one document with no chat chrome", () => {
    const result = source("../components/AgentTaskResult.tsx");
    const renderer = source("../components/AgentResultRenderer.tsx");
    const trace = source("../components/LiveTrace.tsx");
    const task = source("../components/AgentTaskImplementation.tsx");
    expect(result).toContain('data-testid="direction-event"');
    expect(result).toContain('data-testid="work-result"');
    expect(result).toContain('data-work-result="true"');
    expect(result).toContain("native-direction");
    expect(result).toContain("native-result");
    expect(result).toContain("openAgentReview");
    expect(result).toContain("openAgentExecution");
    expect(result).not.toContain("AnswerDocument");
    expect(result).not.toContain("onBranch");
    expect(result).not.toContain("onRerun");
    expect(result).not.toContain("redirect-direction");
    expect(result).not.toContain("rounded-lg border border-edge bg-panel px-5");
    expect(renderer).toContain("LiveTrace");
    expect(renderer).toContain("toolActivity?.length");
    expect(trace).toContain('data-testid="live-trace"');
    expect(trace).toContain("native-execution-head");
    expect(trace).toContain("Worked for");
    expect(trace).toContain('"data-testid": "trace-row-open"');
    expect(task).toContain('import { AgentTaskResult } from "./AgentTaskResult"');
    expect(task).toContain("<AgentTaskResult");
    expect(task).toContain('data-testid="task-scroll"');
    expect(task).toContain("task-item-");
    expect(task).toContain("data-direction=");
    expect(task).toContain('data-testid="remote-execution"');
    expect(task).toContain('data-testid="task-status"');
    expect(task).toContain('data-testid="queued-direction"');
    expect(task).toContain('data-testid="task-resume"');
    expect(task).toContain("runner.resume");
    expect(task).toContain("<WorkingRow label={taskCopy.liveWorking}");
    expect(task).not.toContain("MessageCard");
    expect(task).not.toContain("TaskContent");
    expect(task).not.toContain("ThinkingBubble");
    expect(task).not.toContain("ExecutionSummary");
    expect(task).not.toContain('data-testid="thread-scroll"');
    expect(task).not.toContain('data-testid="task-verify"');
    expect(task).not.toContain("delegate-suggestion");
  });

  it("makes the empty start a greeting and the Composer, with no wizard or SKU catalog", () => {
    const task = source("../components/AgentTaskImplementation.tsx");
    const app = source("../App.tsx");
    expect(task).toContain('data-testid="task-start"');
    expect(task).toContain("native-start-greeting");
    expect(task).toContain("{composer}");
    expect(task).toContain("void runner.submit");
    expect(task).not.toContain("FirstRunFlow");
    expect(task).not.toContain("showFirstRun");
    expect(task).not.toContain("delegate-suggestion");
    expect(task).not.toContain("<h1");
    expect(app).not.toContain("FirstRunWizard");
    absent("../hooks/useFirstRun.ts");
    absent("../lib/firstRun.ts");
  });

  it("uses explicit Decision boundaries with projected impact and a Decline path", () => {
    const action = source("../components/AgentDecisionCard.tsx");
    const task = source("../components/AgentTaskImplementation.tsx");
    const artifacts = source("../components/AgentRuntimeArtifacts.tsx");
    expect(action).toContain("export function AgentNextAction");
    expect(action).toContain('data-testid="agent-decision-required"');
    expect(action).toContain('data-testid="agent-approve-action"');
    expect(action).toContain('data-testid="agent-decline-action"');
    expect(action).toContain('data-testid="decision-impact"');
    expect(action).toContain("native-decision");
    expect(task).toContain('import { AgentNextAction } from "./AgentDecisionCard"');
    expect(task).toContain("<AgentNextAction");
    expect(task).toContain("resolveTaskDecision");
    expect(artifacts).toContain("<AgentNextAction");
    expect(artifacts).not.toContain("ProposalCard");
  });

  it("keeps Review a sheet over the Task with Evidence, Execution and Report only", () => {
    const review = source("./AgentReviewPanel.tsx");
    const model = source("./model.ts");
    const commands = source("./commands.ts");
    const css = source("./native-shell.css");
    expect(review).toContain("agent-review-overlay");
    expect(review).toContain("<EvidenceReview");
    expect(review).toContain("<ExecutionReview");
    expect(review).toContain("<ReportArtifact");
    expect(review).toContain("useDismissOnEscape");
    expect(review).not.toContain("Workspace");
    expect(review).not.toContain('data-testid="decision-history"');
    expect(review).not.toContain('data-testid="task-baselines"');
    expect(review).not.toContain('data-testid="task-drift"');
    expect(review).not.toContain('data-testid="task-revisit"');
    expect(review).not.toContain("remediation-plan-page");
    expect(model).toContain('export type ReviewSurface = "evidence" | "execution" | "report"');
    expect(model).not.toContain('"overview"');
    expect(commands).toContain("openAgentReview");
    expect(commands).toContain("openAgentExecution");
    expect(css).toContain(".agent-review-overlay");
    expect(css).toContain("position: absolute");
    expect(source("./EvidenceReview.tsx")).toContain('data-testid="evidence-review"');
    expect(source("./ExecutionReview.tsx")).toContain("export function ExecutionReview");
    expect(source("./ReportArtifact.tsx")).toContain("export function ReportArtifact");
  });

  it("keeps Settings to model + storage + general + safety, as a dialog", () => {
    const settings = source("../components/SettingsDialog.tsx");
    expect(settings).toContain('data-testid="settings-dialog"');
    expect(settings).toContain("<ModelProvidersPanel");
    expect(settings).toContain("<CloudProvidersPanel");
    expect(settings).toContain('t("settings.safetyTitle")');
    expect(settings).not.toContain('data-testid="settings-price-table"');
    expect(settings).not.toContain("PriceTableSection");
    expect(settings).not.toContain("getPriceTable");
    absent("../views/ProvidersView.tsx");
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
    expect(doc).toContain("shownIdRef");
    expect(doc).toContain("if (id !== shownIdRef.current) setEarlier([])");
  });

  it("uses task-native keyboard contracts", () => {
    const shortcuts = source("../shortcuts.ts");
    const app = source("../App.tsx");
    const boundary = source("../components/AgentTask.tsx");
    const implementation = source("../components/AgentTaskImplementation.tsx");
    const viewport = source("../hooks/useTaskViewport.ts");
    const nav = source("../lib/taskNavigation.ts");
    const css = source("./native-document.css");
    expect(shortcuts).toContain('"newTask"');
    expect(shortcuts).toContain('"toggleTaskNavigation"');
    expect(shortcuts).toContain('"review"');
    expect(shortcuts).not.toContain('"newChat"');
    expect(shortcuts).not.toContain('"toggleRail"');
    expect(app).toContain('matches(event, "newTask")');
    expect(app).toContain('matches(event, "toggleTaskNavigation")');
    expect(app).toContain('matches(event, "stop")');
    expect(app).toContain('matches(event, "focusComposer")');
    expect(boundary).toContain('matches(event, "nextStep")');
    expect(boundary).toContain('matches(event, "prevStep")');
    expect(boundary).not.toContain("stopImmediatePropagation");
    expect(boundary).toContain("scrollTo");
    expect(boundary).not.toContain("scrollIntoView");
    expect(boundary).toContain("RELEASE_TASK_FOLLOW_EVENT");
    expect(viewport).toContain("RELEASE_TASK_FOLLOW_EVENT");
    expect(nav).toContain("TASK_STEP_SCROLL_MARGIN = 72");
    expect(css).toContain("scroll-margin-top: 72px");
    expect(implementation).not.toContain('matches(event, "nextStep")');
    const palette = source("../components/CommandPalette.tsx");
    expect(palette).toContain('data-testid="command-palette"');
    expect(palette).not.toContain("review-overview");
    expect(palette).not.toContain("New investigation");
  });

  it("renders deterministic SVG figures from provenance inside the latest Work Result", () => {
    const pkg = source("../../package.json");
    const figures = source("../viz/AnalysisFigures.tsx");
    const extract = source("../viz/extract.ts");
    const task = source("../components/AgentTaskImplementation.tsx");
    const mark = source("../viz/ProvenanceMark.tsx");
    expect(pkg).not.toMatch(/recharts|chart\.js|d3|plotly|nivo|visx|highcharts/i);
    expect(figures).toContain('data-testid="analysis-figures"');
    expect(figures).toContain("Cost axis withheld");
    expect(extract).toContain("Never invent a day the runtime did not emit");
    expect(task).toContain("task-analysis-figures");
    expect(task).toContain("figures={latest");
    expect(mark).toContain("No direct evidence chain");
    expect(source("../api.ts")).toContain("/agent-tasks/${taskId}/provenance");
    expect(source("./AgentReviewPanel.tsx")).not.toContain("AnalysisFigures");
  });

  it("keeps the presentation on tokens: one neutral ladder, an ink primary, hairline depth", () => {
    const css = source("../index.css");
    const shell = source("./native-shell.css");
    const document = source("./native-document.css");
    expect(css).toContain("--accent: #ececec");
    expect(css).toContain("--accent: #0d0d0d");
    expect(css).not.toContain("#ff6b35");
    expect(css).not.toContain("#c73a00");
    expect(css).toContain("--doc-measure: 46rem");
    expect(css).toContain("--doc-track: 64rem");
    expect(shell).not.toContain("box-shadow: 0 8px");
    expect(document).toContain(".agent-result-prose > :not(.agent-result-wide)");
    expect(document).toContain(".native-composer");
    expect(document).toContain(".native-start-greeting");
    expect(source("../../tailwind.config.js")).not.toContain("magazine");
  });
});

/**
 * v1.10.0 — Native Agent, Codex parity.
 *
 * The OS shell is real (menu bar, deep links, notifications, summon shortcut,
 * window title) and reaches the window through ONE bridge; the runtime names
 * tasks and takes a reasoning effort; Execution detail and the provider panes
 * are native documents; the pre-v0.94 message paths are gone.
 */
describe("v1.10.0 native shell, runtime and pane boundaries", () => {
  it("has one shell bridge, and every event it listens for is emitted by lib.rs", () => {
    const bridge = source("../hooks/useNativeAgent.ts");
    const rust = source("../../../src-tauri/src/lib.rs");
    const conf = source("../../../src-tauri/tauri.conf.json");
    const app = source("../App.tsx");
    for (const event of ["deep-link-request", "menu-command", "shortcut-event"]) {
      expect(bridge).toContain(`"${event}"`);
      expect(rust).toContain(`"${event}"`);
    }
    for (const command of ["notify", "set_window_title", "open_app_folder"]) {
      expect(bridge).toContain(`"${command}"`);
      expect(rust).toContain(`fn ${command}(`);
    }
    // Menu ids are one list, declared on both sides.
    const ids = [...bridge.matchAll(/^\s+"([a-z-]+)",$/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThanOrEqual(12);
    for (const id of ids) expect(rust).toContain(`("${id}",`);
    expect(rust).toContain("fn build_menu");
    expect(rust).toContain(".on_menu_event(");
    expect(rust).toContain("on_open_url");
    expect(rust).toContain("on_shortcut(");
    expect(conf).toContain('"schemes"');
    expect(conf).toContain('"storage-agent"');
    // The old stubs that waited for events nobody sent are gone.
    expect(bridge).not.toContain("useTaskNotifications");
    expect(bridge).not.toContain("useGlobalShortcut");
    expect(bridge).not.toContain("useDeepLink");
    // The menu dispatches through the same handler as the keyboard and palette.
    expect(app).toContain("useNativeShell(");
    expect(app).toContain("onMenuCommand: runCommand");
    expect(app).toContain('runCommand("palette")');
    expect(app).toContain("useSettleNotifications");
    expect(app).toContain("setNativeWindowTitle");
  });

  it("titles tasks from the runtime and takes a reasoning effort only where the model can", () => {
    const chip = source("../components/ModelChip.tsx");
    const types = source("../types.ts");
    const runtime = source("../../../sidecar/app/task_runtime/runtime.py");
    const titling = source("../../../sidecar/app/task_runtime/titling.py");
    const migrations = source("../../../sidecar/app/migrations.py");
    expect(chip).toContain("reasoning_capable");
    expect(chip).toContain('data-testid="model-chip-effort-menu"');
    expect(chip).toContain("updateModelProvider");
    expect(chip).not.toContain("gpt-");
    expect(types).toContain("reasoning_effort: ReasoningEffort | null");
    expect(runtime).toContain("titling.run_title_step(");
    expect(runtime).toContain('"task.titled"');
    expect(titling).toContain("title_source = 'user'");
    expect(titling).toContain("TITLE_MARKER");
    expect(migrations).toContain('(28, "native_agent_titles_effort", _M028)');
    expect(migrations).toContain("ALTER TABLE sessions ADD COLUMN title_source TEXT;");
  });

  it("reads Execution detail as a document in the sheet and the providers as native panes", () => {
    const detail = source("../components/ExecutionDetailImplementation.tsx");
    const css = source("./native-shell.css");
    expect(detail).toContain("native-execution-doc");
    expect(detail).toContain("<LiveTrace");
    expect(detail).toContain('data-testid="execution-status"');
    expect(detail).toContain('data-testid="execution-error"');
    expect(detail).not.toContain("metrics-cards");
    expect(detail).not.toContain("AccountProfilePanel");
    expect(detail).not.toContain("ExecutionSteps");
    expect(detail).not.toContain("grid-cols-2");
    // No override block forcing the old run page into the sheet.
    expect(css).not.toContain('[data-testid="execution-detail"] > div > header');
    expect(css).not.toContain('[data-testid="metrics-cards"]');
    expect(css.split("\n").filter((line) => line.includes("execution-detail") && line.includes("!important"))).toEqual([]);
    absent("../components/ExecutionSteps.tsx");
    absent("../components/AccountProfilePanel.tsx");
    absent("../views/ProvidersView.tsx");
    const model = source("../settings/ModelProvidersPane.tsx");
    const cloud = source("../settings/CloudProvidersPane.tsx");
    const presets = source("../settings/presets.ts");
    expect(model).toContain("MODEL_PRESETS");
    expect(model).toContain('data-testid="model-presets"');
    expect(model).toContain('data-testid="model-test-status"');
    expect(cloud).toContain("CLOUD_PRESETS");
    expect(cloud).toContain("<CloudProviderTester");
    expect(presets).toContain('label: "Custom (S3-compatible)"');
    expect(presets).toContain('label: "Ollama"');
    expect(presets).toContain('label: "MinIO"');
    const agent = source("../components/NativeAgentPanel.tsx");
    expect(agent).toContain("openNativeFolder");
    expect(agent).toContain("getGlobalOtelExport");
    expect(agent).toContain("STORAGE_AGENT_ENABLE_MCP=1");
    expect(agent).not.toContain("GET /agent-tasks");
  });

  it("has one submit path: the execution runner, with no session-message client", () => {
    const api = source("../api.ts");
    expect(api).not.toContain("postSessionMessage");
    expect(api).not.toContain("streamSessionMessage");
    expect(api).not.toContain("/messages/stream");
    expect(api).toContain("createTaskExecution");
    expect(api).toContain("followExecutionEvents");
  });

  it("keeps the Composer the one attach path, dropped files included, and the sidebar keyboard-navigable", () => {
    const composer = source("../components/Composer.tsx");
    const navigation = source("./AgentTaskNavigation.tsx");
    expect(composer).toContain("onDrop=");
    expect(composer).toContain("acceptFile(file)");
    expect(composer).toContain('data-dragging=');
    expect(navigation).toContain('role="listbox"');
    expect(navigation).toContain("onListKeyDown");
    expect(navigation).toContain("editRequest");
  });
});
