import { useFocusTrap } from "../hooks/useFocusTrap";
import { useDismissOnEscape } from "../hooks/useDismissOnEscape";
import { useI18n } from "../i18n";
import { shortcutsIn, type Shortcut } from "../shortcuts";
import { IconButton } from "./ui";

const GROUPS = ["global", "task"] as const;

/** One key cap. The v3 cap (`ui-kbd`), but read aloud: here the keys are the content. */
function Key({ children }: { children: string }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}

/** Keyboard reference for the window and the active task. Opened with `?`. */
export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { lang, t } = useI18n();
  const trapRef = useFocusTrap<HTMLDivElement>(open);
  // v1.16 — sheet chrome lives in the i18n dict.
  const title = t("shortcuts.title");
  const groupTitle = (group: (typeof GROUPS)[number]) => group === "global"
    ? t("shortcuts.groupWindow")
    : t("shortcuts.groupTask");

  useDismissOnEscape(open, onClose);
  if (!open) return null;

  return (
    <div className="shortcuts-scrim fixed inset-0 z-shortcuts flex items-center justify-center p-4 animate-fade-in" onClick={onClose}>
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={title}
        data-testid="shortcuts-sheet"
        onClick={(event) => event.stopPropagation()}
        className="shortcuts-sheet animate-rise-in"
      >
        <div className="shortcuts-head">
          <span className="shortcuts-title">{title}</span>
          <IconButton icon="close" label={t("common.close")} onClick={onClose} />
        </div>
        <div className="max-h-[70vh] space-y-5 overflow-auto px-5 py-4">
          {GROUPS.map((group) => (
            <div key={group}>
              <div className="shortcuts-group-title">{groupTitle(group)}</div>
              <ul className="space-y-1">
                {shortcutsIn(group).map((shortcut: Shortcut) => (
                  <li key={shortcut.id} className="flex items-center gap-3 py-0.5">
                    <span className="shortcuts-label">{shortcut.label[lang]}</span>
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
