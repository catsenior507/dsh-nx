/**
 * dsh-nx, build and deploy of the nx-auto-mcp managed plugin.
 *
 * nx-auto-mcp ships source only: NX refuses an unsigned managed plugin, and the
 * signature is machine-bound, so the DLL has to be compiled here. That makes
 * "is the plugin deployed?" a four-step question — compile, sign, copy, restart —
 * and this module answers all four explicitly instead of reporting one boolean.
 *
 * Two facts learned the hard way, encoded here:
 *
 * - `SignDotNet` can fail with "Cannot obtain authoring license" while NX still
 *   loads the DLL, because the *runtime* author licence is a different grant from
 *   the one the signing tool asks for. So a signing failure is reported as a
 *   failure, and deployment continues — with the outcome stated, not smoothed
 *   over.
 * - `NXSigningResource.res` ships in `UGOPEN`, which a runtime-only NX install
 *   does not have. When it is missing the resource is simply not embedded, and the
 *   build says so rather than failing with a compiler message about `/resource`.
 *
 * @module @dsh-external/dsh-nx/deploy
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const SOURCE_SKIP = /bridge\.bak|[\\/]scripts[\\/]|node_modules|extract-dll|[\\/]journal[\\/]/

/** Run an executable and capture both streams without a shell. */
function run(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
        spawned: error === null || error.code !== undefined,
      })
    })
  })
}

/** Every C# source under the plugin folder, minus the folders the build script skips. */
export function collectSources(pluginDir) {
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.cs')) continue
      if (SOURCE_SKIP.test(full)) continue
      found.push(full)
    }
  }
  walk(pluginDir)
  return found.sort()
}

/** The compiler and reference set the nx-auto-mcp build script uses. */
export function buildPlan(paths) {
  const framework = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319')
  const refs = [
    path.join(paths.sdkDir, 'NXOpen.dll'),
    path.join(paths.sdkDir, 'NXOpen.UF.dll'),
    path.join(paths.sdkDir, 'NXOpen.Utilities.dll'),
    path.join(paths.sdkDir, 'NXOpenUI.dll'),
    path.join(paths.sdkDir, 'ManagedLoader.dll'),
    path.join(paths.sdkDir, 'Newtonsoft.Json.dll'),
    path.join(framework, 'System.Windows.Forms.dll'),
    path.join(framework, 'WPF', 'WindowsBase.dll'),
    path.join(framework, 'WPF', 'PresentationCore.dll'),
    path.join(framework, 'WPF', 'UIAutomationTypes.dll'),
    path.join(framework, 'WPF', 'UIAutomationClient.dll'),
  ]
  return { csc: path.join(framework, 'csc.exe'), refs, framework }
}

/**
 * Compile every C# file under `<package>/plugin` into `<package>/plugin/bin`.
 * @returns { ok, dllPath, bytes, steps, output }
 */
export async function compile(config, paths) {
  const steps = []
  const pluginDir = paths.packagePluginDir
  const dllPath = path.join(pluginDir, 'bin', 'managed_plugin.dll')

  if (config.nxAutoMcpPath === '') {
    return { ok: false, dllPath, steps: [{ name: 'locate', status: 'failed', detail: 'nxAutoMcpPath is not configured' }], output: '' }
  }
  if (!fs.existsSync(pluginDir)) {
    return { ok: false, dllPath, steps: [{ name: 'locate', status: 'failed', detail: 'no plugin folder at ' + pluginDir }], output: '' }
  }
  steps.push({ name: 'locate', status: 'ok', detail: pluginDir })

  const sources = collectSources(pluginDir)
  if (sources.length === 0) {
    return { ok: false, dllPath, steps: [...steps, { name: 'sources', status: 'failed', detail: 'no .cs files under ' + pluginDir }], output: '' }
  }
  steps.push({ name: 'sources', status: 'ok', detail: `${sources.length} C# file(s)` })

  const plan = buildPlan(paths)
  if (!fs.existsSync(plan.csc)) {
    return { ok: false, dllPath, steps: [...steps, { name: 'compiler', status: 'failed', detail: 'csc.exe not found at ' + plan.csc }], output: '' }
  }
  const missingRefs = plan.refs.filter((ref) => !fs.existsSync(ref))
  if (missingRefs.length > 0) {
    steps.push({ name: 'references', status: 'failed', detail: 'missing: ' + missingRefs.map((ref) => path.basename(ref)).join(', ') })
    return { ok: false, dllPath, steps, output: '' }
  }
  steps.push({ name: 'references', status: 'ok', detail: plan.refs.length + ' assembly reference(s) from ' + paths.sdkDir })

  fs.mkdirSync(path.dirname(dllPath), { recursive: true })
  const args = ['/target:library', `/out:${dllPath}`, '/platform:x64', '/nologo']
  for (const ref of plan.refs) args.push(`/r:${ref}`)

  const hasResource = paths.signingResource !== '' && fs.existsSync(paths.signingResource)
  if (hasResource) {
    args.push(`/resource:${paths.signingResource}`)
    steps.push({ name: 'signing-resource', status: 'ok', detail: paths.signingResource })
  } else {
    steps.push({
      name: 'signing-resource',
      status: 'skipped',
      detail: 'NXSigningResource.res is absent (a runtime-only NX install has no UGOPEN); the DLL is built without it and cannot be signed',
    })
  }
  args.push(...sources)

  const result = await run(plan.csc, args, config.deployExecTimeoutMs)
  const output = (result.stdout + result.stderr).trim()
  if (result.code !== 0) {
    return { ok: false, dllPath, steps: [...steps, { name: 'compile', status: 'failed', detail: firstErrorLine(output) || `csc exited ${result.code}` }], output }
  }
  const bytes = fs.existsSync(dllPath) ? fs.statSync(dllPath).size : 0
  const warnings = (output.match(/warning CS/g) ?? []).length
  steps.push({ name: 'compile', status: 'ok', detail: `${bytes} bytes, ${warnings} warning(s)` })
  return { ok: bytes > 0, dllPath, bytes, steps, output }
}

