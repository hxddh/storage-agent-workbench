import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { meetsMinQuery, minQueryFor } from "../taskFind";
import { Icon } from "./icons";

/** Document find for the active Agent task — a strip under the title bar,
 * on the reading column, not a corner gadget. */
export function FindBar({
  query,
  onQuery,
  total,
  index,
  onStep,
  onClose,
  focusTick = 0,
}: {
  query: string;
  onQuery: (q: string) => void;
  total: number;
  index: number;
  onStep: (delta: number) => void;
  onClose: () => void;
  /** Bumped when ⌘F is pressed while the overlay is already open, so the
   * input is re-selected the way a browser / Codex find widget is. */
  focusTick?: number;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const copy = {
    placeholder: t("find.placeholder"),
    tooShort: (n: number) => t("find.tooShort", { n }),
    counter: (i: number, n: number) => t("find.counter", { i, n }),
    none: t("find.none"),
    previous: t("find.previous"),
    next: t("find.next"),
  };

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusTick]);

  const short = query.trim().length > 0 && !meetsMinQuery(query);
  const status = short
    ? copy.tooShort(minQueryFor(query))
    : total > 0
      ? copy.counter(index + 1, total)
      : query.trim()
        ? copy.none
        : "";

  return (
    <div className="native-find-host" data-find-skip>
      <div className="native-find" role="search" data-testid="find-bar">
        <Icon name="search" size={14} className="shrink-0 text-gray-500" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            // v1.16 — stop here: the window closes its top overlay on Escape,
            // and one keypress must not close both the find bar and the
            // palette (or Settings) behind it.
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            } else if (event.key === "Enter" || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "g")) {
              event.preventDefault();
              event.stopPropagation();
              onStep(event.shiftKey ? -1 : 1);
            }
          }}
          placeholder={copy.placeholder}
          aria-label={copy.placeholder}
          data-testid="find-input"
          className="min-w-0 flex-1 bg-transparent text-sm text-gray-100 placeholder:text-gray-500 outline-none"
        />
        <span className="native-find-status" data-testid="find-status" aria-live="polite">
          {status}
        </span>
        <div className="flex shrink-0 items-center">
          <FindStep dir={-1} onStep={onStep} disabled={total === 0} label={copy.previous} />
          <FindStep dir={1} onStep={onStep} disabled={total === 0} label={copy.next} />
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            data-testid="find-close"
            className="native-icon-button"
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Find overlay on the empty start, where there is no transcript to search yet. */
export function IdleFindBar({ onClose, focusTick = 0 }: { onClose: () => void; focusTick?: number }) {
  const [query, setQuery] = useState("");
  return (
    <FindBar
      query={query}
      onQuery={setQuery}
      total={0}
      index={0}
      onStep={() => undefined}
      onClose={onClose}
      focusTick={focusTick}
    />
  );
}

function FindStep({
  dir,
  onStep,
  disabled,
  label,
}: {
  dir: 1 | -1;
  onStep: (d: number) => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onStep(dir)}
      disabled={disabled}
      aria-label={label}
      data-testid={dir === 1 ? "find-next" : "find-prev"}
      className="native-icon-button disabled:opacity-40"
    >
      <Icon name={dir === 1 ? "arrowDown" : "arrowUp"} size={13} />
    </button>
  );
}
