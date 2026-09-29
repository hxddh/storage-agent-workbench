import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ModelProvider } from "../api/types";
import { Icon } from "../components/icons";
import { useToast } from "../components/Toast";
import { StatusDot } from "../components/ui";
import { useI18n } from "../i18n";
import { useApp } from "../shell/context";

/**
 * The model chip: which model the next turn uses, backed by the real provider
 * list. With none it reads "Set up a model…"; when the runtime is unreachable it
 * reads "Runtime offline" and is not a control.
 */
export function ModelChip() {
  const { t } = useI18n();
  const app = useApp();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const models = app.models ?? [];
  const active = models.find((m) => m.active) ?? null;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (!app.online) {
    return (
      <span className="model-chip" data-state="offline" data-testid="model-chip">
        <StatusDot tone="danger" />
        {t("chip.offline")}
      </span>
    );
  }
  if (!active) {
    return (
      <button type="button" className="model-chip" data-state="none" data-testid="model-chip"
        onClick={() => app.openSettings("models")}>
        {t("chip.setUp")}
      </button>
    );
  }

  const choose = async (m: ModelProvider) => {
    setBusy(true);
    try {
      await api.activateModel(m.id);
      await app.reloadProviders();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };
  const setEffort = async (effort: "" | "low" | "medium" | "high") => {
    setBusy(true);
    try {
      await api.updateModel(active.id, { reasoning_effort: effort });
      await app.reloadProviders();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="model-chip-wrap" ref={ref}>
      <button type="button" className="model-chip" data-testid="model-chip" aria-haspopup="listbox" aria-expanded={open}
        onClick={() => setOpen(!open)} disabled={busy}>
        <span className="model-chip-name">{active.model}</span>
        {active.reasoning_capable && active.reasoning_effort ? (
          <span className="model-chip-effort">· {t(`chip.${active.reasoning_effort}`)}</span>
        ) : null}
        <Icon name="chevron" size={14} className="model-chip-caret" />
      </button>
      {open ? (
        <div className="ui-menu model-menu" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); } }}>
          <div role="listbox" aria-label={t("chip.title")}>
            {models.map((m) => (
              <button key={m.id} type="button" role="option" aria-selected={m.active} className="ui-menu-item"
                autoFocus={m.active} onClick={() => void choose(m)}>
                <span>{m.model}</span>
                <small>{m.name}</small>
                {m.active ? <Icon name="check" size={14} /> : null}
              </button>
            ))}
          </div>
          {active.reasoning_capable ? (
            <>
              <div className="ui-menu-sep" />
              <div className="model-menu-effort" role="group" aria-label={t("chip.effort")}>
                <span>{t("chip.effort")}</span>
                {(["", "low", "medium", "high"] as const).map((e) => (
                  <button key={e || "default"} type="button" aria-pressed={(active.reasoning_effort ?? "") === e}
                    onClick={() => void setEffort(e)}>
                    {e ? t(`chip.${e}`) : t("chip.effortDefault")}
                  </button>
                ))}
              </div>
            </>
          ) : null}
          <div className="ui-menu-sep" />
          <button type="button" className="ui-menu-item" onClick={() => { setOpen(false); app.openSettings("models"); }}>
            {t("chip.settings")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
