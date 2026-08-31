import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { MOD } from "../shortcuts";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const formatGiB = (n: number) => `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`;

const Paperclip = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
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
        delegateHint: "给 Agent 一个目标或问题…",
        steer: "Steer",
        steerHint: "补充方向或约束…",
        uploading: (name: string) => `正在准备 ${name}…`,
        stop: "Stop",
        steerAction: "Steer Agent",
        delegateAction: "Delegate task",
      }
    : {
        delegate: "Delegate",
        delegateHint: "Give the Agent a goal or problem…",
        steer: "Steer",
        steerHint: "Add direction or constraints…",
        uploading: (name: string) => `Preparing ${name}…`,
        stop: "Stop",
        steerAction: "Steer Agent",
        delegateAction: "Delegate task",
      };
  const [sizeError, setSizeError] = useState<string | null>(null);

  useEffect(() => { setSizeError(null); }, [attached]);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (!text) {
      ta.style.height = "24px";
      return;
    }
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [text, taRef]);

  const running = busy || uploading;
  const blocked = offline;

  return (
    <div
      className="agent-native-composer relative rounded-xl border border-edge bg-panel px-3 pb-2.5 pt-2.5 transition-[border-color,box-shadow] duration-fast"
      data-testid="agent-composer"
      data-agent-state={busy ? "working" : uploading ? "uploading" : "ready"}
    >
      {attached ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-elevated px-2.5 py-1.5 text-xs">
          <span className="flex min-w-0 items-center gap-1.5 text-gray-300"><Paperclip /><span className="truncate">{attached.name}</span></span>
          {uploading ? (
            <span className="flex items-center gap-1.5 text-gray-400">
              <span className="skeleton h-3 w-12" aria-hidden />
              {copy.uploading(attached.name)}
            </span>
          ) : null}
          {!uploading ? (
            <button type="button" className="ml-auto grid h-6 w-6 place-items-center rounded-md text-gray-500 hover:bg-hover hover:text-gray-300" onClick={onClearAttachment} aria-label={t("common.cancel")}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          ) : null}
        </div>
      ) : null}

      {sizeError ? <div className="mb-2 rounded-md border border-danger-border bg-danger-bg px-3 py-1.5 text-xs text-danger">{sizeError}</div> : null}

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
        className="block h-[24px] max-h-[220px] w-full resize-none bg-transparent px-1 text-prose text-gray-100 placeholder:text-gray-500 focus:outline-none"
        rows={1}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (blocked) return;
            if (busy) onSteer();
            else onSend();
          }
        }}
        placeholder={busy ? copy.steerHint : copy.delegateHint}
      />

      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenFilePicker}
          disabled={running || blocked}
          aria-label={t("attach.button")}
          title={t("attach.button")}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-gray-500 transition-colors hover:bg-hover hover:text-gray-300 disabled:cursor-default disabled:opacity-50"
        >
          <Paperclip />
        </button>

        {busy ? (
          <div className="composer-mode ml-auto" key="steer">
            <button
              type="button"
              onClick={onStop}
              aria-label={copy.stop}
              title={`${copy.stop} ${MOD}.`}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-edge bg-elevated px-2.5 text-2xs font-medium text-gray-200 transition-colors duration-fast hover:bg-hover"
            >
              <span className="grid h-3.5 w-3.5 place-items-center" aria-hidden>
                <span className="h-1.5 w-1.5 rounded-sm bg-gray-200" />
              </span>
              {copy.stop}
            </button>
            <button
              type="button"
              onClick={onSteer}
              disabled={!text.trim()}
              aria-label={copy.steerAction}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-2xs font-semibold text-accent-fg transition-[background-color,transform] duration-fast hover:bg-accent-soft active:scale-[.98] disabled:cursor-default disabled:bg-elevated disabled:text-gray-500"
            >
              {copy.steer}
            </button>
          </div>
        ) : (
          <div className="composer-mode ml-auto" key="delegate">
            <button
              type="button"
              onClick={onSend}
              disabled={uploading || blocked || (!text.trim() && !attached)}
              aria-label={copy.delegateAction}
              title={`${copy.delegateAction} ⏎`}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-2xs font-semibold text-accent-fg transition-[background-color,transform] duration-fast hover:bg-accent-soft active:scale-[.98] disabled:cursor-default disabled:bg-elevated disabled:text-gray-500"
            >
              {uploading ? <span className="skeleton h-3.5 w-3.5 rounded-full" aria-hidden /> : null}
              <span>{copy.delegate}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
