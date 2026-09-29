import type { Severity } from "../api/types";

/** Severity reads as a dot (or a badge on the estate) beside neutral text. */
export const SEVERITY_TONE: Record<Severity, "danger" | "warn" | "neutral" | "outline"> = {
  high: "danger", medium: "warn", low: "neutral", info: "outline",
};
