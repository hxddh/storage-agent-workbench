/**
 * End-to-end run against the fake model and fake S3. Drives the real window:
 * configure a model and an account, ask a question, wait for the answer, then
 * inspect the agent trace and its evidence.
 *
 *   node scripts/e2e.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'

const root = new URL('..', import.meta.url).pathname
const require = createRequire(import.meta.url)
execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
const dataDir = mkdtempSync(join(tmpdir(), 'sa-e2e-'))
const s3Port = 9110
const modelPort = 9210

const seen = new Set()

function start(script, port) {
  const child = spawn(process.execPath, [join(root, script), String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SLOW_MS: '350' },
  })
  child.stdout.on('data', (data) => {
    if (String(data).includes('GROUNDING_CORRECTION')) seen.add('correction')
    process.stdout.write(`[${script}] ${data}`)
  })
  child.stderr.on('data', (data) => process.stderr.write(`[${script}] ${data}`))
  return child
}

const s3 = start('scripts/fake-s3.mjs', s3Port)
const model = start('scripts/fake-model.mjs', modelPort)
await new Promise((resolve) => setTimeout(resolve, 600))

const app = await electron.launch({
  args: ['.', '--no-sandbox'],
  cwd: root,
  env: { ...process.env, STORAGE_AGENT_DATA_DIR: dataDir, STORAGE_AGENT_NO_UPDATE: '1' },
})
const page = await app.firstWindow()
page.on('console', (message) => console.log('[renderer]', message.type(), message.text()))
page.on('pageerror', (error) => console.log('[pageerror]', error.stack ?? error.message))

const fail = async (message) => {
  await page.waitForTimeout(350)
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-failure.png') })
  console.error('FAIL:', message)
  console.error(await page.locator('body').innerText())
  await app.close()
  s3.kill()
  model.kill()
  process.exit(1)
}

const openTrace = async () => {
  await page.waitForSelector('.run-work-head', { timeout: 60_000 })
  const head = page.locator('.run-work-head')
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click()
  await page.waitForSelector('.run-work .activity-list', { timeout: 5_000 })
}

const openFindings = async () => {
  const button = page.locator('.run-evidence-button', { hasText: 'Findings' })
  if (!(await button.count())) await fail('the findings strip is missing')
  await button.click()
  await page.waitForSelector('.run-finding-line', { timeout: 5_000 })
}

const openTool = async (label) => {
  await openTrace()
  const row = page.locator('.activity-item.tool', { hasText: label }).first()
  if (!(await row.count())) await fail(`trace row missing: ${label}`)
  await row.locator('.activity-line').click()
  return row
}

/**
 * A re-check is its own run: wait for it to start and settle, then for its
 * trace, which opens by itself. Toggling the trace header before the run lands
 * would race the page's own open.
 */
const waitRecheck = async () => {
  await page.waitForSelector('.run-tag:has-text("Re-check")', { timeout: 30_000 })
  await page.waitForSelector('.composer .send.stop', { state: 'detached', timeout: 60_000 })
  await openTrace()
  await page.waitForSelector('.activity-item.reverify', { timeout: 30_000 })
}

/** A model run is settled when the composer is no longer in its stop state. */
const waitSettled = async (request) => {
  // Wait for this request's own run first: before it lands, the page still
  // shows the previous run (or none), and the composer is not yet in its stop state.
  if (request)
    await page.waitForFunction(
      (text) => document.querySelector('.run-question')?.textContent === text,
      request,
      { timeout: 60_000 },
    )
  await page.waitForSelector('.composer .send.stop', { state: 'detached', timeout: 60_000 })
  await page.waitForSelector('.run-answer .verdict, .run-clarify', { timeout: 60_000 })
  await page.waitForSelector('.run-work-head', { timeout: 60_000 })
}

const checkA11y = async (label) => {
  await page.evaluate(readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'))
  const axe = await page.evaluate(async () => {
    const runner = window.axe
    return runner.run(document, { resultTypes: ['violations'] })
  })
  const severe = axe.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  )
  console.log(`A11Y ${label}:`, axe.violations.length, 'violations;', severe.length, 'serious')
  for (const violation of severe)
    console.log(
      `A11Y ${label} NODE:`,
      violation.id,
      violation.nodes.map((node) => `${node.target.join(' ')} :: ${node.html}`).join(' | '),
    )
  if (severe.length)
    await fail(`${label} accessibility: ${severe.map((v) => `${v.id} (${v.nodes.length})`).join(', ')}`)
}

