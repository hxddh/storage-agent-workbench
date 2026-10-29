import {
  GetObjectAclCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3'
import type { Table } from '@shared/contract'
import { describe } from '../providers'
import { formatBytes, iso, shortDate, tableText } from '../util'
import {
  agentTool,
  assertInScope,
  bucketParam,
  limitParam,
  providerParam,
  type ToolDeps,
  Type,
} from './policy'

export function bucketTools(deps: ToolDeps) {
  return [
    agentTool(deps, {
      name: 'buckets',
      description: 'List the buckets this account can see, with creation dates.',
      parameters: Type.Object({ provider_id: providerParam }),
      timeoutMs: 30_000,
      target: () => 'account',
      run: async (args, run) => {
        const { config, client } = await run.provider(args.provider_id)
        const response = await client.send(new ListBucketsCommand({}), { abortSignal: run.signal })
        const buckets = (response.Buckets ?? []).filter(
          (bucket) =>
            bucket.Name &&
            (config.scope.buckets.length === 0 || config.scope.buckets.includes(bucket.Name)),
        )
        const rows = buckets.map((bucket) => [bucket.Name ?? '', shortDate(bucket.CreationDate)])
        return {
          model: `${buckets.length} bucket(s):\n${tableText(['Bucket', 'Created'], rows)}`,
          note: `${buckets.length} bucket${buckets.length === 1 ? '' : 's'}`,
          view: {
            kind: 'buckets' as const,
            rows: { columns: ['Bucket', 'Created'], rows } satisfies Table,
          },
        }
      },
    }),

    agentTool(deps, {
      name: 'objects',
      description:
        'List object keys, object versions, or incomplete multipart uploads in one bucket, one page at a time (up to 1000 rows); pass the returned `next` token to read the following page.',
      parameters: Type.Object({
        provider_id: providerParam,
        bucket: bucketParam,
        prefix: Type.Optional(Type.String({ description: 'Key prefix to list under.' })),
        kind: Type.Optional(
          Type.Union([Type.Literal('keys'), Type.Literal('versions'), Type.Literal('uploads')], {
            description: 'keys (default), versions, or uploads.',
          }),
        ),
        limit: limitParam(1000),
        token: Type.Optional(
          Type.String({
            description: 'The `next` token a previous page returned, to read the page after it.',
          }),
        ),
      }),
      timeoutMs: 60_000,
      target: (args) => args.bucket,
      run: async (args, run) => {
        const { config, client } = await run.provider(args.provider_id)
        assertInScope(config, args.bucket)
        const limit = Math.max(1, Math.min(args.limit ?? 100, 1000))
        const prefix = args.prefix || undefined
        // One opaque token per listing kind: S3's own markers, carried as JSON.
        const marker = (() => {
          try {
            return args.token ? (JSON.parse(args.token) as Record<string, string>) : {}
          } catch {
            throw new Error('The token is not one this tool returned.')
          }
        })()
        const next = (value: Record<string, string | undefined> | null) =>
          value && Object.values(value).some(Boolean) ? JSON.stringify(value) : null
        const more = (token: string | null) => (token ? `\nnext: ${token}` : '')
        if (args.kind === 'versions') {
          const response = await client.send(
            new ListObjectVersionsCommand({
              Bucket: args.bucket,
              Prefix: prefix,
              MaxKeys: limit,
              KeyMarker: marker.key,
              VersionIdMarker: marker.version,
            }),
            { abortSignal: run.signal },
          )
          const rows = (response.Versions ?? []).map((v) => [
            v.Key ?? '',
            v.VersionId ?? '',
            v.IsLatest ? 'latest' : '',
            formatBytes(v.Size),
            shortDate(v.LastModified),
          ])
          const token = response.IsTruncated
            ? next({ key: response.NextKeyMarker, version: response.NextVersionIdMarker })
            : null
          return {
            model: `${rows.length} version(s) in ${args.bucket}${prefix ? ` under ${prefix}` : ''}${
              response.IsTruncated ? ' (more exist)' : ''
            }:\n${tableText(['Key', 'Version', 'Latest', 'Size', 'Modified'], rows)}${more(token)}`,
            note: `${rows.length} version${rows.length === 1 ? '' : 's'}`,
            view: {
              kind: 'objects' as const,
              rows: {
                columns: ['Key', 'Version', '', 'Size', 'Modified'],
                rows,
                truncated: Boolean(response.IsTruncated),
              } satisfies Table,
            },
          }
        }
        if (args.kind === 'uploads') {
          const response = await client.send(
            new ListMultipartUploadsCommand({
              Bucket: args.bucket,
              Prefix: prefix,
              MaxUploads: limit,
              KeyMarker: marker.key,
              UploadIdMarker: marker.upload,
            }),
            { abortSignal: run.signal },
          )
          const rows = (response.Uploads ?? []).map((u) => [
            u.Key ?? '',
            u.UploadId ?? '',
            u.StorageClass ?? '',
            iso(u.Initiated),
          ])
          const token = response.IsTruncated
            ? next({ key: response.NextKeyMarker, upload: response.NextUploadIdMarker })
            : null
          return {
            model: `${rows.length} incomplete upload(s) in ${args.bucket}${
              response.IsTruncated ? ' (more exist)' : ''
            }:\n${tableText(['Key', 'Upload', 'Class', 'Initiated'], rows)}${more(token)}`,
            note: `${rows.length} upload${rows.length === 1 ? '' : 's'}`,
            view: {
              kind: 'objects' as const,
              rows: {
                columns: ['Key', 'Upload', 'Class', 'Initiated'],
                rows,
                truncated: Boolean(response.IsTruncated),
              } satisfies Table,
            },
          }
        }
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: args.bucket,
            Prefix: prefix,
            MaxKeys: limit,
            ContinuationToken: marker.continuation,
          }),
          { abortSignal: run.signal },
        )
        const token = response.IsTruncated
          ? next({ continuation: response.NextContinuationToken })
          : null
        const rows = (response.Contents ?? []).map((object) => [
          object.Key ?? '',
          formatBytes(object.Size),
          object.StorageClass ?? '',
          shortDate(object.LastModified),
        ])
        return {
          model: `${rows.length} object(s) in ${args.bucket}${prefix ? ` under ${prefix}` : ''}${
            response.IsTruncated ? ' (more exist)' : ''
          }:\n${tableText(['Key', 'Size', 'Class', 'Modified'], rows)}${more(token)}`,
          note: `${rows.length} object${rows.length === 1 ? '' : 's'}`,
          view: {
            kind: 'objects' as const,
            rows: {
              columns: ['Key', 'Size', 'Class', 'Modified'],
              rows,
              truncated: Boolean(response.IsTruncated),
            } satisfies Table,
          },
        }
      },
    }),

    agentTool(deps, {
      name: 'object',
      description:
        'Inspect one object: its metadata, tags, ACL, and a bounded preview of text-like content. Never downloads a large body.',
      parameters: Type.Object({
        provider_id: providerParam,
        bucket: bucketParam,
        key: Type.String({ description: 'Object key.' }),
        aspects: Type.Optional(
          Type.Array(
            Type.Union([
              Type.Literal('head'),
              Type.Literal('tags'),
              Type.Literal('acl'),
              Type.Literal('preview'),
            ]),
            { description: 'Aspects to read; default head.' },
          ),
        ),
      }),
      timeoutMs: 60_000,
      target: (args) => `${args.bucket}/${args.key}`,
      run: async (args, run) => {
        const { config, client } = await run.provider(args.provider_id)
        assertInScope(config, args.bucket)
        const aspects = new Set(args.aspects?.length ? args.aspects : ['head'])
        const facts: [string, string][] = []
        let preview: { language: string; text: string } | null = null
        let contentType = ''
        let size = 0
        try {
          const head = await client.send(
            new HeadObjectCommand({ Bucket: args.bucket, Key: args.key }),
            { abortSignal: run.signal },
          )
          contentType = head.ContentType ?? ''
          size = head.ContentLength ?? 0
          facts.push(['Size', formatBytes(size)])
          facts.push(['Type', contentType || '—'])
          facts.push(['Modified', iso(head.LastModified)])
          facts.push(['ETag', (head.ETag ?? '').replaceAll('"', '')])
          facts.push(['Storage class', head.StorageClass ?? 'STANDARD'])
          if (head.ServerSideEncryption) facts.push(['Encryption', head.ServerSideEncryption])
          if (head.VersionId) facts.push(['Version', head.VersionId])
          const metadata = Object.entries(head.Metadata ?? {})
          // Metadata names only: values can hold anything the uploader put there.
          if (metadata.length) facts.push(['Metadata', metadata.map(([k]) => k).join(', ')])
        } catch (error) {
          throw new Error(describe(error))
        }
        if (aspects.has('tags')) {
          try {
            const tags = await client.send(
              new GetObjectTaggingCommand({ Bucket: args.bucket, Key: args.key }),
              { abortSignal: run.signal },
            )
            facts.push([
              'Tags',
              (tags.TagSet ?? []).map((tag) => `${tag.Key}=${tag.Value}`).join(', ') || '—',
            ])
          } catch {
            facts.push(['Tags', 'not readable'])
          }
        }
        if (aspects.has('acl')) {
          try {
            const acl = await client.send(
              new GetObjectAclCommand({ Bucket: args.bucket, Key: args.key }),
              { abortSignal: run.signal },
            )
            facts.push([
              'Grants',
              (acl.Grants ?? [])
                .map((grant) =>
                  `${grant.Grantee?.Type ?? '?'}:${grant.Grantee?.URI ?? grant.Grantee?.ID ?? '?'} ${grant.Permission ?? ''}`.trim(),
                )
                .join(', ') || '—',
            ])
          } catch {
            facts.push(['Grants', 'not readable'])
          }
        }
        if (aspects.has('preview') && size > 0) {
          // The first 8 KiB, whatever the object's size or declared type: a text
          // file labelled octet-stream is still text. Bytes that are not text are
          // said to be binary rather than shown.
          try {
            const object = await client.send(
              new GetObjectCommand({ Bucket: args.bucket, Key: args.key, Range: 'bytes=0-8191' }),
              { abortSignal: run.signal },
            )
            const bytes = await object.Body?.transformToByteArray()
            if (bytes?.length) {
              const body = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
              const odd = [...body].filter(
                (char) => char === '\uFFFD' || (char < ' ' && !'\n\r\t'.includes(char)),
              ).length
              if (bytes.includes(0) || odd > body.length * 0.05)
                facts.push(['Preview', 'binary content, not shown'])
              else
                preview = {
                  language: contentType.includes('json')
                    ? 'json'
                    : contentType.includes('xml')
                      ? 'xml'
                      : contentType.includes('csv')
                        ? 'csv'
                        : 'text',
                  text: body,
                }
            }
          } catch {
            facts.push(['Preview', 'not readable'])
          }
        }
        return {
          model: `${args.bucket}/${args.key}: ${facts.map(([k, v]) => `${k}=${v}`).join('; ')}${
            preview ? `\nFirst ${preview.text.length} characters of the body:\n${preview.text}` : ''
          }`,
          note: formatBytes(size),
          view: { kind: 'object' as const, facts, preview },
        }
      },
    }),
  ]
}
