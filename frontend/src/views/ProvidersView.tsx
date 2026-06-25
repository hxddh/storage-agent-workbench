import { useEffect, useState } from "react";
import {
  createCloudProvider,
  createModelProvider,
  deleteCloudProvider,
  deleteModelProvider,
  listCloudProviders,
  listModelProviders,
  testModelProvider,
  updateCloudProvider,
  updateModelProvider,
  type CloudProviderInput,
  type ModelProviderInput,
} from "../api";
import type { CloudProvider, ModelProvider } from "../types";
import { Button, Field, Select, TextInput } from "../components/ui";

const KEYCHAIN_HINT = "已保存到系统 Keychain · 留空表示不修改";
const parseList = (s: string) =>
  s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

type Tab = "model" | "cloud";

export function ProvidersView() {
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
        {tab === "model" ? <ModelProvidersPanel /> : <CloudProvidersPanel />}
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
          <Field label="API key" hint={editing && editing.has_api_key ? KEYCHAIN_HINT : "保存后仅存入系统 Keychain，不会回显"}>
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
                  API key: {p.has_api_key ? <span className="text-emerald-400">已保存到系统 Keychain</span> : <span className="text-gray-600">未配置</span>}
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
  addressing_style: "virtual",
  signature_version: "s3v4",
  access_key: "",
  secret_key: "",
  session_token: "",
  mode: "readonly",
  allowed_buckets: "",
  allowed_prefixes: "",
};

function CloudProvidersPanel() {
  const [items, setItems] = useState<CloudProvider[]>([]);
  const [editing, setEditing] = useState<CloudProvider | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<CloudForm>(emptyCloudForm);
  const [error, setError] = useState<string | null>(null);

  const reload = () => listCloudProviders().then(setItems).catch((e) => setError(String(e)));
  useEffect(() => {
    reload();
  }, []);

  const openCreate = () => {
    setForm(emptyCloudForm);
    setEditing(null);
    setCreating(true);
    setError(null);
  };
  const openEdit = (p: CloudProvider) => {
    setForm({
      name: p.name,
      provider_type: p.provider_type,
      endpoint_url: p.endpoint_url ?? "",
      region: p.region ?? "",
      addressing_style: p.addressing_style ?? "virtual",
      signature_version: p.signature_version ?? "s3v4",
      access_key: "",
      secret_key: "",
      session_token: "",
      mode: p.mode,
      allowed_buckets: p.allowed_buckets.join(", "),
      allowed_prefixes: p.allowed_prefixes.join(", "),
    });
    setEditing(p);
    setCreating(false);
    setError(null);
  };
  const close = () => {
    setCreating(false);
    setEditing(null);
    setForm(emptyCloudForm); // clear secrets from memory
  };

  const submit = async () => {
    setError(null);
    const body: CloudProviderInput = {
      name: form.name,
      provider_type: form.provider_type,
      endpoint_url: form.endpoint_url || undefined,
      region: form.region || undefined,
      addressing_style: form.addressing_style || undefined,
      signature_version: form.signature_version || undefined,
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

  const secretHint = (has: boolean) => (editing && has ? KEYCHAIN_HINT : "保存后仅存入系统 Keychain，不会回显");
  const showForm = creating || editing;

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-200">Cloud Providers</h2>
        {!showForm && <Button variant="primary" onClick={openCreate}>+ Add cloud provider</Button>}
      </div>
      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}

      {showForm ? (
        <div className="mb-6 rounded-lg border border-edge bg-panel p-4">
          <div className="grid grid-cols-2 gap-x-4">
            <Field label="Name">
              <TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="minio-local" />
            </Field>
            <Field label="Provider type">
              <TextInput value={form.provider_type} onChange={(e) => setForm({ ...form, provider_type: e.target.value })} placeholder="s3-compatible" />
            </Field>
            <Field label="Endpoint URL">
              <TextInput value={form.endpoint_url} onChange={(e) => setForm({ ...form, endpoint_url: e.target.value })} placeholder="https://s3.example.com" />
            </Field>
            <Field label="Region">
              <TextInput value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} placeholder="us-east-1" />
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
            <Field label="Mode">
              <Select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as CloudForm["mode"] })}>
                <option value="readonly">readonly</option>
                <option value="test-write">test-write</option>
              </Select>
            </Field>
          </div>

          <Field label="Access key" hint={secretHint(editing?.has_access_key ?? false)}>
            <TextInput type="password" autoComplete="off" value={form.access_key} onChange={(e) => setForm({ ...form, access_key: e.target.value })} placeholder={editing?.has_access_key ? "••••••••（已保存）" : ""} />
          </Field>
          <Field label="Secret key" hint={secretHint(editing?.has_secret_key ?? false)}>
            <TextInput type="password" autoComplete="off" value={form.secret_key} onChange={(e) => setForm({ ...form, secret_key: e.target.value })} placeholder={editing?.has_secret_key ? "••••••••（已保存）" : ""} />
          </Field>
          <Field label="Session token (optional)" hint={secretHint(editing?.has_session_token ?? false)}>
            <TextInput type="password" autoComplete="off" value={form.session_token} onChange={(e) => setForm({ ...form, session_token: e.target.value })} placeholder={editing?.has_session_token ? "••••••••（已保存）" : ""} />
          </Field>
          <Field label="Allowed buckets" hint="逗号或换行分隔">
            <TextInput value={form.allowed_buckets} onChange={(e) => setForm({ ...form, allowed_buckets: e.target.value })} placeholder="bucket-alpha, bucket-beta" />
          </Field>
          <Field label="Allowed prefixes" hint="逗号或换行分隔">
            <TextInput value={form.allowed_prefixes} onChange={(e) => setForm({ ...form, allowed_prefixes: e.target.value })} placeholder="logs/, datasets/" />
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
            <div className="flex items-start justify-between">
              <div>
                <div className="text-sm font-medium text-gray-100">{p.name}</div>
                <div className="text-xs text-gray-500">{p.provider_type} · {p.region || "—"} · {p.endpoint_url || "—"}</div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-gray-500">
                  <span>mode: <span className={p.mode === "readonly" ? "text-emerald-400" : "text-amber-400"}>{p.mode}</span></span>
                  <span>access key: {p.has_access_key ? <span className="text-emerald-400">已保存到系统 Keychain</span> : <span className="text-gray-600">未配置</span>}</span>
                  <span>secret key: {p.has_secret_key ? <span className="text-emerald-400">已保存到系统 Keychain</span> : <span className="text-gray-600">未配置</span>}</span>
                </div>
                {(p.allowed_buckets.length > 0 || p.allowed_prefixes.length > 0) && (
                  <div className="mt-1 text-xs text-gray-600">
                    buckets: {p.allowed_buckets.join(", ") || "—"} · prefixes: {p.allowed_prefixes.join(", ") || "—"}
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <Button onClick={() => openEdit(p)}>Edit</Button>
                <Button variant="danger" onClick={() => remove(p)}>Delete</Button>
              </div>
            </div>
          </li>
        ))}
        {items.length === 0 && !showForm && <li className="text-sm text-gray-600">No cloud providers yet.</li>}
      </ul>
    </div>
  );
}
