/**
 * Workflow 构建共用工具函数，供 summaryWorkflow / sessionQAWorkflow 共享。
 */
import type { AIProvider } from '../ai/providers/base'
import type { AgentDefinition, RunAgentContext, ToolResult } from './types'
import { agentConfigStore } from './config/agentConfigStore'
import { workflowConfigStore } from './config/workflowConfigStore'
import { AgentContext } from '../ai-agent/qa/agentContext'
import { parseNativeToolCallArguments } from '../ai-agent/qa/nativeTools'
import { createFailedNativeToolResult, executeNativeToolAction } from '../ai-agent/qa/orchestrator'
import { loadSessionContactMap } from '../ai-agent/qa/utils/contacts'
import type { SessionQAAgentOptions } from '../ai-agent/qa/types'

// ─── Config 查找 ───

export function resolveWorkflowConfig(workflowKey: string) {
  const workflow = workflowConfigStore.get(workflowKey)
  if (!workflow) throw new Error(`内置 Workflow 未找到：${workflowKey}`)
  return workflow
}

export function resolveBaseAgent(agentId?: string) {
  const id = agentId || 'builtin-general-agent'
  const agent = agentConfigStore.get(id) || agentConfigStore.get('builtin-general-agent')
  if (!agent) throw new Error(`Workflow 引用的 Agent 未找到：${id}`)
  return agent
}

// ─── AgentDefinition 构建 ───

export function buildAgentDefinition(
  baseAgent: AgentDefinition,
  workflow: { decisionTemperature: number; maxTurns: number; toolIds: string[] },
  provider: AIProvider | { name: string },
  model: string,
  maxTokens?: number
): AgentDefinition {
  return {
    ...baseAgent,
    provider: provider.name,
    model,
    temperature: workflow.decisionTemperature,
    maxTokens: maxTokens || baseAgent.maxTokens,
    maxTurns: workflow.maxTurns,
    toolIds: workflow.toolIds
  }
}

// ─── ContactMap 加载 ───

export async function loadContactMapWithSessionName(sessionId: string, sessionName?: string): Promise<Map<string, string>> {
  const contactMap = await loadSessionContactMap(sessionId)
  if (sessionName && !contactMap.has(sessionId)) {
    contactMap.set(sessionId, sessionName)
  }
  return contactMap
}

// ─── NativeToolExecutor 构建 ───

export function createNativeToolExecutor(ctx: AgentContext): RunAgentContext['nativeSessionQAToolExecutor'] {
  return async (toolName, args): Promise<ToolResult> => {
    const parsed = parseNativeToolCallArguments(toolName, args)
    const result = (!parsed.action || parsed.error)
      ? createFailedNativeToolResult(ctx, toolName || 'unknown', parsed.args, parsed.error || '工具参数无效。')
      : await executeNativeToolAction(ctx, parsed.action, parsed.args)
    return {
      ok: result.ok,
      content: result.summary,
      data: result,
      error: result.error
    }
  }
}
