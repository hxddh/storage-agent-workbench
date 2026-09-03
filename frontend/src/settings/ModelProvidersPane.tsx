import { useEffect, useRef, useState } from "react";
import {
  activateModelProvider,
  createModelProvider,
  deleteModelProvider,
  listModelProviders,
  testModelProvider,
  updateModelProvider,
  type ModelProviderInput,
} from "../api";
import type { ModelProvider, ReasoningEffort } from "../types";
import { Button, Field, Select, TextInput } from "../components/ui";
import { Icon } from "../components/icons";
import { useI18n } from "../i18n";
import { pushOverlay } from "../lib/overlayStack";
import { MODEL_PRESETS, isLocalProvider, modelPresetFor, type ModelPreset } from "./presets";

type Form = {
  name: string;
  provider_type: string;
  base_url: string;
  model: string;
  api_key: string;
  context_window: string;
  max_output_tokens: string;
  reasoning_effort: ReasoningEffort | "";
};

const emptyForm = (preset: ModelPreset): Form => ({
  name: preset.label,
  provider_type: preset.providerType,
  base_url: preset.baseUrl,
  model: "",
  api_key: "",
  context_window: "",
  max_output_tokens: "",
  reasoning_effort: "",
});

type TestState = { tone: "ok" | "warn" | "err"; msg: string };

