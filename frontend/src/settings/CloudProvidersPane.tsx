import { useEffect, useState } from "react";
import {
  createCloudProvider,
  deleteCloudProvider,
  listCloudProviders,
  updateCloudProvider,
  type CloudProviderInput,
} from "../api";
import type { CloudProvider } from "../types";
import { Button, Field, Select, TextInput } from "../components/ui";
import { CloudProviderTester } from "../components/CloudProviderTester";
import { Icon } from "../components/icons";
import { useI18n } from "../i18n";
import { CLOUD_PRESETS, cloudEndpoint, parseList, type CloudPreset } from "./presets";

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
  clear_session_token: boolean;
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
  clear_session_token: false,
  mode: "readonly",
  allowed_buckets: "",
  allowed_prefixes: "",
};

/** Cloud providers as a native preference pane: one list, presets, one editor, inline Test Connection. */
export function CloudProvidersPanel() {
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

  const preset: CloudPreset = CLOUD_PRESETS.find((item) => item.id === presetId) ?? CLOUD_PRESETS[0];

  const toggleTesting = (id: string) =>
    setTestingIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const reload = () => listCloudProviders().then(setItems).catch((e) => setError(String(e)));
  useEffect(() => { reload(); }, []);

  const applyPreset = (id: string) => {
    const next = CLOUD_PRESETS.find((item) => item.id === id) ?? CLOUD_PRESETS[0];
    setPresetId(id);
    setForm((current) => ({
      ...current,
      name: next.label,
      provider_type: next.providerType,
      region: next.regionDefault,
      account: "",
      endpoint_url: "",
      addressing_style: next.addressing,
      signature_version: next.signature,
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
  const openEdit = (provider: CloudProvider) => {
    // Editing always uses the explicit (custom) view with the stored endpoint.
    setForm({
      name: provider.name,
      provider_type: provider.provider_type,
      endpoint_url: provider.endpoint_url ?? "",
      region: provider.region ?? "",
      account: "",
      addressing_style: provider.addressing_style ?? "virtual",
      signature_version: provider.signature_version ?? "s3v4",
      access_key: "",
      secret_key: "",
      session_token: "",
      clear_session_token: false,
      mode: provider.mode,
      allowed_buckets: provider.allowed_buckets.join(", "),
      allowed_prefixes: provider.allowed_prefixes.join(", "),
    });
    setPresetId("custom");
    setAdvanced(true);
    setEditing(provider);
    setCreating(false);
    setError(null);
  };
  const close = () => {
    setCreating(false);
    setEditing(null);
    setForm({ ...emptyCloudForm }); // clear secrets from memory
  };

  const submit = async () => {
    setError(null);
    const endpoint = editing || presetId === "custom" ? form.endpoint_url.trim() : cloudEndpoint(preset, form);
    const region = preset.variable === "account" ? preset.regionDefault : form.region || preset.regionDefault;
    const body: CloudProviderInput = {
      name: form.name || preset.label,
      provider_type: editing || presetId === "custom" ? form.provider_type || "s3-compatible" : preset.providerType,
      // On EDIT, "" means "clear to NULL" server-side.
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
    // Explicit "" = clear the saved token server-side. Untouched fields stay omitted.
    else if (editing?.has_session_token && form.clear_session_token) body.session_token = "";
    try {
      if (editing) await updateCloudProvider(editing.id, body);
      else await createCloudProvider(body);
      close();
      reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const remove = async (provider: CloudProvider) => {
    setError(null);
    try {
      await deleteCloudProvider(provider.id);
      setConfirmId(null);
      reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const secretHint = (has: boolean) => (editing && has ? t("prov.hintKeep") : t("prov.hintNew"));
  const showForm = creating || editing;
  const explicitEndpoint = presetId === "custom" || editing;

  return (
    <div className="max-w-3xl" data-testid="settings-cloud-providers">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium text-gray-100">{t("prov.tabCloud")}</h2>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">{t("prov.cloudHint")}</p>
        </div>
        {!showForm ? <Button variant="primary" onClick={openCreate}>{t("prov.addCloud")}</Button> : null}
      </div>
      {error ? <p className="native-banner mb-3" data-tone="danger">{error}</p> : null}

      {showForm ? (
        <div className="native-settings-editor" data-testid="cloud-editor">
          <div className="native-settings-editor-head">
            <strong>{editing ? editing.name : t("prov.addCloud")}</strong>
            {editing ? <span className="text-gray-500">{editing.provider_type}</span> : null}
          </div>
          {!editing ? (
            <Field label={t("prov.fProvider")}>
              <Select value={presetId} onChange={(e) => applyPreset(e.target.value)}>
                {CLOUD_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </Select>
            </Field>
          ) : null}

          {explicitEndpoint ? (
            <div className="grid grid-cols-2 gap-x-4">
              <Field label={t("prov.fEndpoint")} hint={preset.hint}>
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
          ) : preset.variable === "endpoint" ? (
            <div className="grid grid-cols-2 gap-x-4">
              <Field label={t("prov.fEndpoint")} hint={preset.hint}>
                <TextInput value={form.endpoint_url} onChange={(e) => setForm({ ...form, endpoint_url: e.target.value })} placeholder="https://minio.example.com:9000" />
              </Field>
              <Field label={t("prov.fRegion")}>
                <TextInput value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} placeholder={preset.regionDefault} />
              </Field>
            </div>
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

          <button type="button" onClick={() => setAdvanced((value) => !value)} className="native-settings-advanced" aria-expanded={advanced}>
            <Icon name="chevron" size={11} className={advanced ? "rotate-90" : ""} />
            {t("prov.advanced")}
          </button>

          {advanced ? (
            <div className="native-settings-advanced-body">
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
              {editing?.has_session_token && !form.session_token.trim() ? (
                <label className="-mt-2 mb-3 flex items-center gap-2 text-xs text-gray-400">
                  <input type="checkbox" checked={form.clear_session_token} onChange={(e) => setForm({ ...form, clear_session_token: e.target.checked })} />
                  {t("prov.clearToken")}
                </label>
              ) : null}
              <Field label={t("prov.fAllowedBuckets")} hint={t("prov.hintBuckets")}>
                <TextInput value={form.allowed_buckets} onChange={(e) => setForm({ ...form, allowed_buckets: e.target.value })} placeholder="bucket-alpha, bucket-beta" />
              </Field>
              <Field label={t("prov.fAllowedPrefixes")} hint={t("prov.hintPrefixes")}>
                <TextInput value={form.allowed_prefixes} onChange={(e) => setForm({ ...form, allowed_prefixes: e.target.value })} placeholder="logs/, datasets/" />
              </Field>
            </div>
          ) : null}

          <div className="mt-2 flex gap-2">
            <Button variant="primary" onClick={submit}>{editing ? t("prov.save") : t("prov.addProvider")}</Button>
            <Button variant="ghost" onClick={close}>{t("prov.cancel")}</Button>
          </div>
          <p className="mt-2 text-2xs text-gray-500">{t("prov.footerKeys")}</p>
        </div>
      ) : null}

      <ul className="native-settings-list" data-testid="cloud-provider-list">
        {items.map((provider) => (
          <li key={provider.id} className="flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="native-settings-dot" data-on={provider.has_access_key && provider.has_secret_key ? "true" : "false"} aria-hidden />
                <span className="truncate text-sm text-gray-100">{provider.name}</span>
                <span className="native-settings-tag" data-tone={provider.mode === "readonly" ? "ok" : "warn"}>{provider.mode}</span>
              </div>
              <div className="mt-0.5 truncate text-xs text-gray-500">
                {provider.provider_type} · {provider.region || "—"} · {provider.endpoint_url || "—"}
              </div>
              <div className="mt-0.5 text-xs text-gray-500">
                {t("prov.accessKeyLabel")}: {provider.has_access_key ? t("prov.savedKeychain") : t("prov.notSet")} · {t("prov.secretKeyLabel")}: {provider.has_secret_key ? t("prov.savedKeychain") : t("prov.notSet")}
                {provider.allowed_buckets.length > 0 || provider.allowed_prefixes.length > 0
                  ? ` · ${t("prov.bucketsLabel")}: ${provider.allowed_buckets.join(", ") || "—"} · ${t("prov.prefixesLabel")}: ${provider.allowed_prefixes.join(", ") || "—"}`
                  : ""}
              </div>
            </div>
            <div className="native-settings-actions">
              <Button size="sm" variant={testingIds.has(provider.id) ? "selected" : "default"} onClick={() => toggleTesting(provider.id)} aria-pressed={testingIds.has(provider.id)}>
                {t("prov.testConnection")}
              </Button>
              <Button size="sm" onClick={() => openEdit(provider)}>{t("prov.edit")}</Button>
              {confirmId === provider.id ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)}>{t("prov.cancel")}</Button>
                  <Button size="sm" variant="danger" onClick={() => remove(provider)}>{t("prov.confirmDelete")}</Button>
                </>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => { setError(null); setConfirmId(provider.id); }} aria-label={`${t("prov.delete")} ${provider.name}`}>
                  <Icon name="x" size={13} />
                </Button>
              )}
            </div>
            {testingIds.has(provider.id) ? <div className="basis-full"><CloudProviderTester provider={provider} /></div> : null}
          </li>
        ))}
        {items.length === 0 && !showForm ? <li className="native-settings-empty">{t("prov.noCloud")}</li> : null}
      </ul>
    </div>
  );
}
