/**
 * End-to-end run against the fake model and fake S3. Drives the real window as
 * a conversation: configure a model and an account, talk to the agent, and
 * check that its tool calls, answers, questions and confirmations appear in
 * the thread where they happened.
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


function start(script, port) {
  const child = spawn(process.execPath, [join(root, script), String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SLOW_MS: '350' },
  })
  child.stdout.on('data', (data) => {
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

/** Open one tool call in the thread by its label and return its row. */
const openTool = async (label) => {
  const row = page.locator('.step.tool', { hasText: label }).last()
  if (!(await row.count())) await fail(`tool call missing: ${label}`)
  if ((await row.locator('.step-line').getAttribute('aria-expanded')) === 'false')
    await row.locator('.step-line').click()
  await row.locator('.step-detail').waitFor({ timeout: 5_000 })
  return row
}

/**
 * A turn is settled once this message is the last thing the user said, the
 * agent is no longer working, and it has replied (text or a question).
 */
const waitSettled = async (message) => {
  await page.waitForFunction(
    (text) => [...document.querySelectorAll('.msg.user')].at(-1)?.textContent?.startsWith(text),
    message,
    { timeout: 60_000 },
  )
  await page.waitForSelector('.composer .send.stop', { state: 'detached', timeout: 60_000 })
  await page.waitForFunction(
    () => {
      const items = [...document.querySelectorAll('.conversation > *')]
      const user = items.findLastIndex((item) => item.classList.contains('msg') && item.classList.contains('user'))
      return items.slice(user + 1).some((item) => item.querySelector?.('.msg.agent') || item.classList.contains('agent'))
    },
    null,
    { timeout: 60_000 },
  )
}

/** The agent's last text in the thread. */
const lastText = () => page.locator('.msg.agent.text').last().innerText()

