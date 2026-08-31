import { useI18n } from "../i18n";

const COPY = {
  en: {
    task: {
      navigation: "Agent tasks",
      workspace: "Active Agent task",
      newTask: "New task",
      noScope: "General storage task",
      startingExecution: "Starting task execution",
      toolsRun: (n: number) => `${n} tool${n === 1 ? "" : "s"}`,
      steerHint: "Steer anytime",
    },
    states: {
      working: "Agent working",
      uploading: "Preparing evidence",
      decision: "Needs decision",
      attention: "Needs attention",
      ready: "Ready for direction",
      delegate: "Ready to delegate",
    },
    findings: (n: number) => `${n} finding${n === 1 ? "" : "s"}`,
    executions: (n: number) => `${n} execution${n === 1 ? "" : "s"}`,
    command: "Command",
    commandPalette: "Command palette",
    settings: "Settings and providers",
    selectEvidence: "Select an Agent task to review its evidence.",
    review: {
      title: "Review",
      open: "Review",
      close: "Close review",
      loading: "Loading task context…",
    },
    evidence: {
      eyebrow: "Evidence",
      understanding: "Current understanding",
      findings: "Findings",
      noFindings: "No findings recorded for this task yet.",
      attached: "Attached evidence",
      noFiles: "No files are attached to this task.",
    },
    execution: {
      title: "Execution",
      empty: "No execution records on this task yet.",
    },
    report: {
      title: "Report",
      description: "A durable result produced by the Agent for this task.",
      preparing: "Preparing report…",
      empty: "No report has been generated for this task yet.",
      actions: "Report actions",
      copied: "Copied",
      download: "Download .md",
      savedTo: (path: string) => `Saved: ${path}`,
    },
    steering: "Steer Agent",
  },
  zh: {
    task: {
      navigation: "Agent Tasks",
      workspace: "当前 Agent Task",
      newTask: "新任务",
      noScope: "通用对象存储任务",
      startingExecution: "正在启动任务执行",
      toolsRun: (n: number) => `${n} 个 Tool`,
      steerHint: "随时 Steer",
    },
    states: {
      working: "Agent 工作中",
      uploading: "正在准备 Evidence",
      decision: "等待你的决定",
      attention: "需要处理",
      ready: "等待下一步指令",
      delegate: "可以开始委派任务",
    },
    findings: (n: number) => `${n} 项发现`,
    executions: (n: number) => `${n} 次执行`,
    command: "命令",
    commandPalette: "命令面板",
    settings: "设置与 Providers",
    selectEvidence: "选择一个 Agent Task 以查看 Evidence。",
    review: {
      title: "Review",
      open: "Review",
      close: "关闭 Review",
      loading: "正在加载任务上下文…",
    },
    evidence: {
      eyebrow: "Evidence",
      understanding: "当前判断",
      findings: "发现",
      noFindings: "这个任务还没有记录发现。",
      attached: "已附文件",
      noFiles: "这个任务还没有附加文件。",
    },
    execution: {
      title: "Execution",
      empty: "这个任务还没有执行记录。",
    },
    report: {
      title: "Report",
      description: "Agent 为当前任务生成的持久化成果。",
      preparing: "正在准备 Report…",
      empty: "这个任务还没有生成报告。",
      actions: "Report 操作",
      copied: "已复制",
      download: "下载 .md",
      savedTo: (path: string) => `已保存：${path}`,
    },
    steering: "Steer Agent",
  },
} as const;

export function useAgentCopy() {
  const { lang } = useI18n();
  return COPY[lang];
}
