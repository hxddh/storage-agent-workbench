import { useEffect, useRef } from "react";
import { useI18n } from "../i18n";
import { meetsMinQuery, minQueryFor } from "../taskFind";
import { IconButton } from "./ui";

/** Browser-like find for the active Agent task. */
export function FindBar({
  query,
  onQuery,
  total,
  index,
  onStep,
  onClose,
}: {
  query: string;
  onQuery: (q: string) => void;
  total: number;
  index: number;
  onStep: (delta: number) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);
  // v1.15 — find copy lives in the i18n dict.
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
  }, []);

  const short = query.trim().length > 0 && !meetsMinQuery(query);
  const status = short
    ? copy.tooShort(minQueryFor(query))
    : total > 0
      ? copy.counter(index + 1, total)
      : query.trim()
        ? copy.none
        : "";

  return (
    <div
      className="find-bar sticky top-0 z-sticky animate-scale-in"
      role="search"
      data-find-skip
      data-testid="find-bar"
    >
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
          } else if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            onStep(event.shiftKey ? -1 : 1);
          }
        }}
        placeholder={copy.placeholder}
        aria-label={copy.placeholder}
        data-testid="find-input"
        className="find-input"
      />
      <span className="find-status" data-testid="find-status" aria-live="polite">
        {status}
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        <FindStep dir={-1} onStep={onStep} disabled={total === 0} label={copy.previous} />
        <FindStep dir={1} onStep={onStep} disabled={total === 0} label={copy.next} />
        <IconButton icon="close" label={t("common.close")} onClick={onClose} data-testid="find-close" />
      </div>
    </div>
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
      className="ui-icon-btn"
    >
      {dir === 1 ? "↓" : "↑"}
    </button>
  );
}
