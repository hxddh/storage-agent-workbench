# Security

Security is a core product requirement.

## Secret handling

Secrets include:

- Model API keys
- Cloud access keys
- Cloud secret keys
- Session tokens
- Authorization headers
- Presigned URL credentials
- Cookies
- Bearer tokens

Rules:

1. Secrets must never enter LLM prompts.
2. Secrets must never be stored in SQLite.
3. Secrets must never be stored in logs.
4. Secrets must never be stored in traces.
5. Secrets must never be stored in reports.
6. Secrets must never be stored in frontend state longer than needed for submission.
7. Secrets must be stored only through system Keychain / Python keyring.
8. SQLite may store only secret references.

## Tool safety

Rules:

1. No generic shell tool.
2. No raw subprocess tool exposed to the Agent.
3. No raw boto3 client exposed to the Agent.
4. Cloud operations must go through whitelist tools.
5. Default mode is readonly.
6. test-write mode must be explicitly enabled and prefix-limited.
7. Destructive operations are forbidden in MVP.

Forbidden in MVP:

- DeleteBucket
- PutBucketPolicy
- PutBucketAcl
- PutLifecycleConfiguration
- DeleteObjects
- Recursive delete
- Mass object mutation
- Bucket-wide destructive or mutating operation

## Analysis safety

Rules:

1. Do not download object bodies by default.
2. Full bucket scans require explicit user approval.
3. Large scans require max_objects or prefix limits.
4. Reports should show at most 20 sample object keys by default.
5. Logs should be sanitized before persistence.
6. Presigned URLs must be redacted before storage or display.

## Redaction

Must redact:

- Access keys
- Secret keys
- Session tokens
- API keys
- Authorization headers
- Signatures
- Presigned URL credentials
- Sensitive query parameters
- Cookies
- Bearer tokens

## Audit

Record these events:

- Tool calls
- Tool inputs after sanitization
- Tool outputs after sanitization
- Analysis SQL
- Data imports
- Approval events
- Report generation

## Provider unsupported

S3-compatible providers may not support every AWS S3 API.

Unsupported APIs should be recorded as:

```text
Provider unsupported
```

They should not be treated as hard failures unless the requested task requires that capability.
