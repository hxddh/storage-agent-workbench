import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { TaskSnapshot } from "../api/types";
import { useI18n } from "../i18n";
import { sections } from "../store/derive";
import { forksOf, type TaskModel } from "../store/task";
import { Turn } from "./Turn";

const MemoTurn = memo(Turn);

/**
 * One Task as a workspace, oldest first: every turn is an objective, its
 * deterministic artifact, the Agent's short interpretation, findings and a
 * quiet work receipt. The newest turn sits just above the Composer and the
 * page follows it while it streams — unless the reader scrolled up.
 */
export function TaskPage({ model, setSnapshot }: { model: TaskModel; setSnapshot: (s: TaskSnapshot) => void }) {
  const { t } = useI18n();
  // Live text is passed only to the Turn that owns it. Rebuilding every
  // section on every streamed token made long conversations quadratic.
  const all = useMemo(() => sections(model.turns, model.items, null), [model.turns, model.items]);
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
    if (first.current) {
      // A settled task opens on its latest Turn's heading, not halfway through
      // its table. A live task follows the work at the bottom.
      if (model.state === "working" || model.state === "queued") {
        scroller.scrollTop = scroller.scrollHeight;
      } else {
        const last = end.current?.previousElementSibling as HTMLElement | null;
        if (last) {
          const top = last.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
          scroller.scrollTop = Math.max(0, top - 24);
        } else {
          scroller.scrollTop = 0;
        }
      }
      first.current = false;
      requestAnimationFrame(() => {
        pinned.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
      });
    } else if (pinned.current) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [tail, model.snapshot, model.state]);

  // A new message from the reader always brings the page down to it.
  const lastId = lastTurn?.id;
  useLayoutEffect(() => { pinned.current = true; }, [lastId]);

  if (!model.snapshot) {
    return <div className="task-page" aria-busy="true"><p className="quiet-note">{model.error ?? t("task.loading")}</p></div>;
  }
  const firstTurn = all.find((s) => s.turn.kind !== "resume")?.turn.id;
  return (
    <div className="task-page" data-testid="task-page">
      {all.length ? all.map((s) => (
        <MemoTurn key={s.turn.id} section={s} taskId={model.id} forks={forks} setSnapshot={setSnapshot}
          running={s.turn.status === "running"} first={s.turn.id === firstTurn}
          live={model.live?.turn_id === s.turn.id ? model.live : null} />
      )) : <p className="quiet-note">{t("task.empty")}</p>}
      <div ref={end} className="task-end" aria-hidden />
    </div>
  );
}
