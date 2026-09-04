import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
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
    expect(shell).toContain("<ArtifactsPanel");
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
    expect(navigation).not.toContain("<kbd");
    expect(navigation).not.toContain("EmptyState");
    expect(model).toContain("DEFAULT_TASK_NAV_WIDTH");
    expect(model).toContain("clampTaskNavigationWidth");
    expect(model).toContain("onRename");
    expect(model).toContain("onDelete");
    expect(model).not.toContain("onTogglePin");
    expect(model).not.toContain("onFork");
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
    expect(composer).toContain("Describe the storage work to delegate…");
    expect(composer).toContain("描述要委派的存储工作…");
    expect(composer).not.toContain("Ask about your storage");
    expect(composer).not.toContain("问问你的存储");
    expect(composer).not.toContain("Give the Agent a goal");
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

  it("renders the Task as one turn transcript with no chat chrome", () => {
    const turn = source("../components/TranscriptTurn.tsx");
    const items = source("../components/TranscriptItems.tsx");
    const group = source("../components/WorkedGroup.tsx");
    const task = source("../components/TaskDocument.tsx");
    const root = source("../components/AgentTaskImplementation.tsx");
    const banners = source("../components/TaskBanners.tsx");
    expect(turn).toContain('data-testid="turn-user"');
    expect(turn).toContain('data-testid="work-result"');
    expect(turn).toContain('data-testid="turn-answer"');
    expect(turn).toContain("turn-user-bubble");
    expect(turn).not.toContain("AnswerDocument");
    expect(turn).not.toContain("onBranch");
    expect(turn).not.toContain("onRerun");
    expect(turn).not.toContain("redirect-direction");
    expect(turn).not.toContain("native-direction");
    expect(turn).not.toContain("native-result");
    expect(turn).not.toContain("resultShape");
    expect(items).toContain('data-testid="turn-commentary"');
    expect(items).toContain("<WorkedGroup");
    expect(items).toContain("<ApprovalCard");
    expect(group).toContain('data-testid="worked-group"');
    expect(group).toContain('data-testid="worked-row"');
    expect(group).toContain("native-execution-head");
    expect(group).toContain('"data-testid": "trace-row-open"');
    expect(task).toContain('import { AgentTurn, UserTurn } from "./TranscriptTurn"');
    expect(task).toContain("<AgentTurn");
    expect(task).toContain("<UserTurn");
    expect(source("../hooks/useApprovals.ts")).toContain("turnItemsOf(");
    expect(task).toContain('data-testid="task-scroll"');
    expect(task).toContain("task-item-");
    expect(task).toContain("data-direction=");
    expect(task).toContain('data-testid="remote-execution"');
    expect(task).toContain('data-testid="task-status"');
    expect(banners).toContain('data-testid="queued-direction"');
    expect(banners).toContain('data-testid="task-resume"');
    expect(root).toContain("runner.resume");
    for (const text of [task, root, banners]) {
      expect(text).not.toContain("MessageCard");
      expect(text).not.toContain("TaskContent");
      expect(text).not.toContain("ThinkingBubble");
      expect(text).not.toContain("ExecutionSummary");
      expect(text).not.toContain('data-testid="thread-scroll"');
      expect(text).not.toContain('data-testid="task-verify"');
      expect(text).not.toContain("delegate-suggestion");
    }
  });

  it("makes the empty start a greeting and the Composer, with no wizard or SKU catalog", () => {
    const task = source("../components/AgentTaskImplementation.tsx");
    const app = source("../App.tsx");
    expect(task).toContain('data-testid="task-start"');
    expect(task).toContain("native-start-greeting");
    expect(task).toContain("{composerNode}");
    expect(source("../components/TaskComposerHost.tsx")).toContain("void runner.submit");
    expect(task).not.toContain("FirstRunFlow");
    expect(task).not.toContain("showFirstRun");
    expect(task).not.toContain("delegate-suggestion");
    expect(task).not.toContain("<h1");
    expect(app).not.toContain("FirstRunWizard");
    absent("../hooks/useFirstRun.ts");
    absent("../lib/firstRun.ts");
  });

  it("raises approvals inline from gated tool calls, with Allow / Allow for this task / Deny", () => {
    const card = source("../components/ApprovalCard.tsx");
    const task = source("../components/TaskDocument.tsx");
    const approvals = source("../hooks/useApprovals.ts");
    const model = source("../lib/turnItems.ts");
    const api = source("../api/runtime.ts");
    expect(card).toContain('data-testid="approval-card"');
    expect(card).toContain('data-testid="approval-allow"');
    expect(card).toContain('data-testid="approval-allow-task"');
    expect(card).toContain('data-testid="approval-deny"');
    expect(card).toContain('data-testid="approval-impact"');
    expect(card).not.toContain("Decision required");
    expect(approvals).toContain("resolveTaskDecision(");
    expect(task).toContain("<ApprovalCard");
    for (const text of [task, approvals, source("../components/AgentTaskImplementation.tsx")]) {
      expect(text).not.toContain("durable-pending-decisions");
      expect(text).not.toContain("EvidenceImportDialog");
      expect(text).not.toContain("AgentNextAction");
    }
    expect(model).toContain("export function openApproval(");
    expect(api).toContain('"approval.opened"');
    expect(api).toContain('"message.completed"');
    expect(api).toContain('"decision.resolved"');
    expect(api).toContain("scope ? { scope }");
    expect(api).not.toContain("approveDecisionOrPrepare");
    expect(api).not.toContain("prepareSessionAction");
    // The proposal-era modules are physically gone.
    absent("../components/AgentDecisionCard.tsx");
    absent("../components/EvidenceImportDialog.tsx");
    absent("../components/AgentTaskResult.tsx");
    absent("../components/AgentResultRenderer.tsx");
    absent("../components/ExecutionMetrics.tsx");
    absent("../components/Chart.tsx");
  });

  it("keeps Artifacts a right split beside the Task: Evidence, Reports, Plans, Baselines & Drift, Execution", () => {
    const panel = source("./ArtifactsPanel.tsx");
    const shell = source("./AgentShell.tsx");
    const model = source("./model.ts");
    const commands = source("./commands.ts");
    const css = source("./native-shell.css");
    absent("./AgentReviewPanel.tsx");
    absent("./ExecutionReview.tsx");
    expect(panel).toContain('data-testid="agent-artifacts-panel"');
    expect(panel).toContain("data-testid={`artifacts-section-${id}`}");
    for (const section of ["evidence", "reports", "plans", "baselines", "execution"]) {
      expect(panel).toContain(`"${section}"`);
    }
    expect(panel).toContain('data-testid="artifacts-back"');
    expect(panel).toContain("<EvidenceReview");
    expect(panel).toContain("<ReportArtifact");
    expect(panel).toContain("<ExecutionDetail");
    expect(panel).not.toContain("Workspace");
    expect(panel).not.toContain('role="tablist"');
    expect(panel).not.toContain("remediation-plan-page");
    expect(model).toContain('export type ArtifactKind = "evidence" | "report" | "plan" | "baseline" | "execution"');
    expect(model).not.toContain("ReviewSurface");
    expect(model).not.toContain('"overview"');
    expect(commands).toContain("toggleAgentArtifacts");
    expect(commands).toContain("openAgentArtifacts");
    expect(commands).toContain("openAgentReview");
    expect(commands).toContain("openAgentExecution");
    // A split, not a sheet: the panel is a flex sibling of the document; only
    // the narrow-window fallback paints a scrim.
    expect(css).toContain(".agent-artifacts-panel");
    expect(css).not.toContain(".agent-review-overlay");
    expect(shell).toContain('data-artifacts={open ? "open" : "closed"}');
    expect(shell).toContain("overlay={narrow}");
    expect(source("./EvidenceReview.tsx")).toContain('data-testid="evidence-review"');
    expect(source("./ReportArtifact.tsx")).toContain("export function ReportArtifact");
    expect(source("../App.tsx")).toContain('case "review": toggleAgentArtifacts(); break;');
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
    const api = source("../api/runtime.ts");
    expect(impl).toContain("followExecutionEvents");
    expect(impl).toContain("liveHandlers(");
    expect(impl).not.toContain("streamText");
    expect(impl).not.toContain("proposals");
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
    expect(doc).toContain('active.status === "waiting"');
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
    const task = source("../components/TaskDocument.tsx");
    const mark = source("../viz/ProvenanceMark.tsx");
    expect(pkg).not.toMatch(/recharts|chart\.js|d3|plotly|nivo|visx|highcharts/i);
    expect(figures).toContain('data-testid="analysis-figures"');
    // v1.14 — figure copy lives in i18n, referenced by key from the renderer.
    expect(figures).toContain('t("viz.costWithheld")');
    expect(source("../i18n.tsx")).toContain('"viz.costWithheld": "Cost axis withheld."');
    expect(extract).toContain("Never invent a day the runtime did not emit");
    expect(task).toContain("task-analysis-figures");
    expect(task).toContain("figures={figuresFor(item)}");
    // v1.14 — provenance gaps are localized through the same key.
    expect(mark).toContain('t("viz.noChain")');
    expect(source("../api/tasks.ts")).toContain("/agent-tasks/${taskId}/provenance");
    expect(source("./ArtifactsPanel.tsx")).not.toContain("AnalysisFigures");
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
    expect(document).toContain(".agent-table-grid");
    expect(document).toContain(".turn-user-bubble");
    expect(document).not.toContain(".agent-result-wide");
    expect(document).not.toContain(".native-decision");
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
    expect(detail).toContain("<TranscriptItems");
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
    const api = ["../api.ts", "../api/client.ts", "../api/runtime.ts", "../api/tasks.ts", "../api/settings.ts", "../api/providers.ts"]
      .map((relative) => source(relative)).join("\n");
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

/**
 * v1.11.0 — Codex parity for the shell (R5).
 *
 * The sidebar groups by day and states the read-only floor; the Composer
 * stops on an empty Esc and carries a context meter fed only by runtime
 * metrics; the start greeting rotates; an approval is a Working task in the
 * title bar; the OS window remembers its geometry through the Rust plugin.
 */
describe("v1.11.0 shell details", () => {
  it("groups the sidebar by day with Settings alone in the footer", () => {
    const navigation = source("./AgentTaskNavigation.tsx");
    const copy = source("./navigationCopy.ts");
    const css = source("./native-shell.css");
    expect(navigation).toContain("export function dayGroups(");
    expect(navigation).toContain('data-testid="task-group"');
    expect(navigation).toContain("Intl.DateTimeFormat");
    // v1.15 — the footer is Settings alone; the read-only policy lives in
    // Settings → Safety. The painted footer fact clipped to "之读".
    expect(navigation).not.toContain('data-testid="sidebar-read-only"');
    expect(navigation).not.toContain("copy.readOnly");
    expect(navigation).not.toContain('role="switch"');
    expect(navigation).not.toContain("Previous 7 days");
    expect(copy).not.toContain("readOnly");
    expect(css).toContain(".native-task-group + .native-task-group");
    // No yellow: an approval waiting on the user is a Working task.
    expect(css).not.toMatch(/\[data-state="decision"\] \.native-task-mark \{[^}]*--warn/);
  });

  it("stops on an empty Esc and meters context only from runtime metrics", () => {
    const composer = source("../components/Composer.tsx");
    const meter = source("../components/ContextMeter.tsx");
    const app = source("../App.tsx");
    const shortcuts = source("../shortcuts.ts");
    expect(composer).toContain('event.key === "Escape"');
    expect(composer).toContain("if (busy && !text.trim()) { event.preventDefault(); onStop(); }");
    expect(composer).not.toContain("<ContextMeter />");
    expect(source("../components/ModelChip.tsx")).toContain("<ContextMeter />");
    // The Esc branch returns before any history / clear handling runs, and
    // stops propagation so one keypress never also closes an overlay.
    expect(composer).toMatch(/if \(event\.key === "Escape"\) \{[\s\S]*?event\.stopPropagation\(\);[\s\S]*?if \(busy && !text\.trim\(\)\) \{ event\.preventDefault\(\); onStop\(\); \}[\s\S]*?return;\s*\}/);
    // v1.15 — one usage vocabulary in lib/usage; silence renders a badge.
    expect(source("../lib/usage.ts")).toContain("context_window");
    expect(source("../lib/usage.ts")).toContain("export function contextReading(");
    expect(source("../lib/usage.ts")).toContain("export function formatUsageLine(");
    expect(meter).toContain("contextReading");
    expect(meter).toContain('data-testid="context-meter"');
    expect(meter).toContain('data-state="unreported"');
    expect(meter).not.toContain("128000");
    expect(app).toContain("<ActiveTaskContext.Provider value={activeTaskId}>");
    expect(shortcuts).toContain('id: "stopEmpty"');
  });

  it("rotates the start greeting and names a waiting approval in the title bar", () => {
    const greeting = source("./startGreeting.ts");
    const copy = source("./navigationCopy.ts");
    expect(greeting).toContain("export const START_GREETINGS");
    expect(greeting).toContain("export function pickStartGreeting(");
    expect(greeting).toContain('"What should the Agent work on?"');
    expect(greeting).toContain('"让 Agent 处理什么？"');
    expect(copy).toContain('decision: "Waiting for approval"');
    expect(copy).toContain('decision: "等待批准"');
    expect(copy).not.toContain("Needs decision");
    expect(copy).toContain('working: "Working"');
    expect(copy).toContain('attention: "Needs attention"');
  });

  it("remembers the window's geometry through the Rust window-state plugin alone", () => {
    const cargo = source("../../../src-tauri/Cargo.toml");
    const lock = source("../../../src-tauri/Cargo.lock");
    const rust = source("../../../src-tauri/src/lib.rs");
    const capability = source("../../../src-tauri/capabilities/default.json");
    const pkg = source("../../package.json");
    expect(cargo).toContain('tauri-plugin-window-state = "2"');
    expect(lock).toContain('name = "tauri-plugin-window-state"');
    expect(rust).toContain(".plugin(tauri_plugin_window_state::Builder::new().build())");
    expect(rust.indexOf("tauri_plugin_single_instance::init")).toBeLessThan(rust.indexOf("tauri_plugin_window_state::Builder"));
    expect(capability).toContain('"window-state:default"');
    expect(pkg).not.toContain("@tauri-apps/plugin-window-state");
  });

  it("carries no English tokens in the Chinese shell copy", () => {
    const shortcuts = source("../shortcuts.ts");
    const zhLabels = [...shortcuts.matchAll(/zh: "([^"]+)"/g)].map((m) => m[1]);
    expect(zhLabels.length).toBeGreaterThan(10);
    for (const label of zhLabels) expect(label, label).not.toMatch(/\b(Task|Step|Composer|Review|Evidence|Delegate|Steer|Agent)\b/);
    for (const file of ["../components/Composer.tsx", "./navigationCopy.ts", "../components/ModelChip.tsx", "../components/CommandPalette.tsx"]) {
      const text = source(file);
      expect(text, file).not.toMatch(/"[^"]*[\u4e00-\u9fff][^"]*\b(Task|Step|Composer|Delegate|Steer)\b[^"]*"/);
    }
  });
});

/**
 * v1.11.0 — Codex parity for the transcript.
 *
 * A turn is user bubble → commentary · worked group · approval → answer, fed
 * by ONE item list live and durable. Tables scroll in place; the metadata
 * block, the Decision card, the artifact chip row and the metrics footer are gone.
 */
describe("v1.11.0 turn transcript boundaries", () => {
  it("feeds live and durable turns through the same item model", () => {
    const model = source("../lib/turnItems.ts");
    const runs = source("../sessionRuns.ts");
    const runner = source("../hooks/useTurnRunnerImplementation.ts");
    const doc = source("../hooks/useSessionDocument.ts");
    expect(model).toContain("export function turnItemsOf(");
    expect(model).toContain("export function completeMessage(");
    expect(model).toContain("export function segmentsOf(");
    expect(runs).toContain("items: TurnItem[]");
    expect(runs).toContain("answer: string | null");
    expect(runs).toContain("waiting: boolean");
    expect(runs).not.toContain("streamText");
    expect(runs).not.toContain("proposals");
    expect(runner).toContain("onMessageCompleted");
    expect(runner).toContain("onApprovalOpened");
    expect(runner).toContain("onDecisionResolved");
    expect(doc).toContain("liveHandlers(sessionId)");
  });

  it("keeps the answer a Markdown page: whole tables, no chart toggle, no chip row, no footer", () => {
    const md = source("../components/MarkdownImplementation.tsx");
    const turn = source("../components/TranscriptTurn.tsx");
    const task = source("../components/AgentTaskImplementation.tsx") + source("../components/TaskDocument.tsx");
    expect(md).toContain("agent-table-grid");
    expect(md).not.toContain("agent-table-scroll");
    expect(md).not.toContain("chart-toggle");
    expect(md).not.toContain("mask-image");
    expect(md).not.toContain("agent-result-wide");
    expect(turn).not.toContain("work-result-open-report");
    expect(turn).not.toContain("TurnMetricsBar");
    expect(task).not.toContain("TurnMetricsBar");
    expect(task).not.toContain("nextActions");
    expect(task).not.toContain("proposed_actions");
  });

  it("renders the persisted answer without a metadata block", () => {
    const e2e = source("../../e2e/agent.spec.ts");
    expect(e2e).not.toContain("next_action_proposals: [");
    expect(e2e).toContain('"turn-commentary"');
    expect(e2e).toContain('"worked-group"');
  });
});

/**
 * v1.12.0 — native all the way through: the plan the model owns, the
 * compaction marker, task status on the stream, the approval policy pane,
 * the instructions file, and a wall-clock "Worked for".
 */
describe("v1.12.0 native runtime", () => {
  it("renders the plan card only from a `plan` turn item the runtime emitted", () => {
    const card = source("../components/PlanCard.tsx");
    const items = source("../components/TranscriptItems.tsx");
    const model = source("../lib/turnItems.ts");
    const runner = source("../hooks/useTurnRunnerImplementation.ts");
    const api = source("../api/runtime.ts");
    expect(card).toContain('data-testid="plan-card"');
    expect(card).toContain('data-testid="plan-step"');
    expect(card).toContain("data-status={step.status}");
    expect(card).toContain("The UI never invents a step");
    expect(items).toMatch(/segment\.kind === "plan"[\s\S]{0,120}<PlanCard/);
    expect(items).toContain('data-testid="context-compacted"');
    expect(model).toContain("export function applyPlan(");
    expect(model).toContain("export function applyCompacted(");
    expect(model).toContain('ref.kind === "plan"');
    expect(model).toContain('ref.kind === "compacted"');
    expect(runner).toContain("onPlanUpdated");
    expect(runner).toContain("onContextCompacted");
    expect(runner).toContain("onTaskStatus");
    expect(api).toContain('type === "plan.updated"');
    expect(api).toContain('type === "context.compacted"');
    expect(api).toContain('type === "task.status"');
    // Only the transcript items renderer mounts the card.
    for (const relative of ["../components/AgentTaskImplementation.tsx", "../components/TaskDocument.tsx", "../components/TranscriptTurn.tsx", "../components/ExecutionDetailImplementation.tsx"]) {
      expect(source(relative)).not.toContain("<PlanCard");
    }
  });

  it("reads task status from the stream and never polls /state on an interval while following", () => {
    const doc = source("../hooks/useSessionDocument.ts");
    const runs = source("../sessionRuns.ts");
    expect(doc).toContain("applyTaskStatus(");
    expect(doc).toContain("run.taskStatus");
    expect(doc).toContain("tickRef");
    expect(doc).not.toMatch(/\.busy\)\s*\{[^}]*setTimeout\(tick/);
    expect(runs).toContain("taskStatus: TaskStatusPayload | null");
    expect(runs).toContain("contextTokens: number | null");
  });

  it("times a worked group by wall-clock, not by a sum of call durations", () => {
    const group = source("../components/WorkedGroup.tsx");
    expect(group).toContain("export function groupSpanMs(");
    expect(group).toContain("export function groupStartMs(");
    expect(group).toContain('data-testid="worked-elapsed"');
    expect(group).not.toContain("sum +=");
  });

  it("puts the approval policy in Settings → Safety and the instructions file in Skills & bridges", () => {
    const pane = source("../settings/SafetyPane.tsx");
    const settings = source("../components/SettingsDialog.tsx");
    const agent = source("../components/NativeAgentPanel.tsx");
    const api = source("../api/settings.ts");
    expect(settings).toContain("<SafetyPane");
    expect(settings).toContain('t("settings.safety")');
    expect(pane).toContain('data-testid="approval-policy"');
    expect(pane).toContain("data-testid={`approval-policy-${policy}`}");
    expect(pane).toContain('["ask", "allow_session", "allow_always"]');
    expect(pane).toContain("putApprovalPolicy(");
    expect(pane).toContain('data-testid="approval-gated-tools"');
    expect(agent).toContain("getInstructionsStatus");
    expect(agent).toContain('data-testid="instructions-open"');
    expect(agent).toContain('openNativeFolder("data")');
    expect(api).toContain('"/settings/approval-policy"');
    expect(api).toContain('"/settings/instructions"');
  });

  it("compacts context from the palette and drops the meter to the compacted figure", () => {
    const palette = source("../components/CommandPalette.tsx");
    const actions = source("./paletteActions.ts");
    const meter = source("../components/ContextMeter.tsx");
    const hook = source("../hooks/useCompactContext.ts");
    const card = source("../components/ApprovalCard.tsx");
    const i18n = source("../i18n.tsx");
    // v1.16 — palette copy lives in the i18n dict; engines + shortcuts entries exist.
    expect(palette).toContain('t("palette.compact")');
    expect(i18n).toContain('"palette.compact"');
    expect(palette).toContain('t("palette.shortcuts")');
    expect(palette).toContain('group: "engine"');
    expect(palette).toContain('data-testid={`command-palette-${command.group}s`}');
    expect(palette).toContain("live.hasTask && !live.busy && !live.compacting && live.compact");
    expect(actions).toContain("compact?: () => void");
    expect(meter).toContain("run.contextTokens");
    expect(hook).toContain("compactTaskContext(");
    expect(hook).toContain("toast.success");
    expect(card).toContain('t("approval.policySession")');
    expect(i18n.match(/\/\/ v1\.12 transcript/g)).toHaveLength(2);
  });
});

/**
 * v1.12.0 — one protocol, one log, one split (W1 · W6).
 *
 * The frontend speaks the durable runtime only: no session-message client, no
 * turn-cancel path, no evidence-import flow, no `/runs` engine API in the
 * product UI. Execution detail replays the same durable log the transcript
 * follows. The document, the runner and the client are split by responsibility.
 */
describe("v1.12.0 one protocol and the frontend split", () => {
  const productionSources = (): Array<[string, string]> => {
    const root = join(process.cwd(), "src");
    const out: Array<[string, string]> = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = join(dir, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !child.includes("/test/")) {
          out.push([relative(root, child), readFileSync(child, "utf8")]);
        }
      }
    };
    walk(root);
    return out;
  };

  it("carries none of the retired session-message protocol", () => {
    const retired: Array<[string, RegExp]> = [
      ["session message POST", /\/sessions\/\$\{[a-zA-Z]+\}\/messages(?:\/stream)?["'`]/],
      ["session message stream", /\/messages\/stream/],
      ["turn cancel path", /\/turns\/\$\{[a-zA-Z]+\}\/cancel|cancelSessionTurn/],
      ["turn state poll", /\/sessions\/\$\{[a-zA-Z]+\}\/turn["'`]|getSessionTurn(?:State)?|SessionTurnState/],
      ["action prepare", /\/actions\/prepare|prepareSessionAction/],
      ["legacy frames", /legacy_frames/],
      ["proposed actions", /proposed_actions|ProposedAction/],
      ["evidence-import clients", /\/evidence-imports|planEvidenceImport|confirmEvidenceImport|runEvidenceImport|getEvidenceImport|EvidenceImportRunResult/],
      ["runs engine API", /["'`]\/runs\/|runEventsUrl|getRun\(|getAccountProfile|\bRunDetail\b|\bRunEvent\b/],
    ];
    const files = productionSources();
    for (const [label, pattern] of retired) {
      const offenders = files.filter(([, text]) => pattern.test(text)).map(([path]) => path);
      expect(offenders, label).toEqual([]);
    }
  });

  it("splits the client by responsibility behind one barrel", () => {
    for (const relative of ["../api/client.ts", "../api/runtime.ts", "../api/tasks.ts", "../api/settings.ts", "../api/providers.ts"]) {
      expect(existsSync(new URL(relative, import.meta.url)), relative).toBe(true);
    }
    const barrel = source("../api.ts");
    for (const module of ["client", "runtime", "tasks", "settings", "providers"]) {
      expect(barrel).toContain(`export * from "./api/${module}"`);
    }
    expect(barrel).not.toContain("fetch(");
    const runtime = source("../api/runtime.ts");
    expect(runtime).toContain("/agent-tasks/${taskId}/executions");
    expect(runtime).toContain("/executions/${executionId}/events?after=${after}");
    expect(runtime).toContain("export function dispatchDurableEvent(");
    expect(runtime).toContain("export const listTaskEvents");
    expect(runtime).toContain("export const getTaskExecution");
    expect(runtime).toContain("export const stopTaskExecution");
    expect(runtime).toContain("export const compactTaskContext");
    const tasks = source("../api/tasks.ts");
    expect(tasks).toContain("/sessions/${id}/activity/${encodeURIComponent(callId)}");
    expect(tasks).not.toContain("/agent-tasks/${taskId}/executions");
    const settings = source("../api/settings.ts");
    expect(settings).toContain('"/settings/approval-policy"');
    expect(settings).toContain('"/settings/instructions"');
    expect(settings).toContain('"/settings/price-table"');
    const providers = source("../api/providers.ts");
    expect(providers).toContain('"/model-providers"');
    expect(providers).toContain('"/cloud-providers"');
    // The runner has one cancel path.
    const runner = source("../hooks/useTurnRunnerImplementation.ts");
    expect(runner).toContain("stopTaskExecution");
    expect(runner).not.toContain("cancelSessionTurn");
    expect(runner).not.toContain("legacy");
  });

  it("splits the Task document by responsibility behind one thin root", () => {
    const root = source("../components/AgentTaskImplementation.tsx");
    const document = source("../components/TaskDocument.tsx");
    const banners = source("../components/TaskBanners.tsx");
    const host = source("../components/TaskComposerHost.tsx");
    const approvals = source("../hooks/useApprovals.ts");
    expect(root).toContain("<TaskDocument");
    expect(root).toContain("<TaskBanners");
    expect(root).toContain("<TaskComposerHost");
    expect(root).toContain("useApprovals(");
    expect(root).toContain("useTaskComposer(");
    expect(root).toContain("useComposerActions(");
    expect(root.split("\n").length).toBeLessThan(320);
    expect(root).not.toContain("<AgentTurn");
    expect(root).not.toContain("<Composer ");
    expect(root).not.toContain("findRanges");
    expect(document).toContain("export function TaskDocument(");
    expect(document).toContain("export function useTaskItems(");
    expect(document).toContain("<FindBar");
    expect(document).toContain('data-testid="load-earlier"');
    expect(document).toContain('data-testid="jump-to-latest"');
    expect(banners).toContain("export function TaskBanners(");
    expect(banners).toContain('data-testid="offline-banner"');
    expect(host).toContain("export function useTaskComposer(");
    expect(host).toContain("export function useComposerActions(");
    expect(host).toContain("export function TaskComposerHost(");
    expect(host).toContain("<Composer");
    expect(host).toContain("runner.steer(");
    expect(host).toContain("runner.stop()");
    expect(approvals).toContain("export function useApprovals(");
    expect(approvals).toContain("unplacedApprovals(");
    expect(source("../components/taskCopy.ts")).toContain("export function useTaskCopy(");
  });

  it("reads Execution detail from the durable log, never from /runs or an EventSource", () => {
    const detail = source("../components/ExecutionDetailImplementation.tsx");
    const boundary = source("../components/ExecutionDetail.tsx");
    const panel = source("./ArtifactsPanel.tsx");
    const projection = source("./useAgentTaskProjection.ts");
    expect(detail).not.toContain("EventSource");
    expect(detail).not.toContain("/runs");
    expect(detail).not.toContain("getRun");
    expect(detail).not.toContain("getReport");
    expect(detail).toContain("getTaskExecution(");
    // v1.13 reads one execution's pages (events-page), not the whole task log.
    expect(detail).toContain("listExecutionEventsPage(");
    expect(detail).not.toContain("listTaskEvents(");
    expect(detail).toContain("dispatchDurableEvent(");
    expect(detail).toContain("followExecutionEvents(");
    expect(detail).toContain("getSession(");
    expect(detail).toContain("export function replayExecutionEvents(");
    expect(detail).toContain('event.event_type === "work_result.recorded"');
    expect(detail).toContain('data-testid="execution-detail-body"');
    expect(detail).toContain('data-testid="execution-status"');
    expect(detail).toContain('data-testid="execution-error"');
    expect(detail).toContain('data-testid="execution-steps"');
    expect(detail).toContain('data-testid="execution-result"');
    expect(detail).toContain("<TranscriptItems");
    // One call's sanitized input/output opens in place through the worked row.
    expect(source("../components/WorkedGroup.tsx")).toContain("<CallDetail");
    expect(source("../components/CallDetail.tsx")).toContain("getSessionCall(");
    expect(detail).toContain("taskId: string;");
    expect(detail).toContain("executionId: string;");
    expect(boundary).not.toContain("runId");
    expect(boundary).toContain("<ExecutionDetailImplementation {...props} />");
    expect(panel).toContain("<ExecutionDetail taskId={taskId} executionId={selection.id}");
    expect(panel).toContain('data-testid="execution-row"');
    expect(panel).not.toContain("executions = detail?.runs");
    expect(panel).not.toContain("execution.run_id");
    expect(panel).toContain("executions.map((execution) => (");
    expect(projection).toContain("listTaskExecutions(");
  });

  it("names the wall-clock of a worked group from its first start to its last finish", () => {
    const group = source("../components/WorkedGroup.tsx");
    const runtime = source("../api/runtime.ts");
    expect(group).toContain("Math.max(...(ends as number[])) - Math.min(...(starts as number[]))");
    expect(group).not.toMatch(/reduce\([^)]*duration_ms/);
    expect(runtime).toContain("started_at: p.started_at ?? seenAt");
    expect(runtime).toContain("finished_at: p.finished_at ?? seenAt");
  });
});

/**
 * v1.13.0 — honesty and completeness: `@` file mentions with a redacted
 * history, fuzzy palette search, the large-scan approval projection,
 * per-execution detail reads, a long-run hint, and a bounded document cache.
 */
describe("v1.13.0 honesty and completeness", () => {
  it("completes `@` files from the Task and never stores secrets in history", () => {
    const composer = source("../components/Composer.tsx");
    const host = source("../components/TaskComposerHost.tsx");
    const root = source("../components/AgentTaskImplementation.tsx");
    expect(composer).toContain('data-testid="composer-mentions"');
    expect(composer).toContain("export function cleanHistory(");
    expect(composer).toContain("mentionables");
    expect(composer).toContain("completeMention(");
    expect(host).toContain("mentionables={mentionables}");
    expect(root).toContain("detail?.attached_files");
    // History entries carrying key material are dropped, values masked.
    expect(composer).toContain("AKIA");
    expect(composer).toContain("***REDACTED***");
  });

  it("ranks palette tasks by fuzzy score, not substring", () => {
    const palette = source("../components/CommandPalette.tsx");
    expect(palette).toContain("export function fuzzyScore(");
    expect(palette).toContain("fuzzyScore(query, command.label)");
  });

  it("projects large-scan bounds on the approval card", () => {
    const card = source("../components/ApprovalCard.tsx");
    const api = source("../api/runtime.ts");
    const i18n = source("../i18n.tsx");
    expect(card).toContain('data-testid="approval-scan-calls"');
    expect(card).toContain("estimated_calls");
    expect(api).toContain("estimated_calls?: number | null");
    expect(api).toContain("buckets?: number | null");
    expect(i18n).toContain('"approval.estimatedCalls"');
    expect(i18n).toContain('"turn.longRunning"');
  });

  it("reads Execution detail per execution and hints at long runs", () => {
    const detail = source("../components/ExecutionDetailImplementation.tsx");
    const api = source("../api/runtime.ts");
    const turn = source("../components/TranscriptTurn.tsx");
    const doc = source("../hooks/useSessionDocument.ts");
    expect(detail).toContain("listExecutionEventsPage(");
    expect(detail).toContain("readExecutionLog(");
    expect(detail).not.toContain("readTaskLog(");
    expect(api).toContain("export const listExecutionEventsPage");
    expect(api).toContain("/executions/${executionId}/events-page");
    expect(turn).toContain('data-testid="turn-long-running"');
    expect(doc).toContain("slice(-200)");
  });
});

/**
 * v1.14.0 — interaction truth and content craft: steer lands on waiting
 * executions (Sidecar), queued work edits, usage rows, localized figures,
 * honest times, keyboard-correct menus, and one clipboard path.
 */
describe("v1.14.0 interaction truth and content craft", () => {
  it("edits queued work instead of only cancelling it", () => {
    const api = source("../api/runtime.ts");
    const banners = source("../components/TaskBanners.tsx");
    const root = source("../components/AgentTaskImplementation.tsx");
    expect(api).toContain("export const editQueuedExecution");
    expect(api).toContain('method: "PATCH"');
    expect(banners).toContain('data-testid="queued-direction-edit"');
    expect(banners).toContain('data-testid="queued-direction-editor"');
    expect(banners).toContain('data-testid="queued-direction-save"');
    expect(root).toContain("onEditQueued");
  });

  it("bounds composer input and rename titles before the server 422s", () => {
    const composer = source("../components/Composer.tsx");
    const navigation = source("./AgentTaskNavigation.tsx");
    expect(composer).toContain('data-testid="composer-count"');
    expect(composer).toContain("textLimit");
    expect(composer).toContain('t("composer.nearLimit")');
    expect(navigation).toContain("maxLength={120}");
  });

  it("keeps no focus inside a collapsed sidebar and traps overlay panels", () => {
    const navigation = source("./AgentTaskNavigation.tsx");
    const panel = source("./ArtifactsPanel.tsx");
    expect(navigation).toContain("inert={collapsed ? true : undefined}");
    expect(panel).toContain("useFocusTrap<HTMLElement>(overlay)");
    expect(panel).toContain("tabIndex={-1}");
  });

  it("navigates the model menu by keyboard with listbox semantics", () => {
    const chip = source("../components/ModelChip.tsx");
    expect(chip).toContain('role="listbox"');
    expect(chip).toContain("aria-selected={");
    expect(chip).not.toContain("aria-checked={provider.active}");
    expect(chip).toContain("aria-activedescendant");
  });

  it("shares one relative-time implementation with honest UTC sources", () => {
    const navigation = source("./AgentTaskNavigation.tsx");
    const panel = source("./ArtifactsPanel.tsx");
    const detail = source("../components/ExecutionDetailImplementation.tsx");
    expect(navigation).toContain('from "../lib/time"');
    expect(navigation).toContain("previousDayKey(today)");
    expect(navigation).toContain("setInterval");
    expect(panel).toContain("timeAgo(");
    expect(detail).toContain("timeAgo(execution.started_at, t)");
    expect(detail).toContain('data-testid="execution-usage"');
  });

  it("searches open panel documents and renders usage only when reported", () => {
    const document = source("../components/TaskDocument.tsx");
    const detail = source("../components/ExecutionDetailImplementation.tsx");
    expect(document).toContain("getFindRoots()");
    expect(source("./ArtifactsPanel.tsx")).toContain("registerFindRoot");
    expect(detail).toContain("usageLine(usage, t)");
    expect(detail).toContain("unreported usage is not zero");
  });

  it("gives every heading a unique anchor, an outline for two sections, and tables a size with copy", () => {
    const md = source("../components/MarkdownImplementation.tsx");
    expect(md).toContain("uniqueHeadingId");
    expect(md).toContain("scrollIntoView");
    expect(md).toContain("heads.length < 2");
    expect(md).toContain('data-testid="table-size"');
    expect(md).toContain('data-testid="table-copy"');
    expect(md).toContain("font-normal");
  });

  it("localizes figures, evidence states, and triage through i18n", () => {
    const figures = source("../viz/AnalysisFigures.tsx");
    const marks = source("../viz/marks.tsx");
    const preview = source("../viz/ProvenanceMark.tsx");
    const evidence = source("./EvidenceReview.tsx");
    const triage = source("../components/AgentRuntimeArtifacts.tsx");
    const i18n = source("../i18n.tsx");
    for (const hard of ["Cost simulation", "No inventory to simulate.", "Still here", "No class mix to plot."]) {
      expect(figures + marks).not.toContain(`"${hard}"`);
    }
    expect(preview).toContain('t("viz.noChain")');
    expect(evidence).toContain("SeverityMark");
    expect(evidence).toContain('t("evidence.statusReady")');
    expect(triage).toContain('t("triage.next")');
    expect(i18n).toContain('"viz.costTitle"');
    expect(i18n).toContain('"severity.critical"');
  });

  it("copies through one path and highlights config languages", () => {
    const hook = source("../hooks/useCopy.ts");
    expect(hook).toContain("export async function copyTextToClipboard");
    expect(hook).toContain("export function useCopy(");
    for (const relative of ["../components/TranscriptTurn.tsx", "../components/MarkdownImplementation.tsx", "../components/S3ErrorArtifact.tsx", "../components/CallDetail.tsx"]) {
      expect(source(relative)).toContain("useCopy");
      expect(source(relative)).not.toContain("execCommand");
    }
    const highlight = source("../lib/highlight.ts");
    expect(highlight).toContain('yaml: "yaml"');
    expect(highlight).toContain('toml: "toml"');
    expect(highlight).toContain("YAML_RULES");
    expect(highlight).toContain("TOML_INI_RULES");
  });

  it("keeps the empty start to one greeting line plus the Composer", () => {
    const greeting = source("./startGreeting.ts");
    const root = source("../components/AgentTaskImplementation.tsx");
    const panel = source("./ArtifactsPanel.tsx");
    // v1.15 — the rotating "Try:" hint is gone; discoverability lives in
    // the palette (⌘K), not in painted suggestions.
    expect(root).not.toContain('data-testid="start-hint"');
    expect(root).not.toContain("pickStartHint");
    expect(greeting).not.toContain("试试：");
    expect(greeting).not.toContain("Try:");
    expect(panel).toContain('message.role === "assistant"');
  });
});

/**
 * v1.15.0 — True Native Agent: no chat placeholders, no painted hints, no
 * footer policy fact, no manual transport chrome; tables fit first; usage
 * speaks one vocabulary; CJK-safe settings; elevated craft. Quiet title-bar
 * Find/palette icons remain the discovery entry (⌘F / ⌘K stay).
 */
describe("v1.15.0 true native agent", () => {
  it("delegates in work language on the one input", () => {
    const composer = source("../components/Composer.tsx");
    expect(composer).toContain("Describe the storage work to delegate…");
    expect(composer).toContain("描述要委派的存储工作…");
    expect(composer).not.toContain("Ask about your storage");
    expect(composer).not.toContain("问问你的存储");
  });

  it("opens Find and the palette from quiet title-bar icons and the keyboard", () => {
    const app = source("../App.tsx");
    const doc = source("../components/TaskDocument.tsx");
    const task = source("../components/AgentTaskImplementation.tsx");
    expect(app).toContain('data-testid="titlebar-find"');
    expect(app).toContain('data-testid="titlebar-palette"');
    expect(app.indexOf("titlebar-find")).toBeLessThan(app.indexOf("native-titlebar-title"));
    expect(doc).not.toContain('data-testid="task-find-open"');
    expect(task).toContain("openFind");
    expect(task).toContain("setFindOpen(true)");
    expect(doc).not.toContain('matches(event, "find")');
    expect(app).toContain('case "find": live.find?.()');
    expect(app).toContain('case "palette": setPaletteOpen');
  });

  it("searches one CJK character — one Han字 is a word", () => {
    const find = source("../taskFind.ts");
    expect(find).toContain("minQueryFor");
    expect(find).toContain("meetsMinQuery");
    expect(find).toContain("\\u4e00");
  });

  it("heals stalled streams itself — status, never a Resync button", () => {
    const doc = source("../components/TaskDocument.tsx");
    expect(doc).toContain('data-testid="task-reconnecting"');
    expect(doc).toContain("task.reconnecting");
    expect(doc).not.toContain("copy.reload");
    expect(doc).not.toContain("copy.stalled");
    expect(doc).not.toContain("onClick={onResync}");
  });

  it("renders tables whole: no folding, no sliding", () => {
    const md = source("../components/MarkdownImplementation.tsx");
    expect(md).toContain('data-testid="table-grid"');
    expect(md).toContain("agent-table-grid");
    expect(md).not.toContain('data-testid="table-scroll-hint"');
    expect(md).not.toContain('data-testid="table-expand"');
    expect(md).not.toContain('data-testid="table-page"');
    expect(md).not.toContain("agent-table-scroll");
    expect(md).not.toContain("useState");
    const css = source("./native-document.css");
    expect(css).not.toMatch(/\.agent-table-scroll\s*\{[^}]*overflow/);
  });

  it("renders usage from one vocabulary: subset cached, floor ~, named silence", () => {
    const lib = source("../lib/usage.ts");
    const meter = source("../components/ContextMeter.tsx");
    const detail = source("../components/ExecutionDetailImplementation.tsx");
    expect(lib).toContain("export function formatUsageLine(");
    expect(lib).toContain("export function contextReading(");
    expect(lib).toContain("incl.");
    expect(detail).toContain("formatUsageLine(usage, t)");
    expect(detail).toContain("usageTitle(usage, t)");
    expect(meter).toContain('data-state="unreported"');
    expect(detail).not.toContain("usage.cached\", { n");
  });

  it("keeps Execution, Find and Skills copy in the i18n dict", () => {
    const i18n = source("../i18n.tsx");
    for (const key of ["\"task.find\"", "\"exec.back\"", "\"skills.noSkills\"", "\"table.scrollHint\"", "\"usage.cachedOf\""]) {
      expect(i18n).toContain(key);
    }
    expect(source("../components/ExecutionDetailImplementation.tsx")).not.toContain("返回 Execution 列表");
    expect(source("../components/FindBar.tsx")).not.toContain("在当前任务中查找…\",");
    expect(source("../components/NativeAgentPanel.tsx")).not.toContain("还没有技能。把 SKILL.md");
  });

  it("stacks settings grids on the editor pane with strict CJK breaks", () => {
    const css = source("../../src/index.css");
    expect(css).toContain("line-break: strict");
    const shell = source("./native-shell.css");
    expect(shell).toContain("container-type: inline-size");
    expect(shell).toContain(".native-settings-fields");
    expect(shell).toContain("@container (min-width: 32rem)");
    expect(shell).toContain("container-name: settings");
    expect(source("../settings/ModelProvidersPane.tsx")).toContain("native-settings-fields");
    expect(source("../settings/ModelProvidersPane.tsx")).not.toContain("sm:grid-cols-2");
    expect(source("../components/SettingsDialog.tsx")).toContain("native-settings");
    expect(source("../components/NativeAgentPanel.tsx")).toContain("native-settings-head");
  });

  it("elevates the Composer and the user bubble above the canvas", () => {
    const css = source("./native-document.css");
    expect(css).toContain("--shadow-elev");
    expect(css).toContain(".turn-user-bubble");
    // Uniform bubble corners; the tail radius is gone.
    expect(css).not.toContain("border-top-right-radius");
  });
});

/**
 * v1.16.0 — finish the native agent: dict-owned copy, engine discovery in
 * the palette, honest usage end to end, isolated Escape, dismissible errors,
 * retried reconnects, themed last-resort chrome, matching secret shapes.
 */
describe("v1.16.0 true native agent, finished", () => {
  it("owns palette, chip, triage, shortcuts and day labels in dictionaries", () => {
    const i18n = source("../i18n.tsx");
    for (const key of ["\"palette.placeholder\"", "\"palette.engineCost\"", "\"chip.none\"", "\"triage.title\"", "\"shortcuts.title\""]) {
      expect(i18n).toContain(key);
    }
    expect(source("../components/CommandPalette.tsx")).toContain('t("palette.placeholder")');
    expect(source("../components/ModelChip.tsx")).toContain('t("chip.none")');
    expect(source("../components/AgentRuntimeArtifacts.tsx")).toContain('t("triage.title")');
    expect(source("../components/ShortcutsSheet.tsx")).toContain('t("shortcuts.title")');
    expect(source("./AgentTaskNavigation.tsx")).toContain("NAV_DAY_LABELS");
    expect(source("./navigationCopy.ts")).toContain("NAV_DAY_LABELS");
  });

  it("discovers engines and shortcuts through live palette actions", () => {
    const palette = source("../components/CommandPalette.tsx");
    const actions = source("./paletteActions.ts");
    expect(actions).toContain("prefill?: (text: string) => void");
    expect(actions).toContain("shortcuts?: () => void");
    expect(actions).toContain("publishBasePaletteActions");
    expect(palette).toContain("live.prefill");
    expect(palette).toContain("live.shortcuts");
  });

  it("renders the persisted governor and memory reuse beside tokens", () => {
    const lib = source("../lib/usage.ts");
    expect(lib).toContain("budget_tokens");
    expect(lib).toContain("repeat_calls_avoided");
    expect(lib).toContain("windowSource");
    expect(source("../../../sidecar/app/task_runtime/runtime.py")).toContain("context_window_source");
  });

  it("isolates Escape per layer instead of closing two things at once", () => {
    expect(source("../components/FindBar.tsx")).toContain("event.stopPropagation()");
    expect(source("../components/Composer.tsx")).toContain("event.stopPropagation()");
    expect(source("../components/TaskBanners.tsx")).toContain("event.stopPropagation()");
  });

  it("dismisses view errors and stacks banners honestly", () => {
    const banners = source("../components/TaskBanners.tsx");
    expect(banners).toContain("onDismissError");
    expect(banners).toContain('t("common.dismiss")');
    expect(banners).toContain("needKey && !offline");
    expect(banners).toContain("maxLength={QUEUED_DIRECTION_LIMIT}");
  });

  it("retries reconnects with backoff and locks the history auto-load", () => {
    const doc = source("../components/TaskDocument.tsx");
    expect(doc).toContain("stallTries");
    expect(doc).toContain("loadingEarlierRef");
    expect(source("../components/AgentTaskImplementation.tsx")).toMatch(/onResync=\{async \(\)/);
  });

  it("themes the last-resort boundary and matches secret shapes end to end", () => {
    const boundary = source("../ErrorBoundary.tsx");
    expect(boundary).toContain("var(--canvas");
    expect(boundary).not.toContain("#0b0e14");
    expect(source("../components/Composer.tsx")).toContain("ghu_");
    expect(source("../components/Composer.tsx")).toContain("glpat-");
  });

  it("triggers @ mentions on word boundaries and shares the gate-name map", () => {
    const composer = source("../components/Composer.tsx");
    expect(composer).toContain("mentionQueryAt(value, caret)");
    expect(composer).toContain("mentionTriggered(text)");
    expect(composer).toContain("accept={ANALYZED_EXT.join");
    expect(source("../lib/mention.ts")).toContain("mentionTriggered");
    expect(source("../lib/approvalAction.ts")).toContain("approvalActionLabel");
    expect(source("../components/ApprovalCard.tsx")).toContain("approvalActionLabel(item.action_type, t)");
    expect(source("../settings/SafetyPane.tsx")).toContain("approvalActionLabel(action, t)");
  });

  it("prefills full-sentence drafts and promises no charts from tables", () => {
    const palette = source("../components/CommandPalette.tsx");
    expect(palette).toContain("copy.engineCostAsk");
    expect(palette).toContain("useMemo(() => ({");
    const prompt = source("../../../sidecar/app/agent_runtime/prompt.py");
    expect(prompt).not.toContain("the UI draws a chart from that shape");
    expect(prompt).toContain("never draws charts from answer text");
    expect(source("../components/TaskBanners.tsx")).toContain("QUEUED_DIRECTION_LIMIT");
    expect(source("../components/TaskBanners.tsx")).toContain("maxLength={QUEUED_DIRECTION_LIMIT}");
  });

  it("searches what it counts: groups unfold, scrolling is measured", () => {
    const doc = source("../components/TaskDocument.tsx");
    expect(doc).toContain("findActive = findOpen && meetsMinQuery(findQuery)");
    expect(doc).toContain("findActive={findActive}");
    expect(doc).toContain("root.scrollTop +=");
    expect(doc).not.toContain("scrollIntoView({");
    expect(source("../components/TranscriptItems.tsx")).toContain("forceExpanded={findActive}");
    expect(source("../components/TranscriptTurn.tsx")).toContain("findActive?: boolean");
    expect(source("../components/WorkedGroup.tsx")).toContain("forceExpanded = false");
  });

  it("renders tables whole with wrapping cells", () => {
    const css = source("./native-document.css");
    expect(css).toContain(".agent-table-grid");
    expect(css).toContain("table-layout: fixed");
    expect(css).toContain("overflow-wrap: break-word");
    expect(css).not.toContain("overflow-wrap: anywhere");
    expect(source("../../src/index.css")).not.toContain("overflow-wrap: anywhere");
  });

  it("lets flex columns shrink past unbreakable runs", () => {
    // min-width:auto on a flex item is its longest unbreakable run: ARNs
    // stretched the whole column past the window instead of wrapping.
    const root = source("../components/AgentTaskImplementation.tsx");
    expect(root).toContain("min-w-0 flex-1 flex-col");
    const doc = source("../components/TaskDocument.tsx");
    expect(doc).toContain("min-w-0 flex-1 flex-col");
    expect(doc).toContain("min-w-0 px-6 pb-4");
  });
});

/**
 * v1.17.0 — Codex window: quiet chrome, work language, transcript craft.
 *
 * The runtime transcript was already Codex-shaped. This version un-paints
 * extra chrome, names Execution not Runs, and matches Codex's quiet bubble,
 * approval, and Worked head.
 */
describe("v1.17.0 Codex window", () => {
  it("keeps the Composer to attach + text + model + actions", () => {
    const composer = source("../components/Composer.tsx");
    expect(composer).not.toContain("<ContextMeter");
    expect(composer).not.toContain("readOnly");
    expect(source("../components/ModelChip.tsx")).toContain("<ContextMeter />");
  });

  it("paints quiet Find and palette on the title bar, not on the document", () => {
    const app = source("../App.tsx");
    expect(app).toContain("titlebar-find");
    expect(app).toContain("titlebar-palette");
    expect(app.indexOf("titlebar-find")).toBeLessThan(app.indexOf("native-titlebar-title"));
    expect(source("../components/TaskDocument.tsx")).not.toContain("task-find-open");
    expect(source("../components/AgentTaskImplementation.tsx")).not.toContain("start-mark");
  });

  it("uses work language on the turn, Artifacts, and empty fallback", () => {
    const i18n = source("../i18n.tsx");
    expect(i18n).toContain('"turn.workedFor": "Worked for {t}"');
    expect(i18n).not.toContain('"turn.workedFor": "Worked for {t} · {n} tool calls"');
    expect(i18n).toContain('"turn.userLabel": "Direction"');
    expect(i18n).not.toContain('"turn.userLabel": "Your message"');
    expect(source("../agent/agentCopy.ts")).toContain('execution: "Execution"');
    expect(source("../agent/agentCopy.ts")).not.toContain('execution: "Runs"');
    expect(source("../../../sidecar/app/agent_runtime/finalize.py")).not.toContain("Ask again");
    expect(source("../../../sidecar/app/agent_runtime/prompt.py")).toContain('f"Direction:\\n{msg}"');
    expect(source("../../../sidecar/app/agent_runtime/prompt.py")).not.toContain("User question:");
  });

  it("keeps the user bubble a quiet fill and the approval card sentence-case", () => {
    const css = source("./native-document.css");
    expect(css).toMatch(/\.turn-user-bubble \{[^}]*border: 0;/);
    expect(css).not.toMatch(/\.turn-user-bubble \{[^}]*box-shadow/);
    expect(css).not.toMatch(/\.approval-card-head \{[^}]*text-transform: uppercase/);
    expect(css).not.toMatch(/\.approval-card \{[^}]*box-shadow/);
  });
});

/**
 * Window follow-up: queued banners must not reprint the live Direction,
 * Settings fields follow the editor pane, Find/palette icons stay discoverable.
 */
describe("window follow-up: queue honesty, Settings container, painted Find", () => {
  it("filters the live Execution out of queued banners", () => {
    const root = source("../components/AgentTaskImplementation.tsx");
    expect(root).toContain("visibleQueuedExecutions(");
    expect(source("../lib/pendingDirection.ts")).toContain("export function visibleQueuedExecutions");
    expect(source("../lib/taskStatus.ts")).toContain("payload.queued.filter((q) => q.id !== activeId)");
    expect(source("../components/TaskBanners.tsx")).toContain("queuedSteerFollowup");
  });

  it("keeps Find off the document and ContextMeter off the Composer bar", () => {
    expect(source("../components/TaskDocument.tsx")).not.toContain("task-find-open");
    expect(source("../components/Composer.tsx")).not.toContain("<ContextMeter");
    expect(source("../components/AgentTaskImplementation.tsx")).not.toContain("start-mark");
  });
});

/**
 * Find is a strip under the title bar on the reading column (not a
 * corner overlay and not an in-flow scroller card). Settings dialog is
 * its own container so the nav can stack; ⌘F while open re-selects.
 */
describe("document Find strip and Settings dialog chrome", () => {
  it("renders Find as a strip on the reading column, not a corner overlay", () => {
    const bar = source("../components/FindBar.tsx");
    const css = source("./native-document.css");
    const doc = source("../components/TaskDocument.tsx");
    expect(bar).toContain("native-find-host");
    expect(bar).toContain("native-find");
    expect(bar).not.toContain("sticky");
    expect(bar).not.toContain("shadow-pop");
    expect(bar).not.toContain('"↑"');
    expect(bar).toContain('name={dir === 1 ? "arrowDown" : "arrowUp"}');
    expect(bar).toContain("focusTick");
    expect(css).toContain(".native-find-host");
    expect(css).toMatch(/\.native-find \{[^}]*max-width: 46rem/);
    expect(css).not.toContain("right: 16px");
    expect(doc).toContain("focusTick={findFocusTick}");
    expect(doc).not.toContain("matches(event, \"find\")");
    expect(source("../App.tsx").indexOf("titlebar-find")).toBeLessThan(source("../App.tsx").indexOf("native-titlebar-title"));
  });

  it("sizes the Settings dialog as a container and keeps the close control out of the heading", () => {
    const settings = source("../components/SettingsDialog.tsx");
    const shell = source("./native-shell.css");
    expect(settings).toContain("native-settings-content-head");
    expect(settings).not.toContain("absolute right-3 top-3");
    expect(shell).toContain("@container settings (max-width: 40rem)");
    expect(shell).toContain(".native-settings-nav-footer");
  });
});
