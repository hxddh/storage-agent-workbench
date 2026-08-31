import type { ReactNode } from "react";
import type { Coverage } from "./types";

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
  const bits: string[] = [];
  if (estimate) bits.push("Estimate");
  if (coverage?.object_count != null) bits.push(`${coverage.object_count.toLocaleString()} objects`);
  if (coverage?.bytes != null) bits.push(formatBytes(coverage.bytes));
  if (coverage?.total_requests != null) bits.push(`${coverage.total_requests.toLocaleString()} requests`);
  if (coverage?.inventory_as_of) bits.push(coverage.inventory_as_of.slice(0, 10));
  if (coverage?.unknown_age_ratio) bits.push(`${Math.round(coverage.unknown_age_ratio * 100)}% age unknown`);
  if (coverage?.truncated) bits.push("truncated");
  if (coverage?.parsed_fraction != null && coverage.parsed_fraction < 1) {
    bits.push(`${Math.round(coverage.parsed_fraction * 100)}% parsed`);
  }
  if (extra) bits.push(extra);
  if (bits.length === 0 && !coverage?.note) return null;
  return (
    <p className="mt-1.5 text-2xs leading-relaxed text-gray-500" data-testid="viz-coverage">
      {bits.join(" · ")}
      {coverage?.note ? <span className="mt-0.5 block">{coverage.note}</span> : null}
    </p>
  );
}

export function GapState({ title, body }: { title: string; body?: string | null }) {
  return (
    <div
      data-testid="viz-gap"
      className="rounded-lg border border-dashed border-edge bg-panel/40 px-3 py-3 text-xs leading-relaxed text-gray-400"
    >
      <div className="font-medium text-gray-300">{title}</div>
      {body ? <p className="mt-0.5 text-gray-500">{body}</p> : null}
    </div>
  );
}

export function ChartFrame({
  title,
  testId,
  children,
  coverage,
  estimate,
  extra,
}: {
  title: string;
  testId: string;
  children: ReactNode;
  coverage?: Coverage | null;
  estimate?: boolean;
  extra?: string | null;
}) {
  return (
    <figure data-testid={testId} className="agent-result-wide min-w-0">
      <figcaption className="mb-2 text-2xs font-medium uppercase tracking-[0.08em] text-gray-500">{title}</figcaption>
      {children}
      <CoverageMark coverage={coverage ?? null} estimate={estimate} extra={extra} />
    </figure>
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
  if (days.length === 0 || series.length === 0) return <GapState title="No class mix to plot." />;
  const totals = values.map((row) => row.reduce((sum, n) => sum + n, 0));
  const max = Math.max(...totals, 1);
  const width = 320;
  const height = 88;
  const gap = days.length === 1 ? 36 : 10;
  const barW = Math.min(36, (width - gap * (days.length + 1)) / days.length);
  return (
    <svg viewBox={`0 0 ${width} ${height + 18}`} className="h-28 w-full text-gray-500" role="img" aria-label="Storage class mix by simulator horizon">
      {days.map((day, i) => {
        const x = gap + i * ((width - gap) / days.length);
        let y = height;
        return (
          <g key={day}>
            {series.map((name, s) => {
              const amount = values[i]?.[s] ?? 0;
              const h = (amount / max) * height;
              y -= h;
              if (h <= 0) return null;
              return <rect key={name} x={x} y={y} width={barW} height={h} fill={seriesColor(s)} rx={s === series.length - 1 ? 2 : 0} />;
            })}
            <text x={x + barW / 2} y={height + 14} textAnchor="middle" className="fill-current" fontSize="9">{day}d</text>
          </g>
        );
      })}
    </svg>
  );
}

export function CostColumns({
  days,
  baseline,
  candidate,
}: {
  days: number[];
  baseline: Array<number | null>;
  candidate: Array<number | null>;
}) {
  const nums = [...baseline, ...candidate].filter((n): n is number => n != null);
  if (nums.length === 0) return null;
  const max = Math.max(...nums, 0.01);
  const width = 320;
  const height = 72;
  const gap = days.length === 1 ? 36 : 10;
  const slot = (width - gap) / days.length;
  const barW = Math.min(14, slot / 2 - 2);
  return (
    <svg viewBox={`0 0 ${width} ${height + 18}`} className="mt-2 h-24 w-full text-gray-500" role="img" aria-label="Monthly cost at simulator horizons">
      {days.map((day, i) => {
        const x = gap + i * slot;
        const b = baseline[i];
        const c = candidate[i];
        return (
          <g key={day}>
            {b != null ? <rect x={x} y={height - (b / max) * height} width={barW} height={(b / max) * height} fill="var(--viz-6)" rx={1} /> : null}
            {c != null ? <rect x={x + barW + 2} y={height - (c / max) * height} width={barW} height={(c / max) * height} fill="var(--viz-1)" rx={1} /> : null}
            <text x={x + barW} y={height + 14} textAnchor="middle" className="fill-current" fontSize="9">{day}d</text>
          </g>
        );
      })}
    </svg>
  );
}

export function RankedBars({
  points,
  ariaLabel,
}: {
  points: Array<{ label: string; value: number }>;
  ariaLabel: string;
}) {
  if (points.length === 0) return <GapState title="No distribution to plot." />;
  const max = Math.max(...points.map((p) => p.value), 1);
  const peak = points.reduce((a, b) => (b.value > a.value ? b : a));
  return (
    <div role="img" aria-label={ariaLabel} className="space-y-1">
      {points.map((p) => (
        <div key={p.label} className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-2">
          <span className="truncate font-mono text-2xs text-gray-400" title={p.label}>{p.label}</span>
          <div className="h-1.5 overflow-hidden rounded-full bg-edge">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max((p.value / max) * 100, 1.5)}%`,
                background: p === peak ? "var(--viz-1)" : "color-mix(in srgb, var(--viz-1) 45%, transparent)",
              }}
            />
          </div>
          <span className="font-mono text-2xs tabular-nums text-gray-300">{p.value.toLocaleString()}</span>
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

export function formatUsd(n: number): string {
  const sign = n < 0 ? "−" : n > 0 ? "+" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}/mo`;
}
