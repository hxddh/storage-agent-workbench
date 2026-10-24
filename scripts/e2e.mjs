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

function start(script, port) {
  const child = spawn(process.execPath, [join(root, script), String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SLOW_MS: '350' },
  })
  child.stdout.on('data', (data) => process.stdout.write(`[${script}] ${data}`))
  child.stderr.on('data', (data) => process.stderr.write(`[${script}] ${data}`))
  return child
}

const s3 = start('scripts/fake-s3.mjs', s3Port)
const model = start('scripts/fake-model.mjs', modelPort)
await new Promise((resolve) => setTimeout(resolve, 600))

const app = await electron.launch({
  args: ['.', '--no-sandbox'],
  cwd: root,
  env: { ...process.env, STORAGE_AGENT_DATA_DIR: dataDir },
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
  await page.locator('input[type=checkbox]').check()
  const accountForm = page.locator('.account').last()
  await accountForm.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForTimeout(1000)
  const accounts = await page.locator('.account-name').count()
  console.log('ACCOUNTS:', accounts)
  if (accounts < 1) await fail('account was not saved')

  await page.getByRole('button', { name: 'Close' }).click()
  await page.locator('.composer textarea').fill('Which buckets are public?')
  await page.keyboard.press('Enter')

  await page.waitForSelector('.tool-row .pulse-icon', { timeout: 10_000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-running.png') })

  await page.waitForSelector('text=demo-public is publicly accessible', { timeout: 60_000 })
  const body = await page.locator('body').innerText()
  console.log('ANSWER OK')
  console.log(body.slice(0, 1200))
  await page.waitForTimeout(350)
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-answer.png') })

  await page.getByRole('button', { name: 'New task' }).click()
  await page.locator('.composer textarea').fill('Show the fix for demo-public')
  await page.keyboard.press('Enter')
  await page.waitForSelector('text=Prepared fix', { timeout: 60_000 })
  await page.locator('.tool-row', { hasText: 'Prepared fix' }).click()
  await page.waitForSelector('text=AWS CLI', { timeout: 20_000 })
  const fixBody = await page.locator('body').innerText()
  console.log('FIX OK')
  console.log(fixBody.slice(0, 900))
  await page.waitForTimeout(350)
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-fix.png') })

  await page.getByRole('button', { name: 'New task' }).click()
  await page.locator('.composer textarea').fill('Check demo-private again')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.tool-row .pulse-icon', { timeout: 10_000 })
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
  await page.locator('.search-hit').first().click()
  await page.waitForSelector('.entry-user', { timeout: 10_000 })
  console.log('SEARCH OPEN OK')

  const db = readFileSync(join(dataDir, 'storage-agent.db'))
  console.log('DB BYTES:', db.length)
} catch (error) {
  await fail(error.message)
} finally {
  await app.close()
  s3.kill()
  model.kill()
}
