/**
 * v2.1 — a tool row reads as what the Agent did ("Checked bucket"), not as a
 * function name (`head_bucket`). The raw name stays on the row as `data-tool`
 * and its tooltip, so nothing is hidden; an unknown tool falls back to its
 * own name with spaces.
 */
import type { Lang } from "../i18n";

const LABELS: Record<string, { en: string; zh: string }> = {
  list_providers: { en: "Listed providers", zh: "列出提供方" },
  list_buckets: { en: "Listed buckets", zh: "列出桶" },
  test_credentials: { en: "Tested credentials", zh: "测试凭证" },
  head_bucket: { en: "Checked bucket", zh: "检查桶" },
  get_bucket_location: { en: "Read bucket region", zh: "读取桶区域" },
  list_objects: { en: "Listed objects", zh: "列出对象" },
  head_object: { en: "Checked object", zh: "检查对象" },
  preview_object: { en: "Previewed object", zh: "预览对象" },
  list_object_versions: { en: "Listed versions", zh: "列出版本" },
  list_multipart_uploads: { en: "Listed multipart uploads", zh: "列出分段上传" },
  list_upload_parts: { en: "Listed upload parts", zh: "列出分段" },
  get_object_acl: { en: "Read object ACL", zh: "读取对象 ACL" },
  get_object_attributes: { en: "Read object attributes", zh: "读取对象属性" },
  get_object_lock_status: { en: "Read object lock", zh: "读取对象锁" },
  get_object_tagging: { en: "Read object tags", zh: "读取对象标签" },
  test_range_get: { en: "Tested range read", zh: "测试范围读取" },
  test_conditional_get: { en: "Tested conditional read", zh: "测试条件读取" },
  test_addressing_style: { en: "Tested addressing style", zh: "测试寻址方式" },
  inspect_endpoint_tls: { en: "Inspected TLS", zh: "检查 TLS" },
  measure_request_latency: { en: "Measured latency", zh: "测量延迟" },
  diagnose_presigned_url: { en: "Diagnosed presigned URL", zh: "诊断预签名 URL" },
  get_bucket_config_summary: { en: "Read bucket configuration", zh: "读取桶配置" },
  get_bucket_config_detail: { en: "Read configuration detail", zh: "读取配置详情" },
  review_bucket_config: { en: "Reviewed bucket configuration", zh: "审查桶配置" },
  review_bucket_security: { en: "Reviewed security", zh: "审查安全" },
  review_bucket_lifecycle: { en: "Reviewed lifecycle", zh: "审查生命周期" },
  review_bucket_observability: { en: "Reviewed observability", zh: "审查可观测性" },
  review_bucket_performance_profile: { en: "Reviewed performance", zh: "审查性能" },
  review_bucket_cost_optimization: { en: "Reviewed cost", zh: "审查成本" },
  survey_account: { en: "Surveyed account", zh: "盘点账号" },
  query_account_profile: { en: "Queried account profile", zh: "查询账号画像" },
  compare_to_last_survey: { en: "Compared with last survey", zh: "与上次盘点对比" },
  read_run_result: { en: "Read analysis result", zh: "读取分析结果" },
  import_evidence: { en: "Imported evidence", zh: "导入证据" },
  list_imported_evidence: { en: "Listed imported evidence", zh: "列出已导入证据" },
  aggregate_imported_evidence: { en: "Aggregated imported evidence", zh: "汇总已导入证据" },
  list_uploaded_files: { en: "Listed attached files", zh: "列出附件" },
  analyze_uploaded_file: { en: "Analyzed attached file", zh: "分析附件" },
  aggregate_uploaded_file: { en: "Aggregated attached file", zh: "汇总附件" },
  simulate_storage_cost: { en: "Simulated storage cost", zh: "模拟存储成本" },
  get_price_table_status: { en: "Checked price table", zh: "检查价格表" },
  draft_remediation_plan: { en: "Drafted remediation plan", zh: "起草整改方案" },
  verify_remediation_plan: { en: "Verified remediation plan", zh: "验证整改方案" },
  capture_task_baseline: { en: "Captured baseline", zh: "记录基线" },
  compare_task_drift: { en: "Compared drift", zh: "对比漂移" },
  set_task_revisit_days: { en: "Scheduled revisit", zh: "安排回访" },
  read_skill: { en: "Read skill", zh: "读取技能" },
  load_tools: { en: "Loaded tools", zh: "加载工具" },
  note_fact: { en: "Noted fact", zh: "记录事实" },
  record_finding: { en: "Recorded finding", zh: "记录发现" },
  note_open_question: { en: "Noted open question", zh: "记录待解问题" },
  update_memory_item: { en: "Updated note", zh: "更新记录" },
  resolve_memory_item: { en: "Resolved note", zh: "解决记录" },
};

export function toolLabel(tool: string, lang: Lang): string {
  const known = LABELS[tool];
  if (known) return known[lang];
  const spaced = tool.replace(/_/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : tool;
}
