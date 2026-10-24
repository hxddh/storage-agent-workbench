/**
 * A small S3-compatible stub for end-to-end runs and domain tests. Read-only
 * for the app; ignores signatures. Each bucket is a profile of what its
 * configuration APIs answer, including the 501s and 403s real providers send.
 * `POST /__fake/fix?bucket=…` stands in for the user applying a fix outside
 * the app, so a run can verify it.
 *
 *   node scripts/fake-s3.mjs 9100
 */
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

/** The two buckets the end-to-end run uses. */
export const DEFAULT_BUCKETS = {
  'demo-public': { public: true, encryption: false },
  'demo-private': { public: false, encryption: true, blocked: true },
}

const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>${body}`

function send(res, status, body, type = 'application/xml') {
  res.writeHead(status, { 'content-type': type, 'x-amz-request-id': 'fake' })
  res.end(body)
}

function error(res, status, code) {
  send(res, status, xml(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`))
}

function policyOf(bucket, config) {
  if (!config.public && !config.conditional) return null
  const statement = {
    Effect: 'Allow',
    Principal: '*',
    Action: ['s3:GetObject'],
    Resource: `arn:aws:s3:::${bucket}/*`,
  }
  if (config.conditional) statement.Condition = { IpAddress: { 'aws:SourceIp': '10.0.0.0/8' } }
  return { Version: '2012-10-17', Statement: [statement] }
}

