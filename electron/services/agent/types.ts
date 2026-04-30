import type OpenAI from 'openai'
import type { AIProvider } from '../ai/providers/base'

export type AgentToolSource = 'native' | 'mcp' | 'skill'
export type AgentDataScope = 'all' | 'workspace' | 'session'
export type WorkflowContextRequirement = 'none' | 'session' | 'contact' | 'session_or_contact'

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

export type AgentLeafEvent =
  | { type: 'thought'; content: string; turn: number }
  | { type: 'tool_call'; toolCallId: string; toolId: string; name: string; args: Record<string, unknown>; turn: number }
  | { type: 'tool_result'; toolCallId: string; toolId: string; name: string; result: ToolResult; turn: number }
  | { type: 'text'; content: string; turn: number }
  | { type: 'error'; message: string; recoverable?: boolean; turn?: number }
  | { type: 'done'; reason: 'completed' | 'max_turns_reached' | 'aborted' | 'error'; tokenUsage: AgentTokenUsage; turn: number }

export type AgentEvent =
  | AgentLeafEvent
  | {
    type: 'tool_progress'
    parentToolCallId: string
    toolId: string
    name: string
    label?: string
    event: AgentLeafEvent
    turn: number
  }

export interface ToolResult {
  ok: boolean
  content: string
  data?: unknown
  error?: string
}

export interface WorkflowDefinition {
  id: string
  name: string
  version: string
  description: string
  category: string
  builtin: boolean
  agentId: string
  defaultAgentId: string
  allowAgentOverride: boolean
  requiresContext: WorkflowContextRequirement
  toolIds: string[]
  hookNames: string[]
  maxTurns: number
  maxToolCalls: number
  timeoutMs: number
  enableThinking: boolean
  decisionTemperature: number
  answerTemperature: number
  documentation: string
  createdAt: number
  updatedAt: number
}

export interface WorkflowToolResult {
  toolCallId: string
  toolId: string
  name: string
  args: Record<string, unknown>
  result: ToolResult
}

export interface WorkflowState {
  turn: number
  userMessage: string
  messages: AgentChatMessage[]
  turnToolResults: WorkflowToolResult[]
  allToolResults: WorkflowToolResult[]
  abortSignal?: AbortSignal
}

export interface WorkflowToolInjection {
  toolId: string
  args: Record<string, unknown>
  reason: string
}

export interface WorkflowFinalPhase {
  systemPrompt: string
  userPrompt: string
  temperature?: number
  maxTokens?: number
  enableThinking?: boolean
}

export interface WorkflowHooks {
  shouldStop?: (state: WorkflowState) => boolean | Promise<boolean>
  injectToolCall?: (state: WorkflowState) => WorkflowToolInjection | null | Promise<WorkflowToolInjection | null>
  finalPhase?: (state: WorkflowState) => WorkflowFinalPhase | null | Promise<WorkflowFinalPhase | null>
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
  emitEvent?: (event: AgentLeafEvent, options?: { label?: string }) => void
}

export interface RunAgentContext {
  provider: AIProvider
  registry?: {
    getByAgent(toolIds: string[]): import('./registry/unifiedTool').UnifiedTool[]
  }
  selection?: AgentContextSelection
  systemContext?: string
  historyMessages?: AgentChatMessage[]
  workflow?: WorkflowHooks
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
