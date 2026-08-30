import { useEffect, useRef } from "react";
import { useI18n } from "../i18n";
import { MIN_QUERY } from "../taskFind";

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
  const { lang, t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const copy = lang === "zh"
    ? {
        placeholder: "在当前 Agent Task 中查找…",
        tooShort: (n: number) => `至少输入 ${n} 个字符`,
        counter: (i: number, n: number) => `${i} / ${n}`,
        none: "没有匹配项",
        previous: "上一个匹配",
        next: "下一个匹配",
      }
    : {
        placeholder: "Find in the active Agent task…",
        tooShort: (n: number) => `Type at least ${n} characters`,
        counter: (i: number, n: number) => `${i} / ${n}`,
        none: "No matches",
        previous: "Previous match",
        next: "Next match",
      };

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const short = query.trim().length > 0 && query.trim().length < MIN_QUERY;
  const status = short
    ? copy.tooShort(MIN_QUERY)
    : total > 0
      ? copy.counter(index + 1, total)
      : query.trim()
        ? copy.none
        : "";

  return (
    <div
      className="sticky top-0 z-sticky mx-auto flex w-full max-w-3xl items-center gap-2 rounded-b-lg border border-t-0 border-edge bg-elevated/95 px-3 py-2 shadow-pop backdrop-blur-sm animate-fade-in"
      role="search"
      data-find-skip
      data-testid="find-bar"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "Enter") {
            event.preventDefault();
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
          className="grid h-7 w-7 place-items-center rounded-md text-gray-500 transition-colors hover:bg-hover hover:text-gray-200"
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
      className="rounded-md px-1.5 py-1 text-gray-500 transition-colors hover:bg-hover hover:text-gray-200 disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {dir === 1 ? "↓" : "↑"}
    </button>
  );
}
