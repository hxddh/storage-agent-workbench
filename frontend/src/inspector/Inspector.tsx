import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { api } from "../api";
import type { FileRow } from "../api/types";
import { Icon } from "../components/icons";
import { Markdown } from "../components/Markdown";
import { Badge, Button, IconButton, SectionLabel } from "../components/ui";
import { saveTextFile } from "../config";
import { useI18n } from "../i18n";
import { fmtBytes } from "../lib/format";
import { toolLabel } from "../lib/toolLabels";
import { useApp, type PaneTab } from "../shell/context";
import { allTools, findings, sections, type ToolRow } from "../store/derive";
import type { TaskModel } from "../store/task";
import { SEVERITY_TONE } from "../task/Result";

const MIN_W = 352;
const MAX_W = 880;
const DEFAULT_W = 440;

function storedWidth(): number {
  try {
    const n = Number(localStorage.getItem("sa.pane.w"));
    return n >= MIN_W && n <= MAX_W ? n : DEFAULT_W;
  } catch {
    return DEFAULT_W;
  }
}

/**
 * The one side pane for a task's durable outputs: Evidence (the unified
 * findings and attached evidence), Report (the task report in the reader's
 * language), Activity (every tool call; one opens as a document). Resizable
 * from its left edge; Esc and the close button close it.
 */
export function Inspector({ model }: { model: TaskModel }) {
  const { t } = useI18n();
  const app = useApp();
  const [width, setWidth] = useState(storedWidth);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const all = useMemo(() => sections(model.turns, model.items, null), [model.turns, model.items]);
  const unified = useMemo(() => findings(all), [all]);
  const tools = useMemo(() => allTools(all), [all]);
  const files = model.snapshot?.files ?? [];
  const pane = app.pane;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !app.settings && !app.palette) app.setPane(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [app]);

  if (!pane) return null;
  const tabs: Array<{ tab: PaneTab; label: string; n: number | null }> = [
    { tab: "evidence", label: t("task.outputs.evidence"), n: unified.length + files.length },
    { tab: "report", label: t("task.outputs.report"), n: null },
    { tab: "activity", label: t("task.outputs.activity"), n: tools.length },
  ];

  const onDown = (e: RPointerEvent) => {
    drag.current = { x: e.clientX, w: width };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent) => {
    if (!drag.current) return;
    setWidth(Math.max(MIN_W, Math.min(MAX_W, drag.current.w + drag.current.x - e.clientX)));
  };
  const onUp = () => {
    drag.current = null;
    try { localStorage.setItem("sa.pane.w", String(width)); } catch { /* per device */ }
  };

  return (
    <aside className="inspector" style={{ width }} aria-label={tabs.find((x) => x.tab === pane.tab)?.label}
      data-testid="inspector">
      <div className="inspector-grip" role="separator" aria-orientation="vertical" onPointerDown={onDown}
        onPointerMove={onMove} onPointerUp={onUp} onDoubleClick={() => setWidth(DEFAULT_W)} />
      <header className="inspector-head">
        <div className="inspector-tabs" role="tablist">
          {tabs.map((x) => (
            <button key={x.tab} role="tab" type="button" aria-selected={pane.tab === x.tab}
              onClick={() => app.setPane({ tab: x.tab })}>
              {x.label}{x.n ? <small>{x.n}</small> : null}
            </button>
          ))}
        </div>
        <IconButton icon="close" label={t("inspector.close")} onClick={() => app.setPane(null)} />
      </header>
      <div className="inspector-body" role="tabpanel">
        {pane.tab === "evidence" ? <Evidence findings={unified} files={files} all={all} /> : null}
        {pane.tab === "report" ? <Report taskId={model.id} title={model.snapshot?.task.title ?? "task"} version={model.lastSeq} /> : null}
        {pane.tab === "activity" ? (
          pane.callId ? <CallDetail row={tools.find((r) => r.callId === pane.callId) ?? null} />
            : <Activity tools={tools} usage={model.turns.map((t) => t.usage)} />
        ) : null}
      </div>
    </aside>
  );
}

