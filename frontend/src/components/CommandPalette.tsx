import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummaryRow } from "../types";

type Cmd = { id: string; label: string; hint?: string; icon: React.ReactNode; run: () => void };

const I = (d: string) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d.split("|").map((p, i) => <path key={i} d={p} />)}
  </svg>
);

/** ⌘K quick-switcher: new chat, settings, and jump to any recent chat. */
export function CommandPalette({
  open,
  onClose,
  sessions,
  onSelectSession,
  onNew,
  onOpenSettings,
}: {
  open: boolean;
  onClose: () => void;
  sessions: SessionSummaryRow[];
  onSelectSession: (id: string) => void;
  onNew: () => void;
  onOpenSettings: () => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const items = useMemo<Cmd[]>(() => {
    const actions: Cmd[] = [
      { id: "new", label: "New chat", hint: "⌘N", icon: I("M12 5v14|M5 12h14"), run: () => { onNew(); onClose(); } },
      { id: "settings", label: "Settings & providers", icon: I("M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M3 12h2|M19 12h2|M12 3v2|M12 19v2"), run: () => { onOpenSettings(); onClose(); } },
    ];
    const chats: Cmd[] = sessions.map((s) => ({
      id: `s:${s.id}`,
      label: s.title || "Untitled",
      hint: "chat",
      icon: I("M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"),
      run: () => { onSelectSession(s.id); onClose(); },
    }));
    const all = [...actions, ...chats];
    const query = q.trim().toLowerCase();
    return query ? all.filter((c) => c.label.toLowerCase().includes(query)) : all;
  }, [q, sessions, onNew, onOpenSettings, onSelectSession, onClose]);

  useEffect(() => {
    if (sel >= items.length) setSel(Math.max(0, items.length - 1));
  }, [items.length, sel]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); items[sel]?.run(); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 pt-[14vh] backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div
        className="w-[min(560px,92vw)] overflow-hidden rounded-2xl border border-edge bg-panel shadow-pop animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-edge px-4">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-gray-500"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={onKeyDown}
            placeholder="Search chats or run a command…"
            className="w-full bg-transparent py-3.5 text-[14px] text-gray-100 placeholder:text-gray-600 focus:outline-none"
          />
        </div>
        <div className="max-h-[52vh] overflow-auto p-1.5">
          {items.length === 0 && <div className="px-3 py-6 text-center text-[13px] text-gray-600">No matches</div>}
          {items.map((c, i) => (
            <button
              key={c.id}
              onMouseEnter={() => setSel(i)}
              onClick={() => c.run()}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${i === sel ? "bg-hover" : ""}`}
            >
              <span className={i === sel ? "text-accent-soft" : "text-gray-500"}>{c.icon}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-gray-200">{c.label}</span>
              {c.hint && <span className="shrink-0 text-[11px] text-gray-600">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
