/**
 * End-to-end run against the fake model and fake S3. Drives the real window:
 * configure a model and an account, ask a question, wait for the answer.
 *
 *   node scripts/e2e.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const root = new URL('..', import.meta.url).pathname
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
page.on('pageerror', (error) => console.log('[pageerror]', error.message))

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

try {
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: 'Set up a model' }).first().click()
  await page.locator('#modelId').fill('fake-model')
  await page.locator('#baseUrl').fill(`http://127.0.0.1:${modelPort}/v1`)
  await page.locator('#apiKey').fill('test-key')
  await page.getByRole('button', { name: 'Save', exact: true }).first().click()
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: 'Test', exact: true }).click()
  await page.waitForTimeout(1200)
  const modelStatus = await page.locator('.ok-text, .error-text').first().innerText()
  console.log('MODEL:', modelStatus)
  if (!/Connected|ok/i.test(modelStatus)) await fail(`model test: ${modelStatus}`)

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

  await page.getByRole('button', { name: 'Close' }).click()
  await page.locator('.composer textarea').fill('Which buckets are public?')
  await page.keyboard.press('Enter')

  await page.waitForSelector('.check-line .pulse-icon', { timeout: 10_000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-running.png') })

  await page.waitForSelector('text=demo-public is publicly accessible', { timeout: 60_000 })
  const body = await page.locator('body').innerText()
  console.log('ANSWER OK')
  console.log(body.slice(0, 1200))
  if ((await page.locator('.verdict code.ungrounded').count()) !== 0)
    await fail('a grounded verdict was marked')
  await page.locator('.finding-main').first().click()
  await page.waitForSelector('.check-row.flash', { timeout: 5_000 })
  await page.locator('.section-head').click()
  await page.waitForSelector('.data-section table', { timeout: 5_000 })
  console.log('EVIDENCE OK')
  await page.waitForTimeout(350)
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-answer.png') })

  // Accepting a risk is the user's call; it folds the finding and survives a reload.
  const encryption = page.locator('.finding-row', { hasText: 'No default encryption' }).first()
  await encryption.hover()
  await encryption.getByRole('button', { name: 'Accept risk' }).click()
  await page.waitForSelector('.fold-head:has-text("1 accepted")', { timeout: 5_000 })
  console.log('ACCEPT OK')

  // The user applies the fix outside the app; the agent re-reads that bucket only.
  await fetch(`http://127.0.0.1:${s3Port}/__fake/fix?bucket=demo-public`, { method: 'POST' })
  await page.locator('.composer textarea').fill('I applied the fix to demo-public')
  await page.keyboard.press('Enter')
  await page.waitForSelector('text=no longer public', { timeout: 60_000 })
  await page.waitForSelector('.fold.ok .fold-head', { timeout: 10_000 })
  const fixed = await page.locator('.fold.ok .fold-head').innerText()
  console.log('VERIFY OK:', fixed)
  if (await page.locator('.finding-row', { hasText: 'publicly accessible' }).count())
    await fail('a fixed finding is still on the page')
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-verified.png') })

  // A verdict naming a bucket no tool returned is corrected once, then marked.
  await page.getByRole('button', { name: 'New task' }).click()
  await page.locator('.composer textarea').fill('Is ghost-bucket exposed?')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.verdict code.ungrounded', { timeout: 60_000 })
  if (!seen.has('correction')) await fail('the harness did not ask for a grounded verdict')
  console.log('GROUNDING OK')

  await page.getByRole('button', { name: 'New task' }).click()
  await page.locator('.composer textarea').fill('Show the fix for demo-private')
  await page.keyboard.press('Enter')
  await page.waitForSelector('text=AWS CLI', { timeout: 60_000 })
  const fixBody = await page.locator('body').innerText()
  console.log('FIX OK')
  console.log(fixBody.slice(0, 900))
  await page.waitForTimeout(350)
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-fix.png') })

  await page.getByRole('button', { name: 'New task' }).click()
  await page.locator('.composer textarea').fill('Check demo-private again')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.check-line .pulse-icon', { timeout: 10_000 })
  await page.getByRole('button', { name: 'Stop' }).click()
  await page.waitForSelector('text=Stopped.', { timeout: 10_000 })
  console.log('STOP OK')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.waitForSelector('text=demo-public is publicly accessible', { timeout: 60_000 })
  console.log('CONTINUE OK')

  await page.locator('.sidebar-search input').click()
  await page.keyboard.type('public')
  await page.waitForSelector('.search-hit', { timeout: 10_000 })
  const hits = await page.locator('.search-hit').count()
  console.log('SEARCH HITS:', hits)
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-search.png') })
  await page.locator('.sidebar-search input').fill('abort rule')
  await page.waitForSelector('.search-hit:has-text("abort rule")', { timeout: 10_000 })
  await page.locator('.search-hit', { hasText: 'abort rule' }).first().click()
  await page.waitForSelector('.brief .verdict:has-text("abort rule")', { timeout: 10_000 })
  console.log('SEARCH OPEN OK')

  await page.locator('.sidebar-search input').fill('multipart')
  await page.waitForSelector('.search-hit:has-text("multipart")', { timeout: 10_000 })
  await page.locator('.search-hit', { hasText: 'multipart' }).first().click()
  await page.waitForSelector('.finding-row.flash', { timeout: 10_000 })
  console.log('SEARCH FINDING OK')

  // Read-only code mode: the rows are the data section, the script is the evidence.
  await page.getByRole('button', { name: 'New task' }).click()
  await page.locator('.composer textarea').fill('What are the largest prefixes in demo-public?')
  await page.keyboard.press('Enter')
  await page.waitForSelector('text=holds everything', { timeout: 60_000 })
  await page.waitForSelector('.composer .send.stop', { state: 'detached', timeout: 60_000 })
  await page.waitForSelector('.data-section table', { timeout: 10_000 })
  const firstCell = await page.locator('.data-section table tbody td').first().innerText()
  if (firstCell !== 'reports/') await fail(`query rows: ${firstCell}`)
  await page.locator('.checks-head').click()
  await page.locator('.check-line', { hasText: 'Ran a read-only query' }).click()
  await page.waitForSelector('.check-body pre.code:has-text("tools.list")', { timeout: 5_000 })
  if (await page.locator('.verdict code.ungrounded').count()) await fail('a grounded query verdict was marked')
  console.log('QUERY OK')
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-query.png') })

  // Keyboard: j moves between findings.
  await page.locator('.sidebar-search input').fill('public')
  await page.locator('.search-hit', { hasText: 'Which buckets are public?' }).first().click()
  await page.waitForSelector('.finding-main', { timeout: 10_000 })
  await page.locator('.finding-main').first().focus()
  await page.keyboard.press('j')
  const moved = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.finding-main')]
    return rows.indexOf(document.activeElement) === 1
  })
  if (!moved) await fail('j did not move to the next finding')
  console.log('KEYS OK')

  // Demo storage: an in-process account, offered once.
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Try with demo storage' }).click()
  await page.waitForSelector('.account-name:has-text("Demo storage")', { timeout: 5_000 })
  if (await page.getByRole('button', { name: 'Try with demo storage' }).count())
    await fail('the demo was offered twice')
  console.log('DEMO OK')
  await page.getByRole('button', { name: 'Close' }).click()

  const db = readFileSync(join(dataDir, 'storage-agent.db'))
  console.log('DB BYTES:', db.length)
} catch (error) {
  await fail(error.message)
} finally {
  await app.close()
  s3.kill()
  model.kill()
}