function handler(buckets) {
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const parts = url.pathname.split('/').filter(Boolean)
    const bucket = parts[0]
    const key = parts.slice(1).join('/')
    const query = url.searchParams

    if (req.method === 'POST' && bucket === '__fake' && key === 'fix') {
      const target = buckets[query.get('bucket') ?? '']
      if (!target) return error(res, 404, 'NoSuchBucket')
      target.public = false
      target.blocked = true
      res.writeHead(204)
      res.end()
      return
    }

    if (!bucket) {
      return send(
        res,
        200,
        xml(
          `<ListAllMyBucketsResult><Owner><ID>demo</ID><DisplayName>demo</DisplayName></Owner><Buckets>${Object.keys(
            buckets,
          )
            .map(
              (name) =>
                `<Bucket><Name>${name}</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket>`,
            )
            .join('')}</Buckets></ListAllMyBucketsResult>`,
        ),
      )
    }

    const config = buckets[bucket]
    if (!config) return error(res, 404, 'NoSuchBucket')

    if (req.method === 'HEAD') {
      res.writeHead(200)
      res.end()
      return
    }

    if (key && !query.has('acl') && !query.has('tagging')) {
      if (req.method === 'GET' && !query.has('list-type')) {
        return send(res, 200, 'hello from the fake bucket', 'text/plain')
      }
    }

    // An S3-compatible provider without the AWS-only configuration APIs.
    const unsupported =
      config.compat && (query.has('policyStatus') || query.has('publicAccessBlock'))
    if (unsupported) return error(res, 501, 'NotImplemented')

    if (query.has('location')) {
      return send(
        res,
        200,
        xml(`<LocationConstraint>${config.region ?? 'us-east-1'}</LocationConstraint>`),
      )
    }
    if (query.has('versioning')) {
      return send(
        res,
        200,
        xml(
          config.versioning
            ? '<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>'
            : '<VersioningConfiguration/>',
        ),
      )
    }
    if (query.has('encryption')) {
      if (!config.encryption)
        return error(res, 404, 'ServerSideEncryptionConfigurationNotFoundError')
      return send(
        res,
        200,
        xml(
          '<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>',
        ),
      )
    }
    if (query.has('lifecycle')) {
      if (!config.lifecycle) return error(res, 404, 'NoSuchLifecycleConfiguration')
      const abort =
        config.lifecycle === 'abort'
          ? '<AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation></AbortIncompleteMultipartUpload>'
          : ''
      return send(
        res,
        200,
        xml(
          `<LifecycleConfiguration><Rule><ID>r</ID><Status>Enabled</Status><Filter/><Expiration><Days>365</Days></Expiration>${abort}</Rule></LifecycleConfiguration>`,
        ),
      )
    }
    if (query.has('logging')) return send(res, 200, xml('<BucketLoggingStatus/>'))
    if (query.has('replication')) return error(res, 404, 'ReplicationConfigurationNotFoundError')
    if (query.has('policyStatus')) {
      if (!policyOf(bucket, config)) return error(res, 404, 'NoSuchBucketPolicy')
      return send(
        res,
        200,
        xml(`<PolicyStatus><IsPublic>${config.public ? 'true' : 'false'}</IsPublic></PolicyStatus>`),
      )
    }
    if (query.has('policy')) {
      const policy = policyOf(bucket, config)
      if (!policy) return error(res, 404, 'NoSuchBucketPolicy')
      // S3 returns the policy document itself, not XML.
      return send(res, 200, JSON.stringify(policy), 'application/json')
    }
    if (query.has('publicAccessBlock')) {
      if (!config.blocked) return error(res, 404, 'NoSuchPublicAccessBlockConfiguration')
      return send(
        res,
        200,
        xml(
          '<PublicAccessBlockConfiguration><BlockPublicAcls>true</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>true</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>',
        ),
      )
    }
    if (query.has('ownershipControls')) {
      if (config.aclDenied) return error(res, 404, 'OwnershipControlsNotFoundError')
      return send(
        res,
        200,
        xml(
          '<OwnershipControls><Rule><ObjectOwnership>BucketOwnerEnforced</ObjectOwnership></Rule></OwnershipControls>',
        ),
      )
    }
    if (query.has('acl')) {
      if (config.aclDenied) return error(res, 403, 'AccessDenied')
      return send(
        res,
        200,
        xml(
          '<AccessControlPolicy><Owner><ID>demo</ID></Owner><AccessControlList><Grant><Grantee><Type>CanonicalUser</Type><ID>demo</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>',
        ),
      )
    }
    if (query.has('tagging')) return error(res, 404, 'NoSuchTagSet')
    if (query.has('inventory')) {
      return send(
        res,
        200,
        xml(
          '<ListInventoryConfigurationsResult><InventoryConfigurationList/></ListInventoryConfigurationsResult>',
        ),
      )
    }
    if (query.has('cors')) {
      if (!config.cors) return error(res, 404, 'NoSuchCORSConfiguration')
      return send(
        res,
        200,
        xml(
          `<CORSConfiguration><CORSRule><AllowedOrigin>${config.cors}</AllowedOrigin><AllowedMethod>GET</AllowedMethod></CORSRule></CORSConfiguration>`,
        ),
      )
    }
    if (query.has('notification')) return send(res, 200, xml('<NotificationConfiguration/>'))
    if (query.get('list-type') === '2') {
      return send(
        res,
        200,
        xml(
          `<ListBucketResult><Name>${bucket}</Name><KeyCount>2</KeyCount><IsTruncated>false</IsTruncated>` +
            '<Contents><Key>reports/2026-01.csv</Key><Size>1024</Size><LastModified>2026-01-02T00:00:00.000Z</LastModified><StorageClass>STANDARD</StorageClass></Contents>' +
            '<Contents><Key>reports/2026-02.csv</Key><Size>2048</Size><LastModified>2026-02-02T00:00:00.000Z</LastModified><StorageClass>STANDARD</StorageClass></Contents>' +
            '</ListBucketResult>',
        ),
      )
    }
    error(res, 501, 'NotImplemented')
  }
}

/** Start a fake S3 on `port` (0 picks one). Resolves to the server and its endpoint. */
export function startFakeS3({
  port = 0,
  buckets = structuredClone(DEFAULT_BUCKETS),
  slowMs = 0,
} = {}) {
  const handle = handler(buckets)
  const server = createServer((req, res) => {
    if (slowMs > 0) setTimeout(() => handle(req, res), slowMs)
    else handle(req, res)
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, buckets, endpoint: `http://127.0.0.1:${address.port}` })
    })
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 9100)
  await startFakeS3({ port, slowMs: Number(process.env.SLOW_MS ?? 0) })
  console.log(`fake-s3 listening on ${port}`)
}
