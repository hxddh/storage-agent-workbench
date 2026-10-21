import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { api } from "../api";
import { Icon } from "../components/icons";
import { Markdown } from "../components/Markdown";
import { useToast } from "../components/Toast";
import { Button, IconButton } from "../components/ui";
import { saveTextFile } from "../config";
import { useI18n } from "../i18n";
import { fmtBytes } from "../lib/format";
import { revealInScroller } from "../lib/scroll";
import { toolLabel } from "../lib/toolLabels";
import { useApp } from "../shell/context";
import { allTools, sections, type ToolRow } from "../store/derive";
import type { TaskModel } from "../store/task";
import { ResultView, viewFor } from "../tool/ResultView";

const MIN_W = 352;
const MAX_W = 880;
const DEFAULT_W = 480;

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
  const titleRef = useRef<HTMLHeadingElement>(null);
  // Opened from a button, the pane takes focus; closed, focus goes back where it came from.
  // (Opened while typing — ⌘I in the Composer — focus stays in the field.)
  useEffect(() => {
    const from = document.activeElement as HTMLElement | null;
    const typing = !!from?.closest?.("input, textarea, [contenteditable=true]");
    if (!typing) titleRef.current?.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      if (from?.isConnected && (!now || now === document.body || !now.isConnected)) from.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || app.settings) return;
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
  const resizeBy = (dx: number) => setWidth((w) => {
    const next = Math.max(MIN_W, Math.min(MAX_W, w + dx));
    try { localStorage.setItem("sa.pane.w", String(next)); } catch { /* per device */ }
    return next;
  });
  return (
    <aside className="inspector" style={{ width }} aria-label={title} data-testid={testId}>
      <div className="inspector-grip" role="separator" aria-orientation="vertical" tabIndex={0}
        aria-label={t("pane.resize")} aria-valuemin={MIN_W} aria-valuemax={MAX_W} aria-valuenow={width}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onDoubleClick={() => setWidth(DEFAULT_W)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") { e.preventDefault(); resizeBy(32); }
          else if (e.key === "ArrowRight") { e.preventDefault(); resizeBy(-32); }
        }} />
      <header className="inspector-head">
        <h2 className="inspector-title" ref={titleRef} tabIndex={-1}>{title}</h2>
        <IconButton icon="close" label={t("pane.close")} onClick={() => app.setPane(null)} />
      </header>
      <div className="inspector-body">{children}</div>
    </aside>
  );
}

/**
 * Evidence for one task in one scroll: every check expands in place to its
 * rendered result and raw data; there is no second page or Back control.
 */
export function Details({ model }: { model: TaskModel }) {
  const { t } = useI18n();
  const app = useApp();
  const all = useMemo(() => sections(model.turns, model.items, null), [model.turns, model.items]);
  const tools = useMemo(() => allTools(all), [all]);
  const files = model.snapshot?.files ?? [];
  const pane = app.pane;
  const focusCall = pane?.tab === "details" ? pane.callId : undefined;
  // A tool row in the conversation opens the pane at that exact call, not at
  // the top of a long run. The row expands as it scrolls into view.
  useEffect(() => {
    if (!focusCall) return;
    const frame = requestAnimationFrame(() => {
      const target = [...document.querySelectorAll<HTMLElement>("[data-call-id]")]
        .find((el) => el.dataset.callId === focusCall);
      revealInScroller(target, "center");
    });
    return () => cancelAnimationFrame(frame);
  }, [focusCall]);
  if (!pane || pane.tab !== "details") return null;
  return (
    <Pane title={t("pane.details")} testId="inspector">
      <div className="details" data-testid="details">
        {tools.length ? (
          <ul className="details-calls">
            {tools.map((r) => <CallLine key={r.callId} row={r} focus={r.callId === focusCall} />)}
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
        <SaveReport taskId={model.id} title={model.snapshot?.task.title ?? "task"} />
        <Usage usage={model.turns.map((x) => x.usage)} />
      </div>
    </Pane>
  );
}

function CallLine({ row, focus }: { row: ToolRow; focus: boolean }) {
  const { t, lang } = useI18n();
  const app = useApp();
  const [open, setOpen] = useState(false);
  const view = viewFor(row);
  useEffect(() => { if (focus) setOpen(true); }, [focus]);
  return (
    <li data-call-id={row.callId}>
      <details className="call-evidence" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary data-testid="evidence-call" data-status={row.status} data-tool={row.name}>
          <span className="call-verb">{toolLabel(row.name, lang)}</span>
          {row.target ? <span className="call-target">{row.target}</span> : null}
          {row.summary ? <span className="call-note">{row.summary}</span> : null}
          {row.status === "failed" || row.status === "refused"
            ? <span className="sr-only">{t(row.status === "refused" ? "tool.refused" : "tool.failed")}</span> : null}
          {row.durationMs != null ? <small>{(row.durationMs / 1000).toFixed(1)}s</small> : null}
          <Icon name="chevron" size={13} className="call-caret" />
        </summary>
        <div className="call-evidence-body" data-testid="call-detail">
          {view ? <ResultView row={row} /> : (
            <p className="quiet-note result-gap">{row.detailTruncated ? t("result.truncatedGap") : t("tool.noView")}</p>
          )}
          <details className="raw-fold" open={!view}>
            <summary>{t("tool.raw")}</summary>
            <h4 className="pane-label">{t("tool.args")}</h4>
            <Markdown text={"```json\n" + JSON.stringify(readableArgs(row.args, app.clouds), null, 2) + "\n```"} />
            {row.detail ? (
              <>
                <h4 className="pane-label">{t("tool.output")}</h4>
                <Markdown text={"```json\n" + pretty(row.detail) + "\n```"} />
                {row.detailTruncated ? <p className="quiet-note">{t("tool.truncated")}</p> : null}
              </>
            ) : null}
          </details>
        </div>
      </details>
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
    <details className="usage-fold">
      <summary>{t("pane.usageLabel")}</summary>
      <p className="pane-usage">
        {sum.input || sum.output
          ? t(sum.requests === 1 ? "pane.usage1" : "pane.usage", { req: sum.requests, inTok: sum.input.toLocaleString(), outTok: sum.output.toLocaleString() })
          : t(sum.requests === 1 ? "pane.request" : "pane.requests", { req: sum.requests })}
      </p>
    </details>
  );
}

function SaveReport({ taskId, title }: { taskId: string; title: string }) {
  const { t, lang } = useI18n();
  const [saved, setSaved] = useState<string | null>(null);
  const toast = useToast();
  const save = async () => {
    try {
      const text = await api.report(taskId, lang);
      const name = `${title.replace(/[^\w一-鿿-]+/g, "-").slice(0, 60) || "report"}.md`;
      const path = await saveTextFile(name, text);
      if (path) setSaved(path);
      else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 0);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
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

/** A storage account reads by its name, not its opaque id. */
function readableArgs(args: ToolRow["args"], clouds: Array<{ id: string; name: string }> | null) {
  const id = args && typeof args === "object" ? (args as Record<string, unknown>).provider_id : undefined;
  const name = typeof id === "string" ? clouds?.find((c) => c.id === id)?.name : undefined;
  return name ? { ...(args as Record<string, unknown>), provider_id: name } : args;
}
