/**
 * First-run proof: no model, no account.
 *
 * Everything the app reads, the agent reads, so without a model there is
 * nobody to ask. The window offers the in-process demo account once; adding
 * it adds the account and starts nothing. The Composer stays disabled and the
 * window points at setting up a model.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const root = new URL('..', import.meta.url).pathname
const dataDir = mkdtempSync(join(tmpdir(), 'sa-e2e-audit-'))
const out = join(root, '.amp/in/artifacts/e2e-audit-no-model.png')

const app = await electron.launch({
  args: ['.', '--no-sandbox'],
  cwd: root,
  env: { ...process.env, STORAGE_AGENT_DATA_DIR: dataDir, STORAGE_AGENT_NO_UPDATE: '1' },
})
const page = await app.firstWindow()
const fail = async (message) => {
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(root, '.amp/in/artifacts/e2e-audit-failure.png') })
  console.error('FAIL:', message)
  console.error(await page.locator('body').innerText())
  await app.close()
  process.exit(1)
}

try {
  await page.waitForTimeout(1200)
  const demo = page.getByRole('button', { name: 'Try with demo storage' })
  if ((await demo.count()) !== 1) await fail('first run does not offer exactly one demo action')
  if (!(await page.locator('.composer textarea').isDisabled()))
    await fail('the composer accepted free-form input without a model')

  await demo.click()
  await page.waitForSelector('.home-account', { timeout: 30_000 })
  await page.waitForTimeout(800)
  if (await page.locator('.conversation').count())
    await fail('adding the demo without a model started a conversation')
  if ((await page.locator('.task-row-wrap').count()) > 0)
    await fail('adding the demo without a model created a task')
  if (await page.getByRole('button', { name: 'Check account' }).count())
    await fail('Check account is offered with nobody to ask')
  if (!(await page.locator('.composer textarea').isDisabled()))
    await fail('the composer accepted free-form input without a model')
  if ((await page.getByRole('button', { name: 'Set up a model' }).count()) === 0)
    await fail('the window does not point at setting up a model')

  await page.screenshot({ path: out })
  console.log('NO-MODEL FIRST RUN OK: demo added, nothing run, composer waits for a model')
} catch (error) {
  await fail(error.message)
} finally {
  await app.close()
}
