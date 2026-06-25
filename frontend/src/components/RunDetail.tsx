import { useEffect, useMemo, useRef, useState } from "react";
import { getReport, getRun, runEventsUrl } from "../api";
import type { ReportOut, RunDetail as RunDetailT, RunEvent } from "../types";
import { ToolTimeline, type TimelineItem } from "./ToolTimeline";

const STATUS_COLOR: Record<string, string> = {
  pending: "text-gray-400",
  running: "text-amber-400",
  completed: "text-emerald-400",
  failed: "text-red-400",
  not_implemented: "text-gray-500",
};

export function RunDetail({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<RunDetailT | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [report, setReport] = useState<ReportOut | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    setEvents([]);
    setReport(null);
    getRun(runId).then(setDetail).catch(() => undefined);

    const es = new EventSource(runEventsUrl(runId));
    esRef.current = es;
    es.onmessage = (e) => {
      let ev: RunEvent;
      try {
        ev = JSON.parse(e.data) as RunEvent;
      } catch {
        return;
      }
      setEvents((prev) => [...prev, ev]);
      if (ev.type === "report_ready") {
        getReport(runId).then(setReport).catch(() => undefined);
        getRun(runId).then(setDetail).catch(() => undefined);
      }
      if (ev.type === "error") {
        getRun(runId).then(setDetail).catch(() => undefined);
      }
    };
    // The server closes the stream when the run is done → EventSource fires
    // onerror; close to prevent auto-reconnect.
    es.onerror = () => {
      es.close();
      getRun(runId).then(setDetail).catch(() => undefined);
    };
    return () => es.close();
  }, [runId]);

  const plan = useMemo(() => {
    const last = [...events].reverse().find((e) => e.type === "agent_plan");
    return last && last.type === "agent_plan" ? last.content.split("\n") : [];
  }, [events]);

  const findings = useMemo(
    () => events.filter((e): e is Extract<RunEvent, { type: "finding" }> => e.type === "finding"),
    [events],
  );

  const agentMessage = useMemo(() => {
    const last = [...events].reverse().find((e) => e.type === "agent_message");
    return last && last.type === "agent_message" ? last.content : null;
  }, [events]);

  const metricsCards = useMemo<{ label: string; value: string }[]>(() => {
    // Bucket config review: count findings by category.
    if (detail?.run_type === "bucket_config_review") {
      const fs = events.filter((e): e is Extract<RunEvent, { type: "finding" }> => e.type === "finding");
      const byCat = (cat: string) => fs.filter((f) => f.severity === cat).length;
      return [
        { label: "Critical", value: String(byCat("Critical")) },
        { label: "Warning", value: String(byCat("Warning")) },
        { label: "Opportunity", value: String(byCat("Opportunity")) },
        { label: "Provider unsupported", value: String(byCat("Provider unsupported")) },
        { label: "Access denied", value: String(fs.filter((f) => f.title.startsWith("Access denied")).length) },
        { label: "Good", value: String(byCat("Good")) },
      ];
    }
    const finished = [...events].reverse().find(
      (e): e is Extract<RunEvent, { type: "tool_call_finished" }> =>
        e.type === "tool_call_finished" &&
        (e.tool_name === "analyze_access_logs" || e.tool_name === "analyze_inventory"),
    );
    if (!finished) return [];
    const o = finished.output as Record<string, any>;
    const pct = (n: unknown) => `${((Number(n) || 0) * 100).toFixed(1)}%`;
    const bytesH = (n: unknown) => {
      let v = Number(n) || 0;
      const units = ["B", "KB", "MB", "GB", "TB", "PB"];
      let i = 0;
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
      return i === 0 ? `${v} B` : `${v.toFixed(1)} ${units[i]}`;
    };
    if (finished.tool_name === "analyze_access_logs") {
      const topStatus = (o.status_code_distribution || [])[0];
      const topMethod = (o.method_distribution || [])[0];
      return [
        { label: "Total requests", value: String(o.total_requests ?? 0) },
        { label: "4xx rate", value: pct(o.error_rate_4xx) },
        { label: "5xx rate", value: pct(o.error_rate_5xx) },
        { label: "Top status", value: topStatus ? `${topStatus.value} (${topStatus.count})` : "—" },
        { label: "Top method", value: topMethod ? `${topMethod.value} (${topMethod.count})` : "—" },
      ];
    }
    const topPrefix = (o.prefix_distribution || [])[0];
    return [
      { label: "Objects", value: String(o.object_count ?? 0) },
      { label: "Total size", value: bytesH(o.total_size) },
      { label: "Avg size", value: bytesH(o.average_object_size) },
      { label: "Small-object ratio", value: pct(o.small_object_ratio) },
      { label: "Top prefix (size)", value: topPrefix ? `${topPrefix.value} · ${bytesH(topPrefix.size)}` : "—" },
    ];
  }, [events, detail]);

  const timeline = useMemo<TimelineItem[]>(() => {
    const order: string[] = [];
    const map: Record<string, TimelineItem> = {};
    for (const ev of events) {
      if (ev.type === "tool_call_started") {
        if (!map[ev.tool_call_id]) {
          order.push(ev.tool_call_id);
          map[ev.tool_call_id] = { id: ev.tool_call_id, tool_name: ev.tool_name };
        }
      } else if (ev.type === "tool_call_finished") {
        map[ev.tool_call_id] = {
          ...(map[ev.tool_call_id] ?? { id: ev.tool_call_id, tool_name: ev.tool_name }),
          tool_name: ev.tool_name,
          status: ev.status,
          output: ev.output,
        };
      }
    }
    return order.map((id, i) => ({
      ...map[id],
      duration_ms: detail?.tool_calls[i]?.duration_ms ?? null,
    }));
  }, [events, detail]);

  const status = detail?.status ?? "pending";

  return (
    <div className="flex flex-1 flex-col overflow-auto bg-canvas">
      <header className="border-b border-edge px-8 py-4">
        <button className="mb-2 text-xs text-gray-500 hover:text-gray-300" onClick={onBack}>
          ← Back to runs
        </button>
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-gray-100">
            {detail?.title || detail?.run_type || "Run"}
          </h1>
          <span className={`text-sm ${STATUS_COLOR[status] ?? "text-gray-400"}`} data-testid="run-status">
            {status}
          </span>
        </div>
        <p className="text-sm text-gray-500">
          {detail?.run_type} · {detail?.bucket || "—"} · {detail?.prefix || "(root)"}
        </p>
      </header>

      <div className="grid flex-1 grid-cols-2 gap-6 p-8">
        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-200">User prompt</h2>
          <p className="mb-6 rounded-md border border-edge bg-panel p-3 text-xs text-gray-300">
            {detail?.user_prompt || "—"}
          </p>

          <h2 className="mb-2 text-sm font-semibold text-gray-200">Agent plan</h2>
          {plan.length ? (
            <ol className="mb-6 list-inside list-decimal space-y-1 text-xs text-gray-400">
              {plan.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          ) : (
            <p className="mb-6 text-xs text-gray-600">Waiting for plan…</p>
          )}

          {metricsCards.length > 0 && (
            <>
              <h2 className="mb-2 text-sm font-semibold text-gray-200">Metrics</h2>
              <div className="mb-6 grid grid-cols-2 gap-2" data-testid="metrics-cards">
                {metricsCards.map((c) => (
                  <div key={c.label} className="rounded-md border border-edge bg-panel p-3">
                    <div className="text-[11px] text-gray-500">{c.label}</div>
                    <div className="text-sm font-medium text-gray-100">{c.value}</div>
                  </div>
                ))}
              </div>
            </>
          )}

          <h2 className="mb-2 text-sm font-semibold text-gray-200">Findings</h2>
          <ul className="space-y-1">
            {findings.map((f, i) => (
              <li key={i} className="text-xs">
                <span
                  className={
                    f.severity === "error"
                      ? "text-red-400"
                      : f.severity === "warning"
                        ? "text-amber-400"
                        : "text-emerald-400"
                  }
                >
                  [{f.severity}]
                </span>{" "}
                <span className="text-gray-200">{f.title}</span>{" "}
                <span className="text-gray-500">— {f.detail}</span>
              </li>
            ))}
            {findings.length === 0 && <li className="text-xs text-gray-600">No findings yet.</li>}
          </ul>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-200">Tool / Analysis Timeline</h2>
          <ToolTimeline items={timeline} />

          {agentMessage && (
            <div className="mt-6">
              <h2 className="mb-2 text-sm font-semibold text-gray-200">Summary</h2>
              <p className="rounded-md border border-edge bg-panel p-3 text-xs text-gray-300">{agentMessage}</p>
            </div>
          )}

          {report && (
            <div className="mt-6">
              <h2 className="mb-2 text-sm font-semibold text-gray-200">Report preview</h2>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-edge bg-sidebar p-3 text-[11px] text-gray-300">
                {report.content}
              </pre>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
