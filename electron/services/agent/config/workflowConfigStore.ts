import path from 'path'
import fs from 'fs'
import { getAppPath, getUserDataPath } from '../../runtimePaths'
import type { WorkflowContextRequirement, WorkflowDefinition } from '../types'

const WORKFLOW_FILE = 'WORKFLOW.md'

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

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return fallback
}

function coerceContextRequirement(value: unknown): WorkflowContextRequirement {
  const normalized = String(value || '').trim()
  if (
    normalized === 'session' ||
    normalized === 'contact' ||
    normalized === 'session_or_contact'
  ) {
    return normalized
  }
  return 'none'
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
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!pair) continue
    meta[pair[1]] = parseScalar(pair[2])
  }
  return { meta, body: match[2].trim() }
}

function getBuiltinWorkflowRoots(): string[] {
  const resourcesPath = process.resourcesPath || ''
  return unique([
    resourcesPath ? path.join(resourcesPath, 'builtin-workflows') : '',
    resourcesPath ? path.join(resourcesPath, 'resources', 'builtin-workflows') : '',
    resourcesPath ? path.join(resourcesPath, 'app.asar.unpacked', 'resources', 'builtin-workflows') : '',
    path.join(getAppPath(), 'resources', 'builtin-workflows'),
    path.join(process.cwd(), 'resources', 'builtin-workflows')
  ])
}

function getUserWorkflowsDir(): string {
  return path.join(getUserDataPath(), 'workflows')
}

function markdownToWorkflow(filePath: string, builtin: boolean): WorkflowDefinition | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const { meta, body } = parseFrontmatter(content)
    const id = String(meta.id || path.basename(path.dirname(filePath))).trim()
    const now = Date.now()
    const defaultAgentId = String(meta.defaultAgentId || meta.agentId || '').trim()
    return {
      id,
      name: String(meta.name || id).trim(),
      version: String(meta.version || '1.0.0').trim(),
      description: String(meta.description || '').trim(),
      category: String(meta.category || '').trim(),
      builtin: coerceBoolean(meta.builtin, builtin),
      agentId: defaultAgentId,
      defaultAgentId,
      allowAgentOverride: coerceBoolean(meta.allowAgentOverride, false),
      requiresContext: coerceContextRequirement(meta.requiresContext),
      toolIds: coerceStringArray(meta.toolIds || meta.tools),
      hookNames: coerceStringArray(meta.hookNames),
      maxTurns: coerceNumber(meta.maxTurns, 15),
      maxToolCalls: coerceNumber(meta.maxToolCalls, 30),
      timeoutMs: coerceNumber(meta.timeoutMs, 300000),
      enableThinking: coerceBoolean(meta.enableThinking, true),
      decisionTemperature: coerceNumber(meta.decisionTemperature, 0.2),
      answerTemperature: coerceNumber(meta.answerTemperature, 0.3),
      documentation: body,
      createdAt: coerceNumber(meta.createdAt, now),
      updatedAt: coerceNumber(meta.updatedAt, now)
    }
  } catch {
    return null
  }
}

function scanWorkflowDir(baseDir: string, builtin: boolean): WorkflowDefinition[] {
  if (!fs.existsSync(baseDir)) return []
  const workflows: WorkflowDefinition[] = []
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const filePath = path.join(baseDir, entry.name, WORKFLOW_FILE)
    if (!fs.existsSync(filePath)) continue
    const workflow = markdownToWorkflow(filePath, builtin)
    if (workflow) workflows.push(workflow)
  }
  return workflows
}

export class WorkflowConfigStore {
  constructor() {
    this.init()
  }

  init(): void {
    const userWorkflowsDir = getUserWorkflowsDir()
    if (!fs.existsSync(userWorkflowsDir)) fs.mkdirSync(userWorkflowsDir, { recursive: true })
  }

  list(options: { isBuiltin?: boolean; search?: string } = {}): WorkflowDefinition[] {
    const seen = new Set<string>()
    const workflows: WorkflowDefinition[] = []
    for (const root of getBuiltinWorkflowRoots()) {
      for (const workflow of scanWorkflowDir(root, true)) {
        if (seen.has(workflow.id)) continue
        seen.add(workflow.id)
        workflows.push(workflow)
      }
    }
    for (const workflow of scanWorkflowDir(getUserWorkflowsDir(), false)) {
      if (seen.has(workflow.id)) continue
      seen.add(workflow.id)
      workflows.push(workflow)
    }

    const search = options.search?.trim().toLowerCase()
    return workflows
      .filter((workflow) => typeof options.isBuiltin === 'boolean' ? workflow.builtin === options.isBuiltin : true)
      .filter((workflow) => search ? workflow.name.toLowerCase().includes(search) : true)
      .sort((a, b) => {
        if (a.builtin !== b.builtin) return a.builtin ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      })
  }

  get(id: string): WorkflowDefinition | null {
    return this.list().find((workflow) => workflow.id === id) || null
  }
}

export const workflowConfigStore = new WorkflowConfigStore()
