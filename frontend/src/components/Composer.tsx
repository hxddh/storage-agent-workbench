import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { MOD } from "../shortcuts";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const formatGiB = (n: number) => `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`;

export type Slash = { cmd: string; labelKey: string; promptKey?: string; action?: "report" | "pickFile" };
const SLASH: Slash[] = [
  { cmd: "diagnose", labelKey: "sugg.diagnose", promptKey: "prompt.diagnose" },
  { cmd: "logs", labelKey: "sugg.logs", action: "pickFile" },
  { cmd: "inventory", labelKey: "sugg.inventory", action: "pickFile" },
  { cmd: "checkup", labelKey: "sugg.checkup", promptKey: "prompt.checkup" },
  { cmd: "cost", labelKey: "sugg.cost", promptKey: "prompt.cost" },
  { cmd: "drift", labelKey: "sugg.drift", promptKey: "prompt.drift" },
  { cmd: "account", labelKey: "sugg.account", promptKey: "prompt.account" },
  { cmd: "report", labelKey: "slash.report", action: "report" },
];

const Spark = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2z" />
  </svg>
);

const Paperclip = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

export function Composer({
  text,
  setText,
  attached,
  attachType,
  setAttachType,
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
  modelName,
  onOpenSettings,
  onSlashReport,
  onSlashPickFile,
}: {
  text: string;
  setText: (v: string) => void;
  attached: File | null;
  attachType: "inventory" | "access_log" | null;
  setAttachType: (t: "inventory" | "access_log") => void;
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
  modelName: string | null;
  onOpenSettings: () => void;
  onSlashReport: () => void;
  onSlashPickFile: (type: "inventory" | "access_log") => void;
}) {
  const { t, lang } = useI18n();
  const copy = lang === "zh"
    ? {
        delegate: "委派任务",
        delegateHint: "给 Agent 一个目标、问题或需要完成的工作…",
        working: "Agent 工作中",
        workingHint: "Agent 正在执行；你可以继续补充方向或约束",
        steer: "Steer",
        steerHint: "Steer Agent：补充方向、约束或下一步…",
        model: "Model",
        commands: "输入 / 使用任务命令",
        commandMenu: "任务命令",
        uploading: (name: string) => `正在准备 ${name}…`,
        modelSettings: "模型设置",
        steerCurrent: "Steer 当前执行",
        newline: "换行",
        stop: "Stop",
        steerAction: "Steer Agent",
        steerActionHint: "把新的方向或约束加入当前执行，同时保留已经完成的工作",
        delegateAction: "Delegate task",
      }
    : {
        delegate: "Delegate",
        delegateHint: "Give the Agent a goal, problem, or job to complete…",
        working: "Agent working",
        workingHint: "The Agent is executing; add direction or constraints at any time",
        steer: "Steer",
        steerHint: "Steer the Agent with new direction, constraints, or a next step…",
        model: "Model",
        commands: "Type / for task commands",
        commandMenu: "Task commands",
        uploading: (name: string) => `Preparing ${name}…`,
        modelSettings: "Model settings",
        steerCurrent: "Steer current execution",
        newline: "new line",
        stop: "Stop",
        steerAction: "Steer Agent",
        steerActionHint: "Add direction or constraints to the current execution while preserving completed work",
        delegateAction: "Delegate task",
      };
  const [slashSel, setSlashSel] = useState(0);
  const [sizeError, setSizeError] = useState<string | null>(null);
  const [slashSuppressed, setSlashSuppressed] = useState(false);

  useEffect(() => { setSlashSuppressed(false); }, [text]);
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

  const slashQ = /^\/(\w*)$/.exec(text)?.[1];
  const slashItems = slashQ !== undefined ? SLASH.filter((item) => item.cmd.startsWith(slashQ.toLowerCase())) : [];
  const slashOpen = slashItems.length > 0 && !slashSuppressed;
  const slashIdx = Math.min(slashSel, slashItems.length - 1);
  const running = busy || uploading;
  const blocked = offline;

  const selectSlash = (item: Slash) => {
    if (blocked && item.action) return;
    if (item.action === "report") {
      setText("");
      onSlashReport();
    } else if (item.action === "pickFile") {
      setText("");
      onSlashPickFile(item.cmd === "logs" ? "access_log" : "inventory");
    } else if (item.promptKey) {
      setText(t(item.promptKey));
      requestAnimationFrame(() => taRef.current?.focus());
    }
    setSlashSel(0);
  };

  return (
    <div
      className="group/composer agent-native-composer relative rounded-xl border border-edge bg-panel px-3 pb-2.5 pt-2.5 shadow-elev transition-[border-color,box-shadow] duration-fast focus-within:border-edge-strong focus-within:shadow-pop focus-within:ring-4 focus-within:ring-accent/10"
      data-testid="agent-composer"
      data-agent-state={busy ? "working" : uploading ? "uploading" : "ready"}
    >
      <div className="mb-2 flex items-center gap-2 px-1 text-2xs">
        <span className={`h-1.5 w-1.5 rounded-full ${busy || uploading ? "working-mark !h-1.5 !w-1.5" : "bg-success"}`} aria-hidden />
        <strong className="font-medium text-gray-300">{busy || uploading ? copy.working : copy.delegate}</strong>
        <span className="min-w-0 truncate text-gray-500">{busy || uploading ? copy.workingHint : copy.commands}</span>
      </div>

      {slashOpen ? (
        <div className="absolute bottom-full left-1 right-1 z-floating mb-2 overflow-hidden rounded-xl border border-edge bg-panel shadow-pop animate-fade-in">
          <div className="px-3 py-1.5 text-2xs font-medium uppercase tracking-wider text-gray-500">{copy.commandMenu}</div>
          {slashItems.map((item, index) => (
            <button
              key={item.cmd}
              type="button"
              onMouseEnter={() => setSlashSel(index)}
              onClick={() => selectSlash(item)}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${index === slashIdx ? "bg-hover" : "hover:bg-hover/50"}`}
            >
              <span className="font-mono text-xs text-accent-soft">/{item.cmd}</span>
              <span className="text-sm text-gray-300">{t(item.labelKey)}</span>
            </button>
          ))}
        </div>
      ) : null}

      {attached ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-elevated px-2.5 py-1.5 text-xs">
          <span className="flex min-w-0 items-center gap-1.5 text-gray-300"><Paperclip /><span className="truncate">{attached.name}</span></span>
          {uploading ? (
            <span className="flex items-center gap-1.5 text-gray-400">
              <span className="skeleton h-3 w-12" aria-hidden />
              {copy.uploading(attached.name)}
            </span>
          ) : (
            <span className="flex items-center gap-1">
              {!attachType ? <span className="text-gray-500">{t("attach.pickType")}</span> : null}
              {(["inventory", "access_log"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={attachType === kind}
                  data-testid={`attach-type-${kind}`}
                  onClick={() => setAttachType(kind)}
                  className={`rounded-full border px-2 py-0.5 text-2xs transition-colors ${attachType === kind ? "border-accent/50 bg-accent/12 text-accent-soft" : "border-edge text-gray-400 hover:bg-hover hover:text-gray-200"}`}
                >
                  {kind === "inventory" ? t("attach.inventory") : t("attach.accessLog")}
                </button>
              ))}
            </span>
          )}
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
          if (slashOpen) {
            if (event.key === "ArrowDown") { event.preventDefault(); setSlashSel((value) => Math.min(slashItems.length - 1, value + 1)); return; }
            if (event.key === "ArrowUp") { event.preventDefault(); setSlashSel((value) => Math.max(0, value - 1)); return; }
            if (event.key === "Enter") { event.preventDefault(); selectSlash(slashItems[slashIdx]); return; }
            if (event.key === "Escape") { event.preventDefault(); setSlashSuppressed(true); return; }
          }
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

        <button
          type="button"
          onClick={onOpenSettings}
          title={modelName ?? copy.modelSettings}
          aria-label={modelName ? `${copy.model}: ${modelName}` : copy.modelSettings}
          className={`flex h-7 items-center gap-1.5 rounded-lg border px-2 text-2xs transition-colors ${modelName ? "border-transparent text-gray-500 hover:border-edge hover:bg-elevated hover:text-gray-300" : "border-warn-border text-warn-fg"}`}
        >
          <Spark size={10} />
          <span>{modelName ? copy.model : copy.modelSettings}</span>
        </button>

        <span className="ml-auto hidden text-2xs text-gray-500 opacity-0 transition-opacity duration-fast group-focus-within/composer:opacity-100 sm:inline">
          {busy ? <>{copy.steerCurrent} · <kbd className="rounded-md border border-edge bg-elevated px-1">⇧⏎</kbd> {copy.newline}</> : <><kbd className="rounded-md border border-edge bg-elevated px-1">⏎</kbd> {copy.delegate} · <kbd className="rounded-md border border-edge bg-elevated px-1">⇧⏎</kbd> {copy.newline}</>}
        </span>

        {busy ? (
          <div className="composer-mode" key="steer">
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
              title={copy.steerActionHint}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-2xs font-semibold text-accent-fg transition-[background-color,transform] duration-fast hover:bg-accent-soft active:scale-[.98] disabled:cursor-default disabled:bg-elevated disabled:text-gray-500"
            >
              {copy.steer}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><line x1="5" y1="12" x2="19" y2="12" /><polyline points="13 6 19 12 13 18" /></svg>
            </button>
          </div>
        ) : (
          <div className="composer-mode" key="delegate">
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
              {!uploading ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><line x1="5" y1="12" x2="19" y2="12" /><polyline points="13 6 19 12 13 18" /></svg> : null}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
