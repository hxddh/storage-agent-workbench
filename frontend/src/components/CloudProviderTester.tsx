import { useState } from "react";
import { testCloudProvider, toolHeadBucket, toolListObjectsV2 } from "../api";
import type {
  CloudProvider,
  CredentialsTestResult,
  HeadBucketResult,
  ListObjectsResult,
} from "../types";
import { Button, TextInput } from "./ui";
import { ToolResultCard } from "./ToolResultCard";

const DEFAULT_MAX_KEYS = 100; // backend additionally clamps to a hard cap

/**
 * Read-only Test Connection panel for a cloud provider:
 * - Test Connection (test_credentials)
 * - Head Bucket / List Objects against a user-supplied bucket
 *
 * No secret is ever entered or stored here.
 */
export function CloudProviderTester({ provider }: { provider: CloudProvider }) {
  const [bucket, setBucket] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [cred, setCred] = useState<CredentialsTestResult | null>(null);
  const [head, setHead] = useState<HeadBucketResult | null>(null);
  const [list, setList] = useState<ListObjectsResult | null>(null);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3 rounded-md border border-edge/70 bg-canvas/60 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Button onClick={() => run("cred", async () => setCred(await testCloudProvider(provider.id)))} disabled={busy !== null}>
          {busy === "cred" ? "Testing…" : "Test Connection"}
        </Button>
        <span className="text-xs text-gray-600">read-only</span>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <TextInput
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
          placeholder="bucket name"
          style={{ maxWidth: 220 }}
        />
        <Button
          onClick={() => run("head", async () => setHead(await toolHeadBucket(provider.id, bucket)))}
          disabled={busy !== null || !bucket.trim()}
        >
          {busy === "head" ? "…" : "Head Bucket"}
        </Button>
        <Button
          onClick={() =>
            run("list", async () => setList(await toolListObjectsV2(provider.id, bucket, DEFAULT_MAX_KEYS)))
          }
          disabled={busy !== null || !bucket.trim()}
        >
          {busy === "list" ? "…" : "List Objects"}
        </Button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {cred && (
        <ToolResultCard
          title="test_credentials"
          success={cred.success}
          rows={[
            { label: "provider", value: cred.provider_type },
            { label: "endpoint", value: cred.endpoint_url ?? "—" },
            { label: "region", value: cred.region ?? "—" },
            { label: "identity", value: cred.identity_hint ?? "—" },
          ]}
          errorCode={cred.error_code}
          errorMessage={cred.error_message_sanitized}
        />
      )}

      {head && (
        <ToolResultCard
          title="head_bucket"
          success={head.success}
          rows={[{ label: "status", value: head.status_code != null ? String(head.status_code) : "—" }]}
          errorCode={head.error_code}
          errorMessage={head.error_message_sanitized}
        />
      )}

      {list && (
        <ToolResultCard
          title="list_objects_v2"
          success={list.success}
          rows={[
            { label: "key count", value: String(list.key_count) },
            { label: "truncated", value: String(list.is_truncated) },
            { label: "common prefixes", value: list.common_prefixes.join(", ") || "—" },
            { label: "sample keys", value: list.sample_keys.join(", ") || "—" },
          ]}
          errorCode={list.error_code}
          errorMessage={list.error_message_sanitized}
        />
      )}
    </div>
  );
}
