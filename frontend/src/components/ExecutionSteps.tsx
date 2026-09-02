import { useState } from "react";
import { useI18n } from "../i18n";

export interface ExecutionStep {
  id: string;
  tool_name: string;
  status?: string;
  output?: Record<string, unknown>;
  duration_ms?: number | null;
}

function summarize(output?: Record<string, unknown>): string {
  if (!output) return "";
  if (output.error_code) return `error: ${output.error_code}`;
  if (output.identity_hint) return `identity: ${output.identity_hint}`;
  if (output.report_path) return "report written";
  if (typeof output.status_code === "number") return `status ${output.status_code}`;
  if (typeof output.key_count === "number") return `key_count ${output.key_count}`;
  if (typeof output.object_count === "number") return `objects ${output.object_count}`;
  if (typeof output.total_requests === "number") return `requests ${output.total_requests}`;
  if (Array.isArray(output.findings)) return `${output.findings.length} finding(s)`;
  if (output.overall_status) return String(output.overall_status);
  return output.success === false ? "failed" : "ok";
}

function ExecutionStepRow({ step }: { step: ExecutionStep }) {
  const { lang } = useI18n();
  const [open, setOpen] = useState(false);
  const finished = step.status !== undefined;
  const ok = step.status === "success";
  const copy = lang === "zh"
    ? { running: "执行中…", success: "完成", failed: "失败", show: "查看输出", hide: "收起输出" }
    : { running: "running…", success: "complete", failed: "failed", show: "show output", hide: "hide output" };

  return (
    <li className="rounded-lg border border-edge p-3 text-xs" data-testid="execution-step">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${!finished ? "bg-warn animate-pulse" : ok ? "bg-success" : "bg-danger"}`} aria-hidden />
        <span className="font-mono text-gray-200">{step.tool_name}</span>
        <span className={!finished ? "text-warn" : ok ? "text-success" : "text-danger"}>
          {!finished ? copy.running : ok ? copy.success : copy.failed}
        </span>
        {step.duration_ms != null ? <span className="text-gray-500">{step.duration_ms} ms</span> : null}
        <span className="ml-auto text-gray-500">{summarize(step.output)}</span>
        {step.output ? (
          <button type="button" className="ml-2 text-gray-500 hover:text-gray-300" onClick={() => setOpen((value) => !value)}>
            {open ? copy.hide : copy.show}
          </button>
        ) : null}
      </div>
      {open && step.output ? (
        <pre className="mt-2 max-h-64 overflow-auto rounded bg-sidebar p-2 text-2xs text-gray-300">
          {JSON.stringify(step.output, null, 2)}
        </pre>
      ) : null}
    </li>
  );
}

export function ExecutionSteps({ steps }: { steps: ExecutionStep[] }) {
  const { lang } = useI18n();
  if (steps.length === 0) {
    return <p className="text-xs text-gray-500">{lang === "zh" ? "还没有 Tool Execution。" : "No tool execution yet."}</p>;
  }
  return (
    <ol className="space-y-2" data-testid="execution-steps">
      {steps.map((step) => <ExecutionStepRow key={step.id} step={step} />)}
    </ol>
  );
}
