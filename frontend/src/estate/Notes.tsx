import { useEffect, useState } from "react";
import { api } from "../api";
import type { Note } from "../api/types";
import { Button, IconButton } from "../components/ui";
import { useToast } from "../components/Toast";
import { useI18n } from "../i18n";
import { timeAgo } from "../lib/time";
import { useApp } from "../shell/context";

type Scope = { providerId?: string; bucket?: string };

/**
 * Notes kept about the estate, an account or a bucket — by the user, by the
 * Agent (the `note` tool) or as the reason a risk was accepted. Every note is
 * visible, editable and deletable; the most recent reach every task.
 */
export function Notes({ scope, initial, accountOnly = false }: { scope: Scope; initial?: Note[]; accountOnly?: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const [notes, setNotes] = useState<Note[] | null>(initial ?? null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState("");

  useEffect(() => {
    if (initial) { setNotes(initial); return; }
    let live = true;
    const load = scope.providerId && accountOnly
      ? api.buckets(scope.providerId).then((r) => r.notes)
      : listNotes(scope);
    load.then((n) => live && setNotes(n)).catch(() => live && setNotes([]));
    return () => { live = false; };
  }, [scope.providerId, scope.bucket, initial, accountOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (err: unknown) => toast.error(err instanceof Error ? err.message : String(err));
  const shown = notes ?? [];

  const add = async () => {
    const text = draft.trim();
    if (!text) return;
    try {
      const n = await api.addNote(text, scope.providerId, scope.bucket);
      setNotes([n, ...(notes ?? [])]);
      setDraft("");
    } catch (err) { fail(err); }
  };
  const save = async (id: string) => {
    try {
      const n = await api.editNote(id, edit.trim());
      setNotes((notes ?? []).map((x) => (x.id === id ? n : x)));
      setEditing(null);
    } catch (err) { fail(err); }
  };
  const remove = async (id: string) => {
    try {
      await api.deleteNote(id);
      setNotes((notes ?? []).filter((x) => x.id !== id));
    } catch (err) { fail(err); }
  };

  return (
    <div className="notes" data-testid="notes">
      {shown.length ? (
        <ul className="note-list">
          {shown.map((n) => (
            <li key={n.id} className="note" data-source={n.source} data-testid="note">
              {editing === n.id ? (
                <form className="note-edit" onSubmit={(e) => { e.preventDefault(); void save(n.id); }}>
                  <textarea className="ui-input" value={edit} maxLength={1000} autoFocus rows={2}
                    aria-label={t("notes.edit")} onChange={(e) => setEdit(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); }} />
                  <div className="note-actions">
                    <Button size="sm" type="submit" disabled={!edit.trim()}>{t("notes.save")}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>{t("common.cancel")}</Button>
                  </div>
                </form>
              ) : (
                <>
                  <p className="note-text">{n.text}</p>
                  <p className="note-meta">
                    {[t(`notes.by.${n.source}`), n.bucket && !scope.bucket ? n.bucket : null, timeAgo(n.updated_at, t)]
                      .filter(Boolean).join(" · ")}
                    {n.task_id ? <> · <TaskLink id={n.task_id} /></> : null}
                  </p>
                  <div className="note-tools">
                    <IconButton size="sm" icon="compose" label={t("notes.edit")} onClick={() => { setEditing(n.id); setEdit(n.text); }} />
                    <IconButton size="sm" icon="x" label={t("notes.delete")} onClick={() => void remove(n.id)} />
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : notes ? <p className="quiet-note">{t("notes.empty")}</p> : null}
      <form className="note-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <textarea className="ui-input" value={draft} maxLength={1000} rows={2} placeholder={t("notes.placeholder")}
          aria-label={t("notes.add")} data-testid="note-input" onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void add(); } }} />
        <Button size="sm" type="submit" disabled={!draft.trim()} data-testid="note-add">{t("notes.add")}</Button>
      </form>
    </div>
  );
}

function listNotes(scope: Scope): Promise<Note[]> {
  const q = new URLSearchParams();
  if (scope.providerId) q.set("provider_id", scope.providerId);
  if (scope.bucket) q.set("bucket", scope.bucket);
  q.set("exact", "true"); // only this scope's own notes, filtered by the Sidecar
  return api.notes(q.toString());
}

function TaskLink({ id }: { id: string }) {
  const { t } = useI18n();
  const app = useApp();
  return <button type="button" className="link" onClick={() => app.openTask(id)}>{t("estate.task")}</button>;
}
