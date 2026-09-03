/** Live actions the command palette and the native menu may invoke. Only runtime-true work. */

export type PaletteActions = {
  stop?: () => void;
  resume?: () => void;
  focusComposer?: () => void;
  /** Fill the Composer with template text and focus it (v1.16 engines). */
  prefill?: (text: string) => void;
  find?: () => void;
  review?: () => void;
  shortcuts?: () => void;
  /** Compact the task's context now (v1.12) — only for an open, idle task. */
  compact?: () => void;
  compacting?: boolean;
  busy?: boolean;
  canResume?: boolean;
  hasTask?: boolean;
};

let current: PaletteActions = {};
/** Window-level actions owned by App (v1.16: the shortcuts sheet). */
let base: PaletteActions = {};

export function publishPaletteActions(next: PaletteActions): () => void {
  current = next;
  return () => {
    if (current === next) current = {};
  };
}

export function publishBasePaletteActions(next: PaletteActions): void {
  base = next;
}

export function getPaletteActions(): PaletteActions {
  return { ...base, ...current };
}
