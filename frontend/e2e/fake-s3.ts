import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local S3-compatible endpoint, so the browser specs can drive a provider that
 * actually answers.
 *
 * Every existing provider spec creates a provider whose endpoint points nowhere.
 * That is the right shape for the security assertions (the plaintext secret must
 * not reach the DOM or the API response) but it means the question a user asks
 * FIRST on a fresh install — "does this connection work?" — has never been
 * answered by a test. `CloudProviderTester` is the panel that answers it, and it
 * has no coverage of any kind: not a unit test, not a browser test.
 *
 * The sidecar suite grew `tests/fake_s3.py` in v0.66.0 for the same reason one
 * layer down. This is its Node counterpart, reachable from the Playwright
 * process the way `fake-model.ts` is: the sidecar runs on the same host, so a
 * socket on 127.0.0.1 is a cloud provider as far as boto3 is concerned.
 *
 * It is a TEST DOUBLE. It does not verify signatures — re-implementing SigV4
 * would be testing botocore, not this app — and serves only the read-only
 * operations the whitelist uses.
 */

const LIST_BUCKETS = (names: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Owner><ID>acme-owner-id</ID><DisplayName>acme</DisplayName></Owner>
  <Buckets>${names
    .map((n) => `<Bucket><Name>${n}</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket>`)
    .join("")}</Buckets>
</ListAllMyBucketsResult>`;

const LIST_OBJECTS = (bucket: string, prefix: string, maxKeys: number, keys: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${keys.length}</KeyCount>
  <MaxKeys>${maxKeys}</MaxKeys><IsTruncated>false</IsTruncated>
  ${keys
    .map(
      (k, i) =>
        `<Contents><Key>${k}</Key><LastModified>2026-06-01T00:00:00.000Z</LastModified>` +
        `<ETag>&quot;${i.toString(16).padStart(32, "0")}&quot;</ETag><Size>${1024 * (i + 1)}</Size>` +
        `<StorageClass>STANDARD</StorageClass></Contents>`,
    )
    .join("")}
</ListBucketResult>`;

const ERROR = (code: string, message: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>${code}</Code><Message>${message}</Message>
<RequestId>FAKEREQ0001</RequestId><HostId>fakehost</HostId></Error>`;

/** The config sub-resources a bucket snapshot reads, and what they answer. */
export interface BucketConfig {
  /** `?policyStatus` → IsPublic. undefined = the endpoint does not support it. */
  policyIsPublic?: boolean;
  /** `?acl` → whether a grant targets AllUsers / AuthenticatedUsers. */
  aclPublic?: boolean;
  encrypted?: boolean;
}

const POLICY_STATUS = (isPublic: boolean) =>
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<PolicyStatus xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
  `<IsPublic>${isPublic ? "true" : "false"}</IsPublic></PolicyStatus>`;

const ACL = (isPublic: boolean) =>
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<AccessControlPolicy xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
  `<Owner><ID>acme-owner-id</ID></Owner><AccessControlList>` +
  (isPublic
    ? `<Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
      `xsi:type="Group"><URI>http://acs.amazonaws.com/groups/global/AllUsers</URI></Grantee>` +
      `<Permission>READ</Permission></Grant>`
    : `<Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
      `xsi:type="CanonicalUser"><ID>acme-owner-id</ID></Grantee>` +
      `<Permission>FULL_CONTROL</Permission></Grant>`) +
  `</AccessControlList></AccessControlPolicy>`;

const ENCRYPTION = () =>
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<ServerSideEncryptionConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
  `<Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm>` +
  `</ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>`;

/** What AWS itself returns when a configuration simply is not set. */
const NOT_CONFIGURED: Record<string, [number, string]> = {
  policy: [404, "NoSuchBucketPolicy"],
  lifecycle: [404, "NoSuchLifecycleConfiguration"],
  encryption: [404, "ServerSideEncryptionConfigurationNotFoundError"],
  replication: [404, "ReplicationConfigurationNotFoundError"],
  publicAccessBlock: [404, "NoSuchPublicAccessBlockConfiguration"],
  tagging: [404, "NoSuchTagSet"],
  "object-lock": [404, "ObjectLockConfigurationNotFoundError"],
  ownershipControls: [404, "OwnershipControlsNotFoundError"],
  cors: [404, "NoSuchCORSConfiguration"],
};

/** Sub-resources answered with an empty-but-valid document when supported. */
const EMPTY_DOC: Record<string, string> = {
  versioning: '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>',
  logging: '<BucketLoggingStatus xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>',
  notification: '<NotificationConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>',
};

const LOCATION = (region: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${region}</LocationConstraint>`;

export interface FakeS3 {
  endpointUrl: string;
  /** Every request line seen: `${method} ${path}`. */
  requests: string[];
  /** Set to turn the whole endpoint into one specific S3 failure. */
  failWith: (status: number, code: string, message: string) => void;
  clearFailure: () => void;
  close: () => Promise<void>;
}

export interface FakeS3Options {
  region?: string;
  /**
   * How the endpoint answers bucket-configuration sub-resources.
   *
   * `"full"` behaves like AWS. `"unsupported"` is the minimal S3-compatible
   * endpoint — MinIO, Ceph, garage — which answers `501 NotImplemented` for
   * most of them; `"denied"` is an AWS account whose credentials lack the
   * `s3:GetBucketPolicyStatus` / `s3:GetBucketAcl` permissions. Both are
   * ordinary real-world setups, and both mean the exposure question CANNOT be
   * answered — which is a different fact from "nothing is exposed".
   */
  subresources?: "full" | "unsupported" | "denied";
  /** Per-bucket configuration, used when `subresources` is "full". */
  config?: Record<string, BucketConfig>;
}

export async function startFakeS3(
  buckets: Record<string, string[]> = { "acme-logs": ["logs/2026/06/a.parquet"] },
  opts: FakeS3Options | string = {},
): Promise<FakeS3> {
  const o: FakeS3Options = typeof opts === "string" ? { region: opts } : opts;
  const region = o.region ?? "us-east-1";
  const mode = o.subresources ?? "full";
  const config = o.config ?? {};
  const requests: string[] = [];
  let failure: { status: number; code: string; message: string } | null = null;

  /** Resolve the target from EITHER addressing style, like the real thing. */
  const resolve = (host: string, pathname: string): [string | null, string] => {
    const h = (host || "").split(":")[0];
    for (const name of Object.keys(buckets)) {
      if (h.startsWith(`${name}.`)) return [name, pathname.replace(/^\//, "")];
    }
    const parts = pathname.replace(/^\//, "").split("/");
    return parts[0] ? [parts[0], parts.slice(1).join("/")] : [null, ""];
  };

  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const send = (status: number, body: string) => {
      const buf = Buffer.from(body);
      res.writeHead(status, {
        "Content-Type": "application/xml",
        "Content-Length": String(buf.length),
        "x-amz-request-id": "FAKEREQ0001",
      });
      // A HEAD response carries the headers and no body.
      res.end(req.method === "HEAD" ? undefined : buf);
    };

    if (failure) return send(failure.status, ERROR(failure.code, failure.message));

    const url = new URL(req.url ?? "/", "http://placeholder");
    const [bucket, key] = resolve(req.headers.host ?? "", url.pathname);

    if (req.method === "HEAD") {
      const found = bucket !== null && bucket in buckets && (!key || buckets[bucket].includes(key));
      res.writeHead(found ? 200 : 404, {
        "Content-Length": "0",
        "x-amz-request-id": "FAKEREQ0001",
        ...(found && key ? { ETag: '"0123456789abcdef"' } : {}),
      });
      return res.end();
    }

    if (bucket === null) return send(200, LIST_BUCKETS(Object.keys(buckets)));
    if (!(bucket in buckets)) {
      return send(404, ERROR("NoSuchBucket", "The specified bucket does not exist"));
    }
    // S3 sub-resources are VALUELESS flags; `has` sees them, a value lookup
    // would not.
    if (url.searchParams.has("location")) return send(200, LOCATION(region));

    const sub = [...url.searchParams.keys()].find((k) => k !== "prefix" && k !== "max-keys" &&
      k !== "delimiter" && k !== "list-type" && k !== "encoding-type" && k !== "continuation-token");
    if (sub) {
      if (mode === "unsupported") {
        return send(501, ERROR("NotImplemented", `A ${sub} configuration is not implemented`));
      }
      if (mode === "denied") {
        return send(403, ERROR("AccessDenied", `not authorized to read the ${sub} configuration`));
      }
      const cfg = config[bucket] ?? {};
      if (sub === "policyStatus") {
        if (cfg.policyIsPublic === undefined) {
          return send(404, ERROR("NoSuchBucketPolicy", "The bucket policy does not exist"));
        }
        return send(200, POLICY_STATUS(cfg.policyIsPublic));
      }
      if (sub === "acl") return send(200, ACL(cfg.aclPublic === true));
      if (sub === "encryption" && cfg.encrypted) return send(200, ENCRYPTION());
      if (sub === "policy" && cfg.policyIsPublic !== undefined) {
        return send(200, JSON.stringify({ Version: "2012-10-17", Statement: [] }));
      }
      if (EMPTY_DOC[sub]) return send(200, `<?xml version="1.0" encoding="UTF-8"?>${EMPTY_DOC[sub]}`);
      const na = NOT_CONFIGURED[sub];
      if (na) return send(na[0], ERROR(na[1], `no ${sub} configuration`));
      return send(501, ERROR("NotImplemented", `${sub} is not implemented`));
    }

    const prefix = url.searchParams.get("prefix") ?? "";
    const maxKeys = Number(url.searchParams.get("max-keys") ?? 1000);
    const keys = buckets[bucket].filter((k) => k.startsWith(prefix)).slice(0, maxKeys);
    return send(200, LIST_OBJECTS(bucket, prefix, maxKeys, keys));
  });

  await new Promise<void>((resolve_) => server.listen(0, "127.0.0.1", resolve_));
  const { port } = server.address() as AddressInfo;
  return {
    endpointUrl: `http://127.0.0.1:${port}`,
    requests,
    failWith: (status, code, message) => {
      failure = { status, code, message };
    },
    clearFailure: () => {
      failure = null;
    },
    close: () => new Promise<void>((resolve_) => server.close(() => resolve_())),
  };
}

const SIDECAR = `http://127.0.0.1:${process.env.E2E_SIDECAR_PORT || 8799}`;

/** Delete a cloud provider, so the next spec still sees a fresh install. */
export async function dropCloudProvider(id: string): Promise<void> {
  await fetch(`${SIDECAR}/cloud-providers/${id}`, { method: "DELETE" }).catch(() => undefined);
}

/** Every cloud provider currently configured, for cleanup by name. */
export async function listCloudProviders(): Promise<Array<{ id: string; name: string }>> {
  const res = await fetch(`${SIDECAR}/cloud-providers`);
  return (await res.json()) as Array<{ id: string; name: string }>;
}
