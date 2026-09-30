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
  // Retired in v10: older tasks still show calls under these names.
  head_bucket: { en: "Checked bucket", zh: "检查桶" },
  get_bucket_location: { en: "Read bucket region", zh: "读取桶区域" },
  test_object_read: { en: "Tested object read", zh: "测试对象读取" },
  preview_object: { en: "Previewed object", zh: "预览对象" },
  list_object_versions: { en: "Listed versions", zh: "列出版本" },
  list_multipart_uploads: { en: "Listed multipart uploads", zh: "列出分段上传" },
  list_upload_parts: { en: "Listed upload parts", zh: "列出分段" },
  test_addressing_style: { en: "Tested addressing style", zh: "测试寻址方式" },
  inspect_endpoint_tls: { en: "Inspected TLS", zh: "检查 TLS" },
  measure_request_latency: { en: "Measured latency", zh: "测量延迟" },
  diagnose_presigned_url: { en: "Diagnosed presigned URL", zh: "诊断预签名 URL" },
  get_bucket_config_detail: { en: "Read configuration detail", zh: "读取配置详情" },
  review_bucket_performance_profile: { en: "Reviewed performance", zh: "审查性能" },
  compare_to_last_survey: { en: "Compared with last survey", zh: "与上次盘点对比" },
  list_uploaded_files: { en: "Listed attached files", zh: "列出附件" },
  aggregate_uploaded_file: { en: "Aggregated attached file", zh: "汇总附件" },
};

export function toolLabel(tool: string, lang: Lang): string {
  const known = LABELS[tool];
  if (known) return known[lang];
  const spaced = tool.replace(/_/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : tool;
}
