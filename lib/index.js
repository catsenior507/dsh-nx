/**
 * dsh-nx, host half.
 *
 * The problem this plugin addresses is not "call NX". nx-auto-mcp already exposes
 * 123 tools over MCP, and when the chain is up they work. The problem is the
 * chain: five things have to be true at once — NX running, the managed DLL built,
 * the DLL loadable, the plugin's TCP server listening, and the window renderable
 * — and when one is false the model sees only "No work part is open." or an empty
 * screenshot. Diagnosing that by hand means knowing which syslog to read, which
 * registry key NX honours, and that a minimized window silently exports nothing.
 *
 * So the tool here is deliberately about *state and repair*, not about modelling:
 *
 * - `status` reports the five links separately, and marks a link unknown rather
 *   than failed when an earlier one makes it unobservable.
 * - `call` goes straight to the plugin, because an MCP client's tool list is a
 *   connect-time snapshot and a freshly deployed tool is invisible to it.
 * - `launch` and `focus` fix the two most common environmental failures.
 * - `deploy` compiles, signs and installs, and reports signing failures instead
 *   of flattening them into "deployed".
 *
 * @module @dsh-external/dsh-nx
 */

import fs from 'node:fs'

import { deployedDllPath, findNxRoot, resolveConfig } from './config.js'
import { registerTool } from './tool.js'

/** Cordis plugin name. */
export const name = 'tool-nx'

/**
 * The tool registry is the one hard dependency: without it there is nothing to
 * register. The logger is optional and only affects what is reported at mount.
 */
export const inject = ['tools']

/** Log through whichever channel this profile actually provides. */
function makeLogger(ctx) {
  const logger = ctx?.logger
  return {
    info(message) {
      if (typeof logger?.info === 'function') logger.info(message)
    },
    warn(message) {
      if (typeof logger?.warn === 'function') logger.warn(message)
    },
  }
}

/**
 * Mount the plugin.
 * @param ctx - the plugin cordis context.
 * @param config - optional `config:` block from the profile row.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const log = makeLogger(ctx)

  // Report the resolved paths at mount. A wrong nxRoot is cheap to fix once it is
  // visible in the boot log, and expensive to discover inside a failed deploy.
  const nxRoot = resolved.nxRoot !== '' ? resolved.nxRoot : findNxRoot()
  const dll = deployedDllPath(resolved)
  if (nxRoot === '') {
    log.warn('[nx] 未检测到 NX 安装：设置 nxRoot（例如 D:\\Program Files\\Siemens\\NX2412）后 launch/deploy 才能用')
  } else {
    log.info('[nx] NX: ' + nxRoot)
  }
  if (resolved.nxAutoMcpPath === '') {
    log.warn('[nx] 未配置 nxAutoMcpPath：deploy 不可用，status 也会缺少部署信息')
  } else if (dll !== '' && !fs.existsSync(dll)) {
    log.warn('[nx] 尚未部署插件 DLL：' + dll + '（运行 nx deploy 编译并安装）')
  }

  if (resolved.exposeTool === false) return

  let tools
  try {
    tools = ctx.tools
  } catch {
    tools = undefined
  }
  if (tools === undefined || typeof tools.register !== 'function') {
    log.warn('[nx] tools 服务不可用，nx 工具未注册')
    return
  }
  try {
    const dispose = registerTool(tools, resolved)
    if (typeof ctx?.effect === 'function') ctx.effect(() => () => dispose(), 'tool-nx: nx tool')
    log.info('[nx] nx 工具已注册（status / call / tools / launch / focus / capture / deploy）')
  } catch (error) {
    log.warn('[nx] 注册 nx 工具失败：' + String(error))
  }
}

// No default export on purpose: cordis resolves a module plugin as
// module.default ?? module, so a default export would hide the named `inject`
// above and every ctx.tools read would fail with "cannot get property tools
// without inject".
