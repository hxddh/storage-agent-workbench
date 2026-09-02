import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { MOD } from "../shortcuts";
import { Icon } from "./icons";
import { ModelChip } from "./ModelChip";

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

export function useComposerCopy() {
  const { lang } = useI18n();
  return lang === "zh"
    ? {
        delegateHint: "给 Agent 一个目标、一个存储问题，或粘贴一段错误…",
        steerHint: "补充方向或约束，Agent 会在当前执行中采纳…",
        uploading: (name: string) => `正在准备 ${name}…`,
        stop: "停止",
        steerAction: "调整方向",
        delegateAction: "委派任务",
        attachRemove: "移除附件",
        noModel: "未配置模型",
        setUpModel: "配置模型",
        model: "模型",
        switchModel: "切换模型",
        openSettings: "打开设置…",
        readOnly: "只读工具",
      }
    : {
        delegateHint: "Give the Agent a goal, a storage problem, or an error to triage…",
        steerHint: "Add direction or constraints — the Agent applies it to the current execution…",
        uploading: (name: string) => `Preparing ${name}…`,
        stop: "Stop",
        steerAction: "Steer Agent",
        delegateAction: "Delegate task",
        attachRemove: "Remove attachment",
        noModel: "No model configured",
        setUpModel: "Set up a model",
        model: "Model",
        switchModel: "Switch model",
        openSettings: "Open settings…",
        readOnly: "Read-only tools",
      };
}

/**
 * The one Agent input. Delegate at rest; Steer + Stop while an execution is
 * live. Attach, textarea, model, and those actions — nothing else is painted.
 */
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
  onOpenSettings,
  modelRefreshKey = 0,
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
  onOpenSettings?: () => void;
  modelRefreshKey?: number;
}) {
  const { t } = useI18n();
  const copy = useComposerCopy();
  const [sizeError, setSizeError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const histIndex = useRef<number | null>(null);

  // A file dropped anywhere on the Composer takes the same attach path as the
  // `+` button: one file, the same size ceiling, the same accept list.
  const acceptFile = (file: File | null) => {
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setSizeError(t("attach.tooLarge", { size: formatGiB(file.size) }));
      return;
    }
    setSizeError(null);
    onPickFile(file);
  };

  useEffect(() => { setSizeError(null); }, [attached]);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.max(24, Math.min(ta.scrollHeight, 240))}px`;
  }, [text, taRef]);

  const running = busy || uploading;
  const blocked = offline;
  const canDelegate = !uploading && !blocked && (Boolean(text.trim()) || Boolean(attached));

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
      className="native-composer"
      data-testid="agent-composer"
      data-agent-state={busy ? "working" : uploading ? "uploading" : "ready"}
      data-dragging={dragging ? "true" : "false"}
      onDragOver={(event) => {
        if (running || blocked || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        setDragging(false);
        if (running || blocked) return;
        const file = event.dataTransfer.files?.[0] ?? null;
        if (!file) return;
        event.preventDefault();
        acceptFile(file);
      }}
    >
      {attached ? (
        <div className="native-composer-attachment">
          <Icon name="file" size={14} />
          <strong>{attached.name}</strong>
          {uploading ? (
            <span className="ml-auto flex items-center gap-2 text-gray-500">
              <span className="skeleton h-3 w-10" aria-hidden />
              {copy.uploading(attached.name)}
            </span>
          ) : (
            <button type="button" className="native-round ml-auto" style={{ width: 24, height: 24 }} onClick={onClearAttachment} aria-label={copy.attachRemove} title={copy.attachRemove}>
              <Icon name="close" size={12} />
            </button>
          )}
        </div>
      ) : null}

      {sizeError ? <div className="native-composer-error">{sizeError}</div> : null}

      <input
        ref={fileRef}
        type="file"
        accept=".csv,.parquet,.tsv,.log,.txt,.gz,.json,.jsonl"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          event.target.value = "";
          if (!file) { setSizeError(null); onPickFile(null); return; }
          acceptFile(file);
        }}
      />

      <textarea
        ref={taRef}
        data-focus-ring="container"
        rows={1}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowUp" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
            const ta = event.currentTarget;
            const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
            if (!text || atStart) {
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
            if (nextIdx < 0) { histIndex.current = null; setText(""); }
            else { histIndex.current = nextIdx; setText(hist[nextIdx]); }
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            histIndex.current = null;
            if (blocked) return;
            if (busy) handleSteer();
            else if (canDelegate) handleSend();
          } else if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
            histIndex.current = null;
          }
        }}
        placeholder={busy ? copy.steerHint : copy.delegateHint}
      />

      <div className="native-composer-bar">
        <button
          type="button"
          onClick={onOpenFilePicker}
          disabled={running || blocked}
          aria-label={t("attach.button")}
          title={t("attach.button")}
          className="native-round"
        >
          <Icon name="plus" size={18} />
        </button>

        <ModelChip onOpenSettings={onOpenSettings} refreshKey={modelRefreshKey} disabled={busy} />

        <div className="ml-auto flex items-center gap-1.5">
          {busy ? (
            <>
              <button
                type="button"
                onClick={handleSteer}
                disabled={!text.trim()}
                aria-label={copy.steerAction}
                title={`${copy.steerAction} ⏎`}
                className="native-round"
                data-primary={text.trim() ? "true" : "false"}
              >
                <Icon name="arrowUp" size={16} stroke={2} />
              </button>
              <button type="button" onClick={onStop} aria-label={copy.stop} title={`${copy.stop} ${MOD}.`} className="native-round" data-primary={text.trim() ? "false" : "true"}>
                <Icon name="stop" size={14} stroke={0} className="fill-current" />
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={!canDelegate}
              aria-label={copy.delegateAction}
              title={`${copy.delegateAction} ⏎`}
              className="native-round"
              data-primary="true"
            >
              {uploading ? <span className="skeleton h-3 w-3 rounded-full" aria-hidden /> : <Icon name="arrowUp" size={16} stroke={2} />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
