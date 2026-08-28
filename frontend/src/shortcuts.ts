/**
 * The single source of truth for keyboard shortcuts.
 *
 * Before this, the key handler in App.tsx and the help sheet were two
 * independent lists: adding a shortcut in one and forgetting the other produced
 * either an undocumented shortcut or a documented one that does nothing. Both
 * now read this registry, so they cannot disagree.
 */

/** Cmd on Apple platforms, Ctrl everywhere else — rendering ⌘ to a Windows user
 * documents a chord they will press and watch fail. */
export const isApple =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");
export const MOD = isApple ? "⌘" : "Ctrl";

export type ShortcutId =
  | "palette"
  | "newChat"
  | "toggleRail"
  | "shortcuts"
  | "close"
  | "inspector"
  | "find"
  | "prevTurn"
  | "nextTurn"
  | "send"
  | "newline";

export interface Shortcut {
  id: ShortcutId;
  /** Rendered chord, e.g. ["⌘", "K"]. */
  keys: string[];
  /** i18n key for the human description. */
  labelKey: string;
  group: "global" | "chat";
  /** The modifier the handler tests. "mod" = metaKey || ctrlKey. */
  mod?: "mod" | "shift" | null;
  /** `event.key` (lower-cased for letters) the handler compares against.
   * Absent for rows that document a browser/textarea default rather than a
   * binding this app installs. */
  key?: string;
  /** False for documentation-only rows (Enter/Shift+Enter live in the composer,
   * Escape is handled per-overlay). */
  handled?: boolean;
}

export const SHORTCUTS: Shortcut[] = [
  { id: "palette", keys: [MOD, "K"], labelKey: "keys.palette", group: "global", mod: "mod", key: "k", handled: true },
  { id: "newChat", keys: [MOD, "N"], labelKey: "keys.newChat", group: "global", mod: "mod", key: "n", handled: true },
  { id: "toggleRail", keys: [MOD, "\\"], labelKey: "keys.toggleRail", group: "global", mod: "mod", key: "\\", handled: true },
  { id: "shortcuts", keys: ["?"], labelKey: "keys.thisSheet", group: "global", mod: null, key: "?", handled: true },
  { id: "close", keys: ["Esc"], labelKey: "keys.close", group: "global", mod: null, key: "Escape", handled: true },
  { id: "inspector", keys: [MOD, "I"], labelKey: "keys.inspector", group: "chat", mod: "mod", key: "i", handled: true },
  { id: "find", keys: [MOD, "F"], labelKey: "keys.find", group: "chat", mod: "mod", key: "f", handled: true },
  { id: "prevTurn", keys: ["K"], labelKey: "keys.prevTurn", group: "chat", mod: null, key: "k", handled: true },
  { id: "nextTurn", keys: ["J"], labelKey: "keys.nextTurn", group: "chat", mod: null, key: "j", handled: true },
  { id: "send", keys: ["Enter"], labelKey: "keys.send", group: "chat", handled: false },
  { id: "newline", keys: ["Shift", "Enter"], labelKey: "keys.newline", group: "chat", handled: false },
];

export const shortcutsIn = (group: Shortcut["group"]) => SHORTCUTS.filter((s) => s.group === group);

/** Does this keyboard event match the registered shortcut? */
export function matches(e: KeyboardEvent, id: ShortcutId): boolean {
  const s = SHORTCUTS.find((x) => x.id === id);
  if (!s || !s.key) return false;
  const mod = e.metaKey || e.ctrlKey;
  if (s.mod === "mod" && !mod) return false;
  // A bare-key shortcut must NOT fire while a modifier is held: ⌘? is a
  // different chord, and swallowing it would break whatever owns it.
  if (s.mod !== "mod" && mod) return false;
  return s.key.length === 1 ? e.key.toLowerCase() === s.key : e.key === s.key;
}


/**
 * Is the keystroke going into a text field?
 *
 * Bare-letter chords (`?`, `j`, `k`) must never fire while someone is typing,
 * and Escape in a field must not tear down the surrounding surface. This lived
 * as a local helper inside App's key handler; the thread's own navigation needs
 * the same rule, and two copies of "what counts as typing" is exactly the kind
 * of pair that drifts.
 */
export function isEditable(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
}
