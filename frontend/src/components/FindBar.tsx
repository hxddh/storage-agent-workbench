import { useEffect, useRef } from "react";
import { useI18n } from "../i18n";
import { meetsMinQuery, minQueryFor } from "../taskFind";

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
      className="sticky top-0 z-sticky mx-auto mb-3 flex w-full max-w-[46rem] items-center gap-2 rounded-xl border border-edge bg-panel px-3 py-1.5 shadow-pop animate-scale-in"
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
        className="min-w-0 flex-1 bg-transparent text-sm text-gray-100 placeholder:text-gray-500 outline-none"
      />
      <span className="shrink-0 tabular-nums text-2xs text-gray-500" data-testid="find-status" aria-live="polite">
        {status}
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        <FindStep dir={-1} onStep={onStep} disabled={total === 0} label={copy.previous} />
        <FindStep dir={1} onStep={onStep} disabled={total === 0} label={copy.next} />
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          data-testid="find-close"
          className="native-icon-button"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
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
      className="native-icon-button disabled:opacity-40"
    >
      {dir === 1 ? "↓" : "↑"}
    </button>
  );
}