const say = async (text) => {
  await page.locator('.composer textarea').fill(text)
  await page.keyboard.press('Enter')
  await waitSettled(text)
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
  await page.locator('.account').last().getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForTimeout(1000)
  if ((await page.locator('.account-name').count()) < 1) await fail('account was not saved')
  await checkA11y('settings')
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.waitForSelector('.home-account', { timeout: 5_000 })
  console.log('HOME OVERVIEW OK')
  await checkA11y('home')

  // "Check account" is a message to the agent; the agent reads with its tools.
  await page.getByRole('button', { name: 'Check account' }).click()
  await page.waitForSelector('.msg.user', { timeout: 10_000 })
  await page.waitForSelector('.step.tool', { timeout: 30_000 })
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-running.png') })
  await waitSettled('Check my storage accounts')
  if (!(await page.locator('.step.tool', { hasText: 'Read account' }).count()))
    await fail('the check did not read the account')
  console.log('CHECK OK:', (await lastText()).replace(/\s+/g, ' ').slice(0, 160))
  for (const gone of ['Earlier in this task', 'Not checked', 'Worked for'])
    if (await page.getByText(gone).count()) await fail(`report scaffolding is back: ${gone}`)

  // The conversation continues in the same task: a second turn below the first.
  await say('Which buckets are public?')
  if ((await page.locator('.msg.user').count()) !== 2) await fail('the follow-up is not in the same thread')
  await page.locator('.msg.agent .cite').last().click()
  await page.waitForSelector('.step.tool .step-detail', { timeout: 5_000 })
  console.log('ANSWER OK:', (await lastText()).replace(/\s+/g, ' ').slice(0, 160))
  await checkA11y('conversation')
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-answer.png') })

  // @ points at a remembered bucket without typing its name.
  await page.locator('.composer textarea').fill('@demo')
  await page.waitForSelector('.ref-picker .ref-row', { timeout: 5_000 })
  await page.locator('.ref-row', { hasText: 'demo-public' }).first().click()
  await page.waitForSelector('.context-chip', { timeout: 5_000 })
  console.log('CONTEXT PICKER OK')
  await page.locator('.context-chip button').click()
  await page.locator('.composer textarea').fill('')

  // A genuinely ambiguous request: the agent asks, an option answers.
  await page.getByRole('button', { name: 'New task' }).click()
  await page.locator('.composer textarea').fill('Please clarify which account to read')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.msg.agent.question', { timeout: 60_000 })
  if (!(await page.locator('.msg.agent.question').innerText()).includes('Which account should I read?'))
    await fail('clarify question missing')
  await page.getByRole('button', { name: 'Demo', exact: true }).click()
  await waitSettled('Demo')
  console.log('CLARIFY OK')

  // Access paths open in place under their call.
  await say('Who can read demo-public?')
  const access = await openTool('Reviewed configuration')
  await access.locator('.access-chain .access-row').first().waitFor({ timeout: 10_000 })
  console.log('ACCESS OK')
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-access.png') })

  // Accepting a risk is the user's act: the agent asks, the user confirms.
  await page.getByRole('button', { name: 'New task' }).click()
  await say('Accept the encryption risk on demo-public')
  await page.waitForSelector('.msg.agent.confirm', { timeout: 10_000 })
  await page.locator('.msg.agent.confirm').getByRole('button', { name: 'Accept risk' }).click()
  await page.waitForSelector('.msg.agent.confirm >> text=Accepted.', { timeout: 5_000 })
  console.log('ACCEPT OK')

  // The user applies the fix outside the app; the agent re-reads that bucket.
  await fetch(`http://127.0.0.1:${s3Port}/__fake/fix?bucket=demo-public`, { method: 'POST' })
  await say('I applied the fix to demo-public')
  if (!(await lastText()).includes('no longer public')) await fail('the re-read did not land')
  console.log('VERIFY OK')

  await page.getByRole('button', { name: 'New task' }).click()
  await say('Show the change plan for demo-private')
  const change = await openTool('Prepared a change plan')
  await change.locator('.plan').first().waitFor({ timeout: 10_000 })
  await page.waitForSelector('text=AWS CLI', { timeout: 10_000 })
  console.log('CHANGE OK')
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-change.png') })

  await page.getByRole('button', { name: 'New task' }).click()
  await page.locator('.composer textarea').fill('Check demo-private again')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.run-strip .run-dot', { timeout: 10_000 })
  await page.getByRole('button', { name: 'Stop' }).click()
  await page.waitForSelector('text=Stopped.', { timeout: 10_000 })
  console.log('STOP OK')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.waitForSelector('.conversation-divider', { timeout: 10_000 })
  await page.waitForSelector('.composer .send.stop', { state: 'detached', timeout: 60_000 })
  await page.waitForSelector('.msg.agent.text', { timeout: 60_000 })
  console.log('CONTINUE OK')

  await page.getByRole('button', { name: 'New task' }).click()
  await say('Searchable demo question')
  await page.waitForTimeout(400)
  await page.locator('.sidebar-search input').click()
  await page.keyboard.type('Searchable')
  await page.waitForSelector('.search-hit', { timeout: 10_000 })
  console.log('SEARCH HITS:', await page.locator('.search-hit').count())
  await page.locator('.sidebar-search input').fill('abort rule')
  await page.waitForSelector('.search-hit:has-text("abort rule")', { timeout: 10_000 })
  await page.locator('.search-hit', { hasText: 'abort rule' }).first().click()
  await page.waitForSelector('.msg.agent.text:has-text("abort rule")', { timeout: 10_000 })
  console.log('SEARCH OPEN OK')

  // Read-only code mode: the rows and the script open under the query call.
  await page.getByRole('button', { name: 'New task' }).click()
  await say('What are the largest prefixes in demo-public?')
  const query = await openTool('Ran a read-only query')
  const firstCell = await query.locator('.table-block table tbody td').first().innerText()
  if (firstCell !== 'reports/') await fail(`query rows: ${firstCell}`)
  await query.locator('pre.code:has-text("tools.list")').waitFor({ timeout: 5_000 })
  console.log('QUERY OK')
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-query.png') })

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
