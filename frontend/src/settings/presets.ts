/**
 * One-pick presets for the provider panes. A preset pre-fills type, endpoint
 * and addressing so the user only enters what is theirs (key, region, model).
 * Presets are UI sugar over the same API and the same vault rules; they never
 * add a provider type the Sidecar does not already accept.
 */

export type ModelPreset = {
  id: string;
  label: string;
  providerType: string;
  baseUrl: string;
  modelPlaceholder: string;
  local: boolean;
};

export const MODEL_PRESETS: ModelPreset[] = [
  { id: "openai", label: "OpenAI", providerType: "openai", baseUrl: "https://api.openai.com/v1", modelPlaceholder: "gpt-4.1", local: false },
  { id: "anthropic", label: "Anthropic (OpenAI-compatible)", providerType: "anthropic", baseUrl: "https://api.anthropic.com/v1", modelPlaceholder: "claude-sonnet-4-5", local: false },
  { id: "deepseek", label: "DeepSeek", providerType: "deepseek", baseUrl: "https://api.deepseek.com/v1", modelPlaceholder: "deepseek-reasoner", local: false },
  { id: "openrouter", label: "OpenRouter", providerType: "openrouter", baseUrl: "https://openrouter.ai/api/v1", modelPlaceholder: "openai/gpt-4.1", local: false },
  { id: "ollama", label: "Ollama", providerType: "ollama", baseUrl: "http://127.0.0.1:11434/v1", modelPlaceholder: "llama3.1", local: true },
  { id: "lmstudio", label: "LM Studio", providerType: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1", modelPlaceholder: "loaded-model", local: true },
  { id: "vllm", label: "vLLM", providerType: "vllm", baseUrl: "http://127.0.0.1:8000/v1", modelPlaceholder: "served-model-name", local: true },
  { id: "llamacpp", label: "llama.cpp", providerType: "llamacpp", baseUrl: "http://127.0.0.1:8080/v1", modelPlaceholder: "model", local: true },
  { id: "compatible", label: "OpenAI-compatible endpoint", providerType: "openai-compatible", baseUrl: "", modelPlaceholder: "model-name", local: true },
];

const LOCAL_PROVIDER_TYPES = new Set([
  "ollama", "lmstudio", "lm_studio", "local", "openai-compatible",
  "openai_compatible", "vllm", "llamacpp", "llama_cpp", "localai", "local_ai",
]);

export const isLocalProvider = (providerType: string) =>
  LOCAL_PROVIDER_TYPES.has((providerType || "").trim().toLowerCase());

export function modelPresetFor(providerType: string): ModelPreset | null {
  const type = (providerType || "").trim().toLowerCase();
  return MODEL_PRESETS.find((preset) => preset.providerType === type) ?? null;
}

export type CloudPreset = {
  id: string;
  label: string;
  providerType: string;
  endpointTemplate: string; // {region} / {account} placeholders; "" = AWS default
  variable: "region" | "account" | "endpoint" | "none";
  regionDefault: string;
  regionPlaceholder?: string;
  addressing: "virtual" | "path";
  signature: string;
  hint?: string;
};

export const CLOUD_PRESETS: CloudPreset[] = [
  { id: "aws", label: "AWS S3", providerType: "aws-s3", endpointTemplate: "", variable: "region", regionDefault: "us-east-1", addressing: "virtual", signature: "s3v4" },
  { id: "r2", label: "Cloudflare R2", providerType: "cloudflare-r2", endpointTemplate: "https://{account}.r2.cloudflarestorage.com", variable: "account", regionDefault: "auto", addressing: "path", signature: "s3v4", hint: "Account ID is in your R2 dashboard URL." },
  { id: "minio", label: "MinIO", providerType: "minio", endpointTemplate: "", variable: "endpoint", regionDefault: "us-east-1", addressing: "path", signature: "s3v4", hint: "The MinIO server URL, e.g. https://minio.example.com:9000." },
  { id: "oss", label: "Alibaba Cloud OSS", providerType: "alibaba-oss", endpointTemplate: "https://oss-{region}.aliyuncs.com", variable: "region", regionDefault: "cn-hangzhou", addressing: "virtual", signature: "s3v4" },
  { id: "cos", label: "Tencent Cloud COS", providerType: "tencent-cos", endpointTemplate: "https://cos.{region}.myqcloud.com", variable: "region", regionDefault: "ap-guangzhou", addressing: "virtual", signature: "s3v4" },
  { id: "bos", label: "Baidu BOS", providerType: "baidu-bos", endpointTemplate: "https://s3.{region}.bcebos.com", variable: "region", regionDefault: "bj", addressing: "virtual", signature: "s3v4" },
  { id: "tos", label: "Volcengine TOS", providerType: "volcengine-tos", endpointTemplate: "https://tos-s3-{region}.volces.com", variable: "region", regionDefault: "cn-beijing", addressing: "virtual", signature: "s3v4" },
  { id: "b2", label: "Backblaze B2", providerType: "backblaze-b2", endpointTemplate: "https://s3.{region}.backblazeb2.com", variable: "region", regionDefault: "us-west-004", regionPlaceholder: "us-west-004", addressing: "virtual", signature: "s3v4" },
  { id: "gcs", label: "Google Cloud Storage", providerType: "gcs-s3", endpointTemplate: "https://storage.googleapis.com", variable: "region", regionDefault: "auto", addressing: "path", signature: "s3v4", hint: "Use S3 interop (HMAC) keys — not a GCP service account." },
  { id: "custom", label: "Custom (S3-compatible)", providerType: "s3-compatible", endpointTemplate: "", variable: "endpoint", regionDefault: "", addressing: "virtual", signature: "s3v4" },
];

export function cloudEndpoint(preset: CloudPreset, form: { endpoint_url: string; region: string; account: string }): string {
  if (preset.variable === "endpoint") return form.endpoint_url.trim();
  if (preset.variable === "account") return preset.endpointTemplate.replace("{account}", form.account.trim());
  if (preset.endpointTemplate) return preset.endpointTemplate.replace("{region}", (form.region || preset.regionDefault).trim());
  return ""; // AWS: let boto3 use the regional default
}

export const parseList = (value: string) =>
  value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
