import { workerData } from 'worker_threads'
import type { SummaryResult } from '../src/types/ai'
import type { Contact } from './services/chatService'
import { aiService } from './services/ai/aiService'
import { registerNativeAgentTools } from './services/agent/registry/nativeToolBootstrap'
import { runAgent } from './services/agent/runner'
import { createSummaryWorkflow, type SummaryWorkflowOptions } from './services/agent/summaryWorkflow'
import { createWorkerMessenger, consumeAgentEvents, estimateTokenUsage, calculateCost, compactText } from './services/agent/workerShared'

type SerializableSummaryOptions = {
  sessionId: string
  sessionName?: string
  timeRangeDays: number
  timeRangeStart?: number
  timeRangeEnd?: number
  providerName: string
  apiKey: string
  model?: string
  detail?: 'simple' | 'normal' | 'detailed'
  systemPromptPreset?: 'default' | 'decision-focus' | 'action-focus' | 'risk-focus' | 'custom'
  customSystemPrompt?: string
  customRequirement?: string
  enableThinking?: boolean
  inputMessageScopeNote?: string
}

type SummaryWorkerData = {
  requestId: string
  options: SerializableSummaryOptions
  messages: any[]
  contacts: Array<{ username: string; remark: string; nickName: string; alias: string }>
}

const data = workerData as SummaryWorkerData

async function run() {
  const messenger = createWorkerMessenger(data.requestId)

  try {
    aiService.init()
    registerNativeAgentTools()

    const provider = aiService.getConfiguredProvider(data.options.providerName, data.options.apiKey)
    const model = data.options.model || provider.models[0]

    const contactsMap = new Map<string, Contact>()
    for (const c of data.contacts) {
      contactsMap.set(c.username, c)
    }

    messenger.postProgress({
      id: 'preprocess-start', stage: 'preprocess', status: 'running',
      title: '预处理', detail: '正在标准化消息和执行结构化抽取...'
    })

    const workflowOptions: SummaryWorkflowOptions = {
      ...data.options,
      provider
    }

    const workflow = await createSummaryWorkflow(workflowOptions, data.messages, contactsMap)

    messenger.postProgress({
      id: 'preprocess-done', stage: 'preprocess', status: 'completed',
      title: '预处理完成',
      detail: `消息数：${data.messages.length}，结构化分析：${workflow.structuredAnalysisResult ? '成功' : '跳过'}`
    })

    let summaryText = ''

    const { tokenUsage } = await consumeAgentEvents(
      runAgent(workflow.agentDef, workflow.userMessage, workflow.context),
      {
        onThought: (content, turn) => messenger.postProgress({
          id: `agent-thought-${turn}`, stage: 'thought', status: 'completed',
          title: '模型思考', detail: compactText(content, 300)
        }),
        onToolCall: (toolCallId, name, args) => messenger.postProgress({
          id: toolCallId, stage: 'tool', status: 'running',
          title: name, detail: compactText(JSON.stringify(args || {}), 300)
        }),
        onToolResult: (toolCallId, name, result) => messenger.postProgress({
          id: toolCallId, stage: 'tool',
          status: result.ok ? 'completed' : 'failed',
          title: name, detail: compactText(result.content || result.error || '', 500)
        }),
        onText: (content) => {
          summaryText += content
          messenger.postChunk(content)
        }
      }
    )

    const tokensUsed = estimateTokenUsage(tokenUsage, workflow.userPrompt, summaryText)
    const cost = calculateCost(tokensUsed, provider.pricing.input)

    const endTime = Number.isFinite(data.options.timeRangeEnd) && Number(data.options.timeRangeEnd) > 0
      ? Math.floor(Number(data.options.timeRangeEnd))
      : Math.floor(Date.now() / 1000)
    const startTime = Number.isFinite(data.options.timeRangeStart) && Number(data.options.timeRangeStart) >= 0
      ? Math.floor(Number(data.options.timeRangeStart))
      : (data.options.timeRangeDays > 0
        ? endTime - (data.options.timeRangeDays * 24 * 60 * 60)
        : (data.messages[0]?.createTime || endTime))

    const result: SummaryResult = {
      sessionId: data.options.sessionId,
      timeRangeStart: startTime,
      timeRangeEnd: endTime,
      timeRangeDays: data.options.timeRangeDays,
      messageCount: data.messages.length,
      summaryText,
      tokensUsed,
      cost,
      provider: provider.name,
      model,
      createdAt: Date.now(),
      structuredAnalysis: workflow.structuredAnalysisResult?.finalAnalysis as any,
      blockCount: workflow.structuredAnalysisResult?.blockCount
    }

    messenger.postFinal(result)
  } catch (error) {
    messenger.postError(String(error))
  }
}

void run()