/** Model providers as a native preference pane: one list, a `+` menu of presets, one editor. */
export function ModelProvidersPanel() {
  const { t } = useI18n();
  const [items, setItems] = useState<ModelProvider[]>([]);
  const [editing, setEditing] = useState<ModelProvider | null>(null);
  const [creating, setCreating] = useState<ModelPreset | null>(null);
  const [form, setForm] = useState<Form>(emptyForm(MODEL_PRESETS[0]));
  const [advanced, setAdvanced] = useState(false);
  const [presetMenu, setPresetMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState | "running">>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const reload = () => listModelProviders().then(setItems).catch((e) => setError(String(e)));
  useEffect(() => { reload(); }, []);

  useEffect(() => {
    if (!presetMenu) return;
    const onDown = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setPresetMenu(false); };
    document.addEventListener("mousedown", onDown);
    const release = pushOverlay(() => setPresetMenu(false));
    return () => { document.removeEventListener("mousedown", onDown); release(); };
  }, [presetMenu]);

  const openCreate = (preset: ModelPreset) => {
    setPresetMenu(false);
    setForm(emptyForm(preset));
    setEditing(null);
    setCreating(preset);
    setAdvanced(false);
    setError(null);
  };
  const openEdit = (provider: ModelProvider) => {
    setForm({
      name: provider.name,
      provider_type: provider.provider_type,
      base_url: provider.base_url ?? "",
      model: provider.model ?? "",
      api_key: "", // never prefill secrets
      context_window: provider.context_window ? String(provider.context_window) : "",
      max_output_tokens: provider.max_output_tokens ? String(provider.max_output_tokens) : "",
      reasoning_effort: provider.reasoning_effort ?? "",
    });
    setEditing(provider);
    setCreating(null);
    setAdvanced(Boolean(provider.context_window || provider.max_output_tokens));
    setError(null);
  };
  const close = () => {
    setCreating(null);
    setEditing(null);
    setForm(emptyForm(MODEL_PRESETS[0])); // clear the secret from memory
  };

  const submit = async () => {
    setError(null);
    if (!form.name.trim() || !form.provider_type.trim()) {
      setError(t("prov.nameTypeRequired"));
      return;
    }
    const body: ModelProviderInput = {
      name: form.name.trim(),
      provider_type: form.provider_type,
      // On EDIT "" means "clear to NULL" server-side, so blanking a field removes it.
      base_url: editing ? form.base_url : form.base_url || undefined,
      model: editing ? form.model : form.model || undefined,
    };
    if (form.api_key.trim()) body.api_key = form.api_key;
    const window_ = Number(form.context_window);
    if (window_ > 0) body.context_window = window_;
    else if (editing?.context_window) body.context_window = 0;
    const output = Number(form.max_output_tokens);
    if (output > 0) body.max_output_tokens = output;
    else if (editing?.max_output_tokens) body.max_output_tokens = 0;
    if (form.reasoning_effort) body.reasoning_effort = form.reasoning_effort;
    else if (editing?.reasoning_effort) body.reasoning_effort = "";
    try {
      if (editing) await updateModelProvider(editing.id, body);
      else await createModelProvider(body);
      close();
      reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const remove = async (provider: ModelProvider) => {
    setError(null);
    try {
      await deleteModelProvider(provider.id);
      setConfirmId(null);
      reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const activate = async (provider: ModelProvider) => {
    setError(null);
    try {
      await activateModelProvider(provider.id);
      reload();
    } catch (e) {
      setError(String(e));
    }
  };

  const runTest = async (provider: ModelProvider) => {
    setTests((prev) => ({ ...prev, [provider.id]: "running" }));
    try {
      const result = await testModelProvider(provider.id);
      const state: TestState = !result.ok
        ? { tone: "err", msg: result.detail || t("prov.testIncomplete") }
        : result.api_key_verified === null || result.api_key_verified === undefined
          ? { tone: "warn", msg: `${t("prov.testUnverified")} — ${result.detail}` }
          : { tone: "ok", msg: `${t("prov.testOk")} — ${result.detail}` };
      setTests((prev) => ({ ...prev, [provider.id]: state }));
    } catch (e) {
      setTests((prev) => ({ ...prev, [provider.id]: { tone: "err", msg: String(e) } }));
    }
  };

  const showForm = Boolean(creating || editing);
  const local = isLocalProvider(form.provider_type);
  const preset = creating ?? modelPresetFor(form.provider_type);

  return (
    <div className="max-w-3xl" data-testid="settings-model-providers">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium text-gray-100">{t("prov.tabModel")}</h2>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">{t("prov.modelHint")}</p>
        </div>
        {!showForm ? (
          <div ref={menuRef} className="relative shrink-0">
            <Button variant="primary" onClick={() => setPresetMenu((open) => !open)} aria-haspopup="menu" aria-expanded={presetMenu} data-testid="model-add">
              {t("prov.addModel")}
            </Button>
            {presetMenu ? (
              <div className="native-menu native-settings-presets" role="menu" data-testid="model-presets">
                {MODEL_PRESETS.map((item) => (
                  <button key={item.id} type="button" role="menuitem" onClick={() => openCreate(item)}>
                    <span className="flex-1">{item.label}</span>
                    {item.local ? <small>{t("prov.presetLocal")}</small> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {error ? <p className="native-banner mb-3" data-tone="danger">{error}</p> : null}

      {showForm ? (
        <div className="native-settings-editor" data-testid="model-editor">
          <div className="native-settings-editor-head">
            <strong>{editing ? t("prov.edit") : (creating?.label ?? t("prov.addModel"))}</strong>
            {editing ? <span className="text-gray-500">{editing.provider_type}</span> : null}
          </div>
          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            <Field label={t("prov.fName")}>
              <TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label={t("prov.fModel")} hint={preset?.modelPlaceholder ? `${t("prov.hintModel")} ${preset.modelPlaceholder}` : undefined}>
              <TextInput value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder={preset?.modelPlaceholder ?? "model"} />
            </Field>
          </div>
          <Field label={t("prov.fBaseUrl")} hint={local ? t("prov.localHint") : undefined}>
            <TextInput value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder={preset?.baseUrl || "https://api.example.com/v1"} />
          </Field>
          <Field label={t("prov.fApiKey")} hint={local ? t("prov.localActive") : editing?.has_api_key ? t("prov.hintKeep") : t("prov.hintNew")}>
            <TextInput
              type="password"
              autoComplete="off"
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
              placeholder={local ? t("prov.notRequired") : editing?.has_api_key ? t("prov.savedPlaceholder") : ""}
            />
          </Field>
          {editing?.reasoning_capable ? (
            <Field label={t("prov.fEffort")} hint={t("prov.hintEffort")}>
              <Select value={form.reasoning_effort} onChange={(e) => setForm({ ...form, reasoning_effort: e.target.value as Form["reasoning_effort"] })}>
                <option value="">{t("prov.effortDefault")}</option>
                <option value="low">{t("prov.effortLow")}</option>
                <option value="medium">{t("prov.effortMedium")}</option>
                <option value="high">{t("prov.effortHigh")}</option>
              </Select>
            </Field>
          ) : null}

          <button type="button" onClick={() => setAdvanced((value) => !value)} className="native-settings-advanced" aria-expanded={advanced}>
            <Icon name="chevron" size={11} className={advanced ? "rotate-90" : ""} />
            {t("prov.advanced")}
          </button>
          {advanced ? (
            <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
              <Field label={t("prov.fContextWindow")} hint={t("prov.hintContextWindow")}>
                <TextInput type="number" min={1} value={form.context_window} onChange={(e) => setForm({ ...form, context_window: e.target.value })} placeholder="128000" />
              </Field>
              <Field label={t("prov.fMaxOutput")} hint={t("prov.hintMaxOutput")}>
                <TextInput type="number" min={1} value={form.max_output_tokens} onChange={(e) => setForm({ ...form, max_output_tokens: e.target.value })} placeholder="16384" />
              </Field>
            </div>
          ) : null}

          <div className="mt-2 flex gap-2">
            <Button variant="primary" onClick={submit}>{editing ? t("prov.save") : t("prov.create")}</Button>
            <Button variant="ghost" onClick={close}>{t("prov.cancel")}</Button>
          </div>
        </div>
      ) : null}

      <ul className="native-settings-list" data-testid="model-provider-list">
        {items.map((provider) => {
          const test = tests[provider.id];
          return (
            <li key={provider.id} data-active={provider.active ? "true" : "false"}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="native-settings-dot" data-on={provider.active ? "true" : "false"} aria-hidden />
                  <span className="truncate text-sm text-gray-100">{provider.name}</span>
                  {provider.active ? <span className="native-settings-tag" data-testid="active-model-badge">{t("prov.active")}</span> : null}
                </div>
                <div className="mt-0.5 truncate text-xs text-gray-500">
                  {provider.model || "—"} · {provider.base_url || modelPresetFor(provider.provider_type)?.baseUrl || "—"}
                </div>
                <div className="mt-0.5 text-xs text-gray-500">
                  {isLocalProvider(provider.provider_type) && !provider.has_api_key
                    ? t("prov.localActive")
                    : `${t("prov.apiKeyLabel")}: ${provider.has_api_key ? t("prov.savedKeychain") : t("prov.notSet")}`}
                  {provider.reasoning_capable && provider.reasoning_effort ? ` · ${t("prov.fEffort")}: ${provider.reasoning_effort}` : ""}
                </div>
                {test && test !== "running" ? (
                  <div className="mt-1 text-xs" data-testid="model-test-status" data-tone={test.tone}>
                    <span className={test.tone === "ok" ? "text-success" : test.tone === "warn" ? "text-warn" : "text-danger"}>{test.msg}</span>
                  </div>
                ) : test === "running" ? (
                  <div className="mt-1 text-xs text-gray-500" data-testid="model-test-status" data-tone="running">{t("prov.testing")}</div>
                ) : null}
              </div>
              <div className="native-settings-actions">
                {!provider.active && items.length > 1 ? <Button size="sm" variant="ghost" onClick={() => activate(provider)}>{t("prov.setActive")}</Button> : null}
                <Button size="sm" variant="ghost" onClick={() => runTest(provider)} disabled={test === "running"}>{t("prov.test")}</Button>
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
            </li>
          );
        })}
        {items.length === 0 && !showForm ? <li className="native-settings-empty">{t("prov.noModel")}</li> : null}
      </ul>
    </div>
  );
}
