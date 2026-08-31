import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentTaskSummary } from "../agent/navigationModel";
import { openAgentReview } from "../agent/commands";
import { getPaletteActions } from "../agent/paletteActions";
import { useI18n } from "../i18n";
import { useTheme } from "../theme";
import { MOD } from "../shortcuts";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useDismissOnEscape } from "../hooks/useDismissOnEscape";
import type { ReviewSurface } from "../agent/model";

type Cmd = { id: string; label: string; hint?: string; icon: React.ReactNode; run: () => void; group: "action" | "task" };

const I = (d: string) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d.split("|").map((path, index) => <path key={index} d={path} />)}
  </svg>
);

/** ⌘K is the Agent command overlay: switch tasks or run a real runtime action. */
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
  const { lang, setLang, t } = useI18n();
  const { theme, toggle } = useTheme();
  const copy = lang === "zh"
    ? {
        placeholder: "搜索任务或运行命令…",
        newTask: "新建任务",
        settings: "打开设置",
        actions: "操作",
        tasks: "任务",
        empty: "没有匹配的任务或命令。",
        stop: "停止当前执行",
        resume: "恢复中断的执行",
        steer: "Steer 当前执行",
        focus: "聚焦 Composer",
        reviewOverview: "打开 Review · 总览",
        reviewEvidence: "打开 Review · Evidence",
        reviewExecution: "打开 Review · Execution",
        reviewReport: "打开 Review · Report",
        themeLight: "切换到亮色主题",
        themeDark: "切换到暗色主题",
        langEn: "Switch to English",
        langZh: "切换到中文",
      }
    : {
        placeholder: "Search tasks or run a command…",
        newTask: "New Agent task",
        settings: "Open settings",
        actions: "Actions",
        tasks: "Tasks",
        empty: "No matching tasks or commands.",
        stop: "Stop current execution",
        resume: "Resume interrupted execution",
        steer: "Steer current execution",
        focus: "Focus composer",
        reviewOverview: "Open Review · Overview",
        reviewEvidence: "Open Review · Evidence",
        reviewExecution: "Open Review · Execution",
        reviewReport: "Open Review · Report",
        themeLight: "Switch to light theme",
        themeDark: "Switch to dark theme",
        langEn: "Switch to English",
        langZh: "切换到中文",
      };
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
    const live = getPaletteActions();
    const openReview = (surface: ReviewSurface) => {
      if (!live.hasTask) return;
      openAgentReview(surface);
      onClose();
    };
    const actions: Cmd[] = [
      { id: "new", label: copy.newTask, hint: `${MOD}N`, icon: I("M12 5v14|M5 12h14"), run: () => { onNew(); onClose(); }, group: "action" },
      { id: "focus", label: copy.focus, hint: `${MOD}L`, icon: I("M4 5h16v14H4z|M8 9h8"), run: () => { live.focusComposer?.(); onClose(); }, group: "action" },
      { id: "settings", label: copy.settings, icon: I("M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M3 12h2|M19 12h2|M12 3v2|M12 19v2"), run: () => { onOpenSettings(); onClose(); }, group: "action" },
    ];
    if (live.busy) {
      actions.splice(2, 0, {
        id: "stop",
        label: copy.stop,
        hint: `${MOD}.`,
        icon: I("M6 6h12v12H6z"),
        run: () => { live.stop?.(); onClose(); },
        group: "action",
      }, {
        id: "steer",
        label: copy.steer,
        hint: `${MOD}L`,
        icon: I("M5 12h14|M13 6l6 6-6 6"),
        run: () => { live.focusComposer?.(); onClose(); },
        group: "action",
      });
    }
    if (live.canResume) {
      actions.splice(2, 0, {
        id: "resume",
        label: copy.resume,
        icon: I("M8 5v14l11-7z"),
        run: () => { live.resume?.(); onClose(); },
        group: "action",
      });
    }
    if (live.hasTask) {
      actions.push(
        { id: "review-overview", label: copy.reviewOverview, hint: `${MOD}I`, icon: I("M4 5h16M4 12h16M4 19h10"), run: () => openReview("overview"), group: "action" },
        { id: "review-evidence", label: copy.reviewEvidence, icon: I("M14 2H6a2 2 0 0 0-2 2v16h16V8z"), run: () => openReview("evidence"), group: "action" },
        { id: "review-execution", label: copy.reviewExecution, icon: I("M4 6h16M4 12h10M4 18h7"), run: () => openReview("execution"), group: "action" },
        { id: "review-report", label: copy.reviewReport, icon: I("M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"), run: () => openReview("report"), group: "action" },
      );
    }
    actions.push(
      {
        id: "theme",
        label: theme === "dark" ? copy.themeLight : copy.themeDark,
        icon: I("M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z"),
        run: () => { toggle(); onClose(); },
        group: "action",
      },
      {
        id: "lang",
        label: lang === "zh" ? copy.langEn : copy.langZh,
        icon: I("M4 7h16M4 17h16M9 7c1 4 3 7 6 10"),
        run: () => { setLang(lang === "zh" ? "en" : "zh"); onClose(); },
        group: "action",
      },
    );
    const taskItems: Cmd[] = tasks.map((task) => ({
      id: `task:${task.id}`,
      label: task.title || t("common.untitled"),
      hint: copy.tasks,
      icon: I("M4 5h16v14H4z|M8 9h8|M8 13h5"),
      run: () => { onSelectTask(task.id); onClose(); },
      group: "task",
    }));
    const all = [...actions, ...taskItems];
    const query = q.trim().toLowerCase();
    return query ? all.filter((command) => command.label.toLowerCase().includes(query)) : all;
  }, [q, tasks, onNew, onOpenSettings, onSelectTask, onClose, t, copy, theme, toggle, lang, setLang]);

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
        data-testid="command-palette"
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
          <kbd className="shrink-0 rounded-md border border-edge bg-elevated px-1.5 py-0.5 text-2xs text-gray-500">{MOD}K</kbd>
        </div>
        <div className="max-h-[52vh] overflow-auto p-1.5">
          {items.length === 0 ? <div className="px-3 py-6 text-center text-sm text-gray-500">{copy.empty}</div> : null}
          {items.map((command, index) => (
            <div key={command.id}>
              {command.group !== items[index - 1]?.group ? (
                <div className="px-3 pb-1 pt-2 text-2xs font-medium uppercase tracking-[0.08em] text-gray-500" data-testid={`command-palette-${command.group}s`}>
                  {command.group === "task" ? copy.tasks : copy.actions}
                </div>
              ) : null}
              <button
                onMouseEnter={() => setSel(index)}
                onClick={() => command.run()}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${index === sel ? "bg-hover" : ""}`}
              >
                <span className={index === sel ? "text-accent-soft" : "text-gray-500"}>{command.icon}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-gray-200">{command.label}</span>
                {command.hint ? <span className="shrink-0 font-mono text-2xs text-gray-500">{command.hint}</span> : null}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
