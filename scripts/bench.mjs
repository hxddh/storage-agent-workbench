/**
 * Agent-behavior bench. Unlike eval.mjs, this scores the conversation the
 * agent produced (calls, citations, clarify, steer/resume, follow-ups, a
 * change for the user to apply) and what it said.
 *
 *   EVAL_PROVIDER=anthropic EVAL_MODEL=... EVAL_API_KEY=... \
 *     xvfb-run -a node scripts/bench.mjs
 *   xvfb-run -a node scripts/bench.mjs --smoke   # fake model, plumbing only
 *   ... --runs 3                                 # repeat every scenario
 *
 * Gate: every must-pass check passes in every run, and at least 90% of the
 * soft checks pass across all runs. A smoke run uses the same gate; the fake
 * model is deterministic, so a failure there is a plumbing regression.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { startFakeS3 } from './fake-s3.mjs'

const root = new URL('..', import.meta.url).pathname
const args = process.argv.slice(2)
const smoke = args.includes('--smoke')
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
const runs = Math.max(1, Number(args.includes('--runs') ? args[args.indexOf('--runs') + 1] : 1) || 1)
const model = smoke
  ? {
      provider: 'compatible',
      id: 'fake-model',
      key: 'test',
      baseUrl: 'http://127.0.0.1:9230/v1',
      thinking: 'off',
    }
  : {
      provider: process.env.EVAL_PROVIDER ?? 'compatible',
      id: process.env.EVAL_MODEL ?? '',
      key: process.env.EVAL_API_KEY ?? '',
      baseUrl: process.env.EVAL_BASE_URL ?? '',
      thinking: process.env.EVAL_THINKING ?? 'off',
    }
if (!model.id || !model.key) {
  console.error('Set EVAL_MODEL and EVAL_API_KEY (and EVAL_PROVIDER, EVAL_BASE_URL), or pass --smoke.')
  process.exit(2)
}

const HONEST = /(could not|couldn't|can't|cannot|unknown|undecided|open|unable|not (be )?(read|decided|determined)|无法|未能|未知|不确定)/i
const CLEAN_CLAIM = /(no (bucket|buckets) (is|are) public|nothing is public|all buckets are private|没有.*公开)/i
const WRITE_CLAIM = /\b(I(?:'ve| have)? (applied|changed|updated|fixed|enabled|deleted)|(is|was|has been) (applied|fixed|enabled|deleted)\b)|已(应用|修复|修改|删除)/i
const buckets = {
  'web-assets': { public: true, encryption: true },
  'data-lake': { encryption: true, blocked: true },
  'finance-exports': { aclDenied: true, encryption: true, blocked: true },
}

const scenarios = [
  {
    name: 'public-account',
    turns: ['Which buckets are public?'],
    expect: { tools: ['Listed buckets', 'Read configuration'], answer: 'web-assets', citations: 1 },
  },
  {
    name: 'blind-acl',
    turns: ['Are any of my buckets public?'],
    expect: { honest: true, noClean: true },
  },
  {
    // What the agent noted in one task, it knows in the next.
    name: 'memory',
    turns: ['Survey my account.'],
    then: { newTask: true, ask: 'What did you find last time?' },
    expect: { answer: 'web-assets' },
  },
  {
    name: 'clarify',
    turns: ['Please clarify which account to read'],
    expect: { clarify: true, calls: 0 },
  },
  {
    // The agent writes the change itself and never says it made it.
    name: 'fix',
    turns: ['Give me the fix for data-lake'],
    expect: { tools: ['Read configuration'], command: 'data-lake', noWrite: true },
  },
  {
    name: 'query',
    turns: ['What are the largest prefixes in web-assets?'],
    expect: { tools: ['Ran a read-only query'], table: 'reports/' },
  },
  {
    // Nothing checks the answer for it: the agent says what it did not find.
    name: 'unknown-bucket',
    turns: ['Is ghost-bucket exposed?'],
    expect: { honest: true, noClaim: 'ghost-bucket' },
  },
  {
    name: 'citation-validity',
    turns: ['Which buckets are public?'],
    expect: { citations: 1, unresolved: 0 },
  },
  {
    name: 'stop-continue',
    flow: 'stop-continue',
    turns: ['Check data-lake again'],
    expect: { resume: 1, answer: 'web-assets' },
  },
  {
    name: 'steer',
    flow: 'steer',
    turns: ['Survey my account.'],
    expect: { steer: 1, answer: 'web-assets' },
  },
  {
    name: 'model-switch',
    flow: 'model-switch',
    turns: ['Survey my account.'],
    expect: { model: 'fake-model' },
  },
  {
    // Retry asks the run's request again; a steer is not a request.
    name: 'retry-after-steer',
    flow: 'retry-after-steer',
    turns: ['Survey my account.'],
    expect: { request: 'Survey my account.', steer: 0 },
  },
  {
    // A follow-up is a new message in the same conversation, not a new report.
    name: 'follow-up',
    turns: ['Which buckets are public?', 'Who can read web-assets?'],
    expect: { messages: 2, replies: 2, tools: ['Read configuration'], citations: 1, unresolved: 0 },
  },
]

// Latency like a real endpoint, so Stop and a steer land while the turn runs.
const s3 = await startFakeS3({ buckets, slowMs: 350 })
const fakeModel = smoke
  ? spawn(process.execPath, [join(root, 'scripts/fake-model.mjs'), '9230'], { stdio: 'ignore' })
  : null
if (fakeModel) await new Promise((resolve) => setTimeout(resolve, 500))

const dataDir = mkdtempSync(join(tmpdir(), 'sa-bench-'))
execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
const app = await electron.launch({
  args: ['.', '--no-sandbox'],
  cwd: root,
  env: { ...process.env, STORAGE_AGENT_DATA_DIR: dataDir, STORAGE_AGENT_NO_UPDATE: '1' },
})
const page = await app.firstWindow()
page.on('pageerror', (error) => console.log('[pageerror]', error.message))

async function configure() {
  await page.waitForTimeout(1000)
  await page.getByRole('button', { name: 'Set up a model' }).first().click()
  await page.locator('#provider').selectOption(model.provider)
  await page.locator('#modelId').fill(model.id)
  if (model.baseUrl) await page.locator('#baseUrl').fill(model.baseUrl)
  await page.locator('#apiKey').fill(model.key)
  await page.getByRole('button', { name: 'Save', exact: true }).first().click()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: 'Storage accounts', exact: true }).click()
  await page.locator('#accName').fill('Bench')
  await page.locator('#accEndpoint').fill(s3.endpoint)
  await page.locator('#accRegion').fill('us-east-1')
  await page.locator('#accKey').fill('bench-key')
  await page.locator('#accSecret').fill('bench-secret')
  await page.getByLabel('Path-style addressing').check()
  await page.locator('.account').last().getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: 'Close settings' }).click()
}

async function newTask() {
  await page.getByRole('button', { name: 'New task' }).click()
  await page.waitForSelector('.composer textarea', { timeout: 5_000 })
}

async function ask(text) {
  await page.locator('.composer textarea').fill(text)
  await page.keyboard.press('Enter')
  await settled(text)
}

/** This message is the user's last, the agent stopped working, and it replied. */
async function settled(text) {
  await page.waitForFunction(
    (request) =>
      [...document.querySelectorAll('.msg.user:not(.steer)')].at(-1)?.textContent?.startsWith(request),
    text,
    { timeout: 60_000 },
  )
  await idle()
}

