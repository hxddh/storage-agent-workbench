import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { api } from "../api";
import { Icon } from "../components/icons";
import { IconButton } from "../components/ui";
import { useToast } from "../components/Toast";
import { useI18n } from "../i18n";
import { fmtBytes } from "../lib/format";
import { useApp } from "../shell/context";
import { ModelChip } from "./ModelChip";

export const MAX_DIRECTION = 16_000;

/**
 * The only Agent input. At rest it delegates; while work is live the text
 * steers the running turn and Stop is beside it. A file makes the action
 * Delegate (a new, queued Direction), never Steer. Editing a Direction sends
 * a new version of it — a fork of the task at that point.
 */
export function Composer({ taskId, busy, onCreated, autoFocus = false }: {
  taskId: string | null;
  busy: boolean;
  onCreated?: (taskId: string) => void;
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const app = useApp();
  const toast = useToast();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  // Focus on arrival only when nothing else holds focus (⌘K may have just
  // moved it to the search field while this page was mounting).
  useEffect(() => {
    if (!autoFocus) return;
    const active = document.activeElement;
    if (!active || active === document.body) area.current?.focus();
  }, [autoFocus]);
  const picker = useRef<HTMLInputElement>(null);
  const editing = app.editing;

  useEffect(() => {
    if (app.draft.nonce === 0) return;
    setText(app.draft.text);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(app.draft.text.length, app.draft.text.length);
    });
  }, [app.draft]);

  useEffect(() => {
    if (!editing) return;
    setText(editing.text);
    requestAnimationFrame(() => area.current?.focus());
  }, [editing]);

  useEffect(() => {
    setFiles([]);
  }, [taskId]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text]);

  const trimmed = text.trim();
  const steering = busy && files.length === 0 && !editing;
  const tooLong = text.length > MAX_DIRECTION;
  const canSend = !sending && !tooLong && (trimmed.length > 0) && app.online;

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSend) return;
    setSending(true);
    try {
      if (steering && taskId) {
        await api.steer(taskId, trimmed);
      } else {
        let id = taskId;
        if (!id) {
          if (files.length === 0) {
            const snap = await api.createTask(trimmed);
            setText("");
            onCreated?.(snap.task.id);
            return;
          }
          id = (await api.createTask()).task.id;
        }
        const attachments: string[] = [];
        for (const file of files) attachments.push((await api.upload(id, file)).id);
        await api.submit(id, trimmed, {
          attachments,
          parentTurnId: editing ? (editing.parentTurnId ?? "") : undefined,
        });
        app.setEditing(null);
        if (!taskId) onCreated?.(id);
      }
      setText("");
      setFiles([]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!taskId) return;
    try {
      await api.stop(taskId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
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
          <button type="button" onClick={() => { app.setEditing(null); setText(""); }}>{t("common.cancel")}</button>
        </div>
      ) : null}
      {files.length ? (
        <ul className="composer-files" aria-label={t("composer.files")}>
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
        aria-label={busy ? t("composer.placeholderBusy") : t("composer.placeholder")}
        placeholder={busy && !editing ? t("composer.placeholderBusy") : t("composer.placeholder")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
          if (e.key === "Escape" && editing) {
            app.setEditing(null);
            setText("");
          }
        }}
        data-testid="composer-input"
        data-focus-ring="container"
      />
      {text.length > MAX_DIRECTION * 0.75 ? (
        <p className="composer-count" data-over={tooLong ? "true" : undefined}>
          {tooLong ? t("composer.tooLong", { n: MAX_DIRECTION.toLocaleString() }) : `${text.length.toLocaleString()} / ${MAX_DIRECTION.toLocaleString()}`}
        </p>
      ) : null}
      <div className="composer-bar">
        <IconButton icon="paperclip" label={t("composer.attach")} onClick={() => picker.current?.click()} />
        <input ref={picker} type="file" hidden multiple accept=".log,.txt,.csv,.tsv,.json,.jsonl,.gz,.parquet,.orc"
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} data-testid="composer-file" />
        <ModelChip />
        <span className="composer-spacer" />
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
}
