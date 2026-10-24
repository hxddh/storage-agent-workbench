/** Cold start budget: the composer is usable within 1,000 ms (median of 3). */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const root = new URL('..', import.meta.url).pathname
const times = []
for (let run = 0; run < 3; run++) {
  const dataDir = mkdtempSync(join(tmpdir(), 'sa-perf-'))
  const started = performance.now()
  const app = await electron.launch({
    args: ['.', '--no-sandbox'],
    cwd: root,
    env: { ...process.env, STORAGE_AGENT_DATA_DIR: dataDir, STORAGE_AGENT_NO_UPDATE: '1' },
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.composer textarea', { state: 'visible', timeout: 10_000 })
  times.push(performance.now() - started)
  await app.close()
}
times.sort((a, b) => a - b)
const median = times[1]
console.log(`cold start to composer (3 runs): ${times.map((time) => Math.round(time)).join(', ')} ms; median ${Math.round(median)} ms`)
if (median > 1000) {
  console.error('Cold start is over the 1,000 ms budget.')
  process.exit(1)
}
