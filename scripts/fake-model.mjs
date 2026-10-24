/**
 * A fake OpenAI-compatible chat endpoint for local end-to-end runs.
 * It calls survey, then config on the public bucket, then answers.
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

function plan(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user')
  const lastUser = messages[lastUserIndex]
  // Tool results of the current turn only: a task can hold several turns.
  const toolMessages = messages.slice(lastUserIndex + 1).filter((message) => message.role === 'tool')
  const ask = String(lastUser?.content ?? '').toLowerCase()
  if (ask.includes('no tool result in this task shows')) console.log('GROUNDING_CORRECTION')
  if (toolMessages.length === 0) {
    if (ask.includes('applied')) {
      return { tool: call('call_verify_1', 'survey', { buckets: ['demo-public'] }) }
    }
    if (ask.includes('who can read')) {
      return { tool: call('call_access_1', 'config', { bucket: 'demo-public', aspect: 'access' }) }
    }
    if (ask.includes('largest')) {
      return {
        tool: call('call_query_1', 'query', {
          title: 'Largest prefixes in demo-public',
          code: "const sizes = {}; let token = null; do { const page = await tools.list({ bucket: 'demo-public', token }); for (const o of page.items) { const p = o.key.split('/')[0] + '/'; sizes[p] = (sizes[p] ?? 0) + o.size } token = page.next } while (token); return Object.entries(sizes).map(([prefix, bytes]) => ({ prefix, bytes }))",
        }),
      }
    }
    if (ask.includes('fix')) {
      return { tool: call('call_fix_1', 'fix', { bucket: 'demo-private', code: 'no_abort_mpu' }) }
    }
    if (ask.includes('issue')) {
      return { tool: call('call_estate_1', 'estate', {}) }
    }
    return { tool: call('call_survey_1', 'survey', {}) }
  }
  if (
    toolMessages.length === 1 &&
    ask.includes('public') &&
    !ask.includes('who can read') &&
    !ask.includes('fix') &&
    !ask.includes('issue') &&
    !ask.includes('largest')
  ) {
    return { tool: call('call_config_1', 'config', { bucket: 'demo-public', aspect: 'security' }) }
  }
  if (ask.includes('applied')) {
    return { text: '`demo-public` is no longer public; the fix took.' }
  }
  if (ask.includes('who can read')) {
    return { text: 'The public bucket policy is the anonymous grant on `demo-public`.' }
  }
  if (ask.includes('largest')) {
    return { text: '`reports/` holds everything in `demo-public`.' }
  }
  if (ask.includes('fix')) {
    return { text: 'Add an abort rule for incomplete uploads on `demo-private`.' }
  }
  if (ask.includes('issue')) {
    return {
      text:
        'Five issues are open: `demo-public` is public, has no default encryption and no public access block; both buckets never clean up incomplete uploads.',
    }
  }
  // The harness asks once for a correction when the verdict names something no tool returned.
  if (ask.includes('ghost')) {
    return { text: '`demo-public` is public and so is `ghost-bucket`.' }
  }
  return {
    text:
      '`demo-public` is publicly accessible and has no default encryption. `demo-private` is not public, is encrypted, and blocks public access.',
  }
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
              message: next.tool
                ? { role: 'assistant', content: null, tool_calls: [next.tool] }
                : { role: 'assistant', content: next.text },
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
      for (const word of next.text.split(' ')) {
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
