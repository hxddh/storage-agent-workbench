import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { api } from "../api";
import { Icon } from "../components/icons";
import { Markdown } from "../components/Markdown";
import { Button, IconButton } from "../components/ui";
import { saveTextFile } from "../config";
import { useI18n } from "../i18n";
import { fmtBytes } from "../lib/format";
import { toolLabel } from "../lib/toolLabels";
import { useApp } from "../shell/context";
import { allTools, sections, type ToolRow } from "../store/derive";
import type { TaskModel } from "../store/task";

const MIN_W = 352;
const MAX_W = 880;
const DEFAULT_W = 420;

function storedWidth(): number {
  try {
    const n = Number(localStorage.getItem("sa.pane.w"));
    return n >= MIN_W && n <= MAX_W ? n : DEFAULT_W;
  } catch {
    return DEFAULT_W;
  }
}

/** The one side pane's frame: a title, a close button, a resizable left edge. */
export function Pane({ title, children, testId }: { title: string; children: ReactNode; testId: string }) {
  const { t } = useI18n();
  const app = useApp();
  const [width, setWidth] = useState(storedWidth);
  const drag = useRef<{ x: number; w: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || app.settings || app.palette) return;
      // Escape in a field or a menu belongs to that field or menu, not to the pane.
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [role=menu], [role=listbox]")) return;
      app.setPane(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [app]);
  const onDown = (e: RPointerEvent) => {
    drag.current = { x: e.clientX, w: width };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent) => {
    if (drag.current) setWidth(Math.max(MIN_W, Math.min(MAX_W, drag.current.w + drag.current.x - e.clientX)));
  };
  const onUp = () => {
    drag.current = null;
    try { localStorage.setItem("sa.pane.w", String(width)); } catch { /* per device */ }
  };
  return (
    <aside className="inspector" style={{ width }} aria-label={title} data-testid={testId}>
      <div className="inspector-grip" role="separator" aria-orientation="vertical" onPointerDown={onDown}
        onPointerMove={onMove} onPointerUp={onUp} onDoubleClick={() => setWidth(DEFAULT_W)} />
      <header className="inspector-head">
        <h2 className="inspector-title">{title}</h2>
        <IconButton icon="close" label={t("pane.close")} onClick={() => app.setPane(null)} />
      </header>
      <div className="inspector-body">{children}</div>
    </aside>
  );
}

/**
 * Details of one task: every call the Agent made (one opens as a document with
 * its arguments and output), the files attached or imported, and the report.
 */
export function Details({ model }: { model: TaskModel }) {
  const { t } = useI18n();
  const app = useApp();
  const all = useMemo(() => sections(model.turns, model.items, null), [model.turns, model.items]);
  const tools = useMemo(() => allTools(all), [all]);
  const files = model.snapshot?.files ?? [];
  const pane = app.pane;
  if (!pane || pane.tab !== "details") return null;
  const call = pane.callId ? tools.find((r) => r.callId === pane.callId) ?? null : null;
  return (
    <Pane title={t("pane.details")} testId="inspector">
      {call ? <CallDetail row={call} /> : (
        <div className="details" data-testid="details">
          <SaveReport taskId={model.id} title={model.snapshot?.task.title ?? "task"} />
          <Usage usage={model.turns.map((x) => x.usage)} />
          <h3 className="pane-label">{t("pane.calls", { n: tools.length })}</h3>
          {tools.length ? (
            <ul className="details-calls">
              {tools.map((r) => <CallLine key={r.callId} row={r} />)}
            </ul>
          ) : <p className="quiet-note">{t("pane.noCalls")}</p>}
          {files.length ? (
            <>
              <h3 className="pane-label">{t("pane.files", { n: files.length })}</h3>
              <ul className="details-files">
                {files.map((f) => (
                  <li key={f.id}>
                    <Icon name="file" size={14} />
                    <span className="details-file-name">{f.filename}</span>
                    <small>{[fmtBytes(f.size_bytes), f.rows != null ? t("pane.rows", { n: f.rows.toLocaleString() }) : null]
                      .filter(Boolean).join(" · ")}</small>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      )}
    </Pane>
  );
}

function CallLine({ row }: { row: ToolRow }) {
  const { lang } = useI18n();
  const app = useApp();
  return (
    <li>
      <button type="button" data-status={row.status} data-tool={row.name}
        onClick={() => app.setPane({ tab: "details", callId: row.callId })}>
        <span className="call-verb">{toolLabel(row.name, lang)}</span>
        {row.target ? <span className="call-target">{row.target}</span> : null}
        {row.durationMs != null ? <small>{(row.durationMs / 1000).toFixed(1)}s</small> : null}
      </button>
    </li>
  );
}

function Usage({ usage }: { usage: Array<TaskModel["turns"][number]["usage"]> }) {
  const { t } = useI18n();
  const sum = usage.reduce<{ requests: number; input: number; output: number }>((acc, u) => ({
    requests: acc.requests + (u?.requests ?? 0), input: acc.input + (u?.input_tokens ?? 0), output: acc.output + (u?.output_tokens ?? 0),
  }), { requests: 0, input: 0, output: 0 });
  if (!sum.requests) return null;
  return (
    <p className="quiet-note">
      {sum.input || sum.output
        ? t("pane.usage", { req: sum.requests, inTok: sum.input.toLocaleString(), outTok: sum.output.toLocaleString() })
        : t("pane.requests", { req: sum.requests })}
    </p>
  );
}

function SaveReport({ taskId, title }: { taskId: string; title: string }) {
  const { t, lang } = useI18n();
  const [saved, setSaved] = useState<string | null>(null);
  const save = async () => {
    const text = await api.report(taskId, lang);
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
    <div className="details-report">
      <Button size="sm" icon="download" onClick={() => void save()} data-testid="save-report">{t("pane.saveReport")}</Button>
      {saved ? <span className="quiet-note">{t("pane.saved", { path: saved })}</span> : null}
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

function CallDetail({ row }: { row: ToolRow }) {
  const { t, lang } = useI18n();
  const app = useApp();
  return (
    <div className="call-detail" data-testid="call-detail">
      <Button size="sm" variant="ghost" icon="arrowRight" className="flip-icon" onClick={() => app.setPane({ tab: "details" })}>
        {t("pane.back")}
      </Button>
      <h3 className="call-title">{toolLabel(row.name, lang)}</h3>
      <p className="quiet-note"><code>{row.name}</code>{row.durationMs != null ? ` · ${(row.durationMs / 1000).toFixed(1)}s` : ""}</p>
      {row.summary ? <p>{row.summary}</p> : null}
      <h4 className="pane-label">{t("tool.args")}</h4>
      <Markdown text={"```json\n" + JSON.stringify(row.args, null, 2) + "\n```"} />
      {row.detail ? (
        <>
          <h4 className="pane-label">{t("tool.output")}</h4>
          <Markdown text={"```json\n" + pretty(row.detail) + "\n```"} />
          {row.detailTruncated ? <p className="quiet-note">{t("tool.truncated")}</p> : null}
        </>
      ) : null}
    </div>
  );
}
