import { useMemo, useState, type FormEvent } from "react";
import { api } from "../api";
import { Markdown } from "../components/Markdown";
import { Button, StatusDot } from "../components/ui";
import { tauriInvoke } from "../config";
import { useI18n } from "../i18n";
import { latestResult, sections } from "../store/derive";
import { useTask } from "../store/task";

/**
 * Quick Ask: the small always-available window (global shortcut / tray). One
 * question becomes one ordinary task (origin `quick_ask`) through the same
 * submit path; the answer streams here, and the task opens in the main window.
 */
export function QuickAsk() {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const { model } = useTask(taskId);
  const all = useMemo(() => sections(model.turns, model.items, model.live), [model.turns, model.items, model.live]);
  const result = latestResult(all);
  const live = model.live?.text ?? null;
  const working = model.state === "working" || model.state === "queued";

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    const q = text.trim();
    if (!q || sending) return; // one question, one task — a double Enter never makes two
    setError(null);
    setSending(true);
    try {
      const snap = await api.createTask(q, "quick_ask");
      setTaskId(snap.task.id);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };
  const openMain = () => {
    if (!taskId) return;
    const invoke = tauriInvoke();
    if (invoke) void invoke("open_task_in_main", { taskId }).catch(() => {});
    else window.open(`${window.location.pathname}#/task/${taskId}`, "_blank");
  };

  return (
    <div className="quick" data-testid="quick-ask">
      <form onSubmit={ask} className="quick-form" data-tauri-drag-region>
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t("quick.placeholder")}
          aria-label={t("quick.title")} className="quick-input" data-focus-ring="container" />
      </form>
      {taskId ? (
        <div className="quick-body">
          {working ? <p className="quiet-note"><StatusDot tone="accent" pulse />{t("work.thinking")}</p> : null}
          {/* The answer once: the full text when there is one, else the recorded conclusion. */}
          {result?.answer ? <Markdown text={result.answer} />
            : result?.conclusion?.answer ? <p className="result-answer">{result.conclusion.answer}</p>
              : live ? <Markdown text={live} /> : null}
          <Button size="sm" variant="ghost" icon="external" onClick={openMain}>{t("quick.open")}</Button>
        </div>
      ) : null}
      {error ? <p className="quiet-note"><StatusDot tone="danger" />{error}</p> : null}
    </div>
  );
}
