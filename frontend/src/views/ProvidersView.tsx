import { useEffect, useState } from "react";
import {
  createCloudProvider,
  createModelProvider,
  createRun,
  deleteCloudProvider,
  deleteModelProvider,
  listCloudProviders,
  listModelProviders,
  postRunMessage,
  testModelProvider,
  updateCloudProvider,
  updateModelProvider,
  type CloudProviderInput,
  type ModelProviderInput,
} from "../api";
import type { CloudProvider, ModelProvider } from "../types";
import { Button, Field, Select, TextInput } from "../components/ui";
import { CloudProviderTester } from "../components/CloudProviderTester";

const KEYCHAIN_HINT = "Saved in the OS keychain · leave blank to keep";
const parseList = (s: string) =>
  s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

type Tab = "model" | "cloud";

export function ProvidersView({ onRunCreated }: { onRunCreated?: (runId: string) => void } = {}) {
  const [tab, setTab] = useState<Tab>("model");
  return (
    <div className="flex flex-1 flex-col overflow-auto bg-canvas">
      <header className="border-b border-edge px-8 py-4">
        <h1 className="text-lg font-semibold text-gray-100">Providers</h1>
        <p className="text-sm text-gray-500">Configure model and cloud storage providers</p>
        <div className="mt-3 flex gap-2">
          <Button variant={tab === "model" ? "primary" : "default"} onClick={() => setTab("model")}>
            Model Providers
          </Button>
          <Button variant={tab === "cloud" ? "primary" : "default"} onClick={() => setTab("cloud")}>
            Cloud Providers
          </Button>
        </div>
      </header>
      <div className="flex-1 p-8">
        {tab === "model" ? <ModelProvidersPanel /> : <CloudProvidersPanel onRunCreated={onRunCreated} />}
      </div>
    </div>
  );
}

// --- Model providers --------------------------------------------------------

const emptyModelForm: ModelProviderInput = {
  name: "",
  provider_type: "openai",
  base_url: "",
  model: "",
  api_key: "",
};

function ModelProvidersPanel() {
  const [items, setItems] = useState<ModelProvider[]>([]);
  const [editing, setEditing] = useState<ModelProvider | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ModelProviderInput>(emptyModelForm);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const reload = () => listModelProviders().then(setItems).catch((e) => setError(String(e)));
  useEffect(() => {
    reload();
  }, []);

  const openCreate = () => {
    setForm(emptyModelForm);
    setEditing(null);
    setCreating(true);
    setError(null);
  };
  const openEdit = (p: ModelProvider) => {
    setForm({
      name: p.name,
      provider_type: p.provider_type,
      base_url: p.base_url ?? "",
      model: p.model ?? "",
      api_key: "", // never prefill secrets
    });
    setEditing(p);
    setCreating(false);
    setError(null);
  };
  const close = () => {
    setCreating(false);
    setEditing(null);
    setForm(emptyModelForm); // clear secret from memory
  };

  const submit = async () => {
    setError(null);
    const body: ModelProviderInput = {
      name: form.name,
      provider_type: form.provider_type,
      base_url: form.base_url || undefined,
      model: form.model || undefined,
    };
    if (form.api_key && form.api_key.trim()) body.api_key = form.api_key;
    try {
      if (editing) await updateModelProvider(editing.id, body);
      else await createModelProvider(body);
      close();
      reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const remove = async (p: ModelProvider) => {
    if (!confirm(`Delete model provider "${p.name}"?`)) return;
    await deleteModelProvider(p.id);
    reload();
  };

  const runTest = async (p: ModelProvider) => {
    setStatus(null);
    try {
      const r = await testModelProvider(p.id);
      setStatus(`${p.name}: ${r.ok ? "OK" : "incomplete"} — ${r.detail}`);
    } catch (e) {
      setStatus(String(e));
    }
  };

  const showForm = creating || editing;

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-200">Model Providers</h2>
        {!showForm && <Button variant="primary" onClick={openCreate}>+ Add model provider</Button>}
      </div>
      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
      {status && <p className="mb-3 text-xs text-emerald-400" data-testid="model-test-status">{status}</p>}

      {showForm ? (
        <div className="mb-6 rounded-lg border border-edge bg-panel p-4">
          <Field label="Name">
            <TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="OpenAI prod" />
          </Field>
          <Field label="Provider type">
            <TextInput value={form.provider_type} onChange={(e) => setForm({ ...form, provider_type: e.target.value })} placeholder="openai" />
          </Field>
          <Field label="Base URL">
            <TextInput value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://api.openai.com/v1" />
          </Field>
          <Field label="Model">
            <TextInput value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="gpt-4o" />
          </Field>
          <Field label="API key" hint={editing && editing.has_api_key ? KEYCHAIN_HINT : "Stored only in the OS keychain — never shown again."}>
            <TextInput
              type="password"
              autoComplete="off"
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
              placeholder={editing && editing.has_api_key ? "••••••••（已保存）" : ""}
            />
          </Field>
          <div className="flex gap-2">
            <Button variant="primary" onClick={submit}>{editing ? "Save" : "Create"}</Button>
            <Button variant="ghost" onClick={close}>Cancel</Button>
          </div>
        </div>
      ) : null}

      <ul className="space-y-2">
        {items.map((p) => (
          <li key={p.id} className="rounded-lg border border-edge bg-panel p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-gray-100">{p.name}</div>
                <div className="text-xs text-gray-500">{p.provider_type} · {p.model || "—"} · {p.base_url || "—"}</div>
                <div className="mt-1 text-xs text-gray-500">
                  API key: {p.has_api_key ? <span className="text-emerald-400">saved in keychain</span> : <span className="text-gray-600">not set</span>}
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => runTest(p)}>Test</Button>
                <Button onClick={() => openEdit(p)}>Edit</Button>
                <Button variant="danger" onClick={() => remove(p)}>Delete</Button>
              </div>
            </div>
          </li>
        ))}
        {items.length === 0 && !showForm && <li className="text-sm text-gray-600">No model providers yet.</li>}
      </ul>
    </div>
  );
}

