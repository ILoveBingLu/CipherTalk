import path from 'path'
import fs from 'fs'
import { getAppPath, getUserDataPath } from '../../runtimePaths'
import type { AgentDataScope, AgentDefinition } from '../types'

export type AgentCreateInput = Omit<AgentDefinition, 'id' | 'isBuiltin' | 'createdAt' | 'updatedAt'> & {
  id?: string
  isBuiltin?: boolean
}

export type AgentUpdateInput = Partial<Omit<AgentDefinition, 'id' | 'createdAt'>>

const AGENT_FILE = 'AGENT.md'

function createId(): string {
  return `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function sanitizeSegment(value: string): string {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^_+|_+$/g, '')
    || createId()
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function coerceStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    if (trimmed.startsWith('[')) return parseJsonArray(trimmed)
    return trimmed.split(',').map((item) => item.trim()).filter(Boolean)
  }
  return []
}

function coerceNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function coerceOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null' ||
    trimmed.startsWith('[') ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('"')
  ) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // fall through to plain string parsing
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  return trimmed.replace(/^['"]|['"]$/g, '')
}

function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: content.trim() }

  const meta: Record<string, unknown> = {}
  const lines = match[1].split(/\r?\n/)
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!pair) {
      index += 1
      continue
    }

    const key = pair[1]
    const value = pair[2].trim()
    if (value === '>' || value === '|') {
      const blockLines: string[] = []
      index += 1
      while (index < lines.length && (/^\s+/.test(lines[index]) || lines[index].trim() === '')) {
        blockLines.push(lines[index].trim())
        index += 1
      }
      meta[key] = value === '>' ? blockLines.join(' ').replace(/\s+/g, ' ').trim() : blockLines.join('\n').trim()
      continue
    }

    meta[key] = parseScalar(value)
    index += 1
  }

  return { meta, body: match[2].trim() }
}

function stringifyFrontmatterValue(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(String(value ?? ''))
}

function agentToMarkdown(agent: AgentDefinition): string {
  const normalized: AgentDefinition = {
    ...agent,
    name: String(agent.name || '').trim(),
    description: String(agent.description || '').trim(),
    provider: String(agent.provider || '').trim(),
    model: String(agent.model || '').trim(),
    modelPresetId: String(agent.modelPresetId || '').trim() || undefined
  }
  const fields: Array<[string, unknown]> = [
    ['id', normalized.id],
    ['name', normalized.name],
    ['description', normalized.description],
    ['provider', normalized.provider],
    ['model', normalized.model],
    ['modelPresetId', normalized.modelPresetId || ''],
    ['temperature', normalized.temperature],
    ['maxTokens', normalized.maxTokens ?? ''],
    ['maxTurns', normalized.maxTurns],
    ['toolIds', normalized.toolIds || []],
    ['mcpServerIds', normalized.mcpServerIds || []],
    ['skillIds', normalized.skillIds || []],
    ['dataScope', normalized.dataScope],
    ['defaultWorkspace', normalized.defaultWorkspace || ''],
    ['createdAt', normalized.createdAt],
    ['updatedAt', normalized.updatedAt]
  ]
  const frontmatter = fields
    .map(([key, value]) => `${key}: ${stringifyFrontmatterValue(value)}`)
    .join('\n')
  return `---\n${frontmatter}\n---\n\n${String(normalized.systemPrompt || '').trim()}\n`
}

function markdownToAgent(filePath: string, isBuiltin: boolean): AgentDefinition | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const { meta, body } = parseFrontmatter(content)
    const id = String(meta.id || path.basename(path.dirname(filePath))).trim()
    const now = Date.now()
    return {
      id,
      name: String(meta.name || id).trim(),
      description: String(meta.description || '').trim(),
      isBuiltin,
      systemPrompt: body,
      model: String(meta.model || '').trim(),
      provider: String(meta.provider || '').trim(),
      modelPresetId: String(meta.modelPresetId || '').trim() || undefined,
      temperature: coerceNumber(meta.temperature, 0.7),
      maxTokens: coerceOptionalNumber(meta.maxTokens),
      maxTurns: coerceNumber(meta.maxTurns, 15),
      toolIds: coerceStringArray(meta.toolIds),
      mcpServerIds: coerceStringArray(meta.mcpServerIds),
      skillIds: coerceStringArray(meta.skillIds),
      dataScope: (meta.dataScope === 'workspace' || meta.dataScope === 'session') ? meta.dataScope : 'all',
      defaultWorkspace: String(meta.defaultWorkspace || '').trim() || undefined,
      createdAt: coerceNumber(meta.createdAt, now),
      updatedAt: coerceNumber(meta.updatedAt, now)
    }
  } catch {
    return null
  }
}

function getBuiltinAgentRoots(): string[] {
  const resourcesPath = process.resourcesPath || ''
  return unique([
    resourcesPath ? path.join(resourcesPath, 'builtin-agents') : '',
    resourcesPath ? path.join(resourcesPath, 'resources', 'builtin-agents') : '',
    resourcesPath ? path.join(resourcesPath, 'app.asar.unpacked', 'resources', 'builtin-agents') : '',
    path.join(getAppPath(), 'resources', 'builtin-agents'),
    path.join(process.cwd(), 'resources', 'builtin-agents')
  ])
}

function getUserAgentsDir(): string {
  return path.join(getUserDataPath(), 'agents')
}

function scanAgentDir(baseDir: string, isBuiltin: boolean): AgentDefinition[] {
  if (!fs.existsSync(baseDir)) return []
  const agents: AgentDefinition[] = []
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const filePath = path.join(baseDir, entry.name, AGENT_FILE)
    if (!fs.existsSync(filePath)) continue
    const agent = markdownToAgent(filePath, isBuiltin)
    if (agent) agents.push(agent)
  }
  return agents
}

export class AgentConfigStore {
  constructor() {
    this.init()
  }

  init(): void {
    const userAgentsDir = getUserAgentsDir()
    if (!fs.existsSync(userAgentsDir)) fs.mkdirSync(userAgentsDir, { recursive: true })
  }

  private listBuiltinAgents(): AgentDefinition[] {
    const seen = new Set<string>()
    const agents: AgentDefinition[] = []
    for (const root of getBuiltinAgentRoots()) {
      for (const agent of scanAgentDir(root, true)) {
        if (seen.has(agent.id)) continue
        seen.add(agent.id)
        agents.push(agent)
      }
    }
    return agents
  }

  private listUserAgents(): AgentDefinition[] {
    return scanAgentDir(getUserAgentsDir(), false)
  }

  private resolveUserAgentDir(id: string): string | null {
    const userAgentsDir = getUserAgentsDir()
    const direct = path.join(userAgentsDir, sanitizeSegment(id))
    if (fs.existsSync(path.join(direct, AGENT_FILE))) return direct
    if (!fs.existsSync(userAgentsDir)) return null

    for (const entry of fs.readdirSync(userAgentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(userAgentsDir, entry.name)
      const filePath = path.join(candidate, AGENT_FILE)
      if (!fs.existsSync(filePath)) continue
      const agent = markdownToAgent(filePath, false)
      if (agent?.id === id) return candidate
    }
    return null
  }

  private writeUserAgent(agent: AgentDefinition): void {
    const userAgentsDir = getUserAgentsDir()
    const agentDir = this.resolveUserAgentDir(agent.id) || path.join(userAgentsDir, sanitizeSegment(agent.id))
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, AGENT_FILE), agentToMarkdown(agent), 'utf8')
  }

  list(options: { isBuiltin?: boolean; search?: string } = {}): AgentDefinition[] {
    const allAgents = [
      ...this.listBuiltinAgents(),
      ...this.listUserAgents()
    ]
    const search = options.search?.trim().toLowerCase()
    return allAgents
      .filter((agent) => typeof options.isBuiltin === 'boolean' ? agent.isBuiltin === options.isBuiltin : true)
      .filter((agent) => search ? agent.name.toLowerCase().includes(search) : true)
      .sort((a, b) => {
        if (a.isBuiltin !== b.isBuiltin) return a.isBuiltin ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
  }

  get(id: string): AgentDefinition | null {
    return this.list().find((agent) => agent.id === id) || null
  }

  create(input: AgentCreateInput): AgentDefinition {
    if (input.isBuiltin) throw new Error('Built-in agents are loaded from resources/builtin-agents')
    const timestamp = Date.now()
    const agent: AgentDefinition = {
      ...input,
      id: input.id || createId(),
      isBuiltin: false,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    if (this.get(agent.id)) throw new Error(`Agent already exists: ${agent.id}`)
    this.writeUserAgent(agent)
    return agent
  }

  update(id: string, patch: AgentUpdateInput): AgentDefinition {
    const current = this.get(id)
    if (!current) throw new Error(`Agent not found: ${id}`)
    if (current.isBuiltin) throw new Error('Built-in agents cannot be edited')
    const next: AgentDefinition = {
      ...current,
      ...patch,
      id: current.id,
      isBuiltin: false,
      createdAt: current.createdAt,
      updatedAt: Date.now()
    }
    this.writeUserAgent(next)
    return next
  }

  delete(id: string): void {
    const current = this.get(id)
    if (!current) throw new Error(`Agent not found: ${id}`)
    if (current.isBuiltin) throw new Error('Built-in agents cannot be deleted')
    const dir = this.resolveUserAgentDir(id)
    if (!dir) throw new Error(`User agent file not found: ${id}`)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export const agentConfigStore = new AgentConfigStore()
