/**
 * A fake OpenAI-compatible chat endpoint for local end-to-end runs. It works
 * like an agent with one call per round: it lists the buckets, reads each
 * configuration it needs, and writes its answer from what the reads returned.
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

const ACCESS = ['policy', 'policy_status', 'acl', 'public_access_block']

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
  const evidence = (item) => /evidence="([^"]+)"/.exec(item?.text ?? '')?.[1] ?? ''
  const cite = (item) => (evidence(item) ? ` [1](#ev-${evidence(item)})` : '')
  const n = calls.length
  const next = (name, args) => ({ tool: call(`call_${name}_${n + 1}`, name, args) })

  if (ask.includes('clarify') && !made('ask').length)
    return next('ask', {
      question: 'Which account should I read?',
      options: ['Staging', 'Production'],
      note: 'The scope changes the evidence.',
    })

  // A provider reasoning summary arrives with the first call of a turn.
  const reasoning =
    n === 0 && ask.includes('public')
      ? 'List the buckets, then read each one’s policy status, ACL and public access block.'
      : null
  const first = (result) => (reasoning ? { reasoning, ...result } : result)

  // Memory is the notes in the prompt; the agent answers from them.
  if (ask.includes('last time') || ask.includes('what did you find')) {
    const notes = (/Notes \([^)]*\): (.*)/.exec(system)?.[1] ?? '').split(' | ')
    const note = notes.find((text) => text.includes('public'))?.replace(/\.+$/, '')
    return { text: note ? `I noted earlier: ${note}.` : 'I have no notes from an earlier check.' }
  }

  const bucketArg = /`?([a-z0-9][a-z0-9.-]*-[a-z0-9.-]+)`?/.exec(ask.replace(/^.*?(for|on|of|read|in|check) /, ''))?.[1]

  if (ask.includes('largest')) {
    const query = made('query')[0]
    if (!query)
      return first(
        next('query', {
          title: `Largest prefixes in ${bucketArg ?? 'web-assets'}`,
          code: `const sizes = {}; let token = null; do { const page = await tools.list({ bucket: '${bucketArg ?? 'web-assets'}', token }); for (const o of page.items) { const p = o.key.split('/')[0] + '/'; sizes[p] = (sizes[p] ?? 0) + o.size } token = page.next } while (token); return Object.entries(sizes).sort((a, b) => b[1] - a[1]).map(([prefix, bytes]) => ({ prefix, bytes }))`,
        }),
      )
    const top = /"prefix":\s*"([^"]+)"/.exec(query.text)?.[1] ?? 'no prefix'
    return { text: `\`${top}\` holds the most bytes in \`${bucketArg ?? 'web-assets'}\`.${cite(query)}` }
  }

  // A named bucket: read what the question needs of it, then answer.
  const named = bucketArg && !ask.includes('public?') ? bucketArg : null
  if (named && (ask.includes('who can read') || ask.includes('applied') || ask.includes('fix') || ask.includes('change plan') || ask.includes('again'))) {
    const sections = ask.includes('fix') || ask.includes('change plan') ? ['lifecycle'] : ACCESS
    const read = made('config').find((item) => item.args.bucket === named)
    if (!read) return first(next('config', { bucket: named, sections }))
    if (ask.includes('who can read'))
      return {
        text: /"Principal": "\*"/.test(read.text)
          ? `The bucket policy grants anonymous read on \`${named}\`.${cite(read)}`
          : `Nothing in the policy or ACL of \`${named}\` grants anonymous read.${cite(read)}`,
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
  const listing = made('buckets')[0]
  if (!listing) return first(next('buckets', {}))
  const names = listing.text
    .split('\n')
    .map((line) => line.split('\t')[0]?.trim())
    .filter((name) => name && /^[a-z0-9][a-z0-9.-]+$/.test(name) && name !== 'bucket')
  if (ask.includes('ghost'))
    return {
      text: `No read returned a bucket named ghost-bucket, so I cannot say anything about it. This account holds ${names.map((name) => `\`${name}\``).join(', ')}.${cite(listing)}`,
    }
  const unread = names.find((name) => !made('config').some((item) => item.args.bucket === name))
  if (unread) return next('config', { bucket: unread, sections: ACCESS })
  const reads = made('config')
  const open = reads.filter((item) => /"IsPublic": true/.test(item.text) || /AllUsers/.test(item.text))
  const denied = reads.filter((item) => /"status": "access_denied"/.test(item.text))
  const publicText = open.length
    ? `${open.map((item) => `\`${item.args.bucket}\``).join(', ')} ${open.length === 1 ? 'is' : 'are'} public${cite(open[0])}.`
    : 'No bucket policy status or ACL I read makes a bucket public.'
  const deniedText = denied.length
    ? ` I could not read every section of ${denied.map((item) => `\`${item.args.bucket}\``).join(', ')} (access denied), so that bucket is not fully checked.`
    : ''
  if (open.length && !made('note').length && (ask.includes('survey') || ask.includes('check')))
    return next('note', { text: `${open.map((item) => item.args.bucket).join(', ')} public at last check.` })
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
