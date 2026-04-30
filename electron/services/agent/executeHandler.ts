import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { ConfigService } from '../config'
import { aiService } from '../ai/aiService'
import type { AIProvider } from '../ai/providers/base'
import { mcpClientService } from '../mcpClientService'
import { skillManagerService } from '../skillManagerService'
import type { AgentDefinition, AgentEvent, RunAgentContext } from './types'
import { agentConfigStore } from './config/agentConfigStore'
import { agentSessionStore, type AgentVectorRecallConfig } from './session/agentSessionStore'
import { bootstrapAgentTools } from './registry/bootstrap'
import { toolRegistry } from './registry/toolRegistry'
import { createToolId } from './registry/unifiedTool'
import { runAgent } from './runner'
import {
  createAgentSessionQAToolExecutor,
  getAgentSessionQATarget,
  hasAgentSessionQASelection,
  resolveSessionQAToolIds
} from './sessionQaToolContext'

export type AgentExecuteRequest = {
  requestId?: string
  agentId: string
  sessionId?: string
  message: string
  selection?: any
  provider?: string
  apiKey?: string
  model?: string
}

export type AgentMemoryRuntime = {
  provider: AIProvider
  providerName?: string
  model: string
}

export type RegisterAgentExecuteHandlersOptions = {
  configService: ConfigService | null
  resolveAgentMemoryRuntime: (
    agent: Pick<AgentDefinition, 'isBuiltin' | 'provider' | 'model' | 'modelPresetId'>,
    fallback?: AgentMemoryRuntime
  ) => AgentMemoryRuntime
  getAgentVectorRecallConfig: () => AgentVectorRecallConfig
}

const agentRunControllers = new Map<string, AbortController>()

function buildAgentUserMessage(message: string, selection?: any): string {
  const parts = [String(message || '').trim()]
  const selectedSessions = Array.isArray(selection?.selectedSessions) ? selection.selectedSessions : []
  const selectedContacts = Array.isArray(selection?.selectedContacts) ? selection.selectedContacts : []
  const selectedSkills = Array.isArray(selection?.selectedSkills) ? selection.selectedSkills : []
  const selectedWorkflow = selection?.selectedWorkflow || null
  const action = selection?.action || null
  const timeRange = selection?.timeRange
  if (selectedSessions.length || selectedContacts.length || selectedSkills.length || selectedWorkflow || action || timeRange) {
    parts.push(`\nStructured context hints:\n${JSON.stringify({
      selectedSessions,
      selectedContacts,
      selectedSkills,
      selectedWorkflow,
      action,
      timeRange: timeRange || null
    }, null, 2)}`)
  }
  return parts.filter(Boolean).join('\n')
}

function toSkillToolId(skillId: unknown): string | null {
  const normalized = String(skillId || '').trim()
  if (!normalized) return null
  return normalized.startsWith('skill:') ? normalized : createToolId('skill', normalized)
}

function normalizeSkillName(value: unknown): string {
  return String(value || '').trim().replace(/^skill:/, '')
}

function getAgentSkillToolIds(agent: { skillIds?: string[] }, selection?: any): string[] {
  const selectedSkills = Array.isArray(selection?.selectedSkills) ? selection.selectedSkills : []
  const ids = [
    ...(Array.isArray(agent.skillIds) ? agent.skillIds : []),
    ...selectedSkills.map((item: any) => item?.id || item?.name)
  ]
  return [...new Set(ids.map(toSkillToolId).filter((toolId): toolId is string => Boolean(toolId)))]
}

function mergeToolIds(...groups: string[][]): string[] {
  return [...new Set(groups.flat().filter(Boolean))]
}

function filterAvailableAgentToolIds(toolIds: string[] = []): string[] {
  return [...new Set(toolIds)].filter((toolId) => Boolean(toolRegistry.get(toolId)?.isAvailable()))
}

function sanitizeAgentSelection(selection?: any): any {
  if (!selection || typeof selection !== 'object') return selection
  const availableSkills = new Set(skillManagerService.listSkills().map((skill) => skill.name))
  const selectedSkills = Array.isArray(selection.selectedSkills)
    ? selection.selectedSkills.filter((item: any) => {
        const skillName = normalizeSkillName(item?.id || item?.name)
        return Boolean(skillName && availableSkills.has(skillName))
      })
    : selection.selectedSkills
  return {
    ...selection,
    selectedSkills
  }
}

