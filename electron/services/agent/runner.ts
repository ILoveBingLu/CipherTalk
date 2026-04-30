import type OpenAI from 'openai'
import type {
  AgentChatMessage,
  AgentDefinition,
  AgentEvent,
  AgentLeafEvent,
  AgentToolCall,
  RunAgentContext,
  ToolExecutionContext,
  ToolResult,
  WorkflowState,
  WorkflowToolInjection,
  WorkflowToolResult
} from './types'
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
const WORKFLOW_OBSERVATION_MAX_CHARS = 6000

type PreparedToolExecution = {
  toolCallId: string
  toolId: string
  name: string
  args: Record<string, unknown>
  tool: UnifiedTool
}

async function* executeToolsWithProgress(input: {
  executions: PreparedToolExecution[]
  config: AgentDefinition
  context: RunAgentContext
  userMessage: string
  turn: number
  abortSignal?: AbortSignal
}): AsyncGenerator<AgentEvent, WorkflowToolResult[], void> {
  const limit = Math.max(1, Math.min(MAX_CONCURRENT_TOOL_CALLS, input.executions.length))
  const results: Array<WorkflowToolResult | undefined> = new Array(input.executions.length)
  const queue: AgentEvent[] = []
  let nextIndex = 0
  let active = 0
  let completed = 0
  let wake: (() => void) | undefined

  const notify = () => {
    const resolve = wake
    wake = undefined
    resolve?.()
  }

  const pushEvent = (event: AgentEvent) => {
    queue.push(event)
    notify()
  }

  const startNext = () => {
    while (active < limit && nextIndex < input.executions.length) {
      const index = nextIndex++
      const execution = input.executions[index]
      active += 1

      const toolContext: ToolExecutionContext = {
        agent: input.config,
        provider: input.context.provider,
        model: input.config.model,
        userMessage: input.userMessage,
        selection: input.context.selection,
        signal: input.abortSignal,
        nativeSessionQAToolExecutor: input.context.nativeSessionQAToolExecutor,
        emitEvent: (event: AgentLeafEvent, options?: { label?: string }) => {
          pushEvent({
            type: 'tool_progress',
            parentToolCallId: execution.toolCallId,
            toolId: execution.toolId,
            name: execution.name,
            label: options?.label,
            event,
            turn: input.turn
          })
        }
      }

      void execution.tool.execute(execution.args, toolContext)
        .then((result) => ({ ...execution, result }))
        .catch((error) => ({ ...execution, result: toToolResult(error) }))
        .then((run) => {
          results[index] = {
            toolCallId: run.toolCallId,
            toolId: run.toolId,
            name: run.name,
            args: run.args,
            result: run.result
          }
          pushEvent({
            type: 'tool_result',
            toolCallId: run.toolCallId,
            toolId: run.toolId,
            name: run.name,
            result: run.result,
            turn: input.turn
          })
        })
        .finally(() => {
          active -= 1
          completed += 1
          startNext()
          notify()
        })
    }
  }

  startNext()

  while (completed < input.executions.length || queue.length > 0) {
    while (queue.length > 0) {
      const event = queue.shift()
      if (event) yield event
    }
    if (completed >= input.executions.length) break
    await new Promise<void>((resolve) => {
      wake = resolve
      if (queue.length > 0 || completed >= input.executions.length) notify()
    })
  }

  return results.filter((result): result is WorkflowToolResult => Boolean(result))
}

function buildWorkflowState(input: {
  turn: number
  userMessage: string
  messages: AgentChatMessage[]
  turnToolResults: WorkflowToolResult[]
  allToolResults: WorkflowToolResult[]
  abortSignal?: AbortSignal
}): WorkflowState {
  return {
    turn: input.turn,
    userMessage: input.userMessage,
    messages: input.messages,
    turnToolResults: input.turnToolResults,
    allToolResults: input.allToolResults,
    abortSignal: input.abortSignal
  }
}

