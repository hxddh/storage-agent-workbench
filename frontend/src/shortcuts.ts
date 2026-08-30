/** Single source of truth for Agent-task keyboard shortcuts. */

/** Cmd on Apple platforms, Ctrl everywhere else. */
export const isApple =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");
export const MOD = isApple ? "⌘" : "Ctrl";

export type ShortcutId =
  | "palette"
  | "newTask"
  | "toggleTaskNavigation"
  | "shortcuts"
  | "close"
  | "review"
  | "find"
  | "prevStep"
  | "nextStep"
  | "delegate"
  | "newline";

export interface Shortcut {
  id: ShortcutId;
  keys: string[];
  label: { en: string; zh: string };
  group: "global" | "task";
  mod?: "mod" | "shift" | null;
  key?: string;
  handled?: boolean;
}

export const SHORTCUTS: Shortcut[] = [
  { id: "palette", keys: [MOD, "K"], label: { en: "Command palette", zh: "命令面板" }, group: "global", mod: "mod", key: "k", handled: true },
  { id: "newTask", keys: [MOD, "N"], label: { en: "New Agent task", zh: "新建 Agent Task" }, group: "global", mod: "mod", key: "n", handled: true },
  { id: "toggleTaskNavigation", keys: [MOD, "\\"], label: { en: "Show / hide task navigation", zh: "显示 / 隐藏 Task 导航" }, group: "global", mod: "mod", key: "\\", handled: true },
  { id: "shortcuts", keys: ["?"], label: { en: "Keyboard shortcuts", zh: "键盘快捷键" }, group: "global", mod: null, key: "?", handled: true },
  { id: "close", keys: ["Esc"], label: { en: "Close the active panel", zh: "关闭当前面板" }, group: "global", mod: null, key: "Escape", handled: true },
  { id: "review", keys: [MOD, "I"], label: { en: "Review task evidence", zh: "Review 任务 Evidence" }, group: "task", mod: "mod", key: "i", handled: true },
  { id: "find", keys: [MOD, "F"], label: { en: "Find in this task", zh: "在当前 Task 中查找" }, group: "task", mod: "mod", key: "f", handled: true },
  { id: "prevStep", keys: ["K"], label: { en: "Previous task step", zh: "上一个 Task Step" }, group: "task", mod: null, key: "k", handled: true },
  { id: "nextStep", keys: ["J"], label: { en: "Next task step", zh: "下一个 Task Step" }, group: "task", mod: null, key: "j", handled: true },
  { id: "delegate", keys: ["Enter"], label: { en: "Delegate / Steer", zh: "Delegate / Steer" }, group: "task", handled: false },
  { id: "newline", keys: ["Shift", "Enter"], label: { en: "New line", zh: "换行" }, group: "task", handled: false },
];

export const shortcutsIn = (group: Shortcut["group"]) => SHORTCUTS.filter((shortcut) => shortcut.group === group);

/** Does this keyboard event match the registered shortcut? */
export function matches(event: KeyboardEvent, id: ShortcutId): boolean {
  const shortcut = SHORTCUTS.find((item) => item.id === id);
  if (!shortcut || !shortcut.key) return false;
  const mod = event.metaKey || event.ctrlKey;
  if (shortcut.mod === "mod" && !mod) return false;
  if (shortcut.mod !== "mod" && mod) return false;
  return shortcut.key.length === 1 ? event.key.toLowerCase() === shortcut.key : event.key === shortcut.key;
}

/** Bare-key task navigation must never fire while the user is typing. */
export function isEditable(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
}
