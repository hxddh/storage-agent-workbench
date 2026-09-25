import { useI18n } from "../i18n";

const COPY = {
  en: {
    tasks: "Tasks",
    newTask: "New task",
    noTasks: "No tasks yet",
    noTasksHint: "Describe storage work in the box on the right — each task keeps its results.",
    search: "Search tasks",
    noMatches: "No task matches",
    inspector: "Details",
    settings: "Settings",
    resize: "Resize sidebar",
    collapse: "Hide sidebar",
    expand: "Show sidebar",
    deleteConfirm: "Delete this task and everything it recorded?",
    cancel: "Cancel",
    delete: "Delete",
    appTitle: "Storage Agent",
    notifySettled: "The Agent finished working on this task.",
    state: {
      working: "Working",
      uploading: "Preparing",
      attention: "Needs attention",
    },
  },
  zh: {
    tasks: "任务",
    newTask: "新任务",
    noTasks: "还没有任务",
    noTasksHint: "在右侧输入框描述要处理的存储工作，每个任务都会保留结果。",
    search: "搜索任务",
    noMatches: "没有匹配的任务",
    inspector: "详情",
    settings: "设置",
    resize: "调整侧栏宽度",
    collapse: "隐藏侧栏",
    expand: "显示侧栏",
    deleteConfirm: "删除这个任务及其全部记录？",
    cancel: "取消",
    delete: "删除",
    appTitle: "Storage Agent",
    notifySettled: "Agent 已完成这个任务的工作。",
    state: {
      working: "执行中",
      uploading: "准备中",
      attention: "需要处理",
    },
  },
} as const;

export function useNavigationCopy() {
  const { lang } = useI18n();
  return COPY[lang];
}

/** v1.16 — sidebar day-group labels live with the rest of navigation copy. */
export const NAV_DAY_LABELS = {
  en: { today: "Today", yesterday: "Yesterday", earlier: "Earlier" },
  zh: { today: "今天", yesterday: "昨天", earlier: "更早" },
} as const;