function isUsableCustomBaseURL(baseURL?: string): boolean {
  return /^https?:\/\//i.test(String(baseURL || '').trim())
}

async function executeAgentRequest(
  event: IpcMainInvokeEvent,
  request: AgentExecuteRequest,
  options: RegisterAgentExecuteHandlersOptions
) {
  await bootstrapAgentTools()
  const requestId = request.requestId || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const agent = agentConfigStore.get(request.agentId)
  if (!agent) return { success: false, requestId, error: `Agent not found: ${request.agentId}` }
  const selection = sanitizeAgentSelection(request.selection)
  const sessionQATarget = getAgentSessionQATarget(selection)
  if (hasAgentSessionQASelection(selection) && !sessionQATarget) {
    return {
      success: false,
      requestId,
      error: '会话参数无效，请重新用 # 从补全列表选择会话、群聊或联系人。'
    }
  }

  try {
    const currentProviderName = options.configService?.getAICurrentProvider()
    const currentProviderConfig = currentProviderName
      ? options.configService?.getAIProviderConfig(currentProviderName)
      : undefined
    const agentModel = !agent.isBuiltin && agent.model ? String(agent.model).trim() : undefined
    const aiConfigPresets = options.configService?.getAIConfigPresets() || []
    const matchedPreset = !agent.isBuiltin && agent.modelPresetId
      ? aiConfigPresets.find((preset) => preset.id === agent.modelPresetId)
      : undefined
    const agentProviderName = !agent.isBuiltin
      ? matchedPreset?.provider || agent.provider || undefined
      : undefined
    const providerName = request.provider || agentProviderName
    const matchedPresetBaseURL = matchedPreset?.baseURL?.trim()
    if (providerName === 'custom' && matchedPreset && !isUsableCustomBaseURL(matchedPresetBaseURL)) {
      return {
        success: false,
        requestId,
        error: `Agent 模型预设「${matchedPreset.name || matchedPreset.model}」的服务地址无效，请以 http:// 或 https:// 开头。`
      }
    }
    const provider = aiService.getConfiguredProvider(
      providerName,
      request.apiKey || matchedPreset?.apiKey,
      matchedPresetBaseURL ? { baseURL: matchedPresetBaseURL } : undefined
    )
    const effectiveProviderName = providerName || currentProviderName || provider.name
    const configuredModel = effectiveProviderName
      ? (effectiveProviderName === currentProviderName ? currentProviderConfig : options.configService?.getAIProviderConfig(effectiveProviderName))?.model
      : undefined
    const controller = new AbortController()
    agentRunControllers.set(requestId, controller)
    const runModel = String(request.model || matchedPreset?.model || agentModel || configuredModel || provider.models[0] || '').trim()
    const baseToolIds = resolveSessionQAToolIds(agent.toolIds, sessionQATarget)
    const selectedSkillToolIds = getAgentSkillToolIds(agent, selection)
    const runtimeToolIds = filterAvailableAgentToolIds(mergeToolIds(baseToolIds, selectedSkillToolIds))
    const runConfig = {
      ...agent,
      provider: providerName || provider.name,
      model: runModel,
      toolIds: runtimeToolIds,
      mcpServerIds: agent.mcpServerIds.filter((serverName) => mcpClientService.hasClientConfig(serverName)),
      skillIds: agent.skillIds.filter((skillId) => Boolean(skillManagerService.readSkillContent(normalizeSkillName(skillId)).success))
    }
    const memoryRuntime = options.resolveAgentMemoryRuntime(agent, {
      provider,
      providerName: providerName || provider.name,
      model: runModel
    })
    const vectorRecall = options.getAgentVectorRecallConfig()
    const agentSession = agentSessionStore.ensureSession(request.sessionId, {
      agentId: agent.id,
      firstMessage: request.message
    })
    agentSessionStore.updateSession(agentSession.id, { agentId: agent.id })
    const memoryContext = await agentSessionStore.prepareRunContext({
      sessionId: agentSession.id,
      agent: runConfig,
      provider: memoryRuntime.provider,
      model: memoryRuntime.model,
      userMessage: request.message,
      vectorRecall
    })
    agentSessionStore.appendMessage({
      sessionId: agentSession.id,
      role: 'user',
      content: request.message,
      selection,
      agentName: agent.name
    })

    let nativeSessionQAToolExecutor: undefined | ((toolName: string, args: Record<string, unknown>) => Promise<any>)
    let effectiveRunContext: RunAgentContext = {
      provider,
      selection,
      systemContext: memoryContext.systemContext,
      historyMessages: memoryContext.historyMessages,
      nativeSessionQAToolExecutor
    }

    if (sessionQATarget?.id) {
      nativeSessionQAToolExecutor = await createAgentSessionQAToolExecutor({
        target: sessionQATarget,
        question: request.message,
        provider,
        model: runConfig.model,
        signal: controller.signal
      })
      effectiveRunContext = {
        provider,
        selection,
        systemContext: memoryContext.systemContext,
        historyMessages: memoryContext.historyMessages,
        nativeSessionQAToolExecutor
      }
    }

    const userMessage = buildAgentUserMessage(request.message, selection)
    const channel = `agent:execute:event:${requestId}`

    void (async () => {
      const storedEvents: any[] = []
      let answerText = ''
      let errorText = ''
      let doneReason = ''
      let doneEvent: any = null
      const emitEvent = (item: AgentEvent, options: { send?: boolean; collectText?: boolean } = {}) => {
        const send = options.send !== false
        const collectText = options.collectText !== false
        storedEvents.push(item)
        if (collectText && item.type === 'text' && item.content) answerText += item.content
        if (item.type === 'error' && item.message) errorText = item.message
        if (item.type === 'done') doneReason = item.reason
        if (item.type === 'done') {
          doneEvent = item
          return
        }
        if (send && !event.sender.isDestroyed()) event.sender.send(channel, item)
      }

      try {
        for await (const item of runAgent(runConfig, userMessage, effectiveRunContext, controller.signal)) {
          emitEvent(item)
        }
      } catch (error) {
        errorText = error instanceof Error ? error.message : String(error)
        emitEvent({ type: 'error', message: errorText })
        emitEvent({
          type: 'done',
          reason: 'error',
          tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          turn: 0
        })
      } finally {
        if (doneReason !== 'aborted' && (answerText.trim() || errorText.trim() || storedEvents.length > 0)) {
          try {
            const assistantMessage = agentSessionStore.appendMessage({
              sessionId: agentSession.id,
              role: 'assistant',
              content: answerText || errorText,
              agentName: agent.name,
              error: Boolean(errorText && !answerText),
              events: storedEvents as any
            })
            if (answerText.trim()) {
              await agentSessionStore.extractObservationsFromRun({
                sessionId: agentSession.id,
                agent: runConfig,
                provider: memoryRuntime.provider,
                model: memoryRuntime.model,
                userMessage: request.message,
                assistantText: answerText,
                events: storedEvents as any,
                sourceMessageId: assistantMessage.id,
                vectorRecall
              })
            }
          } catch (storeError) {
            console.warn('[Agent] 保存 Agent 回复失败:', storeError)
          }
        }
        if (doneEvent && !event.sender.isDestroyed()) {
          event.sender.send(channel, doneEvent)
        }
        agentRunControllers.delete(requestId)
      }
    })()

    return { success: true, requestId, sessionId: agentSession.id }
  } catch (error) {
    agentRunControllers.delete(requestId)
    return { success: false, requestId, error: error instanceof Error ? error.message : String(error) }
  }
}

export function registerAgentExecuteHandlers(options: RegisterAgentExecuteHandlersOptions): void {
  ipcMain.handle('agent:execute', async (event, request: AgentExecuteRequest) => {
    return executeAgentRequest(event, request, options)
  })
  ipcMain.handle('agent:cancel', async (_, requestId: string) => {
    const controller = agentRunControllers.get(requestId)
    if (!controller) return { success: false, error: `Agent run not found: ${requestId}` }
    controller.abort()
    agentRunControllers.delete(requestId)
    return { success: true }
  })
}
