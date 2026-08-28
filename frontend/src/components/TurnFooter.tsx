import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { fmtDuration, fmtTokens } from "./TurnMetrics";
import { fmtCallMs, isFailed } from "./LiveTrace";
import { CallDetail } from "./CallDetail";
import type { Grounding, ToolActivity, TokenUsage } from "../types";

/**
 * Everything about a finished turn, on one line.
 *
 * It replaces three separate affordances that had accumulated around each
 * answer: a tool trace ABOVE it ("Ran 5 checks · 4 tools"), a metrics strip
 * BELOW it ("5 tool calls (4)"), and a grounding card below that ("Why this
 * answer"). Two of those described the same five tool calls, in two vocabularies,
 * on opposite sides of the answer, each with its own expander — a reader had to
 * look in two places to learn they were the same thing.
 *
 * Codex, Claude Code, Cursor and Dia all converge on one metadata affordance per
 * turn, and on showing process in execution order rather than split before/after
 * the answer. This is that: one line, one expansion, one vocabulary.
 *
 * The live trace during streaming is a different job — there the rows ARE the
 * progress indicator — and stays where it is.
 */

/** Does this evidence line refer to a tool the turn actually ran?
 *
 * Matching is by tool name appearing in the text, which is what the model
 * naturally writes ("head_bucket returned 200"). No match is the common case and
 * renders as plain evidence — inventing a link would be worse than none. */
export function linkEvidence(text: string, tools: ToolActivity[]): string | null {
  const names = new Set(tools.map((t) => t.tool));
  for (const name of names) {
    if (name && text.includes(name)) return name;
  }
  return null;
}

function Dot() {
  return <span className="select-none text-edge-strong" aria-hidden>·</span>;
}

