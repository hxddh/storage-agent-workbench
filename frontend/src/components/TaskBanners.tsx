import type { TaskExecution } from "../api";
import { useI18n } from "../i18n";
import { Button } from "./ui";
import { Icon } from "./icons";
import { useTaskCopy } from "./taskCopy";

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
}: {
  offline: boolean;
  needKey: boolean;
  error: string | null;
  /** The Composer still holds the failed text, so Retry re-sends it. */
  canRetry: boolean;
  onRetry: () => void;
  onOpenSettings: () => void;
  showResume: boolean;
  lastExecution: TaskExecution | null | undefined;
  onResume: (executionId: string) => void;
  queued: TaskExecution[];
  onCancelQueued: (executionId: string) => void;
}) {
  const { t } = useI18n();
  const copy = useTaskCopy();
  return (
    <>
      {offline ? (
        <div data-testid="offline-banner" className="native-banner" data-tone="danger">
          {copy.offline}
          <p>{copy.offlineHint}</p>
        </div>
      ) : null}
      {needKey ? (
        <div className="native-banner" data-tone="warn">
          {copy.needModel}
          <div className="native-banner-actions">
            <Button variant="primary" size="sm" onClick={onOpenSettings}>{copy.needModelAction}</Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="native-banner" data-tone="danger">
          {copy.actionFailed}
          <p className="break-words">{error}</p>
          <div className="native-banner-actions">
            {canRetry ? <Button variant="primary" size="sm" onClick={onRetry}>{copy.retry}</Button> : null}
            <Button variant="default" size="sm" onClick={onOpenSettings}>{t("common.openSettings")}</Button>
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
          <div className="turn-user-bubble" data-queued="true">{execution.direction}</div>
          <div className="turn-user-actions" data-always="true">
            <span className="turn-tag">{copy.queued}</span>
            <button type="button" data-testid="queued-direction-cancel" className="native-ghost-action" onClick={() => onCancelQueued(execution.id)}>
              {copy.queuedCancel}
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
