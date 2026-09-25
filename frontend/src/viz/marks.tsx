import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import type { Coverage } from "./types";

/* v3.0 figures. One validated categorical order (viz-1…6, checked for CVD
 * separation in both themes), thin marks with 4px rounded data-ends anchored
 * to a baseline, 2px surface gaps, recessive gridlines, ink text, a legend for
 * two or more series, a hover tooltip per mark and a table view. */

const SERIES = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)", "var(--viz-5)", "var(--viz-6)"];

export function seriesColor(index: number): string {
  return SERIES[index % SERIES.length];
}

export function CoverageMark({
  coverage,
  estimate,
  extra,
}: {
  coverage: Coverage | null;
  estimate?: boolean;
  extra?: string | null;
}) {
  const { t } = useI18n();
  const bits: string[] = [];
  if (estimate) bits.push(t("viz.estimate"));
  if (coverage?.object_count != null) bits.push(t("viz.objects", { n: coverage.object_count.toLocaleString() }));
  if (coverage?.bytes != null) bits.push(formatBytes(coverage.bytes));
  if (coverage?.total_requests != null) bits.push(t("viz.requests", { n: coverage.total_requests.toLocaleString() }));
  if (coverage?.inventory_as_of) bits.push(coverage.inventory_as_of.slice(0, 10));
  if (coverage?.unknown_age_ratio) bits.push(t("viz.ageUnknown", { n: Math.round(coverage.unknown_age_ratio * 100) }));
  if (coverage?.truncated) bits.push(t("viz.truncated"));
  if (coverage?.parsed_fraction != null && coverage.parsed_fraction < 1) {
    bits.push(t("viz.parsed", { n: Math.round(coverage.parsed_fraction * 100) }));
  }
  if (extra) bits.push(extra);
  if (bits.length === 0 && !coverage?.note) return null;
  return (
    <p className="viz-coverage" data-testid="viz-coverage">
      {bits.join(" · ")}
      {coverage?.note ? <span className="block">{coverage.note}</span> : null}
    </p>
  );
}

function NoMix() {
  const { t } = useI18n();
  return <GapState title={t("viz.noMix")} />;
}

function NoDist() {
  const { t } = useI18n();
  return <GapState title={t("viz.noDist")} />;
}

export function GapState({ title, body }: { title: string; body?: string | null }) {
  return (
    <div data-testid="viz-gap" className="viz-gap">
      <strong>{title}</strong>
      {body ? <p>{body}</p> : null}
    </div>
  );
}

/** A legend row: one swatch + ink label per series (identity is never colour
 * alone — the label is always beside it). Sits above the plot. */
