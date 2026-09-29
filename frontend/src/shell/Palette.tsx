import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { TaskRow } from "../api/types";
import { Kbd } from "../components/ui";
import { useI18n } from "../i18n";
import { useApp } from "./context";

type Entry = { id: string; group: "recent" | "actions"; label: string; keys?: string[]; run: () => void };

/** Fuzzy subsequence score: consecutive and word-start matches rank higher. Null when no match. */
export function score(query: string, text: string): { score: number; hits: number[] } | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { score: 0, hits: [] };
  const s = text.toLowerCase();
  const hits: number[] = [];
  let at = 0;
  let total = 0;
  for (const ch of q) {
    const i = s.indexOf(ch, at);
    if (i < 0) return null;
    total += (i === at ? 3 : 1) + (i === 0 || /\s|[-_/]/.test(s[i - 1]) ? 2 : 0);
    hits.push(i);
    at = i + 1;
  }
  return { score: total - s.length * 0.01, hits };
}

/** The palette (⌘K): Recent tasks and Actions under one fuzzy ranking. A combobox over a listbox. */
export function Palette() {
  const { t } = useI18n();
  const app = useApp();
  const [query, setQuery] = useState("");
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    ref.current?.showModal();
    api.tasks().then((r) => setTasks(r.tasks)).catch(() => {});
  }, []);

  const close = () => app.setPalette(false);
  const entries: Entry[] = useMemo(() => [
    ...tasks.slice(0, query ? 50 : 8).map((task) => ({ id: task.id, group: "recent" as const, label: task.title,
      run: () => app.openTask(task.id) })),
    { id: "new", group: "actions", label: t("nav.newTask"), keys: ["⌘", "N"], run: () => app.goHome() },
    ...(app.route.kind === "task" ? [{ id: "pane", group: "actions" as const, label: t("palette.details"), keys: ["⌘", "I"],
      run: () => app.setPane(app.pane ? null : { tab: "details" }) }] : []),
    { id: "settings", group: "actions", label: t("palette.settings"), keys: ["⌘", ","], run: () => app.openSettings() },
  ], [tasks, query, t, app]);

  const ranked = useMemo(() => entries
    .map((e) => ({ e, m: score(query, e.label) }))
    .filter((x) => x.m)
    .sort((a, b) => (query ? b.m!.score - a.m!.score : 0)), [entries, query]);

  useEffect(() => setActive(0), [query]);

  const choose = (i: number) => {
    const hit = ranked[i];
    if (!hit) return;
    close();
    hit.e.run();
  };

  return (
    <dialog ref={ref} className="palette" aria-label={t("palette.label")} onClose={close}
      onCancel={(e) => { e.preventDefault(); close(); }} onClick={(e) => { if (e.target === ref.current) close(); }}>
      <input
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={ranked[active] ? `pal-${ranked[active].e.id}` : undefined}
        autoFocus
        className="palette-input"
        data-focus-ring="container"
        placeholder={t("palette.placeholder")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(ranked.length - 1, active + 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(0, active - 1)); }
          if (e.key === "Enter") { e.preventDefault(); choose(active); }
        }}
      />
      <ul id="palette-list" role="listbox" className="palette-list">
        {ranked.length === 0 ? <li className="palette-empty">{t("palette.empty")}</li> : null}
        {ranked.map(({ e, m }, i) => (
          <li key={`${e.group}-${e.id}`}>
            {i === 0 || ranked[i - 1].e.group !== e.group ? (
              <div className="palette-group" aria-hidden>{t(e.group === "recent" ? "palette.recent" : "palette.actions")}</div>
            ) : null}
            <div id={`pal-${e.id}`} role="option" aria-selected={i === active} className="palette-item"
              onMouseEnter={() => setActive(i)} onClick={() => choose(i)}>
              <span>{marked(e.label, m!.hits)}</span>
              {e.keys ? <Kbd keys={e.keys} /> : null}
            </div>
          </li>
        ))}
      </ul>
      <footer className="palette-foot" aria-hidden>
        <span><Kbd keys={["↑", "↓"]} /></span><span><Kbd keys={["↵"]} /></span><span><Kbd keys={["esc"]} /></span>
      </footer>
    </dialog>
  );
}

function marked(text: string, hits: number[]) {
  if (!hits.length) return text;
  const set = new Set(hits);
  return Array.from(text).map((ch, i) => (set.has(i) ? <mark key={i}>{ch}</mark> : ch));
}
