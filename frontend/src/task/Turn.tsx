import { useState } from "react";
import { api } from "../api";
import type { TaskSnapshot } from "../api/types";
import { Icon } from "../components/icons";
import { Markdown } from "../components/Markdown";
import { Button, IconButton, StatusDot } from "../components/ui";
import { useToast } from "../components/Toast";
import { useCopy } from "../hooks/useCopy";
import { useElapsed } from "../hooks/useElapsed";
import { useI18n } from "../i18n";
import { SEVERITY_TONE } from "../lib/severity";
import { toolLabel } from "../lib/toolLabels";
import { useApp } from "../shell/context";
import { figures, versions, type Section, type ToolRow as Row } from "../store/derive";
import { AnalysisFigures } from "../viz/AnalysisFigures";

/**
 * One turn of the conversation: the user's message, one line for the work
 * (live: what the Agent is doing now; done: how many steps and how long —
 * it opens to the commentary and every call), then the answer.
 */
export function Turn({ section, taskId, forks, setSnapshot, running }: {
  section: Section; taskId: string; forks: Record<string, string[]>;
  setSnapshot: (s: TaskSnapshot) => void; running: boolean;
}) {
  const { t } = useI18n();
  const s = section;
  const queued = s.turn.status === "queued";
  return (
    <section className="turn" data-status={s.turn.status} data-testid="turn">
      {s.turn.kind === "resume"
        ? <p className="turn-note">{t("turn.continued")}</p>
        : <Message section={s} taskId={taskId} forks={forks} setSnapshot={setSnapshot} />}
      {queued ? <Queued taskId={taskId} turnId={s.turn.id} /> : null}
      {!queued ? <Activity section={s} running={running} /> : null}
      <Answer section={s} running={running} />
      <Outcome section={s} taskId={taskId} running={running} />
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

/** One line for the work. Live: the call running now. Done: steps and time; it opens. */
function Activity({ section, running }: { section: Section; running: boolean }) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const rows = tools(section);
  const commentary = section.blocks.filter((b) => b.kind === "commentary" || b.kind === "steer" || b.kind === "compacted");
  const start = section.turn.started_at ?? section.turn.created_at;
  const elapsed = useElapsed(start, running ? null : section.turn.finished_at, running, lang);
  if (!running && !rows.length && !commentary.length) return null;
  const now = [...rows].reverse().find((r) => r.status === "running");
  const failed = rows.filter((r) => r.status === "failed" || r.status === "refused").length;
  let label: string;
  if (running) {
    label = now ? `${toolLabel(now.name, lang)}${now.target ? ` ${now.target}` : ""}` : t("work.thinking");
  } else {
    label = rows.length === 1 ? t("work.step") : rows.length ? t("work.steps", { n: rows.length }) : t("work.notes");
  }
  const p = running ? now?.progress : null;
  return (
    <div className="activity-line" data-open={open ? "true" : "false"} data-live={running ? "true" : undefined}>
      <button type="button" className="activity-head" aria-expanded={open} onClick={() => setOpen(!open)}
        data-testid="activity-line">
        {running ? <span className="ui-dot" data-tone="accent" data-pulse="true" aria-hidden /> : null}
        <span className="activity-label">{label}</span>
        {p && p.total > 0 ? (
          <span className="activity-progress">{t("tool.progress", { done: p.done.toLocaleString(), total: p.total.toLocaleString(), unit: p.unit })}</span>
        ) : null}
        {failed && !running ? <span className="activity-meta">· {t("work.failed", { n: failed })}</span> : null}
        <span className="activity-meta">· {elapsed}</span>
        <Icon name="chevron" size={14} className="activity-caret" />
      </button>
      {running && !open ? <LiveNotes section={section} /> : null}
      {open ? (
        <div className="activity-body reveal">
          {section.blocks.map((b) => {
            if (b.kind === "commentary") return <div key={b.id} className="activity-note"><Markdown text={b.text} /></div>;
            if (b.kind === "steer") return <p key={b.id} className="activity-steer"><span>{t("work.steered")}</span> {b.text}</p>;
            if (b.kind === "compacted") return <p key={b.id} className="activity-steer">{t("work.compacted")}</p>;
            return (
              <ul key={b.id} className="call-list">
                {b.tools.map((r) => <CallRow key={r.callId} row={r} />)}
              </ul>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** While work is live, the Agent's latest note (its short commentary) under the line. */
function LiveNotes({ section }: { section: Section }) {
  const last = [...section.blocks].reverse().find((b) => b.kind === "commentary" || b.kind === "steer");
  if (!last || (last.kind !== "commentary" && last.kind !== "steer")) return null;
  return <p className="activity-now reveal">{last.text}</p>;
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
        <span className="call-verb">{toolLabel(row.name, lang)}</span>
        {row.target ? <span className="call-target">{row.target}</span> : null}
        {row.summary ? <span className="call-note">{row.status === "refused" ? `${t("tool.refused")} — ` : ""}{row.summary}</span> : null}
      </button>
    </li>
  );
}

/** The answer: streamed while live, the model's final message once done, the recorded findings under it. */
function Answer({ section, running }: { section: Section; running: boolean }) {
  const c = section.conclusion;
  const fig = running ? null : figures(section);
  if (running) {
    return section.live ? (
      <div className="answer live-text" data-testid="live-answer">
        <Markdown text={section.live.text} /><span className="caret" aria-hidden />
      </div>
    ) : null;
  }
  // A conclusion recorded before v9 carries its own answer; newer ones do not.
  const text = section.answer ?? c?.answer ?? null;
  const found = c?.findings ?? [];
  if (!text && !found.length && !fig) return null;
  return (
    <div className="answer reveal" data-testid="answer">
      {text ? <Markdown text={text} /> : null}
      {found.length ? <Findings findings={found} /> : null}
      {fig ? <AnalysisFigures provenance={fig} /> : null}
    </div>
  );
}

function Findings({ findings }: { findings: NonNullable<NonNullable<Section["conclusion"]>["findings"]> }) {
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
      <div className="turn-outcome" data-testid="attention">
        <StatusDot tone={st === "failed" ? "danger" : "warn"} />
        {/* The reason, when the runtime recorded one; a failure points at the model settings,
            an interruption (a restart) can simply continue. */}
        <span className="turn-outcome-text">{section.error?.message ?? section.turn.error
          ?? (st === "interrupted" ? t("turn.interrupted") : t("turn.failed"))}</span>
        {st === "failed"
          ? <Button size="sm" onClick={() => app.openSettings("models")}>{t("turn.openSettings")}</Button>
          : <Button size="sm" onClick={() => void api.resume(taskId, section.turn.id).catch((e) => toast.error(String(e)))}>{t("turn.resume")}</Button>}
      </div>
    );
  }
  if (section.stopped) return <p className="turn-note">{t("turn.stopped")}</p>;
  if (section.finalized) return <p className="turn-note">{t("turn.finalized")}</p>;
  return null;
}
