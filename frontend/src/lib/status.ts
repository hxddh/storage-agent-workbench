/**
 * Established fact, or absence of one.
 *
 * The sidecar spent several releases making this distinction real — v0.80.0
 * through v0.82.0 exist because the product kept stating verdicts it had not
 * established, and the fix was to split every posture read into what was
 * ESTABLISHED (`available`, `not_configured` — we asked and got an answer) and
 * what was UNDETERMINED (`access_denied`, `provider_unsupported`, `error`, and
 * a missing value: we did not get one).
 *
 * The UI then rendered all six as the raw snake_case token in one of five
 * colours, so the only place that distinction lived was the backend. Worse, the
 * two that differ most read almost the same: a bucket never checked (null,
 * gray-400) and a bucket checked against a provider that cannot answer
 * (`provider_unsupported`, gray-500).
 *
 * "Not configured" is a FINDING — encryption being off is a fact about the
 * bucket, and it keeps its warning colour. "Denied" is not a finding about the
 * bucket at all; it is a fact about our credentials.
 */

/** Deliberately `string`, not a union of the five known values.
 *
 * These arrive over the wire. A sidecar that grows a sixth status must not make
 * this UI fail to compile — it must make it fall through to "undetermined",
 * which is the truthful reading of a status this build does not recognise. A
 * closed union would force a cast at every call site and the cast is where the
 * lie would live. */
export type PostureStatus = string | null | undefined;

/** The two answers that are answers. Everything else is an absence of one. */
const ESTABLISHED = new Set(["available", "not_configured"]);

export function isEstablished(status: PostureStatus): boolean {
  return !!status && ESTABLISHED.has(status);
}

/** i18n key for the human label. Never render the raw token. */
export function statusLabelKey(status: PostureStatus): string {
  switch (status) {
    case "available":
      return "posture.available";
    case "not_configured":
      return "posture.notConfigured";
    case "access_denied":
      return "posture.denied";
    case "provider_unsupported":
      return "posture.unsupported";
    case "error":
      return "posture.error";
    default:
      return "posture.notChecked";
  }
}

/** Colour only; the established/undetermined treatment is applied separately so
 * the two axes cannot drift apart. */
export function statusClass(status: PostureStatus): string {
  switch (status) {
    case "available":
      return "text-success";
    case "not_configured":
      return "text-warn";
    case "access_denied":
    case "error":
      return "text-danger";
    default:
      return "text-gray-500";
  }
}