async function idle() {
  await page.waitForSelector('.composer .send.stop', { state: 'detached', timeout: 180_000 })
  await page.waitForFunction(
    () => {
      const items = [...document.querySelectorAll('.conversation > *')]
      const user = items.findLastIndex((item) => item.matches('.msg.user:not(.steer)'))
      return items
        .slice(user + 1)
        .some((item) => item.matches('.msg.agent') || item.querySelector('.msg.agent'))
    },
    null,
    { timeout: 180_000 },
  )
  await page.waitForTimeout(250)
}

async function readTrace() {
  const data = await page.evaluate(() => {
    const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const tools = [...document.querySelectorAll('.step.tool')].map((row) => ({
      title: text(row.querySelector('.step-title')),
      target: text(row.querySelector('.step-target')),
      status:
        ['done', 'failed', 'stopped', 'timeout', 'refused', 'running'].find((name) =>
          row.classList.contains(name),
        ) ?? '',
    }))
    const cites = [...document.querySelectorAll('.cite')].map((el) => el.getAttribute('data-ev'))
    const known = new Set(
      [...document.querySelectorAll('[data-evidence-id], [data-call-id]')].flatMap((el) => [
        el.getAttribute('data-evidence-id'),
        el.getAttribute('data-call-id'),
      ]),
    )
    const users = [...document.querySelectorAll('.msg.user:not(.steer)')]
    const replies = [...document.querySelectorAll('.msg.agent.text, .msg.agent.question')]
    return {
      answer: text([...document.querySelectorAll('.msg.agent.text')].at(-1)),
      citations: cites.length,
      unresolved: cites.filter((id) => !id || !known.has(id)).length,
      tools,
      steer: document.querySelectorAll('.msg.user.steer').length,
      resume: document.querySelectorAll('.conversation-divider').length,
      clarify: document.querySelectorAll('.msg.agent.question').length,
      model: document.querySelector('.conversation-model select')?.value ?? '',
      request: text(users.at(-1)?.querySelector('p')),
      messages: users.length,
      replies: replies.length,
    }
  })
  const queryRow = page.locator('.step.tool', { hasText: 'Ran a read-only query' }).first()
  if (await queryRow.count()) {
    const line = queryRow.locator('.step-line')
    if ((await line.getAttribute('aria-expanded')) === 'false') await line.click()
    await page.waitForTimeout(80)
  }
  const table = page.locator('.step-detail .table-block table')
  if (await table.count()) data.table = await table.first().locator('tbody td').first().innerText()
  data.code = await page
    .locator('.msg.agent.text pre')
    .allInnerTexts()
    .then((blocks) => blocks.join('\n'))
  return data
}

