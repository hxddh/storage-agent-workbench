/** The first paint is Home + Composer; lazy Markdown and Settings are not counted. */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

const dir = 'out/renderer/assets'
const files = readdirSync(dir).filter((name) => name.endsWith('.js'))
const lazy = (name) => /^(Settings|Run|Brief|Markdown)-/.test(name)
let initial = 0
let gzip = 0
let largest = 0
for (const file of files) {
  const size = statSync(join(dir, file)).size
  largest = Math.max(largest, size)
  if (lazy(file)) continue
  initial += size
  gzip += gzipSync(readFileSync(join(dir, file))).length
  console.log(`${file}: ${(size / 1024).toFixed(1)} KiB`)
}
const limit = 500 * 1024
console.log(
  `initial ${(initial / 1024).toFixed(1)} KiB raw, ${(gzip / 1024).toFixed(1)} KiB gzip; largest ${(largest / 1024).toFixed(1)} KiB`,
)
if (initial > limit) {
  console.error(`Initial renderer bundle is over ${limit / 1024} KiB.`)
  process.exit(1)
}
