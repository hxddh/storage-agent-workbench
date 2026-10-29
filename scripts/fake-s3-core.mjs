/**
 * A small S3-compatible responder, as a pure function of a request. Read-only
 * for the app; it ignores signatures. Each bucket is a profile of what its
 * configuration APIs answer, including the 501s and 403s real providers send,
 * and an optional deterministic set of objects.
 *
 * `scripts/fake-s3.mjs` puts HTTP around it for the end-to-end runs and tests.
 */

/** The two buckets the end-to-end run uses. */
export const DEFAULT_BUCKETS = {
  'web-assets': { public: true, encryption: false },
  'data-lake': { public: false, encryption: true, blocked: true },
}

const xml = (body) => `<?xml version="1.0" encoding="UTF-8"?>${body}`
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function reply(status, body, type = 'application/xml') {
  return { status, headers: { 'content-type': type, 'x-amz-request-id': 'fake' }, body }
}

function error(status, code) {
  return reply(status, xml(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`))
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

/** A deterministic pseudo-random number in [0, 1) for a seed. */
function rand(seed) {
  let x = seed | 0
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}

const CLASSES = ['STANDARD', 'STANDARD', 'STANDARD', 'STANDARD', 'STANDARD_IA', 'GLACIER_IR']
const NOW = Date.UTC(2026, 9, 1)

/** The bucket's objects, sorted by key, generated once and cached on the profile. */
export function objectsOf(config) {
  if (config.__objects) return config.__objects
  const spec = config.objects ?? { count: 2, prefixes: ['reports/'] }
  const out = []
  for (let i = 0; i < spec.count; i++) {
    const prefix = spec.prefixes[i % spec.prefixes.length]
    const age = Math.floor(rand(i * 7 + 1) * 1100)
    const modified = new Date(NOW - age * 86_400_000)
    const year = modified.getUTCFullYear()
    const month = String(modified.getUTCMonth() + 1).padStart(2, '0')
    const size = Math.floor(rand(i * 13 + 5) ** 3 * 512 * 1024 * 1024) + 1024
    out.push({
      key: `${prefix}${year}/${month}/part-${String(i).padStart(5, '0')}.dat`,
      size,
      modified: modified.toISOString(),
      storageClass: CLASSES[Math.floor(rand(i * 3 + 2) * CLASSES.length)],
    })
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  config.__objects = out
  return out
}

/** Keys and common prefixes of one listing page. */
function page(objects, query, keyOf = (o) => o.key) {
  const prefix = query.get('prefix') ?? ''
  const delimiter = query.get('delimiter') ?? ''
  const max = Math.max(
    1,
    Math.min(Number(query.get('max-keys') ?? query.get('max-uploads') ?? 1000) || 1000, 1000),
  )
  const start = Number(query.get('continuation-token') ?? query.get('key-marker') ?? 0) || 0
  const contents = []
  const prefixes = new Set()
  let index = start
  for (; index < objects.length && contents.length + prefixes.size < max; index++) {
    const key = keyOf(objects[index])
    if (!key.startsWith(prefix)) continue
    if (delimiter) {
      const rest = key.slice(prefix.length)
      const cut = rest.indexOf(delimiter)
      if (cut >= 0) {
        prefixes.add(prefix + rest.slice(0, cut + delimiter.length))
        continue
      }
    }
    contents.push(objects[index])
  }
  while (index < objects.length && !keyOf(objects[index]).startsWith(prefix)) index++
  return { contents, prefixes: [...prefixes], next: index < objects.length ? String(index) : null }
}

/**
 * Answer one request. `buckets` is mutable state: `POST /__fake/fix?bucket=…`
 * stands in for the user applying a fix outside the app.
 */
export function respond(buckets, request) {
  const url = new URL(request.path ?? '/', 'http://127.0.0.1')
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const bucket = parts[0]
  const key = parts.slice(1).join('/')
  const query = url.searchParams
  const method = request.method ?? 'GET'

  if (method === 'POST' && bucket === '__fake' && key === 'fix') {
    const target = buckets[query.get('bucket') ?? '']
    if (!target) return error(404, 'NoSuchBucket')
    target.public = false
    target.blocked = true
    return { status: 204, headers: {}, body: '' }
  }

  if (!bucket) {
    return reply(
      200,
      xml(
        `<ListAllMyBucketsResult><Owner><ID>owner</ID><DisplayName>owner</DisplayName></Owner><Buckets>${Object.keys(
          buckets,
        )
          .map(
            (name) =>
              `<Bucket><Name>${esc(name)}</Name><CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket>`,
          )
          .join('')}</Buckets></ListAllMyBucketsResult>`,
      ),
    )
  }

  const config = buckets[bucket]
  if (!config) return error(404, 'NoSuchBucket')

  if (key && !query.has('acl') && !query.has('tagging')) {
    const object =
      objectsOf(config).find((o) => o.key === key) ?? (config.objects ? null : { key, size: 26 })
    if (!object) return error(404, 'NoSuchKey')
    if (method === 'HEAD') {
      return {
        status: 200,
        headers: {
          'content-length': String(object.size),
          'content-type': 'application/octet-stream',
          'last-modified': new Date(object.modified ?? NOW).toUTCString(),
          'x-amz-storage-class': object.storageClass ?? 'STANDARD',
          ...(config.encryption ? { 'x-amz-server-side-encryption': 'AES256' } : {}),
        },
        body: '',
      }
    }
    return reply(200, 'hello from the fake bucket', 'text/plain')
  }

  if (method === 'HEAD') return { status: 200, headers: {}, body: '' }

  // An S3-compatible provider without the AWS-only configuration APIs.
  if (config.compat && (query.has('policyStatus') || query.has('publicAccessBlock')))
    return error(501, 'NotImplemented')

  if (query.has('location'))
    return reply(
      200,
      xml(`<LocationConstraint>${config.region ?? 'us-east-1'}</LocationConstraint>`),
    )
  if (query.has('versioning'))
    return reply(
      200,
      xml(
        config.versioning
          ? '<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>'
          : '<VersioningConfiguration/>',
      ),
    )
  if (query.has('encryption')) {
    if (!config.encryption) return error(404, 'ServerSideEncryptionConfigurationNotFoundError')
    return reply(
      200,
      xml(
        '<ServerSideEncryptionConfiguration><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>',
      ),
    )
  }
  if (query.has('lifecycle')) {
    if (!config.lifecycle) return error(404, 'NoSuchLifecycleConfiguration')
    const abort =
      config.lifecycle === 'abort'
        ? '<AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation></AbortIncompleteMultipartUpload>'
        : ''
    return reply(
      200,
      xml(
        `<LifecycleConfiguration><Rule><ID>r</ID><Status>Enabled</Status><Filter/><Expiration><Days>365</Days></Expiration>${abort}</Rule></LifecycleConfiguration>`,
      ),
    )
  }
  if (query.has('logging')) return reply(200, xml('<BucketLoggingStatus/>'))
  if (query.has('replication')) return error(404, 'ReplicationConfigurationNotFoundError')
  if (query.has('policyStatus')) {
    if (!policyOf(bucket, config)) return error(404, 'NoSuchBucketPolicy')
    return reply(
      200,
      xml(`<PolicyStatus><IsPublic>${config.public ? 'true' : 'false'}</IsPublic></PolicyStatus>`),
    )
  }
  if (query.has('policy')) {
    const policy = policyOf(bucket, config)
    if (!policy) return error(404, 'NoSuchBucketPolicy')
    // S3 returns the policy document itself, not XML.
    return reply(200, JSON.stringify(policy), 'application/json')
  }
  if (query.has('publicAccessBlock')) {
    if (!config.blocked) return error(404, 'NoSuchPublicAccessBlockConfiguration')
    return reply(
      200,
      xml(
        '<PublicAccessBlockConfiguration><BlockPublicAcls>true</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>true</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>',
      ),
    )
  }
  if (query.has('ownershipControls')) {
    if (config.aclDenied) return error(404, 'OwnershipControlsNotFoundError')
    return reply(
      200,
      xml(
        '<OwnershipControls><Rule><ObjectOwnership>BucketOwnerEnforced</ObjectOwnership></Rule></OwnershipControls>',
      ),
    )
  }
  if (query.has('acl')) {
    if (config.aclDenied) return error(403, 'AccessDenied')
    return reply(
      200,
      xml(
        '<AccessControlPolicy><Owner><ID>owner</ID></Owner><AccessControlList><Grant><Grantee><Type>CanonicalUser</Type><ID>owner</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>',
      ),
    )
  }
  if (query.has('tagging')) return error(404, 'NoSuchTagSet')
  if (query.has('inventory'))
    return reply(
      200,
      xml(
        '<ListInventoryConfigurationsResult><InventoryConfigurationList/></ListInventoryConfigurationsResult>',
      ),
    )
  if (query.has('cors')) {
    if (!config.cors) return error(404, 'NoSuchCORSConfiguration')
    return reply(
      200,
      xml(
        `<CORSConfiguration><CORSRule><AllowedOrigin>${esc(config.cors)}</AllowedOrigin><AllowedMethod>GET</AllowedMethod></CORSRule></CORSConfiguration>`,
      ),
    )
  }
  if (query.has('notification')) return reply(200, xml('<NotificationConfiguration/>'))
  if (query.has('uploads')) {
    return reply(
      200,
      xml(
        `<ListMultipartUploadsResult><Bucket>${esc(bucket)}</Bucket><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>`,
      ),
    )
  }
  if (query.has('versions')) {
    const objects = objectsOf(config)
    const { contents, prefixes, next } = page(objects, query)
    const versions = contents
      .map(
        (o, i) =>
          `<Version><Key>${esc(o.key)}</Key><VersionId>v${i}</VersionId><IsLatest>true</IsLatest><LastModified>${o.modified}</LastModified><Size>${o.size}</Size><StorageClass>${o.storageClass}</StorageClass></Version>` +
          (config.versioning && i % 3 === 0
            ? `<Version><Key>${esc(o.key)}</Key><VersionId>n${i}</VersionId><IsLatest>false</IsLatest><LastModified>${o.modified}</LastModified><Size>${o.size}</Size><StorageClass>${o.storageClass}</StorageClass></Version>`
            : ''),
      )
      .join('')
    return reply(
      200,
      xml(
        `<ListVersionsResult><Name>${esc(bucket)}</Name><IsTruncated>${next ? 'true' : 'false'}</IsTruncated>${next ? `<NextKeyMarker>${next}</NextKeyMarker><NextVersionIdMarker>x</NextVersionIdMarker>` : ''}${versions}${prefixes.map((p) => `<CommonPrefixes><Prefix>${esc(p)}</Prefix></CommonPrefixes>`).join('')}</ListVersionsResult>`,
      ),
    )
  }
  if (query.get('list-type') === '2') {
    const { contents, prefixes, next } = page(objectsOf(config), query)
    return reply(
      200,
      xml(
        `<ListBucketResult><Name>${esc(bucket)}</Name><KeyCount>${contents.length + prefixes.length}</KeyCount><IsTruncated>${next ? 'true' : 'false'}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}` +
          contents
            .map(
              (o) =>
                `<Contents><Key>${esc(o.key)}</Key><Size>${o.size}</Size><LastModified>${o.modified ?? '2026-01-02T00:00:00.000Z'}</LastModified><StorageClass>${o.storageClass ?? 'STANDARD'}</StorageClass></Contents>`,
            )
            .join('') +
          prefixes
            .map((p) => `<CommonPrefixes><Prefix>${esc(p)}</Prefix></CommonPrefixes>`)
            .join('') +
          '</ListBucketResult>',
      ),
    )
  }
  return error(501, 'NotImplemented')
}
