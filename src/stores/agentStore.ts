import { create } from 'zustand'

export type AgentDefinitionView = {
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
  dataScope: 'all' | 'workspace' | 'session'
  defaultWorkspace?: string
  createdAt: number
  updatedAt: number
}

export type AgentToolView = {
  id: string
  name: string
  description: string
  source: 'native' | 'mcp' | 'skill'
  sourceLabel: string
  serverName?: string
  available: boolean
}

export type AgentConversationEvent = {
  id: string
  type: string
  content?: string
  message?: string
  toolCallId?: string
  toolId?: string
  turn?: number
  name?: string
  args?: Record<string, unknown>
  result?: { ok: boolean; content: string; error?: string }
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

interface AgentState {
  agents: AgentDefinitionView[]
  tools: AgentToolView[]
  selectedAgentId: string | null
  isLoading: boolean
  isRunning: boolean
  requestId: string | null
  events: AgentConversationEvent[]
  answerText: string
  error: string | null
  loadAgents: () => Promise<void>
  loadTools: () => Promise<void>
  selectAgent: (id: string | null) => void
  execute: (message: string, selection?: unknown, sessionId?: string) => Promise<{ success: boolean; sessionId?: string; error?: string }>
  cancel: () => Promise<void>
  appendEvent: (event: AgentConversationEvent) => void
}

function getDefaultAgentId(agents: AgentDefinitionView[]): string | null {
  return (
    agents.find((agent) => agent.id === 'builtin-general-agent')?.id ||
    agents.find((agent) => agent.isBuiltin)?.id ||
    agents[0]?.id ||
    null
  )
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: [],
  tools: [],
  selectedAgentId: null,
  isLoading: false,
  isRunning: false,
  requestId: null,
  events: [],
  answerText: '',
  error: null,

  async loadAgents() {
    set({ isLoading: true, error: null })
    try {
      const agents = await window.electronAPI.agent.list()
      set((state) => ({
        agents,
        selectedAgentId: state.selectedAgentId && agents.some((agent) => agent.id === state.selectedAgentId)
          ? state.selectedAgentId
          : getDefaultAgentId(agents)
      }))
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      set({ isLoading: false })
    }
  },

  async loadTools() {
    try {
      const tools = await window.electronAPI.agent.listTools()
      set({ tools })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  selectAgent(id) {
    set({ selectedAgentId: id })
  },

  async execute(message, selection, sessionId) {
    const state = get()
    const agentId = state.selectedAgentId || getDefaultAgentId(state.agents)
    if (!agentId || !message.trim()) return { success: false, error: 'Agent 或消息为空' }
    const requestId = `agent-ui-${Date.now()}`
    set({ selectedAgentId: agentId, isRunning: true, requestId, events: [], answerText: '', error: null })
    const removeListener = window.electronAPI.agent.onExecuteEvent(requestId, (event) => {
      get().appendEvent({ ...event, id: `${event.type}-${Date.now()}-${Math.random()}` })
      if (event.type === 'done') {
        removeListener()
        set({ isRunning: false, requestId: null })
      }
    })
    const result = await window.electronAPI.agent.execute({ requestId, agentId, sessionId, message, selection })
    if (!result.success) {
      removeListener()
      set({ isRunning: false, requestId: null, error: result.error || 'Agent execution failed' })
    }
    return { success: result.success, sessionId: result.sessionId, error: result.error }
  },

  async cancel() {
    const requestId = get().requestId
    if (!requestId) return
    await window.electronAPI.agent.cancel(requestId)
    set({ isRunning: false, requestId: null })
  },

  appendEvent(event) {
    set((state) => ({
      events: [...state.events, event],
      answerText: event.type === 'text' && event.content ? state.answerText + event.content : state.answerText,
      error: event.type === 'error' ? event.message || event.content || state.error : state.error
    }))
  }
}))
