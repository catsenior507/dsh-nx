/**
 * dsh-nx, the model-facing tool.
 *
 * One tool, `nx`, because the actions share a single subject: the state of the
 * NX ⟷ nx-auto-mcp chain. Splitting them would put status, launch, focus and
 * deploy in four places the model has to discover separately, when the whole
 * point is that they are read in sequence — you cannot call a tool before the
 * port is open, and you cannot screenshot a minimized window.
 *
 * The actions answer questions the MCP server cannot:
 *
 * - `status` — the load chain outside the process: process, port, plugin version,
 *   deployed DLL, signature, syslog evidence, window state.
 * - `call` — one tool call straight to the plugin, bypassing the MCP client's
 *   connect-time tool snapshot.
 * - `tools` — the live inventory, for the same reason.
 * - `launch` — start NX with the two environment variables the plugin needs, then
 *   wait for the port instead of assuming a delay.
 * - `focus` — restore and foreground the NX window. A minimized NX exports an
 *   empty PNG and calls it a success.
 * - `capture` — focus, then screenshot, then confirm the file exists.
 * - `deploy` — compile, sign, install the managed plugin, and say which of the
 *   three failed.
 *
 * @module @dsh-external/dsh-nx/tool
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { deployedDllPath, resolvePaths } from './config.js'
import { compile, install, sign, verifySignature } from './deploy.js'
import { callTool, listTools, ping, unwrap } from './tcp.js'
import { findProcess, newestSyslog, portOpen, readTail, scanSyslog, tempDirectory, windowState } from './win.js'

/** The model-facing tool name. */
export const TOOL_NAME = 'nx'

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'call', 'tools', 'launch', 'focus', 'capture', 'deploy'],
      description:
        'status inspects the whole chain (process, port, plugin, deployed DLL, signature, syslog, window) and is the honest answer to "why is nx_* not working". call runs one plugin tool over TCP, bypassing the MCP tool snapshot. tools lists the live inventory. launch starts NX with the plugin environment and waits for the port. focus restores and foregrounds the NX window. capture focuses then screenshots, because a minimized NX writes an empty image. deploy compiles, signs and installs the managed plugin.',
    },
    tool: {
      type: 'string',
      description: 'For action=call: the plugin tool name, e.g. nx_measure_volume. Names must start with nx_.',
    },
    params: {
      type: 'object',
      description: 'For action=call: the tool arguments. Pass an object; a JSON string is also accepted.',
      additionalProperties: true,
    },
    filter: {
      type: 'string',
      description: 'For action=tools: case-insensitive substring matched against tool names and descriptions.',
    },
    imagePath: {
      type: 'string',
      description: 'For action=capture: where to write the PNG. Defaults to a timestamped file in the temp directory.',
    },
    fit: {
      type: 'boolean',
      description: 'For action=capture: fit the view before shooting (default true), so the image contains the model instead of whatever orientation was last used.',
    },
    sign: {
      type: 'boolean',
      description: 'For action=deploy: attempt SignDotNet after compiling (default true). Signing needs the DotNet author licence; NX may still load the DLL when the runtime licence is present.',
    },
  },
  required: ['action'],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string' },
    summary: { type: 'string' },
    verdict: { type: 'string' },
    ok: { type: 'boolean' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          verdict: { type: 'string' },
          detail: { type: 'string' },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
    data: { type: 'object', additionalProperties: true },
  },
  required: ['action', 'summary', 'verdict', 'ok', 'rows', 'notes'],
}

const DESCRIPTION = [
  'Inspect and drive the Siemens NX ⟷ nx-auto-mcp chain from outside NX.',
  'Start with action=status: it reports the process, the TCP 1977 listener, the plugin version and tool count, the deployed DLL, whether that DLL is signed, what the newest NX syslog says about loading it, and the window state — in one call, with each row either observed or explicitly unknown.',
  'Use action=call to run a plugin tool directly over TCP. This bypasses the MCP client, which pulls its tool list once at connect time and never refreshes: a freshly deployed tool is invisible there but callable here.',
  'action=launch starts ugraf.exe with UGII_CUSTOM_DIRECTORY_FILE and UGII_USER_DIR set, then polls the port instead of sleeping. action=focus restores and foregrounds the NX window, and action=capture focuses before screenshotting, because a minimized NX exports an empty PNG and reports success.',
  'action=deploy compiles plugin/**/*.cs with the .NET Framework compiler against the local NXOpen assemblies, attempts SignDotNet, and copies the result into plugin/startup. It reports compile, sign and install separately: NX loads unsigned managed plugins only when the runtime DotNet author licence is present, so a signing failure is a fact to report, not a step to hide.',
].join(' ')

