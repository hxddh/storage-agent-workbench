/**
 * First-run proof: no model, no account, one click.
 *
 * The window must offer the in-process demo account explicitly, run the
 * deterministic account check, and render a run whose sentences come only
 * from the reading. The Composer stays disabled because free-form questions
 * still need a model.
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

  await demo.click()
  await page.waitForSelector('.run-answer .verdict', { timeout: 120_000 })
  const text = await page.locator('.brief').innerText()
  if (!/risk|problem|No open|could not be read/i.test(text))
    await fail('audit produced no conclusion')
  const scope = await page.locator('.run-scope').innerText()
  if (!/open questions?|Not fully checked/.test(scope) || !/blocked/.test(scope))
    await fail(`partial reads are not named in the scope line: ${scope}`)
  if (await page.locator('.run-answer .verdict code.ungrounded').count())
    await fail('a model-free verdict named something no check returned')
  if (!(await page.locator('.composer textarea').isDisabled()))
    await fail('the composer accepted free-form input without a model')
  await page.locator('.run-evidence-button', { hasText: 'Findings' }).click()
  await page.waitForSelector('.run-finding-line', { timeout: 5_000 })
  if ((await page.locator('.run-finding-main').count()) === 0)
    await fail('the demo account produced no risks')

  await page.screenshot({ path: out })
  console.log('NO-MODEL AUDIT OK:', text.replace(/\s+/g, ' ').slice(0, 180))
} catch (error) {
  await fail(error.message)
} finally {
  await app.close()
}
