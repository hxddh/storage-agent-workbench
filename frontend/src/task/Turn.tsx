import { useState } from "react";
import { api } from "../api";
import type { LiveSegment, TaskSnapshot } from "../api/types";
import { Icon } from "../components/icons";
import { Markdown } from "../components/Markdown";
import { Button, IconButton, StatusDot } from "../components/ui";
import { useToast } from "../components/Toast";
import { useCopy } from "../hooks/useCopy";
import { useElapsed } from "../hooks/useElapsed";
import { describeError } from "../lib/errors";
import { useI18n } from "../i18n";
import { SEVERITY_TONE } from "../lib/severity";
import { toolLabel, toolRunLabel } from "../lib/toolLabels";
import { useApp } from "../shell/context";
import { figures, versions, type Section, type ToolRow as Row } from "../store/derive";
import { ResultView, viewFor } from "../tool/ResultView";
import { AnalysisFigures } from "../viz/AnalysisFigures";

/**
 * One Turn is one exchange: what was asked, the work it caused, the Agent's
 * answer and the findings. The answer leads; deterministic data is a fold
 * beneath it, never a wall the reader has to cross to reach the prose.
 */
export function Turn({ section, taskId, forks, setSnapshot, running, live = null, first = false }: {
  section: Section; taskId: string; forks: Record<string, string[]>;
  setSnapshot: (s: TaskSnapshot) => void; running: boolean; live?: LiveSegment | null; first?: boolean;
}) {
  const { t } = useI18n();
  const s = section;
  const queued = s.turn.status === "queued";
  const rows = tools(s);
  const result = !running ? primaryResult(rows) : null;
  const found = s.conclusion?.findings ?? [];
  const fig = !running ? figures(s) : null;
  return (
    <section className="turn" data-status={s.turn.status} data-testid="turn">
      {s.turn.kind === "resume"
        ? <p className="turn-note">{t("turn.continued")}</p>
        : <Objective section={s} taskId={taskId} forks={forks} setSnapshot={setSnapshot} first={first} />}
      {queued ? <Queued taskId={taskId} turnId={s.turn.id} /> : (
        <div className="turn-body" data-testid="turn-body">
          {running ? (
            <>
              <RunTrace section={s} running live={live} />
              <Answer section={s} running live={live} />
            </>
          ) : (
            <>
              <RunTrace section={s} running={false} live={null} />
              <Answer section={s} running={false} live={null} />
              {found.length ? <Findings findings={found} /> : null}
              {fig ? <AnalysisFigures provenance={fig} /> : null}
              {result ? <TurnData result={result} open={!s.answer} /> : null}
              {!result && rows.some((r) => r.status === "ok" && r.detailTruncated)
                ? <p className="quiet-note result-gap">{t("result.truncatedGap")}</p> : null}
            </>
          )}
          <Outcome section={s} taskId={taskId} running={running} />
        </div>
      )}
    </section>
  );
}

