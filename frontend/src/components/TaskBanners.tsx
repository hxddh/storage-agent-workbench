import { useState } from "react";
import type { TaskExecution } from "../api";
import { useI18n } from "../i18n";
import { Button } from "./ui";
import { Icon } from "./icons";
import { useTaskCopy } from "./taskCopy";

/** Server PATCH ceiling for a queued Direction (routers/agent_tasks.py). */
export const QUEUED_DIRECTION_LIMIT = 32000;

/**
 * What the Task needs from the user right now, beneath the transcript (or
 * beneath the Composer on an empty task): the runtime is offline, no model is
 * configured, the last action failed, an interrupted execution offers Resume,
 * and the Directions queued behind the current execution. Every banner is
 * derived from real runtime state; none of them is a mode.
 */
export function TaskBanners({
  offline,
  needKey,
  error,
  canRetry,
  onRetry,
  onOpenSettings,
  showResume,
  lastExecution,
  onResume,
  queued,
  onCancelQueued,
  onEditQueued,
  onDismissError,
}: {
  offline: boolean;
  needKey: boolean;
  error: string | null;
  /** The Composer still holds the failed text, so Retry re-sends it. */
  canRetry: boolean;
  onRetry: () => void;
  /** v1.16 — view errors (e.g. a failed approval resolve) are dismissible:
   * without text there is no Retry, and without Dismiss the banner stuck. */
  onDismissError?: () => void;
  onOpenSettings: () => void;
  showResume: boolean;
  lastExecution: TaskExecution | null | undefined;
  onResume: (executionId: string) => void;
  queued: TaskExecution[];
  onCancelQueued: (executionId: string) => void;
  onEditQueued: (executionId: string, direction: string) => void;
}) {
  const { t } = useI18n();
  const copy = useTaskCopy();
  // v1.14 — one queued row edits at a time; saving an empty draft cancels.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  return (
    <>
      {offline ? (
        <div data-testid="offline-banner" className="native-banner" data-tone="danger">
          {copy.offline}
          <p>{copy.offlineHint}</p>
        </div>
      ) : null}
      {/* v1.16 — offline suppresses needKey: key state can't be known
          while the runtime is unreachable, and stacked banners bury the doc. */}
      {needKey && !offline ? (
        <div className="native-banner" data-tone="warn">
          {copy.needModel}
          <div className="native-banner-actions">
            <Button variant="primary" size="sm" onClick={onOpenSettings}>{copy.needModelAction}</Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="native-banner" data-tone="danger" data-testid="task-error">
          {copy.actionFailed}
          <p className="break-words">{error}</p>
          <div className="native-banner-actions">
            {canRetry ? <Button variant="primary" size="sm" onClick={onRetry}>{copy.retry}</Button> : null}
            <Button variant="default" size="sm" onClick={onOpenSettings}>{t("common.openSettings")}</Button>
            {onDismissError ? <Button variant="ghost" size="sm" onClick={onDismissError}>{t("common.dismiss")}</Button> : null}
          </div>
        </div>
      ) : null}
      {showResume && lastExecution ? (
        <div data-testid="task-resume" className="native-banner" data-tone="warn">
          <span className="font-medium text-gray-100">{copy.resumeTitle}</span>
          <p>{copy.resumeBody}</p>
          <div className="native-banner-actions">
            <Button data-testid="task-resume-action" variant="primary" size="sm" onClick={() => onResume(lastExecution.id)}>
              <Icon name="play" size={12} />
              {copy.resumeAction}
            </Button>
          </div>
        </div>
      ) : null}
      {queued.map((execution) => (
        <div key={execution.id} data-testid="queued-direction" className="turn-user native-queued" title={copy.queuedHint}>
          {editingId === execution.id ? (
            <div className="turn-user-bubble" data-queued="true">
              <textarea
                data-testid="queued-direction-editor"
                aria-label={copy.queuedEditing}
                rows={2}
                value={draft}
                // v1.16 — the server ceiling (PATCH 422s past it): refuse
                // in the editor, not in a bare error.
                maxLength={QUEUED_DIRECTION_LIMIT}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.stopPropagation();
                    setEditingId(null);
                    if (draft.trim()) onEditQueued(execution.id, draft.trim());
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setEditingId(null);
                  }
                }}
              />
              {draft.length > QUEUED_DIRECTION_LIMIT * 0.75 ? (
                <div className="native-composer-count" data-testid="queued-direction-count">
                  {draft.length.toLocaleString()} / {QUEUED_DIRECTION_LIMIT.toLocaleString()}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="turn-user-bubble" data-queued="true">{execution.direction}</div>
          )}
          <div className="turn-user-actions" data-always="true">
            <span className="turn-tag">{copy.queued}</span>
            {editingId === execution.id ? (
              <button
                type="button"
                data-testid="queued-direction-save"
                className="native-ghost-action"
                disabled={!draft.trim()}
                onClick={() => { setEditingId(null); if (draft.trim()) onEditQueued(execution.id, draft.trim()); }}
              >
                {copy.queuedSave}
              </button>
            ) : (
              <button
                type="button"
                data-testid="queued-direction-edit"
                className="native-ghost-action"
                onClick={() => { setDraft(execution.direction ?? ""); setEditingId(execution.id); }}
              >
                {copy.queuedEdit}
              </button>
            )}
            <button type="button" data-testid="queued-direction-cancel" className="native-ghost-action" onClick={() => onCancelQueued(execution.id)}>
              {copy.queuedCancel}
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