/** The first compiler error, which is the one worth quoting. */
function firstErrorLine(output) {
  for (const line of output.split(/\r?\n/)) {
    if (/\berror CS\d+/.test(line)) return line.trim()
  }
  return ''
}

/**
 * Sign a built DLL with SignDotNet, then verify independently.
 * @returns { ok, detail } — ok means `-verify` agreed, not that the tool exited 0.
 */
export async function sign(config, paths, dllPath) {
  if (!fs.existsSync(dllPath)) return { ok: false, detail: 'no DLL to sign at ' + dllPath }
  if (paths.signTool === '' || !fs.existsSync(paths.signTool)) {
    return { ok: false, detail: 'SignDotNet.exe not found under NXBIN' }
  }
  const signResult = await run(paths.signTool, [dllPath], config.deployExecTimeoutMs)
  const signText = (signResult.stdout + signResult.stderr).trim()
  if (signResult.code !== 0) {
    const reason = firstSignLine(signText) || `SignDotNet exited ${signResult.code}`
    return { ok: false, detail: reason }
  }
  const verifyResult = await run(paths.signTool, ['-verify', dllPath], config.deployExecTimeoutMs)
  const verifyText = (verifyResult.stdout + verifyResult.stderr).trim()
  if (verifyResult.code !== 0 || /not valid|invalid|empty/i.test(verifyText)) {
    return { ok: false, detail: firstSignLine(verifyText) || 'SignDotNet reports the signature is not valid' }
  }
  return { ok: true, detail: 'signed and verified' }
}

/** The line of SignDotNet output that names the failure. */
function firstSignLine(text) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (/license|error|cannot|not compiled|empty|invalid/i.test(trimmed)) return trimmed
  }
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')[0] ?? ''
}

/**
 * Verify a signature without touching it.
 *
 * `status` must not sign: reporting the state of a build and changing it are
 * different actions, and a health check that mutates the DLL would make the next
 * observation describe the check rather than the build.
 *
 * @returns { ok, detail } — ok only when SignDotNet's own verifier agreed.
 */
export async function verifySignature(config, paths, dllPath) {
  if (paths.signTool === '' || !fs.existsSync(paths.signTool)) {
    return { ok: false, detail: 'SignDotNet.exe not found under NXBIN' }
  }
  if (!fs.existsSync(dllPath)) return { ok: false, detail: 'no DLL at ' + dllPath }
  const result = await run(paths.signTool, ['-verify', dllPath], config.deployExecTimeoutMs)
  const text = (result.stdout + result.stderr).trim()
  if (result.code !== 0) return { ok: false, detail: firstSignLine(text) || `SignDotNet -verify exited ${result.code}` }
  if (/not valid|invalid|empty|not compiled/i.test(text)) {
    return { ok: false, detail: firstSignLine(text) || 'SignDotNet reports the signature is not valid' }
  }
  return { ok: true, detail: firstSignLine(text) || 'signature valid' }
}

/**
 * Copy the built DLL and its rule metadata into `plugin/startup/`, which is the
 * only location nx-auto-mcp's `custom_dirs.dat` causes NX to load.
 */
export function install(paths, dllPath) {
  const steps = []
  const startup = path.join(paths.packagePluginDir, 'startup')
  const target = path.join(startup, 'managed_plugin.dll')
  fs.mkdirSync(startup, { recursive: true })
  try {
    fs.copyFileSync(dllPath, target)
    steps.push({ name: 'copy-dll', status: 'ok', detail: `${target} (${fs.statSync(target).size} bytes)` })
  } catch (error) {
    return { ok: false, target, steps: [...steps, { name: 'copy-dll', status: 'failed', detail: error instanceof Error ? error.message : String(error) }] }
  }

  const rulesSource = path.join(paths.packagePluginDir, 'rules', 'rules_config.json')
  const rulesTarget = path.join(startup, 'rules', 'rules_config.json')
  if (!fs.existsSync(rulesSource)) {
    steps.push({ name: 'copy-rules', status: 'skipped', detail: 'no rules/rules_config.json; the engine falls back to its built-in rules' })
  } else {
    try {
      fs.mkdirSync(path.dirname(rulesTarget), { recursive: true })
      fs.copyFileSync(rulesSource, rulesTarget)
      steps.push({ name: 'copy-rules', status: 'ok', detail: rulesTarget })
    } catch (error) {
      steps.push({ name: 'copy-rules', status: 'skipped', detail: error instanceof Error ? error.message : String(error) })
    }
  }
  return { ok: true, target, steps }
}