// --- Cloud providers --------------------------------------------------------

interface CloudForm {
  name: string;
  provider_type: string;
  endpoint_url: string;
  region: string;
  account: string;
  addressing_style: string;
  signature_version: string;
  access_key: string;
  secret_key: string;
  session_token: string;
  mode: "readonly" | "test-write";
  allowed_buckets: string;
  allowed_prefixes: string;
}

const emptyCloudForm: CloudForm = {
  name: "",
  provider_type: "s3-compatible",
  endpoint_url: "",
  region: "",
  account: "",
  addressing_style: "virtual",
  signature_version: "s3v4",
  access_key: "",
  secret_key: "",
  session_token: "",
  mode: "readonly",
  allowed_buckets: "",
  allowed_prefixes: "",
};

// One-pick presets: choosing a provider fills endpoint/addressing/signature so
// the user only enters region (or account) + AK/SK. "custom" exposes endpoint.
type Preset = {
  id: string;
  label: string;
  providerType: string;
  endpointTemplate: string; // {region} / {account} placeholders; "" = AWS default
  variable: "region" | "account" | "endpoint" | "none";
  regionDefault: string;
  regionPlaceholder?: string;
  addressing: "virtual" | "path";
  signature: string;
  hint?: string;
};

const CLOUD_PRESETS: Preset[] = [
  { id: "aws", label: "AWS S3", providerType: "aws-s3", endpointTemplate: "", variable: "region", regionDefault: "us-east-1", addressing: "virtual", signature: "s3v4" },
  { id: "oss", label: "Alibaba Cloud OSS", providerType: "alibaba-oss", endpointTemplate: "https://oss-{region}.aliyuncs.com", variable: "region", regionDefault: "cn-hangzhou", addressing: "virtual", signature: "s3v4" },
  { id: "cos", label: "Tencent Cloud COS", providerType: "tencent-cos", endpointTemplate: "https://cos.{region}.myqcloud.com", variable: "region", regionDefault: "ap-guangzhou", addressing: "virtual", signature: "s3v4" },
  { id: "bos", label: "Baidu BOS", providerType: "baidu-bos", endpointTemplate: "https://s3.{region}.bcebos.com", variable: "region", regionDefault: "bj", addressing: "virtual", signature: "s3v4" },
  { id: "tos", label: "Volcengine TOS", providerType: "volcengine-tos", endpointTemplate: "https://tos-s3-{region}.volces.com", variable: "region", regionDefault: "cn-beijing", addressing: "virtual", signature: "s3v4" },
  { id: "r2", label: "Cloudflare R2", providerType: "cloudflare-r2", endpointTemplate: "https://{account}.r2.cloudflarestorage.com", variable: "account", regionDefault: "auto", addressing: "path", signature: "s3v4", hint: "Account ID is in your R2 dashboard URL." },
  { id: "b2", label: "Backblaze B2", providerType: "backblaze-b2", endpointTemplate: "https://s3.{region}.backblazeb2.com", variable: "region", regionDefault: "us-west-004", regionPlaceholder: "us-west-004", addressing: "virtual", signature: "s3v4" },
  { id: "gcs", label: "Google Cloud Storage", providerType: "gcs-s3", endpointTemplate: "https://storage.googleapis.com", variable: "region", regionDefault: "auto", addressing: "path", signature: "s3v4", hint: "Use S3 interop (HMAC) keys — not a GCP service account." },
  { id: "custom", label: "Custom (S3-compatible)", providerType: "s3-compatible", endpointTemplate: "", variable: "endpoint", regionDefault: "", addressing: "virtual", signature: "s3v4" },
];

