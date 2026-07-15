import { useEffect, useMemo, useRef, useState } from "react";
import { getAccountProfile, getReport, getRun, runEventsUrl } from "../api";
import type { AccountProfile, ReportOut, RunDetail as RunDetailT, RunEvent } from "../types";
import { ToolTimeline, type TimelineItem } from "./ToolTimeline";
import { AccountProfilePanel } from "./AccountProfilePanel";
import { Markdown } from "./Markdown";
import { useI18n } from "../i18n";

const STATUS_COLOR: Record<string, string> = {
  pending: "text-gray-400",
  running: "text-amber-400",
  completed: "text-emerald-400",
  failed: "text-red-400",
  not_implemented: "text-gray-500",
};

// Localize the backend enums instead of leaking them raw ("not_implemented",
// run_type slugs, severity tokens) into user-visible text. Unknown values fall
// back to the raw string so nothing ever renders blank.
const STATUS_KEY: Record<string, string> = {
  pending: "run.queued", running: "run.running", completed: "run.done",
  failed: "run.failed", not_implemented: "run.na",
};
const SEVERITY_KEY: Record<string, string> = {
  critical: "metric.critical", error: "metric.critical", warning: "metric.warning",
  opportunity: "metric.opportunity", good: "metric.good",
  "provider unsupported": "metric.providerUnsupported",
  "access denied": "metric.accessDenied",
};

