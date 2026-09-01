/**
 * Per-task composer drafts, persisted.
 *
 * Draft text is UI state: switching Tasks or reloading must not wipe unsent
 * Direction. It is kept in localStorage rather than SQLite so unsent text does
 * not enter the audit surface. Nothing here reaches a prompt, a log, or a
 * report until the user delegates, at which point the normal sanitized path
 * takes over.
 */

const KEY = "saw.drafts";
/** A draft is a question, not a document; this is far above any real one and
 * exists so a pathological paste cannot fill the storage quota. */
const MAX_DRAFT = 20_000;
/** Drafts for at most this many sessions, newest-first; the rest are dropped. */
const MAX_SESSIONS = 50;

/** The not-yet-created task. Typing into a fresh Composer is the MOST common
 * place a draft is lost — the task id does not exist until the first Direction
 * is sent — so it gets a stable key of its own rather than being dropped. */
const NEW_SESSION_KEY = "__new__";

const keyFor = (sessionId: string | null) => sessionId ?? NEW_SESSION_KEY;

type Store = Record<string, string>;

function read(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Store;
  } catch {
    // Corrupt or unavailable storage must never break the composer.
    return {};
  }
}

function write(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* quota or private mode — the draft is a convenience, not a guarantee */
  }
}

/** The saved draft for a session, or "" — never null, so the composer can use
 * it as its value directly. */
export function loadDraft(sessionId: string | null): string {
  return read()[keyFor(sessionId)] ?? "";
}

/** Save (or clear, when `text` is empty) one session's draft. */
export function saveDraft(sessionId: string | null, text: string): void {
  const key = keyFor(sessionId);
  const store = read();
  if (!text) {
    if (!(key in store)) return;
    delete store[key];
  } else {
    store[key] = text.slice(0, MAX_DRAFT);
    // Re-insert last so the key order is oldest-first and trimming drops the
    // sessions the user has not touched in longest.
    const keys = Object.keys(store);
    if (keys.length > MAX_SESSIONS) {
      for (const k of keys.slice(0, keys.length - MAX_SESSIONS)) delete store[k];
    }
  }
  write(store);
}

/** Drop a session's draft (it was sent, or the session was deleted). */
export function clearDraft(sessionId: string | null): void {
  saveDraft(sessionId, "");
}
