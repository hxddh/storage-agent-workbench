import { useFocusTrap } from "../hooks/useFocusTrap";
import { useDismissOnEscape } from "../hooks/useDismissOnEscape";
import { useI18n } from "../i18n";
import { shortcutsIn, type Shortcut } from "../shortcuts";

const GROUPS = ["global", "task"] as const;

function Key({ children }: { children: string }) {
  return (
    <kbd className="min-w-6 rounded-md border border-edge-strong bg-elevated px-1.5 py-0.5 text-center font-sans text-2xs font-medium text-gray-300">
      {children}
    </kbd>
  );
}

/** Discoverable keyboard control for the Agent window and active task. */
export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { lang, t } = useI18n();
  const trapRef = useFocusTrap<HTMLDivElement>(open);
  const title = lang === "zh" ? "Agent 快捷键" : "Agent shortcuts";
  const groupTitle = (group: (typeof GROUPS)[number]) => group === "global"
    ? (lang === "zh" ? "全局" : "Global")
    : (lang === "zh" ? "当前 Task" : "Active task");

  useDismissOnEscape(open, onClose);
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-shortcuts flex items-center justify-center bg-scrim p-4 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={title}
        data-testid="shortcuts-sheet"
        onClick={(event) => event.stopPropagation()}
        className="w-[min(460px,94vw)] overflow-hidden rounded-2xl border border-edge bg-panel shadow-pop animate-scale-in"
      >
        <div className="flex items-center justify-between border-b border-edge px-5 py-3.5">
          <span className="text-sm font-semibold text-gray-100">{title}</span>
          <button
            onClick={onClose}
            aria-label={t("common.close")}
            className="grid h-7 w-7 place-items-center rounded-md text-gray-500 transition-colors hover:bg-hover hover:text-gray-200"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="max-h-[70vh] space-y-4 overflow-auto px-5 py-4">
          {GROUPS.map((group) => (
            <div key={group}>
              <div className="mb-1.5 text-2xs font-medium uppercase tracking-wider text-gray-500">
                {groupTitle(group)}
              </div>
              <ul className="space-y-1">
                {shortcutsIn(group).map((shortcut: Shortcut) => (
                  <li key={shortcut.id} className="flex items-center gap-3 py-0.5">
                    <span className="min-w-0 flex-1 truncate text-xs text-gray-300">{shortcut.label[lang]}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {shortcut.keys.map((key) => <Key key={key}>{key}</Key>)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
