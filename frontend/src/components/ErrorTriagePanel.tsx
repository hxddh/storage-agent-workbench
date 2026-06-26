import { useState } from "react";
import { submitErrorTriage } from "../api";
import type { ErrorInputKind, NextAction, TriageCase } from "../types";
import { Button, Field, Select } from "./ui";

const INPUT_KINDS: { value: ErrorInputKind; label: string }[] = [
  { value: "mixed", label: "Mixed / paste anything" },
  { value: "error_code", label: "S3 error code / XML" },
  { value: "http_response", label: "HTTP response" },
  { value: "sdk_stack_trace", label: "SDK stack trace" },
  { value: "cli_output", label: "CLI output" },
];

const CONF_COLOR: Record<string, string> = {
  high: "text-emerald-400",
  medium: "text-amber-400",
  low: "text-gray-400",
};

/**
 * Session-centered error triage. The pasted error is redacted server-side before
 * anything is stored or shown; triage performs no S3 call. Suggested next actions
 * are proposals routed through the existing Review / Prepare hand-off.
 */
export function ErrorTriagePanel({
  sessionId,
  providerId,
  primaryBucket,
  onPrepareProposal,
  onCaseCreated,
}: {
  sessionId: string;
  providerId?: string | null;
  primaryBucket?: string | null;
  onPrepareProposal: (proposal: NextAction) => void;
  onCaseCreated?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const [inputKind, setInputKind] = useState<ErrorInputKind>("mixed");
  const [plannerMode, setPlannerMode] = useState<"deterministic" | "agent">("deterministic");
  const [result, setResult] = useState<TriageCase | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!content.trim()) {
      setError("Paste an error to triage.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const c = await submitErrorTriage({
        content: content.trim(),
        input_kind: inputKind,
        session_id: sessionId,
        provider_id: providerId || undefined,
        bucket: primaryBucket || undefined,
        planner_mode: plannerMode,
      });
      setResult(c);
      onCaseCreated?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-200">Triage an error</h2>
        <button className="text-xs text-gray-500 hover:text-gray-300" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Open"}
        </button>
      </div>

      {open && (
        <div className="mt-2 rounded-md border border-edge bg-panel p-3">
          <p className="mb-2 text-[11px] text-gray-500">
            Paste an S3 error code, HTTP response, SDK stack trace, or CLI output. It is redacted before
            storage; triage is read-only and never calls your bucket.
          </p>
          <div className="mb-2 grid grid-cols-2 gap-2">
            <Field label="Input kind">
              <Select value={inputKind} onChange={(e) => setInputKind(e.target.value as ErrorInputKind)}>
                {INPUT_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>{k.label}</option>
                ))}
              </Select>
            </Field>
            <Field label="Planner mode" hint="Agent adds an interpretation over sanitized signals.">
              <Select value={plannerMode} onChange={(e) => setPlannerMode(e.target.value as "deterministic" | "agent")}>
                <option value="deterministic">Deterministic</option>
                <option value="agent">Agent</option>
              </Select>
            </Field>
          </div>
          <textarea
            className="mb-2 w-full rounded-md border border-edge bg-canvas px-3 py-2 font-mono text-[11px] text-gray-100 placeholder:text-gray-600 focus:border-gray-500 focus:outline-none"
            rows={5}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={"<Error><Code>SignatureDoesNotMatch</Code>...</Error>"}
          />
          {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
          <Button variant="primary" onClick={submit} disabled={busy}>{busy ? "Triaging…" : "Triage"}</Button>

          {result && (
            <div className="mt-4 space-y-3 text-xs">
              <div className="text-gray-300">{result.summary}</div>

              <div>
                <div className="mb-1 text-[11px] uppercase tracking-wide text-gray-500">Parsed signals</div>
                <div className="text-gray-400">
                  code: {(result.parsed.error_code as string) || "—"} · http: {(result.parsed.http_status as number) ?? "—"} ·
                  region: {(result.parsed.region as string) || "—"} · op: {(result.parsed.operation as string) || "—"}
                </div>
              </div>

              <div>
                <div className="mb-1 text-[11px] uppercase tracking-wide text-gray-500">Candidate causes</div>
                <ul className="space-y-1">
                  {result.candidate_causes.map((c, i) => (
                    <li key={i} className="rounded border border-edge bg-canvas p-2">
                      <div>
                        <span className={CONF_COLOR[c.confidence ?? "low"]}>[{c.confidence}]</span>{" "}
                        <span className="text-gray-200">{c.title}</span>
                      </div>
                      <div className="text-gray-500">{c.interpretation}</div>
                      {c.next_checks.length > 0 && (
                        <div className="mt-1 text-gray-400">Next checks: {c.next_checks.join("; ")}</div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              {result.agent_interpretation && (
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-wide text-gray-500">Agent interpretation</div>
                  <div className="rounded border border-violet-900/60 bg-violet-950/30 p-2 text-gray-300">
                    {result.agent_interpretation}
                  </div>
                </div>
              )}

              {result.safe_next_actions.length > 0 && (
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-wide text-gray-500">
                    Suggested next actions (proposals — review before starting)
                  </div>
                  <ul className="space-y-1">
                    {result.safe_next_actions.map((a, i) => (
                      <li key={i} className="flex items-center justify-between rounded border border-edge bg-canvas p-2">
                        <span className="text-gray-300">{a.title} <span className="text-gray-600">({a.action_type})</span></span>
                        <Button onClick={() => onPrepareProposal(a)}>Prepare</Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {result.limitations.length > 0 && (
                <div className="text-[11px] text-gray-600">
                  {result.limitations.map((l, i) => <div key={i}>• {l}</div>)}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
