import { useState } from "react";
import { useI18n } from "../i18n";
import type { PlanStep } from "../types";
import { Icon } from "./icons";

/**
 * The plan the model owns (v1.12, Codex parity): a quiet bordered checklist
 * rendered ONLY from a `plan` turn item — the runtime's `update_plan` tool
 * replaced its list. A check for a completed step, a pulse for the one in
 * progress, a hollow dot for the rest. Once every step is completed and the
 * turn is no longer live it folds to one line ("Plan · 4/4"); click opens it.
 * The UI never invents a step.
 */
export function PlanCard({ steps, live = false }: { steps: PlanStep[]; live?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<boolean | null>(null);
  if (!steps.length) return null;
  const done = steps.filter((step) => step.status === "completed").length;
  const finished = done === steps.length;
  const collapsed = !(open ?? !(finished && !live));
  const summary = t("plan.progress", { done, total: steps.length });
  return (
    <section
      className="plan-card"
      data-testid="plan-card"
      data-collapsed={collapsed ? "true" : "false"}
      data-done={done}
      data-total={steps.length}
      aria-label={t("plan.title")}
    >
      <button
        type="button"
        className="plan-card-head"
        aria-expanded={!collapsed}
        onClick={() => setOpen(collapsed)}
        data-testid="plan-head"
      >
        <Icon name="chevron" size={12} className="chevron" />
        <span>{summary}</span>
      </button>
      {!collapsed ? (
        <ol className="plan-card-steps">
          {steps.map((step, index) => (
            <li key={index} className="plan-step" data-testid="plan-step" data-status={step.status}>
              <span className="plan-step-mark" aria-hidden>
                {step.status === "completed" ? (
                  <Icon name="check" size={11} stroke={2.2} />
                ) : step.status === "in_progress" ? (
                  <span className="working-mark" style={{ width: 6, height: 6 }} />
                ) : (
                  <span className="plan-step-dot" />
                )}
              </span>
              <span className="plan-step-text">{step.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