export function Legend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <div className="viz-legend" data-testid="viz-legend">
      {items.map((item) => (
        <span key={item.label}>
          <i style={{ background: item.color }} aria-hidden />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export type FigureTable = { columns: string[]; rows: Array<Array<string>> };

export function ChartFrame({
  title,
  testId,
  children,
  coverage,
  estimate,
  extra,
  table,
}: {
  title: string;
  testId: string;
  children: ReactNode;
  coverage?: Coverage | null;
  estimate?: boolean;
  extra?: string | null;
  table?: FigureTable | null;
}) {
  const { t } = useI18n();
  const [asTable, setAsTable] = useState(false);
  const showTable = asTable && table && table.rows.length > 0;
  return (
    <figure data-testid={testId} className="agent-figure viz-card">
      <figcaption className="viz-head">
        <span className="viz-title">{title}</span>
        {table && table.rows.length > 0 ? (
          <button
            type="button"
            className="viz-view-toggle"
            aria-pressed={asTable}
            data-testid="viz-table-toggle"
            onClick={() => setAsTable((v) => !v)}
          >
            {asTable ? t("viz.showChart") : t("viz.showTable")}
          </button>
        ) : null}
      </figcaption>
      <div className="viz-body">
        {showTable ? (
          <div className="viz-table-wrap">
            <table className="viz-table" data-testid="viz-table">
              <thead><tr>{table.columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
              <tbody>
                {table.rows.map((row, i) => (
                  <tr key={i}>{row.map((cell, j) => (j === 0 ? <th key={j} scope="row">{cell}</th> : <td key={j}>{cell}</td>))}</tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : children}
      </div>
      <CoverageMark coverage={coverage ?? null} estimate={estimate} extra={extra} />
    </figure>
  );
}

/* ---------- plotting helpers ---------- */

/** The plot's rendered width (the viewBox follows it, so text never scales). */
function useMeasuredWidth(fallback = 560) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const w = Math.round(node.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** 0 and two round steps above it — three recessive gridlines. */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 2;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  return [0, step, step * 2];
}

/** A column with only its top (data end) rounded, anchored to the baseline. */
function columnPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

type Tip = { x: number; y: number; title: string; rows: Array<{ label: string; value: string; color?: string }> };

function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div className="viz-tooltip" role="status" style={{ left: tip.x, top: tip.y }} data-testid="viz-tooltip">
      <strong>{tip.title}</strong>
      {tip.rows.map((row) => (
        <span key={row.label}>
          {row.color ? <i style={{ background: row.color }} aria-hidden /> : null}
          <em>{row.label}</em>
          <b>{row.value}</b>
        </span>
      ))}
    </div>
  );
}

const PAD = { top: 10, right: 8, bottom: 24, left: 52 };

function Axis({ ticks, max, width, height, format }: { ticks: number[]; max: number; width: number; height: number; format: (n: number) => string }) {
  return (
    <g>
      {ticks.map((tick) => {
        const y = PAD.top + height - (tick / max) * height;
        return (
          <g key={tick}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y} y2={y} className={tick === 0 ? "viz-baseline" : "viz-grid"} />
            <text x={PAD.left - 8} y={y} dy="0.32em" textAnchor="end" className="viz-tick" data-axis="y">{format(tick)}</text>
          </g>
        );
      })}
    </g>
  );
}

export function StackedHorizon({
  days,
  series,
  values,
}: {
  days: number[];
  series: string[];
  values: number[][];
}) {
  const [ref, width] = useMeasuredWidth();
  const [tip, setTip] = useState<Tip | null>(null);
  if (days.length === 0 || series.length === 0) return <NoMix />;
  const totals = values.map((row) => row.reduce((sum, n) => sum + n, 0));
  const ticks = niceTicks(Math.max(...totals, 1));
  const max = ticks[ticks.length - 1];
  const height = 148;
  const plotW = width - PAD.left - PAD.right;
  const slot = plotW / days.length;
  const barW = Math.max(8, Math.min(48, slot * 0.56));
  return (
    <div ref={ref} className="viz-plot" onMouseLeave={() => setTip(null)}>
      <svg width={width} height={height + PAD.top + PAD.bottom} role="img" aria-label="Storage class mix by simulator horizon">
        <Axis ticks={ticks} max={max} width={width} height={height} format={formatBytesShort} />
        {days.map((day, i) => {
          const x = PAD.left + i * slot + (slot - barW) / 2;
          let y = PAD.top + height;
          const present = series.map((_, s) => values[i]?.[s] ?? 0);
          const topIndex = present.reduce((top, amount, s) => (amount > 0 ? s : top), -1);
          return (
            <g key={day}>
              {series.map((name, s) => {
                const amount = present[s];
                const h = (amount / max) * height;
                if (h <= 0) return null;
                y -= h;
                // A 2px surface gap separates stacked segments (never a stroke).
                const gap = y + h < PAD.top + height ? 2 : 0;
                const segH = Math.max(h - gap, 1);
                return s === topIndex
                  ? <path key={name} d={columnPath(x, y, barW, segH, 4)} fill={seriesColor(s)} />
                  : <rect key={name} x={x} y={y} width={barW} height={segH} fill={seriesColor(s)} />;
              })}
              <text x={x + barW / 2} y={PAD.top + height + 16} textAnchor="middle" className="viz-tick" data-axis="x">{day}d</text>
              <rect
                x={PAD.left + i * slot}
                y={PAD.top}
                width={slot}
                height={height}
                className="viz-hit"
                onMouseEnter={() => setTip({
                  x: Math.min(x + barW + 8, width - 180),
                  y: PAD.top,
                  title: `${day}d`,
                  rows: [
                    ...series.map((name, s) => ({ label: name, value: formatBytes(present[s]), color: seriesColor(s) })).filter((_, s) => present[s] > 0),
                    { label: "Σ", value: formatBytes(totals[i]) },
                  ],
                })}
              />
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

export function CostColumns({
  days,
  baseline,
  candidate,
  labels,
}: {
  days: number[];
  baseline: Array<number | null>;
  candidate: Array<number | null>;
  labels: { baseline: string; candidate: string };
}) {
  const [ref, width] = useMeasuredWidth();
  const [tip, setTip] = useState<Tip | null>(null);
  const nums = [...baseline, ...candidate].filter((n): n is number => n != null);
  if (nums.length === 0) return null;
  const ticks = niceTicks(Math.max(...nums, 0.01));
  const max = ticks[ticks.length - 1];
  const height = 120;
  const plotW = width - PAD.left - PAD.right;
  const slot = plotW / days.length;
  const barW = Math.max(6, Math.min(22, (slot * 0.6 - 2) / 2));
  const money = (n: number) => `$${n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(n < 10 ? 2 : 0)}`;
  return (
    <div ref={ref} className="viz-plot" onMouseLeave={() => setTip(null)}>
      <svg width={width} height={height + PAD.top + PAD.bottom} role="img" aria-label="Monthly cost at simulator horizons">
        <Axis ticks={ticks} max={max} width={width} height={height} format={money} />
        {days.map((day, i) => {
          const x = PAD.left + i * slot + (slot - (barW * 2 + 2)) / 2;
          const b = baseline[i];
          const c = candidate[i];
          const bar = (value: number, bx: number, fill: string) => {
            const h = Math.max((value / max) * height, 1);
            return <path d={columnPath(bx, PAD.top + height - h, barW, h, 4)} fill={fill} />;
          };
          return (
            <g key={day}>
              {b != null ? bar(b, x, "var(--gray-500)") : null}
              {c != null ? bar(c, x + barW + 2, "var(--viz-1)") : null}
              <text x={x + barW + 1} y={PAD.top + height + 16} textAnchor="middle" className="viz-tick" data-axis="x">{day}d</text>
              <rect
                x={PAD.left + i * slot}
                y={PAD.top}
                width={slot}
                height={height}
                className="viz-hit"
                onMouseEnter={() => setTip({
                  x: Math.min(x + barW * 2 + 10, width - 180),
                  y: PAD.top,
                  title: `${day}d`,
                  rows: [
                    ...(b != null ? [{ label: labels.baseline, value: `$${b.toFixed(2)}`, color: "var(--gray-500)" }] : []),
                    ...(c != null ? [{ label: labels.candidate, value: `$${c.toFixed(2)}`, color: "var(--viz-1)" }] : []),
                  ],
                })}
              />
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

export function RankedBars({
  points,
  ariaLabel,
  title,
  format = (n: number) => n.toLocaleString(),
}: {
  points: Array<{ label: string; value: number }>;
  ariaLabel: string;
  title?: string;
  format?: (n: number) => string;
}) {
  if (points.length === 0) return <NoDist />;
  const max = Math.max(...points.map((p) => p.value), 1);
  const total = points.reduce((sum, p) => sum + p.value, 0) || 1;
  return (
    <div className="viz-ranked" role="img" aria-label={ariaLabel}>
      {title ? <div className="viz-subtitle">{title}</div> : null}
      {points.map((p, index) => (
        <div
          key={`${p.label}·${index}`}
          className="viz-ranked-row"
          title={`${p.label}: ${format(p.value)} (${Math.round((p.value / total) * 100)}%)`}
        >
          <span className="viz-ranked-label">{p.label}</span>
          <span className="viz-ranked-track">
            <span style={{ width: `${Math.max((p.value / max) * 100, 1.5)}%` }} />
          </span>
          <span className="viz-ranked-value">{format(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function formatBytes(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

/** Axis ticks: bytes without a trailing ".0". */
function formatBytesShort(n: number): string {
  return n === 0 ? "0" : formatBytes(n).replace(".0 ", " ");
}

export function formatSignedBytes(n: number): string {
  return `${n < 0 ? "−" : "+"}${formatBytes(Math.abs(n))}`;
}

export function formatUsd(n: number): string {
  const sign = n < 0 ? "−" : n > 0 ? "+" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}/mo`;
}
