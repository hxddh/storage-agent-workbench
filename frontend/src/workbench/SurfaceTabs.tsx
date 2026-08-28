import { useRef, type KeyboardEvent } from "react";
import type { WorkSurface } from "./model";
import { useWorkbenchCopy } from "./copy";

const SURFACE_IDS: WorkSurface[] = ["timeline", "evidence", "runs", "report"];

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
  const copy = useWorkbenchCopy();
  const surfaces = SURFACE_IDS.map((id) => ({ id, ...copy.surfaces[id] }));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const enabled = surfaces.filter((surface) => surface.id === "timeline" || sessionReady);
    const index = Math.max(0, enabled.findIndex((surface) => surface.id === active));
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = enabled[(index + delta + enabled.length) % enabled.length];
    const absoluteIndex = surfaces.findIndex((surface) => surface.id === next.id);
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
      {surfaces.map((surface, index) => {
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
