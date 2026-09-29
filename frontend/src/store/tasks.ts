import { useCallback, useEffect, useState } from "react";
import { api, streamUrl } from "../api";
import type { TaskFeedEvent, TaskRow } from "../api/types";

/**
 * The sidebar's list: every task with its live state, kept current by the
 * Sidecar's global feed (state, titles, new and deleted tasks) — never polled.
 */
export function useTaskList(query: string) {
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [online, setOnline] = useState(true);

  const reload = useCallback(async () => {
    try {
      setTasks((await api.tasks(query || undefined)).tasks);
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, [query]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      if (closed) return;
      source = new EventSource(streamUrl("/events"));
      source.addEventListener("open", () => { setOnline(true); void reload(); });
      source.addEventListener("task", (e) => {
        const ev = JSON.parse((e as MessageEvent).data) as TaskFeedEvent;
        if (ev.created || ev.deleted) return void reload();
        setTasks((prev) => {
          if (!prev) return prev;
          if (!prev.some((t) => t.id === ev.task_id)) { void reload(); return prev; }
          return prev.map((t) => (t.id === ev.task_id ? {
            ...t,
            ...(ev.state ? { state: ev.state } : {}),
            ...(ev.title ? { title: ev.title } : {}),
            updated_at: ev.state === "working" ? new Date().toISOString() : t.updated_at,
          } : t));
        });
      });
      source.addEventListener("error", () => {
        source?.close();
        setOnline(false);
        if (!closed) timer = setTimeout(open, 2000);
      });
    };
    open();
    return () => { closed = true; clearTimeout(timer); source?.close(); };
  }, [reload]);

  return { tasks, online, reload };
}
