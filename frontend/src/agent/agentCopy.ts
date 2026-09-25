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
        plans: "Plans",
        baselines: "Baselines & Drift",
        execution: "Execution",
      },
      report: "Task report",
      plan: {
        version: (version: number) => `v${version}`,
        status: { proposed: "proposed", verified: "verified", partially_verified: "partially verified", stale: "stale" } as Record<string, string>,
        actions: "Recommended actions",
        noActions: "This plan lists no actions.",
        checklist: "Before applying",
        applyIn: "Apply outside Storage Agent — the plan is read-only.",
        simulation: "Simulation coverage",
        findingRefs: "Findings addressed",
      },
      baseline: {
        kinds: { baseline: "Baseline", drift_report: "Drift report" } as Record<string, string>,
        added: "Added",
        resolved: "Resolved",
        stillPresent: "Still present",
        configDiff: "Configuration changes",
        before: "Before",
        after: "After",
        inventory: "Inventory trend",
        estimate: "Estimate — deterministic comparison over bounded snapshots.",
        noDrift: "No findings changed between the two snapshots.",
        snapshot: "Snapshot",
        rawSnapshot: "Raw snapshot",
        snapshotFindings: "Findings in this snapshot",
      },
      execution: {
        statuses: {
          queued: "Queued", running: "Running", waiting: "Waiting for approval", completed: "Completed",
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
        plans: "整改方案",
        baselines: "基线与漂移",
        execution: "执行记录",
      },
      report: "任务报告",
      plan: {
        version: (version: number) => `v${version}`,
        status: { proposed: "已提出", verified: "已验证", partially_verified: "部分验证", stale: "已过期" } as Record<string, string>,
        actions: "建议动作",
        noActions: "这份方案没有列出动作。",
        checklist: "应用前须知",
        applyIn: "请在 Storage Agent 之外应用——方案本身只读。",
        simulation: "模拟覆盖范围",
        findingRefs: "涉及的发现",
      },
      baseline: {
        kinds: { baseline: "基线", drift_report: "漂移报告" } as Record<string, string>,
        added: "新增",
        resolved: "已解决",
        stillPresent: "仍然存在",
        configDiff: "配置变化",
        before: "之前",
        after: "之后",
        inventory: "清单趋势",
        estimate: "估算——基于有界快照的确定性比较。",
        noDrift: "两次快照之间没有发现变化。",
        snapshot: "快照",
        rawSnapshot: "原始快照",
        snapshotFindings: "快照中的发现",
      },
      execution: {
        statuses: {
          queued: "排队中", running: "执行中", waiting: "等待批准", completed: "已完成",
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
