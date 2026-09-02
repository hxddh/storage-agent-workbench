import { useEffect, useMemo, useRef, useState } from "react";
import { getReport, getRun, runEventsUrl } from "../api";
import type { ReportOut, RunDetail as RunDetailT, RunEvent, ToolActivity } from "../types";
import { LiveTrace } from "./LiveTrace";
import { Markdown } from "./Markdown";
import { useI18n } from "../i18n";
import { Icon } from "./icons";

const SEVERITY_KEY: Record<string, string> = {
  critical: "metric.critical", error: "metric.critical", warning: "metric.warning",
  opportunity: "metric.opportunity", good: "metric.good",
  "provider unsupported": "metric.providerUnsupported",
  "access denied": "metric.accessDenied",
};

function summarizeOutput(output?: Record<string, unknown>): string {
  if (!output) return "";
  if (output.error_code) return `error: ${String(output.error_code)}`;
  if (output.identity_hint) return `identity: ${String(output.identity_hint)}`;
  if (output.report_path) return "report written";
  if (typeof output.status_code === "number") return `status ${output.status_code}`;
  if (typeof output.key_count === "number") return `key_count ${output.key_count}`;
  if (typeof output.object_count === "number") return `objects ${output.object_count}`;
  if (typeof output.total_requests === "number") return `requests ${output.total_requests}`;
  if (Array.isArray(output.findings)) return `${output.findings.length} finding(s)`;
  if (output.overall_status) return String(output.overall_status);
  return output.success === false ? "failed" : "ok";
}

/**
 * One durable Execution, read as a document inside the Review sheet: what was
 * asked, one *Worked for …* group of its tool calls, what was found, what it
 * concluded, and the report it wrote. Live while the run is still running
 * (the same event stream), durable afterwards.
 */
