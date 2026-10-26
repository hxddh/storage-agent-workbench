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
  return spawn(process.execPath, [join(root, script), String(port)], {
    stdio: 'ignore',
    env: { ...process.env, SLOW_MS: '650' },
  })
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
await page.waitForTimeout(1200)

async function configure() {
  await page.getByRole('button', { name: 'Set up a model' }).first().click()
  await page.waitForTimeout(350)
  await page.screenshot({ path: join(out, '02a-settings-model.png') })
  await page.locator('#modelId').fill('fake-model')
  await page.locator('#baseUrl').fill(`http://127.0.0.1:${modelPort}/v1`)
  await page.locator('#apiKey').fill('test-key')
  await page.getByRole('button', { name: 'Save', exact: true }).first().click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(out, '02d-settings-account-form.png') })
  await page.locator('#accName').fill('Demo')
  await page.locator('#accEndpoint').fill(`http://127.0.0.1:${s3Port}`)
  await page.locator('#accRegion').fill('us-east-1')
  await page.locator('#accKey').fill('demo-key')
  await page.locator('#accSecret').fill('demo-secret')
  await page.getByLabel('Path-style addressing').check()
  await page.locator('.account').last().getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForTimeout(600)
}

await page.waitForTimeout(350)
  await page.screenshot({ path: join(out, '01-home-light.png') })
await configure()
await page.locator('.settings-content').evaluate((element) => {
  element.scrollTop = 0
})
await page.waitForTimeout(350)
await page.screenshot({ path: join(out, '02-settings-light.png') })
await page.getByRole('button', { name: 'Done' }).click()
await page.waitForSelector('.home-ledger-row', { timeout: 5_000 })
await page.waitForTimeout(350)
await page.screenshot({ path: join(out, '01b-home-configured-light.png') })
await page.locator('.composer textarea').fill('Which buckets are public?')
await page.keyboard.press('Enter')
await page.waitForSelector('.run-block .table-block table', { timeout: 60_000 })
await page.waitForTimeout(400)
await page.waitForTimeout(350)
  await page.screenshot({ path: join(out, '03-task-light.png') })

await page.locator('.run-evidence-toggle').click()
await page.waitForSelector('.run-evidence-wrap', { timeout: 2000 })
await page.locator('.checks-head').click()
await page.waitForSelector('.check-line', { timeout: 2000 })
await page.locator('.run-evidence-wrap').scrollIntoViewIfNeeded()
await page.waitForTimeout(350)
  await page.screenshot({ path: join(out, '04-survey-light.png') })

await page.getByRole('button', { name: 'New task' }).click()
await page.locator('.composer textarea').fill('Which issues are open?')
await page.keyboard.press('Enter')
await page.waitForSelector('text=Eight issues are open', { timeout: 60_000 })
await page.waitForTimeout(400)
await page.screenshot({ path: join(out, '05-estate-light.png') })

await page.getByRole('button', { name: 'New task' }).click()
await page.locator('.composer textarea').fill('What history do you remember?')
await page.keyboard.press('Enter')
await page.waitForSelector('text=The history records', { timeout: 60_000 })
await page.waitForTimeout(400)
await page.waitForSelector('.run-timeline', { timeout: 5_000 })
await page.locator('.run-timeline').scrollIntoViewIfNeeded()
await page.waitForTimeout(350)
await page.screenshot({ path: join(out, '13-history-light.png') })

await page.getByRole('button', { name: 'Settings' }).click()
await page.getByRole('button', { name: 'Appearance', exact: true }).click()
await page.waitForTimeout(350)
await page.screenshot({ path: join(out, '02b-settings-appearance.png') })
await page.getByRole('button', { name: 'Dark' }).click()
await page.waitForTimeout(400)
await page.screenshot({ path: join(out, '02c-settings-dark.png') })
await page.getByRole('button', { name: 'Done' }).click()
await page.waitForTimeout(400)
await page.waitForTimeout(350)
  await page.screenshot({ path: join(out, '06-task-dark.png') })

await page.getByRole('button', { name: 'New task' }).click()
await page.waitForTimeout(300)
await page.waitForTimeout(350)
  await page.screenshot({ path: join(out, '07-home-dark.png') })

// The live state must read as work in progress, not a finished brief.
await page.getByRole('button', { name: 'Settings' }).click()
await page.getByRole('button', { name: 'Appearance', exact: true }).click()
await page.getByRole('button', { name: 'Light', exact: true }).click()
await page.getByRole('button', { name: 'Done' }).click()
await page.waitForTimeout(350)
await page.locator('.composer textarea').fill('Which buckets are public?')
await page.keyboard.press('Enter')
await page.waitForSelector('.run-strip', { timeout: 5000 })
await page.waitForTimeout(450)
await page.screenshot({ path: join(out, '08-live-light.png') })
await page.waitForSelector('.composer .send.stop', { state: 'detached', timeout: 60_000 })

// One deterministic change plan, then the same task re-verified against it.
await page.getByRole('button', { name: 'New task' }).click()
await page.locator('.composer textarea').fill('Show the fix for demo-private')
await page.keyboard.press('Enter')
await page.waitForSelector('.plan', { timeout: 60_000 })
await page.locator('.plan').scrollIntoViewIfNeeded()
await page.waitForTimeout(350)
await page.screenshot({ path: join(out, '14-plan-light.png') })
await page.getByRole('button', { name: 'More actions' }).click()
await page.getByRole('menuitem', { name: 'Re-verify' }).click()
await page.waitForSelector('.reverify-plan', { timeout: 30_000 })
const planReverify = await page.locator('.reverify-plan').innerText()
console.log('PLAN REVERIFY:', planReverify.replace(/\s+/g, ' ').slice(0, 200))
await page.locator('.reverify-section').scrollIntoViewIfNeeded()
await page.screenshot({ path: join(out, '15-plan-reverified.png') })

// Narrow window: navigation must stay reachable from Home, not only tasks.
await app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0]?.setSize(760, 820)
})
await page.waitForTimeout(400)
await page.screenshot({ path: join(out, '09-task-compact.png') })
await page.getByRole('button', { name: 'Tasks' }).click()
await page.waitForTimeout(250)
await page.screenshot({ path: join(out, '10-sidebar-compact.png') })
await page.locator('.sidebar-close').click()
await page.getByRole('button', { name: 'Tasks' }).click()
await page.getByRole('button', { name: 'New task' }).click()
await page.waitForTimeout(350)
await page.screenshot({ path: join(out, '11-home-compact.png') })
await page.getByRole('button', { name: 'Tasks' }).click()
await page.getByRole('button', { name: 'Settings' }).click()
await page.waitForTimeout(350)
await page.screenshot({ path: join(out, '12-settings-compact.png') })

await app.close()
s3.kill()
model.kill()
console.log('shots written to', out)
