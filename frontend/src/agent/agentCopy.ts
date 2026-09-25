import { useI18n } from "../i18n";

const COPY = {
  en: {
    task: {
      navigation: "Tasks",
      workspace: "Active task",
    },
    details: {
      title: "Details",
      findings: (n: number) => (n === 1 ? "1 finding" : `${n} findings`),
      reportMeta: "The whole task as one document",
      executions: (n: number) => (n === 1 ? "1 execution" : `${n} executions`),
    },
    artifacts: {
      sections: {
        evidence: "Evidence",
        reports: "Reports",
        execution: "Execution",
      },
      report: "Task report",
      execution: {
        statuses: {
          queued: "Queued", running: "Running", waiting: "Interrupted", completed: "Completed",
          failed: "Failed", cancelled: "Stopped", interrupted: "Interrupted",
        } as Record<string, string>,
        kinds: { direction: "Direction", verify: "Verify", revisit: "Revisit", steer_followup: "Steer follow-up", resume: "Resume", retry: "Retry" } as Record<string, string>,
      },
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
    details: {
      title: "详情",
      findings: (n: number) => `${n} 项发现`,
      reportMeta: "把整个任务整理成一份文档",
      executions: (n: number) => `${n} 次执行`,
    },
    artifacts: {
      sections: {
        evidence: "证据",
        reports: "报告",
        execution: "执行记录",
      },
      report: "任务报告",
      execution: {
        statuses: {
          queued: "排队中", running: "执行中", waiting: "已中断", completed: "已完成",
          failed: "失败", cancelled: "已停止", interrupted: "已中断",
        } as Record<string, string>,
        kinds: { direction: "方向", verify: "验证", revisit: "回访", steer_followup: "补充方向的后续执行", resume: "恢复执行", retry: "重新执行" } as Record<string, string>,
      },
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
