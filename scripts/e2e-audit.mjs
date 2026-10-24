/**
 * First-run proof: no model, no account, one click.
 *
 * The window must add the in-process demo account, run the deterministic
 * account check, and render a brief whose sentences come only from the reading.
 * The Composer stays disabled because free-form questions still need a model.
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
  const check = page.getByRole('button', { name: 'Check account' })
  if ((await check.count()) !== 1) await fail('first run does not offer exactly one account check')

  await check.click()
  await page.waitForSelector('.brief .verdict', { timeout: 120_000 })
  const text = await page.locator('.brief').innerText()
  if (!/issue|problem|No open|could not read/i.test(text)) await fail('audit produced no conclusion')
  if (await page.locator('.verdict code.ungrounded').count())
    await fail('a model-free verdict named something no check returned')
  if (!(await page.locator('.composer textarea').isDisabled()))
    await fail('the composer accepted free-form input without a model')
  if ((await page.locator('.brief .finding-main').count()) === 0)
    await fail('the demo account produced no findings')

  await page.screenshot({ path: out })
  console.log('NO-MODEL AUDIT OK:', text.replace(/\s+/g, ' ').slice(0, 180))
} catch (error) {
  await fail(error.message)
} finally {
  await app.close()
}
