import { useEffect, useRef } from "react";
import { useI18n } from "../i18n";
import { MIN_QUERY, type FindHit, totalMatches } from "../threadFind";

/**
 * Find inside the open investigation.
 *
 * Modelled on a browser's find bar rather than a modal: a search that covers
 * the thread you are reading should not hide the thread you are reading. It
 * floats at the top of the scroll area, leaves the conversation visible behind
 * it, and every control is reachable from the keyboard without leaving the
 * input — Enter and Shift+Enter step, Escape closes.
 */
export function FindBar({
  query,
  onQuery,
  hits,
  index,
  onStep,
  onClose,
}: {
  query: string;
  onQuery: (q: string) => void;
  hits: FindHit[];
  index: number;
  onStep: (delta: number) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const total = totalMatches(hits);
  const short = query.trim().length > 0 && query.trim().length < MIN_QUERY;
  // Three states, and they are genuinely different: nothing typed yet, a query
  // too short to run, and a query that ran and found nothing. Collapsing the
  // last two into one "no results" would tell the user their search failed when
  // it never ran.
  const status = short
    ? t("find.tooShort", { n: MIN_QUERY })
    : total > 0
      ? t("find.counter", { i: index + 1, n: total })
      : query.trim()
        ? t("find.none")
        : "";

  return (
    <div
      className="sticky top-0 z-sticky mx-auto flex w-full max-w-3xl items-center gap-2
                 rounded-b-lg border border-t-0 border-edge bg-elevated/95 px-3 py-2
                 shadow-pop backdrop-blur-sm animate-fade-in"
      role="search"
      data-testid="find-bar"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          }
        }}
        placeholder={t("find.placeholder")}
        aria-label={t("find.placeholder")}
        data-testid="find-input"
        className="min-w-0 flex-1 bg-transparent text-sm text-gray-100 placeholder:text-gray-600
                   outline-none"
      />
      <span
        className="shrink-0 tabular-nums text-2xs text-gray-500"
        data-testid="find-status"
        aria-live="polite"
      >
        {status}
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        <FindStep dir={-1} onStep={onStep} disabled={total === 0} label={t("find.prev")} />
        <FindStep dir={1} onStep={onStep} disabled={total === 0} label={t("find.next")} />
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          data-testid="find-close"
          className="rounded-md px-1.5 py-1 text-gray-500 transition-colors hover:bg-hover hover:text-gray-200"
        >
          ✕
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
      className="rounded-md px-1.5 py-1 text-gray-500 transition-colors hover:bg-hover
                 hover:text-gray-200 disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {dir === 1 ? "↓" : "↑"}
    </button>
  );
}