function compactWorkflowObservation(value: unknown): string {
  let text = ''
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  return text.length > WORKFLOW_OBSERVATION_MAX_CHARS
    ? `${text.slice(0, WORKFLOW_OBSERVATION_MAX_CHARS)}\n...`
    : text
}

function appendWorkflowObservation(messages: AgentChatMessage[], injection: WorkflowToolInjection, run: WorkflowToolResult): void {
  messages.push({
    role: 'system',
    content: [
      `Workflow injected tool result for ${run.name}.`,
      injection.reason ? `Reason: ${injection.reason}` : '',
      compactWorkflowObservation(run.result)
    ].filter(Boolean).join('\n')
  } as OpenAI.Chat.ChatCompletionMessageParam)
}

function findWorkflowTool(injection: WorkflowToolInjection, tools: UnifiedTool[], config: AgentDefinition): UnifiedTool | undefined {
  const requested = injection.toolId
  const allowedIds = new Set(config.toolIds || [])
  const selectedTool = tools.find((item) => item.id === requested || item.name === requested)
  if (selectedTool) return selectedTool

  const registeredTool = toolRegistry.get(requested) || toolRegistry.getByName(requested)
  if (!registeredTool) return undefined
  if (!allowedIds.has(registeredTool.id) && !allowedIds.has(registeredTool.name)) return undefined
  return registeredTool.isAvailable() ? registeredTool : undefined
}

async function* executeWorkflowInjection(input: {
  injection: WorkflowToolInjection
  tools: UnifiedTool[]
  config: AgentDefinition
  context: RunAgentContext
  userMessage: string
  turn: number
  abortSignal?: AbortSignal
}): AsyncGenerator<AgentEvent, WorkflowToolResult, void> {
  const toolCallId = `workflow-${input.turn}-${Date.now()}`
  const tool = findWorkflowTool(input.injection, input.tools, input.config)
  const toolId = tool?.id || input.injection.toolId || 'unknown'
  const name = tool?.name || input.injection.toolId || 'unknown'
  const args = input.injection.args || {}

  yield { type: 'tool_call', toolCallId, toolId, name, args, turn: input.turn }

  if (!tool) {
    const result = { ok: false, content: `Unknown workflow tool: ${name}`, error: 'unknown_workflow_tool' }
    yield { type: 'tool_result', toolCallId, toolId, name, result, turn: input.turn }
    return { toolCallId, toolId, name, args, result }
  }

  const toolContext: ToolExecutionContext = {
    agent: input.config,
    provider: input.context.provider,
    model: input.config.model,
    userMessage: input.userMessage,
    selection: input.context.selection,
    signal: input.abortSignal,
    nativeSessionQAToolExecutor: input.context.nativeSessionQAToolExecutor
  }
  const result = await tool.execute(args, toolContext).catch(toToolResult)
  yield { type: 'tool_result', toolCallId, toolId, name, result, turn: input.turn }
  return { toolCallId, toolId, name, args, result }
}

