import { getNativeSessionQATools } from '../../../ai-agent/qa/nativeTools'
import { runAgent } from '../../runner'
import { createSessionQAWorkflow } from '../../sessionQAWorkflow'
import { createSummaryWorkflow, type SummaryWorkflowOptions } from '../../summaryWorkflow'
import { getAgentSessionQATargets, type AgentSessionQATarget } from '../../sessionQaToolContext'
import type { AgentEvent, AgentLeafEvent, AgentTokenUsage, ToolExecutionContext, ToolResult } from '../../types'
import { wrapNativeToolDefinition, type UnifiedTool } from '../unifiedTool'
import { chatService } from '../../../chatService'
import { ConfigService } from '../../../config'

const configService = new ConfigService()

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required
  }
}

function getCurrentTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function readStringArg(args: Record<string, unknown>, key: string): string {
  return String(args[key] || '').trim()
}

function readStringArrayArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key]
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item || '').trim()).filter(Boolean)
}

function stripCommandTokens(message: string): string {
  return String(message || '')
    .replace(/(?:#|@|\$|!|\/|t:)\[[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatSessionQATarget(target: AgentSessionQATarget): string {
  return target.name || target.id
}

function normalizeTargetRef(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/^[#@/!$]*\[/, '')
    .replace(/\]$/, '')
    .replace(/[“”"]/g, '')
    .toLowerCase()
}

function targetMatchesRef(target: AgentSessionQATarget, ref: string): boolean {
  const normalizedRef = normalizeTargetRef(ref)
  if (!normalizedRef) return false
  const candidates = [
    target.id,
    target.name,
    formatSessionQATarget(target),
    target.name ? `#${target.name}` : '',
    target.name ? `#[${target.name}]` : ''
  ].map(normalizeTargetRef).filter(Boolean)
  return candidates.some((candidate) => candidate === normalizedRef || candidate.includes(normalizedRef) || normalizedRef.includes(candidate))
}

function resolveRequestedTargets(targets: AgentSessionQATarget[], refs: string[]): AgentSessionQATarget[] {
  if (refs.length === 0) return targets
  const matched = targets.filter((target) => refs.some((ref) => targetMatchesRef(target, ref)))
  if (matched.length > 0) return matched
  return targets.length === 1 ? targets : []
}

function limitNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

function addTokenUsage(total: AgentTokenUsage, usage?: AgentTokenUsage): void {
  if (!usage) return
  total.promptTokens += usage.promptTokens || 0
  total.completionTokens += usage.completionTokens || 0
  total.totalTokens += usage.totalTokens || 0
}

function isLeafAgentEvent(event: AgentEvent): event is AgentLeafEvent {
  return event.type !== 'tool_progress'
}

function emitSubagentEvent(context: ToolExecutionContext, label: string, event: AgentLeafEvent): void {
  context.emitEvent?.(event, { label })
}

async function runSessionQAForTarget(input: {
  target: AgentSessionQATarget
  question: string
  context: ToolExecutionContext
}): Promise<{
  target: AgentSessionQATarget
  answerText: string
  evidenceCount: number
  toolCallCount: number
  tokenUsage: AgentTokenUsage
  errorText?: string
}> {
  const provider = input.context.provider
  if (!provider) throw new Error('当前 Agent 运行缺少可用模型 Provider，无法启动 SessionQA subagent。')
  const model = String(input.context.model || input.context.agent.model || '').trim()
  if (!model) throw new Error('当前 Agent 运行缺少模型配置，无法启动 SessionQA subagent。')

  const tokenUsage: AgentTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  let answerText = ''
  let errorText = ''
  let evidenceCount = 0
  let toolCallCount = 0
  const label = formatSessionQATarget(input.target)

  try {
    emitSubagentEvent(input.context, label, {
      type: 'thought',
      content: `SessionQA subagent 开始处理：${label}`,
      turn: 0
    })

    const sessionQA = await createSessionQAWorkflow({
      sessionId: input.target.id,
      sessionName: input.target.name,
      question: input.question,
      provider,
      model,
      agentId: input.context.agent.id,
      enableThinking: false,
      signal: input.context.signal,
      onChunk: () => undefined
    })

    for await (const event of runAgent(sessionQA.agentDef, sessionQA.userMessage, sessionQA.context, input.context.signal)) {
      if (isLeafAgentEvent(event)) {
        emitSubagentEvent(input.context, label, event)
      }
      if (event.type === 'text') {
        answerText += event.content || ''
      } else if (event.type === 'error') {
        errorText = event.message
      } else if (event.type === 'done') {
        addTokenUsage(tokenUsage, event.tokenUsage)
      }
    }
    evidenceCount = sessionQA.agentContext.evidenceCandidates.length
    toolCallCount = sessionQA.agentContext.toolCalls.length
  } catch (error) {
    errorText = error instanceof Error ? error.message : String(error)
    emitSubagentEvent(input.context, label, {
      type: 'error',
      message: errorText,
      turn: 0
    })
  }

  return {
    target: input.target,
    answerText,
    evidenceCount,
    toolCallCount,
    tokenUsage,
    errorText
  }
}

async function runSessionSummaryForTarget(input: {
  target: AgentSessionQATarget
  timeRangeDays: number
  context: ToolExecutionContext
}): Promise<{
  target: AgentSessionQATarget
  summaryText: string
  tokenUsage: AgentTokenUsage
  errorText?: string
}> {
  const provider = input.context.provider
  if (!provider) throw new Error('当前 Agent 运行缺少可用模型 Provider，无法启动 Summary subagent。')
  const model = String(input.context.model || input.context.agent.model || '').trim()
  if (!model) throw new Error('当前 Agent 运行缺少模型配置，无法启动 Summary subagent。')

  const tokenUsage: AgentTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  let summaryText = ''
  let errorText = ''
  const label = formatSessionQATarget(input.target)

  try {
    emitSubagentEvent(input.context, label, {
      type: 'thought',
      content: `Summary subagent 开始处理：${label}`,
      turn: 0
    })

    // 加载消息
    const endTime = Math.floor(Date.now() / 1000)
    const startTime = input.timeRangeDays > 0 ? endTime - (input.timeRangeDays * 24 * 60 * 60) : undefined
    const messageLimit = configService?.get('aiMessageLimit') || 3000
    const messagesResult = await chatService.getMessagesByTimeRangeForSummary(input.target.id, {
      startTime,
      endTime,
      limit: messageLimit
    })
    if (!messagesResult.success || !messagesResult.messages?.length) {
      const message = '获取消息失败或无消息'
      emitSubagentEvent(input.context, label, {
        type: 'error',
        message,
        turn: 0
      })
      return { target: input.target, summaryText: '', tokenUsage, errorText: message }
    }

    // 加载联系人
    const contacts = new Map()
    const senderSet = new Set<string>()
    senderSet.add(input.target.id)
    messagesResult.messages.forEach((msg: any) => {
      if (msg.senderUsername) senderSet.add(msg.senderUsername)
    })
    const myWxid = configService?.get('myWxid')
    if (myWxid) senderSet.add(myWxid)
    for (const username of Array.from(senderSet)) {
      const contact = await chatService.getContact(username)
      if (contact) contacts.set(username, contact)
    }

    const workflowOptions: SummaryWorkflowOptions = {
      sessionId: input.target.id,
      sessionName: input.target.name,
      timeRangeDays: input.timeRangeDays,
      timeRangeStart: startTime ?? messagesResult.messages[0].createTime,
      timeRangeEnd: endTime,
      provider,
      model,
      enableThinking: false
    }

    const workflow = await createSummaryWorkflow(workflowOptions, messagesResult.messages, contacts)

    for await (const event of runAgent(workflow.agentDef, workflow.userMessage, workflow.context, input.context.signal)) {
      if (isLeafAgentEvent(event)) {
        emitSubagentEvent(input.context, label, event)
      }
      if (event.type === 'text') {
        summaryText += event.content || ''
      } else if (event.type === 'error') {
        errorText = event.message
      } else if (event.type === 'done') {
        addTokenUsage(tokenUsage, event.tokenUsage)
      }
    }
  } catch (error) {
    errorText = error instanceof Error ? error.message : String(error)
    emitSubagentEvent(input.context, label, {
      type: 'error',
      message: errorText,
      turn: 0
    })
  }

  return { target: input.target, summaryText, tokenUsage, errorText }
}

async function executeSessionSummaryWorkflowTool(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
  const timeRangeDays = limitNumber(args.timeRangeDays, 7, 1, 365)
  const allTargets = getAgentSessionQATargets(context.selection)
  const targetRefs = readStringArrayArg(args, 'targetIds')
  const filteredTargets = resolveRequestedTargets(allTargets, targetRefs)
  const maxTargets = limitNumber(args.maxTargets, 5, 1, 8)
  const targets = filteredTargets.slice(0, maxTargets)

  if (targets.length === 0) {
    return {
      ok: false,
      content: '需要先在输入框用 # 选择一个会话、群聊或联系人，才能运行会话摘要工作流。',
      error: 'missing_summary_targets'
    }
  }

  const results: Array<{
    target: AgentSessionQATarget
    summaryText: string
    tokenUsage: AgentTokenUsage
    errorText?: string
  }> = []
  const aggregateUsage: AgentTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

  for (const target of targets) {
    if (context.signal?.aborted) break
    const result = await runSessionSummaryForTarget({ target, timeRangeDays, context })
    addTokenUsage(aggregateUsage, result.tokenUsage)
    results.push(result)
  }

  const blocks = results.map((result, index) => {
    const targetTitle = `${index + 1}. ${formatSessionQATarget(result.target)}`
    const status = result.errorText ? `状态：失败，${result.errorText}` : '状态：完成'
    const answer = result.summaryText.trim() || '没有生成摘要内容。'
    return [`## ${targetTitle}`, status, answer].join('\n')
  })

  const content = [
    `Summary subagent 已处理 ${results.length}/${filteredTargets.length} 个目标（${timeRangeDays > 0 ? `最近${timeRangeDays}天` : '全部消息'}）。`,
    filteredTargets.length > targets.length ? `已按 maxTargets=${maxTargets} 截断。` : '',
    '',
    ...blocks
  ].filter((line) => line !== '').join('\n\n')

  return {
    ok: results.length > 0 && results.some((result) => !result.errorText && result.summaryText.trim()),
    content,
    data: {
      timeRangeDays,
      requestedTargetCount: filteredTargets.length,
      processedTargetCount: results.length,
      truncated: filteredTargets.length > targets.length,
      requestedTargetIds: targetRefs,
      tokenUsage: aggregateUsage,
      results: results.map((result) => ({
        target: result.target,
        errorText: result.errorText,
        summaryPreview: result.summaryText.slice(0, 1000)
      }))
    },
    error: results.some((result) => !result.errorText && result.summaryText.trim()) ? undefined : 'summary_workflow_no_output'
  }
}

async function executeSessionQAWorkflowTool(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
  const question = readStringArg(args, 'question') || stripCommandTokens(context.userMessage)
  if (!question) {
    return {
      ok: false,
      content: '需要提供要查询的问题。',
      error: 'missing_question'
    }
  }

  const allTargets = getAgentSessionQATargets(context.selection)
  const targetRefs = readStringArrayArg(args, 'targetIds')
  const filteredTargets = resolveRequestedTargets(allTargets, targetRefs)
  const maxTargets = limitNumber(args.maxTargets, 5, 1, 8)
  const targets = filteredTargets.slice(0, maxTargets)

  if (targets.length === 0) {
    return {
      ok: false,
      content: '需要先在输入框用 # 选择一个会话、群聊或联系人，才能运行会话问答工作流。',
      error: 'missing_session_qa_targets',
      data: {
        selectedTargetCount: allTargets.length,
        selectedTargets: allTargets.map((target) => ({ id: target.id, name: target.name, source: target.source })),
        requestedTargetIds: targetRefs
      }
    }
  }

  const results: Array<{
    target: AgentSessionQATarget
    answerText: string
    evidenceCount: number
    toolCallCount: number
    tokenUsage: AgentTokenUsage
    errorText?: string
  }> = []
  const aggregateUsage: AgentTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  for (const target of targets) {
    if (context.signal?.aborted) break
    const result = await runSessionQAForTarget({ target, question, context })
    addTokenUsage(aggregateUsage, result.tokenUsage)
    results.push(result)
  }

  const blocks = results.map((result, index) => {
    const targetTitle = `${index + 1}. ${formatSessionQATarget(result.target)}`
    const status = result.errorText ? `状态：失败，${result.errorText}` : '状态：完成'
    const stats = `证据数量：${result.evidenceCount}；工具调用：${result.toolCallCount}`
    const answer = result.answerText.trim() || '没有得到可用回答。'
    return [`## ${targetTitle}`, status, stats, answer].join('\n')
  })

  const content = [
    `SessionQA subagent 已处理 ${results.length}/${filteredTargets.length} 个目标。`,
    filteredTargets.length > targets.length ? `已按 maxTargets=${maxTargets} 截断。` : '',
    '',
    ...blocks
  ].filter((line) => line !== '').join('\n\n')

  return {
    ok: results.length > 0 && results.some((result) => !result.errorText && result.answerText.trim()),
    content,
    data: {
      question,
      requestedTargetCount: filteredTargets.length,
      processedTargetCount: results.length,
      truncated: filteredTargets.length > targets.length,
      requestedTargetIds: targetRefs,
      tokenUsage: aggregateUsage,
      results: results.map((result) => ({
        target: result.target,
        evidenceCount: result.evidenceCount,
        toolCallCount: result.toolCallCount,
        errorText: result.errorText,
        answerPreview: result.answerText.slice(0, 1000)
      }))
    },
    error: results.some((result) => !result.errorText && result.answerText.trim()) ? undefined : 'session_qa_workflow_no_answer'
  }
}

export function createNativeUtilityTools(): UnifiedTool[] {
  return [
    wrapNativeToolDefinition({
      type: 'function',
      function: {
        name: 'get_current_time',
        description: '获取当前日期和时间。适合用户询问今天、现在、当前时间、日期、星期、时区，或需要基于当前时间理解相对日期时调用。',
        parameters: objectSchema({
          timeZone: {
            type: 'string',
            description: '可选 IANA 时区，例如 Asia/Shanghai、America/New_York。为空时使用系统当前时区。'
          },
          locale: {
            type: 'string',
            description: '可选语言区域，例如 zh-CN、en-US。为空时使用 zh-CN。'
          }
        })
      }
    }, async (args) => {
      const requestedTimeZone = readStringArg(args, 'timeZone')
      const timeZone = requestedTimeZone || getCurrentTimeZone()
      const locale = readStringArg(args, 'locale') || 'zh-CN'
      const now = new Date()
      let formatted = ''
      try {
        formatted = new Intl.DateTimeFormat(locale, {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          weekday: 'long',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
          timeZoneName: 'short'
        }).format(now)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          ok: false,
          content: `无法获取指定时区的当前时间：${message}`,
          error: 'invalid_time_zone_or_locale'
        }
      }

      return {
        ok: true,
        content: `当前时间：${formatted}\nISO：${now.toISOString()}\n时区：${timeZone}`,
        data: {
          iso: now.toISOString(),
          unixMs: now.getTime(),
          unixSeconds: Math.floor(now.getTime() / 1000),
          timeZone,
          locale,
          formatted
        }
      }
    }, { sourceLabel: 'CipherTalk' }),
    wrapNativeToolDefinition({
      type: 'function',
      function: {
        name: 'run_session_qa_workflow',
        description: [
          '把选中的聊天记录问答委托给内置 SessionQA subagent。',
          '当问题需要基于当前 # 选择的会话、群聊、联系人读取聊天记录证据时调用。',
          '支持多个 # 目标；工具会按目标独立检索并返回分组结果，主 Agent 需要再综合成最终回答。'
        ].join(''),
        parameters: objectSchema({
          question: {
            type: 'string',
            description: '要交给 SessionQA subagent 回答的具体问题。'
          },
          targetIds: {
            type: 'array',
            description: '可选。只处理当前 selection 中这些目标。可以传目标 id、会话名、联系人名或 #[名称]；为空时处理所有 # 选择的目标。',
            items: { type: 'string' }
          },
          maxTargets: {
            type: 'number',
            description: '可选。最多处理多少个目标，默认 5，最大 8。'
          }
        }, ['question'])
      }
    }, executeSessionQAWorkflowTool, { sourceLabel: 'Workflow' }),
    wrapNativeToolDefinition({
      type: 'function',
      function: {
        name: 'run_session_summary_workflow',
        description: [
          '对选中的聊天记录生成摘要，委托给内置 Summary subagent。',
          '当用户要求总结、概括、归纳聊天记录内容时调用。',
          '支持多个 # 目标；工具会按目标独立生成摘要并返回分组结果。'
        ].join(''),
        parameters: objectSchema({
          timeRangeDays: {
            type: 'number',
            description: '时间范围天数，默认 7。0 表示全部消息。'
          },
          targetIds: {
            type: 'array',
            description: '可选。只处理当前 selection 中这些目标。可以传目标 id、会话名、联系人名或 #[名称]；为空时处理所有 # 选择的目标。',
            items: { type: 'string' }
          },
          maxTargets: {
            type: 'number',
            description: '可选。最多处理多少个目标，默认 5，最大 8。'
          }
        })
      }
    }, executeSessionSummaryWorkflowTool, { sourceLabel: 'Workflow' })
  ]
}

const SESSION_QA_NATIVE_TOOL_NAMES = new Set([
  'search_messages',
  'read_context',
  'read_latest',
  'read_by_time_range',
  'get_session_statistics',
  'get_keyword_statistics',
  'aggregate_messages',
  'resolve_participant',
  'read_summary_facts',
  'answer'
])

export function createNativeSessionQATools(): UnifiedTool[] {
  return getNativeSessionQATools()
    .filter((tool) => SESSION_QA_NATIVE_TOOL_NAMES.has(tool.function.name))
    .map((definition) => wrapNativeToolDefinition(definition, async (args, context) => {
      if (!context.nativeSessionQAToolExecutor) {
        return {
          ok: false,
          content: 'SessionQA native tool executor is not available for this agent run.',
          error: 'native_session_qa_executor_unavailable'
        }
      }
      return context.nativeSessionQAToolExecutor(definition.function.name, args)
    }, { sourceLabel: 'SessionQA' }))
}
