import { useI18n } from "../i18n";
import { costChart, driftChart, inventoryChart, accessChart } from "./extract";
import {
  ChartFrame,
  CostColumns,
  GapState,
  Legend,
  RankedBars,
  StackedHorizon,
  formatBytes,
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
    <div className="viz-figures" data-compact={compact ? "true" : undefined} data-testid="analysis-figures">
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
            table={{
              columns: [t("viz.horizon"), ...cost.classes, ...(cost.priceConfirmed ? [t("viz.baseline"), t("viz.candidate")] : [])],
              rows: cost.horizons.map((h) => [
                `${h.day}d`,
                ...cost.classes.map((name) => formatBytes(h.classes[name] ?? 0)),
                ...(cost.priceConfirmed
                  ? [h.baselineCost != null ? `$${h.baselineCost.toFixed(2)}` : "—", h.candidateCost != null ? `$${h.candidateCost.toFixed(2)}` : "—"]
                  : []),
              ]),
            }}
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
                <div className="viz-section">
                  <div className="viz-subhead">
                    <div className="viz-subtitle">{t("viz.monthlyCost")}</div>
                    {cost.delta != null ? (
                      <p className="viz-stat-inline" data-testid="viz-cost-delta">
                        <strong>{formatUsd(cost.delta)}</strong>
                        <span>{t("viz.at365")}</span>
                      </p>
                    ) : null}
                  </div>
                  <Legend items={[{ label: t("viz.baseline"), color: "var(--gray-500)" }, { label: t("viz.candidate"), color: "var(--viz-1)" }]} />
                  <CostColumns
                    days={cost.horizons.map((h) => h.day)}
                    baseline={cost.horizons.map((h) => h.baselineCost)}
                    candidate={cost.horizons.map((h) => h.candidateCost)}
                    labels={{ baseline: t("viz.baseline"), candidate: t("viz.candidate") }}
                  />
                </div>
              </>
            ) : (
              <div className="viz-section">
                <GapState title={t("viz.costWithheld")} body={t("viz.costWithheldBody")} />
              </div>
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
          table={{
            columns: [t("viz.dimension"), t("viz.bucketLabel"), t("viz.objectsCol")],
            rows: [
              ...inventory.age.map((r) => [t("viz.ariaAge"), r.label, r.count.toLocaleString()]),
              ...inventory.storageClass.map((r) => [t("viz.ariaClass"), r.label, r.count.toLocaleString()]),
            ],
          }}
        >
          <div className={compact ? "viz-split viz-split-stack" : "viz-split"}>
            <RankedBars title={t("viz.ariaAge")} points={inventory.age.map((r) => ({ label: r.label, value: r.count }))} ariaLabel={t("viz.ariaAge")} />
            <RankedBars title={t("viz.ariaClass")} points={inventory.storageClass.map((r) => ({ label: r.label, value: r.count }))} ariaLabel={t("viz.ariaClass")} />
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
            <div className="viz-stats">
              {[
                [t("viz.added"), drift.added, "var(--warn)"],
                [t("viz.resolved"), drift.resolved, "var(--success)"],
                [t("viz.stillHere"), drift.stillPresent, "var(--gray-500)"],
              ].map(([label, count, color]) => (
                <div key={String(label)} className="viz-stat" data-testid="viz-drift-cell">
                  <span className="viz-stat-label">
                    <i style={{ background: String(color) }} aria-hidden />
                    {label}
                  </span>
                  <strong>{count}</strong>
                </div>
              ))}
            </div>
          )}
          {drift.objectDelta != null ? (
            <p className="viz-stat-inline viz-section-tight">
              <strong>
                {t("viz.objects", { n: `${(drift.objectDelta ?? 0) >= 0 ? "+" : "−"}${Math.abs(drift.objectDelta ?? 0)}` })}
                {drift.sizeDelta != null ? ` · ${formatSignedBytes(drift.sizeDelta)}` : ""}
              </strong>
              <span>{t("viz.twoSnapshots")}</span>
            </p>
          ) : null}
        </ChartFrame>
      ) : null}

      {access ? (
        <ChartFrame title={t("viz.accessTitle")} testId="viz-access" coverage={access.coverage} estimate={access.estimate}>
          {access.latency ? (
            <RankedBars
              title={t("viz.latency")}
              format={(n) => `${n.toLocaleString()} ms`}
              share={false}
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
            <div className={compact ? "viz-split viz-split-stack viz-section" : "viz-split viz-section"}>
              <RankedBars title={t("viz.byMethod")} points={access.methods.map((r) => ({ label: r.label, value: r.count }))} ariaLabel="Requests by method" />
              <RankedBars title={t("viz.byStatus")} points={access.statuses.map((r) => ({ label: r.label, value: r.count }))} ariaLabel="Requests by status" />
            </div>
          ) : null}
        </ChartFrame>
      ) : null}
    </div>
  );
}
