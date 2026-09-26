import { useEffect, useRef, useState } from "react";
import { activateModelProvider, listModelProviders, updateModelProvider } from "../api";
import type { ModelProvider, ReasoningEffort } from "../types";
import { useI18n } from "../i18n";
import { pushOverlay } from "../lib/overlayStack";
import { Icon } from "./icons";
import { StatusDot } from "./ui";
import { ContextMeter } from "./ContextMeter";

const EFFORTS: ReasoningEffort[] = ["low", "medium", "high"];

function label(provider: ModelProvider): string {
  return provider.model || provider.name;
}

/**
 * Which model the Agent will use for the next Direction, and — only when the
 * active provider's model is known to take one — its reasoning effort. Backed
 * by the real provider list: switching activates a provider server-side and
 * effort is stored on the provider; nothing is painted when the Sidecar
 * reports no providers except the way to set one up.
 */
export function ModelChip({ onOpenSettings, refreshKey = 0, disabled = false }: {
  onOpenSettings?: () => void;
  refreshKey?: number;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  // v1.16 — chip copy lives in the i18n dict.
  const copy = {
    none: t("chip.none"), setUp: t("chip.setUp"), title: t("chip.title"), offline: t("chip.offline"),
    settings: t("chip.settings"), switching: t("chip.switching"), effort: t("chip.effort"),
    effortDefault: t("chip.effortDefault"), low: t("chip.low"), medium: t("chip.medium"), high: t("chip.high"),
  };
  const [providers, setProviders] = useState<ModelProvider[] | null>(null);
  // v3.1 — a failed read is the runtime being unreachable, not "no model":
  // the chip says so instead of sending the user to Settings.
  const [unreachable, setUnreachable] = useState(false);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  // v1.14 — keyboard position in the provider list (listbox pattern).
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setHighlight((i) => Math.min(i, Math.max((providers?.length ?? 1) - 1, 0)));
    menuRef.current?.focus();
  }, [open, providers?.length]);

  useEffect(() => {
    let alive = true;
    listModelProviders()
      .then((items) => { if (alive) { setProviders(items); setUnreachable(false); } })
      .catch(() => { if (alive) { setProviders([]); setUnreachable(true); } });
    return () => { alive = false; };
  }, [refreshKey, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    const release = pushOverlay(() => setOpen(false));
    return () => { document.removeEventListener("mousedown", onDown); release(); };
  }, [open]);

  const active = providers?.find((provider) => provider.active) ?? providers?.[0] ?? null;
  const missing = providers !== null && providers.length === 0;

  const choose = async (provider: ModelProvider) => {
    setOpen(false);
    if (provider.active) return;
    setSwitching(true);
    try {
      await activateModelProvider(provider.id);
      setProviders(await listModelProviders());
    } catch {
      /* the chip re-reads the list on the next open */
    } finally {
      setSwitching(false);
    }
  };

  const chooseEffort = async (effort: ReasoningEffort | null) => {
    if (!active) return;
    setOpen(false);
    try {
      await updateModelProvider(active.id, { reasoning_effort: effort ?? "" });
      setProviders(await listModelProviders());
    } catch {
      /* the chip re-reads the list on the next open */
    }
  };

  if (providers === null) return <span className="native-model-chip" aria-hidden><span className="skeleton h-3 w-16" /></span>;

  if (unreachable) {
    return (
      <span className="native-model-chip" data-offline="true" data-testid="model-chip" title={copy.offline} role="status">
        <StatusDot tone="danger" />
        <span>{copy.offline}</span>
      </span>
    );
  }

  if (missing) {
    return (
      <button type="button" className="native-model-chip" data-missing="true" data-testid="model-chip" onClick={onOpenSettings} title={copy.setUp} aria-label={`${copy.none} — ${copy.setUp}`}>
        <Icon name="chip" size={14} />
        <span>{copy.setUp}</span>
      </button>
    );
  }

  const effortLabel = (effort: ReasoningEffort | null) => (effort ? copy[effort] : copy.effortDefault);
  const showEffort = Boolean(active?.reasoning_capable);

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        className="native-model-chip"
        data-testid="model-chip"
        data-effort={showEffort ? active?.reasoning_effort ?? "default" : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        title={copy.title}
      >
        <Icon name="chip" size={14} />
        <span>{switching ? copy.switching : active ? label(active) : copy.none}</span>
        {showEffort && active && !switching ? (
          <span className="native-model-effort" data-testid="model-chip-effort">· {effortLabel(active.reasoning_effort)}</span>
        ) : null}
        <Icon name="chevron" size={14} className="rotate-90 opacity-60" />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="native-model-menu"
          role="listbox"
          aria-label={copy.title}
          aria-activedescendant={providers[highlight] ? `model-option-${providers[highlight].id}` : undefined}
          data-testid="model-chip-menu"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const delta = event.key === "ArrowDown" ? 1 : -1;
              setHighlight((i) => (i + delta + providers.length) % Math.max(providers.length, 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const target = providers[highlight];
              if (target) void choose(target);
            }
          }}
        >
          <div className="native-model-menu-title">{copy.title}</div>
          {providers.map((provider, index) => (
            <button
              key={provider.id}
              id={`model-option-${provider.id}`}
              type="button"
              role="option"
              aria-selected={provider.active || index === highlight}
              data-highlight={index === highlight ? "true" : "false"}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => void choose(provider)}
            >
              <span className="grid w-3.5 place-items-center">{provider.active ? <Icon name="check" size={14} stroke={1.75} /> : null}</span>
              <span className="min-w-0 flex-1 truncate">{label(provider)}</span>
              <small>{provider.name}</small>
            </button>
          ))}
          {showEffort && active ? (
            <>
              <div className="native-model-menu-sep" />
              <div className="native-model-menu-title">{copy.effort}</div>
              <div className="native-model-effort-row" role="group" aria-label={copy.effort} data-testid="model-chip-effort-menu">
                {([null, ...EFFORTS] as (ReasoningEffort | null)[]).map((effort) => (
                  <button
                    key={effort ?? "default"}
                    type="button"
                    aria-pressed={(active.reasoning_effort ?? null) === effort}
                    onClick={() => void chooseEffort(effort)}
                  >
                    {effortLabel(effort)}
                  </button>
                ))}
              </div>
            </>
          ) : null}
          {onOpenSettings ? (
            <>
              <div className="native-model-menu-sep" />
              <button type="button" onClick={() => { setOpen(false); onOpenSettings(); }}>
                <span className="grid w-3.5 place-items-center"><Icon name="settings" size={14} /></span>
                <span>{copy.settings}</span>
              </button>
            </>
          ) : null}
          <div className="native-model-menu-sep" />
          <div className="native-model-menu-meter">
            <ContextMeter />
          </div>
        </div>
      ) : null}
    </div>
  );
}
