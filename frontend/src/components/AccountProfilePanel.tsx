import { useMemo, useState } from "react";
import type { AccountBucket, AccountProfile } from "../types";

type Filter = "all" | "has_inventory" | "has_logging" | "issues" | "unsupported";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "has_inventory", label: "Has inventory" },
  { value: "has_logging", label: "Has logging" },
  { value: "issues", label: "Errors / denied" },
  { value: "unsupported", label: "Unsupported" },
];

function hasEvidence(b: AccountBucket, sourceType: string): boolean {
  return b.evidence_sources.some((s) => s.source_type === sourceType && s.status === "available");
}

function statusClass(status: string | null | undefined): string {
  switch (status) {
    case "available":
      return "text-emerald-400";
    case "not_configured":
      return "text-amber-400";
    case "access_denied":
    case "error":
      return "text-red-400";
    case "provider_unsupported":
      return "text-gray-500";
    default:
      return "text-gray-400";
  }
}

function Cell({ status }: { status: string | null | undefined }) {
  return <span className={statusClass(status)}>{status ?? "—"}</span>;
}

export function AccountProfilePanel({ profile }: { profile: AccountProfile }) {
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
      <h2 className="mb-2 text-sm font-semibold text-gray-200">Account asset picture</h2>
      <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
        <div className="rounded-md border border-edge bg-panel p-2">
          <div className="text-[11px] text-gray-500">Visible buckets</div>
          <div className="text-sm font-medium text-gray-100">{profile.visible_count}</div>
        </div>
        <div className="rounded-md border border-edge bg-panel p-2">
          <div className="text-[11px] text-gray-500">Processed</div>
          <div className="text-sm font-medium text-gray-100">
            {profile.processed_count}
            {profile.truncated ? " (truncated)" : ""}
          </div>
        </div>
        <div className="rounded-md border border-edge bg-panel p-2">
          <div className="text-[11px] text-gray-500">ListBuckets</div>
          <div className={`text-sm font-medium ${statusClass(profile.list_status)}`}>{profile.list_status}</div>
        </div>
      </div>

      <div className="mb-2 flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`rounded-full border px-2 py-0.5 text-[11px] ${
              filter === f.value ? "border-violet-700 text-violet-300" : "border-edge text-gray-400 hover:text-gray-200"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="overflow-auto rounded-md border border-edge">
        <table className="w-full text-left text-[11px]">
          <thead className="bg-sidebar text-gray-400">
            <tr>
              <th className="px-2 py-1">Bucket</th>
              <th className="px-2 py-1">Region</th>
              <th className="px-2 py-1">Access</th>
              <th className="px-2 py-1">Encryption</th>
              <th className="px-2 py-1">Logging</th>
              <th className="px-2 py-1">Inventory</th>
              <th className="px-2 py-1">Lifecycle</th>
              <th className="px-2 py-1">Public block</th>
              <th className="px-2 py-1">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => {
              const evidence = [
                hasEvidence(b, "inventory") ? "inventory" : null,
                hasEvidence(b, "server_access_logging") ? "logging" : null,
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
                <td colSpan={9} className="px-2 py-2 text-gray-600">No buckets match this filter.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
