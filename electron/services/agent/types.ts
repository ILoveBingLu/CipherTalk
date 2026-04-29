import type OpenAI from 'openai'
import type { AIProvider } from '../ai/providers/base'

export type AgentToolSource = 'native' | 'mcp' | 'skill'
export type AgentDataScope = 'all' | 'workspace' | 'session'

export interface AgentTokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface AgentDefinition {
  id: string
  name: string
  description: string
  isBuiltin: boolean
  systemPrompt: string
  model: string
  provider: string
  modelPresetId?: string
  temperature: number
  maxTokens?: number
  maxTurns: number
  toolIds: string[]
  mcpServerIds: string[]
  skillIds: string[]
  dataScope: AgentDataScope
  defaultWorkspace?: string
  createdAt: number
  updatedAt: number
}

export type AgentEvent =
  | { type: 'thought'; content: string; turn: number }
  | { type: 'tool_call'; toolCallId: string; toolId: string; name: string; args: Record<string, unknown>; turn: number }
  | { type: 'tool_result'; toolCallId: string; toolId: string; name: string; result: ToolResult; turn: number }
  | { type: 'text'; content: string; turn: number }
  | { type: 'error'; message: string; recoverable?: boolean; turn?: number }
  | { type: 'done'; reason: 'completed' | 'max_turns_reached' | 'aborted' | 'error'; tokenUsage: AgentTokenUsage; turn: number }

export interface ToolResult {
  ok: boolean
  content: string
  data?: unknown
  error?: string
}

export interface AgentContextSelection {
  selectedSessions?: Array<{ id: string; name?: string }>
  selectedContacts?: Array<{ id: string; name?: string }>
  selectedSkills?: Array<{ id: string; name?: string }>
  timeRange?: { label?: string; start?: number; end?: number }
  skillId?: string
}

export interface ToolExecutionContext {
  agent: AgentDefinition
  provider?: AIProvider
  model?: string
  userMessage: string
  selection?: AgentContextSelection
  signal?: AbortSignal
  nativeSessionQAToolExecutor?: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>
}

export interface RunAgentContext {
  provider: AIProvider
  registry?: {
    getByAgent(toolIds: string[]): import('./registry/unifiedTool').UnifiedTool[]
  }
  selection?: AgentContextSelection
  nativeSessionQAToolExecutor?: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>
}

export type AgentToolCall = {
  id: string
  type?: string
  function?: {
    name?: string
    arguments?: string
  }
}

export type AgentChatMessage = OpenAI.Chat.ChatCompletionMessageParam
