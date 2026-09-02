import { useEffect, useState } from "react";
import { getGlobalOtelExport, getMcpStatus, getSkillsDirs, listSkills } from "../api";
import { saveTextFile } from "../config";
import { isNativeShell, openNativeFolder } from "../hooks/useNativeAgent";
import { useI18n } from "../i18n";
import { useToast } from "./Toast";
import { Button } from "./ui";
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
  const { t, lang } = useI18n();
  const toast = useToast();
  const copy = lang === "zh"
    ? {
        noSkills: "还没有技能。把 SKILL.md 放到应用数据的 skills 目录即可添加。",
        bundled: "内置", user: "用户", openFolder: "打开技能目录", folderOpened: "已打开",
        folderUnavailable: "桌面版才能打开目录；技能目录在：",
        exportTrace: "导出追踪…", exporting: "导出中…", exported: "追踪已保存到", exportFailed: "导出失败：",
        exportHint: "把所有任务的持久化执行日志、工具调用、指标和产物索引导出为 OTel 风格的 JSON（有界、已脱敏）。",
        enabled: "MCP 已启用", disabled: "MCP 已关闭", tools: "个只读工具", unavailable: "MCP 状态不可用。",
        mcpHow: "在 Sidecar 环境中设置后重启即可启用：", copied: "已复制",
      }
    : {
        noSkills: "No skills yet. Drop a SKILL.md into the app data skills folder to add one.",
        bundled: "Bundled", user: "User", openFolder: "Open skills folder", folderOpened: "Opened",
        folderUnavailable: "Opening folders needs the desktop app; the skills folder is at",
        exportTrace: "Export trace…", exporting: "Exporting…", exported: "Trace saved to", exportFailed: "Export failed:",
        exportHint: "Every task's durable execution log, tool calls, metrics and artifact index as OTel-style JSON (bounded, sanitized).",
        enabled: "MCP enabled", disabled: "MCP disabled", tools: "read-only tools", unavailable: "MCP status unavailable.",
        mcpHow: "Set this in the Sidecar's environment and restart to enable it:", copied: "Copied",
      };
  const [skills, setSkills] = useState<{ name: string; description: string; source?: string }[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [mcp, setMcp] = useState<{ enabled: boolean; allowed_tools: string[]; note: string } | null>(null);
  const [dirs, setDirs] = useState<{ path: string; exists: boolean; skill_count: number }[] | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let alive = true;
    listSkills().then((r) => { if (alive) setSkills(r.skills); }).catch(() => {}).finally(() => { if (alive) setSkillsLoading(false); });
    getMcpStatus().then((r) => { if (alive) setMcp(r); }).catch(() => {});
    getSkillsDirs().then((r) => { if (alive) setDirs(r.dirs); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const userDir = dirs?.[0]?.path ?? null;

  const openFolder = async () => {
    const opened = await openNativeFolder("skills");
    if (opened) toast.success(`${copy.folderOpened} ${opened}`);
    else toast.info(`${copy.folderUnavailable} ${userDir ?? "…/skills"}`);
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
            <h2 className="text-lg font-medium text-gray-100">{t("prov.skillsTitle")}</h2>
            <p className="mt-1 text-xs leading-relaxed text-gray-500">{t("prov.skillsHint")}</p>
          </div>
          <Button onClick={() => void openFolder()} data-testid="skills-open-folder">
            <Icon name="file" size={13} /> {copy.openFolder}
          </Button>
        </div>
        {skillsLoading ? (
          <div className="skeleton h-16 w-full" aria-hidden />
        ) : skills.length === 0 ? (
          <p className="text-xs text-gray-500">{copy.noSkills}</p>
        ) : (
          <ul className="native-settings-list" data-testid="skills-list">
            {skills.map((skill) => (
              <li key={skill.name}>
                <div className="min-w-0">
                  <div className="truncate text-sm text-gray-100">{skill.name}</div>
                  <div className="text-xs leading-relaxed text-gray-500">{skill.description}</div>
                </div>
                <span className="native-settings-tag">{skill.source === "user" ? copy.user : copy.bundled}</span>
              </li>
            ))}
          </ul>
        )}
        {userDir && !isNativeShell() ? <p className="mt-2 font-mono text-2xs text-gray-500">{userDir}</p> : null}
      </section>

      <section>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-medium text-gray-100">{t("prov.observability")}</h2>
            <p className="mt-1 text-xs leading-relaxed text-gray-500">{copy.exportHint}</p>
          </div>
          <Button onClick={() => void exportTrace()} disabled={exporting} data-testid="observability-export">
            {exporting ? copy.exporting : copy.exportTrace}
          </Button>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-medium text-gray-100">{t("prov.mcpTitle")}</h2>
        <p className="mt-1 mb-3 text-xs leading-relaxed text-gray-500">{t("prov.mcpHint")}</p>
        {mcp ? (
          <div className="native-settings-card" data-enabled={mcp.enabled ? "true" : "false"} data-testid="mcp-status">
            <div className="flex items-center gap-2 text-sm text-gray-100">
              <span className="native-settings-dot" aria-hidden />
              {mcp.enabled ? copy.enabled : copy.disabled}
              <span className="text-gray-500">· {mcp.allowed_tools.length} {copy.tools}</span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-gray-500">{mcp.note}</p>
            {!mcp.enabled ? (
              <div className="mt-3">
                <div className="mb-1.5 text-xs text-gray-500">{copy.mcpHow}</div>
                <div className="flex items-center gap-2">
                  <code className="native-settings-code">{MCP_ENV}</code>
                  <button type="button" className="native-ghost-action" onClick={copyEnv} aria-label={t("common.copy")} data-testid="mcp-copy-env">
                    <Icon name="copy" size={13} /> {t("common.copy")}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-gray-500">{copy.unavailable}</p>
        )}
      </section>
    </div>
  );
}
