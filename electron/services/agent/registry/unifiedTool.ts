import type { NativeToolDefinition } from '../../ai/providers/base'
import type { AgentToolSource, ToolExecutionContext, ToolResult } from '../types'

export interface UnifiedTool {
  id: string
  name: string
  description: string
  parameters: Record<string, unknown>
  source: AgentToolSource
  sourceLabel: string
  serverName?: string
  execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult>
  toOpenAITool(): NativeToolDefinition
  isAvailable(): boolean
}

export function createToolId(source: AgentToolSource, name: string, namespace?: string): string {
  const safeNamespace = namespace ? `${namespace}:` : ''
  return `${source}:${safeNamespace}${name}`.replace(/\s+/g, '_')
}

export function toOpenAITool(tool: Pick<UnifiedTool, 'name' | 'description' | 'parameters'>): NativeToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }
}

export function wrapNativeToolDefinition(
  definition: NativeToolDefinition,
  execute: UnifiedTool['execute'],
  options?: { id?: string; sourceLabel?: string; available?: () => boolean }
): UnifiedTool {
  const fn = definition.function
  const name = fn.name
  return {
    id: options?.id || createToolId('native', name),
    name,
    description: fn.description || '',
    parameters: (fn.parameters || { type: 'object', properties: {} }) as Record<string, unknown>,
    source: 'native',
    sourceLabel: options?.sourceLabel || 'CipherTalk',
    execute,
    toOpenAITool() {
      return toOpenAITool(this)
    },
    isAvailable() {
      return options?.available ? options.available() : true
    }
  }
}
