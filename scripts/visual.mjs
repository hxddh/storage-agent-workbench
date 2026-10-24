/**
 * Visual regression against tracked baselines.
 *
 *   xvfb-run -a node scripts/shots.mjs
 *   node scripts/visual.mjs             # compare
 *   node scripts/visual.mjs --update    # accept the current captures
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

const root = new URL('..', import.meta.url).pathname
const current = join(root, '.amp/in/artifacts')
const baseline = join(root, 'visual/baseline')
const update = process.argv.includes('--update')
mkdirSync(baseline, { recursive: true })

const names = [
  '01-home-light.png',
  '01b-home-configured-light.png',
  '02-settings-light.png',
  '03-task-light.png',
  '04-survey-light.png',
  '05-estate-light.png',
  '06-task-dark.png',
  '07-home-dark.png',
]
let failed = 0
for (const name of names) {
  const before = join(baseline, name)
  const after = join(current, name)
  if (!existsSync(after)) continue
  if (update || !existsSync(before)) {
    copyFileSync(after, before)
    console.log(`baseline ${name}`)
    continue
  }
  const a = PNG.sync.read(readFileSync(before))
  const b = PNG.sync.read(readFileSync(after))
  if (a.width !== b.width || a.height !== b.height) {
    console.error(`${name}: size changed ${a.width}x${a.height} -> ${b.width}x${b.height}`)
    failed += 1
    continue
  }
  const diff = new PNG({ width: a.width, height: a.height })
  const pixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 })
  const ratio = pixels / (a.width * a.height)
  if (ratio > 0.01) {
    console.error(`${name}: ${(ratio * 100).toFixed(2)}% pixels changed`)
    failed += 1
  } else {
    console.log(`${name}: ${(ratio * 100).toFixed(2)}% changed`)
  }
}
if (failed) process.exit(1)
