import type { AIProvider } from '../ai/providers/base'
import { createSessionQANativeToolExecutor } from '../ai-agent/qa/orchestrator'
import type { ToolResult } from './types'

export type AgentSessionQATarget = {
  id: string
  name?: string
  source: 'session' | 'contact'
}

export const SESSION_QA_NATIVE_TOOL_IDS = new Set([
  'native:read_summary_facts',
  'native:search_messages',
  'native:read_context',
  'native:read_latest',
  'native:read_by_time_range',
  'native:get_session_statistics',
  'native:get_keyword_statistics',
  'native:aggregate_messages',
  'native:resolve_participant',
  'native:answer'
])

export function getAgentSessionQATarget(selection?: any): AgentSessionQATarget | null {
  return getAgentSessionQATargets(selection)[0] || null
}

export function getAgentSessionQATargets(selection?: any): AgentSessionQATarget[] {
  const selectedSessions = Array.isArray(selection?.selectedSessions) ? selection.selectedSessions : []
  const selectedContacts = Array.isArray(selection?.selectedContacts) ? selection.selectedContacts : []
  const targets: AgentSessionQATarget[] = []
  const seen = new Set<string>()

  const pushTarget = (item: any, source: AgentSessionQATarget['source']) => {
    if (!item?.id) return
    const id = String(item.id).trim()
    if (!id || seen.has(`${source}:${id}`)) return
    seen.add(`${source}:${id}`)
    targets.push({
      id,
      name: item.name ? String(item.name) : undefined,
      source
    })
  }

  selectedSessions.forEach((item: any) => pushTarget(item, 'session'))
  selectedContacts.forEach((item: any) => pushTarget(item, 'contact'))
  return targets
}

export function hasAgentSessionQASelection(selection?: any): boolean {
  const selectedSessions = Array.isArray(selection?.selectedSessions) ? selection.selectedSessions : []
  const selectedContacts = Array.isArray(selection?.selectedContacts) ? selection.selectedContacts : []
  return selectedSessions.length > 0 || selectedContacts.length > 0
}

export function withoutSessionQANativeTools(toolIds: string[] = []): string[] {
  return toolIds.filter((toolId) => !SESSION_QA_NATIVE_TOOL_IDS.has(toolId))
}

export function resolveSessionQAToolIds(toolIds: string[] = [], target?: AgentSessionQATarget | null): string[] {
  return target ? toolIds : withoutSessionQANativeTools(toolIds)
}

export async function createAgentSessionQAToolExecutor(options: {
  target: AgentSessionQATarget
  question: string
  provider: AIProvider
  model: string
  signal?: AbortSignal
}): Promise<(toolName: string, args: Record<string, unknown>) => Promise<ToolResult>> {
  const executor = await createSessionQANativeToolExecutor({
    sessionId: options.target.id,
    sessionName: options.target.name,
    question: options.question,
    provider: options.provider,
    model: options.model,
    enableThinking: false,
    onChunk: () => undefined,
    onProgress: () => undefined,
    signal: options.signal
  })

  return async (toolName, args) => {
    const result = await executor(toolName, args)
    return {
      ok: result.ok,
      content: result.summary,
      data: result,
      error: result.error
    }
  }
}
