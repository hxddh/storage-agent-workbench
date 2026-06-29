import { useEffect, useMemo, useRef, useState } from "react";
import { getAccountProfile, getReport, getRun, runEventsUrl } from "../api";
import type { AccountProfile, ReportOut, RunDetail as RunDetailT, RunEvent } from "../types";
import { ToolTimeline, type TimelineItem } from "./ToolTimeline";
import { AccountProfilePanel } from "./AccountProfilePanel";

const STATUS_COLOR: Record<string, string> = {
  pending: "text-gray-400",
  running: "text-amber-400",
  completed: "text-emerald-400",
  failed: "text-red-400",
  not_implemented: "text-gray-500",
};

export function RunDetail({
  runId,
  onBack,
  onOpenRun,
}: {
  runId: string;
  onBack: () => void;
  onOpenRun?: (runId: string) => void;
}) {
  const [detail, setDetail] = useState<RunDetailT | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [report, setReport] = useState<ReportOut | null>(null);
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEvents([]);
    setReport(null);
    setProfile(null);
    setLoadError(null);
    getRun(runId)
      .then((d) => {
        if (cancelled) return;  // a newer runId is now active — drop stale result
        setDetail(d);
        // Opening an already-finished account_discovery run: no SSE will replay,
        // so fetch the persisted profile directly.
        if (d.run_type === "account_discovery") {
          getAccountProfile(runId).then((p) => { if (!cancelled) setProfile(p); }).catch(() => undefined);
        }
        // Terminal run with a written report: fetch it now (the report_ready SSE
        // event won't replay for a run that finished before we opened it).
        if ((d.status === "completed" || d.status === "failed") && d.report_path) {
          getReport(runId).then((r) => { if (!cancelled) setReport(r); }).catch(() => undefined);
        }
      })
      .catch((e) => { if (!cancelled) setLoadError(String(e)); });

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
        getAccountProfile(runId).then(setProfile).catch(() => undefined);
      }
      if (ev.type === "error") {
        getRun(runId).then(setDetail).catch(() => undefined);
      }
    };
    // The server closes the stream when the run is done → EventSource fires
    // onerror; close to prevent auto-reconnect.
    es.onerror = () => {
      es.close();
      getRun(runId).then((d) => { if (!cancelled) setDetail(d); }).catch(() => undefined);
    };
    return () => { cancelled = true; es.close(); };
  }, [runId]);

  const plan = useMemo(() => {
    const last = [...events].reverse().find((e) => e.type === "plan");
    return last && last.type === "plan" ? last.content.split("\n") : [];
  }, [events]);

  const findings = useMemo(
    () => events.filter((e): e is Extract<RunEvent, { type: "finding" }> => e.type === "finding"),
    [events],
  );

  const agentMessage = useMemo(() => {
    const last = [...events].reverse().find((e) => e.type === "summary" || e.type === "final_summary");
    if (last && (last.type === "summary" || last.type === "final_summary")) return last.content;
    // Terminal run opened fresh (no SSE replay): fall back to the persisted
    // summary so a completed run isn't shown without its conclusion.
    if (detail && detail.status === "completed" && detail.final_summary) return detail.final_summary;
    return null;
  }, [events, detail]);

  const errorMessage = useMemo(() => {
    const last = [...events].reverse().find((e) => e.type === "error");
    if (last && last.type === "error") return last.message;
    // Failed run opened fresh: the failure reason is persisted in final_summary.
    if (detail && detail.status === "failed" && detail.final_summary) return detail.final_summary;
    return null;
  }, [events, detail]);

  const agentActivity = useMemo(
    () =>
      events.filter(
        (e): e is Extract<RunEvent, { type: "tool_selected" | "guardrail_passed" | "guardrail_blocked" }> =>
          e.type === "tool_selected" || e.type === "guardrail_passed" || e.type === "guardrail_blocked",
      ),
    [events],
  );

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
    if (order.length > 0) {
      return order.map((id, i) => ({
        ...map[id],
        duration_ms: detail?.tool_calls[i]?.duration_ms ?? null,
      }));
    }
    // No live SSE events (run already terminated when opened, or the stream
    // replayed nothing) → seed the timeline from the persisted tool_calls so a
    // finished/failed run still shows what it actually did instead of an empty
    // "Waiting for plan…" placeholder.
    return (detail?.tool_calls ?? []).map((tc) => {
      let output: Record<string, unknown> | undefined;
      if (tc.output_json_sanitized) {
        try {
          const parsed = JSON.parse(tc.output_json_sanitized);
          if (parsed && typeof parsed === "object") output = parsed as Record<string, unknown>;
        } catch {
          // sanitized output isn't JSON — leave it out of the structured summary
        }
      }
      return {
        id: tc.id,
        tool_name: tc.tool_name,
        status: tc.status ?? undefined,
        output,
        duration_ms: tc.duration_ms,
      };
    });
  }, [events, detail]);

  const status = detail?.status ?? "pending";

  return (
    <div className="flex flex-1 flex-col overflow-auto bg-canvas">
      <header className="border-b border-edge px-8 py-4">
        <button className="mb-2 text-xs text-gray-500 hover:text-gray-300" onClick={onBack}>
          ← Back to runs
        </button>
        {loadError && (
          <p className="mb-2 rounded border border-red-500/40 bg-red-950/60 px-3 py-1.5 text-xs text-red-300">
            Couldn’t load this run: {loadError}
          </p>
        )}
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
          {detail?.planner_mode && (
            <span
              className={`ml-2 rounded-full border px-2 py-0.5 text-[11px] ${
                detail.planner_mode === "agent"
                  ? "border-violet-700 text-violet-300"
                  : "border-edge text-gray-400"
              }`}
            >
              planner: {detail.planner_mode}
            </span>
          )}
        </p>
      </header>

      {errorMessage && (
        <div className="mx-8 mt-4 rounded-md border border-red-900/60 bg-red-950/40 p-3 text-xs text-red-300" data-testid="run-error">
          <span className="font-medium">Run error:</span> {errorMessage}
        </div>
      )}

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
            <p className="mb-6 text-xs text-gray-600">
              {status === "completed" || status === "failed" || status === "not_implemented"
                ? "This run recorded no explicit plan."
                : "Waiting for plan…"}
            </p>
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

          {detail?.run_type === "account_discovery" && profile && (
            <div className="mb-6">
              <AccountProfilePanel profile={profile} onOpenRun={onOpenRun} />
            </div>
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
          {detail?.planner_mode === "agent" && (
            <div className="mb-6">
              <h2 className="mb-2 text-sm font-semibold text-gray-200">Agent activity</h2>
              <ul className="space-y-1">
                {agentActivity.map((e, i) => (
                  <li key={i} className="text-xs">
                    {e.type === "tool_selected" && (
                      <span className="text-violet-300">
                        ▸ selected <span className="font-mono">{e.tool_name}</span>
                        {e.reason ? <span className="text-gray-500"> — {e.reason}</span> : null}
                      </span>
                    )}
                    {e.type === "guardrail_passed" && (
                      <span className="text-emerald-400">✓ guardrail {e.name}</span>
                    )}
                    {e.type === "guardrail_blocked" && (
                      <span className="text-red-400">✗ guardrail {e.name} — {e.message}</span>
                    )}
                  </li>
                ))}
                {agentActivity.length === 0 && <li className="text-xs text-gray-600">No agent activity yet.</li>}
              </ul>
            </div>
          )}

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
