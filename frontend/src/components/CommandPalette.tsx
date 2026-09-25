import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentTaskSummary } from "../agent/navigationModel";
import { getPaletteActions } from "../agent/paletteActions";
import { useI18n } from "../i18n";
import { useTheme } from "../theme";
import { MOD } from "../shortcuts";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useDismissOnEscape } from "../hooks/useDismissOnEscape";
import { Icon, type IconName } from "./icons";

/** A shortcut as separate key caps (⌘ N, Ctrl N), never run-together text. */
function Keys({ hint }: { hint: string }) {
  const keys = hint.startsWith(MOD) && hint.length > MOD.length ? [MOD, hint.slice(MOD.length)] : [hint];
  return (
    <span className="flex shrink-0 items-center gap-1" data-testid="palette-keys">
      {keys.map((key) => <kbd key={key} className="ui-kbd">{key}</kbd>)}
    </span>
  );
}

type Cmd = { id: string; label: string; hint?: string; icon: IconName; run: () => void; group: "action" | "task"; marks?: number[] };

/** How many tasks the palette lists before the user types (most recent first). */
const RECENT_LIMIT = 8;

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

/** v3.0 — the label positions a query matches (the same greedy subsequence
 * `fuzzyScore` walks), so the palette can mark them. */
export function fuzzyIndices(query: string, label: string): number[] {
  const q = query.toLowerCase();
  const s = label.toLowerCase();
  const out: number[] = [];
  let qi = 0;
  for (let si = 0; si < s.length && qi < q.length; si++) {
    if (s[si] === q[qi]) { out.push(si); qi++; }
  }
  return qi === q.length ? out : [];
}

function Marked({ label, marks }: { label: string; marks?: number[] }) {
  if (!marks || marks.length === 0) return <>{label}</>;
  const set = new Set(marks);
  const parts: Array<{ text: string; hit: boolean }> = [];
  for (let i = 0; i < label.length; i++) {
    const hit = set.has(i);
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += label[i];
    else parts.push({ text: label[i], hit });
  }
  return <>{parts.map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}</>;
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
  // v1.16 — palette copy lives in the i18n dict, like every other surface.
  // Memoized: a fresh object every render defeated the items useMemo below.
  const copy = useMemo(() => ({
    placeholder: t("palette.placeholder"),
    newTask: t("palette.newTask"),
    settings: t("palette.settings"),
    actions: t("palette.actions"),
    tasks: t("palette.tasks"),
    empty: t("palette.empty"),
    stop: t("palette.stop"),
    resume: t("palette.resume"),
    steer: t("palette.steer"),
    focus: t("palette.focus"),
    compact: t("palette.compact"),
    themeLight: t("palette.themeLight"),
    themeDark: t("palette.themeDark"),
    langEn: t("palette.langEn"),
    langZh: t("palette.langZh"),
    shortcuts: t("palette.shortcuts"),
    recent: t("palette.recent"),
    navigate: t("palette.navigate"),
    run: t("palette.run"),
    close: t("palette.close"),
  }), [t]);
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
    if (live.shortcuts) {
      actions.push({
        id: "shortcuts", label: copy.shortcuts, hint: "?", icon: "info",
        run: () => { live.shortcuts?.(); onClose(); }, group: "action",
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
    const query = q.trim();
    // v3.0 — at rest: the few recent tasks first (switching is the common
    // case), then the actions. The engine catalog is gone: the empty start's
    // starters and the Composer are where work is worded.
    if (!query) return [...taskItems.slice(0, RECENT_LIMIT), ...actions];
    // Everything ranks by one fuzzy score; the matched letters are marked.
    const rank = (list: Cmd[]) => list
      .map((command) => ({ command, score: fuzzyScore(query, command.label) }))
      .filter((row) => row.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((row) => ({ ...row.command, marks: fuzzyIndices(query, row.command.label) }));
    return [...rank(taskItems), ...rank(actions)];
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

  const groupLabel = (group: Cmd["group"]) => (group === "task" ? (q.trim() ? copy.tasks : copy.recent) : copy.actions);

  return (
    <div className="fixed inset-0 z-palette flex items-start justify-center bg-scrim pt-[16vh] animate-fade-in" onClick={onClose}>
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label={copy.placeholder}
        data-testid="command-palette"
        className="native-palette w-[min(600px,92vw)] overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="native-palette-search">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={q}
            onChange={(event) => { setQ(event.target.value); setSel(0); }}
            onKeyDown={onKeyDown}
            placeholder={copy.placeholder}
            // The palette itself is the focused surface: no inner focus box.
            data-focus-ring="container"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={items[sel] ? `palette-item-${sel}` : undefined}
          />
        </div>
        <div className="native-palette-list" id="command-palette-list" role="listbox" aria-label={copy.placeholder}>
          {items.length === 0 ? <div className="native-palette-empty">{copy.empty}</div> : null}
          {items.map((command, index) => (
            <div key={command.id} role="presentation">
              {command.group !== items[index - 1]?.group ? (
                <div className="native-palette-group ui-label" role="presentation" data-testid={`command-palette-${command.group}s`}>
                  {groupLabel(command.group)}
                </div>
              ) : null}
              <button
                type="button"
                id={`palette-item-${index}`}
                role="option"
                aria-selected={index === sel}
                data-active={index === sel ? "true" : undefined}
                tabIndex={-1}
                onMouseEnter={() => setSel(index)}
                onClick={() => command.run()}
                className="native-palette-item"
              >
                <Icon name={command.icon} size={16} />
                <span className="native-palette-label"><Marked label={command.label} marks={command.marks} /></span>
                {command.hint ? <Keys hint={command.hint} /> : null}
              </button>
            </div>
          ))}
        </div>
        <div className="native-palette-foot" aria-hidden>
          <span><kbd className="ui-kbd">↑</kbd><kbd className="ui-kbd">↓</kbd>{copy.navigate}</span>
          <span><kbd className="ui-kbd">↵</kbd>{copy.run}</span>
          <span><kbd className="ui-kbd">Esc</kbd>{copy.close}</span>
        </div>
      </div>
    </div>
  );
}