export function TurnFooter({
  tools,
  grounding,
  durationMs,
  usage,
  model,
  budgetTokens,
  repeatCallsAvoided,
  sessionId,
  onOpenInspector,
}: {
  tools?: ToolActivity[];
  grounding?: Grounding | null;
  durationMs?: number | null;
  usage?: TokenUsage | null;
  model?: string | null;
  budgetTokens?: number | null;
  repeatCallsAvoided?: number | null;
  /** Lets a trace row be opened to the call's real persisted input/output. */
  sessionId?: string | null;
  onOpenInspector?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  // The one trace row the reader has opened, if any (v0.56.0).
  const [openCall, setOpenCall] = useState<string | null>(null);
  // Bring what you just opened into view.
  //
  // Measured on a finished turn at the bottom of a thread: the row's detail
  // renders 231px of SENT/RETURNED payload, and its bottom landed at 995px in a
  // reading area that ends at 790px. 205px of the answer to the question you
  // just asked was below the fold, with nothing to say so — you clicked a step
  // and appeared to get nothing.
  //
  // `block: "nearest"` scrolls the minimum: a row already fully visible does not
  // move at all, which matters because moving the thread under a reader who did
  // not ask for it is its own defect. Deferred a frame so the detail has laid
  // out and there is a real height to bring into view.
  const openRowRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (!openCall) return;
    const li = openRowRef.current;
    if (!li) return;
    // Watching the row rather than scrolling once on open. The detail is
    // FETCHED — `getSessionCall` resolves a tick or two later — so a single
    // scroll on the next frame moves a row that is still 20px tall and then
    // never runs again. Measured that way: the payload still ended 195px below
    // the reading area. The observer catches the row growing to its real height
    // and brings that into view.
    const ro = new ResizeObserver(() => li.scrollIntoView({ block: "nearest" }));
    ro.observe(li);
    return () => ro.disconnect();
  }, [openCall]);

  const done = useMemo(
    () => (tools ?? []).filter((a) => a.status !== "started"),
    [tools],
  );
  // Exact, from the sidecar's own verdict (v0.55.0) — not a guess at the result
  // text. The old regex matched none of this product's real failure shapes, so
  // this badge silently under-counted and the trace showed failures in green.
  const failed = done.filter(isFailed).length;
  const dur = fmtDuration(durationMs);
  const inTok = fmtTokens(usage?.input_tokens);
  const outTok = fmtTokens(usage?.output_tokens);
  const hasTokens = inTok !== null || outTok !== null;
  // The two numbers that explain what a turn actually COST (v0.53.0). The fixed
  // prefix — instructions, tool schemas, context — is re-sent on every step of a
  // multi-step turn, so a cached hit rate is the difference between a cheap turn
  // and an expensive one; reasoning tokens are output paid for and never shown.
  // Absent when the endpoint did not report them: not the same as zero.
  const cachedTok = fmtTokens(usage?.cached_input_tokens);
  const reasonTok = fmtTokens(usage?.reasoning_tokens);
  const cachedShare =
    usage?.cached_input_tokens != null && usage?.input_tokens
      ? Math.round((usage.cached_input_tokens / usage.input_tokens) * 100)
      : null;
  // What the turn's own governor did (v0.54.0). The share of the token budget
  // spent is the number that says whether an investigation had room left; the
  // repeat count is what the in-turn dedupe saved. Both are omitted rather than
  // zeroed — a turn that repeated nothing should say nothing.
  const budgetShare =
    budgetTokens && usage?.total_tokens
      ? Math.round((usage.total_tokens / budgetTokens) * 100)
      : null;
  const evidence = grounding?.evidence_used ?? [];
  const gaps = grounding?.evidence_gaps ?? [];
  const skills = grounding?.skills_used ?? [];
  const hasGrounding = evidence.length > 0 || gaps.length > 0 || skills.length > 0;
  const expandable = done.length > 0 || hasGrounding;

  // Nothing measured and nothing to show — render nothing rather than a row of
  // dashes. (Pre-v0.45.0 history, or a turn that never reached the server.)
  if (!expandable && dur === null && !hasTokens) return null;

  return (
    // gray-600 on the panel is the contrast this app uses for text it does NOT
    // expect to be read — a disabled hint, a watermark. The turn footer is the
    // opposite: it is the only place the cost and the tool count of a turn are
    // stated, and people go looking for it. One step up.
    <div className="animate-fade-in text-2xs text-gray-500">
      <div className="flex flex-wrap items-center gap-1.5">
        {expandable ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            data-testid="turn-footer-toggle"
            className="inline-flex items-center gap-1 rounded transition-colors hover:text-gray-300"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2.5"
                 className={`transition-transform duration-200 ${open ? "rotate-90" : ""}`} aria-hidden>
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span className="tabular-nums">{t("turn.checks", { n: done.length })}</span>
            {failed > 0 && (
              <span className="ml-0.5 rounded bg-danger-bg px-1.5 py-px text-3xs text-danger">
                {t("turn.failed", { n: failed })}
              </span>
            )}
          </button>
        ) : null}
        {expandable && (dur || hasTokens) && <Dot />}
        {dur && (
          <span className="tabular-nums" title={t("metrics.durationHint")}>{dur}</span>
        )}
        {dur && hasTokens && <Dot />}
        {hasTokens ? (
          <span className="tabular-nums" title={model ? t("metrics.modelHint", { model }) : undefined}>
            <span className="text-gray-600">↑</span>{inTok ?? "?"}
            {cachedTok !== null && (
              <span
                className="ml-1 text-success"
                data-testid="cached-tokens"
                title={t("metrics.cachedHint", { n: cachedTok, pct: cachedShare ?? 0 })}
              >
                ({cachedShare !== null ? `${cachedShare}%` : cachedTok}⚡)
              </span>
            )}
            <span className="ml-1.5 text-gray-700">↓</span>{outTok ?? "?"}
            {reasonTok !== null && Number(usage?.reasoning_tokens) > 0 && (
              <span
                className="ml-1 text-gray-600"
                data-testid="reasoning-tokens"
                title={t("metrics.reasoningHint", { n: reasonTok })}
              >
                (+{reasonTok}⋯)
              </span>
            )}
          </span>
        ) : (
          // Honest absence: the provider never reported usage. A zero here would
          // be a false claim about spend.
          <span className="text-gray-700" title={t("metrics.tokensUnavailableHint")}>
            {t("metrics.tokens")} —
          </span>
        )}
        {budgetShare !== null && (
          <>
            <Dot />
            <span
              className="tabular-nums text-gray-700"
              data-testid="budget-share"
              title={t("metrics.budgetHint", {
                n: fmtTokens(budgetTokens) ?? "?",
                pct: budgetShare,
              })}
            >
              {budgetShare}% {t("metrics.ofBudget")}
            </span>
          </>
        )}
        {repeatCallsAvoided ? (
          <>
            <Dot />
            <span
              className="tabular-nums text-success"
              data-testid="repeat-calls-avoided"
              title={t("metrics.repeatsHint", { n: repeatCallsAvoided })}
            >
              ⟲{repeatCallsAvoided}
            </span>
          </>
        ) : null}
        {onOpenInspector && (
          <>
            <Dot />
            <button
              type="button"
              onClick={onOpenInspector}
              className="rounded transition-colors hover:text-accent-soft"
            >
              {t("metrics.inspect")}
            </button>
          </>
        )}
      </div>

      {open && (
        <div className="mt-2 space-y-3 border-l border-edge pl-3">
          {done.length > 0 && (
            <div>
              <div className="mb-1.5 text-2xs font-medium uppercase tracking-wider text-gray-500">
                {t("turn.trace")}
              </div>
              <ul className="space-y-[3px]">
                {/* Execution order — the sequence is what explains what led to
                    what, so it is never re-sorted by name or duration. */}
                {done.map((a, i) => {
                  const bad = isFailed(a);
                  const ms = fmtCallMs(a.duration_ms);
                  const canOpen = Boolean(sessionId && a.id);
                  const isOpen = canOpen && openCall === a.id;
                  return (
                    <li key={a.id ?? i} data-tool={a.tool} ref={isOpen ? openRowRef : undefined}>
                    <div
                      className={`flex items-center gap-2 rounded px-1 transition-colors ${
                        highlight === a.tool ? "bg-accent/12" : ""
                      } ${canOpen ? "cursor-pointer hover:bg-hover" : ""}`}
                      {...(canOpen
                        ? {
                            role: "button" as const,
                            tabIndex: 0,
                            "aria-expanded": isOpen,
                            "data-testid": "footer-row-open",
                            onClick: () => setOpenCall(isOpen ? null : (a.id as string)),
                            onKeyDown: (e: React.KeyboardEvent) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setOpenCall(isOpen ? null : (a.id as string));
                              }
                            },
                          }
                        : {})}
                    >
                      <span className="w-4 shrink-0 text-right tabular-nums text-2xs text-gray-500">
                        {i + 1}
                      </span>
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${bad ? "bg-danger" : "bg-success/70"}`} aria-hidden />
                      <span className="shrink-0 font-mono text-accent-soft">{a.tool}</span>
                      {a.target && (
                        <span className="min-w-0 flex-1 truncate text-gray-600" title={a.target}>
                          · {a.target}
                        </span>
                      )}
                      {ms && (
                        <span className="ml-auto shrink-0 tabular-nums text-2xs text-gray-500"
                              data-testid="footer-duration">
                          {ms}
                        </span>
                      )}
                      <span
                        className={`${ms ? "" : "ml-auto "}shrink-0 truncate font-mono text-2xs ${bad ? "text-danger" : "text-gray-500"}`}
                        title={a.result}
                      >
                        {a.result}
                      </span>
                    </div>
                    {isOpen && (
                      <CallDetail sessionId={sessionId as string} callId={a.id as string} />
                    )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {evidence.length > 0 && (
            <div>
              <div className="mb-1.5 text-2xs font-medium uppercase tracking-wider text-gray-500">
                {t("grounding.evidence")}
              </div>
              <ul className="space-y-0.5">
                {evidence.map((e, i) => {
                  const tool = linkEvidence(e, done);
                  return (
                    <li key={i} className="text-2xs text-gray-500">
                      · {e}
                      {tool && (
                        // The link is the point of "grounded in": hovering shows
                        // WHICH call this claim rests on, in the trace above.
                        <button
                          type="button"
                          onMouseEnter={() => setHighlight(tool)}
                          onMouseLeave={() => setHighlight(null)}
                          onFocus={() => setHighlight(tool)}
                          onBlur={() => setHighlight(null)}
                          data-testid="evidence-link"
                          className="ml-1.5 rounded border border-edge px-1 font-mono text-3xs text-gray-600 transition-colors hover:border-accent/50 hover:text-accent-soft"
                        >
                          {tool}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {gaps.length > 0 && (
            <div>
              <div className="mb-1 text-3xs font-medium uppercase tracking-wider text-warn-fg">
                {t("grounding.gaps")}
              </div>
              <ul className="space-y-0.5">
                {gaps.map((g, i) => (
                  <li key={i} className="text-2xs text-gray-500">· {g}</li>
                ))}
              </ul>
            </div>
          )}

          {skills.length > 0 && (
            <div className="text-2xs text-gray-600">
              <span className="text-gray-700">{t("grounding.skills")}: </span>
              {skills.join(", ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
