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
  await page.locator('#accName').fill('Prod')
  await page.locator('#accEndpoint').fill(`http://127.0.0.1:${s3Port}`)
  await page.locator('#accRegion').fill('us-east-1')
  await page.locator('#accKey').fill('logs-key')
  await page.locator('#accSecret').fill('logs-secret')
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
await page.getByRole('button', { name: 'Close settings' }).click()
await page.waitForSelector('.home-account', { timeout: 5_000 })
await page.waitForTimeout(350)
await page.screenshot({ path: join(out, '01b-home-configured-light.png') })
/** Send a message and wait for the agent to finish its turn. */
async function say(text) {
  await page.locator('.composer textarea').fill(text)
  await page.keyboard.press('Enter')
  await page.waitForFunction(
    (request) => [...document.querySelectorAll('.msg.user')].at(-1)?.textContent?.startsWith(request),
    text,
    { timeout: 60_000 },
  )
  await page.waitForSelector('.composer .send.stop', { state: 'detached', timeout: 60_000 })
  await page.waitForTimeout(350)
}

/** Open one call in the conversation by its label. */
async function openStep(label) {
  const row = page.locator('.step.tool', { hasText: label }).last()
  if ((await row.locator('.step-line').getAttribute('aria-expanded')) === 'false')
    await row.locator('.step-line').click()
  await row.locator('.step-detail').waitFor({ timeout: 5_000 })
  return row
}

await say('Which buckets are public?')
await page.locator('.scroll').evaluate((element) => {
  element.scrollTop = 0
})
await page.waitForTimeout(350)
await page.screenshot({ path: join(out, '03-task-light.png') })

// A citation opens the call it names, in place in the conversation.
await page.locator('.msg.agent.text .cite').first().click()
await page.waitForSelector('.step-detail', { timeout: 5_000 })
await page.waitForTimeout(400)
await page.screenshot({ path: join(out, '24-citation-open.png') })
await page.locator('.step.tool .step-line[aria-expanded="true"]').first().click()

await (await openStep('Read')).scrollIntoViewIfNeeded()
await page.waitForTimeout(250)
await page.screenshot({ path: join(out, '23-tool-detail.png') })

// A follow-up is the next message in the same conversation.
await say('Who can read web-assets?')
await page.waitForTimeout(250)
await page.screenshot({ path: join(out, '04-follow-up-light.png') })

// What the agent noted in one task, it knows in the next.
await page.getByRole('button', { name: 'New task' }).click()
await say('What did you find last time?')
await page.screenshot({ path: join(out, '13-memory-light.png') })

await page.getByRole('button', { name: 'Settings' }).click()
await page.getByRole('button', { name: 'Appearance', exact: true }).click()
await page.waitForTimeout(350)
await page.screenshot({ path: join(out, '02b-settings-appearance.png') })
await page.getByRole('button', { name: 'Dark' }).click()
await page.waitForTimeout(400)
await page.screenshot({ path: join(out, '02c-settings-dark.png') })
await page.getByRole('button', { name: 'Close settings' }).click()
await page.waitForTimeout(400)
await page.waitForTimeout(350)
  await page.screenshot({ path: join(out, '06-task-dark.png') })

await page.getByRole('button', { name: 'New task' }).click()
await page.waitForTimeout(300)
await page.waitForTimeout(350)
  await page.screenshot({ path: join(out, '07-home-dark.png') })

// The live state must read as the agent working.
await page.getByRole('button', { name: 'Settings' }).click()
await page.getByRole('button', { name: 'Appearance', exact: true }).click()
await page.getByRole('button', { name: 'Light', exact: true }).click()
await page.getByRole('button', { name: 'Close settings' }).click()
await page.waitForTimeout(350)
await page.locator('.composer textarea').fill('Which buckets are public?')
await page.keyboard.press('Enter')
await page.waitForSelector('.run-strip', { timeout: 5000 })
await page.waitForTimeout(450)
await page.screenshot({ path: join(out, '08-live-light.png') })
await page.waitForSelector('.composer .send.stop', { state: 'detached', timeout: 60_000 })

// A change is the agent's own text, for the user to apply.
await page.getByRole('button', { name: 'New task' }).click()
await say('Give me the fix for data-lake')
await page.locator('.msg.agent.text pre').last().scrollIntoViewIfNeeded()
await page.waitForTimeout(350)
await page.screenshot({ path: join(out, '14-change-light.png') })

// Narrow window: navigation must stay reachable from Home, not only tasks.
await app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0]?.setSize(760, 820)
})
await page.locator('.scroll').evaluate((element) => {
  element.scrollTop = 0
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

// Chinese task and a visible model-test error are part of the UI contract.
await page.getByRole('button', { name: 'Appearance', exact: true }).click()
await page.getByRole('button', { name: '简体中文', exact: true }).click()
await page.getByRole('button', { name: '关闭设置' }).click()
await app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0]?.setSize(1180, 820)
})
await page.waitForTimeout(350)
await page.screenshot({ path: join(out, '20-home-zh.png') })

await page.getByRole('button', { name: '设置' }).click()
await page.getByRole('button', { name: '模型', exact: true }).click()
await page.locator('#baseUrl').fill('http://127.0.0.1:1/v1')
await page.getByRole('button', { name: '测试', exact: true }).click()
await page.waitForSelector('.error-text', { timeout: 4_000 }).catch(() => undefined)
await page.screenshot({ path: join(out, '21-settings-error-zh.png') })

await app.close()
s3.kill()
model.kill()
console.log('shots written to', out)
