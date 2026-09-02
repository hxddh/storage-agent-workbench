import { useFocusTrap } from "../hooks/useFocusTrap";
import { useDismissOnEscape } from "../hooks/useDismissOnEscape";
import { useI18n } from "../i18n";
import { shortcutsIn, type Shortcut } from "../shortcuts";
import { Icon } from "./icons";

const GROUPS = ["global", "task"] as const;

function Key({ children }: { children: string }) {
  return (
    <kbd className="min-w-6 rounded-md bg-elevated px-1.5 py-0.5 text-center font-sans text-2xs font-medium text-gray-200">
      {children}
    </kbd>
  );
}

/** Keyboard reference for the window and the active task. Opened with `?`. */
export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { lang, t } = useI18n();
  const trapRef = useFocusTrap<HTMLDivElement>(open);
  const title = lang === "zh" ? "键盘快捷键" : "Keyboard shortcuts";
  const groupTitle = (group: (typeof GROUPS)[number]) => group === "global"
    ? (lang === "zh" ? "窗口" : "Window")
    : (lang === "zh" ? "当前任务" : "Active task");

  useDismissOnEscape(open, onClose);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-shortcuts flex items-center justify-center bg-scrim p-4 animate-fade-in" onClick={onClose}>
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={title}
        data-testid="shortcuts-sheet"
        onClick={(event) => event.stopPropagation()}
        className="w-[min(480px,94vw)] overflow-hidden rounded-2xl border border-edge bg-canvas shadow-pop animate-scale-in"
      >
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <span className="text-sm font-medium text-gray-100">{title}</span>
          <button onClick={onClose} aria-label={t("common.close")} className="native-icon-button">
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="max-h-[70vh] space-y-5 overflow-auto px-5 py-4">
          {GROUPS.map((group) => (
            <div key={group}>
              <div className="mb-1.5 text-2xs font-medium text-gray-500">{groupTitle(group)}</div>
              <ul className="space-y-1">
                {shortcutsIn(group).map((shortcut: Shortcut) => (
                  <li key={shortcut.id} className="flex items-center gap-3 py-0.5">
                    <span className="min-w-0 flex-1 truncate text-sm text-gray-200">{shortcut.label[lang]}</span>
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
