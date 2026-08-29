import { useEffect, useMemo, useRef, useState } from "react";
import { getAccountProfile, getReport, getRun, runEventsUrl } from "../api";
import type { AccountProfile, ReportOut, RunDetail as RunDetailT, RunEvent } from "../types";
import { ExecutionSteps, type ExecutionStep } from "./ExecutionSteps";
import { AccountProfilePanel } from "./AccountProfilePanel";
import { Markdown } from "./Markdown";
import { useI18n } from "../i18n";
import { fmtBytes } from "../lib/format";

const STATUS_COLOR: Record<string, string> = {
  pending: "text-gray-400",
  running: "text-warn",
  completed: "text-success",
  failed: "text-danger",
  not_implemented: "text-gray-500",
};

const SEVERITY_KEY: Record<string, string> = {
  critical: "metric.critical", error: "metric.critical", warning: "metric.warning",
  opportunity: "metric.opportunity", good: "metric.good",
  "provider unsupported": "metric.providerUnsupported",
  "access denied": "metric.accessDenied",
};

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
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const { t, lang } = useI18n();
  const copy = lang === "zh"
    ? {
        back: "返回 Review",
        loadFailed: "无法加载这次 Execution：",
        failure: "Execution 失败：",
        fallbackTitle: "Agent Execution",
        direction: "Direction",
        metrics: "Metrics",
        findings: "Findings",
        noFindings: "还没有 Findings。",
        steps: "Execution Steps",
        result: "Execution Result",
        report: "Report Artifact",
        root: "（根）",
        statuses: { pending: "等待中", running: "执行中", completed: "完成", failed: "失败", not_implemented: "不可用" } as Record<string, string>,
      }
    : {
        back: "Back to Review",
        loadFailed: "Couldn't load this execution:",
        failure: "Execution failed:",
        fallbackTitle: "Agent execution",
        direction: "Direction",
        metrics: "Metrics",
        findings: "Findings",
        noFindings: "No findings yet.",
        steps: "Execution steps",
        result: "Execution result",
        report: "Report artifact",
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
    setProfile(null);
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
        if (next.run_type === "account_discovery") {
          getAccountProfile(runId).then((value) => { if (!cancelled) setProfile(value); }).catch(() => undefined);
        }
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
        getAccountProfile(runId).then((value) => { if (!cancelled) setProfile(value); }).catch(() => undefined);
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

  const metricsCards = useMemo<{ label: string; value: string }[]>(() => {
    if (detail?.run_type === "bucket_config_review") {
      const allFindings = events.filter((event): event is Extract<RunEvent, { type: "finding" }> => event.type === "finding");
      const byCategory = (category: string) => allFindings.filter((finding) => finding.severity === category).length;
      return [
        { label: t("metric.critical"), value: String(byCategory("Critical")) },
        { label: t("metric.warning"), value: String(byCategory("Warning")) },
        { label: t("metric.opportunity"), value: String(byCategory("Opportunity")) },
        { label: t("metric.providerUnsupported"), value: String(byCategory("Provider unsupported")) },
        { label: t("metric.accessDenied"), value: String(allFindings.filter((finding) => finding.title.startsWith("Access denied")).length) },
        { label: t("metric.good"), value: String(byCategory("Good")) },
      ];
    }
    const finished = [...events].reverse().find(
      (event): event is Extract<RunEvent, { type: "tool_call_finished" }> =>
        event.type === "tool_call_finished" &&
        (event.tool_name === "analyze_access_logs" || event.tool_name === "analyze_inventory"),
    );
    if (!finished) return [];
    const output = finished.output as Record<string, any>;
    const percentage = (value: unknown) => `${((Number(value) || 0) * 100).toFixed(1)}%`;
    const bytes = (value: unknown) => fmtBytes(Number(value) || 0) ?? "0 B";
    if (finished.tool_name === "analyze_access_logs") {
      const topStatus = (output.status_code_distribution || [])[0];
      const topMethod = (output.method_distribution || [])[0];
      return [
        { label: t("metric.totalRequests"), value: String(output.total_requests ?? 0) },
        { label: t("metric.rate4xx"), value: percentage(output.error_rate_4xx) },
        { label: t("metric.rate5xx"), value: percentage(output.error_rate_5xx) },
        { label: t("metric.topStatus"), value: topStatus ? `${topStatus.value} (${topStatus.count})` : "—" },
        { label: t("metric.topMethod"), value: topMethod ? `${topMethod.value} (${topMethod.count})` : "—" },
      ];
    }
    const topPrefix = (output.prefix_distribution || [])[0];
    return [
      { label: t("metric.objects"), value: String(output.object_count ?? 0) },
      { label: t("metric.totalSize"), value: bytes(output.total_size) },
      { label: t("metric.avgSize"), value: bytes(output.average_object_size) },
      { label: t("metric.smallRatio"), value: percentage(output.small_object_ratio) },
      { label: t("metric.topPrefix"), value: topPrefix ? `${topPrefix.value} · ${bytes(topPrefix.size)}` : "—" },
    ];
  }, [events, detail, t]);

  const executionSteps = useMemo<ExecutionStep[]>(() => {
    const order: string[] = [];
    const map: Record<string, ExecutionStep> = {};
    for (const event of events) {
      if (event.type === "tool_call_started") {
        if (!map[event.tool_call_id]) {
          order.push(event.tool_call_id);
          map[event.tool_call_id] = { id: event.tool_call_id, tool_name: event.tool_name };
        }
      } else if (event.type === "tool_call_finished") {
        map[event.tool_call_id] = {
          ...(map[event.tool_call_id] ?? { id: event.tool_call_id, tool_name: event.tool_name }),
          tool_name: event.tool_name,
          status: event.status,
          output: event.output,
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
        const step = map[id];
        const occurrence = seen[step.tool_name] ?? 0;
        seen[step.tool_name] = occurrence + 1;
        return { ...step, duration_ms: durationsByName[step.tool_name]?.[occurrence] ?? null };
      });
    }
    return (detail?.tool_calls ?? []).map((toolCall) => {
      let output: Record<string, unknown> | undefined;
      if (toolCall.output_json_sanitized) {
        try {
          const parsed = JSON.parse(toolCall.output_json_sanitized);
          if (parsed && typeof parsed === "object") output = parsed as Record<string, unknown>;
        } catch {
          // Sanitized output is not structured JSON; the raw execution record remains durable server-side.
        }
      }
      return {
        id: toolCall.id,
        tool_name: toolCall.tool_name,
        status: toolCall.status ?? undefined,
        output,
        duration_ms: toolCall.duration_ms,
      };
    });
  }, [events, detail]);

  const status = detail?.status ?? "pending";

  return (
    <div className="flex flex-1 flex-col overflow-auto bg-canvas" data-testid="execution-detail-body">
      <header className="border-b border-edge px-8 py-4">
        <button className="mb-2 text-xs text-gray-500 hover:text-gray-300" onClick={onBack}>
          ← {copy.back}
        </button>
        {loadError ? (
          <p className="mb-2 rounded border border-danger-border bg-danger-bg px-3 py-1.5 text-xs text-danger">
            {copy.loadFailed} {loadError}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-gray-100">
            {detail?.title || detail?.run_type || copy.fallbackTitle}
          </h1>
          <span className={`text-sm ${STATUS_COLOR[status] ?? "text-gray-400"}`} data-testid="execution-status">
            {copy.statuses[status] ?? status}
          </span>
        </div>
        <p className="text-sm text-gray-500">
          {runTypeLabel(detail?.run_type)} · {detail?.bucket || "—"} · {detail?.prefix || copy.root}
        </p>
      </header>

      {errorMessage ? (
        <div className="mx-8 mt-4 rounded-md border border-danger-border bg-danger-bg p-3 text-xs text-danger" data-testid="execution-error">
          <span className="font-medium">{copy.failure}</span> {errorMessage}
        </div>
      ) : null}

      <div className="grid flex-1 grid-cols-2 gap-6 p-8">
        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-200">{copy.direction}</h2>
          <p className="mb-6 rounded-md border border-edge bg-panel p-3 text-xs text-gray-300">
            {detail?.user_prompt || "—"}
          </p>

          {metricsCards.length > 0 ? (
            <>
              <h2 className="mb-2 text-sm font-semibold text-gray-200">{copy.metrics}</h2>
              <div className="mb-6 grid grid-cols-2 gap-2" data-testid="metrics-cards">
                {metricsCards.map((card) => (
                  <div key={card.label} className="rounded-md border border-edge bg-panel p-3">
                    <div className="text-2xs text-gray-500">{card.label}</div>
                    <div className="text-sm font-medium text-gray-100">{card.value}</div>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {detail?.run_type === "account_discovery" && profile ? (
            <div className="mb-6">
              <AccountProfilePanel profile={profile} />
            </div>
          ) : null}

          <h2 className="mb-2 text-sm font-semibold text-gray-200">{copy.findings}</h2>
          <ul className="space-y-1">
            {findings.map((finding, index) => (
              <li key={index} className="text-xs">
                <span className={finding.severity === "error" ? "text-danger" : finding.severity === "warning" ? "text-warn" : "text-success"}>
                  [{severityLabel(finding.severity)}]
                </span>{" "}
                <span className="text-gray-200">{finding.title}</span>{" "}
                <span className="text-gray-500">— {finding.detail}</span>
              </li>
            ))}
            {findings.length === 0 ? <li className="text-xs text-gray-500">{copy.noFindings}</li> : null}
          </ul>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-200">{copy.steps}</h2>
          <ExecutionSteps steps={executionSteps} />

          {agentMessage ? (
            <div className="mt-6">
              <h2 className="mb-2 text-sm font-semibold text-gray-200">{copy.result}</h2>
              <p className="rounded-md border border-edge bg-panel p-3 text-xs text-gray-300">{agentMessage}</p>
            </div>
          ) : null}

          {report ? (
            <div className="mt-6">
              <h2 className="mb-2 text-sm font-semibold text-gray-200">{copy.report}</h2>
              <div className="max-h-96 overflow-auto rounded-md border border-edge bg-sidebar p-3">
                <Markdown text={report.content} />
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
