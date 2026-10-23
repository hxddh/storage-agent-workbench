/**
 * v2.1 — a tool row reads as what the Agent did ("Checked bucket"), not as a
 * function name (`probe_endpoint`). The raw name stays on the row as `data-tool`
 * and its tooltip, so nothing is hidden; an unknown tool falls back to its
 * own name with spaces.
 */
import type { Lang } from "../i18n";

const LABELS: Record<string, { en: string; zh: string }> = {
  // v10: the fifteen registered tools.
  list_buckets: { en: "Listed buckets", zh: "列出桶" },
  probe_endpoint: { en: "Probed endpoint", zh: "探测端点" },
  list_objects: { en: "Listed objects", zh: "列出对象" },
  inspect_object: { en: "Inspected object", zh: "检查对象" },
  review_bucket_config: { en: "Reviewed bucket configuration", zh: "审查桶配置" },
  survey_account: { en: "Surveyed account", zh: "盘点账号" },
  query_estate: { en: "Checked what is known", zh: "查询已知情况" },
  fix_preview: { en: "Previewed a fix", zh: "预览修复" },
  note: { en: "Kept a note", zh: "记下备注" },
  read_skill: { en: "Read skill", zh: "读取技能" },
  import_evidence: { en: "Imported evidence", zh: "导入证据" },
  analyze_uploaded_file: { en: "Analyzed attached file", zh: "分析附件" },
  triage_error: { en: "Triaged error", zh: "分诊错误" },
  simulate_storage_cost: { en: "Simulated storage cost", zh: "模拟存储成本" },
};

export function toolLabel(tool: string, lang: Lang): string {
  const known = LABELS[tool];
  if (known) return known[lang];
  const spaced = tool.replace(/_/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : tool;
}

/** Present-progressive labels for a call that is running right now. */
const RUNNING: Record<string, { en: string; zh: string }> = {
  list_buckets: { en: "Listing buckets", zh: "正在列出存储桶" },
  probe_endpoint: { en: "Probing endpoint", zh: "正在探测端点" },
  list_objects: { en: "Listing objects", zh: "正在列出对象" },
  inspect_object: { en: "Inspecting object", zh: "正在检查对象" },
  review_bucket_config: { en: "Reviewing bucket configuration", zh: "正在审查桶配置" },
  survey_account: { en: "Surveying account", zh: "正在盘点账号" },
  query_estate: { en: "Checking what is known", zh: "正在查询已知情况" },
  fix_preview: { en: "Previewing a fix", zh: "正在生成修复预览" },
  note: { en: "Keeping a note", zh: "正在记录备注" },
  read_skill: { en: "Reading skill", zh: "正在读取技能" },
  import_evidence: { en: "Importing evidence", zh: "正在导入证据" },
  analyze_uploaded_file: { en: "Analyzing attached file", zh: "正在分析附件" },
  triage_error: { en: "Triaging error", zh: "正在分诊错误" },
  simulate_storage_cost: { en: "Simulating storage cost", zh: "正在模拟存储成本" },
  record_conclusion: { en: "Recording conclusion", zh: "正在记录结论" },
};

export function toolRunLabel(tool: string, lang: Lang): string {
  const known = RUNNING[tool];
  if (known) return known[lang];
  return lang === "zh" ? `正在执行 ${tool.replace(/_/g, " ")}` : `Working on ${tool.replace(/_/g, " ")}`;
}
