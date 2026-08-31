import { useEffect, useState } from "react";
import { readFirstRunStep, readOnboarded, type FirstRunStep } from "../lib/firstRun";

/** Re-render when first-run localStorage changes in this window. */
export function useFirstRun(): { onboarded: boolean; step: FirstRunStep | null } {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener("saw-first-run", bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener("saw-first-run", bump);
      window.removeEventListener("storage", bump);
    };
  }, []);
  void tick;
  return { onboarded: readOnboarded(), step: readFirstRunStep() };
}