export function ExecutionDetailImplementation({
  runId,
  onBack,
}: {
  runId: string;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<RunDetailT | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [report, setReport] = useState<ReportOut | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const { t, lang } = useI18n();
  const copy = lang === "zh"
    ? {
        back: "返回 Execution 列表",
        loadFailed: "无法加载这次 Execution：",
        failure: "Execution 失败：",
        fallbackTitle: "Agent Execution",
        direction: "Direction",
        findings: "Findings",
        noFindings: "这次 Execution 没有记录 Findings。",
        noTools: "这次 Execution 没有调用工具。",
        result: "Work Result",
        report: "Report",
        root: "（根）",
        statuses: { pending: "排队中", running: "执行中", completed: "已完成", failed: "失败", not_implemented: "不可用" } as Record<string, string>,
      }
    : {
        back: "Back to Executions",
        loadFailed: "Couldn't load this execution:",
        failure: "Execution failed:",
        fallbackTitle: "Agent execution",
        direction: "Direction",
        findings: "Findings",
        noFindings: "This execution recorded no findings.",
        noTools: "This execution called no tools.",
        result: "Work Result",
        report: "Report",
        root: "(root)",
        statuses: { pending: "queued", running: "running", completed: "complete", failed: "failed", not_implemented: "unavailable" } as Record<string, string>,
      };

  const runTypeLabel = (runType?: string | null): string => {
    if (!runType) return "";
    const value = t(`runtype.${runType}`);
    return value === `runtype.${runType}` ? runType : value;
  };
  const severityLabel = (severity?: string | null): string => {
    const normalized = (severity || "").toLowerCase();
    return SEVERITY_KEY[normalized] ? t(SEVERITY_KEY[normalized]) : severity || "info";
  };

  useEffect(() => {
    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    const isTerminal = (status?: string) => status === "completed" || status === "failed" || status === "not_implemented";
    let lastStatus: string | undefined;
    let streamDone = false;

    setEvents([]);
    setReport(null);
    setLoadError(null);

    const refreshDetail = () => {
      getRun(runId)
        .then((next) => {
          if (cancelled) return;
          lastStatus = next.status;
          setDetail(next);
          if (isTerminal(next.status)) {
            if (poll) { clearInterval(poll); poll = undefined; }
            esRef.current?.close();
          }
        })
        .catch(() => undefined);
    };

    getRun(runId)
      .then((next) => {
        if (cancelled) return;
        lastStatus = next.status;
        setDetail(next);
        if ((next.status === "completed" || next.status === "failed") && next.report_path) {
          getReport(runId).then((value) => { if (!cancelled) setReport(value); }).catch(() => undefined);
        }
      })
      .catch((error) => { if (!cancelled) setLoadError(String(error)); });

    const eventSource = new EventSource(runEventsUrl(runId));
    esRef.current = eventSource;
    eventSource.onopen = () => {
      if (cancelled) return;
      if (poll) { clearInterval(poll); poll = undefined; }
      setEvents([]);
    };
    eventSource.onmessage = (event) => {
      let nextEvent: RunEvent;
      try {
        nextEvent = JSON.parse(event.data) as RunEvent;
      } catch {
        return;
      }
      if (cancelled) return;
      setEvents((previous) => [...previous, nextEvent]);
      if (nextEvent.type === "report_ready") {
        streamDone = true;
        getReport(runId).then((value) => { if (!cancelled) setReport(value); }).catch(() => undefined);
        getRun(runId).then((value) => { if (!cancelled) { lastStatus = value.status; setDetail(value); } }).catch(() => undefined);
      }
      if (nextEvent.type === "error") {
        streamDone = true;
        getRun(runId).then((value) => { if (!cancelled) { lastStatus = value.status; setDetail(value); } }).catch(() => undefined);
      }
    };
    eventSource.onerror = () => {
      if (cancelled) return;
      if (streamDone || isTerminal(lastStatus)) {
        eventSource.close();
        return;
      }
      refreshDetail();
      if (!poll) poll = setInterval(refreshDetail, 4000);
    };
    return () => {
      cancelled = true;
      if (poll) clearInterval(poll);
      eventSource.close();
    };
  }, [runId]);

  const findings = useMemo(
    () => events.filter((event): event is Extract<RunEvent, { type: "finding" }> => event.type === "finding"),
    [events],
  );

  const agentMessage = useMemo(() => {
    const last = [...events].reverse().find((event) => event.type === "summary");
    if (last && last.type === "summary") return last.content;
    if (detail && detail.status === "completed" && detail.final_summary) return detail.final_summary;
    return null;
  }, [events, detail]);

  const errorMessage = useMemo(() => {
    const last = [...events].reverse().find((event) => event.type === "error");
    if (last && last.type === "error") return last.message;
    if (detail && detail.status === "failed" && detail.final_summary) return detail.final_summary;
    return null;
  }, [events, detail]);

  /** The run's tool calls as the same rows the Task document paints. Live
   * events win while the stream is open; the durable `tool_calls` rows are the
   * record afterwards. */
  const toolRows = useMemo<ToolActivity[]>(() => {
    const order: string[] = [];
    const map: Record<string, ToolActivity> = {};
    for (const event of events) {
      if (event.type === "tool_call_started") {
        if (!map[event.tool_call_id]) {
          order.push(event.tool_call_id);
          map[event.tool_call_id] = { id: event.tool_call_id, tool: event.tool_name, target: "", result: "", status: "started" };
        }
      } else if (event.type === "tool_call_finished") {
        if (!map[event.tool_call_id]) order.push(event.tool_call_id);
        map[event.tool_call_id] = {
          id: event.tool_call_id,
          tool: event.tool_name,
          target: "",
          result: summarizeOutput(event.output),
          ok: event.status === "success",
          status: "completed",
        };
      }
    }
    if (order.length > 0) {
      const durationsByName: Record<string, (number | null)[]> = {};
      for (const toolCall of detail?.tool_calls ?? []) {
        (durationsByName[toolCall.tool_name] ??= []).push(toolCall.duration_ms ?? null);
      }
      const seen: Record<string, number> = {};
      return order.map((id) => {
        const row = map[id];
        const occurrence = seen[row.tool] ?? 0;
        seen[row.tool] = occurrence + 1;
        return { ...row, duration_ms: durationsByName[row.tool]?.[occurrence] ?? null };
      });
    }
    return (detail?.tool_calls ?? []).map((toolCall) => {
      let output: Record<string, unknown> | undefined;
      if (toolCall.output_json_sanitized) {
        try {
          const parsed = JSON.parse(toolCall.output_json_sanitized);
          if (parsed && typeof parsed === "object") output = parsed as Record<string, unknown>;
        } catch {
          // Sanitized output is not structured JSON; the durable record stays server-side.
        }
      }
      return {
        id: toolCall.id,
        tool: toolCall.tool_name,
        target: "",
        result: summarizeOutput(output),
        ok: toolCall.status ? toolCall.status === "success" : undefined,
        duration_ms: toolCall.duration_ms,
        status: "completed",
      };
    });
  }, [events, detail]);

  const status = detail?.status ?? "pending";
  const running = status === "running" || status === "pending";

  return (
    <article className="native-execution-doc" data-testid="execution-detail-body">
      <header className="native-execution-doc-head">
        <button type="button" className="native-ghost-action -ml-1.5" onClick={onBack}>
          <Icon name="arrowRight" size={13} className="rotate-180" />
          {copy.back}
        </button>
        {loadError ? (
          <p className="native-banner mt-3" data-tone="danger">{copy.loadFailed} {loadError}</p>
        ) : null}
        <h1>{detail?.title || detail?.run_type || copy.fallbackTitle}</h1>
        <p className="native-execution-doc-meta">
          <span className="native-execution-doc-status" data-status={status} data-testid="execution-status">
            {running ? <span className="working-mark" style={{ width: 6, height: 6 }} aria-hidden /> : null}
            {copy.statuses[status] ?? status}
          </span>
          <span>{runTypeLabel(detail?.run_type)}</span>
          <span>{detail?.bucket || "—"}</span>
          <span>{detail?.prefix || copy.root}</span>
        </p>
      </header>

      {errorMessage ? (
        <div className="native-banner" data-tone="danger" data-testid="execution-error">
          <strong>{copy.failure}</strong> {errorMessage}
        </div>
      ) : null}

      {detail?.user_prompt ? (
        <section className="native-execution-doc-block">
          <h2>{copy.direction}</h2>
          <blockquote className="native-direction">{detail.user_prompt}</blockquote>
        </section>
      ) : null}

      <section className="native-execution-doc-block" data-testid="execution-steps">
        {toolRows.length > 0 ? (
          <LiveTrace items={toolRows} streaming={running && toolRows.some((row) => row.status === "started")} />
        ) : (
          <p className="agent-empty-line">{copy.noTools}</p>
        )}
      </section>

      <section className="native-execution-doc-block">
        <h2>{copy.findings}</h2>
        {findings.length === 0 ? (
          <p className="agent-empty-line">{copy.noFindings}</p>
        ) : (
          <ul className="native-execution-doc-findings">
            {findings.map((finding, index) => (
              <li key={index} data-severity={(finding.severity || "").toLowerCase()}>
                <span className="native-execution-doc-severity">{severityLabel(finding.severity)}</span>
                <span>
                  <strong>{finding.title}</strong>
                  {finding.detail ? <span className="text-gray-500"> — {finding.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {agentMessage ? (
        <section className="native-execution-doc-block">
          <h2>{copy.result}</h2>
          <div className="agent-prose"><Markdown text={agentMessage} /></div>
        </section>
      ) : null}

      {report ? (
        <section className="native-execution-doc-block">
          <h2>{copy.report}</h2>
          <div className="agent-prose native-execution-doc-report"><Markdown text={report.content} /></div>
        </section>
      ) : null}
    </article>
  );
}
