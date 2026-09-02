import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { MOD } from "../shortcuts";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const formatGiB = (n: number) => `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
const HISTORY_KEY = "saw.composerHistory";
const HISTORY_LIMIT = 20;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch { return []; }
}
function pushHistory(entry: string) {
  const trimmed = entry.trim();
  if (!trimmed) return;
  const hist = loadHistory();
  const deduped = [trimmed, ...hist.filter((h) => h !== trimmed)].slice(0, HISTORY_LIMIT);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(deduped)); } catch {}
}

const Paperclip = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

export function Composer({
  text,
  setText,
  attached,
  onClearAttachment,
  onPickFile,
  onOpenFilePicker,
  fileRef,
  taRef,
  busy,
  offline,
  uploading,
  onSend,
  onStop,
  onSteer,
}: {
  text: string;
  setText: (v: string) => void;
  attached: File | null;
  onClearAttachment: () => void;
  onPickFile: (f: File | null) => void;
  onOpenFilePicker: () => void;
  fileRef: React.RefObject<HTMLInputElement | null>;
  taRef: React.RefObject<HTMLTextAreaElement | null>;
  busy: boolean;
  offline: boolean;
  uploading: boolean;
  onSend: () => void;
  onStop: () => void;
  onSteer: () => void;
}) {
  const { t, lang } = useI18n();
  const copy = lang === "zh"
    ? {
        delegate: "委派",
        delegateHint: "Ask anything — describe a storage problem, paste an error, or drop a file…",
        steer: "Steer",
        steerHint: "Add follow-up — a constraint, a correction, or a new direction…",
        uploading: (name: string) => `正在准备 ${name}…`,
        stop: "Stop",
        steerAction: "Steer Agent",
        delegateAction: "Delegate task",
      }
    : {
        delegate: "Delegate",
        delegateHint: "Ask anything — describe a storage problem, paste an error, or drop a file…",
        steer: "Steer",
        steerHint: "Add follow-up — a constraint, a correction, or a new direction…",
        uploading: (name: string) => `Preparing ${name}…`,
        stop: "Stop",
        steerAction: "Steer Agent",
        delegateAction: "Delegate task",
      };
  const [sizeError, setSizeError] = useState<string | null>(null);
  const histIndex = useRef<number | null>(null);

  useEffect(() => { setSizeError(null); }, [attached]);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (!text) {
      ta.style.height = "28px";
      return;
    }
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
  }, [text, taRef]);

  const running = busy || uploading;
  const blocked = offline;

  const handleSend = () => {
    if (text.trim() || attached) pushHistory(text.trim() || attached?.name || "");
    histIndex.current = null;
    onSend();
  };
  const handleSteer = () => {
    if (text.trim()) pushHistory(text.trim());
    histIndex.current = null;
    onSteer();
  };

  return (
    <div
      className="group relative rounded-2xl border border-edge bg-panel px-4 pb-3 pt-3.5 transition-[border-color,background-color] duration-fast focus-within:border-edge-strong"
      data-testid="agent-composer"
      data-agent-state={busy ? "working" : uploading ? "uploading" : "ready"}
    >
      {attached ? (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-edge bg-elevated px-3 py-2 text-xs">
          <span className="flex min-w-0 items-center gap-2 text-gray-200"><Paperclip /><span className="truncate font-medium">{attached.name}</span></span>
          {uploading ? (
            <span className="flex items-center gap-2 text-gray-500">
              <span className="skeleton h-3 w-12" aria-hidden />
              {copy.uploading(attached.name)}
            </span>
          ) : null}
          {!uploading ? (
            <button type="button" className="ml-auto grid h-7 w-7 place-items-center rounded-md text-gray-500 transition-[background-color,color] duration-fast hover:bg-hover hover:text-gray-200" onClick={onClearAttachment} aria-label={t("common.cancel")}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          ) : null}
        </div>
      ) : null}

      {sizeError ? <div className="mb-3 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger">{sizeError}</div> : null}

      <input
        ref={fileRef}
        type="file"
        accept=".csv,.parquet,.tsv,.log,.txt,.gz,.json,.jsonl"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          event.target.value = "";
          if (file && file.size > MAX_UPLOAD_BYTES) {
            setSizeError(t("attach.tooLarge", { size: formatGiB(file.size) }));
            return;
          }
          setSizeError(null);
          onPickFile(file);
        }}
      />

      <textarea
        ref={taRef}
        data-focus-ring="container"
        className="block min-h-[28px] max-h-[240px] w-full resize-none bg-transparent text-base leading-6 text-gray-100 placeholder:text-gray-500 focus:outline-none"
        rows={1}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowUp" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
            const ta = event.currentTarget;
            const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
            const emptyOrStart = !text || atStart;
            if (emptyOrStart) {
              const hist = loadHistory();
              if (hist.length === 0) return;
              event.preventDefault();
              const nextIdx = histIndex.current === null ? 0 : Math.min(hist.length - 1, histIndex.current + 1);
              histIndex.current = nextIdx;
              setText(hist[nextIdx]);
              requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = hist[nextIdx].length; });
              return;
            }
          }
          if (event.key === "ArrowDown" && histIndex.current !== null) {
            event.preventDefault();
            const hist = loadHistory();
            const nextIdx = histIndex.current - 1;
            if (nextIdx < 0) {
              histIndex.current = null;
              setText("");
            } else {
              histIndex.current = nextIdx;
              setText(hist[nextIdx]);
            }
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            histIndex.current = null;
            if (blocked) return;
            if (busy) handleSteer();
            else handleSend();
          } else if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
            histIndex.current = null;
          }
        }}
        placeholder={busy ? copy.steerHint : copy.delegateHint}
      />

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenFilePicker}
          disabled={running || blocked}
          aria-label={t("attach.button")}
          title={t("attach.button")}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-gray-500 transition-[background-color,color] duration-fast hover:bg-hover hover:text-gray-200 disabled:opacity-40"
        >
          <Paperclip />
        </button>

        <div className="ml-auto flex items-center gap-2">
          {busy ? (
            <>
              <button
                type="button"
                onClick={onStop}
                aria-label={copy.stop}
                title={`${copy.stop} ${MOD}.`}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-edge bg-canvas px-3 text-xs font-medium text-gray-300 transition-[background-color,color] duration-fast hover:bg-hover hover:text-gray-100"
              >
                <span className="h-2 w-2 rounded-full bg-gray-300" aria-hidden />
                {copy.stop}
              </button>
              <button
                type="button"
                onClick={handleSteer}
                disabled={!text.trim()}
                aria-label={copy.steerAction}
                className="inline-flex h-8 items-center rounded-full bg-accent px-4 text-sm font-medium tracking-tight text-accent-fg transition-[background-color,transform] duration-fast hover:bg-accent-soft active:scale-[0.98] disabled:bg-elevated disabled:text-gray-500"
              >
                {copy.steer}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={uploading || blocked || (!text.trim() && !attached)}
              aria-label={copy.delegateAction}
              title={`${copy.delegateAction} ⏎`}
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-4 text-sm font-medium tracking-tight text-accent-fg transition-[background-color,transform] duration-fast hover:bg-accent-soft active:scale-[0.98] disabled:bg-elevated disabled:text-gray-500"
            >
              {uploading ? <span className="skeleton h-3.5 w-3.5 rounded-full" aria-hidden /> : null}
              {copy.delegate}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="opacity-70"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>
            </button>
          )}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 -bottom-px h-px bg-gradient-to-r from-transparent via-edge to-transparent opacity-0 transition-opacity duration-base group-focus-within:opacity-100" aria-hidden />
    </div>
  );
}
