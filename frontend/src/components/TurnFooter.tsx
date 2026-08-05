import { useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { fmtDuration, fmtTokens } from "./TurnMetrics";
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
  onOpenInspector,
}: {
  tools?: ToolActivity[];
  grounding?: Grounding | null;
  durationMs?: number | null;
  usage?: TokenUsage | null;
  model?: string | null;
  onOpenInspector?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);

  const done = useMemo(
    () => (tools ?? []).filter((a) => a.status !== "started"),
    [tools],
  );
  const failed = done.filter((a) => /^(error|failed)\b/i.test(a.result || "")).length;
  const dur = fmtDuration(durationMs);
  const inTok = fmtTokens(usage?.input_tokens);
  const outTok = fmtTokens(usage?.output_tokens);
  const hasTokens = inTok !== null || outTok !== null;
  const evidence = grounding?.evidence_used ?? [];
  const gaps = grounding?.evidence_gaps ?? [];
  const skills = grounding?.skills_used ?? [];
  const hasGrounding = evidence.length > 0 || gaps.length > 0 || skills.length > 0;
  const expandable = done.length > 0 || hasGrounding;

  // Nothing measured and nothing to show — render nothing rather than a row of
  // dashes. (Pre-v0.45.0 history, or a turn that never reached the server.)
  if (!expandable && dur === null && !hasTokens) return null;

  return (
    <div className="animate-fade-in text-[11px] text-gray-600">
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
              <span className="ml-0.5 rounded bg-danger-bg px-1.5 py-px text-[10px] text-danger">
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
            <span className="text-gray-700">↑</span>{inTok ?? "?"}
            <span className="ml-1.5 text-gray-700">↓</span>{outTok ?? "?"}
          </span>
        ) : (
          // Honest absence: the provider never reported usage. A zero here would
          // be a false claim about spend.
          <span className="text-gray-700" title={t("metrics.tokensUnavailableHint")}>
            {t("metrics.tokens")} —
          </span>
        )}
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
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-gray-700">
                {t("turn.trace")}
              </div>
              <ul className="space-y-[3px]">
                {/* Execution order — the sequence is what explains what led to
                    what, so it is never re-sorted by name or duration. */}
                {done.map((a, i) => {
                  const bad = /^(error|failed)\b/i.test(a.result || "");
                  return (
                    <li
                      key={i}
                      data-tool={a.tool}
                      className={`flex items-center gap-2 rounded px-1 transition-colors ${
                        highlight === a.tool ? "bg-accent/12" : ""
                      }`}
                    >
                      <span className="w-4 shrink-0 text-right tabular-nums text-[10px] text-gray-700">
                        {i + 1}
                      </span>
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${bad ? "bg-danger" : "bg-success/70"}`} aria-hidden />
                      <span className="shrink-0 font-mono text-accent-soft">{a.tool}</span>
                      {a.target && (
                        <span className="min-w-0 flex-1 truncate text-gray-600" title={a.target}>
                          · {a.target}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 truncate font-mono text-[10.5px] text-gray-500" title={a.result}>
                        {a.result}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {evidence.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-gray-700">
                {t("grounding.evidence")}
              </div>
              <ul className="space-y-0.5">
                {evidence.map((e, i) => {
                  const tool = linkEvidence(e, done);
                  return (
                    <li key={i} className="text-[11.5px] text-gray-500">
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
                          className="ml-1.5 rounded border border-edge px-1 font-mono text-[9.5px] text-gray-600 transition-colors hover:border-accent/50 hover:text-accent-soft"
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
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-warn-fg">
                {t("grounding.gaps")}
              </div>
              <ul className="space-y-0.5">
                {gaps.map((g, i) => (
                  <li key={i} className="text-[11.5px] text-gray-500">· {g}</li>
                ))}
              </ul>
            </div>
          )}

          {skills.length > 0 && (
            <div className="text-[11px] text-gray-600">
              <span className="text-gray-700">{t("grounding.skills")}: </span>
              {skills.join(", ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
