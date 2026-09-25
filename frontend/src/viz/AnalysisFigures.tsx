import { useI18n } from "../i18n";
import { costChart, driftChart, inventoryChart, accessChart } from "./extract";
import {
  ChartFrame,
  CostColumns,
  GapState,
  Legend,
  RankedBars,
  StackedHorizon,
  formatSignedBytes,
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
            {cost.classes.length > 1 ? (
              <Legend items={cost.classes.map((name, i) => ({ label: name, color: seriesColor(i) }))} />
            ) : null}
            <StackedHorizon
              days={cost.horizons.map((h) => h.day)}
              series={cost.classes}
              values={cost.horizons.map((h) => cost.classes.map((name) => h.classes[name] ?? 0))}
            />
            {cost.priceConfirmed ? (
              <>
                <div className="mt-4">
                  <Legend items={[{ label: t("viz.baseline"), color: "var(--gray-500)" }, { label: t("viz.candidate"), color: "var(--viz-1)" }]} />
                </div>
                <CostColumns
                  days={cost.horizons.map((h) => h.day)}
                  baseline={cost.horizons.map((h) => h.baselineCost)}
                  candidate={cost.horizons.map((h) => h.candidateCost)}
                />
                {cost.delta != null ? (
                  <p className="mt-2 flex items-baseline gap-2" data-testid="viz-cost-delta">
                    <span className="text-lg font-semibold tabular-nums text-gray-100">{formatUsd(cost.delta)}</span>
                    <span className="text-2xs text-gray-500">{t("viz.at365")}</span>
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
            // Three counts as quiet stat cells: the number is ink, status lives
            // in one dot beside the label (never a coloured number).
            <div className="grid grid-cols-3 divide-x divide-edge border-y border-edge">
              {[
                [t("viz.added"), drift.added, "var(--warn)"],
                [t("viz.resolved"), drift.resolved, "var(--success)"],
                [t("viz.stillHere"), drift.stillPresent, "var(--gray-500)"],
              ].map(([label, count, color]) => (
                <div key={String(label)} className="px-3 py-2.5" data-testid="viz-drift-cell">
                  <div className="text-xl font-semibold tabular-nums text-gray-100">{count}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-2xs text-gray-500">
                    <i className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: String(color) }} aria-hidden />
                    {label}
                  </div>
                </div>
              ))}
            </div>
          )}
          {drift.objectDelta != null ? (
            <p className="mt-2 text-xs tabular-nums text-gray-300">
              {t("viz.objects", { n: `${(drift.objectDelta ?? 0) >= 0 ? "+" : "−"}${Math.abs(drift.objectDelta ?? 0)}` })}
              {drift.sizeDelta != null ? ` · ${formatSignedBytes(drift.sizeDelta)}` : ""}
              <span className="ml-1.5 text-2xs text-gray-500">{t("viz.twoSnapshots")}</span>
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
