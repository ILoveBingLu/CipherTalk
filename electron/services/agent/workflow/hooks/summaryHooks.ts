import type { WorkflowFinalPhase, WorkflowHooks, WorkflowState, WorkflowToolInjection } from '../../types'
import type { StructuredAnalysis } from '../../../ai-agent/types/analysis'

export type SummaryWorkflowHookOptions = {
  systemPrompt: string
  userPrompt: string
  structuredAnalysis: StructuredAnalysis | null
  answerTemperature: number
  answerMaxTokens?: number
  enableThinking?: boolean
}

export function createSummaryHooks(
  options: SummaryWorkflowHookOptions
): WorkflowHooks {
  return {
    async shouldStop(_state: WorkflowState): Promise<boolean> {
      return true
    },

    async injectToolCall(_state: WorkflowState): Promise<WorkflowToolInjection | null> {
      if (!options.structuredAnalysis) {
        return {
          toolId: 'native:read_latest',
          args: { count: 40 },
          reason: '结构化抽取为空，需要读取最近消息作为兜底'
        }
      }
      return null
    },

    async finalPhase(_state: WorkflowState): Promise<WorkflowFinalPhase | null> {
      return {
        systemPrompt: options.systemPrompt,
        userPrompt: options.userPrompt,
        temperature: options.answerTemperature,
        maxTokens: options.answerMaxTokens,
        enableThinking: options.enableThinking
      }
    }
  }
}
