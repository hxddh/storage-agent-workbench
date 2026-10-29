/**
 * A fake OpenAI-compatible chat endpoint for local end-to-end runs. It works
 * like an agent with one call per round: it lists the buckets with `call`,
 * reads what it needs of each, and writes its answer from what came back.
 *
 *   node scripts/fake-model.mjs 9200
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 9200)

const call = (id, name, args) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
})

/** The reads of one bucket that say whether it is public. */
const ACCESS = ['GetBucketPolicyStatus', 'GetBucketAcl']

function plan(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
    .join('\n')
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user')
  const lastUser = messages[lastUserIndex]
  // Calls of the current turn only: a task can hold several turns.
  const turn = messages.slice(lastUserIndex + 1)
  const ask = String(
    typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? ''),
  ).toLowerCase()

  /** Every call of this turn, with its arguments and what it returned. */
  const calls = []
  for (const message of turn) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls))
      for (const item of message.tool_calls) {
        let args = {}
        try {
          args = JSON.parse(item.function?.arguments || '{}')
        } catch {}
        calls.push({ id: item.id, name: item.function?.name, args, text: '' })
      }
    if (message.role === 'tool') {
      const found = calls.find((item) => item.id === message.tool_call_id)
      if (found)
        found.text =
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')
    }
  }
  const made = (name) => calls.filter((item) => item.name === name)
  const reads = (operation, bucket) =>
    made('call').filter(
      (item) => item.args.operation === operation && (!bucket || item.args.input?.Bucket === bucket),
    )
  const evidence = (item) => /evidence="([^"]+)"/.exec(item?.text ?? '')?.[1] ?? ''
  const cite = (item) => (evidence(item) ? ` [1](#ev-${evidence(item)})` : '')
  const n = calls.length
  const next = (name, args) => ({ tool: call(`call_${name}_${n + 1}`, name, args) })
  const s3 = (operation, input) => next('call', { service: 's3', operation, ...(input ? { input } : {}) })

  if (ask.includes('clarify') && !made('ask').length)
    return next('ask', {
      question: 'Which account should I read?',
      options: ['Staging', 'Production'],
      note: 'The scope changes the evidence.',
    })

  // A provider reasoning summary arrives with the first call of a turn.
  const reasoning =
    n === 0 && ask.includes('public')
      ? 'List the buckets, then read each one’s policy status and ACL.'
      : null
  const first = (result) => (reasoning ? { reasoning, ...result } : result)

  // Memory is a tool, not prompt content; the agent asks for it.
  if (ask.includes('last time') || ask.includes('what did you find')) {
    const memory = made('memory').at(-1)
    if (!memory) return next('memory', { action: 'get', key: 'survey/last' })
    const open = memory.text.indexOf('>')
    const close = memory.text.lastIndexOf('</untrusted-data>')
    const raw = (open >= 0 && close > open ? memory.text.slice(open + 1, close) : memory.text).trim()
    let value = {}
    try {
      value = JSON.parse(raw)
    } catch {}
    const publicName = Array.isArray(value.public) ? value.public[0] : value.public
    return {
      text: publicName
        ? `I noted earlier: \`${publicName}\` was public at the last check.${cite(memory)}`
        : 'I have no notes from an earlier check.',
    }
  }

  // A view the agent composed itself.
  if (ask.includes('show') && (ask.includes('view') || ask.includes('table'))) {
    const listing = reads('ListBuckets')[0]
    if (!listing) return first(s3('ListBuckets'))
    const names = [...listing.text.matchAll(/"Name": "([^"]+)"/g)].map((match) => match[1])
    const view = made('render')[0]
    if (!view)
      return next('render', {
        title: 'Buckets',
        doc: {
          version: 1,
          blocks: [
            {
              type: 'section',
              title: 'Buckets',
              blocks: [
                {
                  type: 'table',
                  columns: [{ key: 'name', label: 'Bucket' }],
                  rows: names.map((name) => ({ name })),
                },
              ],
            },
          ],
        },
      })
    return { text: `I rendered the buckets I read.${cite(view)}` }
  }


  // A chart with two series, to exercise the renderer's series split.
  if (ask.includes('compare accounts over time') || ask.includes('chart series')) {
    const view = made('render')[0]
    if (!view)
      return next('render', {
        title: 'Account trend',
        doc: {
          version: 1,
          blocks: [
            {
              type: 'chart',
              spec: {
                mark: 'line',
                x: 'day',
                y: 'objects',
                series: 'account',
                xLabel: 'Day',
                yLabel: 'Objects',
                data: [
                  { day: 'Mon', objects: 120, account: 'Prod' },
                  { day: 'Tue', objects: 180, account: 'Prod' },
                  { day: 'Wed', objects: 210, account: 'Prod' },
                  { day: 'Mon', objects: 80, account: 'Staging' },
                  { day: 'Tue', objects: 95, account: 'Staging' },
                  { day: 'Wed', objects: 140, account: 'Staging' },
                ],
              },
            },
          ],
        },
      })
    return { text: `The chart keeps the two accounts separate.${cite(view)}` }
  }

  // A method the agent writes and reuses.
  if (ask.includes('method') || ask.includes('reuse')) {
    const save = made('tool').find((item) => item.args.action === 'save')
    if (!save)
      return next('tool', {
        action: 'save',
        name: 'bucket_names',
        description: 'List the buckets this account can see.',
        schema: { type: 'object', additionalProperties: false },
        code: 'const p = await tools.call({ service: "s3", operation: "ListBuckets" }); return (p.Buckets ?? []).map((b) => ({ name: b.Name }))',
        scope: 'user',
      })
    const run = made('tool').find((item) => item.args.action === 'run')
    if (!run) return next('tool', { action: 'run', name: 'bucket_names', args: {} })
    return { text: `The method returned the buckets I read.${cite(run)}` }
  }

  // A child agent for an independent investigation.
  if (ask.includes('delegate')) {
    const child = made('delegate')[0]
    if (!child) return next('delegate', { task: 'Survey my account.', title: 'Bucket survey' })
    return { text: `The child agent answered.${cite(child)}` }
  }

  const bucketArg = /`?([a-z0-9][a-z0-9.-]*-[a-z0-9.-]+)`?/.exec(ask.replace(/^.*?(for|on|of|read|in|check) /, ''))?.[1]

  if (ask.includes('largest')) {
    const query = made('query')[0]
    const bucket = bucketArg ?? 'web-assets'
    if (!query)
      return first(
        next('query', {
          title: `Largest prefixes in ${bucket}`,
          code: `const sizes = {}; let token; do { const page = await tools.call({ service: 's3', operation: 'ListObjectsV2', input: { Bucket: '${bucket}', ContinuationToken: token } }); for (const o of page.Contents ?? []) { const p = o.Key.split('/')[0] + '/'; sizes[p] = (sizes[p] ?? 0) + o.Size } token = page.NextContinuationToken } while (token); return Object.entries(sizes).sort((a, b) => b[1] - a[1]).map(([prefix, bytes]) => ({ prefix, bytes }))`,
        }),
      )
    const top = /\n([^\t\n]+\/)\t\d+/.exec(query.text)?.[1] ?? 'no prefix'
    return { text: `\`${top}\` holds the most bytes in \`${bucket}\`.${cite(query)}` }
  }

  // A named bucket: read what the question needs of it, then answer.
  const named = bucketArg && !ask.includes('public?') ? bucketArg : null
  if (named && (ask.includes('who can read') || ask.includes('applied') || ask.includes('fix') || ask.includes('change plan') || ask.includes('again'))) {
    const operation = ask.includes('who can read')
      ? 'GetBucketPolicy'
      : ask.includes('fix') || ask.includes('change plan')
        ? 'GetBucketLifecycleConfiguration'
        : 'GetBucketPolicyStatus'
    const read = reads(operation, named)[0]
    if (!read) return first(s3(operation, { Bucket: named }))
    if (ask.includes('who can read'))
      return {
        text: /"Principal": "\*"/.test(read.text)
          ? `The bucket policy grants anonymous read on \`${named}\`.${cite(read)}`
          : `Nothing in the policy of \`${named}\` grants anonymous read.${cite(read)}`,
      }
    if (ask.includes('applied'))
      return {
        text: /"IsPublic": true/.test(read.text)
          ? `\`${named}\` is still public.${cite(read)}`
          : `\`${named}\` is no longer public.${cite(read)}`,
      }
    if (ask.includes('fix') || ask.includes('change plan'))
      return {
        text: `To abort incomplete multipart uploads on \`${named}\`, keep its current rules and add one:${cite(read)}\n\n\`\`\`sh\naws s3api put-bucket-lifecycle-configuration --bucket ${named} --lifecycle-configuration file://lifecycle.json\n\`\`\`\n\nThis adds an abort rule; I have not applied it.`,
      }
  }

  // Everything else: list the buckets, read each one's access, then say what was read.
  const listing = reads('ListBuckets')[0]
  if (!listing) return first(s3('ListBuckets'))
  const names = [...listing.text.matchAll(/"Name": "([^"]+)"/g)].map((match) => match[1])
  if (ask.includes('ghost'))
    return {
      text: `No read returned a bucket named ghost-bucket, so I cannot say anything about it. This account holds ${names.map((name) => `\`${name}\``).join(', ')}.${cite(listing)}`,
    }
  for (const name of names)
    for (const operation of ACCESS)
      if (!reads(operation, name).length) return s3(operation, { Bucket: name })
  const open = names.filter((name) =>
    ACCESS.some((operation) =>
      reads(operation, name).some((item) => /"IsPublic": true|AllUsers/.test(item.text)),
    ),
  )
  const denied = names.filter((name) =>
    ACCESS.some((operation) => reads(operation, name).some((item) => /AccessDenied/.test(item.text))),
  )
  const proof = (name) => reads('GetBucketPolicyStatus', name)[0] ?? reads('GetBucketAcl', name)[0]
  const publicText = open.length
    ? `${open.map((name) => `\`${name}\``).join(', ')} ${open.length === 1 ? 'is' : 'are'} public${cite(proof(open[0]))}.`
    : 'No bucket policy status or ACL I read makes a bucket public.'
  const deniedText = denied.length
    ? ` I could not read every part of ${denied.map((name) => `\`${name}\``).join(', ')} (access denied), so that bucket is not fully checked.`
    : ''
  if (open.length && !made('memory').length && (ask.includes('survey') || ask.includes('check')))
    return next('memory', {
      action: 'put',
      key: 'survey/last',
      value: { public: open, checkedAt: new Date().toISOString() },
      text: `${open.join(', ')} public at last check.`,
      tags: ['survey'],
    })
  return { text: `${publicText}${deniedText}` }
}

function chunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url?.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
    return
  }
  if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
    return
  }
  let raw = ''
  req.on('data', (data) => {
    raw += data
  })
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {
      body = {}
    }
    const next = plan(body)
    const base = {
      id: 'chatcmpl-fake',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? 'fake',
    }

    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          created: base.created,
          model: base.model,
          choices: [
            {
              index: 0,
              finish_reason: next.tool ? 'tool_calls' : 'stop',
              message: {
                role: 'assistant',
                content: next.tool ? null : (next.text ?? null),
                ...(next.reasoning ? { reasoning_content: next.reasoning } : {}),
                ...(next.tool ? { tool_calls: [next.tool] } : {}),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      )
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    chunk(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
    if (next.reasoning) {
      chunk(res, {
        ...base,
        choices: [{ index: 0, delta: { reasoning_content: next.reasoning }, finish_reason: null }],
      })
    }
    if (next.tool) {
      chunk(res, {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: next.tool.id,
                  type: 'function',
                  function: { name: next.tool.function.name, arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })
      chunk(res, {
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: next.tool.function.arguments } }] },
            finish_reason: null,
          },
        ],
      })
      chunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    } else {
      for (const word of (next.text ?? '').split(' ').filter(Boolean)) {
        chunk(res, { ...base, choices: [{ index: 0, delta: { content: `${word} ` }, finish_reason: null }] })
      }
      chunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`fake-model listening on ${port}`)
})
