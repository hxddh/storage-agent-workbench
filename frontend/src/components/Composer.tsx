/**
 * The sticky composer: textarea + slash-command menu + attachment chip +
 * model chip + send/stop buttons. Extracted from Thread.tsx (behavior-
 * preserving); all session/turn logic stays in Thread + useTurnRunner.
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n";

// Slash commands: "/" in the composer opens this menu. Capability commands seed
// a prompt; "report" runs the session report; logs/inventory open the picker.
export type Slash = { cmd: string; labelKey: string; promptKey?: string; action?: "report" | "pickFile" };
const SLASH: Slash[] = [
  { cmd: "diagnose", labelKey: "sugg.diagnose", promptKey: "prompt.diagnose" },
  { cmd: "logs", labelKey: "sugg.logs", action: "pickFile" },
  { cmd: "inventory", labelKey: "sugg.inventory", action: "pickFile" },
  { cmd: "config", labelKey: "sugg.config", promptKey: "prompt.config" },
  { cmd: "account", labelKey: "sugg.account", promptKey: "prompt.account" },
  { cmd: "optimize", labelKey: "sugg.optimize", promptKey: "prompt.optimize" },
  { cmd: "report", labelKey: "slash.report", action: "report" },
];

const Spark = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2z" />
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
  /** Open the file picker with no preset type (plain 📎 attach). */
  onOpenFilePicker: () => void;
  fileRef: React.RefObject<HTMLInputElement>;
  taRef: React.RefObject<HTMLTextAreaElement>;
  busy: boolean;
  uploading: boolean;
  onSend: () => void;
  onStop: () => void;
  /** Redirect the in-flight turn: cancel it (keeping what it found) and send the
   *  composer text as a new, trace-aware turn. Only meaningful while `busy`. */
  onSteer: () => void;
  modelName: string | null;
  onOpenSettings: () => void;
  onSlashReport: () => void;
  onSlashPickFile: (type: "inventory" | "access_log") => void;
}) {
  const { t } = useI18n();
  const [slashSel, setSlashSel] = useState(0);

  // Auto-grow the composer (pin one line when empty so the wrapping placeholder
  // doesn't inflate scrollHeight).
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (!text) {
      ta.style.height = "22px";
      return;
    }
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // Slash commands: open when the composer is exactly "/" + word chars.
  const slashQ = /^\/(\w*)$/.exec(text)?.[1];
  const slashItems = slashQ !== undefined ? SLASH.filter((c) => c.cmd.startsWith(slashQ.toLowerCase())) : [];
  const slashOpen = slashItems.length > 0;
  const slashIdx = Math.min(slashSel, slashItems.length - 1);

  const selectSlash = (c: Slash) => {
    if (c.action === "report") {
      setText("");
      onSlashReport();
    } else if (c.action === "pickFile") {
      // Log/inventory analysis needs a local file → open the picker (same as
      // the empty-state chips), not just seed a prompt the agent has no file for.
      setText("");
      onSlashPickFile(c.cmd === "logs" ? "access_log" : "inventory");
    } else if (c.promptKey) {
      setText(t(c.promptKey));
      requestAnimationFrame(() => taRef.current?.focus());
    }
    setSlashSel(0);
  };

  const running = busy || uploading;

  return (
    <div className="relative rounded-[22px] border border-edge bg-panel px-3.5 pb-2.5 pt-3 shadow-elev transition-all duration-150 focus-within:border-edge-strong focus-within:shadow-pop focus-within:ring-4 focus-within:ring-accent/10">
      {slashOpen && (
        <div className="absolute bottom-full left-1 right-1 mb-2 overflow-hidden rounded-xl border border-edge bg-panel shadow-pop animate-fade-in">
          <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-gray-600">{t("thread.commands")}</div>
          {slashItems.map((c, i) => (
            <button
              key={c.cmd}
              onMouseEnter={() => setSlashSel(i)}
              onClick={() => selectSlash(c)}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${i === slashIdx ? "bg-hover" : "hover:bg-hover/50"}`}
            >
              <span className="font-mono text-[12px] text-accent-soft">/{c.cmd}</span>
              <span className="text-[13px] text-gray-300">{t(c.labelKey)}</span>
            </button>
          ))}
        </div>
      )}
      {attached && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-elevated px-2.5 py-1.5 text-xs">
          <span className="text-gray-300">📎 {attached.name}</span>
          {uploading ? (
            <span className="flex items-center gap-1.5 text-gray-400">
              <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
              {t("thread.uploading", { name: attached.name })}
            </span>
          ) : attachType ? (
            <span className="rounded-full border border-edge px-2 py-0.5 text-[11px] text-gray-400">
              {attachType === "inventory" ? t("attach.inventory") : t("attach.accessLog")}
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <span className="text-gray-500">{t("attach.pickType")}</span>
              <button className="rounded-full border border-edge px-2 py-0.5 text-[11px] text-gray-300 hover:bg-hover"
                onClick={() => setAttachType("inventory")}>{t("attach.inventory")}</button>
              <button className="rounded-full border border-edge px-2 py-0.5 text-[11px] text-gray-300 hover:bg-hover"
                onClick={() => setAttachType("access_log")}>{t("attach.accessLog")}</button>
            </span>
          )}
          {!uploading && (
            <button className="ml-auto text-gray-500 hover:text-gray-300"
              onClick={onClearAttachment} aria-label={t("common.cancel")}>✕</button>
          )}
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept=".csv,.parquet,.tsv,.log,.txt,.gz,.json,.jsonl"
        className="hidden"
        onChange={(e) => { onPickFile(e.target.files?.[0] ?? null); e.target.value = ""; }}
      />
      <textarea
        ref={taRef}
        className="block max-h-[220px] h-[22px] w-full resize-none bg-transparent px-1 text-[14px] leading-relaxed text-gray-100 placeholder:text-gray-600 focus:outline-none focus-visible:shadow-none"
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (slashOpen) {
            if (e.key === "ArrowDown") { e.preventDefault(); setSlashSel((s) => Math.min(slashItems.length - 1, s + 1)); return; }
            if (e.key === "ArrowUp") { e.preventDefault(); setSlashSel((s) => Math.max(0, s - 1)); return; }
            if (e.key === "Enter") { e.preventDefault(); selectSlash(slashItems[slashIdx]); return; }
            if (e.key === "Escape") { e.preventDefault(); setText(""); return; }
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            // While a turn is streaming, Enter REDIRECTS it (cancel + resend as a
            // trace-aware turn) instead of no-opping; otherwise it sends normally.
            if (busy) onSteer();
            else onSend();
          }
        }}
        placeholder={t("thread.placeholder")}
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={onOpenFilePicker}
          disabled={running}
          aria-label={t("attach.button")}
          title={t("attach.button")}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-gray-500 transition-colors hover:bg-hover hover:text-gray-300 disabled:cursor-default disabled:opacity-50"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <button
          onClick={onOpenSettings}
          className={`group/chip flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11.5px] transition-colors ${
            modelName
              ? "border-edge text-gray-400 hover:border-edge-strong hover:text-gray-200"
              : "border-amber-800/40 text-amber-300/90 hover:border-amber-700/60 hover:text-amber-200"
          }`}
        >
          <Spark size={11} />
          <span className="max-w-[14rem] truncate">{modelName ?? t("thread.addModel")}</span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-600 group-hover/chip:text-gray-400">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        <span className="ml-auto hidden text-[11px] text-gray-600 sm:inline">
          {busy && text.trim() ? (
            // While a turn runs, Enter REDIRECTS it (cancel + resend) — say so,
            // instead of the misleading "Send".
            <><kbd className="font-sans">⏎</kbd> {t("thread.redirectCurrent")}</>
          ) : (
            <><kbd className="font-sans">⏎</kbd> {t("thread.send")} · <kbd className="font-sans">⇧⏎</kbd> {t("thread.newline")}</>
          )}
        </span>
        {busy && text.trim() && (
          // Redirect the running turn: cancel it (keeping what it found) and
          // resend this text as a trace-aware turn. Secondary look next to the
          // prominent Stop, so the two actions read distinctly.
          <button
            onClick={onSteer}
            aria-label={t("thread.redirect")}
            title={t("thread.redirectHint")}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-edge bg-elevated text-gray-100 transition-all hover:bg-hover active:scale-95"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
          </button>
        )}
        {busy ? (
          <button
            onClick={onStop}
            aria-label={t("thread.stop")}
            title={t("thread.stop")}
            className="group/stop grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent text-white transition-all hover:bg-accent-soft active:scale-95"
          >
            {/* Stop square inside a subtle spinner ring so it reads as "running,
                click to cancel". */}
            <span className="relative grid h-4 w-4 place-items-center">
              <span className="absolute inset-0 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </span>
          </button>
        ) : (
          <button
            onClick={onSend}
            disabled={uploading || (!text.trim() && !attached)}
            aria-label={t("thread.send")}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent text-white transition-all hover:bg-accent-soft active:scale-95 disabled:cursor-default disabled:bg-elevated disabled:text-gray-600"
          >
            {uploading ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
