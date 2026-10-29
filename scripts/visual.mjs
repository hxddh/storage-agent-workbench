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
  '02a-settings-model.png',
  '02-settings-light.png',
  '02b-settings-appearance.png',
  '02c-settings-dark.png',
  '02d-settings-account-form.png',
  '02e-settings-methods.png',
  '02f-settings-memory.png',
  '03-task-light.png',
  '04-follow-up-light.png',
  '06-task-dark.png',
  '07-home-dark.png',
  '08-live-light.png',
  '09-task-compact.png',
  '10-sidebar-compact.png',
  '11-home-compact.png',
  '12-settings-compact.png',
  '13-memory-light.png',
  '14-change-light.png',
  '20-home-zh.png',
  '21-settings-error-zh.png',
  '23-tool-detail.png',
  '24-citation-open.png',
  '25-render-light.png',
  '26-agent-tool-light.png',
  '27-delegate-light.png',
  '28-chart-series-light.png',
]
let failed = 0
for (const name of names) {
  const before = join(baseline, name)
  const after = join(current, name)
  if (!existsSync(after)) {
    console.error(`${name}: capture missing; run scripts/shots.mjs first`)
    failed += 1
    continue
  }
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
  const pixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
    threshold: 0.1,
    // A diff mask keeps unchanged pixels fully transparent; the default diff
    // image paints them gray, which would mark every tile as a hot region.
    diffMask: true,
  })
  const ratio = pixels / (a.width * a.height)
  // A global percentage hides a small component vanishing in a large window.
  // In addition to the global budget, reject any 64px tile that is mostly
  // different: font rasterization is diffuse, a missing control is local.
  const tile = 64
  let hotTiles = 0
  for (let y = 0; y < a.height; y += tile) {
    for (let x = 0; x < a.width; x += tile) {
      let changed = 0
      const right = Math.min(x + tile, a.width)
      const bottom = Math.min(y + tile, a.height)
      for (let yy = y; yy < bottom; yy += 1) {
        for (let xx = x; xx < right; xx += 1) {
          const index = (yy * a.width + xx) * 4
          if (diff.data[index] !== 0 || diff.data[index + 1] !== 0 || diff.data[index + 2] !== 0)
            changed += 1
        }
      }
      // Font rasterization changes many pixels inside a line without moving
      // anything. A real missing/shifted control changes most of a tile.
      if (changed > 400 && changed / ((right - x) * (bottom - y)) > 0.4) hotTiles += 1
    }
  }
  if (ratio > 0.05 || hotTiles > 0) {
    console.error(
      `${name}: ${(ratio * 100).toFixed(2)}% pixels changed; ${hotTiles} hot region(s)`,
    )
    failed += 1
  } else {
    console.log(`${name}: ${(ratio * 100).toFixed(2)}% changed; no hot regions`)
  }
}
if (failed) process.exit(1)