function score(scenario, trace) {
  const e = scenario.expect
  const results = []
  const check = (name, pass, must = true) => results.push({ name, pass, must })
  for (const tool of e.tools ?? [])
    check(`uses ${tool}`, trace.tools.some((item) => item.title === tool))
  if (e.firstTool) check(`first call is ${e.firstTool}`, trace.tools[0]?.title === e.firstTool)
  if (e.answer) check(`answer names ${e.answer}`, trace.answer.includes(e.answer), false)
  if (e.citations) check(`has ${e.citations} citation(s)`, trace.citations >= e.citations)
  if (e.unresolved !== undefined)
    check('no unresolved citations', trace.unresolved <= e.unresolved)
  if (e.command) check(`writes a command for ${e.command}`, (trace.code ?? '').includes(e.command))
  if (e.noWrite) check('never claims the change was made', !WRITE_CLAIM.test(trace.answer))
  if (e.steer) check('shows the steer in the trace', trace.steer > 0)
  if (e.steer === 0) check('the steer is not in the retried run', trace.steer === 0)
  if (e.request) check(`the run's request is "${e.request}"`, trace.request === e.request)
  if (e.resume) check('shows the resume in the trace', trace.resume > 0)
  if (e.clarify) check('asks one clarifying question', trace.clarify > 0)
  if (e.calls !== undefined)
    check(`at most ${e.calls} calls`, trace.tools.length <= e.calls, false)
  if (e.table) check(`table starts with ${e.table}`, trace.table === e.table)
  if (e.model) check(`task uses ${e.model}`, trace.model.includes(e.model))
  if (e.honest) check('answer says the question is open', HONEST.test(trace.answer))
  if (e.noClean) check('answer never claims clean', !CLEAN_CLAIM.test(trace.answer))
  if (e.noClaim)
    check(
      `answer does not call ${e.noClaim} exposed`,
      !new RegExp(`${e.noClaim}\`? (is|are) (public|exposed)`, 'i').test(trace.answer),
    )
  if (e.messages) check(`${e.messages} user messages in one conversation`, trace.messages === e.messages)
  if (e.replies) check(`the agent replied ${e.replies} times`, trace.replies >= e.replies)
  return results
}

