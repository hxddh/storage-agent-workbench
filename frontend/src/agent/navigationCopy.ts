import { useI18n } from "../i18n";

const COPY = {
  en: {
    tasks: "Tasks",
    newTask: "New task",
    noTasks: "No tasks yet",
    noTasksHint: "Ask anything. Tasks live here — your durable, read-only investigations.",
    settings: "Settings",
    resize: "Resize task list",
    collapse: "Collapse task list",
    expand: "Expand task list",
    deleteConfirm: "Delete this task and its history?",
    cancel: "Cancel",
    delete: "Delete",
  },
  zh: {
    tasks: "任务",
    newTask: "新任务",
    noTasks: "还没有任务",
    noTasksHint: "在 Composer 提问，任务会出现在这里 — 你的持久化只读调查。",
    settings: "设置",
    resize: "调整任务列表宽度",
    collapse: "收起任务列表",
    expand: "展开任务列表",
    deleteConfirm: "删除这个任务及其历史？",
    cancel: "取消",
    delete: "删除",
  },
} as const;

export function useNavigationCopy() {
  const { lang } = useI18n();
  return COPY[lang];
}