/** The objective, with the version/edit/copy controls that belong to it. */
function Objective({ section, taskId, forks, setSnapshot, first }: {
  section: Section; taskId: string; forks: Record<string, string[]>; setSnapshot: (s: TaskSnapshot) => void; first: boolean;
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
      toast.error(describeError(err, t));
    }
  };
  const settled = turn.status !== "queued" && turn.status !== "running";
  const Heading = first ? "h1" : "h2";
  return (
    <div className="objective" data-testid="message">
      <div className="objective-head">
        <div className="objective-main">
          {!first ? <span className="objective-kicker">{t("turn.you")}</span> : null}
          <Heading className="objective-text">{section.direction}</Heading>
        </div>
        <div className="objective-tools">
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
              onClick={() => app.setEditing({ turnId: turn.id, parentTurnId: turn.parent_turn_id, text: section.direction,
                attachments: section.attachments })} />
          ) : null}
          <IconButton icon={copied ? "check" : "copy"} size="sm" label={copied ? t("common.copied") : t("common.copy")}
            onClick={() => copy(section.direction)} />
        </div>
      </div>
      {section.attachments?.length ? (
        <ul className="objective-files">
          {section.attachments.map((a) => (
            <li key={a.dataset_id}><Icon name="paperclip" size={14} /><span>{a.filename}</span></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Queued({ taskId, turnId }: { taskId: string; turnId: string }) {
  const { t } = useI18n();
  const toast = useToast();
  return (
    <p className="turn-note" data-testid="queued">
      <StatusDot tone="neutral" /> {t("turn.queued")}
      <button type="button" className="link" onClick={() => void api.withdraw(taskId, turnId).catch((e) => toast.error(describeError(e, t)))}>
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
  const app = useApp();
  const rows = tools(section);
  const start = section.turn.started_at ?? section.turn.created_at;
  const elapsed = useElapsed(start, running ? null : section.turn.finished_at, running, lang);
  const commentary = section.blocks.filter((b) => b.kind === "commentary" || b.kind === "steer"
    || b.kind === "compaction" || b.kind === "carried");
  const failed = rows.filter((r) => r.status === "failed" || r.status === "refused").length;

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
          <span className="run-meta">· {elapsed}</span>
        </div>
        <RunBody section={section} running headId={now?.callId} />
      </div>
    );
  }

  if (!rows.length && !commentary.length) return null;
  const body = (
    <>
      <span className="run-glyph" aria-hidden><Icon name="activity" size={14} /></span>
      <span>{rows.length ? t(rows.length === 1 ? "work.check" : "work.checks", { n: rows.length }) : t("work.notes")}</span>
      {failed ? <span className="run-meta run-failed">· {t("work.failed", { n: failed })}</span> : null}
      <span className="run-meta">· {elapsed}</span>
    </>
  );
  if (!rows.length) return <div className="run-receipt" data-testid="run-trace" data-live="false">{body}</div>;
  return (
    <button type="button" className="run-receipt" data-testid="run-trace" data-live="false"
      onClick={() => app.setPane({ tab: "details" })}>
      {body}
    </button>
  );
}

/** The deterministic evidence for the answer, folded unless it is the deliverable. */
function TurnData({ result, open: initiallyOpen }: { result: Row; open: boolean }) {
  const { t } = useI18n();
  const view = viewFor(result);
  const fix = view?.kind === "fix";
  const [open, setOpen] = useState(Boolean(fix || initiallyOpen));
  if (!view) return null;
  const label = view.kind === "survey"
    ? t("result.dataSurvey", { n: view.rows.length + view.omitted })
    : t(`result.data.${view.kind}`);
  return (
    <details className="turn-data" data-kind={view.kind} open={open} data-testid="run-result"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <Icon name={fix ? "tool" : "table"} size={14} />
        <span>{label}</span>
        <Icon name="chevron" size={13} className="turn-data-caret" />
      </summary>
      <div className="turn-data-body"><ResultView row={result} /></div>
    </details>
  );
}

function RunBody({ section, running = false, headId }: { section: Section; running?: boolean; headId?: string }) {
  const { t } = useI18n();
  return (
    <div className="run-body" data-testid="run-body">
      {section.blocks.map((b) => {
        if (b.kind === "commentary") return <div key={b.id} className="run-note"><Markdown text={b.text} /></div>;
        if (b.kind === "steer") return <p key={b.id} className="run-steer"><span>{t("work.steered")}</span> {b.text}</p>;
        if (b.kind === "carried") return <p key={b.id} className="run-carried">{t("work.carried", { n: b.count })}</p>;
        if (b.kind === "compaction") {
          return (
            <details key={b.id} className="run-context">
              <summary>{t("work.compacted")}{b.turns ? ` · ${t("work.turns", { n: b.turns })}` : ""}</summary>
              {b.summary ? <p>{b.summary}</p> : null}
            </details>
          );
        }
        // The call in the head line is not repeated; other calls (including
        // parallel ones still running) stay visible in the body.
        const visible = running ? b.tools.filter((r) => r.callId !== headId) : b.tools;
        if (!visible.length) return null;
        return (
          <ul key={b.id} className="call-list">
            {visible.map((r) => <CallRow key={r.callId} row={r} />)}
          </ul>
        );
      })}
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
        onClick={() => app.setPane({ tab: "details", callId: row.callId })}>
        <span className="call-glyph">
          {row.status === "running" ? <span className="ui-dot" data-tone="accent" data-pulse="true" aria-hidden /> : <Icon name={GLYPH[row.status]} size={14} />}
        </span>
        <span className="call-verb">{row.status === "running" ? toolRunLabel(row.name, lang) : toolLabel(row.name, lang)}</span>
        {row.target ? <span className="call-target">{row.target}</span> : null}
        {row.progress && row.progress.total > 0 ? (
          <span className="call-note">{t("tool.progress", { done: row.progress.done.toLocaleString(),
            total: row.progress.total.toLocaleString(), unit: row.progress.unit })}</span>
        ) : row.summary ? (
          <span className="call-note">{row.status === "refused" ? `${t("tool.refused")} — ` : ""}{row.summary}</span>
        ) : null}
      </button>
    </li>
  );
}

/** The interpretation: streamed while live, the model's final message once done. */
function Answer({ section, running, live }: { section: Section; running: boolean; live: LiveSegment | null }) {
  if (running) {
    return live ? (
      <div className="answer live-text" data-testid="live-answer" aria-live="polite">
        <Markdown text={live.text} /><span className="caret" aria-hidden />
      </div>
    ) : null;
  }
  const text = section.answer;
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
        <Button size="sm" onClick={() => void api.resume(taskId, section.turn.id).catch((e) => toast.error(describeError(e, t)))}>{t("turn.resume")}</Button>
        {st === "failed" ? <Button size="sm" variant="ghost" onClick={() => app.openSettings("models")}>{t("turn.openSettings")}</Button> : null}
      </div>
    );
  }
  if (section.stopped) return <p className="turn-note">{t("turn.stopped")}</p>;
  if (section.finalized) return <p className="turn-note">{t("turn.finalized")}</p>;
  return null;
}
