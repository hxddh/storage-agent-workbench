import { useEffect } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useI18n } from "../i18n";
import { shortcutsIn, type Shortcut } from "../shortcuts";

const GROUPS = [
  { group: "global" as const, titleKey: "keys.groupGlobal" },
  { group: "chat" as const, titleKey: "keys.groupChat" },
];

function Key({ children }: { children: string }) {
  return (
    <kbd className="min-w-[1.5rem] rounded-[5px] border border-edge-strong bg-elevated px-1.5 py-0.5 text-center font-sans text-2xs font-medium text-gray-300">
      {children}
    </kbd>
  );
}

/**
 * The keyboard shortcuts, in one place.
 *
 * Every shortcut in this app already existed; none of them were written down
 * anywhere in the product. A shortcut nobody can discover is a shortcut only its
 * author uses.
 */
export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const trapRef = useFocusTrap<HTMLDivElement>(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[75] flex items-center justify-center bg-scrim p-4 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={t("keys.title")}
        data-testid="shortcuts-sheet"
        onClick={(e) => e.stopPropagation()}
        className="w-[min(460px,94vw)] overflow-hidden rounded-2xl border border-edge bg-panel shadow-pop animate-scale-in"
      >
        <div className="flex items-center justify-between border-b border-edge px-5 py-3.5">
          <span className="text-sm font-semibold text-gray-100">{t("keys.title")}</span>
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
          {GROUPS.map((g) => (
            <div key={g.group}>
              <div className="mb-1.5 text-3xs font-medium uppercase tracking-wider text-gray-600">
                {t(g.titleKey)}
              </div>
              <ul className="space-y-1">
                {shortcutsIn(g.group).map((r: Shortcut) => (
                  <li key={r.id} className="flex items-center gap-3 py-0.5">
                    <span className="min-w-0 flex-1 truncate text-xs text-gray-300">{t(r.labelKey)}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {r.keys.map((k) => <Key key={k}>{k}</Key>)}
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