function Evidence({ findings: list, files, all }: {
  findings: ReturnType<typeof findings>; files: FileRow[]; all: ReturnType<typeof sections>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="evidence" data-testid="evidence">
      <SectionLabel count={list.length}>{t("task.findings")}</SectionLabel>
      {list.length ? (
        <ul className="evidence-findings">
          {list.map((f, i) => {
            const from = all.find((s) => s.turn.id === f.turnId);
            return (
              <li key={i} data-severity={f.severity}>
                <button type="button" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                  <Badge tone={SEVERITY_TONE[f.severity]}>{t(`sev.${f.severity}`)}</Badge>
                  <span>{f.title}</span>
                </button>
                {open === i ? (
                  <div className="evidence-detail reveal">
                    {f.detail ? <p>{f.detail}</p> : null}
                    {from ? <p className="quiet-note">{t("inspector.source", { direction: from.direction.slice(0, 80) })}</p> : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : <p className="quiet-note">{t("inspector.noFindings")}</p>}
      <SectionLabel count={files.length}>{t("inspector.files")}</SectionLabel>
      {files.length ? (
        <ul className="evidence-files">
          {files.map((f) => (
            <li key={f.id}>
              <Icon name="file" size={14} />
              <span className="evidence-file-name">{f.filename}</span>
              <small>{[f.type.replace("_", " "), fmtBytes(f.size_bytes), f.rows != null ? `${f.rows.toLocaleString()} rows` : null]
                .filter(Boolean).join(" · ")}</small>
            </li>
          ))}
        </ul>
      ) : <p className="quiet-note">{t("inspector.noFiles")}</p>}
    </div>
  );
}

function Report({ taskId, title, version }: { taskId: string; title: string; version: number }) {
  const { t, lang } = useI18n();
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.report(taskId, lang).then((r) => { if (alive) setText(r); }).catch((e) => { if (alive) setText(`> ${String(e)}`); });
    return () => { alive = false; };
  }, [taskId, lang, version]);
  if (text == null) return <p className="quiet-note">{t("inspector.reportLoading")}</p>;
  const save = async () => {
    const name = `${title.replace(/[^\w一-鿿-]+/g, "-").slice(0, 60) || "report"}.md`;
    const path = await saveTextFile(name, text);
    if (path) setSaved(path);
    else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
      a.download = name;
      a.click();
    }
  };
  return (
    <div className="report" data-testid="report">
      <div className="report-actions">
        <Button size="sm" icon="download" onClick={() => void save()}>{t("inspector.save")}</Button>
        {saved ? <span className="quiet-note">{t("inspector.saved", { path: saved })}</span> : null}
      </div>
      <Markdown text={text} />
    </div>
  );
}

function Activity({ tools, usage }: { tools: ToolRow[]; usage: Array<TaskModel["turns"][number]["usage"]> }) {
  const { t, lang } = useI18n();
  const app = useApp();
  const sum = usage.reduce<{ requests: number; input: number; output: number }>((acc, u) => ({
    requests: acc.requests + (u?.requests ?? 0),
    input: acc.input + (u?.input_tokens ?? 0),
    output: acc.output + (u?.output_tokens ?? 0),
  }), { requests: 0, input: 0, output: 0 });
  return (
    <div className="activity" data-testid="activity">
      {sum.requests ? (
        <p className="quiet-note">{t("inspector.usage", { req: sum.requests, inTok: sum.input.toLocaleString(), outTok: sum.output.toLocaleString() })}</p>
      ) : null}
      {tools.length ? (
        <ul className="activity-list">
          {tools.map((r) => (
            <li key={r.callId}>
              <button type="button" onClick={() => app.setPane({ tab: "activity", callId: r.callId })} data-status={r.status}>
                <span className="activity-verb">{toolLabel(r.name, lang)}</span>
                {r.target ? <span className="tool-target">{r.target}</span> : null}
                {r.durationMs != null ? <small>{(r.durationMs / 1000).toFixed(1)}s</small> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="quiet-note">{t("inspector.noActivity")}</p>}
    </div>
  );
}

function pretty(text: string | null): string {
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function CallDetail({ row }: { row: ToolRow | null }) {
  const { t, lang } = useI18n();
  const app = useApp();
  if (!row) return null;
  return (
    <div className="call-detail" data-testid="call-detail">
      <Button size="sm" variant="ghost" icon="arrowRight" className="flip-icon" onClick={() => app.setPane({ tab: "activity" })}>
        {t("inspector.back")}
      </Button>
      <h3 className="call-title">{toolLabel(row.name, lang)}</h3>
      <p className="quiet-note"><code>{row.name}</code>{row.durationMs != null ? ` · ${(row.durationMs / 1000).toFixed(1)}s` : ""}</p>
      {row.summary ? <p>{row.summary}</p> : null}
      <SectionLabel>{t("tool.args")}</SectionLabel>
      <Markdown text={"```json\n" + JSON.stringify(row.args, null, 2) + "\n```"} />
      {row.detail ? (
        <>
          <SectionLabel>{t("tool.output")}</SectionLabel>
          <Markdown text={"```json\n" + pretty(row.detail) + "\n```"} />
          {row.detailTruncated ? <p className="quiet-note">{t("tool.truncated")}</p> : null}
        </>
      ) : null}
    </div>
  );
}
