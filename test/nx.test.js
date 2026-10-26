/**
 * Tests for dsh-nx.
 *
 * The TCP layer is exercised against a fake plugin rather than a real NX: the wire
 * format is the contract that matters, and it can be pinned without a licence, a
 * desktop session, or a running CAD system. The deploy tests use temporary
 * directory trees for the same reason — what is being checked is the selection
 * rule, not whether this machine has NX.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { findNxRoot, resolveConfig } from '../lib/config.js'
import { callTool, listTools, ping, unwrap } from '../lib/tcp.js'
import { buildPlan, collectSources } from '../lib/deploy.js'
import { parseParams, registerTool, render } from '../lib/tool.js'
import { pickWindow } from '../lib/win.js'

/** Write a throwaway tree, returning its root. */
function tempTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nx-test-'))
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return root
}

/** Start a one-request-per-connection JSON server that mimics the plugin. */
async function fakePlugin(handler) {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const request = JSON.parse(buffer.slice(0, newline))
      socket.end(JSON.stringify(handler(request)) + '\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

test('resolveConfig fills defaults and clamps nonsense', () => {
  const defaults = resolveConfig(undefined)
  assert.equal(defaults.host, '127.0.0.1')
  assert.equal(defaults.port, 1977)
  assert.equal(defaults.windowTitle, 'NX - Gateway')
  assert.equal(defaults.callTimeoutMs, 180000)
  assert.equal(defaults.exposeTool, true)

  const clamped = resolveConfig({ port: 99999, callTimeoutMs: 5, host: '   ', exposeTool: false })
  assert.equal(clamped.port, 1977, 'out-of-range port falls back')
  assert.equal(clamped.callTimeoutMs, 180000, 'too-small timeout falls back')
  assert.equal(clamped.host, '127.0.0.1', 'blank host falls back')
  assert.equal(clamped.exposeTool, false)

  const custom = resolveConfig({ port: '1978', nxRoot: ' D:\\NX ' })
  assert.equal(custom.port, 1978)
  assert.equal(custom.nxRoot, 'D:\\NX', 'values are trimmed')
})

test('findNxRoot prefers the declared root, then the highest release', () => {
  const declared = tempTree({ 'NXBIN/ugraf.exe': '' })
  assert.equal(findNxRoot({ UGII_BASE_DIR: declared }), declared)

  const base = tempTree({
    'Siemens/NX2306/NXBIN/ugraf.exe': '',
    'Siemens/NX2412/NXBIN/ugraf.exe': '',
    'Siemens/NXWhatever/NXBIN/ugraf.exe': '',
  })
  const found = findNxRoot({ ProgramFiles: base })
  assert.equal(path.basename(found), 'NX2412', 'the newest release wins, and non-numeric names are ignored')
})

test('findNxRoot returns empty when nothing is installed', () => {
  assert.equal(findNxRoot({ ProgramFiles: tempTree({}) }), '')
})

test('the TCP client speaks the plugin wire format', async () => {
  const { server, port } = await fakePlugin((request) => {
    if (request.method === 'ping') {
      return { id: request.id, result: { pong: true, version: '0.4.0', tool_count: 123, timestamp: 't' } }
    }
    if (request.method === 'list_tools') {
      return { id: request.id, result: { tools: [{ name: 'nx_extrude' }] } }
    }
    if (request.method === 'tool') {
      // The plugin flattens arguments under the tool name, not under `params`.
      assert.equal(request.params.tool, 'nx_measure_volume')
      assert.equal(request.params.body, 'BODY_1')
      return { id: request.id, result: { success: true, message: 'ok', data: { volume_mm3: 1 }, warnings: [] } }
    }
    return { id: request.id, error: { message: 'unknown method' } }
  })
  const config = resolveConfig({ port, callTimeoutMs: 3000 })
  try {
    const info = await ping(config)
    assert.equal(info.result.tool_count, 123)

    const inventory = await listTools(config)
    assert.equal(inventory.result.tools.length, 1)

    const reply = await callTool(config, 'nx_measure_volume', { body: 'BODY_1' })
    assert.equal(unwrap(reply).success, true)
    assert.equal(unwrap(reply).data.volume_mm3, 1)
  } finally {
    server.close()
  }
})

test('the TCP client reports an unreachable port without hanging', async () => {
  const config = resolveConfig({ port: 9, callTimeoutMs: 1000 })
  await assert.rejects(() => ping(config), /cannot reach|no reply/)
})

test('unwrap projects both failure shapes into one', () => {
  assert.deepEqual(unwrap({ error: { message: 'boom' } }), { success: false, message: 'boom', data: {}, warnings: [] })
  assert.deepEqual(unwrap({ result: { success: false, message: 'no work part' } }), {
    success: false,
    message: 'no work part',
    data: {},
    warnings: [],
  })
  assert.equal(unwrap({ result: { data: {} } }).success, true, 'a result with no explicit flag is a success')
  assert.equal(unwrap({}).success, false, 'a reply with no result is a failure, not a quiet pass')
})

test('collectSources mirrors the build script skip list', () => {
  const root = tempTree({
    'A.cs': '',
    'tools/B.cs': '',
    'nested/deep/C.cs': '',
    'scripts/D.cs': '',
    'node_modules/E.cs': '',
    'journal/F.cs': '',
    'bridge.bak/G.cs': '',
    'notes.txt': 'not a source',
  })
  const names = collectSources(root).map((file) => path.basename(file)).sort()
  assert.deepEqual(names, ['A.cs', 'B.cs', 'C.cs'])
})

test('buildPlan references the local NX SDK and the framework', () => {
  const paths = {
    sdkDir: 'C:\\NX\\NXBIN\\managed',
    signingResource: 'C:\\NX\\UGOPEN\\NXSigningResource.res',
  }
  const plan = buildPlan(paths)
  assert.equal(path.basename(plan.csc), 'csc.exe')
  assert.ok(plan.refs.some((ref) => ref.endsWith('NXOpen.dll')))
  assert.ok(plan.refs.some((ref) => ref.endsWith('Newtonsoft.Json.dll')))
  assert.ok(plan.refs.every((ref) => path.isAbsolute(ref)))
})

test('parseParams accepts an object, a JSON string, and rejects rubbish', () => {
  assert.deepEqual(parseParams({ a: 1 }), { a: 1 })
  assert.deepEqual(parseParams('{"a":1}'), { a: 1 })
  assert.deepEqual(parseParams(undefined), {})
  assert.throws(() => parseParams('{a:1}'), /not valid JSON/)
  assert.throws(() => parseParams('[1,2]'), /must be a JSON object/)
})

test('the tool schema exposes every action and requires one', () => {
  let definition
  const tools = { register: (value) => (definition = value) }
  registerTool(tools, resolveConfig({}))
  assert.equal(definition.name, 'nx')
  assert.deepEqual(definition.parameters.properties.action.enum, ['status', 'call', 'tools', 'launch', 'focus', 'capture', 'deploy'])
  assert.deepEqual(definition.parameters.required, ['action'])
})

test('render puts the summary first and marks notes', () => {
  const text = render({}, {
    action: 'status',
    summary: 'NX is up.',
    verdict: 'online',
    ok: true,
    rows: [{ name: 'port', verdict: 'listening', detail: '127.0.0.1:1977' }],
    notes: ['watch the window'],
  })[0].text
  assert.match(text, /^nx status: NX is up\./)
  assert.match(text, /port {2}\| {2}listening {2}— {2}127\.0\.0\.1:1977/)
  assert.match(text, /! watch the window/)
})

test('call rejects a tool name the MCP adapter would also reject', async () => {
  let definition
  registerTool({ register: (value) => (definition = value) }, resolveConfig({}))
  await assert.rejects(() => definition.execute({ action: 'call', tool: 'extrude' }), /does not start with nx_/)
  await assert.rejects(() => definition.execute({ action: 'call' }), /requires tool/)
})

test(
  'status reads the live chain against a fake plugin',
  { skip: process.platform !== 'win32' },
  async () => {
    const { server, port } = await fakePlugin((request) => ({
      id: request.id,
      result: { pong: true, version: '0.4.0', tool_count: 123, timestamp: '2026-01-01T00:00:00Z' },
    }))
    const config = resolveConfig({ port, callTimeoutMs: 3000 })
    let definition
    registerTool({ register: (value) => (definition = value) }, config)
    try {
      const result = await definition.execute({ action: 'status' })
      const byName = Object.fromEntries(result.rows.map((entry) => [entry.name, entry]))
      assert.equal(byName.port.verdict, 'listening')
      assert.equal(byName.plugin.verdict, 'answering')
      assert.match(byName.plugin.detail, /123 tool/)
      assert.equal(result.verdict, 'online')
      assert.equal(result.ok, true)
      assert.equal(byName.deployment.verdict, 'unknown', 'an unconfigured package is unknown, not failed')
    } finally {
      server.close()
    }
  },
)

test('pickWindow never invents an NX window', () => {
  const win = (title, pid, visible = true) => ({ handle: '1', pid, title, visible, iconic: false })
  const windows = [
    win('NX - Gateway', 100),
    win('UG 插件 nx-auto-mcp 调研 — DeepSeek Harness', 200),
    win('NX', 300),
  ]

  assert.equal(pickWindow(windows, { pids: [100], titleFragment: 'NX - Gateway' }).title, 'NX - Gateway')
  assert.equal(
    pickWindow(windows, { pids: [300], titleFragment: 'NX - Gateway' }).title,
    'NX',
    'process ownership outranks the title: NX is titled "NX" at the gateway',
  )
  assert.equal(
    pickWindow(windows, { pids: [999], titleFragment: 'NX - Gateway' }),
    null,
    'a pid that owns nothing must not fall back to some other window',
  )
  assert.equal(
    pickWindow(windows, { pids: [], titleFragment: 'Siemens' }),
    null,
    'without a pid the title is the only evidence, so a non-match is not a candidate',
  )
  assert.equal(pickWindow(windows, { pids: [], titleFragment: 'deepseek harness' }).pid, 200, 'title matching is case-insensitive')
  assert.equal(pickWindow([], { pids: [], titleFragment: 'NX' }), null)
  assert.equal(pickWindow([{ pid: 1, title: '   ', visible: true }], { pids: [1] }), null, 'untitled windows are not candidates')
})

test('pickWindow prefers a visible window of the same process', () => {
  const hidden = { handle: '1', pid: 7, title: 'NX hidden helper', visible: false, iconic: false }
  const shown = { handle: '2', pid: 7, title: 'NX', visible: true, iconic: false }
  assert.equal(pickWindow([hidden, shown], { pids: [7] }).handle, '2')
})