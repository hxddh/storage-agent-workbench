/**
 * WCAG contrast guard for the two secondary text tokens. Components must use
 * tokens, so checking the token pairs catches the common regression without
 * pretending to audit every composed color.
 */
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8')
const blocks = [...css.matchAll(/:root(?:\[data-theme="dark"\])?\s*\{([\s\S]*?)\n\}/g)].map(
  (match) => match[1],
)
const tokens = (block) =>
  Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((match) => [
      match[1],
      match[2].toLowerCase(),
    ]),
  )
const light = tokens(blocks[0] ?? '')
const dark = tokens(blocks[1] ?? '')

function luminance(hex) {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
  const linear = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  )
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function ratio(a, b) {
  const [lightest, darkest] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (lightest + 0.05) / (darkest + 0.05)
}

const pairs = [
  ['light ink-3 on bg', light['ink-3'], light.bg],
  ['light ink-3 on surface', light['ink-3'], light.surface],
  ['dark ink-3 on bg', dark['ink-3'], dark.bg],
  ['dark ink-3 on surface', dark['ink-3'], dark.surface],
]
let failed = false
for (const [label, foreground, background] of pairs) {
  if (!foreground || !background) {
    console.error(`contrast: missing token for ${label}`)
    failed = true
    continue
  }
  const value = ratio(foreground, background)
  console.log(`${label}: ${value.toFixed(2)}:1`)
  if (value < 4.5) failed = true
}
if (failed) process.exit(1)