try {
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: 'Set up a model' }).first().click()
  await page.locator('#baseUrl').fill(`http://127.0.0.1:${modelPort}/v1`)
  await page.locator('#apiKey').fill('test-key')
  await page.waitForSelector('select[aria-label="Models"]', { timeout: 5_000 })
  await page.locator('select[aria-label="Models"]').selectOption('fake-model')
  console.log('MODEL LIST OK')
  await page.getByRole('button', { name: 'Save', exact: true }).first().click()
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: 'Model', exact: true }).click()
  await page.getByRole('button', { name: 'Test', exact: true }).click()
  await page.waitForTimeout(1200)
  const modelStatus = await page.locator('.ok-text, .error-text').first().innerText()
  console.log('MODEL:', modelStatus)
  if (!/Connected|ok/i.test(modelStatus)) await fail(`model test: ${modelStatus}`)

  await page.getByRole('button', { name: 'Storage accounts', exact: true }).click()
  await page.locator('#accName').fill('Demo')
  await page.locator('#accEndpoint').fill(`http://127.0.0.1:${s3Port}`)
  await page.locator('#accRegion').fill('us-east-1')
  await page.locator('#accKey').fill('demo-key')
  await page.locator('#accSecret').fill('demo-secret')
  await page.getByLabel('Path-style addressing').check()
  const accountForm = page.locator('.account').last()
  await accountForm.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForTimeout(1000)
  const accounts = await page.locator('.account-name').count()
  console.log('ACCOUNTS:', accounts)
  if (accounts < 1) await fail('account was not saved')
  await checkA11y('settings')

  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.waitForSelector('.home-ledger-row', { timeout: 5_000 })
  console.log('HOME OVERVIEW OK')
  await checkA11y('home')

  // Model-free account check: the same readers produce a run without a model.
  await page.getByRole('button', { name: 'Check account' }).click()
  await page.waitForSelector('.brief .verdict', { timeout: 120_000 })
  const auditText = await page.locator('.brief').innerText()
  if (!/risk|problem|No open/i.test(auditText)) await fail('audit produced no conclusion')
  console.log('AUDIT OK:', auditText.replace(/\s+/g, ' ').slice(0, 180))
  await checkA11y('audit')
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-audit.png') })

  await page.locator('.composer textarea').fill('Which buckets are public?')
  await page.keyboard.press('Enter')

  await page.waitForSelector('.run-strip .run-dot', { timeout: 10_000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-running.png') })

  await waitSettled('Which buckets are public?')
  if (await page.locator('.run-plan').count()) await fail('a finished plan is still visible')
  await page.locator('.run-answer .run-cite').first().click()
  await page.waitForSelector('.run-peek', { timeout: 5_000 })
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-peek.png') })
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await openTrace()
  await openFindings()
  const body = await page.locator('body').innerText()
  console.log('ANSWER OK')
  console.log(body.slice(0, 1200))
  if ((await page.locator('.verdict code.ungrounded').count()) !== 0)
    await fail('a grounded verdict was marked')
  await page.locator('.run-finding-main').first().click()
  await page.waitForSelector('.run-work-head[aria-expanded="true"]', { timeout: 5_000 })
  console.log('EVIDENCE OK')
  await page.waitForTimeout(200)
  await checkA11y('answer')
  await page.waitForTimeout(350)
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-answer.png') })

  // @ points at a remembered bucket without typing its name.
  await page.locator('.composer textarea').fill('@demo')
  await page.waitForSelector('.ref-picker .ref-row', { timeout: 5_000 })
  await page.locator('.ref-row', { hasText: 'demo-public' }).first().click()
  await page.waitForSelector('.context-chip', { timeout: 5_000 })
  console.log('CONTEXT PICKER OK')
  await page.locator('.context-chip button').click()

  // A genuinely ambiguous request ends in one clarifying question; choosing
  // an option sends the answer as the next run.
  await page.getByRole('button', { name: 'New task' }).click()
  await page.locator('.composer textarea').fill('Please clarify which account to read')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.run-clarify', { timeout: 60_000 })
  const clarify = await page.locator('.run-clarify').innerText()
  if (!clarify.includes('Which account should I read?')) await fail('clarify question missing')
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-clarify.png') })
  await page.getByRole('button', { name: 'Demo', exact: true }).click()
  await waitSettled('Demo')
  console.log('CLARIFY OK')
  await page.locator('.composer textarea').fill('')

  // Re-verify is model-free: it re-reads the buckets this task touched.
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Re-check' }).click()
  await waitRecheck()
  await page.locator('.activity-item.reverify .activity-line').click()
  await page.waitForSelector('.activity-reverify', { timeout: 5_000 })
  const reverify = await page.locator('.activity-reverify').innerText()
  console.log('REVERIFY:', reverify.replace(/\s+/g, ' ').slice(0, 160))

  // Access paths: policy, ACL, identity, key and analyzer grants in one chain.
  await page.locator('.composer textarea').fill('Who can read demo-public?')
  await page.keyboard.press('Enter')
  await waitSettled('Who can read demo-public?')
  await openTool('Reviewed configuration')
  await page.waitForSelector('.access-chain .access-row', { timeout: 10_000 })
  const access = await page.locator('.access-chain').innerText()
  console.log('ACCESS OK:', access.replace(/\s+/g, ' ').slice(0, 180))
  await page.locator('.access-chain').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-access.png') })

  // Accepting a risk is the user's call; it folds the finding and survives a reload.
  await page.getByRole('button', { name: 'New task' }).click()
  await page.waitForSelector('.home', { timeout: 5_000 })
  await page.locator('.composer textarea').fill('Which buckets are public?')
  await page.keyboard.press('Enter')
  await waitSettled('Which buckets are public?')
  await openFindings()
  const encryption = page.locator('.run-finding-line', { hasText: 'No default encryption' }).first()
  await encryption.hover()
  await encryption.getByRole('button', { name: 'Accept risk' }).click()
  await page.waitForSelector('text=1 accepted', { timeout: 5_000 })
  console.log('ACCEPT OK')

  // The user applies the fix outside the app; the agent re-reads that bucket only.
  await fetch(`http://127.0.0.1:${s3Port}/__fake/fix?bucket=demo-public`, { method: 'POST' })
  await page.locator('.composer textarea').fill('I applied the fix to demo-public')
  await page.keyboard.press('Enter')
  await waitSettled('I applied the fix to demo-public')
  await page.waitForSelector('text=no longer public', { timeout: 60_000 })
  await openFindings()
  await page.waitForSelector('.run-panel-label.ok', { timeout: 10_000 })
  const fixed = await page.locator('.run-panel-label.ok').innerText()
  console.log('VERIFY OK:', fixed)
  await page.locator('.run-history-head').click()
  await page.waitForSelector('.run-turn-head', { timeout: 5_000 })
  await page.locator('.run-turn-head').first().click()
  await page.waitForSelector('.run-turn-body', { timeout: 5_000 })
  console.log('HISTORY OK')
  if (await page.locator('.run-finding-line', { hasText: 'publicly accessible' }).count())
    await fail('a fixed finding is still on the page')
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-verified.png') })

  // An answer naming a bucket no tool returned is corrected once; the correction replaces it.
  await page.getByRole('button', { name: 'New task' }).click()
  await page.locator('.composer textarea').fill('Is ghost-bucket exposed?')
  await page.keyboard.press('Enter')
  await waitSettled('Is ghost-bucket exposed?')
  await page.waitForSelector('.verdict:has-text("readings do not show")', { timeout: 60_000 })
  if (!seen.has('correction')) await fail('the harness did not ask for a grounded answer')
  console.log('GROUNDING OK')

  await page.getByRole('button', { name: 'New task' }).click()
  await page.locator('.composer textarea').fill('Show the change plan for demo-private')
  await page.keyboard.press('Enter')
  await waitSettled('Show the change plan for demo-private')
  await openTool('Prepared a change plan')
  await page.waitForSelector('.plan', { timeout: 10_000 })
  await page.waitForSelector('text=AWS CLI', { timeout: 60_000 })
  const changeBody = await page.locator('body').innerText()
  console.log('CHANGE OK')
  console.log(changeBody.slice(0, 900))
  await page.waitForTimeout(350)
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-change.png') })

  // Re-verify compares the account with the plan; it does not assume the user applied it.
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Re-check' }).click()
  await waitRecheck()
  await page.locator('.activity-item.reverify .activity-line').click()
  await page.waitForSelector('.activity-reverify', { timeout: 5_000 })
  const planReverify = await page.locator('.activity-reverify').innerText()
  console.log('PLAN REVERIFY:', planReverify.replace(/\s+/g, ' ').slice(0, 200))
  if (!planReverify.includes('not applied')) await fail('an unapplied plan step was not reported')

  await page.getByRole('button', { name: 'New task' }).click()
  await page.locator('.composer textarea').fill('Check demo-private again')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.run-strip .run-dot', { timeout: 10_000 })
  await page.getByRole('button', { name: 'Stop' }).click()
  await page.waitForSelector('text=Stopped.', { timeout: 10_000 })
  console.log('STOP OK')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.waitForSelector('.composer .send.stop', { state: 'detached', timeout: 60_000 })
  await page.waitForSelector('.run-answer .verdict', { timeout: 60_000 })
  await openFindings()
  console.log('CONTINUE OK')

  // Create one task in this session and find it by a distinctive title. This
  // also proves a model task reaches the durable task list, not only the view.
  await page.getByRole('button', { name: 'New task' }).click()
  await page.locator('.composer textarea').fill('Searchable demo question')
  await page.keyboard.press('Enter')
  await waitSettled('Searchable demo question')
  await openFindings()
  await page.waitForTimeout(400)

  await page.locator('.sidebar-search input').click()
  await page.keyboard.type('Searchable')
  await page.waitForSelector('.search-hit', { timeout: 10_000 })
  const hits = await page.locator('.search-hit').count()
  console.log('SEARCH HITS:', hits)
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-search.png') })
  await page.locator('.sidebar-search input').fill('abort rule')
  await page.waitForSelector('.search-hit:has-text("abort rule")', { timeout: 10_000 })
  await page.locator('.search-hit', { hasText: 'abort rule' }).first().click()
  // The change plan's task was re-checked since: its answer is an earlier run now.
  await page.waitForSelector(
    '.brief .verdict:has-text("abort rule"), .run-turn-summary:has-text("abort rule")',
    { timeout: 10_000 },
  )
  console.log('SEARCH OPEN OK')

  await page.locator('.sidebar-search input').fill('multipart')
  await page.waitForSelector('.search-hit:has-text("multipart")', { timeout: 10_000 })
  await page.locator('.search-hit', { hasText: 'multipart' }).first().click()
  await page.waitForSelector('.run-finding-line', { timeout: 10_000 })
  console.log('SEARCH FINDING OK')

  // Read-only code mode: the rows and the script are both in the trace.
  await page.getByRole('button', { name: 'New task' }).click()
  await page.locator('.composer textarea').fill('What are the largest prefixes in demo-public?')
  await page.keyboard.press('Enter')
  await page.waitForSelector('text=holds everything', { timeout: 60_000 })
  await page.waitForSelector('.composer .send.stop', { state: 'detached', timeout: 60_000 })
  await openTool('Ran a read-only query')
  await page.waitForSelector('.table-block table', { timeout: 10_000 })
  const firstCell = await page.locator('.table-block table tbody td').first().innerText()
  if (firstCell !== 'reports/') await fail(`query rows: ${firstCell}`)
  await page.waitForSelector('.activity-detail pre.code:has-text("tools.list")', { timeout: 5_000 })
  if (await page.locator('.verdict code.ungrounded').count()) await fail('a grounded query verdict was marked')
  console.log('QUERY OK')
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-query.png') })

  // Keyboard: j moves between findings.
  await page.getByRole('button', { name: 'New task' }).click()
  await page.locator('.composer textarea').fill('Which issues are open?')
  await page.keyboard.press('Enter')
  await waitSettled('Which issues are open?')
  await openFindings()
  await page.locator('.run-finding-main').first().focus()
  await page.keyboard.press('j')
  const moved = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.run-finding-main')]
    return rows.indexOf(document.activeElement) === 1
  })
  if (!moved) await fail('j did not move to the next finding')
  console.log('KEYS OK')

  // Demo storage: an in-process account, offered once.
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Storage accounts', exact: true }).click()
  await page.getByRole('button', { name: 'Try with demo storage' }).click()
  await page.waitForSelector('.account-name:has-text("Demo storage")', { timeout: 5_000 })
  if (await page.getByRole('button', { name: 'Try with demo storage' }).count())
    await fail('the demo was offered twice')
  console.log('DEMO OK')
  await page.getByRole('button', { name: 'Close settings' }).click()

  const db = readFileSync(join(dataDir, 'storage-agent.db'))
  console.log('DB BYTES:', db.length)
} catch (error) {
  await fail(error.message)
} finally {
  await app.close()
  s3.kill()
  model.kill()
}
