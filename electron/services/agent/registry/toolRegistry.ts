import type { AgentDefinition } from '../types'
import type { UnifiedTool } from './unifiedTool'

export type ToolMetadata = {
  id: string
  name: string
  description: string
  source: UnifiedTool['source']
  sourceLabel: string
  serverName?: string
  available: boolean
}

export class ToolRegistry {
  private tools = new Map<string, UnifiedTool>()

  register(tool: UnifiedTool): void {
    if (!tool.id) throw new Error('Tool id is required')
    if (this.tools.has(tool.id)) throw new Error(`Tool already registered: ${tool.id}`)
    this.tools.set(tool.id, tool)
  }

  upsert(tool: UnifiedTool): void {
    if (!tool.id) throw new Error('Tool id is required')
    this.tools.set(tool.id, tool)
  }

  unregister(toolId: string): boolean {
    return this.tools.delete(toolId)
  }

  unregisterBy(predicate: (tool: UnifiedTool) => boolean): number {
    let count = 0
    for (const tool of this.tools.values()) {
      if (predicate(tool)) {
        this.tools.delete(tool.id)
        count += 1
      }
    }
    return count
  }

  get(toolId: string): UnifiedTool | undefined {
    return this.tools.get(toolId)
  }

  getByName(name: string): UnifiedTool | undefined {
    return [...this.tools.values()].find((tool) => tool.name === name)
  }

  getAll(): UnifiedTool[] {
    return [...this.tools.values()]
  }

  getByAgent(agentOrToolIds: AgentDefinition | string[]): UnifiedTool[] {
    const toolIds = Array.isArray(agentOrToolIds) ? agentOrToolIds : agentOrToolIds.toolIds
    const selectedIds = [...new Set(toolIds)]
    if (selectedIds.length === 0) return []
    return selectedIds
      .map((toolId) => this.tools.get(toolId))
      .filter((tool): tool is UnifiedTool => Boolean(tool?.isAvailable()))
  }

  listMetadata(): ToolMetadata[] {
    return this.getAll().map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      source: tool.source,
      sourceLabel: tool.sourceLabel,
      serverName: tool.serverName,
      available: tool.isAvailable()
    }))
  }
}

export const toolRegistry = new ToolRegistry()
