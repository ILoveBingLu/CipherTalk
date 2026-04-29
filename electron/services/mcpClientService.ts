import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ChildProcess } from 'child_process'

export type McpTransportType = 'stdio' | 'sse' | 'http'

export type McpClientServerConfig = {
  type: McpTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  timeoutMs?: number
  autoConnect?: boolean
}

export type McpServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export type McpServerInfo = {
  name: string
  config: McpClientServerConfig
  status: McpServerStatus
  toolCount: number
  error?: string
}

export type McpToolInfo = {
  name: string
  description?: string
  inputSchema?: unknown
}

type ClientConnection = {
  client: InstanceType<typeof import('@modelcontextprotocol/sdk/client/index.js').Client>
  transport: unknown
  process?: ChildProcess
  tools: McpToolInfo[]
}

const CONFIG_FILE = 'mcp-client-configs.json'

function normalizeTimeoutMs(value?: number): number | undefined {
  if (!value || !Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value)
}

function mergeHeaders(base: RequestInit['headers'] | undefined, extra: Record<string, string> | undefined): Headers {
  const headers = new Headers(base)
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (key.trim()) headers.set(key.trim(), value)
    }
  }
  return headers
}

function createFetchWithOptions(headers?: Record<string, string>, timeoutMs?: number): typeof fetch {
  return async (input, init = {}) => {
    const controller = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const upstreamSignal = init.signal

    if (upstreamSignal) {
      if (upstreamSignal.aborted) controller.abort(upstreamSignal.reason)
      else upstreamSignal.addEventListener('abort', () => controller.abort(upstreamSignal.reason), { once: true })
    }

    if (timeoutMs) {
      timer = setTimeout(() => controller.abort(new Error(`MCP request timed out after ${timeoutMs}ms`)), timeoutMs)
    }

    try {
      return await fetch(input, {
        ...init,
        headers: mergeHeaders(init.headers, headers),
        signal: controller.signal,
      })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, label: string): Promise<T> {
  if (!timeoutMs) return promise
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function getConfigPath(): string {
  return join(app.getPath('userData'), CONFIG_FILE)
}

function loadConfigs(): Record<string, McpClientServerConfig> {
  const p = getConfigPath()
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return {}
  }
}

function saveConfigs(configs: Record<string, McpClientServerConfig>): void {
  writeFileSync(getConfigPath(), JSON.stringify(configs, null, 2), 'utf8')
}

export class McpClientService {
  private connections = new Map<string, ClientConnection>()
  private pendingStatuses = new Map<string, McpServerStatus>()
  private lastErrors = new Map<string, string>()

  listClientConfigs(): Record<string, McpClientServerConfig> {
    return loadConfigs()
  }

  hasClientConfig(name: string): boolean {
    return Boolean(loadConfigs()[name])
  }

  saveClientConfig(name: string, config: McpClientServerConfig, overwrite = false): { success: boolean; error?: string } {
    if (!name.trim()) return { success: false, error: 'Server name is required' }
    const configs = loadConfigs()
    if (configs[name] && !overwrite) return { success: false, error: `Server "${name}" already exists` }
    if (configs[name]?.autoConnect !== undefined && config.autoConnect === undefined) {
      config.autoConnect = configs[name].autoConnect
    }
    configs[name] = config
    saveConfigs(configs)
    return { success: true }
  }

  private setAutoConnect(name: string, enabled: boolean): void {
    const configs = loadConfigs()
    if (!configs[name]) return
    configs[name] = { ...configs[name], autoConnect: enabled }
    saveConfigs(configs)
  }

  deleteClientConfig(name: string): { success: boolean; error?: string } {
    const configs = loadConfigs()
    if (!configs[name]) return { success: false, error: `Server "${name}" not found` }

    void this.disconnectFromServer(name)
    delete configs[name]
    saveConfigs(configs)
    return { success: true }
  }

  async connectToServer(name: string): Promise<{ success: boolean; tools?: McpToolInfo[]; error?: string }> {
    if (this.connections.has(name)) {
      return { success: false, error: `Already connected to "${name}"` }
    }
    if (this.pendingStatuses.get(name) === 'connecting') {
      return { success: false, error: `Already connecting to "${name}"` }
    }

    const configs = loadConfigs()
    const config = configs[name]
    if (!config) return { success: false, error: `Server "${name}" not found` }

    this.pendingStatuses.set(name, 'connecting')
    this.lastErrors.delete(name)
    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const client = new Client({ name: `ciphertalk-client-${name}`, version: '1.0.0' })
      const timeoutMs = normalizeTimeoutMs(config.timeoutMs)

      let transport: unknown

      if (config.type === 'stdio') {
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
        transport = new StdioClientTransport({
          command: config.command || '',
          args: config.args,
          env: config.env as Record<string, string> | undefined,
          cwd: config.cwd,
        })
      } else if (config.type === 'sse') {
        const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
        const requestInit = config.headers ? { headers: config.headers } : undefined
        const fetchWithOptions = createFetchWithOptions(config.headers, timeoutMs)
        transport = new SSEClientTransport(new URL(config.url || ''), {
          requestInit,
          eventSourceInit: { fetch: fetchWithOptions },
          fetch: fetchWithOptions,
        })
      } else if (config.type === 'http') {
        const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
        transport = new StreamableHTTPClientTransport(new URL(config.url || ''), {
          requestInit: config.headers ? { headers: config.headers } : undefined,
          fetch: createFetchWithOptions(config.headers, timeoutMs),
        })
      } else {
        return { success: false, error: `Unsupported transport type: ${config.type}` }
      }

      await withTimeout(
        client.connect(transport as import('@modelcontextprotocol/sdk/shared/transport.js').Transport),
        timeoutMs,
        'MCP connection'
      )

      const toolsResult = await withTimeout(client.listTools(), timeoutMs, 'MCP listTools')
      const tools: McpToolInfo[] = (toolsResult.tools || []).map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }))

      this.connections.set(name, { client, transport, tools })
      this.pendingStatuses.delete(name)
      this.lastErrors.delete(name)
      this.setAutoConnect(name, true)
      return { success: true, tools }
    } catch (e) {
      const error = String(e)
      this.pendingStatuses.delete(name)
      this.lastErrors.set(name, error)
      return { success: false, error }
    }
  }

  async disconnectFromServer(name: string, rememberManualDisconnect = true): Promise<{ success: boolean; error?: string }> {
    const conn = this.connections.get(name)
    if (!conn) {
      if (rememberManualDisconnect) this.setAutoConnect(name, false)
      this.pendingStatuses.delete(name)
      return { success: false, error: `Not connected to "${name}"` }
    }

    try {
      await conn.client.close()
      this.connections.delete(name)
      this.pendingStatuses.delete(name)
      this.lastErrors.delete(name)
      if (rememberManualDisconnect) this.setAutoConnect(name, false)
      return { success: true }
    } catch (e) {
      this.connections.delete(name)
      this.pendingStatuses.delete(name)
      if (rememberManualDisconnect) this.setAutoConnect(name, false)
      return { success: false, error: String(e) }
    }
  }

  async listToolsFromServer(name: string): Promise<{ success: boolean; tools?: McpToolInfo[]; error?: string }> {
    const conn = this.connections.get(name)
    if (!conn) return { success: false, error: `Not connected to "${name}"` }

    try {
      const toolsResult = await conn.client.listTools()
      const tools: McpToolInfo[] = (toolsResult.tools || []).map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }))
      conn.tools = tools
      return { success: true, tools }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async callTool(name: string, toolName: string, args: Record<string, unknown>): Promise<{ success: boolean; result?: unknown; error?: string }> {
    const conn = this.connections.get(name)
    if (!conn) return { success: false, error: `Not connected to "${name}"` }

    try {
      const result = await conn.client.callTool({ name: toolName, arguments: args })
      return { success: true, result }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  getServerStatus(name: string): McpServerStatus {
    const pending = this.pendingStatuses.get(name)
    if (pending) return pending
    if (this.lastErrors.has(name)) return 'error'
    return this.connections.has(name) ? 'connected' : 'disconnected'
  }

  listAllServerStatuses(): McpServerInfo[] {
    const configs = loadConfigs()
    const results: McpServerInfo[] = []

    for (const [name, config] of Object.entries(configs)) {
      const conn = this.connections.get(name)
      const status = this.getServerStatus(name)
      results.push({
        name,
        config,
        status,
        toolCount: conn?.tools.length ?? 0,
        error: this.lastErrors.get(name),
      })
    }

    return results
  }

  async restoreSavedConnections(): Promise<void> {
    const configs = loadConfigs()
    const targets = Object.entries(configs)
      .filter(([, config]) => config.autoConnect)
      .map(([name]) => name)
    await Promise.allSettled(targets.map(name => this.connectToServer(name)))
  }

  async disconnectAll(rememberManualDisconnect = false): Promise<void> {
    const names = [...this.connections.keys()]
    await Promise.allSettled(names.map(n => this.disconnectFromServer(n, rememberManualDisconnect)))
  }
}

export const mcpClientService = new McpClientService()
