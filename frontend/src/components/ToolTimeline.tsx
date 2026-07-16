import { useState } from "react";
import { useI18n } from "../i18n";

export interface TimelineItem {
  id: string;
  tool_name: string;
  status?: string;
  output?: Record<string, unknown>;
  duration_ms?: number | null;
}

function summarize(output?: Record<string, unknown>): string {
  if (!output) return "";
  const o = output as Record<string, unknown>;
  if (o.error_code) return `error: ${o.error_code}`;
  if (o.identity_hint) return `identity: ${o.identity_hint}`;
  if (o.report_path) return "report written";
  if (typeof o.status_code === "number") return `status ${o.status_code}`;
  if (typeof o.key_count === "number") return `key_count ${o.key_count}`;
  if (typeof o.object_count === "number") return `objects ${o.object_count}`;
  if (typeof o.total_requests === "number") return `requests ${o.total_requests}`;
  if (Array.isArray(o.findings)) return `${o.findings.length} finding(s)`;
  if (o.overall_status) return String(o.overall_status);
  return o.success === false ? "failed" : "ok";
}

function TimelineRow({ item }: { item: TimelineItem }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const finished = item.status !== undefined;
  const ok = item.status === "success";
  return (
    <li className="rounded-md border border-edge bg-canvas p-3 text-xs" data-testid="timeline-item">
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full ${
            !finished ? "bg-amber-400 animate-pulse" : ok ? "bg-emerald-400" : "bg-red-500"
          }`}
          aria-hidden
        />
        <span className="font-mono text-gray-200">{item.tool_name}</span>
        <span className={!finished ? "text-amber-400" : ok ? "text-emerald-400" : "text-red-400"}>
          {!finished ? t("tool.running") : ok ? t("tool.success") : t("tool.failed")}
        </span>
        {item.duration_ms != null && <span className="text-gray-600">{item.duration_ms} ms</span>}
        <span className="ml-auto text-gray-500">{summarize(item.output)}</span>
        {item.output && (
          <button className="ml-2 text-gray-500 hover:text-gray-300" onClick={() => setOpen((v) => !v)}>
            {open ? `▾ ${t("timeline.hideOutput")}` : `▸ ${t("timeline.showOutput")}`}
          </button>
        )}
      </div>
      {open && item.output && (
        <pre className="mt-2 max-h-64 overflow-auto rounded bg-sidebar p-2 text-[11px] text-gray-300">
          {JSON.stringify(item.output, null, 2)}
        </pre>
      )}
    </li>
  );
}

export function ToolTimeline({ items }: { items: TimelineItem[] }) {
  const { t } = useI18n();
  if (items.length === 0) {
    return <p className="text-xs text-gray-600">{t("timeline.noCalls")}</p>;
  }
  return (
    <ul className="space-y-2">
      {items.map((it) => (
        <TimelineRow key={it.id} item={it} />
      ))}
    </ul>
  );
}
