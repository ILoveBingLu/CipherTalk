import { workerData } from 'worker_threads'
import type {
  SessionQAProgressEvent,
  SessionQAResult
} from '../src/types/ai'
import type { SessionQAOptions } from './services/ai/aiService'
import { aiService } from './services/ai/aiService'
import { registerNativeAgentTools } from './services/agent/registry/nativeToolBootstrap'
import { runAgent } from './services/agent/runner'
import { createSessionQAWorkflow } from './services/agent/sessionQAWorkflow'
import {
  DEFAULT_AGENT_ANSWER_MAX_TOKENS,
  DEFAULT_AGENT_DECISION_MAX_TOKENS
} from './services/ai-agent/qa/types'
import { createWorkerMessenger, consumeAgentEvents, estimateTokenUsage, calculateCost, compactText } from './services/agent/workerShared'

type SessionQAWorkerData = {
  requestId: string
  options: SessionQAOptions
}

const data = workerData as SessionQAWorkerData

async function run() {
  const messenger = createWorkerMessenger(data.requestId)

  try {
    aiService.init()
    registerNativeAgentTools()

    const question = String(data.options.question || '').trim()
    if (!question) throw new Error('问题不能为空')

    const provider = aiService.getConfiguredProvider(data.options.provider, data.options.apiKey)
    const model = data.options.model || provider.models[0]
    const agentDecisionMaxTokens = Number(data.options.agentDecisionMaxTokens || DEFAULT_AGENT_DECISION_MAX_TOKENS)
    const agentAnswerMaxTokens = Number(data.options.agentAnswerMaxTokens || DEFAULT_AGENT_ANSWER_MAX_TOKENS)
    const workflow = await createSessionQAWorkflow({
      ...data.options,
      question,
      provider,
      model,
      agentDecisionMaxTokens,
      agentAnswerMaxTokens,
      onChunk: (chunk) => messenger.postChunk(chunk),
      onProgress: (progress) => {
        messenger.post({
          kind: 'progress',
          progress: {
            ...progress,
            requestId: data.requestId,
            elapsedMs: Date.now() - Date.now()
          }
        })
      }
    })

    let answerText = ''

    const { tokenUsage } = await consumeAgentEvents(
      runAgent(workflow.agentDef, workflow.userMessage, workflow.context),
      {
        onThought: (content, turn) => messenger.postProgress({
          id: `agent-thought-${turn}`, stage: 'thought', status: 'completed',
          title: '模型思考', displayName: '模型思考', nodeName: '模型思考',
          detail: compactText(content, 300), source: 'model'
        }),
        onToolCall: (toolCallId, name, args) => messenger.postProgress({
          id: toolCallId, stage: 'tool', status: 'running',
          title: name, displayName: name, nodeName: name,
          detail: compactText(JSON.stringify(args || {}), 300),
          toolName: name as any, source: 'model'
        }),
        onToolResult: (toolCallId, name, result, toolId) => messenger.postProgress({
          id: toolCallId, stage: 'tool',
          status: result.ok ? 'completed' : 'failed',
          title: name, displayName: name, nodeName: name,
          detail: compactText(result.content || result.error || '', 500),
          toolName: name as any,
          source: toolId.startsWith('native:') ? 'chat' : 'model'
        }),
        onText: (content) => {
          answerText += content
          messenger.postChunk(content)
        }
      }
    )

    const promptText = workflow.agentContext.lastAgentPrompt
      ? `${workflow.userMessage}\n\n--- final answer prompt ---\n${workflow.agentContext.lastAgentPrompt}`
      : workflow.userMessage
    const tokensUsed = estimateTokenUsage(tokenUsage, promptText, answerText)
    const cost = calculateCost(tokensUsed, provider.pricing.input)
    const result: SessionQAResult = {
      sessionId: data.options.sessionId,
      question,
      answerText,
      evidenceRefs: workflow.agentContext.evidenceCandidates,
      toolCalls: workflow.agentContext.toolCalls,
      tokensUsed,
      cost,
      provider: provider.name,
      model,
      createdAt: Date.now()
    }

    messenger.postFinal(result)
  } catch (error) {
    messenger.postError(String(error))
  }
}

void run()
