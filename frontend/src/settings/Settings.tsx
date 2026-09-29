import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import type { CloudProvider, ModelProvider, Settings as SettingsData, Watch } from "../api/types";
import { Notes } from "../estate/Notes";
import { Icon } from "../components/icons";
import { Badge, Button, Field, IconButton, Segmented, Select, StatusDot, TextInput } from "../components/ui";
import { useToast } from "../components/Toast";
import { copyTextToClipboard } from "../hooks/useCopy";
import { openNativeFolder } from "../hooks/useNativeAgent";
import { LANGS, useI18n, type Lang } from "../i18n";
import { timeAgo } from "../lib/time";
import { useApp } from "../shell/context";
import { useTheme } from "../theme";
import { CLOUD_PRESETS, MODEL_PRESETS, cloudEndpoint, isLocalProvider, parseList } from "./presets";

const SECTIONS = ["general", "models", "storage"] as const;
type SectionId = (typeof SECTIONS)[number];
const LABEL: Record<SectionId, string> = {
  general: "settings.general", models: "settings.models", storage: "settings.storage",
};

/** Settings: one centred dialog of compact preference panes. Secrets go in, never come out. */
export function Settings() {
  const { t } = useI18n();
  const app = useApp();
  const ref = useRef<HTMLDialogElement>(null);
  const section = (SECTIONS as readonly string[]).includes(app.settings ?? "") ? (app.settings as SectionId) : "general";

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  return (
    <dialog ref={ref} className="settings" aria-labelledby="settings-title" onClose={() => app.closeSettings()}
      onCancel={(e) => { e.preventDefault(); app.closeSettings(); }} data-testid="settings">
      <nav className="settings-nav" aria-label={t("settings.title")}>
        <h2 id="settings-title" className="settings-title">{t("settings.title")}</h2>
        {SECTIONS.map((s) => (
          <button key={s} type="button" aria-current={s === section ? "page" : undefined}
            onClick={() => app.openSettings(s)} data-testid={`settings-${s}`}>
            {t(LABEL[s])}
          </button>
        ))}
      </nav>
      <div className="settings-pane">
        <header className="settings-pane-head">
          <h3>{t(LABEL[section])}</h3>
          <IconButton icon="close" label={t("common.close")} onClick={() => app.closeSettings()} />
        </header>
        <div className="settings-pane-body">
          {section === "general" ? <General /> : null}
          {section === "models" ? <Models /> : null}
          {section === "storage" ? <Storage /> : null}
        </div>
      </div>
    </dialog>
  );
}

function General() {
  const { t, lang, setLang } = useI18n();
  const { theme, setTheme } = useTheme();
  const [data, setData] = useState<SettingsData | null>(null);
  useEffect(() => { api.settings().then(setData).catch(() => setData(null)); }, []);
  const chooseLang = (l: Lang) => {
    setLang(l);
    void api.updateSettings({ language: l }).catch(() => {});
  };
  const chooseTheme = (th: "light" | "dark") => {
    setTheme(th);
    void api.updateSettings({ theme: th }).catch(() => {});
  };
  return (
    <div className="pref-rows">
      <div className="pref-row">
        <span id="pref-theme">{t("settings.theme")}</span>
        <Segmented labelId="pref-theme" value={theme} onChange={chooseTheme}
          options={[{ value: "light", label: t("settings.theme.light") }, { value: "dark", label: t("settings.theme.dark") }]} />
      </div>
      <div className="pref-row">
        <span id="pref-lang">{t("settings.language")}</span>
        <Segmented labelId="pref-lang" value={lang} onChange={chooseLang}
          options={LANGS.map((l) => ({ value: l.value, label: l.label }))} />
      </div>
      {data?.vault.unreadable ? (
        <p className="pref-warn"><StatusDot tone="danger" />{t("settings.vaultUnreadable")}</p>
      ) : null}
      <div className="pref-group">
        <h4 className="pref-group-title">{t("settings.safety")}</h4>
        <ul className="safety-points">
          {[1, 2, 3].map((n) => (
            <li key={n}><Icon name="shield" size={16} /><span>{t(`settings.safety.${n}`)}</span></li>
          ))}
        </ul>
      </div>
      <details className="pref-advanced" data-testid="settings-advanced">
        <summary>{t("settings.advanced")}</summary>
        <Skills />
      </details>
    </div>
  );
}

// --- models --------------------------------------------------------------------------

