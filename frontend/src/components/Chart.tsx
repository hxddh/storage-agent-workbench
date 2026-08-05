import { useI18n } from "../i18n";

/**
 * Charts for the tables the agent already writes.
 *
 * The aggregate tools return a metric, a group-by and a value per group, and the
 * agent renders that as a markdown table — "capacity by prefix", "errors per
 * hour", "objects by storage class". A column of numbers answers "what is the
 * value for X"; it does not answer "which one is the problem", which is the
 * actual question. A bar does that at a glance.
 *
 * Three rules keep this honest:
 *
 *  - The chart is DERIVED from the rendered table, never from a second source.
 *    Nothing new is sent to the model and no raw row is exposed; if the numbers
 *    on screen are wrong the chart is wrong in exactly the same way.
 *  - The table stays, below the chart, unchanged. A bar communicates ratio, not
 *    magnitude — the precise value has to remain readable.
 *  - When the shape is not confidently chartable, no chart is drawn. A chart of
 *    something that is not a measure is worse than a plain table.
 *
 * Drawn with layout boxes rather than SVG: bars are rectangles, and CSS gives
 * responsive widths, text truncation and theme colours for free — an SVG would
 * have to re-solve all three.
 */

export type ChartKind = "bar" | "column";
export type ChartPoint = { label: string; value: number; raw: string };
export type ChartSpec = {
  kind: ChartKind;
  label: string;
  measure: string;
  points: ChartPoint[];
};

/** Rows beyond this stop being a chart and start being a texture. */
const MAX_POINTS = 40;
const MIN_POINTS = 2;

/** Timestamps and hour buckets read left-to-right as a sequence; anything else
 * is a set of categories and gets ranked bars. */
const TEMPORAL = /^(?:\d{4}-\d{2}(?:-\d{2})?(?:[T ]\d{2}(?::\d{2})?)?|\d{4}\/\d{2}\/\d{2}|\d{1,2}:\d{2})$/;

/** Parse a table cell as a measure. Accepts plain and comma-grouped numbers and
 * percentages; rejects anything carrying a unit, because a column mixing "4 GB"
 * and "900 MB" would draw bars that lie about the ratio. */
export function parseMeasure(cell: string): number | null {
  const s = (cell ?? "").trim().replace(/^\*\*|\*\*$/g, "");
  if (!/^-?[\d,]+(?:\.\d+)?\s*%?$/.test(s)) return null;
  const n = Number(s.replace(/[,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Decide whether a parsed table is a measure-by-category shape, and which
 * column is which. Returns `null` — meaning "just render the table" — for
 * anything ambiguous.
 */
export function chartSpec(headers: string[], rows: string[][]): ChartSpec | null {
  if (headers.length < 2) return null;
  const body = rows.filter((r) => r.length >= 2 && (r[0] ?? "").trim() !== "");
  if (body.length < MIN_POINTS || body.length > MAX_POINTS) return null;

  // First column that parses as a measure in EVERY row. A column with one
  // "Provider unsupported" or "n/a" cell is not a measure — it is a report.
  let col = -1;
  for (let c = 1; c < headers.length; c++) {
    if (body.every((r) => parseMeasure(r[c] ?? "") !== null)) {
      col = c;
      break;
    }
  }
  if (col < 0) return null;

  const values = body.map((r) => parseMeasure(r[col])!);
  // Negative measures need a signed baseline to be read correctly; until that
  // exists, refuse rather than draw a bar that implies magnitude only.
  if (values.some((v) => v < 0)) return null;
  if (values.every((v) => v === 0)) return null;

  const labels = body.map((r) => stripInline(r[0]));
  // A label column that is itself numeric is usually an id, not a category.
  if (labels.every((l) => parseMeasure(l) !== null) && !labels.every((l) => TEMPORAL.test(l))) {
    return null;
  }

  const temporal = labels.length >= 4 && labels.every((l) => TEMPORAL.test(l));
  return {
    kind: temporal ? "column" : "bar",
    label: stripInline(headers[0]) || "",
    measure: stripInline(headers[col]) || "",
    points: body.map((r, i) => ({ label: labels[i], value: values[i], raw: stripInline(r[col]) })),
  };
}

/** Cell text can carry inline markdown; a chart axis wants the words. */
function stripInline(s: string): string {
  return (s ?? "").replace(/[*`_~]/g, "").trim();
}

/** Compact enough to sit inside a bar row without wrapping. */
function fmt(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function Chart({ spec }: { spec: ChartSpec }) {
  const { t } = useI18n();
  const max = Math.max(...spec.points.map((p) => p.value));
  const peak = spec.points.reduce((a, b) => (b.value > a.value ? b : a));
  const caption = t("chart.caption", { measure: spec.measure || "value", label: spec.label || "group" });
  const summary = t("chart.summary", { label: peak.label, value: peak.raw, measure: spec.measure || "value" });

  return (
    <div
      data-testid="table-chart"
      data-chart-kind={spec.kind}
      role="img"
      aria-label={`${caption}. ${summary}`}
      className="border-b border-edge bg-elevated/40 px-3.5 py-3"
    >
      <div className="mb-2 flex items-baseline gap-2 text-[10.5px] uppercase tracking-wide text-gray-500">
        <span>{caption}</span>
      </div>
      {spec.kind === "bar" ? (
        <div className="space-y-1">
          {spec.points.map((p, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-2.5">
              <span className="truncate text-[11.5px] text-gray-400" title={p.label}>
                {p.label}
              </span>
              <div className="h-[7px] overflow-hidden rounded-full bg-edge">
                <div
                  data-testid="chart-bar"
                  className={`h-full rounded-full transition-[width] duration-500 ${
                    p === peak ? "bg-accent" : "bg-accent/45"
                  }`}
                  style={{ width: `${max > 0 ? Math.max((p.value / max) * 100, 1.5) : 0}%` }}
                />
              </div>
              <span className="shrink-0 text-right font-mono text-[11px] tabular-nums text-gray-300">
                {p.raw}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div>
          <div className="flex h-24 items-end gap-[3px]">
            {spec.points.map((p, i) => (
              <div
                key={i}
                className="flex h-full min-w-0 flex-1 flex-col justify-end"
                title={`${p.label}: ${p.raw}`}
              >
                <div
                  data-testid="chart-bar"
                  className={`w-full rounded-t-sm transition-[height] duration-500 ${
                    p === peak ? "bg-accent" : "bg-accent/45"
                  }`}
                  style={{ height: `${max > 0 ? Math.max((p.value / max) * 100, 2) : 0}%` }}
                />
              </div>
            ))}
          </div>
          {/* Only the ends are labelled: a per-column axis at this width would
              overlap into unreadable ink. The table below carries every value. */}
          <div className="mt-1.5 flex justify-between font-mono text-[10px] text-gray-500">
            <span>{spec.points[0].label}</span>
            <span className="text-gray-400">
              {t("chart.peak")} {peak.label} · {fmt(peak.value)}
            </span>
            <span>{spec.points[spec.points.length - 1].label}</span>
          </div>
        </div>
      )}
    </div>
  );
}
