/**
 * dsh-nx, configuration.
 *
 * Every path this plugin needs is a path the user already has, so the rules are:
 * take what the profile says, otherwise take what NX itself declares through the
 * environment, otherwise scan the two standard Siemens roots. Nothing is
 * invented: an unresolvable path stays empty and the tool reports it as a gap
 * instead of guessing one and failing somewhere less legible.
 *
 * @module @dsh-external/dsh-nx/config
 */

import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 1977
export const DEFAULT_WINDOW_TITLE = 'NX - Gateway'

function asString(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function asInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  if (i < min || i > max) return fallback
  return i
}

/**
 * Normalise a `config:` block from the profile row.
 * @param raw - the config block, possibly undefined.
 * @returns a fully populated configuration.
 */
export function resolveConfig(raw) {
  const cfg = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    host: asString(cfg.host, DEFAULT_HOST),
    port: asInt(cfg.port, DEFAULT_PORT, 1, 65535),
    nxRoot: asString(cfg.nxRoot, ''),
    nxAutoMcpPath: asString(cfg.nxAutoMcpPath, ''),
    customDirsFile: asString(cfg.customDirsFile, ''),
    userDir: asString(cfg.userDir, ''),
    exePath: asString(cfg.exePath, ''),
    windowTitle: asString(cfg.windowTitle, DEFAULT_WINDOW_TITLE),
    callTimeoutMs: asInt(cfg.callTimeoutMs, 180000, 1000, 3600000),
    launchTimeoutMs: asInt(cfg.launchTimeoutMs, 240000, 5000, 1800000),
    deployExecTimeoutMs: asInt(cfg.deployExecTimeoutMs, 300000, 10000, 1800000),
    exposeTool: cfg.exposeTool !== false,
  }
}

/** NX2412 -> 2412, NX2306 -> 2306; anything else sorts lowest. */
function releaseNumber(directory) {
  const match = /NX(\d+)/i.exec(path.basename(directory))
  return match === null ? 0 : Number(match[1])
}

/**
 * Find an NX install root.
 *
 * Order: UGII_BASE_DIR (what NX itself exports), NX_ROOT (what the nx-auto-mcp
 * build scripts use), then a scan of <ProgramFiles>\Siemens\NX*. The scan is
 * sorted by release number, so a machine with two NX versions picks the newer
 * one, which is the only ordering that matches how the NX installer names them.
 *
 * @param env - environment to read (defaults to process.env).
 * @returns the install root, or '' when nothing usable was found.
 */
export function findNxRoot(env = process.env) {
  const declared = [env.UGII_BASE_DIR, env.NX_ROOT].filter((value) => typeof value === 'string' && value !== '')
  for (const root of declared) {
    if (fs.existsSync(path.join(root, 'NXBIN', 'ugraf.exe'))) return root
  }

  const declaredProgramFiles = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(
    (value) => typeof value === 'string' && value !== '',
  )
  // Only fall back to the well-known roots when the environment carries none: that
  // keeps a caller (and a test) able to bound the search to a directory of its own.
  const programFiles = declaredProgramFiles.length > 0 ? declaredProgramFiles : ['C:\\Program Files', 'D:\\Program Files']
  const candidates = []
  for (const base of programFiles) {
    const siemens = path.join(base, 'Siemens')
    let entries
    try {
      entries = fs.readdirSync(siemens, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^NX\d+/i.test(entry.name)) continue
      const root = path.join(siemens, entry.name)
      if (fs.existsSync(path.join(root, 'NXBIN', 'ugraf.exe'))) candidates.push(root)
    }
  }
  candidates.sort((a, b) => releaseNumber(b) - releaseNumber(a))
  return candidates.length > 0 ? candidates[0] : ''
}

/**
 * Resolve the pieces of the NX side for one call.
 *
 * `nxRoot` is detected once and reused; the rest are derived from it so a single
 * configured path is enough for launch, deploy and the health chain to agree on
 * which install they are talking about.
 *
 * @param config - resolved config.
 * @returns the paths the actions use, each '' when it cannot be resolved.
 */
export function resolvePaths(config) {
  const nxRoot = config.nxRoot !== '' ? config.nxRoot : findNxRoot()
  const exePath = config.exePath !== '' ? config.exePath : nxRoot === '' ? '' : path.join(nxRoot, 'NXBIN', 'ugraf.exe')
  const customDirsFile =
    config.customDirsFile !== ''
      ? config.customDirsFile
      : config.nxAutoMcpPath === ''
        ? ''
        : path.join(config.nxAutoMcpPath, 'custom_dirs.dat')
  const userDir = config.userDir !== '' ? config.userDir : config.nxAutoMcpPath
  return {
    nxRoot,
    exePath,
    customDirsFile,
    userDir,
    signTool: nxRoot === '' ? '' : path.join(nxRoot, 'NXBIN', 'SignDotNet.exe'),
    sdkDir: nxRoot === '' ? '' : path.join(nxRoot, 'NXBIN', 'managed'),
    signingResource: nxRoot === '' ? '' : path.join(nxRoot, 'UGOPEN', 'NXSigningResource.res'),
    packagePluginDir: config.nxAutoMcpPath === '' ? '' : path.join(config.nxAutoMcpPath, 'plugin'),
  }
}

/** The managed plugin DLL nx-auto-mcp loads, relative to the package. */
export function deployedDllPath(config) {
  return config.nxAutoMcpPath === '' ? '' : path.join(config.nxAutoMcpPath, 'plugin', 'startup', 'managed_plugin.dll')
}