export function RunDetail({
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
  const { t } = useI18n();

  // Localized run-type / severity labels with a raw-value fallback (never
  // render an i18n key or a blank for an unknown backend value).
  const runTypeLabel = (rt?: string | null): string => {
    if (!rt) return "";
    const v = t(`runtype.${rt}`);
    return v === `runtype.${rt}` ? rt : v;
  };
  const severityLabel = (sev?: string | null): string => {
    const s = (sev || "").toLowerCase();
    return SEVERITY_KEY[s] ? t(SEVERITY_KEY[s]) : sev || "info";
  };

  useEffect(() => {
    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    const isTerminal = (s?: string) => s === "completed" || s === "failed" || s === "not_implemented";
    // Latest known status, so onerror can decide whether the run is done (and the
    // stream should be closed for good) without relying on stale closure state.
    let lastStatus: string | undefined;
    // Set synchronously when a terminal SSE event (report_ready / error) arrives.
    // The server closes the stream right after the run finishes, which fires
    // onerror — but the getRun() refresh that would set lastStatus="completed"
    // is async and may not have resolved yet, so onerror would otherwise treat
    // the close as transient and reconnect, replaying the whole buffer forever
    // (M1). This flag closes the stream for good the moment we saw the run end.
    let streamDone = false;

    setEvents([]);
    setReport(null);
    setProfile(null);
    setLoadError(null);

    // Refresh the persisted run (+ profile/report), guarded so an in-flight
    // request for an old runId can't clobber the newly-selected run's view.
    const refreshDetail = () => {
      getRun(runId)
        .then((d) => {
          if (cancelled) return;
          lastStatus = d.status;
          setDetail(d);
          if (isTerminal(d.status)) {
            if (poll) { clearInterval(poll); poll = undefined; }
            esRef.current?.close();
          }
        })
        .catch(() => undefined);
    };

    getRun(runId)
      .then((d) => {
        if (cancelled) return;  // a newer runId is now active — drop stale result
        lastStatus = d.status;
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
    // The server replays the run's whole event buffer from cursor 0 on every
    // (re)connect. Reset the local list when a connection opens so a reconnect
    // replay doesn't append duplicates (M1).
    es.onopen = () => {
      if (cancelled) return;
      // A successful (re)connect makes the fallback poll redundant — stop it so a
      // transient onerror that started polling doesn't leave it running once the
      // stream is back (F5).
      if (poll) { clearInterval(poll); poll = undefined; }
      setEvents([]);
    };
    es.onmessage = (e) => {
      let ev: RunEvent;
      try {
        ev = JSON.parse(e.data) as RunEvent;
      } catch {
        return;
      }
      if (cancelled) return;
      setEvents((prev) => [...prev, ev]);
      if (ev.type === "report_ready") {
        streamDone = true;
        getReport(runId).then((r) => { if (!cancelled) setReport(r); }).catch(() => undefined);
        getRun(runId).then((d) => { if (!cancelled) { lastStatus = d.status; setDetail(d); } }).catch(() => undefined);
        getAccountProfile(runId).then((p) => { if (!cancelled) setProfile(p); }).catch(() => undefined);
      }
      if (ev.type === "error") {
        streamDone = true;
        getRun(runId).then((d) => { if (!cancelled) { lastStatus = d.status; setDetail(d); } }).catch(() => undefined);
      }
    };
    // A transient onerror on a still-running run must NOT permanently close the
    // stream — let EventSource auto-reconnect, and start a bounded poll as a
    // fallback in case it can't. Only close for good once the run is terminal
    // (the server closes the stream when the run finishes).
    es.onerror = () => {
      if (cancelled) return;
      // Close for good if we already saw the run end — either via a terminal
      // SSE event (streamDone, set synchronously) or a refreshed terminal
      // status. This prevents the completed-run reconnect/replay loop (M1).
      if (streamDone || isTerminal(lastStatus)) {
        es.close();
        return;
      }
      // Kick a status refresh now, and poll until terminal (poll clears itself
      // and closes the stream when it observes a terminal status).
      refreshDetail();
      if (!poll) poll = setInterval(refreshDetail, 4000);
    };
    return () => {
      cancelled = true;
      if (poll) clearInterval(poll);
      es.close();
    };
  }, [runId]);

  const findings = useMemo(
    () => events.filter((e): e is Extract<RunEvent, { type: "finding" }> => e.type === "finding"),
    [events],
  );

  const agentMessage = useMemo(() => {
    const last = [...events].reverse().find((e) => e.type === "summary");
    if (last && last.type === "summary") return last.content;
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

  const metricsCards = useMemo<{ label: string; value: string }[]>(() => {
    // Bucket config review: count findings by category.
    if (detail?.run_type === "bucket_config_review") {
      const fs = events.filter((e): e is Extract<RunEvent, { type: "finding" }> => e.type === "finding");
      const byCat = (cat: string) => fs.filter((f) => f.severity === cat).length;
      return [
        { label: t("metric.critical"), value: String(byCat("Critical")) },
        { label: t("metric.warning"), value: String(byCat("Warning")) },
        { label: t("metric.opportunity"), value: String(byCat("Opportunity")) },
        { label: t("metric.providerUnsupported"), value: String(byCat("Provider unsupported")) },
        { label: t("metric.accessDenied"), value: String(fs.filter((f) => f.title.startsWith("Access denied")).length) },
        { label: t("metric.good"), value: String(byCat("Good")) },
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
        { label: t("metric.totalRequests"), value: String(o.total_requests ?? 0) },
        { label: t("metric.rate4xx"), value: pct(o.error_rate_4xx) },
        { label: t("metric.rate5xx"), value: pct(o.error_rate_5xx) },
        { label: t("metric.topStatus"), value: topStatus ? `${topStatus.value} (${topStatus.count})` : "—" },
        { label: t("metric.topMethod"), value: topMethod ? `${topMethod.value} (${topMethod.count})` : "—" },
      ];
    }
    const topPrefix = (o.prefix_distribution || [])[0];
    return [
      { label: t("metric.objects"), value: String(o.object_count ?? 0) },
      { label: t("metric.totalSize"), value: bytesH(o.total_size) },
      { label: t("metric.avgSize"), value: bytesH(o.average_object_size) },
      { label: t("metric.smallRatio"), value: pct(o.small_object_ratio) },
      { label: t("metric.topPrefix"), value: topPrefix ? `${topPrefix.value} · ${bytesH(topPrefix.size)}` : "—" },
    ];
  }, [events, detail, t]);

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
      // Mid-run the persisted tool_calls list lags the SSE list, so a raw
      // positional join attaches durations to the wrong rows. Join by (tool
      // name, per-name occurrence index) so each row picks up the duration of
      // the matching persisted call, not whatever sits at the same index (M-dur).
      const durationsByName: Record<string, (number | null)[]> = {};
      for (const tc of detail?.tool_calls ?? []) {
        (durationsByName[tc.tool_name] ??= []).push(tc.duration_ms ?? null);
      }
      const seen: Record<string, number> = {};
      return order.map((id) => {
        const item = map[id];
        const occ = seen[item.tool_name] ?? 0;
        seen[item.tool_name] = occ + 1;
        return { ...item, duration_ms: durationsByName[item.tool_name]?.[occ] ?? null };
      });
    }
    // No live SSE events (run already terminated when opened, or the stream
    // replayed nothing) → seed the timeline from the persisted tool_calls so a
    // finished/failed run still shows the tools it actually ran.
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
          ← {t("run.back")}
        </button>
        {loadError && (
          <p className="mb-2 rounded border border-red-500/40 bg-red-950/60 px-3 py-1.5 text-xs text-red-300">
            {t("run.loadFailed")} {loadError}
          </p>
        )}
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-gray-100">
            {detail?.title || detail?.run_type || t("run.fallbackTitle")}
          </h1>
          <span className={`text-sm ${STATUS_COLOR[status] ?? "text-gray-400"}`} data-testid="run-status">
            {STATUS_KEY[status] ? t(STATUS_KEY[status]) : status}
          </span>
        </div>
        <p className="text-sm text-gray-500">
          {runTypeLabel(detail?.run_type)} · {detail?.bucket || "—"} · {detail?.prefix || t("run.rootPrefix")}
        </p>
      </header>

      {errorMessage && (
        <div className="mx-8 mt-4 rounded-md border border-red-900/60 bg-red-950/40 p-3 text-xs text-red-300" data-testid="run-error">
          <span className="font-medium">{t("run.errorLabel")}</span> {errorMessage}
        </div>
      )}

      <div className="grid flex-1 grid-cols-2 gap-6 p-8">
        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-200">{t("run.userPrompt")}</h2>
          <p className="mb-6 rounded-md border border-edge bg-panel p-3 text-xs text-gray-300">
            {detail?.user_prompt || "—"}
          </p>

          {metricsCards.length > 0 && (
            <>
              <h2 className="mb-2 text-sm font-semibold text-gray-200">{t("run.metrics")}</h2>
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
              <AccountProfilePanel profile={profile} />
            </div>
          )}

          <h2 className="mb-2 text-sm font-semibold text-gray-200">{t("run.findings")}</h2>
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
                  [{severityLabel(f.severity)}]
                </span>{" "}
                <span className="text-gray-200">{f.title}</span>{" "}
                <span className="text-gray-500">— {f.detail}</span>
              </li>
            ))}
            {findings.length === 0 && <li className="text-xs text-gray-600">{t("run.noFindings")}</li>}
          </ul>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-200">{t("run.timeline")}</h2>
          <ToolTimeline items={timeline} />

          {agentMessage && (
            <div className="mt-6">
              <h2 className="mb-2 text-sm font-semibold text-gray-200">{t("run.summary")}</h2>
              <p className="rounded-md border border-edge bg-panel p-3 text-xs text-gray-300">{agentMessage}</p>
            </div>
          )}

          {report && (
            <div className="mt-6">
              <h2 className="mb-2 text-sm font-semibold text-gray-200">{t("run.reportPreview")}</h2>
              <div className="max-h-96 overflow-auto rounded-md border border-edge bg-sidebar p-3">
                <Markdown text={report.content} />
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
