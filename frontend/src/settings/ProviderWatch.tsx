import { useEffect, useId, useState } from "react";
import { getProviderWatch, runProviderWatch, setProviderWatch, type WatchState } from "../api";
import { useI18n } from "../i18n";
import { timeAgo } from "../lib/time";
import { Button, Segmented, StatusDot, type Tone } from "../components/ui";

type Watch = WatchState & { running?: boolean };
type Choice = "off" | "6" | "24" | "168";
const CHOICES: Choice[] = ["off", "6", "24", "168"];
const STATUS_TONE: Record<string, Tone> = { found: "warn", clear: "success", failed: "danger", running: "accent" };

/**
 * v4.0 — a cloud provider's watch: off by default; on, the Sidecar sweeps the
 * account read-only on its interval and opens one task when something new
 * turns up. "Check now" runs one sweep immediately.
 */
export function ProviderWatch({ providerId }: { providerId: string }) {
  const { t } = useI18n();
  const labelId = useId();
  const [watch, setWatch] = useState<Watch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  useEffect(() => {
    getProviderWatch(providerId).then(setWatch).catch(() => setWatch(null));
  }, [providerId]);
  // While a sweep the user started runs, follow it until it settles.
  useEffect(() => {
    if (!started) return;
    const id = window.setInterval(() => {
      getProviderWatch(providerId)
        .then((next) => { setWatch(next); if (!next.running) setStarted(false); })
        .catch(() => setStarted(false));
    }, 3000);
    return () => window.clearInterval(id);
  }, [started, providerId]);
  if (!watch) return null;
  const value: Choice = watch.enabled ? ((CHOICES.find((c) => c === String(watch.interval_hours)) ?? "24") as Choice) : "off";
  const change = async (next: Choice) => {
    setError(null);
    try {
      setWatch(await setProviderWatch(providerId, next !== "off", next === "off" ? watch.interval_hours : Number(next)));
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };
  const status = watch.last_status && watch.last_run_at
    ? `${t(`watch.status.${watch.last_status}`)} · ${timeAgo(watch.last_run_at, t)}`
    : null;
  return (
    <div className="provider-watch" data-testid="provider-watch" data-enabled={watch.enabled ? "true" : "false"}>
      <span className="provider-watch-label" id={labelId}>{t("watch.label")}</span>
      <Segmented
        labelId={labelId}
        testId="provider-watch-interval"
        value={value}
        onChange={(next) => void change(next)}
        options={CHOICES.map((c) => ({ value: c, label: t(`watch.every.${c}`) }))}
      />
      <Button size="sm" variant="ghost" disabled={started}
        onClick={() => {
          setStarted(true);
          void runProviderWatch(providerId).catch((e) => { setError(String(e)); setStarted(false); });
        }}>
        {started ? t("watch.started") : t("watch.checkNow")}
      </Button>
      <p className="provider-watch-note">
        {status ? (
          <span className="provider-watch-status">
            <StatusDot tone={STATUS_TONE[watch.last_status ?? ""] ?? "neutral"} />
            {status}{watch.last_summary ? ` — ${watch.last_summary}` : ""}
          </span>
        ) : t("watch.hint")}
      </p>
      {error ? <p className="provider-watch-note" role="alert">{error}</p> : null}
    </div>
  );
}
