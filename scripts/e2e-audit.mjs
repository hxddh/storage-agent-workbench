/**
 * First-run proof: no model, no account.
 *
 * Everything the app reads, the agent reads, so without a model there is
 * nobody to ask. The window adds nothing on its own and runs nothing: it
 * offers to set up a model and add an account, and the composer waits.
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
  if (!(await page.locator('.composer textarea').isDisabled()))
    await fail('the composer accepted free-form input without a model')
  if ((await page.getByRole('button', { name: 'Set up a model' }).count()) === 0)
    await fail('the window does not point at setting up a model')
  if ((await page.getByRole('button', { name: 'Add an account' }).count()) === 0)
    await fail('the window does not offer to add an account')
  for (const gone of ['Check account', 'Try with demo storage'])
    if (await page.getByRole('button', { name: gone }).count()) await fail(`${gone} is offered`)
  if (await page.locator('.home-account').count()) await fail('an account appeared on its own')
  if (await page.locator('.conversation').count()) await fail('a conversation started on its own')
  if ((await page.locator('.task-row-wrap').count()) > 0) await fail('a task was created on its own')

  await page.screenshot({ path: out })
  console.log('NO-MODEL FIRST RUN OK: nothing added, nothing run, composer waits for a model')
} catch (error) {
  await fail(error.message)
} finally {
  await app.close()
}