async function runScenario(scenario) {
  await newTask()
  let trace
  if (scenario.flow === 'stop-continue') {
    await page.locator('.composer textarea').fill(scenario.turns[0])
    await page.keyboard.press('Enter')
    await page.waitForSelector('.run-strip .run-dot', { timeout: 10_000 })
    await page.getByRole('button', { name: 'Stop' }).click()
    await page.waitForSelector('text=Stopped.', { timeout: 10_000 })
    await page.getByRole('button', { name: 'Continue' }).click()
    // The resumed turn must land before "not running" means anything: wait for
    // its divider and an agent reply after it, then for the turn to settle.
    await page.waitForSelector('.conversation-divider', { timeout: 30_000 })
    await page.waitForFunction(
      () => {
        const items = [...document.querySelectorAll('.conversation > *')]
        const divider = items.findLastIndex((item) => item.matches('.conversation-divider'))
        return divider >= 0 && items.slice(divider + 1).some((item) => item.matches('.msg.agent.text') || item.querySelector('.msg.agent.text'))
      },
      null,
      { timeout: 180_000 },
    )
    await page.waitForSelector('.composer .send.stop', { state: 'detached', timeout: 180_000 })
    trace = await readTrace()
  } else if (scenario.flow === 'steer') {
    await page.locator('.composer textarea').fill(scenario.turns[0])
    await page.keyboard.press('Enter')
    await page.waitForSelector('.run-strip .run-dot', { timeout: 10_000 })
    await page.locator('.composer textarea').fill('Focus on web-assets')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.composer .send.stop', { state: 'detached', timeout: 180_000 })
    trace = await readTrace()
  } else if (scenario.flow === 'retry-after-steer') {
    await page.locator('.composer textarea').fill(scenario.turns[0])
    await page.keyboard.press('Enter')
    await page.waitForSelector('.run-strip .run-dot', { timeout: 10_000 })
    await page.locator('.composer textarea').fill('Focus on web-assets')
    await page.keyboard.press('Enter')
    await idle()
    const id = await page.locator('.conversation[data-task-id]').getAttribute('data-task-id')
    const before = await page.locator('.msg.agent.text').count()
    await page.evaluate((taskId) => window.agent.retryTask(taskId), id)
    await page.waitForFunction(
      (count) => document.querySelectorAll('.msg.agent.text').length > count,
      before,
      { timeout: 180_000 },
    )
    await idle()
    trace = await readTrace()
    // The retry asks the request again; the steer stays where it was said.
    const items = await page.evaluate(() =>
      [...document.querySelectorAll('.conversation > *')].map((item) =>
        item.matches('.msg.user.steer') ? 'steer' : item.matches('.msg.user') ? 'user' : '',
      ),
    )
    trace.steer = items.slice(items.lastIndexOf('user')).filter((kind) => kind === 'steer').length
  } else if (scenario.flow === 'model-switch') {
    await ask(scenario.turns[0])
    const id = await page.locator('.conversation[data-task-id]').getAttribute('data-task-id')
    const next = await page.evaluate(
      ({ taskId, baseUrl }) =>
        window.agent
          .setTaskModel(taskId, {
            provider: 'compatible',
            modelId: 'fake-model',
            baseUrl,
            thinking: 'off',
          })
          .then(() => window.agent.openTask(taskId)),
      { taskId: id, baseUrl: model.baseUrl },
    )
    await ask('Which buckets are public?')
    trace = await readTrace()
    trace.model = `${trace.model} ${next.model?.modelId ?? ''}`
  } else {
    for (const turn of scenario.turns) await ask(turn)
    if (scenario.then) {
      await newTask()
      await ask(scenario.then.ask)
    }
    trace = await readTrace()
  }
  return { scenario: scenario.name, trace, results: score(scenario, trace) }
}

try {
  await configure()
  const report = []
  for (let attempt = 1; attempt <= runs; attempt += 1)
    for (const scenario of scenarios) {
      if (only && scenario.name !== only) continue
      const name = runs > 1 ? `${scenario.name} #${attempt}` : scenario.name
      try {
        const result = await runScenario(scenario)
        report.push({ ...result, scenario: name })
        const passed = result.results.filter((item) => item.pass).length
        console.log(`${name}: ${passed}/${result.results.length}`)
      } catch (error) {
        console.error(`${name}: ${error.message}`)
        report.push({
          scenario: name,
          trace: null,
          results: [{ name: 'run completed', pass: false, must: true }],
        })
      }
    }
  const lines = [
    `# Storage Agent bench — ${model.provider}/${model.id}${smoke ? ' (smoke, fake model)' : ''}`,
    '',
    `${new Date().toISOString()} · ${report.length} scenario run(s) · ${runs} run(s) each`,
    '',
  ]
  for (const result of report) {
    const passed = result.results.filter((item) => item.pass).length
    lines.push(`## ${result.scenario} — ${passed}/${result.results.length}`)
    for (const item of result.results)
      lines.push(`- ${item.pass ? '✓' : '✗'} ${item.name}${item.must ? '' : ' (soft)'}`)
    lines.push('')
  }
  writeFileSync(
    join(root, '.amp/in/artifacts/bench-report.json'),
    JSON.stringify({ model: { ...model, key: undefined }, smoke, report }, null, 2),
  )
  const all = report.flatMap((item) => item.results)
  const must = all.filter((item) => item.must)
  const soft = all.filter((item) => !item.must)
  const softRate = soft.length ? soft.filter((item) => item.pass).length / soft.length : 1
  const gate = `must-pass ${must.filter((item) => item.pass).length}/${must.length} · soft ${Math.round(softRate * 100)}%`
  lines.splice(3, 0, gate, '')
  writeFileSync(join(root, '.amp/in/artifacts/bench-report.md'), lines.join('\n'))
  console.log(`Bench ${gate}. Report: ${join(root, '.amp/in/artifacts/bench-report.md')}`)
  // Set the code and let `finally` close the window and the servers.
  if (must.some((item) => !item.pass) || softRate < 0.9) process.exitCode = 1
} finally {
  await app.close().catch(() => undefined)
  s3.server.close()
  fakeModel?.kill()
}
