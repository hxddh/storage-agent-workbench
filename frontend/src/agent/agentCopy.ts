import { useI18n } from "../i18n";

const COPY = {
  en: {
    task: {
      navigation: "Tasks",
      workspace: "Active task",
    },
    review: {
      close: "Close",
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
      preparing: "Preparing report…",
      empty: "No report has been generated for this task yet.",
      actions: "Report actions",
      copied: "Copied",
      download: "Download .md",
      savedTo: (path: string) => `Saved: ${path}`,
    },
  },
  zh: {
    task: {
      navigation: "任务",
      workspace: "当前任务",
    },
    review: {
      close: "关闭",
      loading: "正在加载任务上下文…",
    },
    evidence: {
      eyebrow: "证据",
      understanding: "当前判断",
      findings: "发现",
      noFindings: "这个任务还没有记录发现。",
      attached: "已附加的证据",
      noFiles: "这个任务还没有附加文件。",
    },
    execution: {
      title: "执行",
      empty: "这个任务还没有执行记录。",
    },
    report: {
      title: "报告",
      preparing: "正在准备报告…",
      empty: "这个任务还没有生成报告。",
      actions: "报告操作",
      copied: "已复制",
      download: "下载 .md",
      savedTo: (path: string) => `已保存：${path}`,
    },
  },
} as const;

export function useAgentCopy() {
  const { lang } = useI18n();
  return COPY[lang];
}
