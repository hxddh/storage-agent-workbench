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
  const turn = messages.slice(lastUserIndex + 1)
  const toolMessages = turn.filter((message) => message.role === 'tool')
  const ask = String(lastUser?.content ?? '').toLowerCase()

  const names = new Map()
  for (const message of turn) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls) {
      if (call?.id && call?.function?.name) names.set(call.id, call.function.name)
    }
  }
  const called = new Set(names.values())
  let planCalls = 0
  for (const message of turn) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls) if (call?.function?.name === 'plan') planCalls += 1
  }
  const output = new Map()
  for (const message of toolMessages) {
    const name = names.get(message.tool_call_id)
    if (!name) continue
    output.set(
      name,
      typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content ?? ''),
    )
  }
  const toolText = [...output.values()].join('\n')
  const surveyText = [...output.entries()]
    .filter(([name]) => name === 'survey')
    .map(([, text]) => text)
    .join('\n')
  const publicBucket =
    (/(?:^|\n)Public:\s*([A-Za-z0-9._-]+)/.exec(surveyText)?.[1] ?? '').replace(
      /[.,]+$/,
      '',
    ) || null
  const evidence = (name) => {
    const text = output.get(name) ?? ''
    return /evidence="([^"]+)"/.exec(text)?.[1] ?? ''
  }

  // The harness asks once when the answer names something no read returned.
  if (/no tool result in this task shows|which no tool result/i.test(ask)) {
    console.log('GROUNDING_CORRECTION')
    return { text: 'The readings do not show that name.' }
  }

  if (ask.includes('clarify') && !called.has('ask')) {
    return {
      tool: call('call_ask_1', 'ask', {
        question: 'Which account should I read?',
        options: ['Demo', 'Production'],
        note: 'The scope changes the evidence.',
      }),
    }
  }

  if (ask.includes('access method') && !called.has('skill')) {
    return { tool: call('call_skill_1', 'skill', { name: 'access' }) }
  }

  if (!called.has('plan')) {
    const reasoning = ask.includes('public')
      ? 'Read the account-wide public access block first, then inspect each bucket policy.'
      : ask.includes('change plan')
        ? 'Find the open finding, keep the existing lifecycle configuration intact, and prepare one user-applied text.'
        : ask.includes('issue')
          ? 'Read remembered posture and current open findings before choosing the five most useful risks.'
          : null
    return {
      ...(reasoning ? { reasoning } : {}),
      tool: call('call_plan_1', 'plan', {
        note: 'Plan the read before spending a call.',
        steps: [
          { title: 'Recall the estate', status: 'done' },
          { title: 'Read the account', status: 'active' },
          { title: 'Compose the answer', status: 'pending' },
        ],
      }),
    }
  }

  if (
    !called.has('survey') &&
    !called.has('estate') &&
    !called.has('config') &&
    !called.has('query') &&
    !called.has('change_plan')
  ) {
    if (ask.includes('applied')) {
      return { tool: call('call_survey_1', 'survey', { buckets: ['demo-public'] }) }
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
    if (ask.includes('fix') || ask.includes('change plan')) {
      return { tool: call('call_change_1', 'change_plan', { bucket: 'demo-private', code: 'no_abort_mpu' }) }
    }
    if (ask.includes('history') || ask.includes('changed')) {
      return { tool: call('call_history_1', 'estate', { history: true }) }
    }
    if (ask.includes('issue')) {
      return { tool: call('call_estate_1', 'estate', {}) }
    }
    return { tool: call('call_survey_1', 'survey', {}) }
  }

  if (
    called.has('survey') &&
    !called.has('config') &&
    ask.includes('public') &&
    !ask.includes('who can read') &&
    !ask.includes('fix') &&
    !ask.includes('issue') &&
    !ask.includes('largest')
  ) {
    return {
      tool: call('call_config_1', 'config', {
        bucket: publicBucket ?? 'demo-public',
        aspect: 'security',
      }),
    }
  }


  if (planCalls === 1) {
    return {
      tool: call('call_plan_2', 'plan', {
        note: 'The reads are in; compose next.',
        steps: [
          { title: 'Recall the estate', status: 'done' },
          { title: 'Read the account', status: 'done' },
          { title: 'Compose the answer', status: 'active' },
        ],
      }),
    }
  }

  let text = 'Only `demo-public` is public. `demo-private` is private and blocks public access.'
  let source = 'survey'
  if (ask.includes('applied')) {
    text = '`demo-public` is no longer public.'
    source = 'survey'
  } else if (ask.includes('who can read')) {
    text = 'The public bucket policy is the anonymous grant on `demo-public`.'
    source = 'config'
  } else if (ask.includes('largest')) {
    text = '`reports/` holds everything in `demo-public`.'
    source = 'query'
  } else if (ask.includes('fix') || ask.includes('change plan')) {
    text = 'Add an abort rule for incomplete uploads on `demo-private`.'
    source = 'change_plan'
  } else if (ask.includes('history') || ask.includes('changed')) {
    text = 'The history records open risks on `demo-public` and `demo-private`.'
    source = 'estate'
  } else if (ask.includes('issue')) {
    text = '8 risks are open; the highest severity is public exposure on `demo-public`.'
    source = 'estate'
  } else if (ask.includes('ghost')) {
    text = '`demo-public` is public and so is `ghost-bucket`.'
    source = 'survey'
  } else if (publicBucket && publicBucket !== 'demo-public') {
    text = `\`${publicBucket}\` is publicly accessible.`
    source = 'survey'
  }
  const id = evidence(source)
  if (id) text += ` [1](#ev-${id})`
  return { text }

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