function CloudProvidersPanel({ onRunCreated }: { onRunCreated?: (runId: string) => void }) {
  const [items, setItems] = useState<CloudProvider[]>([]);
  const [editing, setEditing] = useState<CloudProvider | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<CloudForm>(emptyCloudForm);
  const [presetId, setPresetId] = useState<string>("aws");
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());

  const preset = CLOUD_PRESETS.find((p) => p.id === presetId) ?? CLOUD_PRESETS[0];

  const discoverAccount = async (p: CloudProvider) => {
    setError(null);
    try {
      const created = await createRun({
        run_type: "account_discovery",
        provider_id: p.id,
        user_prompt: "Discover account-level buckets and evidence sources.",
        title: `Account discovery: ${p.name}`,
      });
      await postRunMessage(created.run_id, "discover");
      onRunCreated?.(created.run_id);
    } catch (e) {
      setError(String(e));
    }
  };

  const toggleTesting = (id: string) =>
    setTestingIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const reload = () => listCloudProviders().then(setItems).catch((e) => setError(String(e)));
  useEffect(() => {
    reload();
  }, []);

  const applyPreset = (id: string) => {
    const p = CLOUD_PRESETS.find((x) => x.id === id) ?? CLOUD_PRESETS[0];
    setPresetId(id);
    setForm((f) => ({
      ...f,
      name: p.label,
      provider_type: p.providerType,
      region: p.regionDefault,
      account: "",
      endpoint_url: "",
      addressing_style: p.addressing,
      signature_version: p.signature,
    }));
  };

  const openCreate = () => {
    setForm({ ...emptyCloudForm });
    setPresetId("aws");
    applyPreset("aws");
    setAdvanced(false);
    setEditing(null);
    setCreating(true);
    setError(null);
  };
  const openEdit = (p: CloudProvider) => {
    // Editing always uses the explicit (custom) view with the stored endpoint.
    setForm({
      name: p.name,
      provider_type: p.provider_type,
      endpoint_url: p.endpoint_url ?? "",
      region: p.region ?? "",
      account: "",
      addressing_style: p.addressing_style ?? "virtual",
      signature_version: p.signature_version ?? "s3v4",
      access_key: "",
      secret_key: "",
      session_token: "",
      mode: p.mode,
      allowed_buckets: p.allowed_buckets.join(", "),
      allowed_prefixes: p.allowed_prefixes.join(", "),
    });
    setPresetId("custom");
    setAdvanced(true);
    setEditing(p);
    setCreating(false);
    setError(null);
  };
  const close = () => {
    setCreating(false);
    setEditing(null);
    setForm({ ...emptyCloudForm }); // clear secrets from memory
  };

  const computedEndpoint = (): string => {
    if (presetId === "custom") return form.endpoint_url.trim();
    if (preset.variable === "account") return preset.endpointTemplate.replace("{account}", form.account.trim());
    if (preset.endpointTemplate) return preset.endpointTemplate.replace("{region}", (form.region || preset.regionDefault).trim());
    return ""; // AWS: let boto3 use the regional default
  };

  const submit = async () => {
    setError(null);
    const endpoint = computedEndpoint();
    const region = preset.variable === "account" ? preset.regionDefault : form.region || preset.regionDefault;
    const body: CloudProviderInput = {
      name: form.name || preset.label,
      provider_type: presetId === "custom" ? form.provider_type || "s3-compatible" : preset.providerType,
      endpoint_url: endpoint || undefined,
      region: region || undefined,
      addressing_style: form.addressing_style || preset.addressing,
      signature_version: form.signature_version || preset.signature,
      mode: form.mode,
      allowed_buckets: parseList(form.allowed_buckets),
      allowed_prefixes: parseList(form.allowed_prefixes),
    };
    if (form.access_key.trim()) body.access_key = form.access_key;
    if (form.secret_key.trim()) body.secret_key = form.secret_key;
    if (form.session_token.trim()) body.session_token = form.session_token;
    try {
      if (editing) await updateCloudProvider(editing.id, body);
      else await createCloudProvider(body);
      close();
      reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const remove = async (p: CloudProvider) => {
    if (!confirm(`Delete cloud provider "${p.name}"?`)) return;
    await deleteCloudProvider(p.id);
    reload();
  };

  const secretHint = (has: boolean) => (editing && has ? "Saved in the OS keychain · leave blank to keep" : "Stored only in the OS keychain — never shown again.");
  const showForm = creating || editing;

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-200">Cloud providers</h2>
        {!showForm && <Button variant="primary" onClick={openCreate}>Add cloud provider</Button>}
      </div>
      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}

      {showForm ? (
        <div className="mb-6 rounded-xl border border-edge bg-panel p-4">
          {!editing && (
            <Field label="Provider">
              <Select value={presetId} onChange={(e) => applyPreset(e.target.value)}>
                {CLOUD_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </Select>
            </Field>
          )}

          {presetId === "custom" || editing ? (
            <div className="grid grid-cols-2 gap-x-4">
              <Field label="Endpoint URL">
                <TextInput value={form.endpoint_url} onChange={(e) => setForm({ ...form, endpoint_url: e.target.value })} placeholder="https://s3.example.com" />
              </Field>
              <Field label="Region">
                <TextInput value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} placeholder="us-east-1" />
              </Field>
            </div>
          ) : preset.variable === "account" ? (
            <Field label="Account ID" hint={preset.hint}>
              <TextInput value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value })} placeholder="a1b2c3d4e5f6…" />
            </Field>
          ) : preset.variable === "region" ? (
            <Field label="Region" hint={preset.hint}>
              <TextInput value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} placeholder={preset.regionPlaceholder || preset.regionDefault} />
            </Field>
          ) : null}

          <div className="grid grid-cols-2 gap-x-4">
            <Field label="Access key ID" hint={secretHint(editing?.has_access_key ?? false)}>
              <TextInput type="password" autoComplete="off" value={form.access_key} onChange={(e) => setForm({ ...form, access_key: e.target.value })} placeholder={editing?.has_access_key ? "•••••••• (saved)" : ""} />
            </Field>
            <Field label="Secret access key" hint={secretHint(editing?.has_secret_key ?? false)}>
              <TextInput type="password" autoComplete="off" value={form.secret_key} onChange={(e) => setForm({ ...form, secret_key: e.target.value })} placeholder={editing?.has_secret_key ? "•••••••• (saved)" : ""} />
            </Field>
          </div>

          <button
            onClick={() => setAdvanced((a) => !a)}
            className="mb-2 mt-1 flex items-center gap-1 text-xs text-gray-500 transition-colors hover:text-gray-300"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`transition-transform ${advanced ? "rotate-90" : ""}`}>
              <polyline points="9 18 15 12 9 6" />
            </svg>
            Advanced
          </button>

          {advanced && (
            <div className="mb-1 rounded-lg border border-edge bg-canvas/50 p-3">
              <div className="grid grid-cols-2 gap-x-4">
                <Field label="Name">
                  <TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={preset.label} />
                </Field>
                <Field label="Mode">
                  <Select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as CloudForm["mode"] })}>
                    <option value="readonly">readonly</option>
                    <option value="test-write">test-write</option>
                  </Select>
                </Field>
                <Field label="Addressing style">
                  <Select value={form.addressing_style} onChange={(e) => setForm({ ...form, addressing_style: e.target.value })}>
                    <option value="virtual">virtual</option>
                    <option value="path">path</option>
                  </Select>
                </Field>
                <Field label="Signature version">
                  <TextInput value={form.signature_version} onChange={(e) => setForm({ ...form, signature_version: e.target.value })} placeholder="s3v4" />
                </Field>
              </div>
              <Field label="Session token (optional)" hint={secretHint(editing?.has_session_token ?? false)}>
                <TextInput type="password" autoComplete="off" value={form.session_token} onChange={(e) => setForm({ ...form, session_token: e.target.value })} placeholder={editing?.has_session_token ? "•••••••• (saved)" : ""} />
              </Field>
              <Field label="Allowed buckets" hint="comma- or newline-separated; empty = all visible">
                <TextInput value={form.allowed_buckets} onChange={(e) => setForm({ ...form, allowed_buckets: e.target.value })} placeholder="bucket-alpha, bucket-beta" />
              </Field>
              <Field label="Allowed prefixes" hint="comma- or newline-separated">
                <TextInput value={form.allowed_prefixes} onChange={(e) => setForm({ ...form, allowed_prefixes: e.target.value })} placeholder="logs/, datasets/" />
              </Field>
            </div>
          )}

          <div className="mt-2 flex gap-2">
            <Button variant="primary" onClick={submit}>{editing ? "Save" : "Add provider"}</Button>
            <Button variant="ghost" onClick={close}>Cancel</Button>
          </div>
          <p className="mt-2 text-[11px] text-gray-600">Keys are stored in the OS keychain and used read-only by default.</p>
        </div>
      ) : null}

      <ul className="space-y-2">
        {items.map((p) => (
          <li key={p.id} className="rounded-lg border border-edge bg-panel p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-sm font-medium text-gray-100">{p.name}</div>
                <div className="text-xs text-gray-500">{p.provider_type} · {p.region || "—"} · {p.endpoint_url || "—"}</div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-gray-500">
                  <span>mode: <span className={p.mode === "readonly" ? "text-emerald-400" : "text-amber-400"}>{p.mode}</span></span>
                  <span>access key: {p.has_access_key ? <span className="text-emerald-400">saved in keychain</span> : <span className="text-gray-600">not set</span>}</span>
                  <span>secret key: {p.has_secret_key ? <span className="text-emerald-400">saved in keychain</span> : <span className="text-gray-600">not set</span>}</span>
                </div>
                {(p.allowed_buckets.length > 0 || p.allowed_prefixes.length > 0) && (
                  <div className="mt-1 text-xs text-gray-600">
                    buckets: {p.allowed_buckets.join(", ") || "—"} · prefixes: {p.allowed_prefixes.join(", ") || "—"}
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant={testingIds.has(p.id) ? "primary" : "default"} onClick={() => toggleTesting(p.id)}>
                  Test Connection
                </Button>
                <Button onClick={() => discoverAccount(p)}>Discover account</Button>
                <Button onClick={() => openEdit(p)}>Edit</Button>
                <Button variant="danger" onClick={() => remove(p)}>Delete</Button>
              </div>
            </div>
            {testingIds.has(p.id) && <CloudProviderTester provider={p} />}
          </li>
        ))}
        {items.length === 0 && !showForm && <li className="text-sm text-gray-600">No cloud providers yet.</li>}
      </ul>
    </div>
  );
}
