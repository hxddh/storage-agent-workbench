/**
 * Storage Agent as an MCP server, end to end: start the built app headless
 * with --mcp, connect over stdio as another agent would, list the tools and
 * call one.
 *
 *   npm run build && xvfb-run -a node scripts/mcp-smoke.mjs
 */
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const require = createRequire(import.meta.url)
const electron = require('electron')
const root = new URL('..', import.meta.url).pathname
const dataDir = mkdtempSync(join(tmpdir(), 'sa-mcp-'))

const fail = (message) => {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

const transport = new StdioClientTransport({
  command: electron,
  args: [root, '--mcp', '--no-sandbox'],
  env: { ...process.env, STORAGE_AGENT_DATA_DIR: dataDir, STORAGE_AGENT_NO_UPDATE: '1' },
  stderr: 'inherit',
})
const client = new Client({ name: 'mcp-smoke', version: '1.0.0' })
const timer = setTimeout(() => fail('the server did not answer within 60 s'), 60_000)
await client.connect(transport)
const { tools } = await client.listTools()
const names = tools.map((tool) => tool.name).sort()
if (names.join(',') !== 'call,more,probe,query,workspace') fail(`unexpected tools: ${names.join(', ')}`)
console.log('MCP TOOLS OK:', names.join(', '))
const listed = await client.callTool({ name: 'workspace', arguments: { action: 'list' } })
const text = listed.content.map((part) => part.text ?? '').join('')
if (!/untrusted-data-[0-9a-f]{12}/.test(text)) fail(`no envelope: ${text.slice(0, 200)}`)
console.log('MCP CALL OK')
const write = await client.callTool({ name: 'workspace', arguments: { action: 'write', path: 'x.md', content: 'x' } })
if (!write.isError) fail('a workspace write ran over MCP')
console.log('MCP READ-ONLY OK')
clearTimeout(timer)
await client.close()
process.exit(0)
