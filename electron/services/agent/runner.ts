import type OpenAI from 'openai'
import type { AgentChatMessage, AgentDefinition, AgentEvent, AgentToolCall, RunAgentContext, ToolExecutionContext, ToolResult } from './types'
import { toolRegistry } from './registry/toolRegistry'
import type { UnifiedTool } from './registry/unifiedTool'

function stringifyAssistantContent(content: OpenAI.Chat.ChatCompletionMessage['content'] | null | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  const parts = content as unknown
  if (Array.isArray(parts)) {
    return parts.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('')
  }
  return ''
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool arguments must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  const otherChars = text.length - chineseChars
  return Math.ceil(chineseChars / 1.5 + otherChars / 4)
}

function toToolResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error || 'Tool execution failed')
  return { ok: false, content: message, error: message }
}

function findTool(call: AgentToolCall, tools: UnifiedTool[]): UnifiedTool | undefined {
  const name = call.function?.name || ''
  return tools.find((tool) => tool.name === name || tool.id === name)
}

export async function* runAgent(
  config: AgentDefinition,
  userMessage: string,
  context: RunAgentContext,
  abortSignal?: AbortSignal
): AsyncGenerator<AgentEvent> {
  const registry = context.registry || toolRegistry
  const tools = registry.getByAgent(config.toolIds)
  const messages: AgentChatMessage[] = [
    { role: 'system', content: config.systemPrompt },
    { role: 'user', content: userMessage }
  ]
  const tokenUsage = { promptTokens: estimateTokens(config.systemPrompt + userMessage), completionTokens: 0, totalTokens: 0 }
  const maxTurns = Math.max(1, config.maxTurns || 15)
  let turn = 0

  try {
    while (turn < maxTurns) {
      if (abortSignal?.aborted) {
        tokenUsage.totalTokens = tokenUsage.promptTokens + tokenUsage.completionTokens
        yield { type: 'done', reason: 'aborted', tokenUsage, turn }
        return
      }

      turn += 1
      const response = await context.provider.chatWithTools(messages, {
        model: config.model,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        enableThinking: false,
        tools: tools.map((tool) => tool.toOpenAITool()),
        toolChoice: 'auto'
      })

      const assistantMessage = response.message
      messages.push(assistantMessage as OpenAI.Chat.ChatCompletionMessageParam)
      const assistantText = stringifyAssistantContent(assistantMessage.content)
      tokenUsage.completionTokens += estimateTokens(assistantText)
      const toolCalls = Array.isArray((assistantMessage as any).tool_calls)
        ? (assistantMessage as any).tool_calls as AgentToolCall[]
        : []

      if (toolCalls.length === 0) {
        if (assistantText) yield { type: 'text', content: assistantText, turn }
        tokenUsage.totalTokens = tokenUsage.promptTokens + tokenUsage.completionTokens
        yield { type: 'done', reason: 'completed', tokenUsage, turn }
        return
      }

      if (assistantText) {
        yield { type: 'thought', content: assistantText, turn }
      }

      for (const call of toolCalls) {
        const tool = findTool(call, tools)
        const toolCallId = call.id || `tool-${turn}-${Date.now()}`
        if (!tool) {
          const result = { ok: false, content: `Unknown tool: ${call.function?.name || 'unknown'}`, error: 'unknown_tool' }
          yield { type: 'tool_result', toolCallId, toolId: call.function?.name || 'unknown', name: call.function?.name || 'unknown', result, turn }
          messages.push({ role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(result) } as OpenAI.Chat.ChatCompletionMessageParam)
          continue
        }

        let args: Record<string, unknown>
        try {
          args = parseToolArguments(call.function?.arguments)
        } catch (error) {
          const result = toToolResult(error)
          yield { type: 'tool_result', toolCallId, toolId: tool.id, name: tool.name, result, turn }
          messages.push({ role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(result) } as OpenAI.Chat.ChatCompletionMessageParam)
          continue
        }

        yield { type: 'tool_call', toolCallId, toolId: tool.id, name: tool.name, args, turn }
        let result: ToolResult
        try {
          const toolContext: ToolExecutionContext = {
            agent: config,
            provider: context.provider,
            model: config.model,
            userMessage,
            selection: context.selection,
            signal: abortSignal,
            nativeSessionQAToolExecutor: context.nativeSessionQAToolExecutor
          }
          result = await tool.execute(args, toolContext)
        } catch (error) {
          result = toToolResult(error)
        }
        yield { type: 'tool_result', toolCallId, toolId: tool.id, name: tool.name, result, turn }
        messages.push({ role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(result) } as OpenAI.Chat.ChatCompletionMessageParam)
      }
    }

    tokenUsage.totalTokens = tokenUsage.promptTokens + tokenUsage.completionTokens
    yield { type: 'done', reason: 'max_turns_reached', tokenUsage, turn }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'Agent execution failed')
    yield { type: 'error', message, turn }
    tokenUsage.totalTokens = tokenUsage.promptTokens + tokenUsage.completionTokens
    yield { type: 'done', reason: 'error', tokenUsage, turn }
  }
}
