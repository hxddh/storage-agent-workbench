/** Live actions the command palette may invoke. Only runtime-true work. */

export type PaletteActions = {
  stop?: () => void;
  resume?: () => void;
  focusComposer?: () => void;
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
