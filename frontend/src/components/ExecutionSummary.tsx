import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import {
  ACTIVITY_DENSITIES,
  defaultTraceOpen,
  setActivityDensity,
  useActivityDensity,
  type ActivityDensity,
} from "../lib/activityDensity";
import { fmtDuration, fmtTokens } from "./ExecutionMetrics";
import { fmtCallMs, isFailed } from "./LiveTrace";
import { CallDetail } from "./CallDetail";
import type { Grounding, ToolActivity, TokenUsage } from "../types";

export function linkEvidence(text: string, tools: ToolActivity[]): string | null {
  const names = new Set(tools.map((tool) => tool.tool));
  for (const name of names) {
    if (name && text.includes(name)) return name;
  }
  return null;
}

function Dot() {
  return <span className="select-none text-gray-500" aria-hidden>·</span>;
}

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
        title="Execution detail density"
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
      {open ? (
        <div
          role="menu"
          aria-label="Execution detail density"
          className="absolute bottom-7 right-0 z-floating w-64 overflow-hidden rounded-xl border border-edge bg-panel p-1.5 shadow-pop animate-fade-in"
        >
          <div className="px-2 pb-1.5 pt-1 text-2xs font-medium uppercase tracking-[0.08em] text-gray-500">
            Execution detail
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
                className={`flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors ${selected ? "bg-elevated" : "hover:bg-hover"}`}
              >
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${selected ? "bg-accent" : "bg-gray-500"}`} aria-hidden />
                <span className="min-w-0">
                  <span className={`block text-xs font-medium ${selected ? "text-gray-100" : "text-gray-300"}`}>{item.label}</span>
                  <span className="mt-0.5 block text-2xs leading-relaxed text-gray-500">{item.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function ExecutionSummary({
  tools,
  grounding,
  durationMs,
  usage,
  model,
  budgetTokens,
  repeatCallsAvoided,
  sessionId,
  latest,
  onReviewEvidence,
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
  onReviewEvidence?: () => void;
}) {
  const { t, lang } = useI18n();
  const density = useActivityDensity();
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => setOverride(null), [density]);
  const open = override ?? defaultTraceOpen(density, Boolean(latest));

  const [highlight, setHighlight] = useState<string | null>(null);
  const [openCall, setOpenCall] = useState<string | null>(null);
  const openRowRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (!openCall) return;
    const row = openRowRef.current;
    if (!row) return;
    const observer = new ResizeObserver(() => row.scrollIntoView({ block: "nearest" }));
    observer.observe(row);
    return () => observer.disconnect();
  }, [openCall]);

  const done = useMemo(() => (tools ?? []).filter((activity) => activity.status !== "started"), [tools]);
  const failed = done.filter(isFailed).length;
  const latestStep = done.at(-1) ?? null;
  const dur = fmtDuration(durationMs);
  const inTok = fmtTokens(usage?.input_tokens);
  const outTok = fmtTokens(usage?.output_tokens);
  const cachedTok = fmtTokens(usage?.cached_input_tokens);
  const reasoningTok = fmtTokens(usage?.reasoning_tokens);
  const hasTokens = inTok !== null || outTok !== null;
  const cachedShare = usage?.cached_input_tokens != null && usage?.input_tokens
    ? Math.round((usage.cached_input_tokens / usage.input_tokens) * 100)
    : null;
  const budgetShare = budgetTokens && usage?.total_tokens
    ? Math.round((usage.total_tokens / budgetTokens) * 100)
    : null;

  const evidence = grounding?.evidence_used ?? [];
  const gaps = grounding?.evidence_gaps ?? [];
  const skills = grounding?.skills_used ?? [];
  const hasGrounding = evidence.length > 0 || gaps.length > 0 || skills.length > 0;
  const expandable = done.length > 0 || hasGrounding;

  if (!expandable && dur === null && !hasTokens) return null;

  const copy = lang === "zh"
    ? {
        label: "Execution",
        steps: `${done.length} 步`,
        failed: `${failed} 失败`,
        review: "Review Evidence",
        detail: "执行详情",
        latest: "最后动作",
      }
    : {
        label: "Execution",
        steps: `${done.length} step${done.length === 1 ? "" : "s"}`,
        failed: `${failed} failed`,
        review: "Review evidence",
        detail: "Execution details",
        latest: "Latest action",
      };

  return (
    <section
      className="execution-summary animate-fade-in rounded-xl border border-edge/70 bg-panel/35 px-3 py-2.5 text-2xs text-gray-500"
      data-activity-density={density}
      data-testid="execution-summary"
      aria-label={copy.label}
    >
      <div className="flex min-h-6 flex-wrap items-center gap-x-1.5 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-medium text-gray-300">
          <span className={`h-1.5 w-1.5 rounded-full ${failed ? "bg-danger" : "bg-success"}`} aria-hidden />
          {copy.label}
        </span>
        {expandable ? (
          <button
            type="button"
            onClick={() => setOverride(!open)}
            aria-expanded={open}
            data-testid="execution-summary-toggle"
            className="inline-flex h-6 items-center gap-1 rounded-md px-1 transition-colors hover:bg-hover hover:text-gray-300"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`} aria-hidden>
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span className="tabular-nums">{copy.steps}</span>
            {failed > 0 ? <span className="ml-0.5 rounded bg-danger-bg px-1.5 py-px text-danger">{copy.failed}</span> : null}
          </button>
        ) : null}
        {dur ? <><Dot /><span className="tabular-nums" title={t("metrics.durationHint")}>{dur}</span></> : null}
        {hasTokens ? (
          <>
            <Dot />
            <span className="tabular-nums" title={model ? t("metrics.modelHint", { model }) : undefined}>
              <span>in </span>{inTok ?? "?"}
              {cachedTok !== null ? (
                <span className="ml-1 text-success" data-testid="cached-tokens" title={t("metrics.cachedHint", { n: cachedTok, pct: cachedShare ?? 0 })}>
                  ({cachedShare !== null ? `${cachedShare}% cached` : `${cachedTok} cached`})
                </span>
              ) : null}
              <span className="ml-1.5">out </span>{outTok ?? "?"}
              {reasoningTok !== null && Number(usage?.reasoning_tokens) > 0 ? (
                <span className="ml-1 text-gray-500" data-testid="reasoning-tokens" title={t("metrics.reasoningHint", { n: reasoningTok })}>
                  (+{reasoningTok} reasoning)
                </span>
              ) : null}
            </span>
          </>
        ) : <><Dot /><span title={t("metrics.tokensUnavailableHint")}>{t("metrics.tokens")} —</span></>}
        {budgetShare !== null ? <><Dot /><span className="tabular-nums" data-testid="budget-share" title={t("metrics.budgetHint", { n: fmtTokens(budgetTokens) ?? "?", pct: budgetShare })}>{budgetShare}% {t("metrics.ofBudget")}</span></> : null}
        {repeatCallsAvoided ? <><Dot /><span className="tabular-nums text-success" data-testid="repeat-calls-avoided" title={t("metrics.repeatsHint", { n: repeatCallsAvoided })}>{repeatCallsAvoided} reused</span></> : null}
        {onReviewEvidence ? <><Dot /><button type="button" onClick={onReviewEvidence} className="rounded px-0.5 transition-colors hover:text-accent-soft">{copy.review}</button></> : null}
        {latest && expandable ? <div className="ml-auto"><ActivityDensityControl density={density} /></div> : null}
      </div>

      {!open && latestStep ? (
        <div className="mt-1.5 flex min-w-0 items-center gap-2 rounded-lg bg-canvas/30 px-2 py-1.5" data-testid="execution-latest-step">
          <span className="shrink-0 text-gray-500">{copy.latest}</span>
          <span className="shrink-0 font-mono text-xs text-accent-soft">{latestStep.tool}</span>
          {latestStep.target ? <span className="min-w-0 truncate text-xs text-gray-400" title={latestStep.target}>{latestStep.target}</span> : null}
          <span className="min-w-0 flex-1 truncate text-xs text-gray-500" title={latestStep.result}>{latestStep.result}</span>
        </div>
      ) : null}

      {open && expandable ? (
        <section aria-label={copy.detail} className="mt-2 rounded-xl bg-panel/55 px-2.5 py-2.5" data-testid="execution-summary-panel">
          {done.length > 0 ? (
            <div>
              <div className="mb-1.5 flex items-center gap-2 px-1">
                <span className="text-xs font-medium text-gray-300">{copy.detail}</span>
                <span className="text-2xs tabular-nums text-gray-500">{done.length}</span>
              </div>
              <ol className="space-y-0.5">
                {done.map((activity, index) => {
                  const bad = isFailed(activity);
                  const ms = fmtCallMs(activity.duration_ms);
                  const canOpen = Boolean(sessionId && activity.id);
                  const isOpen = canOpen && openCall === activity.id;
                  return (
                    <li key={activity.id ?? index} data-tool={activity.tool} ref={isOpen ? openRowRef : undefined} className="min-w-0">
                      <div
                        className={`group/row flex min-h-7 items-center gap-2 rounded-lg px-1.5 py-1 transition-colors ${highlight === activity.tool ? "bg-accent/12" : ""} ${canOpen ? "cursor-pointer hover:bg-hover" : ""}`}
                        {...(canOpen ? {
                          role: "button" as const,
                          tabIndex: 0,
                          "aria-expanded": isOpen,
                          "data-testid": "execution-step-open",
                          onClick: () => setOpenCall(isOpen ? null : (activity.id as string)),
                          onKeyDown: (event: React.KeyboardEvent) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setOpenCall(isOpen ? null : (activity.id as string));
                            }
                          },
                        } : {})}
                      >
                        <span className="w-4 shrink-0 text-right text-2xs tabular-nums text-gray-500">{index + 1}</span>
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${bad ? "bg-danger" : "bg-success/70"}`} aria-hidden />
                        <span className="shrink-0 font-mono text-xs text-accent-soft">{activity.tool}</span>
                        {activity.target ? <span className="min-w-0 truncate text-xs text-gray-400" title={activity.target}>{activity.target}</span> : null}
                        <span className="min-w-0 flex-1 truncate text-xs text-gray-500" title={activity.result}>{activity.result}</span>
                        {ms ? <span className="shrink-0 text-2xs tabular-nums text-gray-500" data-testid="execution-step-duration">{ms}</span> : null}
                        {canOpen ? (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden className={`shrink-0 text-gray-500 transition-transform ${isOpen ? "rotate-90" : ""}`}>
                            <polyline points="9 18 15 12 9 6" />
                          </svg>
                        ) : null}
                      </div>
                      {isOpen ? <div className="ml-8 mr-1 mt-1 overflow-hidden rounded-lg bg-canvas/55"><CallDetail sessionId={sessionId as string} callId={activity.id as string} /></div> : null}
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : null}

          {hasGrounding ? (
            <div className={`${done.length > 0 ? "mt-3 border-t border-edge/70 pt-2.5" : ""} space-y-2.5 px-1`}>
              {evidence.length > 0 ? (
                <div>
                  <div className="mb-1 text-xs font-medium text-gray-300">{t("grounding.evidence")}</div>
                  <ul className="space-y-1">
                    {evidence.map((item, index) => {
                      const tool = linkEvidence(item, done);
                      return <li key={index} className="flex items-start gap-1.5 text-xs leading-relaxed text-gray-400"><span className="mt-[0.65em] h-1 w-1 shrink-0 rounded-full bg-gray-500" aria-hidden /><span className="min-w-0 flex-1">{item}{tool ? <button type="button" onMouseEnter={() => setHighlight(tool)} onMouseLeave={() => setHighlight(null)} onFocus={() => setHighlight(tool)} onBlur={() => setHighlight(null)} data-testid="evidence-link" className="ml-1.5 rounded-md bg-elevated px-1.5 py-0.5 font-mono text-2xs text-gray-400 transition-colors hover:text-accent-soft">{tool}</button> : null}</span></li>;
                    })}
                  </ul>
                </div>
              ) : null}
              {gaps.length > 0 ? <div><div className="mb-1 text-xs font-medium text-warn-fg">{t("grounding.gaps")}</div><ul className="space-y-1">{gaps.map((gap, index) => <li key={index} className="flex items-start gap-1.5 text-xs leading-relaxed text-gray-400"><span className="mt-[0.65em] h-1 w-1 shrink-0 rounded-full bg-warn" aria-hidden /><span>{gap}</span></li>)}</ul></div> : null}
              {skills.length > 0 ? <div className="text-xs text-gray-500"><span className="font-medium text-gray-400">{t("grounding.skills")}: </span>{skills.join(", ")}</div> : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
