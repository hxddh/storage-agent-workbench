/** Live actions the command palette and the native menu may invoke. Only runtime-true work. */

export type PaletteActions = {
  stop?: () => void;
  resume?: () => void;
  focusComposer?: () => void;
  find?: () => void;
  review?: () => void;
  /** Compact the task's context now (v1.12) — only for an open, idle task. */
  compact?: () => void;
  compacting?: boolean;
  busy?: boolean;
  canResume?: boolean;
  hasTask?: boolean;
};

let current: PaletteActions = {};

export function publishPaletteActions(next: PaletteActions): () => void {
  current = next;
  return () => {
    if (current === next) current = {};
  };
}

export function getPaletteActions(): PaletteActions {
  return current;
}
