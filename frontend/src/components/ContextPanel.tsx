const FIELDS: { label: string; value: string }[] = [
  { label: "Cloud Provider", value: "—" },
  { label: "Bucket", value: "—" },
  { label: "Endpoint", value: "—" },
  { label: "Region", value: "—" },
  { label: "Mode", value: "readonly" },
  { label: "Allowed Prefixes", value: "—" },
  { label: "Risk Policy", value: "—" },
  { label: "Approval", value: "Not required" },
];

export function ContextPanel() {
  return (
    <aside className="w-72 shrink-0 overflow-auto border-l border-edge bg-panel">
      <div className="border-b border-edge px-4 py-4">
        <div className="text-sm font-semibold text-gray-100">Context</div>
        <div className="text-xs text-gray-500">No provider selected</div>
      </div>

      <dl className="px-4 py-3">
        {FIELDS.map((f) => (
          <div key={f.label} className="flex items-center justify-between border-b border-edge/60 py-2">
            <dt className="text-xs text-gray-500">{f.label}</dt>
            <dd className="text-xs font-medium text-gray-300">{f.value}</dd>
          </div>
        ))}
      </dl>

      <p className="px-4 py-3 text-xs text-gray-600">
        Default mode is <span className="text-gray-400">readonly</span>. Provider
        selection and credentials (via system Keychain) arrive in later phases.
      </p>
    </aside>
  );
}