/** One output row, fully populated so the schema never sees undefined. */
function row(name, verdict, detail) {
  return { name, verdict, detail }
}

/** Truncate long text for a row, keeping the distinctive head. */
function clip(text, limit = 160) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : flat.slice(0, limit - 1) + '…'
}

/** Parse the params argument, accepting either an object or a JSON string. */
export function parseParams(raw) {
  if (raw === null || raw === undefined) return {}
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error('nx: params is not valid JSON — ' + (error instanceof Error ? error.message : String(error)))
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('nx: params must be a JSON object')
  }
  return parsed
}

/** Human byte size. */
function bytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(2) + ' MB'
}

/**
 * The health chain.
 *
 * Rows are ordered by dependency: a closed port makes the plugin row unknown
 * rather than failed, because nothing was learned about the plugin itself.
 */
async function status(config) {
  const paths = resolvePaths(config)
  const rows = []
  const notes = []
  const data = {
    paths: {
      nxRoot: paths.nxRoot,
      exePath: paths.exePath,
      customDirsFile: paths.customDirsFile,
      userDir: paths.userDir,
      package: config.nxAutoMcpPath,
      deployedDll: deployedDllPath(config),
    },
  }

  const process = await findProcess('ugraf.exe')
  rows.push(
    row(
      'process',
      process.running ? 'running' : 'stopped',
      process.running ? `ugraf.exe pid ${process.pids.join(', ')}` : 'no ugraf.exe in the process list',
    ),
  )

  const listening = await portOpen(config.host, config.port)
  rows.push(row('port', listening ? 'listening' : 'closed', `${config.host}:${config.port}`))

  let plugin = null
  if (listening) {
    try {
      const reply = await ping(config)
      plugin = reply?.result ?? null
      rows.push(row('plugin', plugin?.version ? 'answering' : 'unexpected reply', plugin === null ? 'ping returned no result' : `${plugin.version} · ${plugin.tool_count} tool(s) · ${plugin.timestamp ?? ''}`))
    } catch (error) {
      rows.push(row('plugin', 'no reply', error instanceof Error ? error.message : String(error)))
    }
  } else {
    rows.push(row('plugin', 'unknown', 'not queried: the port is closed, so this says nothing about the plugin'))
  }

  const dll = deployedDllPath(config)
  if (dll === '') {
    rows.push(row('deployment', 'unknown', 'nxAutoMcpPath is not configured, so there is no package to inspect'))
  } else if (!fs.existsSync(dll)) {
    rows.push(row('deployment', 'missing', dll + ' does not exist; run action=deploy'))
  } else {
    const stat = fs.statSync(dll)
    rows.push(row('deployment', 'present', `${dll} · ${bytes(stat.size)} · built ${stat.mtime.toISOString()}`))
    data.deployedDll = { path: dll, bytes: stat.size, builtAt: stat.mtime.toISOString() }
  }

  if (dll !== '' && fs.existsSync(dll) && paths.signTool !== '' && fs.existsSync(paths.signTool)) {
    const verdict = await verifySignature(config, paths, dll)
    rows.push(row('signature', verdict.ok ? 'valid' : 'not signed', verdict.detail))
    if (!verdict.ok) {
      notes.push(
        'The DLL is unsigned. NX only loads it when the runtime DotNet author licence is present (the syslog then says "DotNet author license is present. Authentication passed"). Signing itself needs the author licence granted to SignDotNet, which is a different grant.',
      )
    }
  } else {
    rows.push(row('signature', 'unknown', 'not checked: no deployed DLL or no SignDotNet.exe'))
  }

  const syslog = newestSyslog(tempDirectory())
  if (syslog === null) {
    rows.push(row('syslog', 'absent', 'no *.syslog in ' + tempDirectory()))
  } else {
    const evidence = scanSyslog(readTail(syslog.path))
    data.syslog = { path: syslog.path, ...evidence }
    let verdictText = 'no load evidence'
    if (evidence.loaded) verdictText = 'loaded'
    else if (evidence.fatalSignal) verdictText = 'truncated by a crash'
    else if (evidence.signatureRejected) verdictText = 'refused'
    const detailParts = [
      'log written ' + new Date(syslog.mtime).toISOString(),
      evidence.authenticated ? 'authentication passed' : '',
      evidence.customDirs === '' ? '' : 'custom dirs: ' + evidence.customDirs,
      evidence.loadedFrom.length > 0 ? 'loaded from ' + evidence.loadedFrom[evidence.loadedFrom.length - 1] : '',
    ].filter((part) => part !== '')
    rows.push(row('syslog', verdictText, clip(detailParts.join(' · ') || path.basename(syslog.path), 240)))
    if (!evidence.loaded && !evidence.fatalSignal && process.running) {
      notes.push(
        'The newest syslog has no "Loaded assembly: managed_plugin" line. That is not proof of a refusal: a crash or a batch session truncates the log before the plugin is reached. Read the row above before concluding.',
      )
    }
    const seen = evidence.customDirsAll
    const configured = paths.customDirsFile === '' ? '' : path.resolve(paths.customDirsFile)
    const configuredSeen = configured === '' ? true : seen.some((value) => path.resolve(value) === configured)
    if (seen.length > 0 && !configuredSeen) {
      notes.push(`That syslog names ${seen.join(' | ')}, none of which is ${paths.customDirsFile}. Either it predates this profile's setup or NX started without UGII_CUSTOM_DIRECTORY_FILE — compare the log time with the last NX start before trusting the row.`)
    }
  }

  const window = await windowState(config.windowTitle, false, process.pids)
  if (!window.found) {
    rows.push(row('window', 'absent', `no window title contains "${config.windowTitle}"`))
  } else {
    rows.push(row('window', window.minimized ? 'minimized' : 'visible', `${window.title}${window.minimized ? ' — screenshots will be empty until it is restored' : ''}`))
  }

  let verdict = 'offline'
  if (listening && plugin !== null) verdict = 'online'
  else if (listening || process.running) verdict = 'degraded'
  const ok = verdict === 'online'

  const summary =
    verdict === 'online'
      ? `NX is up: ${plugin.version}, ${plugin.tool_count} tools, listening on ${config.host}:${config.port}.`
      : verdict === 'degraded'
        ? 'NX is partially up: something is running but the plugin did not answer on the port.'
        : 'NX is not running (or not reachable): the plugin never got a chance to answer.'

  if (!listening) notes.push('Start NX with action=launch (it sets UGII_CUSTOM_DIRECTORY_FILE and UGII_USER_DIR), or start it yourself once those variables are set.')
  return { action: 'status', summary, verdict, ok, rows, notes, data }
}

