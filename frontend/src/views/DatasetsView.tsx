import { useEffect, useState } from "react";
import { listDatasets } from "../api";
import type { Dataset } from "../types";

const STATUS_COLOR: Record<string, string> = {
  uploaded: "text-amber-400",
  imported: "text-emerald-400",
};

export function DatasetsView() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listDatasets().then(setDatasets).catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-auto bg-canvas">
      <header className="border-b border-edge px-8 py-4">
        <h1 className="text-lg font-semibold text-gray-100">Datasets</h1>
        <p className="text-sm text-gray-500">Imported access-log and inventory datasets</p>
      </header>

      <div className="p-8">
        {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
        <table className="w-full text-left text-xs">
          <thead className="text-gray-500">
            <tr className="border-b border-edge">
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Type</th>
              <th className="py-2 pr-4 font-medium">Run</th>
              <th className="py-2 pr-4 font-medium">Rows</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="text-gray-300">
            {datasets.map((d) => (
              <tr key={d.id} className="border-b border-edge/60" data-testid="dataset-row">
                <td className="py-2 pr-4">{d.name || d.source_filename || "—"}</td>
                <td className="py-2 pr-4">{d.dataset_type}</td>
                <td className="py-2 pr-4 font-mono text-gray-500">{d.run_id?.slice(0, 8) ?? "—"}</td>
                <td className="py-2 pr-4">{d.row_count ?? "—"}</td>
                <td className={`py-2 pr-4 ${STATUS_COLOR[d.status] ?? "text-gray-400"}`}>{d.status}</td>
                <td className="py-2 pr-4 text-gray-500">{d.created_at}</td>
              </tr>
            ))}
            {datasets.length === 0 && (
              <tr>
                <td colSpan={6} className="py-3 text-gray-600">No datasets yet. Create an analysis run to import one.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
