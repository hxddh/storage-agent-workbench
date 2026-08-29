import { memo, useState } from "react";
import type { ToolActivity } from "../types";
import { useI18n } from "../i18n";
import { Markdown } from "./Markdown";
import { LiveTrace, WorkingRow } from "./LiveTrace";

export type AgentResultRendererProps = {
  content: string | null;
  toolActivity?: ToolActivity[];
  streaming?: boolean;
  sessionId?: string | null;
  onRegenerate?: () => void;
};

function stripMetaBlock(text: string): string {
  const index = text.lastIndexOf("```json");
  if (index < 0) return text;
  const rest = text.slice(index);
  const looksMeta = /"(answer|skills_used|evidence_used|next_action_proposals)"/.test(rest)
    || rest.replace(/```json\s*/, "").trimStart().length === 0;
  return looksMeta ? text.slice(0, index).trimEnd() : text;
}

function legacyCopy(text: string): boolean {
  try {
    const node = document.createElement("textarea");
    node.value = text;
    node.style.position = "fixed";
    node.style.opacity = "0";
    document.body.appendChild(node);
    node.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(node);
    return ok;
  } catch {
    return false;
  }
}

async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return legacyCopy(text);
    }
  }
  return legacyCopy(text);
}

function CopyResult({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => void copyText(text).then((ok) => {
        if (!ok) return;
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      })}
      className="text-gray-500 transition-colors hover:text-gray-200"
      aria-label={t("common.copy")}
      data-testid="copy-work-result"
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden><polyline points="20 6 9 17 4 12" /></svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      )}
    </button>
  );
}

/** Assistant-only renderer for a real Agent work result.
 *
 * It has no user-role branch and no chat abstraction. Streaming tool activity is
 * the execution itself; after completion the task-level footer owns persisted
 * execution/evidence disclosure.
 */
export const AgentResultRenderer = memo(function AgentResultRenderer({
  content,
  toolActivity,
  streaming,
  sessionId,
  onRegenerate,
}: AgentResultRendererProps) {
  const { t } = useI18n();
  const shown = streaming ? stripMetaBlock(content || "") : content || "";

  return (
    <div className="group animate-fade-in-up" data-testid="agent-result-renderer">
      <div className="mb-0.5 flex h-4 items-center gap-1.5">
        {!streaming ? (
          <span className="flex items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <CopyResult text={content || ""} />
            {onRegenerate ? (
              <button
                type="button"
                onClick={onRegenerate}
                title={t("msg.regenerate")}
                aria-label={t("msg.regenerate")}
                data-testid="regenerate"
                className="text-gray-500 transition-colors hover:text-gray-200"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              </button>
            ) : null}
          </span>
        ) : null}
      </div>

      {streaming && toolActivity?.length ? <LiveTrace items={toolActivity} sessionId={sessionId} /> : null}
      <Markdown text={shown} />
      {streaming ? (
        shown.trim() ? (
          <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-pulse bg-accent-soft align-middle" />
        ) : (
          <WorkingRow label={t("think.working")} />
        )
      ) : null}
    </div>
  );
});
