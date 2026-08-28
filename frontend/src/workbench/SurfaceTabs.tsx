import { useRef, type KeyboardEvent } from "react";
import type { WorkSurface } from "./model";

const SURFACES: Array<{ id: WorkSurface; label: string; hint: string }> = [
  { id: "timeline", label: "Timeline", hint: "Conversation and decisions" },
  { id: "evidence", label: "Evidence", hint: "Facts, findings and files" },
  { id: "runs", label: "Runs", hint: "Auditable execution" },
  { id: "report", label: "Report", hint: "Durable investigation output" },
];

export function SurfaceTabs({
  active,
  sessionReady,
  onChange,
}: {
  active: WorkSurface;
  sessionReady: boolean;
  onChange: (surface: WorkSurface) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const enabled = SURFACES.filter((surface) => surface.id === "timeline" || sessionReady);
    const index = Math.max(0, enabled.findIndex((surface) => surface.id === active));
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = enabled[(index + delta + enabled.length) % enabled.length];
    const absoluteIndex = SURFACES.findIndex((surface) => surface.id === next.id);
    event.preventDefault();
    onChange(next.id);
    requestAnimationFrame(() => refs.current[absoluteIndex]?.focus());
  };

  return (
    <div
      role="tablist"
      aria-label="Work surfaces"
      className="workbench-surface-tabs"
      onKeyDown={onKeyDown}
      data-testid="work-surface-tabs"
    >
      {SURFACES.map((surface, index) => {
        const disabled = surface.id !== "timeline" && !sessionReady;
        const selected = active === surface.id;
        return (
          <button
            key={surface.id}
            ref={(node) => { refs.current[index] = node; }}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`work-surface-${surface.id}`}
            disabled={disabled}
            title={surface.hint}
            className="workbench-surface-tab"
            data-surface={surface.id}
            onClick={() => onChange(surface.id)}
          >
            {surface.label}
          </button>
        );
      })}
    </div>
  );
}