/** One plugin tool call, straight over TCP. */
async function call(config, args) {
  const tool = typeof args.tool === 'string' ? args.tool.trim() : ''
  if (tool === '') throw new Error('nx: action=call requires tool (for example nx_list_open_parts)')
  if (!tool.startsWith('nx_')) {
    throw new Error(`nx: "${tool}" does not start with nx_ — the MCP adapter rejects such names, and the plugin registry is keyed the same way`)
  }
  const params = parseParams(args.params)
  let reply
  try {
    reply = await callTool(config, tool, params)
  } catch (error) {
    return {
      action: 'call',
      summary: `${tool}: the plugin did not answer — ${error instanceof Error ? error.message : String(error)}`,
      verdict: 'offline',
      ok: false,
      rows: [row('tcp', 'unreachable', `${config.host}:${config.port}`)],
      notes: ['Run action=status: a closed port means NX is not running or the plugin is not loaded, which is a different problem from the tool refusing the work.'],
      data: { tool, error: error instanceof Error ? error.message : String(error) },
    }
  }
  const result = unwrap(reply)
  const rows = [row(tool, result.success ? 'ok' : 'failed', clip(result.message))]
  for (const warning of result.warnings) rows.push(row(tool + ' warning', 'warning', clip(warning)))
  const notes = []
  if (!result.success) {
    notes.push('A failure here can be a missing precondition rather than a broken install: geometry tools need an open work part (nx_create_part or nx_open_part first).')
    notes.push('Run action=status to separate "the plugin is not loaded" from "the plugin said no".')
  }
  return {
    action: 'call',
    summary: result.success ? `${tool}: ${result.message || 'ok'}` : `${tool}: failed — ${result.message}`,
    verdict: result.success ? 'ok' : 'failed',
    ok: result.success,
    rows,
    notes,
    data: { tool, message: result.message, result: result.data, reply },
  }
}