async function* runWorkflowFinalPhase(input: {
  state: WorkflowState
  config: AgentDefinition
  context: RunAgentContext
  tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number }
}): AsyncGenerator<AgentEvent, boolean, void> {
  const phase = await input.context.workflow?.finalPhase?.(input.state)
  if (!phase) return false

  const messages: AgentChatMessage[] = [
    { role: 'system', content: phase.systemPrompt },
    { role: 'user', content: phase.userPrompt }
  ]
  input.tokenUsage.promptTokens += estimateTokens(messages.map((message) => {
    const content = (message as any).content
    return typeof content === 'string' ? content : JSON.stringify(content || '')
  }).join('\n'))

  let finalText = ''
  const chunks: string[] = []
  let completed = false
  let streamError: unknown
  let wake: (() => void) | undefined
  const notify = () => {
    const resolve = wake
    wake = undefined
    resolve?.()
  }

  const streamPromise = input.context.provider.streamChat(messages, {
    model: input.config.model,
    temperature: phase.temperature ?? input.config.temperature,
    maxTokens: phase.maxTokens ?? input.config.maxTokens,
    enableThinking: phase.enableThinking
  }, (chunk) => {
    finalText += chunk
    chunks.push(chunk)
    notify()
  }).catch((error) => {
    streamError = error
  }).finally(() => {
    completed = true
    notify()
  })

  while (!completed || chunks.length > 0) {
    while (chunks.length > 0) {
      const content = chunks.shift()
      if (content) yield { type: 'text', content, turn: input.state.turn }
    }
    if (completed) break
    await new Promise<void>((resolve) => {
      wake = resolve
      if (chunks.length > 0 || completed) notify()
    })
  }

  await streamPromise
  if (streamError) throw streamError
  if (finalText) input.tokenUsage.completionTokens += estimateTokens(finalText)
  return true
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
  const allToolResults: WorkflowToolResult[] = []

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
        if (context.workflow) {
          const state = buildWorkflowState({
            turn,
            userMessage,
            messages,
            turnToolResults: [],
            allToolResults,
            abortSignal
          })
          const shouldStop = context.workflow.shouldStop ? await context.workflow.shouldStop(state) : true
          if (!shouldStop) {
            const injection = await context.workflow.injectToolCall?.(state)
            if (injection) {
              const injectedRun = yield* executeWorkflowInjection({
                injection,
                tools,
                config,
                context,
                userMessage,
                turn,
                abortSignal
              })
              allToolResults.push(injectedRun)
              appendWorkflowObservation(messages, injection, injectedRun)
              continue
            }
          }

          const usedFinalPhase = yield* runWorkflowFinalPhase({ state, config, context, tokenUsage })
          if (usedFinalPhase) {
            tokenUsage.totalTokens = tokenUsage.promptTokens + tokenUsage.completionTokens
            yield { type: 'done', reason: 'completed', tokenUsage, turn }
            return
          }
        }
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

      // 先 yield 所有 tool_call 事件，再执行工具。工具内部可通过 emitEvent 透传子流程进度。
      const execItems: PreparedToolExecution[] = []
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
        execItems.push({ toolCallId, toolId, name, args, tool })
      }

      // 并行执行工具（最多 MAX_CONCURRENT_TOOL_CALLS 个并发）
      if (execItems.length > 0) {
        const execResults = yield* executeToolsWithProgress({
          executions: execItems,
          config,
          context,
          userMessage,
          turn,
          abortSignal
        })
        const turnToolResults: WorkflowToolResult[] = []
        for (const { toolCallId, toolId, name, args, result } of execResults) {
          messages.push({ role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(result) } as OpenAI.Chat.ChatCompletionMessageParam)
          turnToolResults.push({ toolCallId, toolId, name, args, result })
          allToolResults.push({ toolCallId, toolId, name, args, result })
        }

        if (context.workflow) {
          const state = buildWorkflowState({
            turn,
            userMessage,
            messages,
            turnToolResults,
            allToolResults,
            abortSignal
          })
          const injection = await context.workflow.injectToolCall?.(state)
          if (injection) {
            const injectedRun = yield* executeWorkflowInjection({
              injection,
              tools,
              config,
              context,
              userMessage,
              turn,
              abortSignal
            })
            allToolResults.push(injectedRun)
            appendWorkflowObservation(messages, injection, injectedRun)
          }
        }
      }
    }

    if (context.workflow) {
      const state = buildWorkflowState({
        turn,
        userMessage,
        messages,
        turnToolResults: [],
        allToolResults,
        abortSignal
      })
      const usedFinalPhase = yield* runWorkflowFinalPhase({ state, config, context, tokenUsage })
      if (usedFinalPhase) {
        tokenUsage.totalTokens = tokenUsage.promptTokens + tokenUsage.completionTokens
        yield { type: 'done', reason: 'max_turns_reached', tokenUsage, turn }
        return
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
