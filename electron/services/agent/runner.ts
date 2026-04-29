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

const MAX_CONCURRENT_TOOL_CALLS = 5

async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  let nextIndex = 0
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index]) }
      } catch (error) {
        results[index] = { status: 'rejected', reason: error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

export async function* runAgent(
  config: AgentDefinition,
  userMessage: string,
  context: RunAgentContext,
  abortSignal?: AbortSignal
): AsyncGenerator<AgentEvent> {
  const registry = context.registry || toolRegistry
  const tools = registry.getByAgent(config.toolIds)
  const systemPrompt = [
    config.systemPrompt,
    context.systemContext ? `\n\n${context.systemContext}` : ''
  ].filter(Boolean).join('')
  const messages: AgentChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(context.historyMessages || []),
    { role: 'user', content: userMessage }
  ]
  const tokenUsage = {
    promptTokens: estimateTokens(messages.map((message) => {
      const content = (message as any).content
      return typeof content === 'string' ? content : JSON.stringify(content || '')
    }).join('\n')),
    completionTokens: 0,
    totalTokens: 0
  }
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

      // 并行执行所有 tool calls
      const toolExecResults = await Promise.allSettled(toolCalls.map(async (call) => {
        const toolCallId = call.id || `tool-${turn}-${Date.now()}`
        const tool = findTool(call, tools)
        if (!tool) {
          const result = { ok: false, content: `Unknown tool: ${call.function?.name || 'unknown'}`, error: 'unknown_tool' }
          return { toolCallId, toolId: call.function?.name || 'unknown', name: call.function?.name || 'unknown', args: {} as Record<string, unknown>, result }
        }

        const args = parseToolArguments(call.function?.arguments)
        return { toolCallId, toolId: tool.id, name: tool.name, args, tool }
      }))

      // 先 yield 所有 tool_call 事件（解析阶段），同时构建惰性执行任务
      const execThunks: (() => Promise<{ toolCallId: string; toolId: string; name: string; result: ToolResult }>)[] = []
      for (const settled of toolExecResults) {
        if (settled.status === 'rejected') {
          const result = toToolResult(settled.reason)
          const toolCallId = `tool-${turn}-${Date.now()}-err`
          yield { type: 'tool_result', toolCallId, toolId: 'unknown', name: 'unknown', result, turn }
          messages.push({ role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(result) } as OpenAI.Chat.ChatCompletionMessageParam)
          continue
        }
        const { toolCallId, toolId, name, args, tool } = settled.value
        if (!tool) {
          // unknown tool — 已在 map 中处理
          const result = settled.value.result as ToolResult
          yield { type: 'tool_result', toolCallId, toolId, name, result, turn }
          messages.push({ role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(result) } as OpenAI.Chat.ChatCompletionMessageParam)
          continue
        }
        yield { type: 'tool_call', toolCallId, toolId, name, args, turn }
        const toolContext: ToolExecutionContext = {
          agent: config,
          provider: context.provider,
          model: config.model,
          userMessage,
          selection: context.selection,
          signal: abortSignal,
          nativeSessionQAToolExecutor: context.nativeSessionQAToolExecutor
        }
        execThunks.push(() =>
          tool.execute(args, toolContext)
            .then((result) => ({ toolCallId, toolId, name, result }))
            .catch((error) => ({ toolCallId, toolId, name, result: toToolResult(error) }))
        )
      }

      // 并行执行工具（最多 MAX_CONCURRENT_TOOL_CALLS 个并发）
      if (execThunks.length > 0) {
        const execResults = await runWithConcurrencyLimit(execThunks, MAX_CONCURRENT_TOOL_CALLS, (thunk) => thunk())
        for (const settled of execResults) {
          const { toolCallId, toolId, name, result } = settled.status === 'fulfilled'
            ? settled.value
            : { toolCallId: `tool-${turn}-settle-err`, toolId: 'unknown', name: 'unknown', result: toToolResult(settled.reason) }
          yield { type: 'tool_result', toolCallId, toolId, name, result, turn }
          messages.push({ role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(result) } as OpenAI.Chat.ChatCompletionMessageParam)
        }
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
