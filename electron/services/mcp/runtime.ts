import { dirname, join } from 'path'
import { existsSync } from 'fs'
import { ConfigService } from '../config'
import { getAppPath, getAppVersion, getDocumentsPath, getExePath, isElectronPackaged } from '../runtimePaths'
import type { McpHealthPayload, McpLaunchConfig, McpLauncherMode, McpStatusPayload } from './types'
import { MCP_TOOL_NAMES } from './types'

const MCP_SERVICE_NAME = 'ciphertalk-mcp'
export const DEFAULT_MCP_PROXY_PORT = 5032
export const DEFAULT_MCP_PROXY_TIMEOUT_MS = 30000

export interface McpProxyConfig {
  host: '127.0.0.1'
  port: number
  url: string
  token: string
  timeoutMs: number
}

function cleanAccountDirName(dirName: string): string {
  const trimmed = dirName.trim()
  if (!trimmed) return trimmed

  if (trimmed.toLowerCase().startsWith('wxid_')) {
    const match = trimmed.match(/^(wxid_[a-zA-Z0-9]+)/i)
    if (match) return match[1]
    return trimmed
  }

  const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  if (suffixMatch) return suffixMatch[1]
  return trimmed
}

function findAccountDir(baseDir: string, wxid: string): string | null {
  if (!existsSync(baseDir)) return null

  const cleanedWxid = cleanAccountDirName(wxid)
  const directCandidates = [wxid]

  if (cleanedWxid && cleanedWxid !== wxid) {
    directCandidates.push(cleanedWxid)
  }

  for (const candidate of directCandidates) {
    if (existsSync(join(baseDir, candidate))) {
      return candidate
    }
  }

  try {
    const fs = require('fs') as typeof import('fs')
    const entries = fs.readdirSync(baseDir, { withFileTypes: true })
    const wxidLower = wxid.toLowerCase()
    const cleanedLower = cleanedWxid.toLowerCase()

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dirName = entry.name
      const dirLower = dirName.toLowerCase()
      const cleanedDirLower = cleanAccountDirName(dirName).toLowerCase()

      if (dirLower === wxidLower || dirLower === cleanedLower) return dirName
      if (dirLower.startsWith(`${wxidLower}_`) || dirLower.startsWith(`${cleanedLower}_`)) return dirName
      if (cleanedDirLower === wxidLower || cleanedDirLower === cleanedLower) return dirName
    }
  } catch {
    return null
  }

  return null
}

function getDecryptedDbDir(configService: ConfigService): string {
  const cachePath = String(configService.get('cachePath') || '')
  if (cachePath) return cachePath

  if (!isElectronPackaged()) {
    return join(getDocumentsPath(), 'CipherTalkData')
  }

  const installDir = dirname(getExePath())
  const isOnCDrive = /^[cC]:/i.test(installDir) || installDir.startsWith('\\')
  if (isOnCDrive) {
    return join(getDocumentsPath(), 'CipherTalkData')
  }

  return join(installDir, 'CipherTalkData')
}

function getLauncherMode(): McpLauncherMode {
  const mode = String(process.env.CIPHERTALK_MCP_LAUNCHER || '').trim()
  if (mode === 'dev-runner' || mode === 'packaged-launcher') {
    return mode
  }

  return 'direct'
}

function getRuntimeWarnings(config: { mcpEnabled: boolean; dbReady: boolean }): string[] {
  const warnings: string[] = []

  if (!config.mcpEnabled) {
    warnings.push('MCP is not marked as enabled in Settings. Calls still work, but hosts should treat this as informational.')
  }

  if (!config.dbReady) {
    warnings.push('Chat database is not ready yet. Data tools may return DB_NOT_READY until setup is complete.')
  }

  return warnings
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

export function getPackagedLauncherPath(): string {
  if (process.platform === 'darwin') {
    return join(dirname(getExePath()), 'ciphertalk-mcp')
  }

  return join(dirname(getExePath()), 'ciphertalk-mcp.cmd')
}

export function getMcpLaunchConfig(): McpLaunchConfig {
  if (isElectronPackaged()) {
    return {
      command: getPackagedLauncherPath(),
      args: [],
      cwd: dirname(getExePath()),
      mode: 'packaged'
    }
  }

  return {
    command: 'npm',
    args: ['run', 'mcp'],
    cwd: getAppPath(),
    mode: 'dev'
  }
}

export function getMcpConfigSnapshot() {
  const configService = new ConfigService()
  try {
    const mcpEnabled = Boolean(configService.get('mcpEnabled'))
    const mcpExposeMediaPaths = configService.get('mcpExposeMediaPaths') !== false
    const myWxid = String(configService.get('myWxid') || '')
    const decryptedBaseDir = getDecryptedDbDir(configService)

    let dbReady = false
    if (myWxid) {
      const accountDir = findAccountDir(decryptedBaseDir, myWxid)
      if (accountDir) {
        dbReady = existsSync(join(decryptedBaseDir, accountDir, 'session.db'))
      }
    }

    return {
      mcpEnabled,
      mcpExposeMediaPaths,
      dbReady
    }
  } finally {
    configService.close()
  }
}

export function getMcpProxyConfig(config?: ConfigService): McpProxyConfig {
  const configService = config || new ConfigService()

  try {
    const host = '127.0.0.1' as const
    const port = parsePositiveInt(
      process.env.CIPHERTALK_MCP_PROXY_PORT || configService.get('mcpProxyPort'),
      DEFAULT_MCP_PROXY_PORT
    )
    const token = String(process.env.CIPHERTALK_MCP_PROXY_TOKEN || configService.get('mcpProxyToken') || '')
    const timeoutMs = parsePositiveInt(
      process.env.CIPHERTALK_MCP_PROXY_TIMEOUT_MS,
      DEFAULT_MCP_PROXY_TIMEOUT_MS
    )

    return {
      host,
      port,
      url: process.env.CIPHERTALK_MCP_PROXY_URL || `http://${host}:${port}`,
      token,
      timeoutMs
    }
  } finally {
    if (!config) {
      configService.close()
    }
  }
}

export function getMcpHealthPayload(): McpHealthPayload {
  const config = getMcpConfigSnapshot()
  return {
    ok: true,
    service: MCP_SERVICE_NAME,
    version: getAppVersion(),
    warnings: getRuntimeWarnings(config)
  }
}

export function getMcpStatusPayload(): McpStatusPayload {
  const config = getMcpConfigSnapshot()
  return {
    runtime: {
      pid: process.pid,
      platform: process.platform,
      appMode: isElectronPackaged() ? 'packaged' : 'dev',
      launcherMode: getLauncherMode()
    },
    config,
    capabilities: {
      tools: [...MCP_TOOL_NAMES]
    },
    warnings: getRuntimeWarnings(config)
  }
}
