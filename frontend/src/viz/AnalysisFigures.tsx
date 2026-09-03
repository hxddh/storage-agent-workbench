import { useI18n } from "../i18n";
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
  const { t } = useI18n();
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
          <ChartFrame title={t("viz.costTitle")} testId="viz-cost" coverage={cost.coverage} estimate>
            <GapState title={t("viz.costEmpty")} body={cost.gaps[0]?.message} />
          </ChartFrame>
        ) : (
          <ChartFrame
            title={t("viz.horizonsTitle")}
            testId="viz-cost"
            coverage={cost.coverage}
            estimate
            extra={t("viz.horizonsNote")}
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
                    <span className="ml-2 text-2xs font-sans font-medium uppercase tracking-wide text-gray-500">{t("viz.at365")}</span>
                  </p>
                ) : null}
              </>
            ) : (
              <GapState title={t("viz.costWithheld")} body={t("viz.costWithheldBody")} />
            )}
          </ChartFrame>
        )
      ) : null}

      {inventory ? (
        <ChartFrame
          title={t("viz.inventoryTitle")}
          testId="viz-inventory"
          coverage={inventory.coverage}
          estimate={inventory.estimate}
          extra={t("viz.inventoryNote")}
        >
          <div className={compact ? "space-y-3" : "grid gap-4 sm:grid-cols-2"}>
            <RankedBars points={inventory.age.map((r) => ({ label: r.label, value: r.count }))} ariaLabel={t("viz.ariaAge")} />
            <RankedBars points={inventory.storageClass.map((r) => ({ label: r.label, value: r.count }))} ariaLabel={t("viz.ariaClass")} />
          </div>
        </ChartFrame>
      ) : null}

      {drift ? (
        <ChartFrame title={t("viz.driftTitle")} testId="viz-drift" coverage={drift.coverage} estimate={drift.estimate} extra={drift.trendNote}>
          {drift.gap ? (
            <GapState title={t("viz.driftEmpty")} body={drift.gap} />
          ) : (
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                [t("viz.added"), drift.added, "var(--warn)"],
                [t("viz.resolved"), drift.resolved, "var(--success)"],
                [t("viz.stillHere"), drift.stillPresent, "var(--viz-1)"],
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
              {t("viz.objects", { n: `${(drift.objectDelta ?? 0) >= 0 ? "+" : "−"}${Math.abs(drift.objectDelta ?? 0)}` })}
              {drift.sizeDelta != null ? ` · ${drift.sizeDelta >= 0 ? "+" : ""}${drift.sizeDelta} bytes` : ""}
              <span className="ml-1 font-sans text-2xs uppercase tracking-wide text-gray-500">{t("viz.twoSnapshots")}</span>
            </p>
          ) : null}
        </ChartFrame>
      ) : null}

      {access ? (
        <ChartFrame title={t("viz.accessTitle")} testId="viz-access" coverage={access.coverage} estimate={access.estimate}>
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
            <GapState title={t("viz.latencyGap")} body={t("viz.latencyBody")} />
          )}
          {access.methods.length || access.statuses.length ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <RankedBars points={access.methods.map((r) => ({ label: r.label, value: r.count }))} ariaLabel="Requests by method" />
              <RankedBars points={access.statuses.map((r) => ({ label: r.label, value: r.count }))} ariaLabel="Requests by status" />
            </div>
          ) : null}
        </ChartFrame>
      ) : null}
    </div>
  );
}
