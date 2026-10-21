import { api } from "../api";
import type { LiveSegment, TaskSnapshot } from "../api/types";
import { Icon } from "../components/icons";
import { Markdown } from "../components/Markdown";
import { Button, IconButton, StatusDot } from "../components/ui";
import { useToast } from "../components/Toast";
import { useCopy } from "../hooks/useCopy";
import { useElapsed } from "../hooks/useElapsed";
import { useI18n } from "../i18n";
import { SEVERITY_TONE } from "../lib/severity";
import { toolLabel, toolRunLabel } from "../lib/toolLabels";
import { useApp } from "../shell/context";
import { figures, versions, type Section, type ToolRow as Row } from "../store/derive";
import { ResultView, viewFor } from "../tool/ResultView";
import { AnalysisFigures } from "../viz/AnalysisFigures";

/**
 * One turn: the request, then one assistant article. The article carries a
 * single receipt (or the live trace), the answer, the deterministic result,
 * the findings and at most one next step. Nothing repeats the receipt.
 */
export function Turn({ section, taskId, forks, setSnapshot, running, live = null }: {
  section: Section; taskId: string; forks: Record<string, string[]>;
  setSnapshot: (s: TaskSnapshot) => void; running: boolean; live?: LiveSegment | null;
}) {
  const { t } = useI18n();
  const s = section;
  const queued = s.turn.status === "queued";
  const rows = tools(s);
  const result = !running ? primaryResult(rows) : null;
  const found = s.conclusion?.findings ?? [];
  const fig = !running ? figures(s) : null;
  const next = !running && s.turn.status === "completed" ? (s.conclusion?.next_steps?.[0] ?? null) : null;
  return (
    <section className="turn" data-status={s.turn.status} data-testid="turn">
      {s.turn.kind === "resume"
        ? <p className="turn-note">{t("turn.continued")}</p>
        : <Message section={s} taskId={taskId} forks={forks} setSnapshot={setSnapshot} />}
      {queued ? <Queued taskId={taskId} turnId={s.turn.id} /> : (
        <article className="assistant" data-testid="assistant">
          <RunTrace section={s} running={running} live={live} />
          {s.compacted && !s.blocks.some((b) => b.kind === "context")
            ? <p className="turn-note">{t("work.compacted")}</p> : null}
          <Answer section={s} running={running} live={live} />
          {result ? <SettledResult result={result} /> : null}
          {fig ? <AnalysisFigures provenance={fig} /> : null}
          {found.length ? <Findings findings={found} /> : null}
          {next ? <NextStep text={next} /> : null}
          <Outcome section={s} taskId={taskId} running={running} />
        </article>
      )}
    </section>
  );
}

