/**
 * Visual pass: drives the real window through the states that matter and
 * writes screenshots to .amp/in/artifacts.
 *
 *   node scripts/shots.mjs
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const root = new URL('..', import.meta.url).pathname
const dataDir = join(root, '.amp/in/e2e-data')
const out = join(root, '.amp/in/artifacts')
const s3Port = 9120
const modelPort = 9220

rmSync(dataDir, { recursive: true, force: true })

function start(script, port) {
  return spawn(process.execPath, [join(root, script), String(port)], { stdio: 'ignore' })
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
await page.waitForTimeout(1200)

async function configure() {
  await page.getByRole('button', { name: 'Set up a model' }).first().click()
  await page.locator('#modelId').fill('fake-model')
  await page.locator('#baseUrl').fill(`http://127.0.0.1:${modelPort}/v1`)
  await page.locator('#apiKey').fill('test-key')
  await page.getByRole('button', { name: 'Save', exact: true }).first().click()
  await page.waitForTimeout(400)
  await page.locator('#accName').fill('Demo')
  await page.locator('#accEndpoint').fill(`http://127.0.0.1:${s3Port}`)
  await page.locator('#accRegion').fill('us-east-1')
  await page.locator('#accKey').fill('demo-key')
  await page.locator('#accSecret').fill('demo-secret')
  await page.locator('input[type=checkbox]').check()
  await page.locator('.account').last().getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForTimeout(600)
}

await page.waitForTimeout(350)
  await page.screenshot({ path: join(out, '01-home-light.png') })
await configure()
await page.locator('.sheet-body').evaluate((element) => {
  element.scrollTop = 0
})
await page.waitForTimeout(350)
await page.screenshot({ path: join(out, '02-settings-light.png') })
await page.getByRole('button', { name: 'Close' }).click()
await page.locator('.composer textarea').fill('Which buckets are public?')
await page.keyboard.press('Enter')
await page.waitForSelector('text=demo-public is publicly accessible', { timeout: 60_000 })
await page.waitForTimeout(400)
await page.waitForTimeout(350)
  await page.screenshot({ path: join(out, '03-task-light.png') })

await page.locator('.tool-row').first().click()
await page.waitForTimeout(300)
await page.waitForTimeout(350)
  await page.screenshot({ path: join(out, '04-survey-light.png') })

await page.getByRole('button', { name: 'New task' }).click()
await page.locator('.composer textarea').fill('Which issues are open?')
await page.keyboard.press('Enter')
await page.waitForSelector('text=Checked memory', { timeout: 60_000 })
await page.locator('.tool-row').first().click()
await page.waitForTimeout(400)
await page.screenshot({ path: join(out, '05-estate-light.png') })

await page.getByRole('button', { name: 'Settings' }).click()
await page.getByRole('button', { name: 'Dark' }).click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: 'Close' }).click()
await page.waitForTimeout(400)
await page.waitForTimeout(350)
  await page.screenshot({ path: join(out, '06-task-dark.png') })

await page.getByRole('button', { name: 'New task' }).click()
await page.waitForTimeout(300)
await page.waitForTimeout(350)
  await page.screenshot({ path: join(out, '07-home-dark.png') })

await app.close()
s3.kill()
model.kill()
console.log('shots written to', out)
