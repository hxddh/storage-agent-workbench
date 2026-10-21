import { useState } from "react";
import type { FixFormat, Impact } from "../api/types";
import { Icon } from "../components/icons";
import { StatusDot } from "../components/ui";
import { useCopy } from "../hooks/useCopy";
import { useI18n } from "../i18n";

/**
 * Deterministic result views. The window renders what a tool actually
 * returned (`tool_output.detail`); the model interprets it instead of
 * retyping a table. Unknown or truncated shapes stay a visible gap — never a
 * partial table that looks complete.
 */

type Json = Record<string, unknown>;

export type SurveyIssue = { code?: string; title?: string; severity?: string; buckets?: number; names?: string[] };

export type ToolView =
  | { kind: "survey"; issues: SurveyIssue[]; columns: string[]; common: Json; rows: unknown[][]; omitted: number;
      coverage: Json }
  | { kind: "estate"; buckets: Json[]; issues: Json[]; notes: Json[] }
  | { kind: "buckets"; rows: Json[] }
  | { kind: "config"; bucket: string; sections: Json; findings: Json[] }
  | { kind: "fix"; issue: string; bucket: string; fixable: boolean; formats: FixFormat[]; impact: Impact | null;
      notes: string[]; note: string };

function obj(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function objects(value: unknown): Json[] {
  return arr(value).filter((v): v is Json => !!obj(v));
}

export function viewFor(row: { name: string; detail: string | null; detailTruncated: boolean }): ToolView | null {
  if (!row.detail || row.detailTruncated) return null;
  let doc: Json | null = null;
  try {
    doc = obj(JSON.parse(row.detail));
  } catch {
    return null;
  }
  if (!doc) return null;
  if (row.name === "survey_account" && obj(doc.buckets)) {
    const table = obj(doc.buckets) as Json;
    const columns = arr(table.columns).filter((c): c is string => typeof c === "string");
    const rows = arr(table.rows).filter((r): r is unknown[] => Array.isArray(r));
    if (!columns.length) return null;
    return { kind: "survey", issues: objects(doc.issues) as SurveyIssue[], columns, common: obj(table.common) ?? {},
      rows, omitted: Number(table.rows_omitted ?? 0), coverage: obj(doc.coverage) ?? {} };
  }
  if (row.name === "fix_preview" && (Array.isArray(doc.formats) || doc.fixable === false)) {
    const formats = objects(doc.formats).filter((f) => typeof f.text === "string" && typeof f.format === "string") as FixFormat[];
    return { kind: "fix", issue: String(doc.issue ?? ""), bucket: String(doc.bucket ?? ""), fixable: doc.fixable !== false,
      formats, impact: obj(doc.impact) as Impact | null, notes: arr(doc.notes).filter((n): n is string => typeof n === "string"),
      note: String(doc.note ?? "") };
  }
  if (row.name === "query_estate" && Array.isArray(doc.buckets) && Array.isArray(doc.issues)) {
    return { kind: "estate", buckets: objects(doc.buckets), issues: objects(doc.issues), notes: objects(doc.notes) };
  }
  if (row.name === "list_buckets" && Array.isArray(doc.buckets)) {
    return { kind: "buckets", rows: objects(doc.buckets) };
  }
  if (row.name === "review_bucket_config" && (obj(doc.sections) || Array.isArray(doc.findings))) {
    return { kind: "config", bucket: String(doc.bucket ?? ""), sections: obj(doc.sections) ?? {},
      findings: objects(doc.findings) };
  }
  return null;
}

function humanize(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (value === true) return "Yes";
  if (value === false) return "No";
  return String(value).replace(/_/g, " ").replace(/\s*,\s*/g, " · ");
}

function Table({ columns, common, rows, omitted }: { columns: string[]; common: Json; rows: unknown[][]; omitted: number }) {
  const { t } = useI18n();
  const { copied, copy } = useCopy();
  const head = columns.slice(0, 9);
  const cut = columns.length - head.length;
  const tsv = [head.join("\t"), ...rows.map((r) => head.map((_, i) => String(r[i] ?? "")).join("\t"))].join("\n");
  return (
    <div className="result-table-wrap">
      <div className="result-table-head">
        <span className="result-table-label">{t("result.table")}</span>
        <button type="button" className="link result-copy" onClick={() => copy(tsv)}>
          <Icon name={copied ? "check" : "copy"} size={13} />{copied ? t("common.copied") : t("common.copy")}
        </button>
      </div>
      <table className="result-table" data-testid="tool-table">
        <thead><tr>{head.map((c) => <th key={c}>{label(c, t)}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{head.map((_, j) => <td key={j} data-num={typeof r[j] === "number" ? "true" : undefined}>{humanize(r[j])}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {Object.keys(common).length ? (
        <p className="result-note">{t("result.common", { text: Object.entries(common).slice(0, 4).map(([k, v]) => `${label(k, t)} ${humanize(v)}`).join(" · ") })}</p>
      ) : null}
      {omitted > 0 ? <p className="result-note">{t("result.omitted", { n: omitted })}</p> : null}
      {cut > 0 ? <p className="result-note">{t("result.moreColumns", { n: cut })}</p> : null}
    </div>
  );
}

function label(column: string, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (column === "bucket") return t("result.bucket");
  const known = t(`posture.${column}`);
  if (known !== `posture.${column}`) return known;
  const word = column.replace(/_/g, " ");
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function Coverage({ coverage }: { coverage: Json }) {
  const { t } = useI18n();
  const surveyed = Number(coverage.surveyed ?? 0);
  if (!surveyed) return null;
  const bits = [t("result.coverage", { n: surveyed })];
  if (coverage.unreadable) bits.push(t("result.unreadable", { n: Number(coverage.unreadable) }));
  if (coverage.truncated) bits.push(t("result.truncated"));
  return <p className="result-note">{bits.join(" · ")}</p>;
}

function Issues({ issues }: { issues: SurveyIssue[] }) {
  const { t } = useI18n();
  if (!issues.length) return null;
  return (
    <ul className="result-issues">
      {issues.slice(0, 8).map((i, n) => (
        <li key={`${i.code ?? n}`}>
          <StatusDot tone={i.severity === "high" ? "danger" : i.severity === "medium" ? "warn" : "neutral"} />
          <span>{i.title ?? i.code ?? "Issue"}</span>
          {i.buckets ? <span className="result-meta">{t("result.bucketCount", { n: Number(i.buckets) })}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function ResultView({ row }: { row: { name: string; detail: string | null; detailTruncated: boolean } }) {
  const { t } = useI18n();
  const [format, setFormat] = useState(0);
  if (row.detailTruncated) return <p className="quiet-note result-gap">{t("result.truncatedGap")}</p>;
  const view = viewFor(row);
  if (!view) return null;
  if (view.kind === "survey") {
    return (
      <div className="tool-result" data-kind="survey" data-testid="tool-result">
        <Issues issues={view.issues} />
        <Table columns={view.columns} common={view.common} rows={view.rows} omitted={view.omitted} />
        <Coverage coverage={view.coverage} />
      </div>
    );
  }
  if (view.kind === "estate") {
    return (
      <div className="tool-result" data-kind="estate" data-testid="tool-result">
        {view.buckets.length ? (
          <div className="result-chips">
            {view.buckets.slice(0, 30).map((b, i) => <span key={i} className="result-chip">{String(b.bucket ?? b.name ?? "—")}</span>)}
            {view.buckets.length > 30 ? <span className="result-meta">+{view.buckets.length - 30}</span> : null}
          </div>
        ) : null}
        <Issues issues={view.issues as SurveyIssue[]} />
        {view.notes.length ? (
          <ul className="result-notes">
            {view.notes.slice(0, 6).map((n, i) => <li key={i}>{String(n.text ?? "")}</li>)}
          </ul>
        ) : null}
      </div>
    );
  }
  if (view.kind === "buckets") {
    return (
      <div className="tool-result" data-kind="buckets" data-testid="tool-result">
        <div className="result-chips">
          {view.rows.slice(0, 40).map((b, i) => <span key={i} className="result-chip">{String(b.name ?? b.bucket ?? "—")}</span>)}
        </div>
      </div>
    );
  }
  if (view.kind === "config") {
    return (
      <div className="tool-result" data-kind="config" data-testid="tool-result">
        <Issues issues={view.findings.map((f) => ({ title: String(f.title ?? ""), severity: String(f.severity ?? "") }))} />
        <div className="result-chips">
          {Object.keys(view.sections).map((s) => <span key={s} className="result-chip">{s.replace(/_/g, " ")}</span>)}
        </div>
      </div>
    );
  }
  return (
    <div className="tool-result" data-kind="fix" data-testid="tool-result">
      {view.fixable && view.formats.length ? (
        <>
          <div className="result-tabs" role="tablist" aria-label={t("result.formats")}>
            {view.formats.map((f, i) => (
              <button key={f.format} type="button" role="tab" aria-selected={i === format}
                onClick={() => setFormat(i)}>{f.label || f.format}</button>
            ))}
          </div>
          <pre className="result-code">{view.formats[Math.min(format, view.formats.length - 1)].text}</pre>
        </>
      ) : <p className="quiet-note">{view.note || t("issue.noFix")}</p>}
      {view.impact ? <p className="result-impact" data-verdict={view.impact.verdict}>{t(`impact.${view.impact.verdict}`)}</p> : null}
      {view.notes.length ? <p className="result-note">{view.notes.join(" · ")}</p> : null}
    </div>
  );
}
