import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import {
  ACTIVITY_DENSITIES,
  defaultTraceOpen,
  setActivityDensity,
  useActivityDensity,
  type ActivityDensity,
} from "../lib/activityDensity";
import { fmtDuration, fmtTokens } from "./TurnMetrics";
import { fmtCallMs, isFailed } from "./LiveTrace";
import { CallDetail } from "./CallDetail";
import type { Grounding, ToolActivity, TokenUsage } from "../types";

/** Does this evidence line refer to a tool the turn actually ran? */
export function linkEvidence(text: string, tools: ToolActivity[]): string | null {
  const names = new Set(tools.map((t) => t.tool));
  for (const name of names) {
    if (name && text.includes(name)) return name;
  }
  return null;
}

function Dot() {
  return <span className="select-none text-gray-500" aria-hidden>·</span>;
}

/**
 * Cursor-style process density, adapted to a diagnostic workbench rather than
 * copied as decoration. The selector appears only on the newest expandable
 * turn: it is a reading preference for the whole thread, not metadata that
 * should repeat under every answer.
 */
function ActivityDensityControl({ density }: { density: ActivityDensity }) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement | null>(null);
  const current = ACTIVITY_DENSITIES.find((item) => item.value === density) ?? ACTIVITY_DENSITIES[1];

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!host.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div ref={host} className="relative" data-testid="activity-density-control">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Tool activity density"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-2xs text-gray-500 transition-colors hover:bg-hover hover:text-gray-300"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="7" y1="12" x2="20" y2="12" />
          <line x1="10" y1="17" x2="20" y2="17" />
        </svg>
        <span>{current.label}</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Tool activity density"
          className="absolute bottom-7 right-0 z-floating w-64 overflow-hidden rounded-xl border border-edge bg-panel p-1.5 shadow-pop animate-fade-in"
        >
          <div className="px-2 pb-1.5 pt-1 text-2xs font-medium uppercase tracking-[0.08em] text-gray-500">
            Agent activity
          </div>
          {ACTIVITY_DENSITIES.map((item) => {
            const selected = item.value === density;
            return (
              <button
                key={item.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                data-density={item.value}
                onClick={() => {
                  setActivityDensity(item.value);
                  setOpen(false);
                }}
                className={`flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors ${
                  selected ? "bg-elevated" : "hover:bg-hover"
                }`}
              >
                <span
                  className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                    selected ? "bg-accent" : "bg-gray-500"
                  }`}
                  aria-hidden
                />
                <span className="min-w-0">
                  <span className={`block text-xs font-medium ${selected ? "text-gray-100" : "text-gray-300"}`}>
                    {item.label}
                  </span>
                  <span className="mt-0.5 block text-2xs leading-relaxed text-gray-500">
                    {item.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
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
  latest,
  onOpenInspector,
}: {
  tools?: ToolActivity[];
  grounding?: Grounding | null;
  durationMs?: number | null;
  usage?: TokenUsage | null;
  model?: string | null;
  budgetTokens?: number | null;
  repeatCallsAvoided?: number | null;
  sessionId?: string | null;
  latest?: boolean;
  onOpenInspector?: () => void;
}) {
  const { t } = useI18n();
  const density = useActivityDensity();

  // Density owns the default disclosure, while an explicit click owns this
  // turn. Changing the global density intentionally clears that local override
  // so the whole thread immediately adopts the newly requested reading mode.
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => setOverride(null), [density]);
  const open = override ?? defaultTraceOpen(density, Boolean(latest));

  const [highlight, setHighlight] = useState<string | null>(null);
  const [openCall, setOpenCall] = useState<string | null>(null);
  const openRowRef = useRef<HTMLLIElement | null>(null);

  // CallDetail is fetched after the row opens. Watch the row grow rather than
  // scrolling once while it is still one line tall.
  useEffect(() => {
    if (!openCall) return;
    const li = openRowRef.current;
    if (!li) return;
    const ro = new ResizeObserver(() => li.scrollIntoView({ block: "nearest" }));
    ro.observe(li);
    return () => ro.disconnect();
  }, [openCall]);

  const done = useMemo(
    () => (tools ?? []).filter((activity) => activity.status !== "started"),
    [tools],
  );
  const failed = done.filter(isFailed).length;
  const dur = fmtDuration(durationMs);
  const inTok = fmtTokens(usage?.input_tokens);
  const outTok = fmtTokens(usage?.output_tokens);
  const hasTokens = inTok !== null || outTok !== null;
  const cachedTok = fmtTokens(usage?.cached_input_tokens);
  const reasonTok = fmtTokens(usage?.reasoning_tokens);
  const cachedShare =
    usage?.cached_input_tokens != null && usage?.input_tokens
      ? Math.round((usage.cached_input_tokens / usage.input_tokens) * 100)
      : null;
  const budgetShare =
    budgetTokens && usage?.total_tokens
      ? Math.round((usage.total_tokens / budgetTokens) * 100)
      : null;
  const evidence = grounding?.evidence_used ?? [];
  const gaps = grounding?.evidence_gaps ?? [];
  const skills = grounding?.skills_used ?? [];
  const hasGrounding = evidence.length > 0 || gaps.length > 0 || skills.length > 0;
  const expandable = done.length > 0 || hasGrounding;

  if (!expandable && dur === null && !hasTokens) return null;

  return (
    <div
      className="animate-fade-in text-2xs text-gray-500"
      data-activity-density={density}
      data-testid="turn-activity"
    >
      {/* One quiet status rail for the turn. Process density sits here because
          it changes how the evidence below is disclosed, not how the answer is
          written. Metrics remain visible in every mode: density must never hide
          cost or make an incomplete token count look exact. */}
      <div className="flex min-h-6 flex-wrap items-center gap-x-1.5 gap-y-1">
        {expandable ? (
          <button
            type="button"
            onClick={() => setOverride(!open)}
            aria-expanded={open}
            data-testid="turn-footer-toggle"
            className="inline-flex h-6 items-center gap-1 rounded-md px-1 transition-colors hover:bg-hover hover:text-gray-300"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`}
              aria-hidden
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span className="tabular-nums">{t("turn.checks", { n: done.length })}</span>
            {failed > 0 && (
              <span className="ml-0.5 rounded bg-danger-bg px-1.5 py-px text-2xs text-danger">
                {t("turn.failed", { n: failed })}
              </span>
            )}
          </button>
        ) : null}

        {expandable && (dur || hasTokens) && <Dot />}
        {dur && <span className="tabular-nums" title={t("metrics.durationHint")}>{dur}</span>}
        {dur && hasTokens && <Dot />}

        {hasTokens ? (
          <span className="tabular-nums" title={model ? t("metrics.modelHint", { model }) : undefined}>
            <span>↑</span>{inTok ?? "?"}
            {cachedTok !== null && (
              <span
                className="ml-1 text-success"
                data-testid="cached-tokens"
                title={t("metrics.cachedHint", { n: cachedTok, pct: cachedShare ?? 0 })}
              >
                ({cachedShare !== null ? `${cachedShare}%` : cachedTok}⚡)
              </span>
            )}
            <span className="ml-1.5">↓</span>{outTok ?? "?"}
            {reasonTok !== null && Number(usage?.reasoning_tokens) > 0 && (
              <span
                className="ml-1 text-gray-500"
                data-testid="reasoning-tokens"
                title={t("metrics.reasoningHint", { n: reasonTok })}
              >
                (+{reasonTok}⋯)
              </span>
            )}
          </span>
        ) : (
          <span title={t("metrics.tokensUnavailableHint")}>{t("metrics.tokens")} —</span>
        )}

        {budgetShare !== null && (
          <>
            <Dot />
            <span
              className="tabular-nums"
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
              className="rounded px-0.5 transition-colors hover:text-accent-soft"
            >
              {t("metrics.inspect")}
            </button>
          </>
        )}

        {latest && expandable && (
          <div className="ml-auto">
            <ActivityDensityControl density={density} />
          </div>
        )}
      </div>

      {open && expandable && (
        /* A process surface, not a decorative rule beside the answer. The old
           expansion was a thin left border with every line rendered in the
           faintest type. Here the trace gets a quiet surface and readable rows;
           it is visibly subordinate to the answer but no longer looks like
           debug output leaking into prose. */
        <section
          aria-label="Agent activity"
          className="mt-2 rounded-xl bg-panel/55 px-2.5 py-2.5"
          data-testid="turn-activity-panel"
        >
          {done.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center gap-2 px-1">
                <span className="text-xs font-medium text-gray-300">{t("turn.trace")}</span>
                <span className="text-2xs tabular-nums text-gray-500">{done.length}</span>
              </div>
              <ol className="space-y-0.5">
                {done.map((activity, index) => {
                  const bad = isFailed(activity);
                  const ms = fmtCallMs(activity.duration_ms);
                  const canOpen = Boolean(sessionId && activity.id);
                  const isOpen = canOpen && openCall === activity.id;
                  return (
                    <li
                      key={activity.id ?? index}
                      data-tool={activity.tool}
                      ref={isOpen ? openRowRef : undefined}
                      className="min-w-0"
                    >
                      <div
                        className={`group/row flex min-h-7 items-center gap-2 rounded-lg px-1.5 py-1 transition-colors ${
                          highlight === activity.tool ? "bg-accent/12" : ""
                        } ${canOpen ? "cursor-pointer hover:bg-hover" : ""}`}
                        {...(canOpen
                          ? {
                              role: "button" as const,
                              tabIndex: 0,
                              "aria-expanded": isOpen,
                              "data-testid": "footer-row-open",
                              onClick: () => setOpenCall(isOpen ? null : (activity.id as string)),
                              onKeyDown: (event: React.KeyboardEvent) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  setOpenCall(isOpen ? null : (activity.id as string));
                                }
                              },
                            }
                          : {})}
                      >
                        <span className="w-4 shrink-0 text-right text-2xs tabular-nums text-gray-500">
                          {index + 1}
                        </span>
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${bad ? "bg-danger" : "bg-success/70"}`}
                          aria-hidden
                        />
                        <span className="shrink-0 font-mono text-xs text-accent-soft">
                          {activity.tool}
                        </span>
                        {activity.target && (
                          <span className="min-w-0 truncate text-xs text-gray-400" title={activity.target}>
                            {activity.target}
                          </span>
                        )}
                        <span className="min-w-0 flex-1 truncate text-xs text-gray-500" title={activity.result}>
                          {activity.result}
                        </span>
                        {ms && (
                          <span
                            className="shrink-0 text-2xs tabular-nums text-gray-500"
                            data-testid="footer-duration"
                          >
                            {ms}
                          </span>
                        )}
                        {canOpen && (
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.2"
                            aria-hidden
                            className={`shrink-0 text-gray-500 transition-transform ${isOpen ? "rotate-90" : ""}`}
                          >
                            <polyline points="9 18 15 12 9 6" />
                          </svg>
                        )}
                      </div>
                      {isOpen && (
                        <div className="ml-8 mr-1 mt-1 overflow-hidden rounded-lg bg-canvas/55">
                          <CallDetail sessionId={sessionId as string} callId={activity.id as string} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          {hasGrounding && (
            <div className={`${done.length > 0 ? "mt-3 border-t border-edge/70 pt-2.5" : ""} space-y-2.5 px-1`}>
              {evidence.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-medium text-gray-300">{t("grounding.evidence")}</div>
                  <ul className="space-y-1">
                    {evidence.map((item, index) => {
                      const tool = linkEvidence(item, done);
                      return (
                        <li key={index} className="flex items-start gap-1.5 text-xs leading-relaxed text-gray-400">
                          <span className="mt-[0.65em] h-1 w-1 shrink-0 rounded-full bg-gray-500" aria-hidden />
                          <span className="min-w-0 flex-1">
                            {item}
                            {tool && (
                              <button
                                type="button"
                                onMouseEnter={() => setHighlight(tool)}
                                onMouseLeave={() => setHighlight(null)}
                                onFocus={() => setHighlight(tool)}
                                onBlur={() => setHighlight(null)}
                                data-testid="evidence-link"
                                className="ml-1.5 rounded-md bg-elevated px-1.5 py-0.5 font-mono text-2xs text-gray-400 transition-colors hover:text-accent-soft"
                              >
                                {tool}
                              </button>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {gaps.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-medium text-warn-fg">{t("grounding.gaps")}</div>
                  <ul className="space-y-1">
                    {gaps.map((gap, index) => (
                      <li key={index} className="flex items-start gap-1.5 text-xs leading-relaxed text-gray-400">
                        <span className="mt-[0.65em] h-1 w-1 shrink-0 rounded-full bg-warn" aria-hidden />
                        <span>{gap}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {skills.length > 0 && (
                <div className="text-xs text-gray-500">
                  <span className="font-medium text-gray-400">{t("grounding.skills")}: </span>
                  {skills.join(", ")}
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
