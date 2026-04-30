import type { WorkflowFinalPhase, WorkflowHooks, WorkflowState, WorkflowToolInjection } from '../../types'
import { hasConclusiveSearchFailure } from '../../../ai-agent/qa/evidence'
import { pickFallbackToolAction } from '../../../ai-agent/qa/orchestrator'
import { buildAnswerPrompt } from '../../../ai-agent/qa/prompts/answer'
import type { AgentContext } from '../../../ai-agent/qa/agentContext'

export type SessionQAWorkflowHookOptions = {
  structuredContext: string
  historyText: string
  answerTemperature: number
  answerMaxTokens?: number
  enableThinking?: boolean
}

function toolActionToInjection(action: ReturnType<typeof pickFallbackToolAction>): WorkflowToolInjection | null {
  if (action.action === 'answer') return null
  return {
    toolId: `native:${action.action}`,
    args: { ...action },
    reason: action.reason || 'SessionQA 工作流需要继续收集证据'
  }
}

export function createSessionQAHooks(
  ctx: AgentContext,
  options: SessionQAWorkflowHookOptions
): WorkflowHooks {
  return {
    async shouldStop(_state: WorkflowState): Promise<boolean> {
      if (ctx.evidenceQuality === 'sufficient') return true
      if (hasConclusiveSearchFailure(ctx.searchPayloads)) return true
      if (ctx.evidenceQuality === 'none' && ctx.route.intent !== 'direct_answer') return false
      return true
    },

    async injectToolCall(_state: WorkflowState): Promise<WorkflowToolInjection | null> {
      if (ctx.evidenceQuality === 'sufficient') return null
      if (hasConclusiveSearchFailure(ctx.searchPayloads)) return null
      return toolActionToInjection(pickFallbackToolAction(ctx, ctx.route))
    },

    async finalPhase(_state: WorkflowState): Promise<WorkflowFinalPhase | null> {
      const promptText = buildAnswerPrompt({
        sessionName: ctx.sessionName,
        question: ctx.question,
        route: ctx.route,
        summaryText: ctx.options.summaryText,
        structuredContext: options.structuredContext,
        summaryFactsText: ctx.summaryFactsText,
        contextWindows: ctx.contextWindows,
        searchPayloads: ctx.searchPayloads,
        aggregateText: ctx.aggregateText,
        resolvedParticipants: ctx.resolvedParticipants,
        historyText: options.historyText,
        usedRecentFallback: ctx.usedRecentFallback
      })

      ctx.lastAgentPrompt = promptText
      return {
        systemPrompt: '你是严谨的聊天记录问答助手。你必须基于给定上下文回答，并在证据不足时明确承认不足。',
        userPrompt: promptText,
        temperature: options.answerTemperature,
        maxTokens: options.answerMaxTokens,
        enableThinking: options.enableThinking
      }
    }
  }
}
