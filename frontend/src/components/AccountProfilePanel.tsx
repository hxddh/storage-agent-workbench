import { useMemo, useState } from "react";
import type { AccountBucket, AccountProfile } from "../types";
import { useI18n } from "../i18n";
import { isEstablished, statusClass, statusLabelKey, type PostureStatus } from "../lib/status";

type Filter = "all" | "has_inventory" | "has_logging" | "issues" | "unsupported";

const FILTERS: { value: Filter; labelKey: string }[] = [
  { value: "all", labelKey: "profile.filterAll" },
  { value: "has_inventory", labelKey: "profile.filterInventory" },
  { value: "has_logging", labelKey: "profile.filterLogging" },
  { value: "issues", labelKey: "profile.filterIssues" },
  { value: "unsupported", labelKey: "profile.filterUnsupported" },
];

function hasEvidence(b: AccountBucket, sourceType: string): boolean {
  return b.evidence_sources.some((s) => s.source_type === sourceType && s.status === "available");
}

/** One posture cell.
 *
 * Two things changed here. The raw snake_case token is no longer printed at a
 * person — `access_denied` is a wire value, not a word — and an UNDETERMINED
 * cell is now visibly not a finding: it is dimmed and underlined with a dotted
 * rule, the typographic convention for "this is not a value", with the reason on
 * hover.
 *
 * The distinction is the sidecar's, and it had nowhere to land: `available` and
 * `not_configured` are answers we got, while `access_denied`,
 * `provider_unsupported`, `error` and a missing value are answers we did not.
 * Rendered flat, a bucket nobody could read looked like a bucket that was fine.
 *
 * `not_configured` deliberately keeps its warning colour: encryption being off
 * IS a fact about the bucket. "Denied" is a fact about our credentials. */
function Cell({ status }: { status: PostureStatus }) {
  const { t } = useI18n();
  const label = t(statusLabelKey(status));
  if (isEstablished(status)) {
    return <span className={statusClass(status)}>{label}</span>;
  }
  return (
    <span
      className={`${statusClass(status)} decoration-dotted underline underline-offset-2 opacity-80`}
      title={t("status.undeterminedHint")}
    >
      {label}
    </span>
  );
}

export function AccountProfilePanel({
  profile,
}: {
  profile: AccountProfile;
}) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<Filter>("all");

  const buckets = useMemo(() => {
    const list = profile.buckets ?? [];
    switch (filter) {
      case "has_inventory":
        return list.filter((b) => hasEvidence(b, "inventory"));
      case "has_logging":
        return list.filter((b) => hasEvidence(b, "server_access_logging"));
      case "issues":
        return list.filter(
          (b) => b.access_status === "access_denied" || b.access_status === "error" ||
            (b.access_denied_items?.length ?? 0) > 0 || (b.errors?.length ?? 0) > 0,
        );
      case "unsupported":
        return list.filter((b) => (b.provider_unsupported_items?.length ?? 0) > 0);
      default:
        return list;
    }
  }, [profile.buckets, filter]);

  return (
    <div data-testid="account-profile">
      <h2 className="mb-2 text-sm font-semibold text-gray-200">{t("profile.title")}</h2>
      <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
        <div className="rounded-md border border-edge bg-panel p-2">
          <div className="text-2xs text-gray-500">{t("profile.visibleBuckets")}</div>
          <div className="text-sm font-medium text-gray-100">{profile.visible_count}</div>
        </div>
        <div className="rounded-md border border-edge bg-panel p-2">
          <div className="text-2xs text-gray-500">{t("profile.processed")}</div>
          <div className="text-sm font-medium text-gray-100">
            {profile.processed_count}
            {profile.truncated ? ` ${t("profile.truncatedSuffix")}` : ""}
          </div>
        </div>
        <div className="rounded-md border border-edge bg-panel p-2">
          <div className="text-2xs text-gray-500">ListBuckets</div>
          <div className={`text-sm font-medium ${statusClass(profile.list_status)}`}>
            {t(statusLabelKey(profile.list_status))}
          </div>
        </div>
      </div>

      <div className="mb-2 flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`rounded-full border px-2 py-0.5 text-2xs ${
              filter === f.value ? "border-violet-700 text-violet-300" : "border-edge text-gray-400 hover:text-gray-200"
            }`}
          >
            {t(f.labelKey)}
          </button>
        ))}
      </div>

      <div className="overflow-auto rounded-md border border-edge">
        <table className="w-full text-left text-2xs">
          <thead className="bg-sidebar text-gray-400">
            <tr>
              <th className="px-2 py-1">{t("profile.colBucket")}</th>
              <th className="px-2 py-1">{t("profile.colRegion")}</th>
              <th className="px-2 py-1">{t("profile.colAccess")}</th>
              <th className="px-2 py-1">{t("profile.colEncryption")}</th>
              <th className="px-2 py-1">{t("profile.colLogging")}</th>
              <th className="px-2 py-1">{t("profile.colInventory")}</th>
              <th className="px-2 py-1">{t("profile.colLifecycle")}</th>
              <th className="px-2 py-1">{t("profile.colPublicBlock")}</th>
              <th className="px-2 py-1">{t("profile.colEvidence")}</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => {
              const evidence = [
                hasEvidence(b, "inventory") ? t("profile.evInventory") : null,
                hasEvidence(b, "server_access_logging") ? t("profile.evLogging") : null,
              ].filter(Boolean);
              return (
                <tr key={b.bucket_name} className="border-t border-edge text-gray-300">
                  <td className="px-2 py-1 font-mono text-gray-100">{b.bucket_name}</td>
                  <td className="px-2 py-1">{b.region ?? "—"}</td>
                  <td className="px-2 py-1"><Cell status={b.access_status} /></td>
                  <td className="px-2 py-1"><Cell status={b.encryption_status} /></td>
                  <td className="px-2 py-1"><Cell status={b.logging_status} /></td>
                  <td className="px-2 py-1"><Cell status={b.inventory_status} /></td>
                  <td className="px-2 py-1"><Cell status={b.lifecycle_status} /></td>
                  <td className="px-2 py-1"><Cell status={b.public_access_block_status} /></td>
                  <td className="px-2 py-1 text-gray-400">{evidence.length ? evidence.join(", ") : "—"}</td>
                </tr>
              );
            })}
            {buckets.length === 0 && (
              <tr>
                <td colSpan={9} className="px-2 py-2 text-gray-600">{t("profile.noMatch")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