type Probe = { ok: boolean; detail: string };
/** A local model's context window when the user does not know a larger one. */
const LOCAL_CONTEXT = "16384";

/** The item being edited, kept fresh from the reloaded list (a save stays on its item). */
function useEditing<T extends { id: string }>(list: T[] | null) {
  const [editing, setEditing] = useState<T | "new" | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  useEffect(() => {
    if (list === null) return;
    if (list.length === 0) { setEditing("new"); return; }
    setEditing((e) => (e && e !== "new" ? list.find((x) => x.id === e.id) ?? null : e));
  }, [list]);
  const open = (e: T | "new" | null) => { setProbe(null); setEditing(e); };
  const saved = (item: T, p: Probe | null) => { setEditing(item); setProbe(p); };
  return { editing, probe, open, saved };
}

function Models() {
  const { t } = useI18n();
  const app = useApp();
  const { editing, probe, open, saved } = useEditing(app.models);
  const list = app.models ?? [];
  return (
    <div className="provider-pane">
      <div className="provider-list">
        {list.map((m) => (
          <button key={m.id} type="button" className="provider-item" aria-current={editing !== "new" && editing?.id === m.id}
            onClick={() => open(m)}>
            <span className="provider-name">{m.name}</span>
            {m.active ? <Badge tone="accent">{t("settings.active")}</Badge> : null}
            <small>{m.model}</small>
          </button>
        ))}
        <Button size="sm" icon="plus" onClick={() => open("new")} data-testid="add-model">{t("settings.add")}</Button>
        {list.length === 0 && !editing ? <p className="quiet-note">{t("settings.empty.models")}</p> : null}
      </div>
      {editing ? <ModelEditor key={editing === "new" ? "new" : editing.id} model={editing === "new" ? null : editing}
        initialProbe={probe}
        onSaved={(m, p) => { saved(m, p); void app.reloadProviders(); }}
        onChanged={() => void app.reloadProviders()}
        onDeleted={() => { open(null); void app.reloadProviders(); }} /> : null}
    </div>
  );
}

