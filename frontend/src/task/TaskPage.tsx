import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { TaskSnapshot } from "../api/types";
import { useI18n } from "../i18n";
import { useApp } from "../shell/context";
import { sections } from "../store/derive";
import { forksOf, type TaskModel } from "../store/task";
import { Turn } from "./Turn";

/**
 * One Task as a conversation, oldest first: every turn is the user's message,
 * one line for the work, and the answer. The newest turn sits just above the
 * Composer and the page follows it while it streams — unless the reader has
 * scrolled up to read something earlier.
 */
export function TaskPage({ model, setSnapshot }: { model: TaskModel; setSnapshot: (s: TaskSnapshot) => void }) {
  const { t } = useI18n();
  const app = useApp();
  const all = useMemo(() => sections(model.turns, model.items, model.live), [model.turns, model.items, model.live]);
  const forks = useMemo(() => forksOf(model), [model.snapshot?.forks, model.allTurns]); // eslint-disable-line react-hooks/exhaustive-deps
  const end = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const first = useRef(true);

  // Follow the bottom while the reader is there.
  useEffect(() => {
    const scroller = end.current?.closest(".document");
    if (!scroller) return;
    const onScroll = () => {
      pinned.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [model.snapshot !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const lastTurn = all[all.length - 1]?.turn;
  const tail = `${all.length}:${lastTurn?.status}:${model.live?.text.length ?? 0}:${model.items.length}:${model.state}`;
  useLayoutEffect(() => {
    const scroller = end.current?.closest(".document") as HTMLElement | null;
    if (!scroller || !model.snapshot) return;
    if (first.current || pinned.current) {
      scroller.scrollTop = scroller.scrollHeight;
      first.current = false;
    }
  }, [tail, model.snapshot]);

  // A new message from the reader always brings the page down to it.
  const lastId = lastTurn?.id;
  useLayoutEffect(() => { pinned.current = true; }, [lastId]);

  if (!model.snapshot) {
    return <div className="task-page" aria-busy="true"><p className="quiet-note">{model.error ?? t("task.loading")}</p></div>;
  }
  const busy = model.state === "working" || model.state === "queued";
  const last = all[all.length - 1];
  const steps = !busy && last?.turn.status === "completed" ? (last.conclusion?.next_steps ?? []).slice(0, 3) : [];

  return (
    <div className="task-page" data-testid="task-page">
      {all.length ? all.map((s) => (
        <Turn key={s.turn.id} section={s} taskId={model.id} forks={forks} setSnapshot={setSnapshot}
          running={s.turn.status === "running"} />
      )) : <p className="quiet-note">{t("task.empty")}</p>}
      {steps.length ? (
        <div className="suggestions" data-testid="suggestions">
          {steps.map((s, i) => (
            <button key={i} type="button" className="suggestion" onClick={() => app.prefill(s)}>{s}</button>
          ))}
        </div>
      ) : null}
      <div ref={end} className="task-end" aria-hidden />
    </div>
  );
}
