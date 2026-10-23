import { ApiError } from "../api/client";

/** Turn a transport or Sidecar failure into the one sentence the reader sees.
 * Backend validation details stay as they are — they name the field to fix. */
export function describeError(err: unknown, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (err instanceof ApiError) {
    if (err.code === "offline") return t("error.offline");
    if (err.code === "timeout") return t("error.timeout");
    if (err.status === 401) return t("error.auth");
    if (err.status === 413) return t("error.tooLarge");
    if (err.status === 429) return t("error.busy");
    if (err.status >= 500) return t("error.server", { status: err.status });
    return err.message || t("error.generic");
  }
  if (err instanceof Error && err.name === "AbortError") return t("error.timeout");
  if (err instanceof Error && err.message) return err.message;
  return t("error.generic");
}
