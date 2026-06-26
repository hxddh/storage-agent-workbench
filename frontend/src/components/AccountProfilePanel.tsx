import { useMemo, useState } from "react";
import type { AccountBucket, AccountProfile } from "../types";
import { EvidenceImportDialog } from "./EvidenceImportDialog";

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

export function AccountProfilePanel({
  profile,
  onOpenRun,
}: {
  profile: AccountProfile;
  onOpenRun?: (runId: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [importing, setImporting] = useState<{ bucket: string; sourceType: "inventory" | "access_log" } | null>(null);

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
              <th className="px-2 py-1">Import</th>
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
                  <td className="px-2 py-1">
                    <div className="flex gap-1">
                      {hasEvidence(b, "inventory") && (
                        <button
                          className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-gray-300 hover:border-violet-700 hover:text-violet-300"
                          onClick={() => setImporting({ bucket: b.bucket_name, sourceType: "inventory" })}
                        >
                          Inv
                        </button>
                      )}
                      {hasEvidence(b, "server_access_logging") && (
                        <button
                          className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-gray-300 hover:border-violet-700 hover:text-violet-300"
                          onClick={() => setImporting({ bucket: b.bucket_name, sourceType: "access_log" })}
                        >
                          Logs
                        </button>
                      )}
                      {!hasEvidence(b, "inventory") && !hasEvidence(b, "server_access_logging") && (
                        <span className="text-gray-600">—</span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {buckets.length === 0 && (
              <tr>
                <td colSpan={10} className="px-2 py-2 text-gray-600">No buckets match this filter.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {importing && (
        <EvidenceImportDialog
          accountRunId={profile.run_id}
          bucketName={importing.bucket}
          sourceType={importing.sourceType}
          onClose={() => setImporting(null)}
          onImported={(runId) => {
            setImporting(null);
            onOpenRun?.(runId);
          }}
        />
      )}
    </div>
  );
}