/** The live inventory, independent of any MCP client snapshot. */
async function inventory(config, args) {
  let reply
  try {
    reply = await listTools(config)
  } catch (error) {
    return {
      action: 'tools',
      summary: 'The plugin did not answer: ' + (error instanceof Error ? error.message : String(error)),
      verdict: 'offline',
      ok: false,
      rows: [row('tcp', 'unreachable', `${config.host}:${config.port}`)],
      notes: [
        'A closed port says nothing about the plugin inventory. Run action=status to see whether NX is running, whether the DLL is deployed and what the syslog recorded.',
      ],
      data: { error: error instanceof Error ? error.message : String(error) },
    }
  }
  const list = Array.isArray(reply?.result?.tools) ? reply.result.tools : []
  const filter = typeof args.filter === 'string' ? args.filter.trim().toLowerCase() : ''
  const matched = list.filter((entry) => {
    const name = String(entry?.name ?? '')
    const description = String(entry?.description ?? '')
    if (filter === '') return true
    return name.toLowerCase().includes(filter) || description.toLowerCase().includes(filter)
  })
  const rows = matched.slice(0, 200).map((entry) => row(String(entry?.name ?? ''), 'tool', clip(entry?.description ?? '', 120)))
  const notes = []
  if (list.length === 0) notes.push('The plugin answered with an empty inventory: it loaded, but registered nothing.')
  if (matched.length > rows.length) notes.push(`Showing the first ${rows.length} of ${matched.length} matches.`)
  return {
    action: 'tools',
    summary: filter === '' ? `${list.length} tool(s) registered` : `${matched.length} of ${list.length} tool(s) match "${filter}"`,
    verdict: list.length > 0 ? 'listed' : 'empty',
    ok: list.length > 0,
    rows,
    notes,
    data: { total: list.length, matched: matched.length, filter },
  }
}

