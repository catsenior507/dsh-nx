/**
 * Live check: exercise the whole chain against a real NX.
 *
 * The unit tests pin the wire format and the selection rules against a fake
 * plugin; this script is the other half, and it needs a real install. It is kept
 * out of `npm test` because it starts a CAD application.
 *
 * Usage (PowerShell):
 *   $env:NX_AUTO_MCP_PATH = 'D:\path\to\nx-auto-mcp'
 *   $env:NX_ROOT          = 'D:\Program Files\Siemens\NX2412'   # optional, detected otherwise
 *   node scripts/live-check.mjs
 *
 * It launches NX when the port is closed and leaves it running: closing the
 * application is the operator's call, not a test's.
 */

import { resolveConfig } from '../lib/config.js'
import { registerTool } from '../lib/tool.js'

const nxAutoMcpPath = process.env.NX_AUTO_MCP_PATH ?? ''
if (nxAutoMcpPath === '') {
  console.error('set NX_AUTO_MCP_PATH to the nx-auto-mcp checkout (the folder containing plugin/)')
  process.exit(2)
}

const config = resolveConfig({
  nxAutoMcpPath,
  nxRoot: process.env.NX_ROOT ?? '',
  launchTimeoutMs: 240000,
})

let definition
registerTool({ register: (value) => (definition = value) }, config)

const show = (title, result) => {
  console.log('\n=== ' + title + ' ===')
  console.log(result.summary)
  console.log('verdict:', result.verdict, '| ok:', result.ok)
  for (const row of result.rows) console.log('  -', row.name, '|', row.verdict, '|', row.detail)
  for (const note of result.notes) console.log('  !', note)
}

const before = await definition.execute({ action: 'status' })
show('status', before)

if (before.verdict !== 'online') {
  show('launch', await definition.execute({ action: 'launch' }))
  await new Promise((resolve) => setTimeout(resolve, 3000))
  show('status (after launch)', await definition.execute({ action: 'status' }))
}

show('tools (filter: measure)', await definition.execute({ action: 'tools', filter: 'measure' }))
show('focus', await definition.execute({ action: 'focus' }))
show('capture', await definition.execute({ action: 'capture' }))
show('call nx_list_open_parts', await definition.execute({ action: 'call', tool: 'nx_list_open_parts', params: {} }))
