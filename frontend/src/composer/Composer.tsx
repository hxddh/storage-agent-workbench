import { memo, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { api } from "../api";
import type { Attachment, ContextRef, Issue } from "../api/types";
import { Icon } from "../components/icons";
import { IconButton } from "../components/ui";
import { useToast } from "../components/Toast";
import { useI18n } from "../i18n";
import { fmtBytes } from "../lib/format";
import { useApp } from "../shell/context";
import { ModelChip } from "./ModelChip";

export const MAX_DIRECTION = 16_000;

type Option = ContextRef & { label: string; hint: string };
type Selected = Option;

function keyOf(c: ContextRef): string {
  return [c.kind, c.provider_id, c.bucket ?? "", c.issue_id ?? ""].join(":");
}

function refOf(c: Selected | ContextRef): ContextRef {
  return { kind: c.kind, provider_id: c.provider_id, ...(c.bucket ? { bucket: c.bucket } : {}),
    ...(c.issue_id ? { issue_id: c.issue_id } : {}) };
}

/**
 * The only Agent input. At rest it sends; while work is live it adds to the
 * running request. A file or a context chip makes it a new, queued Direction,
 * never a steer. Editing a Direction sends a new version of it — a fork.
 */
export const Composer = memo(function Composer({ taskId, busy, onCreated, autoFocus = false }: {
  taskId: string | null;
  busy: boolean;
  onCreated?: (taskId: string) => void;
  autoFocus?: boolean;
}) {
  const { t, lang } = useI18n();
  const app = useApp();
  const toast = useToast();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [kept, setKept] = useState<Attachment[]>([]);
  const [context, setContext] = useState<Selected[]>([]);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [picker, setPicker] = useState(false);
  const [contextLoading, setContextLoading] = useState(false);
  const [menu, setMenu] = useState(false);
  const [options, setOptions] = useState<Option[]>([]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const contextInput = useRef<HTMLInputElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const editing = app.editing;
  /** Turn a stored ref (with its estate names) or a draft ref into a chip. */
  const selectedFrom = (refs: Array<ContextRef & { account?: string; title?: string }>): Selected[] => refs.map((r) => {
    const account = r.account ?? app.clouds?.find((c) => c.id === r.provider_id)?.name ?? r.provider_id;
    const label = r.kind === "account" ? account : r.kind === "bucket" ? (r.bucket ?? account) : (r.title ?? t("context.issue"));
    const hint = r.kind === "account" ? t("context.accountHint") : account;
    return { kind: r.kind, provider_id: r.provider_id, ...(r.bucket ? { bucket: r.bucket } : {}),
      ...(r.issue_id ? { issue_id: r.issue_id } : {}), label, hint };
  });
  // Focus on arrival only when nothing else holds focus (⌘K may have just
  // moved it to the search field while this page was mounting).
  useEffect(() => {
    if (!autoFocus) return;
    // On a phone the keyboard is the user's decision; an empty home does not
    // steal the first tap or resize the window on launch.
    if (window.matchMedia?.("(max-width: 720px)").matches) return;
    const activeEl = document.activeElement;
    if (!activeEl || activeEl === document.body) area.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (app.draft.nonce === 0) return;
    setText(app.draft.text);
    setContext(selectedFrom(app.draft.context ?? []));
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(app.draft.text.length, app.draft.text.length);
    });
  }, [app.draft]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!editing) return;
    setText(editing.text);
    // A fork keeps the estate focus it was written with; the refs are resolved
    // names already stored on the message, not a second lookup.
    setContext(selectedFrom(editing.context ?? []));
    setKept(editing.attachments ?? []);
    requestAnimationFrame(() => area.current?.focus());
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setFiles([]);
    setKept([]);
    setContext([]);
    setPicker(false);
    setMenu(false);
  }, [taskId]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text]);

  const trimmed = text.trim();
  // Context applies to a request, not a steer: with a chip (or a file) the
  // Composer always creates / queues a Direction.
  const steering = busy && files.length === 0 && kept.length === 0 && context.length === 0 && !editing;
  const tooLong = text.length > MAX_DIRECTION;
  const noModel = app.models !== null && !app.models.some((m) => m.active);
  const canSend = !sending && !tooLong && trimmed.length > 0 && app.online && (steering || !noModel);
  const writing = trimmed.length > 0;
  useEffect(() => { if (noModel && writing) void app.reloadProviders(); }, [noModel, writing]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Accounts, known buckets and open issues — one searchable estate, not a second page. */
  const loadContext = async () => {
    setContextLoading(true);
    try {
      const clouds = app.clouds ?? [];
      if (!clouds.length) { setOptions([]); return; }
      const [estate, buckets] = await Promise.all([
        api.estate(lang).catch(() => null),
        Promise.all(clouds.map((c) => api.buckets(c.id).catch(() => ({ buckets: [], notes: [] })))),
      ]);
      const names = new Map(clouds.map((c) => [c.id, c.name]));
      const out: Option[] = clouds.map((c) => ({ kind: "account", provider_id: c.id, label: c.name,
        hint: t("context.accountHint") }));
      for (const [i, res] of buckets.entries()) {
        const provider = clouds[i];
        for (const b of res.buckets) {
          out.push({ kind: "bucket", provider_id: provider.id, bucket: b.bucket, label: b.bucket,
            hint: names.get(provider.id) ?? "" });
        }
      }
      for (const issue of (estate?.issues ?? []) as Issue[]) {
        out.push({ kind: "issue", provider_id: issue.provider_id, bucket: issue.bucket, issue_id: issue.id,
          label: issue.title, hint: `${names.get(issue.provider_id) ?? issue.provider_name} · ${issue.bucket}` });
      }
      const seen = new Set<string>();
      setOptions(out.filter((o) => (seen.has(keyOf(o)) ? false : (seen.add(keyOf(o)), true))));
    } finally {
      setContextLoading(false);
    }
  };

  const openContext = () => {
    setMenu(false);
    setPicker(true);
    setQuery("");
    setActive(0);
    void loadContext();
  };

  useEffect(() => {
    if (!picker && !menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPicker(false);
      setMenu(false);
      area.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picker, menu]);

  useEffect(() => {
    if (!picker && !menu) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(".composer-tools, .context-popover")) return;
      setPicker(false);
      setMenu(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [picker, menu]);

  useEffect(() => {
    if (!picker) return;
    const id = requestAnimationFrame(() => contextInput.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [picker]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (q ? options.filter((o) => `${o.label} ${o.hint} ${o.kind}`.toLowerCase().includes(q)) : options).slice(0, 40);
  }, [options, query]);

  useEffect(() => { setActive(0); }, [query]);

  const selectedKeys = useMemo(() => new Set(context.map(keyOf)), [context]);
  const choose = (o: Option) => {
    if (!selectedKeys.has(keyOf(o))) setContext((prev) => [...prev, o].slice(0, 8));
    setPicker(false);
    setQuery("");
    requestAnimationFrame(() => area.current?.focus());
  };

  const remove = (c: ContextRef) => setContext((prev) => prev.filter((x) => keyOf(x) !== keyOf(c)));
  const refs = context.map(refOf);

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
            const snap = await api.createTask(trimmed, "user", refs);
            setText("");
            setContext([]);
            onCreated?.(snap.task.id);
            return;
          }
          id = (await api.createTask()).task.id;
        }
        const attachments: string[] = kept.map((a) => a.dataset_id);
        for (const file of files) attachments.push((await api.upload(id, file)).id);
        await api.submit(id, trimmed, {
          attachments,
          context: refs,
          parentTurnId: editing ? (editing.parentTurnId ?? "") : undefined,
        });
        app.setEditing(null);
        if (!taskId) onCreated?.(id);
      }
      setText("");
      setFiles([]);
      setKept([]);
      setContext([]);
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

  const onText = (value: string) => {
    // `@` at a word boundary opens the one estate picker; it is consumed, not
    // left in the Direction.
    if (value.endsWith("@") && (value.length === 1 || /\s$/.test(value.slice(0, -1)))) {
      setText(value.slice(0, -1));
      setPicker(true);
      setQuery("");
      setActive(0);
      void loadContext();
      return;
    }
    setText(value);
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
          <button type="button" onClick={() => { app.setEditing(null); setText(""); setContext([]); setKept([]); }}>{t("common.cancel")}</button>
        </div>
      ) : null}
      {context.length ? (
        <ul className="composer-context" aria-label={t("context.selected")}>
          {context.map((c) => (
            <li key={keyOf(c)} className="context-chip" data-kind={c.kind}>
              <span className="context-kind">{t(`context.${c.kind}`)}</span>
              <span className="context-label">{c.label}</span>
              <IconButton icon="x" size="sm" label={t("context.remove", { name: c.label })} onClick={() => remove(c)} />
            </li>
          ))}
        </ul>
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
      {picker ? (
        <div className="context-popover" data-testid="context-picker">
          <div className="context-search">
            <Icon name="search" size={14} />
            <input ref={contextInput} value={query} placeholder={t("context.search")} aria-label={t("context.search")}
              role="combobox" aria-autocomplete="list" aria-controls={!contextLoading && filtered.length ? "context-options" : undefined}
              aria-expanded="true" aria-busy={contextLoading}
              aria-activedescendant={!contextLoading && filtered[active] ? `context-${keyOf(filtered[active])}` : undefined}
              onChange={(e) => setQuery(e.target.value)}
              data-focus-ring="container"
              onKeyDown={(e) => {
                if (e.key === "Escape") { setPicker(false); area.current?.focus(); }
                else if (e.key === "ArrowDown") { e.preventDefault(); setActive((n) => Math.min(filtered.length - 1, n + 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setActive((n) => Math.max(0, n - 1)); }
                else if (e.key === "Enter" && !contextLoading && filtered[active]) { e.preventDefault(); choose(filtered[active]); }
              }} />
          </div>
          {contextLoading ? <p className="quiet-note context-empty">{t("storage.loading")}</p>
            : filtered.length ? (
            <ul className="context-options" id="context-options" role="listbox" aria-label={t("context.search")}>
              {filtered.map((o, i) => (
                <li key={keyOf(o)}>
                  <button type="button" role="option" id={`context-${keyOf(o)}`} aria-selected={i === active} data-active={i === active ? "true" : undefined}
                    disabled={selectedKeys.has(keyOf(o))} onClick={() => choose(o)}
                    onMouseEnter={() => setActive(i)}>
                    <span className="context-option-kind">{t(`context.${o.kind}`)}</span>
                    <span className="context-option-label">{o.label}</span>
                    <small>{o.hint}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="quiet-note context-empty">{t("context.empty")}</p>}
        </div>
      ) : null}
      <textarea
        ref={area}
        value={text}
        rows={1}
        aria-label={placeholder}
        placeholder={placeholder}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
          if (e.key === "Escape" && (picker || editing)) {
            if (picker) setPicker(false);
            else { app.setEditing(null); setText(""); }
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
        <div className="composer-tools">
          <IconButton icon="plus" label={t("composer.add")} aria-expanded={menu}
            data-testid="composer-plus" onClick={() => { setMenu((v) => !v); setPicker(false); }} />
          {menu ? (
            <div className="composer-menu" role="menu" aria-label={t("composer.add")} data-testid="composer-menu">
              <button type="button" role="menuitem" onClick={() => { setMenu(false); filePicker.current?.click(); }}>
                <Icon name="paperclip" size={15} /><span>{t("composer.attach")}</span>
              </button>
              <button type="button" role="menuitem" onClick={openContext}>
                <Icon name="search" size={15} /><span>{t("context.add")}</span><kbd>@</kbd>
              </button>
            </div>
          ) : null}
        </div>
        <input ref={filePicker} type="file" hidden multiple accept=".log,.txt,.csv,.tsv,.json,.jsonl,.gz,.parquet,.orc"
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
});
