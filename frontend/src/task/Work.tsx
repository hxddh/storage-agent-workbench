import { useState } from "react";
import { Icon } from "../components/icons";
import { useI18n } from "../i18n";
import { useElapsed } from "../hooks/useElapsed";
import { toolLabel } from "../lib/toolLabels";
import type { Block, ToolRow as Row } from "../store/derive";
import { useApp } from "../shell/context";
import { Markdown } from "../components/Markdown";

/**
 * What the Agent did, as a document: commentary in order, and between it one
 * "Worked for …" group of tool rows. While the turn is live every group stays
 * open; afterwards each folds to its one line.
 */
export function Blocks({ blocks, live, endedAt }: { blocks: Block[]; live: boolean; endedAt: string | null }) {
  const { t } = useI18n();
  return (
    <div className="blocks">
      {blocks.map((b, i) => {
        if (b.kind === "commentary") return <div key={b.id} className="commentary reveal"><Markdown text={b.text} /></div>;
        if (b.kind === "steer") {
          return (
            <p key={b.id} className="steer-note reveal">
              <Icon name="arrowRight" size={14} />
              <span className="steer-label">{t("task.steered")}</span>
              <span>{b.text}</span>
            </p>
          );
        }
        if (b.kind === "compacted") return <p key={b.id} className="quiet-note">{t("task.compacted")}</p>;
        const next = blocks.slice(i + 1).find((x) => x.kind === "work");
        const groupLive = live && !next && b.tools.some((r) => r.status === "running");
        return <WorkGroup key={b.id} tools={b.tools} startedAt={b.startedAt} endedAt={b.endedAt ?? endedAt}
          live={live} running={groupLive} />;
      })}
    </div>
  );
}

function WorkGroup({ tools, startedAt, endedAt, live, running }: {
  tools: Row[]; startedAt: string; endedAt: string | null; live: boolean; running: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const elapsed = useElapsed(startedAt, endedAt, running);
  const expanded = live || open;
  return (
    <div className="work-group reveal" data-open={expanded ? "true" : "false"}>
      <button type="button" className="work-head" aria-expanded={expanded} onClick={() => setOpen(!open)} disabled={live}>
        {running ? <span className="ui-dot" data-tone="accent" data-pulse="true" aria-hidden /> : null}
        <span>{running ? t("task.workingFor", { t: elapsed }) : t("task.workedFor", { t: elapsed })}</span>
        {!live ? <Icon name="chevron" size={14} className="work-caret" /> : null}
      </button>
      {expanded ? (
        <ul className="tool-rows">
          {tools.map((r) => <ToolRow key={r.callId} row={r} />)}
        </ul>
      ) : null}
    </div>
  );
}

const GLYPH: Record<Row["status"], { icon: "check" | "x" | "alert" | "tool"; tone: string }> = {
  ok: { icon: "check", tone: "neutral" },
  failed: { icon: "x", tone: "danger" },
  refused: { icon: "alert", tone: "warn" },
  running: { icon: "tool", tone: "accent" },
};

export function ToolRow({ row }: { row: Row }) {
  const { t, lang } = useI18n();
  const app = useApp();
  const g = GLYPH[row.status];
  const p = row.progress;
  return (
    <li className="tool-row reveal" data-status={row.status}>
      <button type="button" className="tool-row-btn" data-tool={row.name} title={row.name}
        onClick={() => app.setPane({ tab: "activity", callId: row.callId })}>
        <span className="tool-glyph" data-tone={g.tone}>
          {row.status === "running" ? <span className="ui-dot" data-tone="accent" data-pulse="true" aria-hidden /> : <Icon name={g.icon} size={14} />}
        </span>
        <span className="tool-verb">{toolLabel(row.name, lang)}</span>
        {row.target ? <span className="tool-target">{row.target}</span> : null}
        {row.status === "running" && p && p.total > 0 ? (
          <span className="tool-progress">
            <span>{t("tool.progress", { done: p.done.toLocaleString(), total: p.total.toLocaleString(), unit: p.unit })}</span>
            <span className="meter" aria-hidden><span style={{ width: `${Math.min(100, (p.done / p.total) * 100)}%` }} /></span>
          </span>
        ) : row.summary ? (
          <span className="tool-note">{row.status === "refused" ? `${t("tool.refused")} — ` : ""}{row.summary}</span>
        ) : null}
      </button>
    </li>
  );
}
