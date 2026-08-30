import { Button } from "./ui";
import { useI18n } from "../i18n";

export function FirstRunWizard({
  onConfigure,
  onDismiss,
}: {
  onConfigure: () => void;
  onDismiss: () => void;
}) {
  const { lang } = useI18n();
  const copy = lang === "zh"
    ? {
        title: "配置 Storage Agent",
        body: "本地优先的对象存储 Agent。它会执行真实的只读检查、持续展示 Execution，并在需要下载、导入或其他明确决策时停下来等你确认。",
        steps: [
          ["配置 Model Provider", "为 Agent 提供推理能力。API Key 只保存在本机加密 Vault。"],
          ["连接 Storage Provider", "提供受范围约束的只读凭证，让 Agent 能检查真实 Bucket、配置和 Evidence。"],
          ["Delegate 第一个 Task", "直接描述目标、约束与期望结果；运行中可以随时 Steer 或 Stop。"],
        ],
        later: "稍后配置",
        configure: "配置 Agent",
      }
    : {
        title: "Configure Storage Agent",
        body: "A local-first object-storage Agent that performs real read-only checks, exposes Execution as it works, and stops for your decision before downloads, imports, or other gated actions.",
        steps: [
          ["Configure a Model Provider", "Give the Agent reasoning capability. The API key stays in the encrypted local vault."],
          ["Connect a Storage Provider", "Use scoped read-only credentials so the Agent can inspect real buckets, configuration, and evidence."],
          ["Delegate the first task", "Describe the goal, constraints, and desired outcome. Steer or Stop the Agent at any time while it works."],
        ],
        later: "Configure later",
        configure: "Configure Agent",
      };

  return (
    <div className="fixed inset-0 z-wizard flex items-center justify-center bg-scrim p-4 backdrop-blur-sm animate-fade-in">
      <div className="w-[min(540px,94vw)] overflow-hidden rounded-2xl border border-edge bg-panel shadow-pop animate-scale-in" data-testid="agent-first-run">
        <div className="border-b border-edge bg-elevated px-7 pb-5 pt-7">
          <div className="mb-3 grid h-11 w-11 place-items-center rounded-xl border border-edge-strong bg-panel text-accent">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" aria-hidden>
              <path d="M12 2 2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <div className="text-lg font-medium text-gray-100">{copy.title}</div>
          <p className="mt-1.5 text-sm leading-relaxed text-gray-400">{copy.body}</p>
        </div>

        <ol className="space-y-1 px-5 py-5">
          {copy.steps.map(([title, body], index) => (
            <li key={title} className="flex gap-3 rounded-xl px-2 py-2">
              <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-accent/40 bg-accent/10 text-xs font-semibold text-accent-soft">
                {index + 1}
              </span>
              <div>
                <div className="text-sm font-medium text-gray-100">{title}</div>
                <div className="text-sm leading-relaxed text-gray-500">{body}</div>
              </div>
            </li>
          ))}
        </ol>

        <div className="flex justify-end gap-2 border-t border-edge px-5 py-4">
          <Button variant="ghost" onClick={onDismiss}>{copy.later}</Button>
          <Button variant="primary" onClick={onConfigure}>{copy.configure}</Button>
        </div>
      </div>
    </div>
  );
}
