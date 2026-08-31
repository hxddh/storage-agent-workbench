import { costChart, driftChart, inventoryChart, accessChart } from "./extract";
import {
  ChartFrame,
  CostColumns,
  GapState,
  RankedBars,
  StackedHorizon,
  formatUsd,
  seriesColor,
} from "./marks";
import type { TaskProvenance } from "./types";

export function AnalysisFigures({
  provenance,
  compact = false,
}: {
  provenance: TaskProvenance | null;
  compact?: boolean;
}) {
  if (!provenance) return null;
  const cost = costChart(provenance.analysis.cost);
  const inventory = inventoryChart(provenance.analysis.inventory);
  const drift = driftChart(provenance.analysis.drift);
  const access = accessChart(provenance.analysis.access_log);
  if (!cost && !inventory && !drift && !access) return null;

  return (
    <div className={compact ? "space-y-4" : "space-y-5"} data-testid="analysis-figures">
      {cost ? (
        cost.horizons.length === 0 ? (
          <ChartFrame title="Cost simulation" testId="viz-cost" coverage={cost.coverage} estimate>
            <GapState title="No inventory to simulate." body={cost.gaps[0]?.message} />
          </ChartFrame>
        ) : (
          <ChartFrame
            title="Storage class over 0–365d"
            testId="viz-cost"
            coverage={cost.coverage}
            estimate
            extra="Horizons the simulator emitted. Not a forecast."
          >
            <StackedHorizon
              days={cost.horizons.map((h) => h.day)}
              series={cost.classes}
              values={cost.horizons.map((h) => cost.classes.map((name) => h.classes[name] ?? 0))}
            />
            {cost.classes.length ? (
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-gray-500">
                {cost.classes.map((name, i) => (
                  <span key={name} className="inline-flex items-center gap-1">
                    <i className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: seriesColor(i) }} aria-hidden />
                    {name}
                  </span>
                ))}
              </div>
            ) : null}
            {cost.priceConfirmed ? (
              <>
                <CostColumns
                  days={cost.horizons.map((h) => h.day)}
                  baseline={cost.horizons.map((h) => h.baselineCost)}
                  candidate={cost.horizons.map((h) => h.candidateCost)}
                />
                {cost.delta != null ? (
                  <p className="mt-1 font-mono text-sm tabular-nums text-gray-100" data-testid="viz-cost-delta">
                    {formatUsd(cost.delta)}
                    <span className="ml-2 text-2xs font-sans font-medium uppercase tracking-wide text-gray-500">at 365d · estimate</span>
                  </p>
                ) : null}
              </>
            ) : (
              <GapState title="Cost axis withheld." body="Confirm the local price table to see dollar figures. Class mix above is still real." />
            )}
          </ChartFrame>
        )
      ) : null}

      {inventory ? (
        <ChartFrame
          title="Inventory age and class"
          testId="viz-inventory"
          coverage={inventory.coverage}
          estimate={inventory.estimate}
          extra="Age and class are independent. Joint age×class is not observed."
        >
          <div className={compact ? "space-y-3" : "grid gap-4 sm:grid-cols-2"}>
            <RankedBars points={inventory.age.map((r) => ({ label: r.label, value: r.count }))} ariaLabel="Objects by age" />
            <RankedBars points={inventory.storageClass.map((r) => ({ label: r.label, value: r.count }))} ariaLabel="Objects by storage class" />
          </div>
        </ChartFrame>
      ) : null}

      {drift ? (
        <ChartFrame title="Drift" testId="viz-drift" coverage={drift.coverage} estimate={drift.estimate} extra={drift.trendNote}>
          {drift.gap ? (
            <GapState title="No comparable baseline." body={drift.gap} />
          ) : (
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                ["Added", drift.added, "var(--warn)"],
                ["Resolved", drift.resolved, "var(--success)"],
                ["Still here", drift.stillPresent, "var(--viz-1)"],
              ].map(([label, count, color]) => (
                <div key={String(label)} className="rounded-lg border border-edge bg-panel/50 px-2 py-2">
                  <div className="font-mono text-lg tabular-nums text-gray-100" style={{ color: String(color) }}>{count}</div>
                  <div className="text-2xs uppercase tracking-wide text-gray-500">{label}</div>
                </div>
              ))}
            </div>
          )}
          {drift.objectDelta != null ? (
            <p className="mt-2 font-mono text-xs tabular-nums text-gray-300">
              {drift.objectDelta >= 0 ? "+" : ""}{drift.objectDelta} objects
              {drift.sizeDelta != null ? ` · ${drift.sizeDelta >= 0 ? "+" : ""}${drift.sizeDelta} bytes` : ""}
              <span className="ml-1 font-sans text-2xs uppercase tracking-wide text-gray-500">two snapshots</span>
            </p>
          ) : null}
        </ChartFrame>
      ) : null}

      {access ? (
        <ChartFrame title="Access logs" testId="viz-access" coverage={access.coverage} estimate={access.estimate}>
          {access.latency ? (
            <RankedBars
              points={[
                { label: "p50", value: access.latency.p50 },
                { label: "p95", value: access.latency.p95 },
                { label: "p99", value: access.latency.p99 },
                { label: "max", value: access.latency.max },
              ]}
              ariaLabel="Latency percentiles in milliseconds"
            />
          ) : (
            <GapState title="Latency not in this log format." body="Request mix below is still from parsed rows." />
          )}
          {access.methods.length || access.statuses.length ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <RankedBars points={access.methods} ariaLabel="Requests by method" />
              <RankedBars points={access.statuses} ariaLabel="Requests by status" />
            </div>
          ) : null}
        </ChartFrame>
      ) : null}
    </div>
  );
}
