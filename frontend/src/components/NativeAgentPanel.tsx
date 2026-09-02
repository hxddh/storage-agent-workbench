import { useEffect, useState } from "react";
import { getSkillsDirs, listSkills, getMcpStatus } from "../api";
import { useI18n } from "../i18n";

/** Skills, observability export, and the read-only MCP bridge: runtime facts only. */
export function NativeAgentPanel() {
  const { t, lang } = useI18n();
  const copy = lang === "zh"
    ? { noSkills: "还没有技能。把 SKILL.md 放到应用数据的 skills 目录即可添加。", enabled: "MCP 已启用", disabled: "MCP 已关闭", tools: "个工具", unavailable: "MCP 状态不可用。", perTask: "按任务", global: "全局" }
    : { noSkills: "No skills found. Drop a SKILL.md into the app data skills folder to add one.", enabled: "MCP enabled", disabled: "MCP disabled", tools: "tools", unavailable: "MCP status unavailable.", perTask: "Per task", global: "Global" };
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
    <div className="max-w-3xl space-y-8">
      <section>
        <h2 className="text-lg font-medium text-gray-100">{t("prov.skillsTitle")}</h2>
        <p className="mt-1 mb-3 text-xs leading-relaxed text-gray-500">{t("prov.skillsHint")}</p>
        {skillsLoading ? (
          <div className="skeleton h-16 w-full" aria-hidden />
        ) : skills.length === 0 ? (
          <p className="text-xs text-gray-500">{copy.noSkills}</p>
        ) : (
          <ul className="max-h-56 overflow-auto rounded-xl border border-edge">
            {skills.map((s) => (
              <li key={s.name} className="border-b border-edge px-3 py-2 last:border-0">
                <div className="text-sm text-gray-100">{s.name}</div>
                <div className="text-xs leading-relaxed text-gray-500">{s.description}</div>
              </li>
            ))}
          </ul>
        )}
        {dirs && (
          <p className="mt-2 font-mono text-2xs text-gray-500">
            {dirs.map((d) => `${d.path} (${d.exists ? `${d.skill_count} skills` : "not present"})`).join(" · ")}
          </p>
        )}
      </section>

      <section>
        <h2 className="text-lg font-medium text-gray-100">{t("prov.observability")}</h2>
        <p className="mt-1 text-xs leading-relaxed text-gray-500">{t("prov.observabilityHint")}</p>
        <p className="mt-2 font-mono text-2xs text-gray-500">{copy.perTask}: GET /agent-tasks/:id/export/otel · {copy.global}: GET /observability/export</p>
      </section>

      <section>
        <h2 className="text-lg font-medium text-gray-100">{t("prov.mcpTitle")}</h2>
        <p className="mt-1 mb-3 text-xs leading-relaxed text-gray-500">{t("prov.mcpHint")}</p>
        {mcp ? (
          <div className={`rounded-xl border px-3 py-2.5 text-xs ${mcp.enabled ? "border-success-border bg-success-bg text-success" : "border-edge text-gray-400"}`}>
            <div className="font-medium">{mcp.enabled ? copy.enabled : copy.disabled} · {mcp.allowed_tools.length} {copy.tools}</div>
            <div className="mt-1 leading-relaxed">{mcp.note}</div>
          </div>
        ) : (
          <p className="text-xs text-gray-500">{copy.unavailable}</p>
        )}
      </section>
    </div>
  );
}
