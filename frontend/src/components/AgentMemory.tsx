import { useMemo, useState } from "react";
import { useI18n } from "../i18n";
import type { AgentMemoryItem, AgentMemoryKind, AttachedFile } from "../types";

/**
 * What the agent knows — and the ability to correct it.
 *
 * The agent writes its own working memory as it investigates (`note_fact`,
 * `record_finding`, `note_open_question`) and that memory is replayed into the
 * context of EVERY later turn. Until v0.51.0 none of it was visible: the session
 * endpoint did not return it and the report rendered only findings, so a wrong
 * fact — "bucket acme-logs is path-style only" — steered the rest of the
 * investigation with no way for the person watching to see it, let alone fix it.
 *
 * Two operations, both of which the agent already had for itself:
 *
 *  - **correct** rewrites the text (the item keeps its id and provenance);
 *  - **resolve** closes it, so it leaves the active set and stops being replayed.
 *
 * Resolve rather than delete: the row survives for the audit trail. Both are
 * recorded as rule-17 audit events with `by: user`, so a later reader can tell
 * which premises came from the agent and which a human overrode.
 */

const KIND_ORDER: AgentMemoryKind[] = ["fact", "finding", "open_question"];

function sevTone(sev?: string | null): string {
  switch ((sev || "").toLowerCase()) {
    case "critical":
    case "high":
      return "text-danger";
    case "medium":
      return "text-warn-fg";
    default:
      return "text-gray-500";
  }
}

function MemoryRow({
  item,
  onCorrect,
  onResolve,
}: {
  item: AgentMemoryItem;
  onCorrect: (id: string, text: string) => Promise<void>;
  onResolve: (id: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const next = draft.trim();
    if (!next || next === item.text) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await onCorrect(item.id, next);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="group/mem flex items-start gap-2 rounded px-1 py-1 hover:bg-hover/50" data-testid="memory-row">
      <span
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
          item.kind === "finding" ? "bg-warn" : item.kind === "open_question" ? "bg-accent/70" : "bg-success/70"
        }`}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex flex-col gap-1.5">
            <textarea
              value={draft}
              autoFocus
              rows={2}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void save();
                }
                if (e.key === "Escape") {
                  setDraft(item.text);
                  setEditing(false);
                }
              }}
              data-testid="memory-edit-input"
              className="w-full resize-none rounded border border-edge-strong bg-panel px-2 py-1 text-xs text-gray-200 outline-none focus:border-accent"
            />
            <div className="flex gap-1.5 text-2xs">
              <button
                type="button"
                onClick={() => void save()}
                disabled={busy}
                data-testid="memory-save"
                className="rounded border border-accent/50 px-2 py-0.5 text-accent-soft transition-colors hover:bg-accent-dim disabled:opacity-50"
              >
                {t("memory.save")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft(item.text);
                  setEditing(false);
                }}
                className="rounded border border-edge px-2 py-0.5 text-gray-500 transition-colors hover:text-gray-300"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-xs leading-relaxed text-gray-300">{item.text}</p>
            <div className="mt-0.5 flex items-center gap-2 text-2xs">
              {item.severity && <span className={sevTone(item.severity)}>{item.severity}</span>}
              {item.confidence && (
                <span className="text-gray-500">{t("memory.confidence", { level: item.confidence })}</span>
              )}
              <span className="ml-auto flex gap-1.5 opacity-0 transition-opacity group-hover/mem:opacity-100 focus-within:opacity-100">
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  data-testid="memory-correct"
                  className="rounded text-gray-500 transition-colors hover:text-gray-200"
                >
                  {t("memory.correct")}
                </button>
                <button
                  type="button"
                  onClick={() => void onResolve(item.id)}
                  data-testid="memory-resolve"
                  className="rounded text-gray-500 transition-colors hover:text-gray-200"
                >
                  {t("memory.resolve")}
                </button>
              </span>
            </div>
          </>
        )}
      </div>
    </li>
  );
}

export function AgentMemoryPanel({
  memory,
  files,
  contextMessages,
  messageTotal,
  onCorrect,
  onResolve,
}: {
  memory: AgentMemoryItem[];
  files?: AttachedFile[];
  /** How many messages the agent replays, and how many exist. */
  contextMessages?: number;
  messageTotal?: number;
  onCorrect: (id: string, text: string) => Promise<void>;
  onResolve: (id: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const groups = useMemo(() => {
    const by: Record<AgentMemoryKind, AgentMemoryItem[]> = { fact: [], finding: [], open_question: [] };
    for (const m of memory) if (by[m.kind]) by[m.kind].push(m);
    return by;
  }, [memory]);

  const rolled =
    typeof contextMessages === "number" &&
    typeof messageTotal === "number" &&
    messageTotal > contextMessages;

  const attached = files ?? [];
  if (memory.length === 0 && attached.length === 0 && !rolled) return null;

  return (
    <section className="mt-4 rounded-lg border border-edge bg-panel/60 p-3" data-testid="agent-memory">
      <h3 className="mb-2 text-2xs font-semibold uppercase tracking-wider text-gray-400">
        {t("memory.title")}
      </h3>

      {rolled && (
        // Honesty about the rolling window: the agent is not re-reading the
        // whole conversation, and a reader who assumes it is will misjudge
        // what its later answers are based on.
        <p className="mb-2.5 rounded border border-warn-border bg-warn-bg px-2 py-1.5 text-2xs text-warn-fg"
           data-testid="context-rolled">
          {t("memory.rolled", { shown: contextMessages!, total: messageTotal! })}
        </p>
      )}

      {KIND_ORDER.map((kind) =>
        groups[kind].length > 0 ? (
          <div key={kind} className="mb-2.5 last:mb-0">
            <div className="mb-0.5 text-2xs font-medium uppercase tracking-wider text-gray-500">
              {t(`memory.kind.${kind}`)} · {groups[kind].length}
            </div>
            <ul className="space-y-px">
              {groups[kind].map((m) => (
                <MemoryRow key={m.id} item={m} onCorrect={onCorrect} onResolve={onResolve} />
              ))}
            </ul>
          </div>
        ) : null,
      )}

      {attached.length > 0 && (
        <div className="mt-2.5 border-t border-edge pt-2.5">
          <div className="mb-1 text-2xs font-medium uppercase tracking-wider text-gray-500">
            {t("memory.attached")} · {attached.length}
          </div>
          <ul className="space-y-0.5" data-testid="attached-files">
            {attached.map((f) => (
              <li key={f.id} className="flex items-baseline gap-2 text-2xs">
                <span className="min-w-0 truncate font-mono text-gray-300" title={f.source_filename ?? ""}>
                  {f.source_filename || t("common.untitled")}
                </span>
                <span className="ml-auto shrink-0 tabular-nums text-2xs text-gray-500">
                  {f.detected_format || f.dataset_type}
                  {f.row_count ? ` · ${f.row_count.toLocaleString()}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
