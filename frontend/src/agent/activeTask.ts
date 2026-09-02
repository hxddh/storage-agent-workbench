import { createContext, useContext } from "react";

/**
 * Which durable Agent task the window is showing. The shell owns the choice
 * (App), the Composer reads it to follow that task's runtime state — the
 * context meter, for one — without threading the id through every prop.
 * `null` is the empty start surface.
 */
export const ActiveTaskContext = createContext<string | null>(null);

export function useActiveTaskId(): string | null {
  return useContext(ActiveTaskContext);
}
