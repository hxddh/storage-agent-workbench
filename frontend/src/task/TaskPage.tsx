import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { TaskSnapshot, Turn } from "../api/types";
import { Icon } from "../components/icons";
import { Markdown } from "../components/Markdown";
import { Button, IconButton, SectionLabel, StatusDot } from "../components/ui";
import { useToast } from "../components/Toast";
import { useCopy } from "../hooks/useCopy";
import { useI18n } from "../i18n";
import { revealInScroller } from "../lib/scroll";
import { useApp } from "../shell/context";
import type { TaskModel } from "../store/task";
import { findings, isLive, latestResult, sections, versions, type Section } from "../store/derive";
import { Result } from "./Result";
import { Blocks } from "./Work";

/**
 * One Task, result-first: banners, the work in progress (its Direction, the
 * live execution, and its conclusion as soon as it is recorded), the latest
 * Result, then the Work log — every earlier Direction as a document section.
 * A Direction can be edited: that sends a new version, a fork of the task at
 * that point, and ‹ 1 of 2 › reads the other branch.
 */
export function TaskPage({ model, setSnapshot }: { model: TaskModel; setSnapshot: (s: TaskSnapshot) => void }) {
  const { t } = useI18n();
  const all = useMemo(() => sections(model.turns, model.items, model.live), [model.turns, model.items, model.live]);
  const liveSection = all.find((s) => isLive(s.turn) && s.turn.status === "running") ?? null;
  const result = latestResult(all);
  const top = useRef<HTMLDivElement>(null);
  const liveId = liveSection?.turn.id;

  useEffect(() => {
    if (liveId) revealInScroller(top.current, "start");
  }, [liveId]);

  if (!model.snapshot) {
    return <div className="task-page" aria-busy="true"><p className="quiet-note">{model.error ?? t("task.loading")}</p></div>;
  }
  const log = all.filter((s) => s !== liveSection && s.turn.status !== "queued");
  const unified = findings(all);
  const outputs = {
    evidence: unified.length + model.snapshot.files.length,
    report: all.some((s) => s.answer || s.conclusion),
    activity: all.reduce((n, s) => n + s.toolCount, 0),
  };
  const single = log.length === 1 && result === log[0];

  return (
    <div className="task-page" ref={top} data-testid="task-page">
      <Banners model={model} all={all} />
      {liveSection ? (
        <section className="turn turn-live" aria-live="polite" data-testid="work-in-progress">
          <Direction section={liveSection} forks={model.snapshot.forks} setSnapshot={setSnapshot} taskId={model.id} />
          <Blocks blocks={liveSection.blocks} live endedAt={null} />
          {liveSection.live ? (
            <div className="commentary live-text"><Markdown text={liveSection.live.text} /><span className="caret" aria-hidden /></div>
          ) : null}
          {liveSection.conclusion ? <p className="result-answer reveal">{liveSection.conclusion.answer}</p> : null}
        </section>
      ) : null}
      {result ? (
        <>
          {single ? <Direction section={result} forks={model.snapshot.forks} setSnapshot={setSnapshot} taskId={model.id} lead /> : null}
          <Result section={result} outputs={outputs}
            work={single && result.blocks.length ? <Blocks blocks={result.blocks} live={false} endedAt={result.turn.finished_at} /> : null} />
        </>
      ) : !liveSection && !log.length ? (
        <p className="quiet-note">{t("task.empty")}</p>
      ) : null}
      {!single && log.length ? (
        <section className="work-log" aria-labelledby="work-log-label">
          <SectionLabel id="work-log-label">{t("task.log")}</SectionLabel>
          {log.map((s) => (
            <LogTurn key={s.turn.id} section={s} isResult={s === result} forks={model.snapshot!.forks}
              setSnapshot={setSnapshot} taskId={model.id} />
          ))}
        </section>
      ) : null}
    </div>
  );
}

