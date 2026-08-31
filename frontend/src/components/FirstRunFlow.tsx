import { useState } from "react";
import {
  activateModelProvider,
  createCloudProvider,
  createModelProvider,
  testCloudProvider,
  testModelProvider,
} from "../api";
import { completeFirstRun, skipFirstRun, writeFirstRunStep, type FirstRunStep } from "../lib/firstRun";
import { useI18n } from "../i18n";
import { Button, Field, TextInput } from "./ui";

/**
 * Inline 60-second path: welcome → model (real test) → storage (skippable) →
 * first checkup. No demo data, no fake progress. Every step can exit; empty
 * start then offers a resume entry back to that step.
 */
export function FirstRunFlow({
  sidecarReady,
  onCheckup,
  resumeOnly = false,
  onResume,
  onExit,
  initialStep = "welcome",
}: {
  sidecarReady: boolean;
  onCheckup: () => void;
  resumeOnly?: boolean;
  onResume?: () => void;
  onExit?: () => void;
  initialStep?: FirstRunStep;
}) {
  const { lang, t } = useI18n();
  const [step, setStep] = useState<FirstRunStep>(initialStep);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [storageSkipped, setStorageSkipped] = useState(false);
  const [model, setModel] = useState({
    name: "Local model",
    provider_type: "openai-compatible",
    base_url: "",
    model: "",
    api_key: "",
  });
  const [cloud, setCloud] = useState({
    name: "Object storage",
    provider_type: "s3-compatible",
    endpoint_url: "",
    region: "",
    access_key: "",
    secret_key: "",
  });

  const copy = lang === "zh"
    ? {
        welcomeTitle: "配置 Storage Agent",
        welcomeBody: "连接模型，可选连接存储，然后把第一次只读体检交给 Agent。全程真实配置，没有演示数据。",
        continue: "继续",
        later: "稍后配置",
        modelTitle: "连接模型提供商",
        modelBody: "Agent 需要一个模型才能执行 Task。API Key 只写入本机加密 Vault。",
        modelSave: "测试并继续",
        skipModel: "先跳过",
        storageTitle: "连接存储提供商",
        storageBody: "只读凭证，范围由 Sidecar 强制。可以跳过，体检会把缺失标成缺口。",
        storageSave: "测试并继续",
        skipStorage: "跳过存储",
        skipped: "已跳过存储。第一次体检会把缺失的 Provider 记为缺口，而不是假装连上了。",
        checkupTitle: "第一次存储体检",
        checkupBody: "只读检查配置、生命周期、加密和公共访问。证据不足就标缺口。",
        checkupAction: "开始存储体检",
        skipCheckup: "稍后自己委派",
        resume: "继续完成配置",
        resumeHint: "还差一步就能看到第一个真实 Work Result。",
        needSidecar: "本地运行时尚未就绪。",
      }
    : {
        welcomeTitle: "Configure Storage Agent",
        welcomeBody: "Connect a model, optionally connect storage, then delegate the first read-only checkup. Real config only — no demo data.",
        continue: "Continue",
        later: "Configure later",
        modelTitle: "Connect a model provider",
        modelBody: "The Agent needs a model to run a Task. The API key is written only to the encrypted local vault.",
        modelSave: "Test and continue",
        skipModel: "Skip for now",
        storageTitle: "Connect storage",
        storageBody: "Read-only credentials, scoped by the Sidecar. Skip if you want; checkup will record the gap.",
        storageSave: "Test and continue",
        skipStorage: "Skip storage",
        skipped: "Storage skipped. The first checkup will record a missing provider as a gap — not a fake connection.",
        checkupTitle: "First storage checkup",
        checkupBody: "Read-only review of configuration, lifecycle, encryption, and public-access posture. Missing evidence stays a gap.",
        checkupAction: "Run storage checkup",
        skipCheckup: "I'll delegate later",
        resume: "Finish setup",
        resumeHint: "One more step to the first real Work Result.",
        needSidecar: "The local runtime is not ready yet.",
      };

  const go = (next: FirstRunStep) => {
    setError(null);
    setOk(null);
    setStep(next);
    writeFirstRunStep(next);
  };

  const exit = (resume: FirstRunStep) => {
    skipFirstRun(resume);
    onExit?.();
  };

  const saveModel = async () => {
    if (!sidecarReady) { setError(copy.needSidecar); return; }
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      if (!model.name.trim() || !model.provider_type.trim() || !model.model.trim() || !model.api_key.trim()) {
        setError(t("prov.nameTypeRequired"));
        return;
      }
      const created = await createModelProvider({
        name: model.name.trim(),
        provider_type: model.provider_type.trim(),
        base_url: model.base_url.trim() || undefined,
        model: model.model.trim(),
        api_key: model.api_key,
      });
      setModel((current) => ({ ...current, api_key: "" }));
      try { await activateModelProvider(created.id); } catch { /* first provider is already default */ }
      const result = await testModelProvider(created.id);
      if (!result.ok) {
        setError(result.detail);
        return;
      }
      const label = result.api_key_verified == null ? t("prov.testUnverified") : t("prov.testOk");
      setOk(`${label} — ${result.detail}`);
      go("storage");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveCloud = async () => {
    if (!sidecarReady) { setError(copy.needSidecar); return; }
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      if (!cloud.name.trim() || !cloud.access_key.trim() || !cloud.secret_key.trim()) {
        setError(t("prov.nameTypeRequired"));
        return;
      }
      const created = await createCloudProvider({
        name: cloud.name.trim(),
        provider_type: cloud.provider_type.trim() || "s3-compatible",
        endpoint_url: cloud.endpoint_url.trim() || undefined,
        region: cloud.region.trim() || undefined,
        access_key: cloud.access_key,
        secret_key: cloud.secret_key,
        mode: "readonly",
      });
      setCloud((current) => ({ ...current, access_key: "", secret_key: "" }));
      const result = await testCloudProvider(created.id);
      if (!result.success) {
        setError(result.error_message_sanitized || result.error_code || "Storage test failed.");
        return;
      }
      setOk(result.identity_hint || "Reachable.");
      setStorageSkipped(false);
      go("checkup");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  if (resumeOnly) {
    return (
      <button
        type="button"
        data-testid="first-run-resume"
        onClick={onResume}
        className="mb-5 flex w-full items-center gap-3 rounded-xl border border-edge bg-panel/70 px-4 py-3 text-left transition-colors hover:border-edge-strong hover:bg-hover"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-accent/30 bg-accent/10 text-accent-soft" aria-hidden>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 2 2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /></svg>
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-gray-100">{copy.resume}</span>
          <span className="mt-0.5 block text-2xs text-gray-500">{copy.resumeHint}</span>
        </span>
      </button>
    );
  }

  return (
    <section className="mb-6" data-testid="agent-first-run" data-step={step}>
      <div className="rounded-2xl border border-edge bg-panel/80 p-5 shadow-elev">
        {step === "welcome" ? (
          <>
            <h2 className="text-lg font-semibold tracking-[-0.02em] text-gray-100">{copy.welcomeTitle}</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-gray-400">{copy.welcomeBody}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => go("model")}>{copy.continue}</Button>
              <Button variant="ghost" onClick={() => exit("welcome")}>{copy.later}</Button>
            </div>
          </>
        ) : null}

        {step === "model" ? (
          <>
            <h2 className="text-lg font-semibold tracking-[-0.02em] text-gray-100">{copy.modelTitle}</h2>
            <p className="mt-1.5 mb-4 text-sm leading-relaxed text-gray-400">{copy.modelBody}</p>
            <Field label={t("prov.fName")}>
              <TextInput data-testid="first-run-model-name" value={model.name} onChange={(e) => setModel({ ...model, name: e.target.value })} />
            </Field>
            <Field label={t("prov.fProviderType")}>
              <TextInput data-testid="first-run-model-type" value={model.provider_type} onChange={(e) => setModel({ ...model, provider_type: e.target.value })} />
            </Field>
            <Field label={t("prov.fBaseUrl")}>
              <TextInput data-testid="first-run-model-url" value={model.base_url} onChange={(e) => setModel({ ...model, base_url: e.target.value })} placeholder="https://api.openai.com/v1" />
            </Field>
            <Field label={t("prov.fModel")}>
              <TextInput data-testid="first-run-model-id" value={model.model} onChange={(e) => setModel({ ...model, model: e.target.value })} placeholder="gpt-4.1" />
            </Field>
            <Field label={t("prov.fApiKey")} hint={t("prov.hintNew")}>
              <TextInput data-testid="first-run-model-key" type="password" autoComplete="off" value={model.api_key} onChange={(e) => setModel({ ...model, api_key: e.target.value })} />
            </Field>
            {error ? <p className="mb-3 rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger" data-testid="first-run-model-fail">{error}</p> : null}
            {ok ? <p className="mb-3 rounded-lg border border-edge bg-panel px-3 py-2 text-xs text-success" data-testid="first-run-model-ok">{ok}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={busy} onClick={() => void saveModel()}>{copy.modelSave}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => exit("model")}>{copy.skipModel}</Button>
            </div>
          </>
        ) : null}

        {step === "storage" ? (
          <>
            <h2 className="text-lg font-semibold tracking-[-0.02em] text-gray-100">{copy.storageTitle}</h2>
            <p className="mt-1.5 mb-4 text-sm leading-relaxed text-gray-400">{copy.storageBody}</p>
            <Field label={t("prov.fName")}>
              <TextInput data-testid="first-run-cloud-name" value={cloud.name} onChange={(e) => setCloud({ ...cloud, name: e.target.value })} />
            </Field>
            <Field label={t("prov.fEndpoint")}>
              <TextInput data-testid="first-run-cloud-endpoint" value={cloud.endpoint_url} onChange={(e) => setCloud({ ...cloud, endpoint_url: e.target.value })} />
            </Field>
            <Field label={t("prov.fRegion")}>
              <TextInput data-testid="first-run-cloud-region" value={cloud.region} onChange={(e) => setCloud({ ...cloud, region: e.target.value })} />
            </Field>
            <Field label={t("prov.fAccessKey")} hint={t("prov.hintNew")}>
              <TextInput data-testid="first-run-cloud-key" autoComplete="off" value={cloud.access_key} onChange={(e) => setCloud({ ...cloud, access_key: e.target.value })} />
            </Field>
            <Field label={t("prov.fSecretKey")} hint={t("prov.hintNew")}>
              <TextInput data-testid="first-run-cloud-secret" type="password" autoComplete="off" value={cloud.secret_key} onChange={(e) => setCloud({ ...cloud, secret_key: e.target.value })} />
            </Field>
            {error ? <p className="mb-3 rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger" data-testid="first-run-storage-fail">{error}</p> : null}
            {ok ? <p className="mb-3 rounded-lg border border-edge bg-panel px-3 py-2 text-xs text-success">{ok}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={busy} onClick={() => void saveCloud()}>{copy.storageSave}</Button>
              <Button
                variant="ghost"
                disabled={busy}
                data-testid="first-run-skip-storage"
                onClick={() => { setStorageSkipped(true); go("checkup"); }}
              >
                {copy.skipStorage}
              </Button>
            </div>
          </>
        ) : null}

        {step === "checkup" ? (
          <>
            <h2 className="text-lg font-semibold tracking-[-0.02em] text-gray-100">{copy.checkupTitle}</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-gray-400">{copy.checkupBody}</p>
            {storageSkipped ? (
              <p className="mt-3 rounded-lg border border-dashed border-edge px-3 py-2 text-xs leading-relaxed text-gray-400" data-testid="first-run-storage-skipped">
                {copy.skipped}
              </p>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="primary"
                data-testid="first-run-checkup"
                onClick={() => { completeFirstRun(); onExit?.(); onCheckup(); }}
              >
                {copy.checkupAction}
              </Button>
              <Button variant="ghost" onClick={() => exit("checkup")}>{copy.skipCheckup}</Button>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
