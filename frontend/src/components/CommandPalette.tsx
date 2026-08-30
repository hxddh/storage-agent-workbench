import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentTaskSummary } from "../agent/navigationModel";
import { useI18n } from "../i18n";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useDismissOnEscape } from "../hooks/useDismissOnEscape";

type Cmd = { id: string; label: string; hint?: string; icon: React.ReactNode; run: () => void };

const I = (d: string) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d.split("|").map((path, index) => <path key={index} d={path} />)}
  </svg>
);

/** ⌘K is the Agent command center: create a task, switch tasks, or configure runtime. */
export function CommandPalette({
  open,
  onClose,
  tasks,
  onSelectTask,
  onNew,
  onOpenSettings,
}: {
  open: boolean;
  onClose: () => void;
  tasks: AgentTaskSummary[];
  onSelectTask: (id: string) => void;
  onNew: () => void;
  onOpenSettings: () => void;
}) {
  const { lang, t } = useI18n();
  const copy = lang === "zh"
    ? { placeholder: "搜索 Agent Tasks 或运行命令…", newTask: "新建 Agent Task", settings: "打开设置", task: "Task", empty: "没有匹配的 Task 或命令。" }
    : { placeholder: "Search Agent tasks or run a command…", newTask: "New Agent task", settings: "Open settings", task: "Task", empty: "No matching tasks or commands." };
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(open);
  useDismissOnEscape(open, onClose);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const items = useMemo<Cmd[]>(() => {
    const actions: Cmd[] = [
      { id: "new", label: copy.newTask, hint: "⌘N", icon: I("M12 5v14|M5 12h14"), run: () => { onNew(); onClose(); } },
      { id: "settings", label: copy.settings, icon: I("M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M3 12h2|M19 12h2|M12 3v2|M12 19v2"), run: () => { onOpenSettings(); onClose(); } },
    ];
    const taskItems: Cmd[] = tasks.map((task) => ({
      id: `task:${task.id}`,
      label: task.title || t("common.untitled"),
      hint: copy.task,
      icon: I("M4 5h16v14H4z|M8 9h8|M8 13h5"),
      run: () => { onSelectTask(task.id); onClose(); },
    }));
    const all = [...actions, ...taskItems];
    const query = q.trim().toLowerCase();
    return query ? all.filter((command) => command.label.toLowerCase().includes(query)) : all;
  }, [q, tasks, onNew, onOpenSettings, onSelectTask, onClose, t, copy.newTask, copy.settings, copy.task]);

  useEffect(() => {
    if (sel >= items.length) setSel(Math.max(0, items.length - 1));
  }, [items.length, sel]);

  if (!open) return null;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setSel((value) => Math.min(items.length - 1, value + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setSel((value) => Math.max(0, value - 1)); }
    else if (event.key === "Enter") { event.preventDefault(); items[sel]?.run(); }
  };

  return (
    <div className="fixed inset-0 z-palette flex items-start justify-center bg-scrim pt-[14vh] backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label={copy.placeholder}
        className="w-[min(560px,92vw)] overflow-hidden rounded-2xl border border-edge bg-panel shadow-pop animate-scale-in"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-edge px-4">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-gray-500" aria-hidden><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(event) => { setQ(event.target.value); setSel(0); }}
            onKeyDown={onKeyDown}
            placeholder={copy.placeholder}
            className="w-full bg-transparent py-3.5 text-base text-gray-100 placeholder:text-gray-500 focus:outline-none"
          />
        </div>
        <div className="max-h-[52vh] overflow-auto p-1.5">
          {items.length === 0 ? <div className="px-3 py-6 text-center text-sm text-gray-500">{copy.empty}</div> : null}
          {items.map((command, index) => (
            <button
              key={command.id}
              onMouseEnter={() => setSel(index)}
              onClick={() => command.run()}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${index === sel ? "bg-hover" : ""}`}
            >
              <span className={index === sel ? "text-accent-soft" : "text-gray-500"}>{command.icon}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-gray-200">{command.label}</span>
              {command.hint ? <span className="shrink-0 text-2xs text-gray-500">{command.hint}</span> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