function Message({ section, taskId, forks, setSnapshot }: {
  section: Section; taskId: string; forks: Record<string, string[]>; setSnapshot: (s: TaskSnapshot) => void;
}) {
  const { t } = useI18n();
  const app = useApp();
  const toast = useToast();
  const { copied, copy } = useCopy();
  const turn = section.turn;
  const v = versions(forks, turn);
  const go = async (to: number) => {
    if (!v) return;
    try {
      setSnapshot(await api.switchBranch(taskId, v.ids[to]));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };
  const settled = turn.status !== "queued" && turn.status !== "running";
  return (
    <div className="message" data-testid="message">
      <div className="message-bubble">
        <p className="message-text">{section.direction}</p>
        {section.context?.length ? (
          <ul className="message-context" data-testid="message-context">
            {section.context.map((c, i) => (
              <li key={`${c.kind}-${i}`} className="context-pill" data-kind={c.kind}>
                <span>{c.kind === "account" ? c.account : c.kind === "issue" ? (c.title ?? c.bucket) : c.bucket}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {section.attachments?.length ? (
          <ul className="message-files">
            {section.attachments.map((a) => (
              <li key={a.dataset_id}><Icon name="paperclip" size={14} /><span>{a.filename}</span></li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="message-tools">
        {v ? (
          <span className="versions" role="group" aria-label={t("turn.version", { i: v.index + 1, n: v.ids.length })}>
            <IconButton icon="chevron" size="sm" className="flip" label={t("turn.prevVersion")} disabled={v.index === 0}
              onClick={() => void go(v.index - 1)} />
            <span>{v.index + 1} / {v.ids.length}</span>
            <IconButton icon="chevron" size="sm" label={t("turn.nextVersion")} disabled={v.index === v.ids.length - 1}
              onClick={() => void go(v.index + 1)} />
          </span>
        ) : null}
        {settled ? (
          <IconButton icon="compose" size="sm" label={t("turn.edit")} data-testid="edit-message"
            onClick={() => app.setEditing({ turnId: turn.id, parentTurnId: turn.parent_turn_id, text: section.direction })} />
        ) : null}
        <IconButton icon={copied ? "check" : "copy"} size="sm" label={copied ? t("common.copied") : t("common.copy")}
          onClick={() => copy(section.direction)} />
      </div>
    </div>
  );
}

function Queued({ taskId, turnId }: { taskId: string; turnId: string }) {
  const { t } = useI18n();
  const toast = useToast();
  return (
    <p className="turn-note" data-testid="queued">
      <StatusDot tone="neutral" /> {t("turn.queued")}
      <button type="button" className="link" onClick={() => void api.withdraw(taskId, turnId).catch((e) => toast.error(String(e)))}>
        {t("turn.withdraw")}
      </button>
    </p>
  );
}

function tools(section: Section): Row[] {
  return section.blocks.flatMap((b) => (b.kind === "work" ? b.tools : []));
}

/** The one deterministic result worth placing under the answer: a survey first,
 * then the narrower views, never merely the last call. */
const RESULT_RANK: Record<string, number> = { survey: 0, estate: 1, buckets: 2, config: 3, fix: 4 };
function primaryResult(rows: Row[]): Row | null {
  let best: Row | null = null;
  let rank = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (row.status !== "ok") continue;
    const view = viewFor(row);
    if (!view) continue;
    const next = RESULT_RANK[view.kind] ?? 99;
    if (next <= rank) { best = row; rank = next; }
  }
  return best;
}

/** The run: every real call while it is live; one quiet receipt once it has settled. */
function RunTrace({ section, running, live }: { section: Section; running: boolean; live: LiveSegment | null }) {
  const { t, lang } = useI18n();
  const rows = tools(section);
  const start = section.turn.started_at ?? section.turn.created_at;
  const elapsed = useElapsed(start, running ? null : section.turn.finished_at, running, lang);
  const commentary = section.blocks.filter((b) => b.kind === "commentary" || b.kind === "steer"
    || b.kind === "context" || b.kind === "carried");
  const failed = rows.filter((r) => r.status === "failed" || r.status === "refused").length;
  const result = running ? primaryResult(rows) : null;

  if (running) {
    const now = [...rows].reverse().find((r) => r.status === "running");
    const label = now ? `${toolRunLabel(now.name, lang)}${now.target ? ` ${now.target}` : ""}`
      : live?.text ? t("work.writing") : t("work.thinking");
    const progress = now?.progress;
    return (
      <div className="run-trace" data-live="true">
        <div className="run-head" data-testid="run-trace">
          <span className="ui-dot" data-tone="accent" data-pulse="true" aria-hidden />
          <span className="run-label">{label}</span>
          {progress && progress.total > 0 ? (
            <span className="run-progress">{t("tool.progress", { done: progress.done.toLocaleString(),
              total: progress.total.toLocaleString(), unit: progress.unit })}</span>
          ) : null}
          <span className="run-meta">· {t(rows.length === 1 ? "work.check" : "work.checks", { n: rows.length })}</span>
          <span className="run-meta">· {elapsed}</span>
        </div>
        <RunBody section={section} result={result} />
      </div>
    );
  }

  if (!rows.length && !commentary.length) return null;
  return (
    <div className="run-receipt" data-testid="run-trace" data-live="false">
      <span className="run-glyph" aria-hidden><Icon name="activity" size={14} /></span>
      <span>{rows.length ? t(rows.length === 1 ? "work.check" : "work.checks", { n: rows.length }) : t("work.notes")}</span>
      {failed ? <span className="run-meta run-failed">· {t("work.failed", { n: failed })}</span> : null}
      <span className="run-meta">· {elapsed}</span>
    </div>
  );
}

/** The latest deterministic result with a known shape, rendered as part of the answer. */
function SettledResult({ result }: { result: Row }) {
  return <div className="run-result" data-testid="run-result"><ResultView row={result} /></div>;
}

function RunBody({ section, result }: { section: Section; result: Row | null }) {
  const { t } = useI18n();
  return (
    <div className="run-body" data-testid="run-body">
      {section.blocks.map((b) => {
        if (b.kind === "commentary") return <div key={b.id} className="run-note"><Markdown text={b.text} /></div>;
        if (b.kind === "steer") return <p key={b.id} className="run-steer"><span>{t("work.steered")}</span> {b.text}</p>;
        if (b.kind === "carried") return <p key={b.id} className="run-carried">{t("work.carried", { n: b.count })}</p>;
        if (b.kind === "context") {
          return (
            <details key={b.id} className="run-context">
              <summary>{t("work.compacted")}{b.turns ? ` · ${t("work.turns", { n: b.turns })}` : ""}</summary>
              {b.summary ? <p>{b.summary}</p> : null}
            </details>
          );
        }
        return (
          <ul key={b.id} className="call-list">
            {b.tools.map((r) => <CallRow key={r.callId} row={r} />)}
          </ul>
        );
      })}
      {result ? <div className="run-result" data-testid="run-result"><ResultView row={result} /></div> : null}
    </div>
  );
}

const GLYPH: Record<Row["status"], "check" | "x" | "alert" | "tool"> = { ok: "check", failed: "x", refused: "alert", running: "tool" };

function CallRow({ row }: { row: Row }) {
  const { t, lang } = useI18n();
  const app = useApp();
  return (
    <li className="call-row" data-status={row.status}>
      <button type="button" data-tool={row.name} title={row.name}
        onClick={() => app.setPane({ tab: "details" })}>
        <span className="call-glyph">
          {row.status === "running" ? <span className="ui-dot" data-tone="accent" data-pulse="true" aria-hidden /> : <Icon name={GLYPH[row.status]} size={14} />}
        </span>
        <span className="call-verb">{row.status === "running" ? toolRunLabel(row.name, lang) : toolLabel(row.name, lang)}</span>
        {row.target ? <span className="call-target">{row.target}</span> : null}
        {row.summary ? <span className="call-note">{row.status === "refused" ? `${t("tool.refused")} — ` : ""}{row.summary}</span> : null}
      </button>
    </li>
  );
}

/** The answer text: streamed while live, the model's final message once done. */
function Answer({ section, running, live }: { section: Section; running: boolean; live: LiveSegment | null }) {
  const c = section.conclusion;
  if (running) {
    return live ? (
      <div className="answer live-text" data-testid="live-answer" aria-live="polite">
        <Markdown text={live.text} /><span className="caret" aria-hidden />
      </div>
    ) : null;
  }
  // A conclusion recorded before v9 carries its own answer; newer ones do not.
  const text = section.answer ?? c?.answer ?? null;
  if (!text) return null;
  return <div className="answer" data-testid="answer"><Markdown text={text} /></div>;
}

function Findings({ findings }: {
  findings: NonNullable<NonNullable<Section["conclusion"]>["findings"]>;
}) {
  const { t } = useI18n();
  return (
    <ul className="findings" aria-label={t("turn.findings")} data-testid="findings">
      {findings.map((f, i) => (
        <li key={i} className="finding" data-severity={f.severity}>
          <StatusDot tone={SEVERITY_TONE[f.severity] === "outline" ? "neutral" : SEVERITY_TONE[f.severity]} />
          <span className="sr-only">{t(`sev.${f.severity}`)}: </span>
          <span className="finding-title">{f.title}</span>
          {f.detail ? <span className="finding-detail">{f.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** One recorded next step, never a row of cards. */
function NextStep({ text }: { text: string }) {
  const { t } = useI18n();
  const app = useApp();
  return (
    <button type="button" className="next-step" data-testid="next-step" onClick={() => app.prefill(text)}>
      <span className="next-step-label">{t("turn.next")}</span>
      <span className="next-step-text">{text}</span>
      <Icon name="arrowRight" size={14} className="next-step-arrow" />
    </button>
  );
}

/** Stopped, finalized, failed or interrupted — said once, with what to do. */
function Outcome({ section, taskId, running }: { section: Section; taskId: string; running: boolean }) {
  const { t } = useI18n();
  const app = useApp();
  const toast = useToast();
  if (running) return null;
  const st = section.turn.status;
  if (st === "failed" || st === "interrupted") {
    return (
      <div className="turn-outcome" data-tone={st} data-testid="attention">
        <StatusDot tone={st === "failed" ? "danger" : "warn"} />
        <span className="turn-outcome-text">{section.error?.message ?? section.turn.error
          ?? (st === "interrupted" ? t("turn.interrupted") : t("turn.failed"))}</span>
        <Button size="sm" onClick={() => void api.resume(taskId, section.turn.id).catch((e) => toast.error(String(e)))}>{t("turn.resume")}</Button>
        {st === "failed" ? <Button size="sm" variant="ghost" onClick={() => app.openSettings("models")}>{t("turn.openSettings")}</Button> : null}
      </div>
    );
  }
  if (section.stopped) return <p className="turn-note">{t("turn.stopped")}</p>;
  if (section.finalized) return <p className="turn-note">{t("turn.finalized")}</p>;
  return null;
}
