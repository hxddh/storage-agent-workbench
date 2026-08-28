import { useEffect, useRef, useState } from "react";
import { useActiveTurnController } from "../hooks/useTurnRunner";
import { getSessionRun, useSessionRun } from "../sessionRuns";
import { useI18n } from "../i18n";
import { useWorkbenchCopy } from "./copy";

export function SteeringSurface({
  sessionId,
  visible,
  offline,
}: {
  sessionId: string | null;
  visible: boolean;
  offline: boolean;
}) {
  const { t } = useI18n();
  const copy = useWorkbenchCopy();
  const controller = useActiveTurnController();
  const run = useSessionRun(sessionId);
  const [text, setTextState] = useState("");
  const textRef = useRef("");

  const setText = (next: string) => {
    textRef.current = next;
    setTextState(next);
  };

  useEffect(() => {
    setText("");
  }, [sessionId]);

  const dispatch = async () => {
    const question = textRef.current.trim();
    if (!sessionId || !controller || offline || !question || run.uploading) return;

    setText("");
    if (run.busy) await controller.steer(question);
    else await controller.submit(question);

    const finished = getSessionRun(sessionId);
    if ((finished.error || finished.needKey) && textRef.current === "") setText(question);
  };

  const blocked = offline || !controller || run.uploading;
  const actionLabel = run.busy ? t("thread.redirect") : t("thread.send");

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-4"
      hidden={!visible || !sessionId}
      data-testid="workbench-steering"
    >
      <div className="pointer-events-auto w-full max-w-[760px] rounded-xl border border-edge bg-panel/95 p-2 shadow-pop backdrop-blur-xl">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex items-center gap-2 px-1 text-2xs text-gray-500">
              <span className={`h-1.5 w-1.5 rounded-full ${run.busy ? "bg-warn" : "bg-success"}`} aria-hidden />
              <span>{run.busy ? t("thread.redirectCurrent") : copy.steering}</span>
              {run.busy && run.pending ? (
                <span className="min-w-0 truncate text-gray-500" title={run.pending}>{run.pending}</span>
              ) : null}
            </div>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void dispatch();
                }
              }}
              rows={1}
              data-focus-ring="container"
              className="block max-h-28 min-h-9 w-full resize-none bg-transparent px-2 py-1.5 text-sm text-gray-100 placeholder:text-gray-500 focus:outline-none"
              placeholder={run.busy ? t("thread.redirectHint") : t("thread.placeholder")}
              aria-label={run.busy ? t("thread.redirectCurrent") : t("thread.placeholder")}
            />
          </div>

          {run.busy ? (
            <button
              type="button"
              className="agent-os-command h-8 shrink-0 px-2.5"
              onClick={() => controller?.stop(sessionId ?? undefined)}
              disabled={!controller}
            >
              {t("thread.stop")}
            </button>
          ) : null}
          <button
            type="button"
            className="h-8 shrink-0 rounded-lg bg-accent px-3 text-xs font-medium text-[var(--accent-fg)] transition-opacity disabled:cursor-default disabled:opacity-35"
            onClick={() => void dispatch()}
            disabled={blocked || text.trim().length === 0}
          >
            {actionLabel}
          </button>
        </div>

        {run.error ? <p className="px-1 pt-1.5 text-2xs text-danger">{run.error}</p> : null}
      </div>
    </div>
  );
}
