import type { AIProvider } from '../ai/providers/base'
import type { AgentDefinition, RunAgentContext } from './types'
import { AgentContext } from '../ai-agent/qa/agentContext'
import { enforceConcreteEvidenceRoute, routeFromHeuristics } from '../ai-agent/qa/intent/router'
import { refineRouteWithAIIntent } from '../ai-agent/qa/intent/aiRouter'
import { buildAutonomousAgentPrompt } from '../ai-agent/qa/prompts/decision'
import { stripThinkBlocks } from '../ai-agent/qa/utils/text'
import type { SessionQAAgentOptions } from '../ai-agent/qa/types'
import { createSessionQAHooks } from './workflow/hooks/sessionQaHooks'
import { resolveWorkflowConfig, resolveBaseAgent, buildAgentDefinition, loadContactMapWithSessionName, createNativeToolExecutor } from './workflowShared'

function compactText(text: string, maxLength: number): string {
  if (!text) return ''
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function buildStructuredContext(analysis?: SessionQAAgentOptions['structuredAnalysis']): string {
  if (!analysis) return ''
  try {
    return compactText(JSON.stringify(analysis, null, 2), 4000)
  } catch {
    return ''
  }
}

function buildHistoryContext(history: SessionQAAgentOptions['history'] = []): string {
  return history
    .slice(-6)
    .map((item) => `${item.role === 'user' ? '用户' : '助手'}：${compactText(stripThinkBlocks(item.content || ''), 600)}`)
    .join('\n')
}

export type SessionQAWorkflowBuildResult = {
  workflowId: string
  agentDef: AgentDefinition
  userMessage: string
  context: RunAgentContext
  agentContext: AgentContext
}

export async function createSessionQAWorkflow(options: SessionQAAgentOptions): Promise<SessionQAWorkflowBuildResult> {
  const workflow = resolveWorkflowConfig('builtin-session-qa')
  const baseAgentId = options.agentId || workflow.defaultAgentId || workflow.agentId || 'builtin-general-agent'
  const baseAgent = resolveBaseAgent(baseAgentId)

  const structuredContext = buildStructuredContext(options.structuredAnalysis)
  const historyText = buildHistoryContext(options.history)
  const heuristicRoute = routeFromHeuristics(options.question, options.summaryText)
  let route = heuristicRoute
  if (!(heuristicRoute.intent === 'direct_answer' && !heuristicRoute.needsSearch)) {
    try {
      const aiRoute = await refineRouteWithAIIntent({
        provider: options.provider,
        model: options.model,
        question: options.question,
        sessionName: options.sessionName,
        historyText,
        heuristicRoute
      })
      route = aiRoute.route
    } catch {
      route = heuristicRoute
    }
  }
  if (!(route.intent === 'direct_answer' && !route.needsSearch)) {
    route = enforceConcreteEvidenceRoute(route, options.question)
  }

  const contactMap = await loadContactMapWithSessionName(options.sessionId, options.sessionName)
  const ctx = new AgentContext(options, route, contactMap)
  const userMessage = buildAutonomousAgentPrompt({
    sessionName: ctx.sessionName,
    question: ctx.question,
    route,
    summaryText: options.summaryText,
    structuredContext,
    historyText,
    observations: ctx.observations,
    knownHits: ctx.knownHits,
    resolvedParticipants: ctx.resolvedParticipants,
    aggregateText: ctx.aggregateText,
    summaryFactsRead: ctx.summaryFactsRead,
    toolCallsUsed: ctx.toolCallsUsed,
    evidenceQuality: ctx.evidenceQuality,
    searchRetries: ctx.searchRetries,
    searchPayloads: ctx.searchPayloads,
    contextWindows: ctx.contextWindows
  })
  ctx.lastAgentPrompt = userMessage

  const agentDef = buildAgentDefinition(baseAgent, workflow, options.provider, options.model, options.agentDecisionMaxTokens)

  const nativeSessionQAToolExecutor = createNativeToolExecutor(ctx)

  return {
    workflowId: workflow.id,
    agentDef,
    userMessage,
    context: {
      provider: options.provider as AIProvider,
      workflow: createSessionQAHooks(ctx, {
        structuredContext,
        historyText,
        answerTemperature: workflow.answerTemperature,
        answerMaxTokens: options.agentAnswerMaxTokens,
        enableThinking: options.enableThinking
      }),
      selection: {
        selectedSessions: [{ id: options.sessionId, name: options.sessionName }]
      },
      nativeSessionQAToolExecutor
    },
    agentContext: ctx
  }
}
