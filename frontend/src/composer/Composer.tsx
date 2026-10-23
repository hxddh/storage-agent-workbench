import { memo, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { api } from "../api";
import type { Attachment } from "../api/types";
import { Icon } from "../components/icons";
import { IconButton } from "../components/ui";
import { useToast } from "../components/Toast";
import { describeError } from "../lib/errors";
import { useI18n } from "../i18n";
import { fmtBytes } from "../lib/format";
import { useApp } from "../shell/context";
import { ModelChip } from "./ModelChip";

export const MAX_DIRECTION = 16_000;

/**
 * The only Agent input. At rest it sends; while work is live it adds to the
 * running request. A file makes a new, queued Direction, never a steer.
 * Editing a Direction sends a new version of it — a fork that keeps its files.
 *
 * There is deliberately no estate picker: the user names what they mean, and
 * the Agent resolves it from the estate. Storage is a capability, not a form.
 */
export const Composer = memo(function Composer({ taskId, busy, onCreated, autoFocus = false }: {
  taskId: string | null;
  busy: boolean;
  onCreated?: (taskId: string) => void;
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const app = useApp();
  const toast = useToast();
  const draftKey = taskId ?? "home";
  const [text, setText] = useState(() => app.drafts.get(draftKey));
  const [files, setFiles] = useState<File[]>([]);
  const [kept, setKept] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const uploadAbort = useRef<AbortController | null>(null);
  const cancelled = useRef(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const lastKey = useRef(draftKey);
  const textRef = useRef(text);
  textRef.current = text;
  const editing = app.editing;

  useEffect(() => {
    if (!autoFocus) return;
    // On a phone the keyboard is the user's decision; an empty home does not
    // steal the first tap or resize the window on launch.
    if (window.matchMedia?.("(max-width: 720px)").matches) return;
    const activeEl = document.activeElement;
    if (!activeEl || activeEl === document.body) area.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (!editing) return;
    setFiles([]);
    setText(editing.text);
    setKept(editing.attachments ?? []);
    requestAnimationFrame(() => area.current?.focus());
  }, [editing]);

  useEffect(() => {
    if (lastKey.current === draftKey) return;
    app.drafts.set(lastKey.current, textRef.current);
    lastKey.current = draftKey;
    setText(app.drafts.get(draftKey));
    setFiles([]);
    setKept([]);
  }, [draftKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => app.drafts.set(lastKey.current, textRef.current), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text]);

  const trimmed = text.trim();
  // A file always makes a Direction; text alone can steer a running Turn.
  const steering = busy && files.length === 0 && kept.length === 0 && !editing;
  const tooLong = text.length > MAX_DIRECTION;
  const noModel = app.models !== null && !app.models.some((m) => m.active);
  const canSend = !sending && !tooLong && trimmed.length > 0 && app.online && (steering || !noModel);
  const writing = trimmed.length > 0;
  useEffect(() => { if (noModel && writing) void app.reloadProviders(); }, [noModel, writing]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSend) return;
    setSending(true);
    setUploadPct(null);
    cancelled.current = false;
    let created: string | null = null;
    try {
      if (steering && taskId) {
        await api.steer(taskId, trimmed);
      } else {
        let id = taskId;
        if (!id) {
          if (files.length === 0) {
            const snap = await api.createTask(trimmed);
            setText("");
            app.drafts.clear(draftKey);
            onCreated?.(snap.task.id);
            return;
          }
          // A file needs a task to belong to. If anything below fails, the
          // empty task is removed again instead of becoming an orphan row.
          id = (await api.createTask()).task.id;
          created = id;
        }
        const attachments: string[] = kept.map((a) => a.dataset_id);
        if (files.length) {
          const controller = new AbortController();
          uploadAbort.current = controller;
          setUploadPct(0);
          for (const file of files) {
            attachments.push((await api.upload(id, file, { signal: controller.signal, onProgress: setUploadPct })).id);
          }
        }
        await api.submit(id, trimmed, {
          attachments,
          parentTurnId: editing ? (editing.parentTurnId ?? "") : undefined,
        });
        app.setEditing(null);
        created = null; // it has a Direction now; a later error is not an orphan
        if (!taskId) onCreated?.(id);
      }
      setText("");
      app.drafts.clear(draftKey);
      setFiles([]);
      setKept([]);
    } catch (err) {
      if (created) await api.deleteTask(created).catch(() => {});
      if (!cancelled.current) toast.error(describeError(err, t));
    } finally {
      uploadAbort.current = null;
      setUploadPct(null);
      setSending(false);
    }
  };

  const stop = async () => {
    if (!taskId) return;
    try {
      await api.stop(taskId);
    } catch (err) {
      toast.error(describeError(err, t));
    }
  };

  const addFiles = (list: FileList | null) => {
    if (!list?.length) return;
    setFiles((prev) => [...prev, ...Array.from(list)].slice(0, 8));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const label = sending && files.length ? t("composer.uploading") : steering ? t("composer.steer") : t("composer.send");
  const placeholder = busy && !editing ? t("composer.placeholderBusy")
    : taskId ? t("composer.followUp") : t("composer.placeholder");

  return (
    <form
      className="composer"
      data-busy={busy ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined}
      onSubmit={send}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      data-testid="composer"
    >
      {editing ? (
        <div className="composer-editing">
          <Icon name="compose" size={14} />
          <span>{t("composer.editing")}</span>
          <button type="button" onClick={() => { app.setEditing(null); setText(""); app.drafts.clear(draftKey); setKept([]); setFiles([]); }}>{t("common.cancel")}</button>
        </div>
      ) : null}
      {files.length || kept.length ? (
        <ul className="composer-files" aria-label={t("composer.files")}>
          {kept.map((a) => (
            <li key={a.dataset_id} data-testid="kept-attachment">
              <Icon name="file" size={14} />
              <span>{a.filename}</span>
              <IconButton icon="x" size="sm" label={t("composer.remove", { name: a.filename })}
                onClick={() => setKept(kept.filter((x) => x.dataset_id !== a.dataset_id))} />
            </li>
          ))}
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <Icon name="file" size={14} />
              <span>{f.name}</span>
              <small>{fmtBytes(f.size)}</small>
              <IconButton icon="x" size="sm" label={t("composer.remove", { name: f.name })}
                onClick={() => setFiles(files.filter((_, j) => j !== i))} />
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={area}
        value={text}
        rows={1}
        aria-label={placeholder}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
          if (e.key === "Escape" && editing) {
            app.setEditing(null);
            setText("");
            app.drafts.clear(draftKey);
            setKept([]);
            setFiles([]);
          }
        }}
        data-testid="composer-input"
        data-focus-ring="container"
      />
      {uploadPct !== null ? (
        <p className="composer-progress" role="status">{t("composer.uploadProgress", { pct: Math.round(uploadPct * 100) })}</p>
      ) : null}
      {text.length > MAX_DIRECTION * 0.75 ? (
        <p className="composer-count" data-over={tooLong ? "true" : undefined}>
          {tooLong ? t("composer.tooLong", { n: MAX_DIRECTION.toLocaleString() }) : `${text.length.toLocaleString()} / ${MAX_DIRECTION.toLocaleString()}`}
        </p>
      ) : null}
      <div className="composer-bar">
        <IconButton icon="paperclip" label={t("composer.attach")} data-testid="composer-attach"
          onClick={() => filePicker.current?.click()} />
        <input ref={filePicker} type="file" hidden multiple accept=".log,.txt,.csv,.tsv,.json,.jsonl,.gz,.parquet,.orc"
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} data-testid="composer-file" />
        <ModelChip />
        <span className="composer-spacer" />
        {sending && files.length ? (
          <IconButton icon="x" label={t("common.cancel")} onClick={() => { cancelled.current = true; uploadAbort.current?.abort(); }}
            data-testid="composer-cancel-upload" />
        ) : null}
        {busy ? (
          <IconButton icon="stop" label={t("composer.stop")} className="composer-stop" onClick={() => void stop()}
            data-testid="composer-stop" />
        ) : null}
        <IconButton type="submit" icon={steering ? "arrowRight" : "arrowUp"} label={label} className="composer-send"
          data-ready={canSend ? "true" : undefined} disabled={!canSend} data-testid="composer-send" />
      </div>
      {dragging ? <div className="composer-drop" aria-hidden>{t("composer.drop")}</div> : null}
    </form>
  );
});
