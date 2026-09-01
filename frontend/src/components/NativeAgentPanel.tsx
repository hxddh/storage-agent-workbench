import { useEffect, useState } from "react";
import { getSkillsDirs, listSkills, getMcpStatus } from "../api";
import { useI18n } from "../i18n";

export function NativeAgentPanel() {
  const { t } = useI18n();
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [mcp, setMcp] = useState<{ enabled: boolean; allowed_tools: string[]; note: string } | null>(null);
  const [dirs, setDirs] = useState<{ path: string; exists: boolean; skill_count: number }[] | null>(null);

  useEffect(() => {
    let alive = true;
    listSkills().then((r) => { if (alive) setSkills(r.skills); }).catch(() => {}).finally(() => { if (alive) setSkillsLoading(false); });
    getMcpStatus().then((r) => { if (alive) setMcp(r); }).catch(() => {});
    getSkillsDirs().then((r) => { if (alive) setDirs(r.dirs); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  return (
    <div className="border-t border-edge bg-canvas px-8 py-5">
      <div className="mb-1 text-sm font-semibold text-gray-100">{t("prov.skillsTitle")}</div>
      <p className="mb-3 text-xs leading-relaxed text-gray-500">{t("prov.skillsHint")}</p>
      {skillsLoading ? (
        <div className="skeleton h-16 w-full" aria-hidden />
      ) : skills.length === 0 ? (
        <p className="text-xs text-gray-500">No skills found. Drop a SKILL.md into your app data skills folder to add one.</p>
      ) : (
        <ul className="mb-3 max-h-48 overflow-auto rounded-lg border border-edge bg-panel p-2">
          {skills.map((s) => (
            <li key={s.name} className="border-b border-edge px-2 py-1.5 last:border-0">
              <div className="text-xs font-medium text-gray-100">{s.name}</div>
              <div className="text-2xs leading-relaxed text-gray-500">{s.description}</div>
            </li>
          ))}
        </ul>
      )}
      {dirs && (
        <p className="mb-4 text-2xs text-gray-500">
          {dirs.map((d) => `${d.path} (${d.exists ? `${d.skill_count} skills` : "not present"})`).join(" · ")}
        </p>
      )}

      <div className="mb-1 text-sm font-semibold text-gray-100">{t("prov.observability")}</div>
      <p className="mb-2 text-xs leading-relaxed text-gray-500">{t("prov.observabilityHint")}</p>
      <p className="mb-4 text-2xs text-gray-500">Per-task: GET /agent-tasks/:id/export/otel · Global: GET /observability/export</p>

      <div className="mb-1 text-sm font-semibold text-gray-100">{t("prov.mcpTitle")}</div>
      <p className="mb-2 text-xs leading-relaxed text-gray-500">{t("prov.mcpHint")}</p>
      {mcp ? (
        <div className={`rounded-lg border px-3 py-2 text-xs ${mcp.enabled ? "border-success-border bg-success-bg text-success" : "border-edge bg-panel text-gray-500"}`}>
          <div className="font-medium">{mcp.enabled ? "MCP enabled" : "MCP disabled"} · {mcp.allowed_tools.length} tools</div>
          <div className="mt-1 leading-relaxed">{mcp.note}</div>
        </div>
      ) : (
        <p className="text-xs text-gray-500">MCP status unavailable.</p>
      )}
    </div>
  );
}
