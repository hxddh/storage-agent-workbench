/**
 * A tiny S3-compatible stub for local end-to-end runs. Read-only; ignores
 * signatures. Two buckets: one public with no encryption, one private.
 *
 *   node scripts/fake-s3.mjs 9100
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 9100)

const BUCKETS = {
  'demo-public': { public: true, encryption: false },
  'demo-private': { public: false, encryption: true },
}

const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>${body}`

function error(res, status, code) {
  res.writeHead(status, { 'content-type': 'application/xml' })
  res.end(xml(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`))
}

const SLOW_MS = Number(process.env.SLOW_MS ?? 0)

function handle(req, res) {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  const parts = url.pathname.split('/').filter(Boolean)
  const bucket = parts[0]
  const key = parts.slice(1).join('/')
  const query = url.searchParams

  res.setHeader('x-amz-request-id', 'fake')

  if (!bucket) {
    res.writeHead(200, { 'content-type': 'application/xml' })
    res.end(
      xml(
        `<ListAllMyBucketsResult><Owner><ID>demo</ID><DisplayName>demo</DisplayName></Owner><Buckets>${Object.keys(
          BUCKETS,
        )
          .map(
            (name) =>
              `<Bucket><Name>${name}</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket>`,
          )
          .join('')}</Buckets></ListAllMyBucketsResult>`,
      ),
    )
    return
  }

  const config = BUCKETS[bucket]
  if (!config) return error(res, 404, 'NoSuchBucket')

  if (req.method === 'HEAD') {
    res.writeHead(200)
    res.end()
    return
  }

  if (key && !query.has('acl') && !query.has('tagging')) {
    if (req.method === 'GET' && !query.has('list-type')) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello from the fake bucket')
      return
    }
  }

  if (query.has('location')) {
    res.writeHead(200, { 'content-type': 'application/xml' })
    res.end(xml('<LocationConstraint>us-east-1</LocationConstraint>'))
    return
  }
  if (query.has('versioning')) {
    res.writeHead(200, { 'content-type': 'application/xml' })
    res.end(xml('<VersioningConfiguration/>'))
    return
  }
  if (query.has('encryption')) {
    if (!config.encryption) return error(res, 404, 'ServerSideEncryptionConfigurationNotFoundError')
    res.writeHead(200, { 'content-type': 'application/xml' })
    res.end(
      xml(
        '<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>',
      ),
    )
    return
  }
  if (query.has('lifecycle')) return error(res, 404, 'NoSuchLifecycleConfiguration')
  if (query.has('logging')) {
    res.writeHead(200, { 'content-type': 'application/xml' })
    res.end(xml('<BucketLoggingStatus/>'))
    return
  }
  if (query.has('replication')) return error(res, 404, 'ReplicationConfigurationNotFoundError')
  if (query.has('policyStatus')) {
    if (!config.public) return error(res, 404, 'NoSuchBucketPolicy')
    res.writeHead(200, { 'content-type': 'application/xml' })
    res.end(xml('<PolicyStatus><IsPublic>true</IsPublic></PolicyStatus>'))
    return
  }
  if (query.has('policy')) {
    if (!config.public) return error(res, 404, 'NoSuchBucketPolicy')
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: `arn:aws:s3:::${bucket}/*`,
        },
      ],
    }
    res.writeHead(200, { 'content-type': 'application/xml' })
    res.end(xml(`<Policy>${escapeXml(JSON.stringify(policy))}</Policy>`))
    return
  }
  if (query.has('publicAccessBlock')) {
    if (config.public) return error(res, 404, 'NoSuchPublicAccessBlockConfiguration')
    res.writeHead(200, { 'content-type': 'application/xml' })
    res.end(
      xml(
        '<PublicAccessBlockConfiguration><BlockPublicAcls>true</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>true</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>',
      ),
    )
    return
  }
  if (query.has('ownershipControls')) {
    res.writeHead(200, { 'content-type': 'application/xml' })
    res.end(
      xml(
        '<OwnershipControls><Rule><ObjectOwnership>BucketOwnerEnforced</ObjectOwnership></Rule></OwnershipControls>',
      ),
    )
    return
  }
  if (query.has('acl')) {
    res.writeHead(200, { 'content-type': 'application/xml' })
    res.end(
      xml(
        '<AccessControlPolicy><Owner><ID>demo</ID></Owner><AccessControlList><Grant><Grantee><Type>CanonicalUser</Type><ID>demo</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>',
      ),
    )
    return
  }
  if (query.has('tagging')) return error(res, 404, 'NoSuchTagSet')
  if (query.has('inventory')) {
    res.writeHead(200, { 'content-type': 'application/xml' })
    res.end(xml('<ListInventoryConfigurationsResult><InventoryConfigurationList/></ListInventoryConfigurationsResult>'))
    return
  }
  if (query.has('cors')) return error(res, 404, 'NoSuchCORSConfiguration')
  if (query.has('notification')) {
    res.writeHead(200, { 'content-type': 'application/xml' })
    res.end(xml('<NotificationConfiguration/>'))
    return
  }
  if (query.get('list-type') === '2') {
    res.writeHead(200, { 'content-type': 'application/xml' })
    res.end(
      xml(
        `<ListBucketResult><Name>${bucket}</Name><KeyCount>2</KeyCount><IsTruncated>false</IsTruncated>` +
          '<Contents><Key>reports/2026-01.csv</Key><Size>1024</Size><LastModified>2026-01-02T00:00:00.000Z</LastModified><StorageClass>STANDARD</StorageClass></Contents>' +
          '<Contents><Key>reports/2026-02.csv</Key><Size>2048</Size><LastModified>2026-02-02T00:00:00.000Z</LastModified><StorageClass>STANDARD</StorageClass></Contents>' +
          '</ListBucketResult>',
      ),
    )
    return
  }

  res.writeHead(501, { 'content-type': 'application/xml' })
  res.end(xml('<Error><Code>NotImplemented</Code><Message>NotImplemented</Message></Error>'))
}

const server = createServer((req, res) => {
  if (SLOW_MS > 0) setTimeout(() => handle(req, res), SLOW_MS)
  else handle(req, res)
})

function escapeXml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

server.listen(port, '127.0.0.1', () => {
  console.log(`fake-s3 listening on ${port}`)
})
