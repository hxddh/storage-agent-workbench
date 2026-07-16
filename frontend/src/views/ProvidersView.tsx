import { useEffect, useState } from "react";
import {
  activateModelProvider,
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
import { CloudProviderTester } from "../components/CloudProviderTester";
import { useI18n } from "../i18n";

const parseList = (s: string) =>
  s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

type Tab = "model" | "cloud";

export function ProvidersView() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("model");
  return (
    <div className="flex flex-1 flex-col overflow-auto bg-canvas">
      <header className="border-b border-edge px-8 py-5">
        <div className="mb-1 text-sm font-semibold text-gray-100">{t("prov.title")}</div>
        <p className="mb-4 text-xs leading-relaxed text-gray-500">{t("prov.subtitle")}</p>
        <div className="flex gap-2">
          <Button variant={tab === "model" ? "primary" : "default"} onClick={() => setTab("model")}>
            {t("prov.tabModel")}
          </Button>
          <Button variant={tab === "cloud" ? "primary" : "default"} onClick={() => setTab("cloud")}>
            {t("prov.tabCloud")}
          </Button>
        </div>
      </header>
      <div className="flex-1 px-8 py-5">
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
  context_window: null,
};

function ModelProvidersPanel() {
  const { t } = useI18n();
  const [items, setItems] = useState<ModelProvider[]>([]);
  const [editing, setEditing] = useState<ModelProvider | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ModelProviderInput>(emptyModelForm);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

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
      context_window: p.context_window ?? null,
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
      // On EDIT, send "" verbatim — the API treats "" as "clear to NULL", so
      // blanking a field actually removes it (it used to silently revert).
      base_url: editing ? form.base_url ?? "" : form.base_url || undefined,
      model: editing ? form.model ?? "" : form.model || undefined,
    };
    if (form.api_key && form.api_key.trim()) body.api_key = form.api_key;
    if (form.context_window && form.context_window > 0) {
      body.context_window = form.context_window;
    } else if (editing && editing.context_window) {
      body.context_window = 0; // field cleared → 0 tells the API to reset to NULL
    }
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
    // Inline confirm (window.confirm is a no-op in the Tauri webview).
    setError(null);
    try {
      await deleteModelProvider(p.id);
      setConfirmId(null);
      reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const runTest = async (p: ModelProvider) => {
    setStatus(null);
    try {
      const r = await testModelProvider(p.id);
      setStatus(`${p.name}: ${r.ok ? t("prov.testOk") : t("prov.testIncomplete")} — ${r.detail}`);
    } catch (e) {
      setStatus(String(e));
    }
  };

  const activate = async (p: ModelProvider) => {
    setError(null);
    try {
      await activateModelProvider(p.id);
      reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const showForm = creating || editing;

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-200">{t("prov.tabModel")}</h2>
        {!showForm && <Button variant="primary" onClick={openCreate}>{t("prov.addModel")}</Button>}
      </div>
      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}
      {status && <p className="mb-3 text-xs text-emerald-400" data-testid="model-test-status">{status}</p>}

      {showForm ? (
        <div className="mb-6 rounded-lg border border-edge bg-panel p-4">
          <Field label={t("prov.fName")}>
            <TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="OpenAI prod" />
          </Field>
          <Field label={t("prov.fProviderType")}>
            <TextInput value={form.provider_type} onChange={(e) => setForm({ ...form, provider_type: e.target.value })} placeholder="openai" />
          </Field>
          <Field label={t("prov.fBaseUrl")}>
            <TextInput value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="https://api.openai.com/v1" />
          </Field>
          <Field label={t("prov.fModel")}>
            <TextInput value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="gpt-4o" />
          </Field>
          <Field label={t("prov.fContextWindow")} hint={t("prov.hintContextWindow")}>
            <TextInput
              inputMode="numeric"
              value={form.context_window != null ? String(form.context_window) : ""}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9]/g, "");
                setForm({ ...form, context_window: v ? parseInt(v, 10) : null });
              }}
              placeholder="1000000"
            />
          </Field>
          <Field label={t("prov.fApiKey")} hint={editing && editing.has_api_key ? t("prov.hintKeep") : t("prov.hintNew")}>
            <TextInput
              type="password"
              autoComplete="off"
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
              placeholder={editing && editing.has_api_key ? t("prov.savedPlaceholder") : ""}
            />
          </Field>
          <div className="flex gap-2">
            <Button variant="primary" onClick={submit}>{editing ? t("prov.save") : t("prov.create")}</Button>
            <Button variant="ghost" onClick={close}>{t("prov.cancel")}</Button>
          </div>
        </div>
      ) : null}

      <ul className="space-y-2">
        {items.map((p) => (
          <li key={p.id} className="rounded-lg border border-edge bg-panel p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-gray-100">
                  {p.name}
                  {p.active && (
                    <span className="rounded-full border border-emerald-700 bg-emerald-950/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-400" data-testid="active-model-badge">
                      {t("prov.active")}
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500">{p.provider_type} · {p.model || "—"} · {p.base_url || "—"}</div>
                <div className="mt-1 text-xs text-gray-500">
                  {t("prov.apiKeyLabel")}: {p.has_api_key ? <span className="text-emerald-400">{t("prov.savedKeychain")}</span> : <span className="text-gray-600">{t("prov.notSet")}</span>}
                </div>
              </div>
              <div className="flex gap-2">
                {!p.active && items.length > 1 && (
                  <Button variant="ghost" onClick={() => activate(p)}>{t("prov.setActive")}</Button>
                )}
                <Button variant="ghost" onClick={() => runTest(p)}>{t("prov.test")}</Button>
                <Button onClick={() => openEdit(p)}>{t("prov.edit")}</Button>
                {confirmId === p.id ? (
                  <>
                    <Button variant="ghost" onClick={() => setConfirmId(null)}>{t("prov.cancel")}</Button>
                    <Button variant="danger" onClick={() => remove(p)}>{t("prov.confirmDelete")}</Button>
                  </>
                ) : (
                  <Button variant="danger" onClick={() => { setError(null); setConfirmId(p.id); }}>{t("prov.delete")}</Button>
                )}
              </div>
            </div>
          </li>
        ))}
        {items.length === 0 && !showForm && <li className="text-sm text-gray-600">{t("prov.noModel")}</li>}
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

function CloudProvidersPanel() {
  const { t } = useI18n();
  const [items, setItems] = useState<CloudProvider[]>([]);
  const [editing, setEditing] = useState<CloudProvider | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<CloudForm>(emptyCloudForm);
  const [presetId, setPresetId] = useState<string>("aws");
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());

  const preset = CLOUD_PRESETS.find((p) => p.id === presetId) ?? CLOUD_PRESETS[0];

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
      // On EDIT, "" means "clear to NULL" server-side — blanking the endpoint
      // actually removes it instead of silently reverting to the stored value.
      endpoint_url: editing ? endpoint : endpoint || undefined,
      region: editing ? region : region || undefined,
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
    // Inline confirm (window.confirm is a no-op in the Tauri webview).
    setError(null);
    try {
      await deleteCloudProvider(p.id);
      setConfirmId(null);
      reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const secretHint = (has: boolean) => (editing && has ? t("prov.hintKeep") : t("prov.hintNew"));
  const showForm = creating || editing;

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-200">{t("prov.tabCloud")}</h2>
        {!showForm && <Button variant="primary" onClick={openCreate}>{t("prov.addCloud")}</Button>}
      </div>
      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}

      {showForm ? (
        <div className="mb-6 rounded-xl border border-edge bg-panel p-4">
          {!editing && (
            <Field label={t("prov.fProvider")}>
              <Select value={presetId} onChange={(e) => applyPreset(e.target.value)}>
                {CLOUD_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </Select>
            </Field>
          )}

          {presetId === "custom" || editing ? (
            <div className="grid grid-cols-2 gap-x-4">
              <Field label={t("prov.fEndpoint")}>
                <TextInput value={form.endpoint_url} onChange={(e) => setForm({ ...form, endpoint_url: e.target.value })} placeholder="https://s3.example.com" />
              </Field>
              <Field label={t("prov.fRegion")}>
                <TextInput value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} placeholder="us-east-1" />
              </Field>
            </div>
          ) : preset.variable === "account" ? (
            <Field label={t("prov.fAccountId")} hint={preset.hint}>
              <TextInput value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value })} placeholder="a1b2c3d4e5f6…" />
            </Field>
          ) : preset.variable === "region" ? (
            <Field label={t("prov.fRegion")} hint={preset.hint}>
              <TextInput value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} placeholder={preset.regionPlaceholder || preset.regionDefault} />
            </Field>
          ) : null}

          <div className="grid grid-cols-2 gap-x-4">
            <Field label={t("prov.fAccessKey")} hint={secretHint(editing?.has_access_key ?? false)}>
              <TextInput type="password" autoComplete="off" value={form.access_key} onChange={(e) => setForm({ ...form, access_key: e.target.value })} placeholder={editing?.has_access_key ? t("prov.savedPlaceholder") : ""} />
            </Field>
            <Field label={t("prov.fSecretKey")} hint={secretHint(editing?.has_secret_key ?? false)}>
              <TextInput type="password" autoComplete="off" value={form.secret_key} onChange={(e) => setForm({ ...form, secret_key: e.target.value })} placeholder={editing?.has_secret_key ? t("prov.savedPlaceholder") : ""} />
            </Field>
          </div>

          <button
            onClick={() => setAdvanced((a) => !a)}
            className="mb-2 mt-1 flex items-center gap-1 text-xs text-gray-500 transition-colors hover:text-gray-300"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`transition-transform ${advanced ? "rotate-90" : ""}`}>
              <polyline points="9 18 15 12 9 6" />
            </svg>
            {t("prov.advanced")}
          </button>

          {advanced && (
            <div className="mb-1 rounded-lg border border-edge bg-canvas/50 p-3">
              <div className="grid grid-cols-2 gap-x-4">
                <Field label={t("prov.fName")}>
                  <TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={preset.label} />
                </Field>
                <Field label={t("prov.fMode")}>
                  <Select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as CloudForm["mode"] })}>
                    <option value="readonly">readonly</option>
                    <option value="test-write">test-write</option>
                  </Select>
                </Field>
                <Field label={t("prov.fAddressing")}>
                  <Select value={form.addressing_style} onChange={(e) => setForm({ ...form, addressing_style: e.target.value })}>
                    <option value="virtual">virtual</option>
                    <option value="path">path</option>
                  </Select>
                </Field>
                <Field label={t("prov.fSignature")}>
                  <TextInput value={form.signature_version} onChange={(e) => setForm({ ...form, signature_version: e.target.value })} placeholder="s3v4" />
                </Field>
              </div>
              <Field label={t("prov.fSessionToken")} hint={secretHint(editing?.has_session_token ?? false)}>
                <TextInput type="password" autoComplete="off" value={form.session_token} onChange={(e) => setForm({ ...form, session_token: e.target.value })} placeholder={editing?.has_session_token ? t("prov.savedPlaceholder") : ""} />
              </Field>
              <Field label={t("prov.fAllowedBuckets")} hint={t("prov.hintBuckets")}>
                <TextInput value={form.allowed_buckets} onChange={(e) => setForm({ ...form, allowed_buckets: e.target.value })} placeholder="bucket-alpha, bucket-beta" />
              </Field>
              <Field label={t("prov.fAllowedPrefixes")} hint={t("prov.hintPrefixes")}>
                <TextInput value={form.allowed_prefixes} onChange={(e) => setForm({ ...form, allowed_prefixes: e.target.value })} placeholder="logs/, datasets/" />
              </Field>
            </div>
          )}

          <div className="mt-2 flex gap-2">
            <Button variant="primary" onClick={submit}>{editing ? t("prov.save") : t("prov.addProvider")}</Button>
            <Button variant="ghost" onClick={close}>{t("prov.cancel")}</Button>
          </div>
          <p className="mt-2 text-[11px] text-gray-600">{t("prov.footerKeys")}</p>
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
                  <span>{t("prov.modeLabel")}: <span className={p.mode === "readonly" ? "text-emerald-400" : "text-amber-400"}>{p.mode}</span></span>
                  <span>{t("prov.accessKeyLabel")}: {p.has_access_key ? <span className="text-emerald-400">{t("prov.savedKeychain")}</span> : <span className="text-gray-600">{t("prov.notSet")}</span>}</span>
                  <span>{t("prov.secretKeyLabel")}: {p.has_secret_key ? <span className="text-emerald-400">{t("prov.savedKeychain")}</span> : <span className="text-gray-600">{t("prov.notSet")}</span>}</span>
                </div>
                {(p.allowed_buckets.length > 0 || p.allowed_prefixes.length > 0) && (
                  <div className="mt-1 text-xs text-gray-600">
                    {t("prov.bucketsLabel")}: {p.allowed_buckets.join(", ") || "—"} · {t("prov.prefixesLabel")}: {p.allowed_prefixes.join(", ") || "—"}
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant={testingIds.has(p.id) ? "primary" : "default"} onClick={() => toggleTesting(p.id)}>
                  {t("prov.testConnection")}
                </Button>
                <Button onClick={() => openEdit(p)}>{t("prov.edit")}</Button>
                {confirmId === p.id ? (
                  <>
                    <Button variant="ghost" onClick={() => setConfirmId(null)}>{t("prov.cancel")}</Button>
                    <Button variant="danger" onClick={() => remove(p)}>{t("prov.confirmDelete")}</Button>
                  </>
                ) : (
                  <Button variant="danger" onClick={() => { setError(null); setConfirmId(p.id); }}>{t("prov.delete")}</Button>
                )}
              </div>
            </div>
            {testingIds.has(p.id) && <CloudProviderTester provider={p} />}
          </li>
        ))}
        {items.length === 0 && !showForm && <li className="text-sm text-gray-600">{t("prov.noCloud")}</li>}
      </ul>
    </div>
  );
}
