import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentTaskSummary } from "../agent/navigationModel";
import { getPaletteActions } from "../agent/paletteActions";
import { useI18n } from "../i18n";
import { useTheme } from "../theme";
import { MOD } from "../shortcuts";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useDismissOnEscape } from "../hooks/useDismissOnEscape";
import { Icon, type IconName } from "./icons";

type Cmd = { id: string; label: string; hint?: string; icon: IconName; run: () => void; group: "action" | "task" };

/** v1.13 — subsequence fuzzy score (higher is better, -1 is no match).
 * Contiguous runs and prefix matches score above scattered letters, so
 * `srvy` still finds `account survey` but `survey account` ranks first. */
export function fuzzyScore(query: string, label: string): number {
  const q = query.toLowerCase();
  const s = label.toLowerCase();
  if (!q) return 0;
  let qi = 0;
  let score = 0;
  let run = 0;
  for (let si = 0; si < s.length && qi < q.length; si++) {
    if (s[si] === q[qi]) {
      qi++;
      run++;
      score += 2 + run; // contiguous run bonus grows quadratically-ish
      if (si === qi - 1) score += 4; // prefix alignment
    } else {
      run = 0;
    }
  }
  if (qi < q.length) return -1;
  return score - s.length * 0.01; // shorter labels win ties
}

/** ⌘K: switch tasks or run a real runtime action. An overlay, not a destination. */
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
        newTask: "新任务",
        settings: "打开设置",
        actions: "操作",
        tasks: "任务",
        empty: "没有匹配的任务或命令。",
        stop: "停止当前执行",
        resume: "恢复中断的执行",
        steer: "调整当前执行的方向",
        focus: "聚焦输入框",
        compact: "压缩上下文",
        themeLight: "切换到浅色主题",
        themeDark: "切换到深色主题",
        langEn: "Switch to English",
        langZh: "切换到中文",
      }
    : {
        placeholder: "Search tasks or run a command…",
        newTask: "New task",
        settings: "Open settings",
        actions: "Actions",
        tasks: "Tasks",
        empty: "No matching tasks or commands.",
        stop: "Stop current execution",
        resume: "Resume interrupted execution",
        steer: "Steer current execution",
        focus: "Focus composer",
        compact: "Compact context",
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
    const actions: Cmd[] = [
      { id: "new", label: copy.newTask, hint: `${MOD}N`, icon: "compose", run: () => { onNew(); onClose(); }, group: "action" },
      { id: "focus", label: copy.focus, hint: `${MOD}L`, icon: "arrowUp", run: () => { live.focusComposer?.(); onClose(); }, group: "action" },
      { id: "settings", label: copy.settings, icon: "settings", run: () => { onOpenSettings(); onClose(); }, group: "action" },
    ];
    if (live.busy) {
      actions.splice(2, 0, {
        id: "stop", label: copy.stop, hint: `${MOD}.`, icon: "stop",
        run: () => { live.stop?.(); onClose(); }, group: "action",
      }, {
        id: "steer", label: copy.steer, hint: `${MOD}L`, icon: "arrowRight",
        run: () => { live.focusComposer?.(); onClose(); }, group: "action",
      });
    }
    if (live.canResume) {
      actions.splice(2, 0, { id: "resume", label: copy.resume, icon: "play", run: () => { live.resume?.(); onClose(); }, group: "action" });
    }
    if (live.hasTask && !live.busy && !live.compacting && live.compact) {
      actions.splice(actions.length - 1, 0, {
        id: "compact", label: copy.compact, icon: "refresh",
        run: () => { live.compact?.(); onClose(); }, group: "action",
      });
    }
    actions.push(
      { id: "theme", label: theme === "dark" ? copy.themeLight : copy.themeDark, icon: "sun", run: () => { toggle(); onClose(); }, group: "action" },
      { id: "lang", label: lang === "zh" ? copy.langEn : copy.langZh, icon: "globe", run: () => { setLang(lang === "zh" ? "en" : "zh"); onClose(); }, group: "action" },
    );
    const taskItems: Cmd[] = tasks.map((task) => ({
      id: `task:${task.id}`,
      label: task.title || t("common.untitled"),
      icon: "file",
      run: () => { onSelectTask(task.id); onClose(); },
      group: "task",
    }));
    const all = [...actions, ...taskItems];
    const query = q.trim();
    if (!query) return all;
    // Tasks rank by fuzzy score; actions keep substring matching (few, fixed).
    const ranked = taskItems
      .map((command) => ({ command, score: fuzzyScore(query, command.label) }))
      .filter((row) => row.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((row) => row.command);
    const ql = query.toLowerCase();
    const matchedActions = actions.filter((command) => command.label.toLowerCase().includes(ql));
    return [...matchedActions, ...ranked];
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
    <div className="fixed inset-0 z-palette flex items-start justify-center bg-scrim pt-[16vh] animate-fade-in" onClick={onClose}>
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label={copy.placeholder}
        data-testid="command-palette"
        className="w-[min(600px,92vw)] overflow-hidden rounded-2xl border border-edge bg-canvas shadow-pop animate-scale-in"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-edge px-4">
          <Icon name="search" size={16} className="shrink-0 text-gray-500" />
          <input
            ref={inputRef}
            value={q}
            onChange={(event) => { setQ(event.target.value); setSel(0); }}
            onKeyDown={onKeyDown}
            placeholder={copy.placeholder}
            className="w-full bg-transparent py-3.5 text-base text-gray-100 placeholder:text-gray-500 focus:outline-none"
          />
        </div>
        <div className="max-h-[52vh] overflow-auto p-2">
          {items.length === 0 ? <div className="px-3 py-6 text-center text-sm text-gray-500">{copy.empty}</div> : null}
          {items.map((command, index) => (
            <div key={command.id}>
              {command.group !== items[index - 1]?.group ? (
                <div className="px-2 pb-1 pt-2 text-2xs font-medium text-gray-500" data-testid={`command-palette-${command.group}s`}>
                  {command.group === "task" ? copy.tasks : copy.actions}
                </div>
              ) : null}
              <button
                onMouseEnter={() => setSel(index)}
                onClick={() => command.run()}
                className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-[background-color] duration-fast ${index === sel ? "bg-hover" : ""}`}
              >
                <Icon name={command.icon} size={15} className={index === sel ? "text-gray-100" : "text-gray-500"} />
                <span className="min-w-0 flex-1 truncate text-sm text-gray-100">{command.label}</span>
                {command.hint ? <span className="shrink-0 font-mono text-2xs text-gray-500">{command.hint}</span> : null}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