function LogTurn({ section, isResult, forks, setSnapshot, taskId }: {
  section: Section; isResult: boolean; forks: Record<string, string[]>; setSnapshot: (s: TaskSnapshot) => void; taskId: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const head = section.conclusion?.answer ?? section.answer?.split("\n").find((l) => l.trim()) ?? null;
  return (
    <section className="turn" data-status={section.turn.status}>
      <Direction section={section} forks={forks} setSnapshot={setSnapshot} taskId={taskId} />
      <Blocks blocks={section.blocks} live={false} endedAt={section.turn.finished_at} />
      {isResult ? (
        <p className="quiet-note">{t("task.resultPointer")}</p>
      ) : section.answer ? (
        open ? (
          <div className="turn-answer reveal"><Markdown text={section.answer} /></div>
        ) : (
          <button type="button" className="turn-fold" onClick={() => setOpen(true)} aria-expanded={false}>
            <span>{head}</span>
            <Icon name="chevron" size={14} />
          </button>
        )
      ) : null}
      {section.error ? <p className="quiet-note"><StatusDot tone="danger" /> {section.error.message}</p> : null}
    </section>
  );
}

function Direction({ section, forks, setSnapshot, taskId, lead = false }: {
  section: Section; forks: Record<string, string[]>; setSnapshot: (s: TaskSnapshot) => void; taskId: string; lead?: boolean;
}) {
  const { t } = useI18n();
  const app = useApp();
  const toast = useToast();
  const { copied, copy } = useCopy();
  const turn: Turn = section.turn;
  const v = versions(forks, turn);
  const go = async (to: number) => {
    if (!v) return;
    try {
      setSnapshot(await api.switchBranch(taskId, v.ids[to]));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };
  if (turn.kind === "resume") return null;
  return (
    <header className="direction" data-lead={lead ? "true" : undefined}>
      <h2 className="direction-text">{section.direction}</h2>
      {section.attachments?.length ? (
        <ul className="direction-files">
          {section.attachments.map((a) => (
            <li key={a.dataset_id}><Icon name="file" size={14} /><span>{a.filename}</span></li>
          ))}
        </ul>
      ) : null}
      <div className="direction-tools">
        {v ? (
          <span className="versions" role="group" aria-label={t("task.version", { i: v.index + 1, n: v.ids.length })}>
            <IconButton icon="chevron" size="sm" className="flip" label={t("task.prevVersion")} disabled={v.index === 0}
              onClick={() => void go(v.index - 1)} />
            <span>{t("task.version", { i: v.index + 1, n: v.ids.length })}</span>
            <IconButton icon="chevron" size="sm" label={t("task.nextVersion")} disabled={v.index === v.ids.length - 1}
              onClick={() => void go(v.index + 1)} />
          </span>
        ) : null}
        {!isLive(turn) ? (
          <IconButton icon="compose" size="sm" label={t("task.edit")} data-testid="edit-direction"
            onClick={() => app.setEditing({ turnId: turn.id, parentTurnId: turn.parent_turn_id, text: section.direction })} />
        ) : null}
        <IconButton icon={copied ? "check" : "copy"} size="sm" label={copied ? t("common.copied") : t("common.copy")}
          onClick={() => copy(section.direction)} />
      </div>
    </header>
  );
}

function Banners({ model, all }: { model: TaskModel; all: Section[] }) {
  const { t } = useI18n();
  const app = useApp();
  const toast = useToast();
  const last = all[all.length - 1];
  const queued = model.snapshot?.queued.filter((q) => model.queuedTurnIds.includes(q.turn_id)) ?? [];
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div className="banners">
      {queued.map((q) => (
        <div key={q.turn_id} className="banner" data-kind="queued">
          <StatusDot tone="neutral" />
          <span className="banner-label">{t("task.queued")}</span>
          <span className="banner-text">{q.direction}</span>
          <Button size="sm" variant="ghost" onClick={() => void run(() => api.withdraw(model.id, q.turn_id))}>
            {t("task.withdraw")}
          </Button>
        </div>
      ))}
      {last && !model.runningTurnId && (last.turn.status === "failed" || last.turn.status === "interrupted") ? (
        <div className="banner" data-kind="attention" data-testid="attention">
          <StatusDot tone={last.turn.status === "failed" ? "danger" : "warn"} />
          <span className="banner-text">
            {last.error?.message ?? (last.turn.status === "interrupted" ? t("task.interrupted") : t("task.failed"))}
          </span>
          {last.error?.action === "settings" ? (
            <Button size="sm" onClick={() => app.openSettings("models")}>{t("task.openSettings")}</Button>
          ) : (
            <Button size="sm" onClick={() => void run(() => api.resume(model.id, last.turn.id))}>{t("task.resume")}</Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
