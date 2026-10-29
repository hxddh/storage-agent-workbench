/**
 * Agent-behavior bench. Unlike eval.mjs, this scores the trace the agent
 * produced (calls, coverage, citations, steer/resume/re-check) and the answer,
 * not the app's facts projection.
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
const buckets = {
  'demo-public': { public: true, encryption: true },
  'demo-private': { encryption: true, blocked: true },
  'finance-exports': { aclDenied: true, encryption: true, blocked: true },
}

const scenarios = [
  {
    name: 'public-account',
    turns: ['Which buckets are public?'],
    expect: { tools: ['Read account'], answer: 'demo-public', citations: 1 },
  },
  {
    name: 'blind-acl',
    turns: ['Are any of my buckets public?'],
    expect: { honest: true, blind: 1, noClean: true },
  },
  {
    name: 'memory-first',
    turns: ['Survey my account.'],
    then: { newTask: true, ask: 'What did you find last time?' },
    expect: { firstTool: 'Recalled memory', answer: 'demo-public' },
  },
  {
    name: 'clarify',
    turns: ['Please clarify which account to read'],
    expect: { clarify: true, calls: 0 },
  },
  {
    name: 'fix-plan',
    turns: ['Survey my account.', 'Give me the fix for demo-private'],
    expect: { tools: ['Prepared a change plan'], plan: 1, answer: 'demo-private' },
  },
  {
    name: 'query',
    turns: ['What are the largest prefixes in demo-public?'],
    expect: { tools: ['Ran a read-only query'], table: 'reports/' },
  },
  {
    name: 'grounding',
    turns: ['Is ghost-bucket exposed?'],
    expect: { answer: 'readings do not show', correction: true },
  },
  {
    name: 'citation-validity',
    turns: ['Which buckets are public?'],
    expect: { citations: 1, unresolved: 0 },
  },
  {
    name: 'stop-continue',
    flow: 'stop-continue',
    turns: ['Check demo-private again'],
    expect: { resume: 1, answer: 'demo-public' },
  },
  {
    name: 'steer',
    flow: 'steer',
    turns: ['Survey my account.'],
    expect: { steer: 1, answer: 'demo-public' },
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
    // A scripted check leaves real calls and a cited answer, like a model run.
    name: 'check-parity',
    flow: 'check',
    turns: [],
    expect: { tools: ['Read account'], citations: 1, unresolved: 0, tag: 'Deterministic account check' },
  },
  {
    // A model run after a check in the same task answers from fresh, cited reads.
    name: 'check-then-ask',
    flow: 'check',
    turns: ['Which buckets are public?'],
    expect: { citations: 1, unresolved: 0, answer: 'demo-public', request: 'Which buckets are public?' },
  },
  {
    // A re-check is its own run in the same task: its trace shows the comparison.
    name: 'recheck-run',
    flow: 'recheck',
    turns: ['Survey my account.'],
    expect: { reverify: 1, tag: 'Re-check', earlier: 1 },
  },
]

const s3 = await startFakeS3({ buckets })
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
const seen = new Set()
page.on('console', (message) => {
  if (message.text().includes('GROUNDING_CORRECTION')) seen.add('correction')
})
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
  // This request's own run must land before "not running" means anything.
  await page.waitForFunction(
    (request) => document.querySelector('.run-question')?.textContent === request,
    text,
    { timeout: 60_000 },
  )
  await page.waitForSelector('.composer .send.stop', { state: 'detached', timeout: 180_000 })
  await page.waitForSelector('.run-answer .verdict, .run-clarify', { timeout: 180_000 })
  await page.waitForTimeout(250)
}

async function readTrace() {
  const head = page.locator('.run-work-head')
  if ((await head.count()) && (await head.getAttribute('aria-expanded')) === 'false')
    await head.click()
  await page.waitForTimeout(80)
  const data = await page.evaluate(() => {
    const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const tools = [...document.querySelectorAll('.activity-item.tool')].map((row) => ({
      title: text(row.querySelector('.activity-title')),
      target: text(row.querySelector('.activity-target')),
      status:
        ['done', 'failed', 'stopped', 'timeout', 'refused', 'running'].find((name) =>
          row.classList.contains(name),
        ) ?? '',
    }))
    return {
      answer: text(document.querySelector('.run-answer .verdict')),
      citations: document.querySelectorAll('.run-cite').length,
      unresolved: document.querySelectorAll('.run-unresolved').length,
      tools,
      plan: document.querySelectorAll('.run-work-plan').length,
      steer: document.querySelectorAll('.activity-item.steer').length,
      resume: document.querySelectorAll('.activity-item.resume').length,
      validation: document.querySelectorAll('.activity-item.validation').length,
      clarify: document.querySelectorAll('.run-clarify').length,
      model: text(document.querySelector('.run-model')),
      request: text(document.querySelector('.run-question')),
      tag: text(document.querySelector('.run-tag')),
      reverify: document.querySelectorAll('.activity-item.reverify').length,
      earlier: Number(text(document.querySelector('.run-history-count')) || 0),
    }
  })
  const findings = page.locator('.run-evidence-button', { hasText: 'Findings' })
  if (await findings.count()) {
    if ((await findings.getAttribute('aria-expanded')) === 'false') await findings.click()
    data.findings = await page.locator('.run-finding-line').count()
  }
  const notChecked = page.locator('.run-evidence-button', { hasText: 'Not checked' })
  if (await notChecked.count()) {
    if ((await notChecked.getAttribute('aria-expanded')) === 'false') await notChecked.click()
    data.blind = await page.locator('.run-coverage-panel .blind').count()
  }
  const queryRow = page.locator('.activity-item.tool', { hasText: 'Ran a read-only query' }).first()
  if (await queryRow.count()) {
    const line = queryRow.locator('.activity-line')
    if ((await line.getAttribute('aria-expanded')) === 'false') await line.click()
    await page.waitForTimeout(80)
  }
  const table = page.locator('.activity-detail .table-block table')
  if (await table.count()) data.table = await table.first().locator('tbody td').first().innerText()
  const changeRow = page
    .locator('.activity-item.tool', { hasText: 'Prepared a change plan' })
    .first()
  if (await changeRow.count()) {
    const line = changeRow.locator('.activity-line')
    if ((await line.getAttribute('aria-expanded')) === 'false') await line.click()
    await page.waitForTimeout(120)
    data.change = await page.locator('.activity-detail .plan, .activity-detail .tabs').count()
  }
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
  if (e.plan) check('shows a change plan', (trace.change ?? 0) > 0)
  if (e.steer) check('shows the steer in the trace', trace.steer > 0)
  if (e.steer === 0) check('the steer is not in the retried run', trace.steer === 0)
  if (e.request) check(`the run's request is "${e.request}"`, trace.request === e.request)
  if (e.tag) check(`tagged ${e.tag}`, trace.tag === e.tag)
  if (e.reverify) check('shows the re-check comparison', trace.reverify >= e.reverify)
  if (e.earlier) check('keeps the earlier run', trace.earlier >= e.earlier)
  if (e.resume) check('shows the resume in the trace', trace.resume > 0)
  if (e.clarify) check('asks one clarifying question', trace.clarify > 0)
  if (e.calls !== undefined)
    check(`at most ${e.calls} calls`, trace.tools.length <= e.calls, false)
  if (e.blind) check('shows the blind spot', (trace.blind ?? 0) > 0)
  if (e.table) check(`table starts with ${e.table}`, trace.table === e.table)
  if (e.model) check(`task uses ${e.model}`, trace.model.includes(e.model))
  if (e.honest) check('answer says the question is open', HONEST.test(trace.answer))
  if (e.noClean) check('answer never claims clean', !CLEAN_CLAIM.test(trace.answer))
  if (e.correction) check('validation is visible in the trace', trace.validation > 0)
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
    await page.waitForSelector('.composer .send.stop', { state: 'detached', timeout: 180_000 })
    trace = await readTrace()
  } else if (scenario.flow === 'steer') {
    await page.locator('.composer textarea').fill(scenario.turns[0])
    await page.keyboard.press('Enter')
    await page.waitForSelector('.run-strip .run-dot', { timeout: 10_000 })
    await page.locator('.composer textarea').fill('Focus on demo-public')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.composer .send.stop', { state: 'detached', timeout: 180_000 })
    trace = await readTrace()
  } else if (scenario.flow === 'retry-after-steer') {
    await page.locator('.composer textarea').fill(scenario.turns[0])
    await page.keyboard.press('Enter')
    await page.waitForSelector('.run-strip .run-dot', { timeout: 10_000 })
    await page.locator('.composer textarea').fill('Focus on demo-public')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.composer .send.stop', { state: 'detached', timeout: 180_000 })
    const id = await page.locator('.run[data-task-id]').getAttribute('data-task-id')
    await page.evaluate((taskId) => window.agent.retryTask(taskId), id)
    await page.waitForSelector('.run-history-count', { timeout: 30_000 })
    await page.waitForSelector('.composer .send.stop', { state: 'detached', timeout: 180_000 })
    await page.waitForSelector('.run-answer .verdict', { timeout: 180_000 })
    trace = await readTrace()
  } else if (scenario.flow === 'check') {
    await page.getByRole('button', { name: 'Check account' }).first().click()
    await page.waitForSelector('.run-answer .verdict', { timeout: 180_000 })
    await page.waitForSelector('.composer .send.stop', { state: 'detached', timeout: 180_000 })
    for (const turn of scenario.turns) await ask(turn)
    trace = await readTrace()
  } else if (scenario.flow === 'recheck') {
    for (const turn of scenario.turns) await ask(turn)
    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: 'Re-check' }).click()
    await page.waitForSelector('.run-tag', { timeout: 30_000 })
    await page.waitForSelector('.activity-item.reverify', { timeout: 120_000 })
    trace = await readTrace()
  } else if (scenario.flow === 'model-switch') {
    await ask(scenario.turns[0])
    const id = await page.locator('.run[data-task-id]').getAttribute('data-task-id')
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
