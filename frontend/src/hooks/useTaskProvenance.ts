import { useEffect, useState } from "react";
import { getTaskProvenance } from "../api";
import type { TaskProvenance } from "../viz/types";

export function useTaskProvenance(taskId: string | null, enabled = true) {
  const [provenance, setProvenance] = useState<TaskProvenance | null>(null);
  useEffect(() => {
    if (!taskId || !enabled) {
      setProvenance(null);
      return;
    }
    let cancelled = false;
    void getTaskProvenance(taskId)
      .then((next) => { if (!cancelled) setProvenance(next); })
      .catch(() => { if (!cancelled) setProvenance(null); });
    return () => { cancelled = true; };
  }, [taskId, enabled]);
  return provenance;
}
