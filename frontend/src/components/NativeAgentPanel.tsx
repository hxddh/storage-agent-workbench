import { useEffect, useState } from "react";
import { getGlobalOtelExport, getInstructionsStatus, getMcpStatus, getSkillsDirs, listSkills, type InstructionsStatus } from "../api";
import { saveTextFile } from "../config";
import { isNativeShell, openNativeFolder } from "../hooks/useNativeAgent";
import { useI18n } from "../i18n";
import { useToast } from "./Toast";
import { Button, StatusDot } from "./ui";
import { Icon } from "./icons";

const MCP_ENV = "STORAGE_AGENT_ENABLE_MCP=1";

function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      resolve();
    } catch (error) {
      reject(error);
    }
  });
}

function downloadInBrowser(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Skills, observability export, and the read-only MCP bridge — as actions on real runtime facts. */
export function NativeAgentPanel() {
  const { t } = useI18n();
  const toast = useToast();
  // v1.15 — panel copy lives in the i18n dict; hardcoded blocks were the
  // mixed-language source.
  const copy = {
    noSkills: t("skills.noSkills"),
    bundled: t("skills.bundled"),
    user: t("skills.user"),
    openFolder: t("skills.openFolder"),
    folderOpened: t("skills.folderOpened"),
    folderUnavailable: t("skills.folderUnavailable"),
    exportTrace: t("skills.exportTrace"),
    exporting: t("skills.exporting"),
    exported: t("skills.exported"),
    exportFailed: t("skills.exportFailed"),
    exportHint: t("skills.exportHint"),
    enabled: t("skills.enabled"),
    disabled: t("skills.disabled"),
    tools: t("skills.tools"),
    unavailable: t("skills.unavailable"),
    mcpHow: t("skills.mcpHow"),
    copied: t("skills.copied"),
  };
  const [skills, setSkills] = useState<{ name: string; description: string; source?: string }[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [mcp, setMcp] = useState<{ enabled: boolean; allowed_tools: string[]; note: string } | null>(null);
  const [dirs, setDirs] = useState<{ path: string; exists: boolean; skill_count: number }[] | null>(null);
  const [exporting, setExporting] = useState(false);
  const [instructions, setInstructions] = useState<InstructionsStatus | null>(null);

  useEffect(() => {
    let alive = true;
    listSkills().then((r) => { if (alive) setSkills(r.skills); }).catch(() => {}).finally(() => { if (alive) setSkillsLoading(false); });
    getMcpStatus().then((r) => { if (alive) setMcp(r); }).catch(() => {});
    getSkillsDirs().then((r) => { if (alive) setDirs(r.dirs); }).catch(() => {});
    getInstructionsStatus().then((r) => { if (alive) setInstructions(r); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const userDir = dirs?.[0]?.path ?? null;

  const openFolder = async () => {
    const opened = await openNativeFolder("skills");
    if (opened) toast.success(`${copy.folderOpened} ${opened}`);
    else toast.info(`${copy.folderUnavailable} ${userDir ?? "…/skills"}`);
  };

  // The instructions file lives in the data directory itself: reveal that
  // folder on the desktop, or say where it is when the shell cannot.
  const openInstructions = async () => {
    const opened = await openNativeFolder("data");
    if (opened) toast.success(`${copy.folderOpened} ${opened}`);
    else toast.info(`${t("settings.instructionsAt")} ${instructions?.path ?? "…/AGENTS.md"}`);
  };

  const exportTrace = async () => {
    setExporting(true);
    try {
      const data = await getGlobalOtelExport();
      const content = JSON.stringify(data, null, 2);
      const filename = `storage-agent-trace-${new Date().toISOString().slice(0, 10)}.json`;
      const path = await saveTextFile(filename, content);
      if (path) toast.success(`${copy.exported} ${path}`);
      else downloadInBrowser(filename, content);
    } catch (error) {
      toast.error(`${copy.exportFailed} ${String(error)}`);
    } finally {
      setExporting(false);
    }
  };

  const copyEnv = () => {
    copyText(MCP_ENV).then(() => toast.success(copy.copied)).catch(() => undefined);
  };

  return (
    <div className="max-w-3xl space-y-8" data-testid="settings-agent">
      <section>
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <h2 className="settings-pane-subtitle">{t("prov.skillsTitle")}</h2>
            <p className="native-settings-hint">{t("prov.skillsHint")}</p>
          </div>
          <Button onClick={() => void openFolder()} data-testid="skills-open-folder">
            <Icon name="file" size={14} /> {copy.openFolder}
          </Button>
        </div>
        {skillsLoading ? (
          <div className="skeleton h-16 w-full" aria-hidden />
        ) : skills.length === 0 ? (
          <p className="settings-pane-empty-text">{copy.noSkills}</p>
        ) : (
          <ul className="native-settings-list" data-testid="skills-list">
            {skills.map((skill) => (
              <li key={skill.name}>
                <div className="min-w-0">
                  <div className="settings-pane-name truncate">{skill.name}</div>
                  <div className="settings-pane-desc">{skill.description}</div>
                </div>
                <span className="native-settings-tag">{skill.source === "user" ? copy.user : copy.bundled}</span>
              </li>
            ))}
          </ul>
        )}
        {userDir && !isNativeShell() ? <p className="settings-pane-path mt-2">{userDir}</p> : null}
      </section>

      <section data-testid="settings-instructions">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="settings-pane-subtitle">{t("settings.instructions")}</h2>
            <p className="native-settings-hint">{t("settings.instructionsHint")}</p>
            {instructions ? (
              <p className="settings-pane-status" data-testid="instructions-status" data-loaded={instructions.loaded ? "true" : "false"}>
                {instructions.loaded ? t("settings.instructionsLoaded", { chars: instructions.chars }) : t("settings.instructionsMissing")}
                {instructions.path ? <span className="settings-pane-path ml-2">{instructions.path}</span> : null}
                {instructions.error ? <span className="settings-pane-issue ml-2"><StatusDot tone="warn" />{instructions.error}</span> : null}
              </p>
            ) : null}
          </div>
          <Button onClick={() => void openInstructions()} data-testid="instructions-open">
            <Icon name="file" size={14} /> {t("settings.instructionsOpen")}
          </Button>
        </div>
      </section>

      <section>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="settings-pane-subtitle">{t("prov.observability")}</h2>
            <p className="native-settings-hint">{copy.exportHint}</p>
          </div>
          <Button onClick={() => void exportTrace()} disabled={exporting} data-testid="observability-export">
            {exporting ? copy.exporting : copy.exportTrace}
          </Button>
        </div>
      </section>

      <section>
        <h2 className="settings-pane-subtitle">{t("prov.mcpTitle")}</h2>
        <p className="native-settings-hint">{t("prov.mcpHint")}</p>
        {mcp ? (
          <div className="native-settings-card mt-3" data-enabled={mcp.enabled ? "true" : "false"} data-testid="mcp-status">
            <div className="settings-pane-card-head">
              <span className="native-settings-dot" aria-hidden />
              {mcp.enabled ? copy.enabled : copy.disabled}
              <span className="settings-pane-muted">· {mcp.allowed_tools.length} {copy.tools}</span>
            </div>
            <p className="settings-pane-desc">{mcp.note}</p>
            {!mcp.enabled ? (
              <div className="mt-3">
                <div className="settings-pane-meta">{copy.mcpHow}</div>
                <div className="mt-1.5 flex items-center gap-2">
                  <code className="native-settings-code">{MCP_ENV}</code>
                  <button type="button" className="native-ghost-action" onClick={copyEnv} aria-label={t("common.copy")} data-testid="mcp-copy-env">
                    <Icon name="copy" size={14} /> {t("common.copy")}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="settings-pane-empty-text mt-3">{copy.unavailable}</p>
        )}
      </section>
    </div>
  );
}
