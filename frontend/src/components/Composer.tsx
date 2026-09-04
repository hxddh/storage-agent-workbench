import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { mentionQueryAt, mentionTriggered } from "../lib/mention";
import { MOD } from "../shortcuts";
import { Icon } from "./icons";
import { ModelChip } from "./ModelChip";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const formatGiB = (n: number) => `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
const HISTORY_KEY = "saw.composerHistory";
const HISTORY_LIMIT = 20;

// v1.13 — history lives in plaintext localStorage, so secret-shaped content
// must never be stored: entries carrying key material are dropped entirely,
// credential-bearing values are masked. Mirrors the Sidecar redactor's shapes.
// v1.16 — mirrors sidecar/app/security/redaction.py shapes. When adding one
// here, add it there too (and to architecture.test.ts's ghu assertion).
const SECRET_ENTRY = [
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{16}\b/,
  /\bsk-[A-Za-z0-9][A-Za-z0-9_\-]{5,}/,
  /\bxox[baprse]-[A-Za-z0-9-]{10,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bghu_[A-Za-z0-9]{36}/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/,
  /\bglpat-[A-Za-z0-9_\-]{20,}/,
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
];
const SECRET_VALUES: [RegExp, string][] = [
  [/([?&][A-Za-z0-9_.-]*(?:password|passwd|pwd|client_secret|secret|access_token|refresh_token|credential|auth|session|token|api_key)=)([^&\s]+)/gi, "$1***REDACTED***"],
  [/\b(api[_-]?key|token)(\s*[:=]\s*)(['"]?)[A-Za-z0-9/+=_.\-]{4,}/gi, "$1$2$3***REDACTED***"],
  [/\b(Bearer\s+)[A-Za-z0-9._\-/+=]+/gi, "$1***REDACTED***"],
];

export function cleanHistory(entry: string): string | null {
  if (SECRET_ENTRY.some((re) => re.test(entry))) return null;
  let out = entry;
  for (const [re, rep] of SECRET_VALUES) out = out.replace(re, rep);
  return out;
}

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Migration-clean pre-v1.13 entries on read.
    const cleaned: string[] = [];
    for (const x of parsed) {
      if (typeof x !== "string") continue;
      const c = cleanHistory(x);
      if (c && !cleaned.includes(c)) cleaned.push(c);
    }
    return cleaned.slice(0, HISTORY_LIMIT);
  } catch { return []; }
}
function pushHistory(entry: string) {
  const trimmed = entry.trim();
  if (!trimmed) return;
  const cleaned = cleanHistory(trimmed);
  if (!cleaned) return;
  const hist = loadHistory();
  const deduped = [cleaned, ...hist.filter((h) => h !== cleaned)].slice(0, HISTORY_LIMIT);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(deduped)); } catch {}
}

export function useComposerCopy() {
  const { lang } = useI18n();
  return lang === "zh"
    ? {
        delegateHint: "描述要委派的存储工作…",
        steerHint: "补充这次执行的方向…",
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
      }
    : {
        delegateHint: "Describe the storage work to delegate…",
        steerHint: "Steer this execution…",
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
  mentionables = [],
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
  /** v1.13 — `@` completion source: files attached to this Task. Selecting one
   * inserts `@filename`; the model resolves it via list_uploaded_files. */
  mentionables?: { id: string; filename: string }[];
}) {
  const { t } = useI18n();
  const copy = useComposerCopy();
  const [sizeError, setSizeError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const histIndex = useRef<number | null>(null);
  const [mention, setMention] = useState<{ query: string; index: number } | null>(null);

  const updateMention = (value: string, caret: number | null) => {
    if (!mentionables.length || caret == null) { setMention(null); return; }
    // v1.16 — word-boundary trigger shared with the hint lines below, so
    // email addresses never open file completion.
    const query = mentionQueryAt(value, caret);
    if (query == null) { setMention(null); return; }
    setMention((prev) => ({ query, index: prev && prev.query === query ? prev.index : 0 }));
  };
  const mentionMatches = mention
    ? mentionables.filter((f) => f.filename.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 6)
    : [];
  const completeMention = (filename: string) => {
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@[^\s@]*$/, `@${filename} `);
    setText(before + text.slice(caret));
    setMention(null);
    histIndex.current = null;
    requestAnimationFrame(() => {
      if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = before.length; }
    });
  };

  // v1.16 — analyzed types, in one place so button, drop and picker agree.
  const ANALYZED_EXT = [".csv", ".parquet", ".tsv", ".log", ".txt", ".gz", ".json", ".jsonl"];
  const isAnalyzedType = (name: string) => {
    const lower = name.toLowerCase();
    return ANALYZED_EXT.some((ext) => lower.endsWith(ext));
  };
  // A file dropped anywhere on the Composer takes the same attach path as the
  // `+` button: one file, the same size ceiling, the same accept list.
  const acceptFile = (file: File | null) => {
    if (!file) return;
    if (!isAnalyzedType(file.name)) {
      setSizeError(t("attach.badType"));
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setSizeError(t("attach.tooLarge", { size: formatGiB(file.size) }));
      return;
    }
    setSizeError(null);
    onPickFile(file);
  };
  // v1.16 — `@` discoverability: a quiet line only while the user is
  // actually typing a trigger (R1: never a permanent fixture).
  const showMentionHint = mentionables.length > 0 && !mention && mentionTriggered(text);
  const showMentionNeedsFile = mentionables.length === 0 && !mention && mentionTriggered(text);

  useEffect(() => { setSizeError(null); }, [attached]);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.max(24, Math.min(ta.scrollHeight, 240))}px`;
  }, [text, taRef]);

  const running = busy || uploading;
  const blocked = offline;
  // v1.14 — the Sidecar caps Direction at 32 000 chars and steer text at
  // 8 000; show a counter past 75 % and refuse past 100 % instead of
  // letting a long paste die as a 422 in the error banner.
  const textLimit = busy ? 8000 : 32000;
  const textLen = text.length;
  const overLimit = textLen > textLimit;
  const showCount = textLen > textLimit * 0.75;
  const canDelegate = !uploading && !blocked && !overLimit && (Boolean(text.trim()) || Boolean(attached));

  const handleSend = () => {
    if (text.trim() || attached) pushHistory(text.trim() || attached?.name || "");
    histIndex.current = null;
    onSend();
  };
  // A file cannot ride a steer. If one is present while busy, ↑ is Delegate
  // (queued Direction after settle) — never a lying Steer label.
  const fileWhileBusy = Boolean(busy && attached);
  const handleSteer = () => {
    if (overLimit) return;
    if (fileWhileBusy) {
      if (text.trim()) pushHistory(text.trim());
      histIndex.current = null;
      onSteer();
      return;
    }
    if (!text.trim()) return;
    pushHistory(text.trim());
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
        accept={ANALYZED_EXT.join(",")}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          event.target.value = "";
          if (!file) { setSizeError(null); onPickFile(null); return; }
          acceptFile(file);
        }}
      />

      {mention && mentionMatches.length > 0 ? (
        <div className="native-mention-list" data-testid="composer-mentions" role="listbox">
          {mentionMatches.map((f, i) => (
            <button
              key={f.id}
              type="button"
              role="option"
              aria-selected={i === mention.index}
              data-active={i === mention.index ? "true" : "false"}
              className="native-mention-item"
              onMouseDown={(e) => { e.preventDefault(); completeMention(f.filename); }}
            >
              <Icon name="file" size={12} />
              <span>{f.filename}</span>
            </button>
          ))}
        </div>
      ) : null}

      {showMentionHint ? (
        <div className="native-composer-mention-hint" data-testid="composer-mention-hint">{t("attach.mentionHint")}</div>
      ) : null}
      {showMentionNeedsFile ? (
        <div className="native-composer-mention-hint" data-testid="composer-mention-needs-file">{t("attach.mentionNeedsFile")}</div>
      ) : null}

      <textarea
        ref={taRef}
        data-focus-ring="container"
        rows={1}
        value={text}
        title={t("composer.historyHint")}
        onChange={(event) => {
          setText(event.target.value);
          histIndex.current = null;
          updateMention(event.target.value, event.target.selectionStart);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          // v1.13 `@` file completion takes precedence while open.
          if (mention && mentionMatches.length > 0) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const delta = event.key === "ArrowDown" ? 1 : -1;
              setMention({ query: mention.query, index: (mention.index + delta + mentionMatches.length) % mentionMatches.length });
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              completeMention(mentionMatches[mention.index]?.filename ?? mentionMatches[0].filename);
              return;
            }
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMention(null); return; }
          } else if (mention && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMention(null); return; }
          // Esc in an EMPTY Composer stops the running execution — the same
          // Stop as the button and ⌘. — and does nothing at all otherwise:
          // typed text is never cleared by a key the hand reaches for reflexively.
          if (event.key === "Escape") {
            // v1.16 — stop here: the window also closes its top overlay on
            // Escape, and one keypress must not stop an execution AND close
            // the palette behind it.
            event.stopPropagation();
            if (busy && !text.trim()) { event.preventDefault(); onStop(); }
            return;
          }
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
        placeholder={busy && !attached ? copy.steerHint : copy.delegateHint}
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
        {showCount ? (
          <span
            className="native-composer-count"
            data-over={overLimit ? "true" : "false"}
            data-testid="composer-count"
            title={overLimit ? t("composer.nearLimit") : undefined}
          >
            {textLen.toLocaleString()} / {textLimit.toLocaleString()}
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          {busy ? (
            <>
              <button
                type="button"
                onClick={handleSteer}
                disabled={fileWhileBusy ? overLimit : (!text.trim() || overLimit)}
                aria-label={fileWhileBusy ? copy.delegateAction : copy.steerAction}
                title={overLimit ? t("composer.nearLimit") : `${fileWhileBusy ? copy.delegateAction : copy.steerAction} ⏎`}
                className="native-round"
                data-primary={fileWhileBusy || text.trim() ? "true" : "false"}
                data-testid={fileWhileBusy ? "composer-delegate-queued" : "composer-steer"}
              >
                <Icon name="arrowUp" size={16} stroke={2} />
              </button>
              <button type="button" onClick={onStop} aria-label={copy.stop} title={`${copy.stop} ${MOD}. · Esc`} className="native-round" data-primary={text.trim() ? "false" : "true"}>
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