function ModelEditor({ model, initialProbe, onSaved, onChanged, onDeleted }: {
  model: ModelProvider | null; initialProbe: Probe | null;
  onSaved: (m: ModelProvider, p: Probe | null) => void; onChanged: () => void; onDeleted: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [preset, setPreset] = useState(model ? (MODEL_PRESETS.find((p) => p.providerType === model.kind)?.id ?? "compatible") : "openai");
  const p = MODEL_PRESETS.find((x) => x.id === preset)!;
  const [name, setName] = useState(model?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(model?.base_url ?? "");
  const [modelName, setModelName] = useState(model?.model ?? "");
  const [key, setKey] = useState("");
  const [ctx, setCtx] = useState(model?.context_window ? String(model.context_window) : "");
  const [probe, setProbe] = useState<Probe | null>(initialProbe);
  const [busy, setBusy] = useState(false);
  const local = isLocalProvider(p.providerType);
  const fail = (err: unknown) => toast.error(err instanceof Error ? err.message : String(err));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim() || p.label, kind: p.providerType, base_url: baseUrl.trim() || p.baseUrl || null,
        model: modelName.trim(), context_window: ctx ? Number(ctx) : null,
      };
      if (key.trim()) body.api_key = key.trim();
      const saved = model ? await api.updateModel(model.id, body) : await api.createModel(body);
      setKey("");
      setProbe(null);
      let out: Probe | null = null;
      try {
        const r = await api.testModel(saved.id);
        out = { ok: r.ok, detail: r.detail };
      } catch (err) {
        out = { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
      setProbe(out);
      onSaved(saved, out);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    if (!model) return;
    setBusy(true);
    try {
      const out = await api.testModel(model.id);
      setProbe({ ok: out.ok, detail: out.detail });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!model) return;
    await api.deleteModel(model.id).then(onDeleted, fail);
  };
  const contextField = (
    <Field label={t("field.contextWindow")} hint={local ? t("field.contextHint") : t("field.optional")}>
      <TextInput inputMode="numeric" value={ctx} onChange={(e) => setCtx(e.target.value.replace(/\D/g, ""))} data-testid="context-window" />
    </Field>
  );

  return (
    <form className="provider-editor" onSubmit={save} data-testid="model-editor">
      <Field label={t("field.kind")}>
        <Select value={preset} onChange={(e) => {
          const next = MODEL_PRESETS.find((x) => x.id === e.target.value)!;
          setPreset(next.id);
          setBaseUrl(next.baseUrl);
          // A local model's window is small unless the user says otherwise.
          if (isLocalProvider(next.providerType) && !ctx) setCtx(LOCAL_CONTEXT);
          if (!isLocalProvider(next.providerType) && ctx === LOCAL_CONTEXT) setCtx("");
        }}>
          {MODEL_PRESETS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </Select>
      </Field>
      <Field label={t("field.name")}><TextInput value={name} placeholder={p.label} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label={t("field.baseUrl")}>
        <TextInput value={baseUrl} placeholder={p.baseUrl || "http://127.0.0.1:8000/v1"} onChange={(e) => setBaseUrl(e.target.value)} />
      </Field>
      <Field label={t("field.model")}>
        <TextInput required value={modelName} placeholder={p.modelPlaceholder} onChange={(e) => setModelName(e.target.value)} />
      </Field>
      <Field label={t("field.apiKey")} hint={model?.has_api_key ? t("field.keepKey") : local ? t("field.optional") : undefined}>
        <TextInput type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)}
          placeholder={model?.has_api_key ? "••••••••" : ""} />
      </Field>
      {local ? contextField : (
        <details className="fold" open={Boolean(model?.context_window) || undefined}>
          <summary>{t("settings.advanced")}</summary>
          {contextField}
        </details>
      )}
      {model ? <p className="quiet-note">{t("field.apiStyle")}: {t(`settings.apiStyle.${model.api_style}`)}</p> : null}
      {probe ? (
        <p className="probe" data-ok={probe.ok ? "true" : "false"} data-testid="probe"><StatusDot tone={probe.ok ? "success" : "danger"} />{probe.detail}</p>
      ) : null}
      <div className="editor-actions">
        <Button type="submit" variant="primary" disabled={busy || !modelName.trim()}>{busy ? t("settings.testing") : t("settings.save")}</Button>
        {model ? <Button onClick={() => void test()} disabled={busy}>{t("settings.test")}</Button> : null}
        {model && !model.active ? <Button variant="ghost" onClick={() => void api.activateModel(model.id).then(onChanged, fail)}>{t("settings.makeActive")}</Button> : null}
        <span className="editor-spacer" />
        {model ? <Button variant="danger" onClick={() => void remove()}>{t("settings.delete")}</Button> : null}
      </div>
    </form>
  );
}

// --- storage accounts -----------------------------------------------------------------

function Storage() {
  const { t } = useI18n();
  const app = useApp();
  const { editing, probe, open, saved } = useEditing(app.clouds);
  const list = app.clouds ?? [];
  return (
    <div className="provider-pane">
      <div className="provider-list">
        {list.map((c) => (
          <button key={c.id} type="button" className="provider-item" aria-current={editing !== "new" && editing?.id === c.id}
            onClick={() => open(c)}>
            <span className="provider-name">{c.name}</span>
            {c.watch?.enabled ? <Icon name="shield" size={14} /> : null}
            <small>{CLOUD_PRESETS.find((p) => p.providerType === c.provider_type)?.label ?? c.provider_type}</small>
          </button>
        ))}
        <Button size="sm" icon="plus" onClick={() => open("new")} data-testid="add-storage">{t("settings.add")}</Button>
        {list.length === 0 && !editing ? <p className="quiet-note">{t("settings.empty.storage")}</p> : null}
        {list.length ? (
          <details className="fold">
            <summary>{t("notes.general")}</summary>
            <Notes scope={{}} />
          </details>
        ) : null}
      </div>
      {editing ? <CloudEditor key={editing === "new" ? "new" : editing.id} cloud={editing === "new" ? null : editing}
        initialProbe={probe}
        onSaved={(c, p) => { saved(c, p); void app.reloadProviders(); }}
        onDeleted={() => { open(null); void app.reloadProviders(); }} /> : null}
    </div>
  );
}

function CloudEditor({ cloud, initialProbe, onSaved, onDeleted }: {
  cloud: CloudProvider | null; initialProbe: Probe | null;
  onSaved: (c: CloudProvider, p: Probe | null) => void; onDeleted: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const initial = cloud ? CLOUD_PRESETS.find((p) => p.providerType === cloud.provider_type) ?? CLOUD_PRESETS[CLOUD_PRESETS.length - 1] : CLOUD_PRESETS[0];
  const [preset, setPreset] = useState(initial.id);
  const p = CLOUD_PRESETS.find((x) => x.id === preset)!;
  const [form, setForm] = useState({
    name: cloud?.name ?? "", endpoint_url: cloud?.endpoint_url ?? "", region: cloud?.region ?? p.regionDefault, account: "",
    access_key: "", secret_key: "", session_token: "",
    buckets: (cloud?.allowed_buckets ?? []).join(", "), prefixes: (cloud?.allowed_prefixes ?? []).join(", "),
  });
  const [probe, setProbe] = useState<Probe | null>(initialProbe);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const scoped = Boolean(cloud?.allowed_buckets?.length || cloud?.allowed_prefixes?.length);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim() || p.label, provider_type: p.providerType,
        endpoint_url: cloudEndpoint(p, form) || (cloud ? form.endpoint_url.trim() || null : null),
        region: form.region.trim() || p.regionDefault || null, addressing_style: p.addressing, signature_version: p.signature,
        allowed_buckets: parseList(form.buckets), allowed_prefixes: parseList(form.prefixes),
      };
      for (const k of ["access_key", "secret_key", "session_token"] as const) if (form[k].trim()) body[k] = form[k].trim();
      const saved = cloud ? await api.updateCloud(cloud.id, body) : await api.createCloud(body);
      setForm({ ...form, access_key: "", secret_key: "", session_token: "" });
      let out: Probe;
      try {
        const r = await api.testCloud(saved.id);
        out = { ok: Boolean(r.success), detail: r.success ? t("settings.probeOk") : (r.error_message_sanitized ?? r.error_code ?? t("settings.probeFailed")) };
      } catch (err) {
        out = { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
      setProbe(out);
      onSaved(saved, out);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="provider-editor">
      {cloud ? <WatchControl providerId={cloud.id} /> : null}
      <form className="provider-editor" onSubmit={save} data-testid="cloud-editor">
        <Field label={t("field.providerType")}>
          <Select value={preset} onChange={(e) => {
            const next = CLOUD_PRESETS.find((x) => x.id === e.target.value)!;
            setPreset(next.id);
            setForm({ ...form, region: next.regionDefault });
          }}>
            {CLOUD_PRESETS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </Select>
        </Field>
        <Field label={t("field.name")}><TextInput value={form.name} placeholder={p.label} onChange={set("name")} /></Field>
        {p.variable === "endpoint" ? (
          <Field label={t("field.endpoint")} hint={p.hint ? t(`preset.hint.${p.id}`) : undefined}><TextInput required value={form.endpoint_url} onChange={set("endpoint_url")} /></Field>
        ) : null}
        {p.variable === "account" ? (
          <Field label={t("field.accountId")} hint={p.hint ? t(`preset.hint.${p.id}`) : undefined}><TextInput required value={form.account} onChange={set("account")} /></Field>
        ) : null}
        <Field label={t("field.region")}><TextInput value={form.region} placeholder={p.regionPlaceholder ?? p.regionDefault} onChange={set("region")} /></Field>
        <Field label={t("field.accessKey")} hint={cloud?.has_access_key ? t("field.keepKey") : undefined}>
          <TextInput autoComplete="off" value={form.access_key} onChange={set("access_key")} placeholder={cloud?.has_access_key ? "••••••••" : ""} />
        </Field>
        <Field label={t("field.secretKey")} hint={cloud?.has_secret_key ? t("field.keepKey") : undefined}>
          <TextInput type="password" autoComplete="off" value={form.secret_key} onChange={set("secret_key")} placeholder={cloud?.has_secret_key ? "••••••••" : ""} />
        </Field>
        <details className="fold" open={scoped || undefined} data-testid="cloud-advanced">
          <summary>{t("settings.advanced")}</summary>
          <div className="provider-editor">
            <Field label={t("field.sessionToken")} hint={t("field.optional")}>
              <TextInput type="password" autoComplete="off" value={form.session_token} onChange={set("session_token")} />
            </Field>
            <Field label={t("field.buckets")} hint={t("field.listHint")}><TextInput value={form.buckets} onChange={set("buckets")} /></Field>
            <Field label={t("field.prefixes")} hint={t("field.listHint")}><TextInput value={form.prefixes} onChange={set("prefixes")} /></Field>
          </div>
        </details>
        {probe ? (
          <p className="probe" data-ok={probe.ok ? "true" : "false"} data-testid="probe"><StatusDot tone={probe.ok ? "success" : "danger"} />{probe.detail}</p>
        ) : null}
        <div className="editor-actions">
          <Button type="submit" variant="primary" disabled={busy}>{busy ? t("settings.testing") : t("settings.save")}</Button>
          <span className="editor-spacer" />
          {cloud ? <Button variant="danger" onClick={() => void api.deleteCloud(cloud.id).then(onDeleted, (e) => toast.error(e instanceof Error ? e.message : String(e)))}>{t("settings.delete")}</Button> : null}
        </div>
      </form>
      {cloud ? (
        <div className="pref-group">
          <h4 className="pref-group-title">{t("notes.account")}</h4>
          <Notes scope={{ providerId: cloud.id }} accountOnly />
        </div>
      ) : null}
    </div>
  );
}

const WATCH_OPTIONS = [
  { value: "off", hours: 0, label: "watch.off" },
  { value: "6", hours: 6, label: "watch.6h" },
  { value: "24", hours: 24, label: "watch.daily" },
  { value: "168", hours: 168, label: "watch.weekly" },
] as const;

function WatchControl({ providerId }: { providerId: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const [watch, setWatch] = useState<Watch | null>(null);
  useEffect(() => { api.watch(providerId).then(setWatch).catch(() => setWatch(null)); }, [providerId]);
  useEffect(() => {
    if (!watch?.running) return;
    const timer = setInterval(() => void api.watch(providerId).then(setWatch).catch(() => {}), 2000);
    return () => clearInterval(timer);
  }, [watch?.running, providerId]);
  if (!watch) return null;
  const value = watch.enabled ? String(watch.interval_hours) : "off";
  return (
    <div className="pref-group watch" data-testid="watch">
      <h4 className="pref-group-title" id={`watch-${providerId}`}>{t("watch.title")}</h4>
      <Segmented labelId={`watch-${providerId}`} value={WATCH_OPTIONS.some((o) => o.value === value) ? value : "24"}
        onChange={(v) => {
          const o = WATCH_OPTIONS.find((x) => x.value === v)!;
          void api.setWatch(providerId, o.hours > 0, o.hours || watch.interval_hours).then(setWatch, (e) => toast.error(e instanceof Error ? e.message : String(e)));
        }}
        options={WATCH_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }))} />
      <p className="quiet-note">{t("watch.note")}</p>
      <div className="editor-actions">
        <Button size="sm" disabled={watch.running}
          onClick={() => void api.runWatch(providerId).then(() => setWatch({ ...watch, running: true }), (e) => toast.error(e instanceof Error ? e.message : String(e)))}>
          {watch.running ? t("watch.running") : t("watch.checkNow")}
        </Button>
        {watch.last_run_at ? (
          <span className="quiet-note">{t("watch.last", { when: timeAgo(watch.last_run_at, t), summary: watch.last_summary ?? "" })}</span>
        ) : null}
      </div>
    </div>
  );
}

// --- advanced: skills, standing instructions, the MCP bridge -----------------------------------------------------------------

function Skills() {
  const { t } = useI18n();
  const [skills, setSkills] = useState<Array<{ name: string; description: string; user: boolean }>>([]);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  useEffect(() => {
    api.skills().then((s) => setSkills(s.skills)).catch(() => {});
    api.settings().then(setSettings).catch(() => {});
  }, []);
  return (
    <div className="pref-rows">
      <div className="pref-group">
        <h4 className="pref-group-title">{t("skills.count", { n: skills.length })}</h4>
        <ul className="skill-list">
          {skills.map((s) => (
            <li key={s.name}><code>{s.name}</code>{s.user ? <Badge tone="outline">{t("skills.user")}</Badge> : null}
              <span className="quiet-note">{s.description}</span></li>
          ))}
        </ul>
        <div className="editor-actions">
          <Button size="sm" icon="external" onClick={() => void openNativeFolder("skills")}>{t("skills.openFolder")}</Button>
          <Button size="sm" icon="external" onClick={() => void openNativeFolder("data")}>{t("skills.openData")}</Button>
        </div>
        <p className="quiet-note">
          {settings?.instructions.loaded ? t("skills.instructionsLoaded", { n: settings.instructions.chars }) : t("skills.instructionsNone")}
        </p>
      </div>
      <div className="pref-group">
        <h4 className="pref-group-title">{t("skills.mcp")}</h4>
        <p className="quiet-note">{t("skills.mcpBody")}</p>
        <Button size="sm" icon="copy" onClick={() => void copyTextToClipboard("STORAGE_AGENT_ENABLE_MCP=1")}>{t("skills.copyEnv")}</Button>
      </div>
    </div>
  );
}
