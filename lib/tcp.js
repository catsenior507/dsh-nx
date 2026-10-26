/**
 * dsh-nx, the TCP client.
 *
 * nx-auto-mcp's plugin is a line-delimited JSON server on 127.0.0.1:1977, one
 * request and one reply per connection. There is no handshake and no session, so
 * this is deliberately dumb: connect, write one line, read one line, hang up.
 *
 * The reason this exists at all is the MCP snapshot problem. An MCP client pulls
 * `tools/list` once, at connect time, and never again; a tool deployed into NX
 * afterwards is invisible until the client reconnects. Everything here talks to
 * the plugin directly, so it sees the live inventory.
 *
 * @module @dsh-external/dsh-nx/tcp
 */

import net from 'node:net'

/**
 * Send one request and read one reply line.
 * @param config - resolved config (host, port, callTimeoutMs).
 * @param payload - the JSON body, e.g. { method: 'ping', id: 1 }.
 * @param timeoutMs - optional override.
 * @returns the parsed reply object.
 */
export function request(config, payload, timeoutMs = config.callTimeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(config.port, config.host)
    let buffer = ''
    let settled = false
    let timer

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      socket.destroy()
      fn(value)
    }

    timer = setTimeout(() => {
      finish(reject, new Error(`nx: no reply within ${timeoutMs} ms from ${config.host}:${config.port}`))
    }, timeoutMs)

    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const line = buffer.slice(0, newline).trim()
      if (line === '') return
      try {
        finish(resolve, JSON.parse(line))
      } catch {
        finish(reject, new Error('nx: the plugin replied with a line that is not JSON: ' + line.slice(0, 200)))
      }
    })
    socket.on('error', (error) => {
      finish(reject, new Error(`nx: cannot reach ${config.host}:${config.port} — ${error.code ?? error.message}`))
    })
    socket.on('close', () => {
      finish(reject, new Error('nx: the connection closed before a reply arrived'))
    })

    socket.write(JSON.stringify(payload) + '\n')
  })
}

/**
 * `ping` returns the plugin version and the live tool count.
 * Shape: { id, result: { pong, timestamp, version, tool_count }, error }.
 */
export async function ping(config) {
  return request(config, { method: 'ping', id: 1 })
}

/** `list_tools` returns every registered tool with its schema. */
export async function listTools(config) {
  return request(config, { method: 'list_tools', id: 1, params: {} })
}

/**
 * Call one plugin tool by name.
 *
 * nx-auto-mcp wraps the arguments under `tool`, and the plugin flattens them into
 * the method params — so the payload is `{ tool: name, ...params }`, not
 * `{ tool: name, params }`. Getting that wrong produces "No work part is open."
 * style confusion rather than a schema error, which is why it is stated here.
 *
 * @param config - resolved config.
 * @param tool - tool name, e.g. `nx_measure_volume`.
 * @param params - the tool's arguments.
 */
export async function callTool(config, tool, params) {
  return request(config, { method: 'tool', id: 1, params: { tool, ...params } })
}

/**
 * Flatten a reply into the { success, message, data, warnings } the plugin uses.
 * A transport-level `error` is projected into the same shape so callers do not
 * have to branch on which layer refused.
 */
export function unwrap(reply) {
  if (reply !== null && typeof reply === 'object' && reply.error !== null && reply.error !== undefined) {
    return { success: false, message: String(reply.error?.message ?? reply.error), data: {}, warnings: [] }
  }
  const result = reply?.result
  if (result === null || typeof result !== 'object') {
    return { success: false, message: 'nx: the reply carried no result', data: {}, warnings: [] }
  }
  return {
    success: result.success !== false,
    message: typeof result.message === 'string' ? result.message : '',
    data: result.data ?? {},
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
  }
}
