import { useEffect, useRef, useState } from "react";
import { activateModelProvider, listModelProviders } from "../api";
import type { ModelProvider } from "../types";
import { useI18n } from "../i18n";
import { pushOverlay } from "../lib/overlayStack";
import { Icon } from "./icons";

function label(provider: ModelProvider): string {
  return provider.model || provider.name;
}

/**
 * Which model the Agent will use for the next Direction. Backed by the real
 * provider list: switching activates a provider server-side; nothing is
 * painted when the Sidecar reports no providers except the way to set one up.
 */
export function ModelChip({ onOpenSettings, refreshKey = 0, disabled = false }: {
  onOpenSettings?: () => void;
  refreshKey?: number;
  disabled?: boolean;
}) {
  const { lang } = useI18n();
  const copy = lang === "zh"
    ? { none: "未配置模型", setUp: "配置模型…", title: "模型", settings: "管理模型…", switching: "切换中…" }
    : { none: "No model", setUp: "Set up a model…", title: "Model", settings: "Manage models…", switching: "Switching…" };
  const [providers, setProviders] = useState<ModelProvider[] | null>(null);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    listModelProviders().then((items) => { if (alive) setProviders(items); }).catch(() => { if (alive) setProviders([]); });
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

  if (providers === null) return <span className="native-model-chip" aria-hidden><span className="skeleton h-3 w-16" /></span>;

  if (missing) {
    return (
      <button type="button" className="native-model-chip" data-missing="true" data-testid="model-chip" onClick={onOpenSettings} title={copy.setUp}>
        <Icon name="chip" size={13} />
        <span>{copy.none}</span>
      </button>
    );
  }

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        className="native-model-chip"
        data-testid="model-chip"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        title={copy.title}
      >
        <Icon name="chip" size={13} />
        <span>{switching ? copy.switching : active ? label(active) : copy.none}</span>
        <Icon name="chevron" size={11} className="rotate-90 opacity-60" />
      </button>
      {open ? (
        <div className="native-model-menu" role="listbox" aria-label={copy.title} data-testid="model-chip-menu">
          <div className="native-model-menu-title">{copy.title}</div>
          {providers.map((provider) => (
            <button key={provider.id} type="button" role="option" aria-checked={provider.active} onClick={() => void choose(provider)}>
              <span className="grid w-3.5 place-items-center">{provider.active ? <Icon name="check" size={12} stroke={2} /> : null}</span>
              <span className="min-w-0 flex-1 truncate">{label(provider)}</span>
              <small>{provider.name}</small>
            </button>
          ))}
          {onOpenSettings ? (
            <>
              <div className="native-model-menu-sep" />
              <button type="button" onClick={() => { setOpen(false); onOpenSettings(); }}>
                <span className="grid w-3.5 place-items-center"><Icon name="settings" size={12} /></span>
                <span>{copy.settings}</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