/** Start NX with the environment the plugin needs, then wait for the port. */
async function launch(config) {
  const paths = resolvePaths(config)
  const rows = []
  const notes = []

  if (paths.exePath === '' || !fs.existsSync(paths.exePath)) {
    return {
      action: 'launch',
      summary: 'Cannot launch: ugraf.exe was not found.',
      verdict: 'failed',
      ok: false,
      rows: [row('exe', 'missing', paths.exePath === '' ? 'no NX install detected; set nxRoot in the plugin config' : paths.exePath)],
      notes: ['Set nxRoot (for example D:\\Program Files\\Siemens\\NX2412) in the dsh-nx config block and retry.'],
    }
  }

  const already = await findProcess('ugraf.exe')
  if (already.running) {
    const listening = await portOpen(config.host, config.port)
    return {
      action: 'launch',
      summary: `NX is already running (pid ${already.pids.join(', ')}); not starting a second instance.`,
      verdict: listening ? 'already-running' : 'already-running-without-port',
      ok: listening,
      rows: [
        row('process', 'running', 'pid ' + already.pids.join(', ')),
        row('port', listening ? 'listening' : 'closed', `${config.host}:${config.port}`),
      ],
      notes: listening
        ? []
        : [
            'NX is running but nothing listens on the port. Either the plugin was not loaded at startup (check action=status → syslog), or the NX menu Toggle MCP Server switched it off.',
            'The DLL is only read at startup: restarting NX is the reliable fix after a deploy.',
          ],
      data: { pid: already.pids, exe: paths.exePath },
    }
  }

  const env = { ...process.env }
  if (paths.customDirsFile !== '' && fs.existsSync(paths.customDirsFile)) {
    env.UGII_CUSTOM_DIRECTORY_FILE = paths.customDirsFile
    rows.push(row('custom-dirs', 'set', paths.customDirsFile))
  } else {
    rows.push(row('custom-dirs', 'missing', paths.customDirsFile === '' ? 'not configured' : paths.customDirsFile))
    notes.push('Without UGII_CUSTOM_DIRECTORY_FILE, NX starts without the plugin: no menu, no listener, and no error. Run action=status for the current state.')
  }
  if (paths.userDir !== '' && fs.existsSync(paths.userDir)) {
    env.UGII_USER_DIR = paths.userDir
    rows.push(row('user-dir', 'set', paths.userDir))
  }

  const startedAt = Date.now()
  let child
  try {
    child = spawn(paths.exePath, [], { env, detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    rows.push(row('exe', 'spawned', `${paths.exePath}${child.pid === undefined ? '' : ' (pid ' + child.pid + ')'}`))
  } catch (error) {
    return {
      action: 'launch',
      summary: 'Failed to spawn ugraf.exe.',
      verdict: 'failed',
      ok: false,
      rows: [...rows, row('exe', 'failed', error instanceof Error ? error.message : String(error))],
      notes,
    }
  }

  const deadline = startedAt + config.launchTimeoutMs
  let listening = false
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    listening = await portOpen(config.host, config.port)
    if (listening) break
  }
  const elapsed = Math.round((Date.now() - startedAt) / 1000)
  rows.push(row('port', listening ? 'listening' : 'closed', `${config.host}:${config.port} after ${elapsed}s`))
  if (!listening) {
    notes.push(`The port did not open within ${Math.round(config.launchTimeoutMs / 1000)}s. NX may still be starting (a cold start takes 30–90s), or the DLL is missing/unsigned.`)
    notes.push('Run action=status: the syslog row distinguishes "still loading" from "never loaded".')
  } else {
    try {
      const reply = await ping(config)
      rows.push(row('plugin', 'answering', `${reply?.result?.version ?? '?'} · ${reply?.result?.tool_count ?? '?'} tool(s)`))
    } catch (error) {
      rows.push(row('plugin', 'no reply', error instanceof Error ? error.message : String(error)))
    }
  }

  return {
    action: 'launch',
    summary: listening ? `NX started and the plugin answered after ${elapsed}s.` : `NX was spawned, but the plugin port did not open within ${Math.round(config.launchTimeoutMs / 1000)}s.`,
    verdict: listening ? 'online' : 'launched-without-port',
    ok: listening,
    rows,
    notes,
    data: { exe: paths.exePath, elapsedSeconds: elapsed, customDirsFile: paths.customDirsFile, userDir: paths.userDir },
  }
}

/** Restore and foreground the NX window. */
async function focus(config) {
  const running = await findProcess('ugraf.exe')
  const state = await windowState(config.windowTitle, true, running.pids)
  if (!state.found) {
    return {
      action: 'focus',
      summary: `No window title contains "${config.windowTitle}".`,
      verdict: 'absent',
      ok: false,
      rows: [row('window', 'absent', state.error ?? `looked for "${config.windowTitle}"`)],
      notes: ['NX may not be running, or it uses a different window title. action=status reports the process and port.'],
      data: { state },
    }
  }
  return {
    action: 'focus',
    summary: state.minimized ? `Window "${state.title}" is still minimized.` : `Window "${state.title}" is restored and in front.`,
    verdict: state.minimized ? 'still-minimized' : 'focused',
    ok: !state.minimized,
    rows: [
      row('window', 'found', state.title),
      row('restore', state.wasMinimized ? (state.minimized ? 'failed' : 'ok') : 'not-needed', state.wasMinimized ? 'was minimized' : 'was already visible'),
    ],
    notes: state.minimized ? ['A restore can be refused when the window is owned by another session. Bring it forward by hand and retry.'] : [],
    data: { state },
  }
}

/**
 * Focus, settle, fit, then capture the viewport — and prove the file exists.
 *
 * The settle step is not decoration. NX exports the graphics buffer, not a fresh
 * render: a screenshot taken while the window is still repainting (just restored,
 * just uncovered) writes a file that is the right size and full of nothing. A
 * capture that merely checks the exit status cannot see that, which is why the
 * file is measured here.
 */
async function capture(config, args) {
  const target =
    typeof args.imagePath === 'string' && args.imagePath.trim() !== ''
      ? args.imagePath.trim()
      : path.join(os.tmpdir(), `nx-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
  const wantFit = args.fit !== false

  const rows = []
  const notes = []
  const running = await findProcess('ugraf.exe')
  const focused = await windowState(config.windowTitle, true, running.pids)
  rows.push(
    row(
      'window',
      focused.found ? (focused.minimized ? 'still minimized' : 'ready') : 'absent',
      focused.found ? (focused.title + ' (pid ' + focused.pid + ')') : `no window of ugraf.exe (${running.pids.length} process(es))`,
    ),
  )
  if (!focused.found) {
    return {
      action: 'capture',
      summary: 'Cannot capture: no NX window belongs to a running ugraf.exe.',
      verdict: 'absent',
      ok: false,
      rows,
      notes: [
        running.pids.length === 0
          ? 'ugraf.exe is not running. Start it with action=launch.'
          : 'ugraf.exe is running but has no titled window yet — NX creates the main window late in startup. Retry in a few seconds.',
      ],
      data: { imagePath: target },
    }
  }

  fs.mkdirSync(path.dirname(target), { recursive: true })

  const shoot = async () => {
    let outcome
    try {
      outcome = unwrap(await callTool(config, 'nx_screenshot', { path: target.replace(/\\/g, '/') }))
    } catch (error) {
      outcome = { success: false, message: error instanceof Error ? error.message : String(error), data: {}, warnings: [] }
    }
    const exists = fs.existsSync(target)
    const size = exists ? fs.statSync(target).size : 0
    return { outcome, size, empty: !exists || size === 0 }
  }

  // Give the window a moment to repaint after being restored or uncovered.
  await new Promise((resolve) => setTimeout(resolve, 900))
  if (wantFit) {
    try {
      await callTool(config, 'nx_fit_view', {})
    } catch {
      // A failed fit is not a failed capture: it only means the view stays where it was.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  let attempt = await shoot()
  if (!attempt.outcome.success) {
    rows.push(row('screenshot', 'failed', clip(attempt.outcome.message)))
  } else if (attempt.empty) {
    // NX said it saved something and nothing appeared: the classic minimized or
    // mid-repaint case. One retry, with a longer settle, before calling it failed.
    await new Promise((resolve) => setTimeout(resolve, 1400))
    attempt = await shoot()
    rows.push(row('screenshot', attempt.empty ? 'empty after retry' : 'ok after retry', clip(attempt.outcome.message)))
  } else {
    rows.push(row('screenshot', 'ok', clip(attempt.outcome.message)))
  }

  rows.push(row('file', attempt.empty ? 'empty' : 'written', `${target} · ${bytes(attempt.size)}`))

  if (!attempt.outcome.success) {
    notes.push(
      'The plugin refused the screenshot: ' + attempt.outcome.message +
        ' A screenshot needs an open work part, so create or open one first (nx_create_part / nx_open_part), then retry.',
    )
  } else if (attempt.empty) {
    notes.push(
      'NX reported success and wrote nothing, twice. That is the no-renderable-surface case: the window was minimized, hidden, or still repainting. Bring NX to the foreground and retry.',
    )
  }

  const ok = attempt.outcome.success && !attempt.empty
  return {
    action: 'capture',
    summary: ok ? `Captured ${bytes(attempt.size)} to ${target}.` : 'Capture failed or produced an empty file.',
    verdict: ok ? 'captured' : 'failed',
    ok,
    rows,
    notes,
    data: { imagePath: target, bytes: attempt.size, screenshot: attempt.outcome },
  }
}
/** Compile, sign, install the managed plugin. */
async function deploy(config, args) {
  const paths = resolvePaths(config)
  const rows = []
  const notes = []
  const signWanted = args.sign !== false

  if (config.nxAutoMcpPath === '') {
    return {
      action: 'deploy',
      summary: 'Cannot deploy: nxAutoMcpPath is not configured.',
      verdict: 'failed',
      ok: false,
      rows: [row('config', 'missing', 'nxAutoMcpPath')],
      notes: ['Set nxAutoMcpPath to the nx-auto-mcp checkout (the folder containing plugin/).'],
    }
  }

  const built = await compile(config, paths)
  for (const step of built.steps) rows.push(row(step.name, step.status, clip(step.detail, 220)))
  if (!built.ok) {
    notes.push('Compilation failed, so nothing was signed, copied or deployed. The first compiler error is in the compile row.')
    return { action: 'deploy', summary: 'Compilation failed; nothing was deployed.', verdict: 'compile-failed', ok: false, rows, notes, data: { output: clip(built.output, 2000) } }
  }

  let signed = false
  let signDetail = 'skipped'
  if (signWanted) {
    const verdict = await sign(config, paths, built.dllPath)
    signed = verdict.ok
    signDetail = verdict.detail
    rows.push(row('sign', signed ? 'ok' : 'failed', clip(verdict.detail, 220)))
  } else {
    rows.push(row('sign', 'skipped', 'sign=false; the DLL stays unsigned'))
  }

  const installed = install(paths, built.dllPath)
  for (const step of installed.steps) rows.push(row(step.name, step.status, clip(step.detail, 220)))
  if (!installed.ok) {
    notes.push('The copy into plugin/startup failed. NX locks the DLL while it runs — exit NX completely, then deploy again.')
    return { action: 'deploy', summary: 'Built, but installing into plugin/startup failed.', verdict: 'install-failed', ok: false, rows, notes, data: {} }
  }

  const running = await findProcess('ugraf.exe')
  if (running.running) {
    notes.push('NX is running and holds the previous DLL in memory. NX reads the plugin only at startup, so exit it completely and start it again (action=launch) before expecting the new build.')
  }
  if (!signed) {
    notes.push('The DLL is unsigned. NX loads it only when the runtime DotNet author licence is present; the syslog then reports "Authentication passed". If it does not load, signing is the missing piece and it needs a licence for SignDotNet, not a rebuild.')
  }
  if (!fs.existsSync(paths.signingResource)) {
    notes.push('NXSigningResource.res is absent (runtime-only NX install, no UGOPEN). The DLL was compiled without it, so SignDotNet cannot sign this build even with a licence.')
  }

  const ok = signed
  return {
    action: 'deploy',
    summary: signed
      ? `Built, signed and installed (${bytes(fs.statSync(installed.target).size)}); restart NX to load it.`
      : `Built and installed (${bytes(fs.statSync(installed.target).size)}) but not signed — NX may still load it when the runtime author licence is present; restart NX to find out.`,
    verdict: signed ? 'deployed' : 'deployed-unsigned',
    ok,
    rows,
    notes,
    data: { dll: installed.target, signed, signDetail, nxRunning: running.running },
  }
}

/**
 * Build the tool definition for `ctx.tools.register`.
 * @param config - resolved plugin configuration.
 */
export function registerTool(tools, config) {
  const definition = {
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args) {
      const action = typeof args?.action === 'string' ? args.action : 'status'
      if (action === 'status') return status(config)
      if (action === 'call') return call(config, args ?? {})
      if (action === 'tools') return inventory(config, args ?? {})
      if (action === 'launch') return launch(config)
      if (action === 'focus') return focus(config)
      if (action === 'capture') return capture(config, args ?? {})
      if (action === 'deploy') return deploy(config, args ?? {})
      throw new Error('nx: unknown action ' + action)
    },
  }
  return tools.register(definition)
}

/**
 * Render the structured result as text for the transcript.
 *
 * The registry calls `render(args, value)` — a tool's renderer receives the
 * arguments it was called with and the validated output value. Taking the value as
 * the first parameter reads the arguments object instead, which fails with
 * "result.rows is not iterable" only once the tool is actually invoked.
 */
export function render(_args, result) {
  const lines = [`nx ${result.action}: ${result.summary}`]
  for (const entry of result.rows) {
    const head = [entry.name, entry.verdict].filter((part) => part !== '').join('  |  ')
    lines.push('  ' + head + (entry.detail === '' ? '' : '  —  ' + entry.detail))
  }
  for (const note of result.notes) lines.push('  ! ' + note)
  return [{ type: 'text', text: lines.join('\n') }]
}
