/**
 * Agent 主编排循环
 *
 * 职责：驱动 Agent 决策循环，协调工具调用，生成最终回答。
 * 内置超时保护和取消机制。
 */
import type OpenAI from 'openai'
import type {
  SessionQAAgentOptions,
  SessionQAAgentResult,
  ToolLoopAction,
  ContextWindow,
  SessionQAToolCall,
  IntentRoute,
  NativeToolExecutionResult,
  ToolObservation
} from './types'
import {
  MAX_CONTEXT_MESSAGES,
  MAX_CONTEXT_WINDOWS,
  MAX_SUMMARY_CHARS,
  MAX_STRUCTURED_CHARS,
  MAX_TOOL_CALLS,
  MAX_SEARCH_RETRIES,
  SEARCH_CONTEXT_BEFORE,
  SEARCH_CONTEXT_AFTER,
  DEFAULT_AGENT_DECISION_MAX_TOKENS,
  DEFAULT_AGENT_ANSWER_MAX_TOKENS,
  MAX_AGENT_DECISION_MAX_TOKENS,
  MAX_AGENT_ANSWER_MAX_TOKENS
} from './types'
import type { StructuredAnalysis } from '../types/analysis'
import { compactText, stripThinkBlocks, filterThinkChunk, clampTokenBudget } from './utils/text'
import { clampToolLimit } from './utils/text'
import { inferTimeRangeFromQuestion, formatTimeRangeLabel } from './utils/time'
import { normalizeSearchQuery, isGenericSearchQuery, generateAlternativeQueries } from './utils/search'
import { dedupeMessagesByCursor, dedupeEvidenceRefs, getMessageCursorKey, formatMessageLine, toEvidenceRef } from './utils/message'
import { loadSessionContactMap } from './utils/contacts'
import { routeFromHeuristics, enforceConcreteEvidenceRoute, getRouteLabel } from './intent/router'
import { refineRouteWithAIIntent, type AIIntentRouterResult } from './intent/aiRouter'
import { emitProgress } from './progress'
import { AgentContext, AgentAbortError } from './agentContext'
import { hasConclusiveSearchFailure, findKnownHitForAction, summarizeSearchObservation, getSearchDiagnostics, interpretSearchFailure } from './evidence'
import { searchSessionMessages, loadLatestContext, loadContextAroundMessage } from './tools/search'
import { loadSessionStatistics, loadKeywordStatistics, loadMessagesByTimeRange, loadMessagesByTimeRangeAll, formatSessionStatisticsText, formatKeywordStatisticsText } from './tools/statistics'
import { resolveParticipantName, findResolvedSenderUsername } from './tools/participant'
import { aggregateMessages } from './tools/aggregate'
import { buildAutonomousAgentPrompt } from './prompts/decision'
import { buildAnswerPrompt } from './prompts/answer'
import { getNativeSessionQATools, parseNativeToolCallArguments, toSessionQAToolName } from './nativeTools'
import { NATIVE_TOOL_CALLING_UNSUPPORTED_MESSAGE, isNativeToolCallingUnsupportedError, type ChatWithToolsOptions } from '../../ai/providers/base'
import type { SummaryEvidenceRef } from '../types/analysis'
import { getAgentNodeName } from './nodeNames'

// ─── 辅助函数 ────────────────────────────────────────────────

const AUTO_FINAL_CONTEXT_MESSAGE_LIMIT = MAX_CONTEXT_MESSAGES
const AUTO_FINAL_TOOL_CALLS_WITH_EVIDENCE = 8

function buildStructuredContext(analysis?: StructuredAnalysis): string {
  if (!analysis) return ''
  return compactText(JSON.stringify(analysis), MAX_STRUCTURED_CHARS)
}

function buildHistoryContext(history: SessionQAAgentOptions['history'] = []): string {
  return (history || [])
    .map((item) => `${item.role === 'user' ? '用户' : 'AI'}：${item.content}`)
    .join('\n')
}

function buildSummaryFactsText(summaryText?: string, structuredContext?: string): string {
  const parts = [
    stripThinkBlocks(summaryText || '').trim(),
    structuredContext ? `结构化摘要：${structuredContext}` : ''
  ].filter(Boolean)
  return compactText(parts.join('\n\n'), MAX_SUMMARY_CHARS + MAX_STRUCTURED_CHARS)
}

function collectStructuredEvidenceRefs(analysis?: StructuredAnalysis): SummaryEvidenceRef[] {
  if (!analysis) return []
  const refs: SummaryEvidenceRef[] = []
  for (const group of [analysis.decisions, analysis.todos, analysis.risks, analysis.events]) {
    for (const item of group) {
      refs.push(...item.evidenceRefs)
    }
  }
  return refs
}

function isExactLookupQuestion(question: string): boolean {
  return /邮箱|邮件|email|e-mail|电话|手机|手机号|号码|账号|帐号|密码|地址|网址|链接|url|http/i.test(question)
}

function buildToolCall(input: Omit<SessionQAToolCall, 'displayName' | 'nodeName'>): SessionQAToolCall {
  const nodeName = getAgentNodeName({ toolName: input.toolName })
  return { ...input, displayName: nodeName, nodeName }
}

function getContextMessageCount(ctx: AgentContext): number {
  return ctx.contextWindows.reduce((sum, window) => sum + window.messages.length, 0)
}

function appendContextWindow(ctx: AgentContext, window: ContextWindow): boolean {
  if (ctx.contextWindows.length >= MAX_CONTEXT_WINDOWS) return false
  ctx.contextWindows.push(window)
  return true
}

function appendContextWindows(ctx: AgentContext, windows: ContextWindow[]): number {
  let appended = 0
  for (const window of windows) {
    if (!appendContextWindow(ctx, window)) break
    appended += 1
  }
  return appended
}

function hasStatsEvidence(ctx: AgentContext): boolean {
  return Boolean(ctx.aggregateText)
    || ctx.toolCalls.some((call) =>
      (call.toolName === 'get_session_statistics'
        || call.toolName === 'get_keyword_statistics'
        || call.toolName === 'aggregate_messages')
      && call.status !== 'failed'
    )
}

function getAutoFinalizeReason(ctx: AgentContext, action: ToolLoopAction): string | null {
  if (action.action === 'answer') return '模型已请求进入最终回答。'
  if (hasConclusiveSearchFailure(ctx.searchPayloads)) return '检索已明确没有相关内容，继续找数据只会扩大上下文。'

  if (ctx.evidenceQuality === 'sufficient') {
    if (ctx.route.intent === 'stats_or_count' && !hasStatsEvidence(ctx)) return null
    return '当前证据质量已足够回答用户问题。'
  }

  if (ctx.hasEvidence && getContextMessageCount(ctx) >= AUTO_FINAL_CONTEXT_MESSAGE_LIMIT) {
    return `已读取 ${getContextMessageCount(ctx)} 条上下文消息，进入回答以避免上下文继续膨胀。`
  }

  if (ctx.hasEvidence && ctx.toolCallsUsed >= AUTO_FINAL_TOOL_CALLS_WITH_EVIDENCE) {
    return `已有证据且工具调用已达 ${ctx.toolCallsUsed} 次，停止继续检索。`
  }

  return null
}

// ─── 工具执行器（每个分支独立函数）─────────────────────────────

async function executeSummaryFacts(ctx: AgentContext, action: ToolLoopAction & { action: 'read_summary_facts' }) {
  ctx.toolCallsUsed += 1
  const progressId = `tool-loop-${ctx.toolCallsUsed}-summary`
  const structuredContext = buildStructuredContext(ctx.options.structuredAnalysis)

  emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'running', title: '读取摘要事实', detail: action.reason || '读取当前摘要和结构化摘要', toolName: 'read_summary_facts' })

  ctx.summaryFactsText = buildSummaryFactsText(ctx.options.summaryText, structuredContext)
  ctx.summaryFactsRead = Boolean(ctx.summaryFactsText)
  if (ctx.summaryFactsRead) {
    ctx.evidenceCandidates.push(...collectStructuredEvidenceRefs(ctx.options.structuredAnalysis))
  }

  ctx.toolCalls.push(buildToolCall({ toolName: 'read_summary_facts', args: { hasSummaryText: Boolean(stripThinkBlocks(ctx.options.summaryText || '').trim()), hasStructuredAnalysis: Boolean(structuredContext) }, summary: ctx.summaryFactsRead ? '已读取当前摘要和结构化摘要。' : '当前没有可用摘要事实。' }))
  emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'completed', title: '读取摘要事实', detail: ctx.summaryFactsRead ? '当前摘要/结构化摘要可作为回答依据' : '当前摘要为空或不足', toolName: 'read_summary_facts', count: ctx.summaryFactsRead ? 1 : 0 })
  ctx.observations.push({ title: '读取摘要事实', detail: ctx.summaryFactsRead ? ctx.summaryFactsText : '当前没有可用摘要事实。' })
}

async function executeResolveParticipant(ctx: AgentContext, action: ToolLoopAction & { action: 'resolve_participant' }) {
  ctx.toolCallsUsed += 1
  const name = action.name || ctx.route.participantHints[0] || ''
  const progressId = `tool-loop-${ctx.toolCallsUsed}-participant`

  emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'running', title: '解析参与者', detail: name ? `正在解析：${name}` : '正在从问题中解析参与者', toolName: 'resolve_participant', query: name })

  const resolution = await resolveParticipantName({ sessionId: ctx.sessionId, name, contextWindows: ctx.contextWindows, knownHits: ctx.knownHits })
  ctx.resolvedParticipants.push(resolution)
  ctx.toolCalls.push(buildToolCall({ toolName: 'resolve_participant', args: { sessionId: ctx.sessionId, name }, summary: resolution.senderUsername ? `解析为 ${resolution.displayName || resolution.senderUsername}` : '未解析到明确发送者，后续读取会不加发送者过滤。' }))
  emitProgress(ctx.options, { id: progressId, stage: 'tool', status: resolution.senderUsername ? 'completed' : 'failed', title: '解析参与者', detail: resolution.senderUsername ? `${resolution.query} => ${resolution.displayName || resolution.senderUsername}` : `${resolution.query} 未解析到明确发送者`, toolName: 'resolve_participant', query: name, count: resolution.senderUsername ? 1 : 0 })
  ctx.observations.push({ title: '解析参与者', detail: resolution.senderUsername ? `${resolution.query} => ${resolution.displayName || resolution.senderUsername} (${resolution.senderUsername})，置信度 ${resolution.confidence}。` : `${resolution.query} 未解析到明确 senderUsername。` })
}

async function executeReadByTimeRange(ctx: AgentContext, action: ToolLoopAction & { action: 'read_by_time_range' }) {
  if (ctx.contextWindows.length >= MAX_CONTEXT_WINDOWS && ctx.hasEvidence) {
    ctx.toolCallsUsed += 1
    const progressId = `tool-loop-${ctx.toolCallsUsed}-time`
    emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'completed', title: '按时间读取消息', detail: `上下文窗口已达 ${MAX_CONTEXT_WINDOWS} 个，跳过继续读取`, toolName: 'read_by_time_range', count: 0 })
    ctx.observations.push({ title: '跳过按时间读取', detail: `已有证据且上下文窗口已达 ${MAX_CONTEXT_WINDOWS} 个，请进入回答。` })
    return
  }

  ctx.toolCallsUsed += 1
  const inferredRange = ctx.route.timeRange || inferTimeRangeFromQuestion(ctx.question)
  const range = { startTime: action.startTime || inferredRange?.startTime, endTime: action.endTime || inferredRange?.endTime, label: action.label || inferredRange?.label }
  const senderUsername = findResolvedSenderUsername(action, ctx.resolvedParticipants)
  const hasRange = Boolean(range.startTime || range.endTime)
  const limit = clampToolLimit(action.limit, hasRange ? 80 : MAX_CONTEXT_MESSAGES, 100)
  const progressId = `tool-loop-${ctx.toolCallsUsed}-time`
  const label = hasRange ? formatTimeRangeLabel(range) : '最近一批消息'

  emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'running', title: hasRange ? '按时间读取消息' : '读取最近消息', detail: label, toolName: 'read_by_time_range', query: action.keyword })

  try {
    const payload = await loadMessagesByTimeRange(ctx.sessionId, { startTime: range.startTime, endTime: range.endTime, keyword: action.keyword, senderUsername, limit, order: hasRange ? 'asc' : 'desc' })
    if (payload.toolCall) ctx.toolCalls.push(payload.toolCall)
    const messages = payload.payload?.items || []
    if (appendContextWindow(ctx, { source: 'time_range', label, messages })) {
      ctx.addContextEvidence(messages)
    } else {
      ctx.observations.push({ title: '跳过追加上下文', detail: `上下文窗口已达 ${MAX_CONTEXT_WINDOWS} 个，未继续追加按时间读取结果。` })
    }
    emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'completed', title: hasRange ? '按时间读取消息' : '读取最近消息', detail: `读取到 ${messages.length} 条消息`, toolName: 'read_by_time_range', count: messages.length })
    ctx.observations.push({ title: hasRange ? '按时间读取消息' : '读取最近消息', detail: `${label}，读取到 ${messages.length} 条。\n${messages.slice(0, 12).map(formatMessageLine).join('\n') || '无消息。'}` })
  } catch (error) {
    emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'failed', title: '按时间读取失败', detail: compactText(String(error), 120), toolName: 'read_by_time_range' })
    ctx.observations.push({ title: '按时间读取失败', detail: `失败原因：${compactText(String(error), 160)}。` })
  }
}

async function executeSessionStatistics(ctx: AgentContext, action: ToolLoopAction & { action: 'get_session_statistics' }) {
  ctx.toolCallsUsed += 1
  const progressId = `tool-loop-${ctx.toolCallsUsed}-session-stats`
  const inferredRange = ctx.route.timeRange || inferTimeRangeFromQuestion(ctx.question)
  const label = action.label || inferredRange?.label || '全部消息'

  emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'running', title: '统计当前会话', detail: label, toolName: 'get_session_statistics' })

  try {
    const stats = await loadSessionStatistics(ctx.sessionId, action, inferredRange)
    if (stats.toolCall) ctx.toolCalls.push(stats.toolCall)
    const payload = stats.payload
    const statsText = payload ? formatSessionStatisticsText(payload) : '未读取到会话统计。'
    ctx.aggregateText = ctx.aggregateText ? `${ctx.aggregateText}\n\n${statsText}` : statsText
    if (payload?.samples?.length) {
      for (const message of payload.samples) {
        const ref = toEvidenceRef(ctx.sessionId, message)
        if (ref) ctx.evidenceCandidates.push(ref)
      }
    }
    emitProgress(ctx.options, { id: progressId, stage: 'tool', status: payload && payload.totalMessages > 0 ? 'completed' : 'failed', title: '统计当前会话', detail: payload ? `统计 ${payload.totalMessages} 条消息` : '没有统计结果', toolName: 'get_session_statistics', count: payload?.totalMessages || 0 })
    ctx.observations.push({ title: '统计当前会话', detail: statsText })
  } catch (error) {
    emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'failed', title: '统计当前会话失败', detail: compactText(String(error), 120), toolName: 'get_session_statistics' })
    ctx.observations.push({ title: '统计当前会话失败', detail: `失败原因：${compactText(String(error), 160)}。` })
  }
}

async function executeKeywordStatistics(ctx: AgentContext, action: ToolLoopAction & { action: 'get_keyword_statistics' }) {
  ctx.toolCallsUsed += 1
  const progressId = `tool-loop-${ctx.toolCallsUsed}-keyword-stats`
  const inferredRange = ctx.route.timeRange || inferTimeRangeFromQuestion(ctx.question)
  const keywords = action.keywords.filter((k) => !isGenericSearchQuery(k)).slice(0, 6)

  if (keywords.length === 0) {
    ctx.observations.push({ title: '跳过关键词统计', detail: '没有可用关键词。' })
    return
  }

  emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'running', title: '统计关键词', detail: `关键词：${keywords.join('、')}`, toolName: 'get_keyword_statistics', query: keywords.join(' ') })

  try {
    const stats = await loadKeywordStatistics(ctx.sessionId, { ...action, keywords }, inferredRange)
    if (stats.toolCall) ctx.toolCalls.push(stats.toolCall)
    const payload = stats.payload
    const statsText = payload ? formatKeywordStatisticsText(payload) : '未读取到关键词统计。'
    ctx.aggregateText = ctx.aggregateText ? `${ctx.aggregateText}\n\n${statsText}` : statsText
    if (payload) {
      for (const ks of payload.keywords) {
        for (const sample of ks.samples) {
          const ref = toEvidenceRef(ctx.sessionId, sample.message, sample.excerpt)
          if (ref) ctx.evidenceCandidates.push(ref)
        }
      }
    }
    emitProgress(ctx.options, { id: progressId, stage: 'tool', status: payload && payload.matchedMessages > 0 ? 'completed' : 'failed', title: '统计关键词', detail: payload ? `命中 ${payload.matchedMessages} 条消息` : '没有统计结果', toolName: 'get_keyword_statistics', count: payload?.matchedMessages || 0 })
    ctx.observations.push({ title: '统计关键词', detail: statsText })
  } catch (error) {
    emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'failed', title: '统计关键词失败', detail: compactText(String(error), 120), toolName: 'get_keyword_statistics' })
    ctx.observations.push({ title: '统计关键词失败', detail: `失败原因：${compactText(String(error), 160)}。` })
  }
}

async function executeAggregateMessages(ctx: AgentContext, action: ToolLoopAction & { action: 'aggregate_messages' }) {
  ctx.toolCallsUsed += 1
  const progressId = `tool-loop-${ctx.toolCallsUsed}-aggregate`
  const inferredRange = ctx.route.timeRange || inferTimeRangeFromQuestion(ctx.question)
  const senderUsername = ctx.resolvedParticipants.find((i) => i.senderUsername)?.senderUsername
  let messages = dedupeMessagesByCursor(ctx.contextWindows.flatMap((w) => w.messages))

  emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'running', title: '整理统计', detail: action.reason || '对已读取消息做聚合整理', toolName: 'aggregate_messages', count: messages.length })

  if (ctx.route.intent === 'stats_or_count') {
    try {
      const directMessages = await loadMessagesByTimeRangeAll(ctx.sessionId, { startTime: inferredRange?.startTime, endTime: inferredRange?.endTime, senderUsername, maxMessages: 10000 })
      if (directMessages.length > messages.length) messages = dedupeMessagesByCursor(directMessages)
    } catch (error) {
      ctx.observations.push({ title: '完整统计读取失败', detail: `回退到已读取上下文统计：${compactText(String(error), 160)}。` })
    }
  }

  ctx.aggregateText = aggregateMessages(messages, action.metric)
  ctx.toolCalls.push(buildToolCall({ toolName: 'aggregate_messages', args: { metric: action.metric || 'summary', messageCount: messages.length }, summary: ctx.aggregateText, status: messages.length > 0 ? 'completed' : 'failed', evidenceCount: messages.length }))
  emitProgress(ctx.options, { id: progressId, stage: 'tool', status: messages.length > 0 ? 'completed' : 'failed', title: '整理统计', detail: messages.length > 0 ? `已整理 ${messages.length} 条消息` : '没有可聚合的消息', toolName: 'aggregate_messages', count: messages.length })
  ctx.observations.push({ title: '整理统计', detail: ctx.aggregateText })
}

async function executeSearchMessages(ctx: AgentContext, action: ToolLoopAction & { action: 'search_messages' }) {
  const query = normalizeSearchQuery(action.query, 48)
  const queryKey = query.toLowerCase()
  if (!query) {
    ctx.toolCallsUsed += 1
    const progressId = `tool-loop-${ctx.toolCallsUsed}-search`
    emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'failed', title: '搜索相关消息', detail: '搜索查询为空。', toolName: 'search_messages', query })
    ctx.observations.push({ title: '搜索参数错误', detail: '搜索查询为空。' })
    return
  }
  if (ctx.searchedQueries.has(queryKey)) {
    ctx.toolCallsUsed += 1
    const progressId = `tool-loop-${ctx.toolCallsUsed}-search`
    emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'completed', title: '搜索相关消息', detail: `已跳过重复关键词：${query}`, toolName: 'search_messages', query, count: 0 })
    ctx.observations.push({ title: '跳过重复搜索', detail: `关键词 "${query}" 已经搜索过，请更换关键词，或进入回答。` })
    return
  }

  ctx.searchedQueries.add(queryKey)
  ctx.toolCallsUsed += 1
  const progressId = `tool-loop-${ctx.toolCallsUsed}-search`

  emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'running', title: '搜索相关消息', detail: `关键词：${query}`, toolName: 'search_messages', query })

  try {
    const isExactLookup = isExactLookupQuestion(ctx.question)
    const limit = isExactLookup ? 30 : undefined
    const search = await searchSessionMessages(ctx.sessionId, query, {
      provider: ctx.options.provider, model: ctx.options.model, originalQuestion: ctx.question,
      sessionName: ctx.sessionName, semanticQuery: `${query} ${ctx.question}`,
      startTime: ctx.route.timeRange?.startTime, endTime: ctx.route.timeRange?.endTime,
      senderUsername: ctx.route.intent === 'participant_focus' ? ctx.resolvedParticipants.find((i) => i.senderUsername)?.senderUsername : undefined,
      limit,
      contactMap: ctx.contactMap
    })
    if (search.toolCall) ctx.toolCalls.push(search.toolCall)
    if (search.payload) {
      ctx.searchPayloads.push({ query, payload: search.payload })
      ctx.addKnownHits(query, search.payload)
    }
    if (search.contextWindows?.length) {
      const windowsToAppend = search.contextWindows.slice(0, Math.max(0, MAX_CONTEXT_WINDOWS - ctx.contextWindows.length))
      const appended = appendContextWindows(ctx, windowsToAppend)
      for (const w of windowsToAppend.slice(0, appended)) {
        ctx.addContextEvidence(w.messages)
      }
      if (appended < search.contextWindows.length) {
        ctx.observations.push({ title: '限制上下文扩展', detail: `搜索命中已展开 ${appended} 个上下文窗口，剩余命中不再展开以控制上下文长度。` })
      }
    }
    emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'completed', title: '搜索相关消息', detail: `关键词：${query}，命中 ${search.payload?.hits.length || 0} 条`, toolName: 'search_messages', query, count: search.payload?.hits.length || 0, diagnostics: [...(search.diagnostics || []), ...getSearchDiagnostics(search.payload)] })
    ctx.observations.push({ title: '搜索相关消息', detail: summarizeSearchObservation(query, search.payload, ctx.knownHits) })

    if ((search.payload?.hits.length || 0) === 0 && ctx.toolCallsUsed < MAX_TOOL_CALLS - 1) {
      const failure = interpretSearchFailure(search.payload)
      const altQuery = generateAlternativeQueries(query, ctx.question)
        .find((candidate) => !ctx.searchedQueries.has(candidate.toLowerCase()))
      const canRetry = ctx.searchRetries < MAX_SEARCH_RETRIES
        && Boolean(altQuery)
        && (failure.reason !== 'content_not_found' || isExactLookup)

      if (canRetry && altQuery) {
        ctx.searchRetries += 1
        ctx.observations.push({
          title: '搜索策略调整',
          detail: `"${query}" 无结果，自动尝试 "${altQuery}"（第 ${ctx.searchRetries} 次重试）`
        })
        await executeSearchMessages(ctx, {
          action: 'search_messages',
          query: altQuery,
          reason: `自动重试：${query} -> ${altQuery}`
        })
      } else if (failure.reason === 'content_not_found') {
        ctx.observations.push({ title: '搜索无结果（内容不存在）', detail: failure.suggestion })
      } else if (ctx.searchRetries < MAX_SEARCH_RETRIES) {
        ctx.observations.push({ title: '搜索策略调整', detail: `关键词"${query}"搜索 0 命中。${failure.suggestion}，但没有新的可用替代词。` })
      }
    }
  } catch (error) {
    ctx.toolCalls.push(buildToolCall({ toolName: 'search_messages', args: { sessionId: ctx.sessionId, query }, summary: `检索失败：${String(error)}`, status: 'failed' }))
    emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'failed', title: '搜索相关消息失败', detail: `关键词：${query}，${compactText(String(error), 120)}`, toolName: 'search_messages', query })
    ctx.observations.push({ title: '搜索相关消息失败', detail: `关键词：${query}，失败原因：${compactText(String(error), 160)}。` })
  }
}

async function executeReadContext(ctx: AgentContext, action: ToolLoopAction & { action: 'read_context' }) {
  if (ctx.contextWindows.length >= MAX_CONTEXT_WINDOWS && ctx.hasEvidence) {
    ctx.toolCallsUsed += 1
    const progressId = `tool-loop-${ctx.toolCallsUsed}-context`
    emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'completed', title: '读取命中上下文', detail: `上下文窗口已达 ${MAX_CONTEXT_WINDOWS} 个，跳过继续读取`, toolName: 'read_context', count: 0 })
    ctx.observations.push({ title: '跳过读取上下文', detail: `已有证据且上下文窗口已达 ${MAX_CONTEXT_WINDOWS} 个，请进入回答。` })
    return
  }

  const target = findKnownHitForAction(action, ctx.knownHits)
  if (!target) {
    ctx.toolCallsUsed += 1
    const progressId = `tool-loop-${ctx.toolCallsUsed}-context`
    emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'failed', title: '读取命中上下文', detail: '没有可读取的搜索命中', toolName: 'read_context' })
    ctx.observations.push({ title: '读取命中上下文', detail: '没有可读取的搜索命中，请先搜索。' })
    return
  }
  const contextKey = getMessageCursorKey(target.message)
  if (ctx.readContextKeys.has(contextKey)) {
    ctx.toolCallsUsed += 1
    const progressId = `tool-loop-${ctx.toolCallsUsed}-context`
    emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'completed', title: '读取命中上下文', detail: `已跳过重复命中：${target.hitId}`, toolName: 'read_context', count: 0 })
    ctx.observations.push({ title: '跳过重复上下文', detail: `${target.hitId} 已读取过前后文。请选择其他 hitId，或进行最终回答。` })
    return
  }

  ctx.toolCallsUsed += 1
  const beforeLimit = clampToolLimit(action.beforeLimit, SEARCH_CONTEXT_BEFORE, 12)
  const afterLimit = clampToolLimit(action.afterLimit, SEARCH_CONTEXT_AFTER, 12)
  const progressId = `tool-loop-${ctx.toolCallsUsed}-context`

  emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'running', title: '读取命中上下文', detail: `${target.hitId}，前 ${beforeLimit} 后 ${afterLimit}`, toolName: 'read_context', query: target.query })

  try {
    const context = await loadContextAroundMessage(ctx.sessionId, target.message, beforeLimit, afterLimit)
    if (context.toolCall) ctx.toolCalls.push(context.toolCall)
    const messages = context.payload?.items || []
    if (messages.length > 0) {
      ctx.readContextKeys.add(contextKey)
    }
    if (appendContextWindow(ctx, { source: 'search', query: target.query, anchor: target.message, messages })) {
      for (const m of messages) {
        const ref = toEvidenceRef(ctx.sessionId, m)
        if (ref) ctx.evidenceCandidates.push(ref)
      }
    } else {
      ctx.observations.push({ title: '跳过追加上下文', detail: `上下文窗口已达 ${MAX_CONTEXT_WINDOWS} 个，未继续追加 ${target.hitId} 的前后文。` })
    }
    emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'completed', title: '读取命中上下文', detail: `${target.hitId}，读取到 ${messages.length} 条`, toolName: 'read_context', count: messages.length })
    ctx.observations.push({ title: '读取命中上下文', detail: `${target.hitId}，读取到 ${messages.length} 条。\n${messages.slice(0, 10).map(formatMessageLine).join('\n')}` })
  } catch (error) {
    emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'failed', title: '读取命中上下文失败', detail: `${target.hitId}，${compactText(String(error), 120)}`, toolName: 'read_context' })
    ctx.observations.push({ title: '读取命中上下文失败', detail: `${target.hitId}，失败原因：${compactText(String(error), 160)}。` })
  }
}

async function executeReadLatest(ctx: AgentContext, action: ToolLoopAction & { action: 'read_latest' }) {
  ctx.usedRecentFallback = true
  if (ctx.contextWindows.length >= MAX_CONTEXT_WINDOWS && ctx.hasEvidence) {
    ctx.toolCallsUsed += 1
    const progressId = `tool-loop-${ctx.toolCallsUsed}-latest`
    emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'completed', title: '读取最近上下文', detail: `上下文窗口已达 ${MAX_CONTEXT_WINDOWS} 个，跳过继续读取`, toolName: 'read_latest', count: 0 })
    ctx.observations.push({ title: '跳过读取最近上下文', detail: `已有证据且上下文窗口已达 ${MAX_CONTEXT_WINDOWS} 个，请进入回答。` })
    return
  }

  if (ctx.contextWindows.some((w) => w.source === 'latest')) {
    ctx.toolCallsUsed += 1
    const progressId = `tool-loop-${ctx.toolCallsUsed}-latest`
    emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'completed', title: '读取最近上下文', detail: '已跳过重复读取', toolName: 'read_latest', count: 0 })
    ctx.observations.push({ title: '跳过重复读取', detail: '已读取过最近上下文，请进入回答。' })
    return
  }
  ctx.toolCallsUsed += 1
  const latestLimit = clampToolLimit(action.limit, MAX_CONTEXT_MESSAGES, MAX_CONTEXT_MESSAGES)
  const progressId = `tool-loop-${ctx.toolCallsUsed}-latest`

  emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'running', title: '读取最近上下文', detail: `读取最近 ${latestLimit} 条消息`, toolName: 'read_latest' })

  try {
    const latest = await loadLatestContext(ctx.sessionId, latestLimit)
    if (latest.toolCall) ctx.toolCalls.push(latest.toolCall)
    const latestMessages = latest.payload?.items || []
    if (appendContextWindow(ctx, { source: 'latest', messages: latestMessages })) {
      for (const m of latestMessages.slice(-8)) {
        const ref = toEvidenceRef(ctx.sessionId, m)
        if (ref) ctx.evidenceCandidates.push(ref)
      }
    } else {
      ctx.observations.push({ title: '跳过追加上下文', detail: `上下文窗口已达 ${MAX_CONTEXT_WINDOWS} 个，未继续追加最近消息。` })
    }
    emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'completed', title: '读取最近上下文', detail: `读取到 ${latestMessages.length} 条`, toolName: 'read_latest', count: latestMessages.length })
    ctx.observations.push({ title: '读取最近上下文', detail: `读取到 ${latestMessages.length} 条最近消息。\n${latestMessages.slice(0, 10).map(formatMessageLine).join('\n')}` })
  } catch (error) {
    emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'failed', title: '读取最近上下文失败', detail: compactText(String(error), 120), toolName: 'read_latest' })
    ctx.observations.push({ title: '读取最近上下文失败', detail: `失败原因：${compactText(String(error), 160)}。` })
  }
}

// ─── 工具分发 ────────────────────────────────────────────────

async function dispatchToolAction(ctx: AgentContext, action: ToolLoopAction): Promise<void> {
  switch (action.action) {
    case 'read_summary_facts': return executeSummaryFacts(ctx, action)
    case 'resolve_participant': return executeResolveParticipant(ctx, action)
    case 'read_by_time_range': return executeReadByTimeRange(ctx, action)
    case 'get_session_statistics': return executeSessionStatistics(ctx, action)
    case 'get_keyword_statistics': return executeKeywordStatistics(ctx, action)
    case 'aggregate_messages': return executeAggregateMessages(ctx, action)
    case 'search_messages': return executeSearchMessages(ctx, action)
    case 'read_context': return executeReadContext(ctx, action)
    case 'read_latest': return executeReadLatest(ctx, action)
    default: break
  }
}

type AssistantContentPart = {
  text?: unknown
}

function stringifyAssistantContent(content: unknown): string {
  if (!content) return ''
  if (typeof content === 'string') return stripThinkBlocks(content).trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const text = (part as AssistantContentPart).text
          return typeof text === 'string' ? text : ''
        }
        return ''
      })
      .join('')
      .trim()
  }
  return ''
}

function buildNativeToolState(ctx: AgentContext): NativeToolExecutionResult['state'] {
  return {
    toolCallsUsed: ctx.toolCallsUsed,
    knownHitIds: ctx.knownHits.slice(0, 12).map((hit) => hit.hitId),
    searchPayloadCount: ctx.searchPayloads.length,
    contextWindowCount: ctx.contextWindows.length,
    contextMessageCount: ctx.contextWindows.reduce((sum, window) => sum + window.messages.length, 0)
  }
}

function compactToolObservationForModel(result: NativeToolExecutionResult): string {
  return JSON.stringify({
    ok: result.ok,
    toolName: result.toolName,
    summary: compactText(result.summary, 1200),
    evidenceQuality: result.evidenceQuality,
    observations: result.observations.slice(-3).map((item) => ({
      title: item.title,
      detail: compactText(item.detail, 1800)
    })),
    state: result.state,
    error: result.error
  })
}

export function createFailedNativeToolResult(
  ctx: AgentContext,
  toolName: string,
  args: Record<string, unknown>,
  error: string
): NativeToolExecutionResult {
  const safeToolName = toSessionQAToolName(toolName)
  const toolCall = buildToolCall({
    toolName: safeToolName,
    args,
    summary: error,
    status: 'failed'
  })

  ctx.toolCallsUsed += 1
  ctx.toolCalls.push(toolCall)
  ctx.observations.push({ title: '工具参数错误', detail: error })
  emitProgress(ctx.options, {
    id: `tool-loop-${ctx.toolCallsUsed}-invalid`,
    stage: 'tool',
    status: 'failed',
    title: getAgentNodeName({ toolName: safeToolName }),
    detail: error,
    toolName: safeToolName
  })

  return {
    ok: false,
    toolName: safeToolName,
    args,
    summary: error,
    observations: [{ title: '工具参数错误', detail: error }],
    toolCalls: [toolCall],
    evidenceQuality: ctx.evidenceQuality,
    error,
    state: buildNativeToolState(ctx)
  }
}

export async function executeNativeToolAction(
  ctx: AgentContext,
  action: ToolLoopAction,
  args: Record<string, unknown>
): Promise<NativeToolExecutionResult> {
  if (action.action === 'answer') {
    const summary = action.reason || '模型判断可以进入最终回答。'
    ctx.observations.push({ title: '开始回答', detail: summary })
    return {
      ok: true,
      toolName: 'answer',
      args,
      summary,
      observations: [{ title: '开始回答', detail: summary }],
      toolCalls: [] as SessionQAToolCall[],
      evidenceQuality: ctx.evidenceQuality,
      state: buildNativeToolState(ctx)
    }
  }

  const beforeObservationCount = ctx.observations.length
  const beforeToolCallCount = ctx.toolCalls.length
  await dispatchToolAction(ctx, action)

  const observations: ToolObservation[] = ctx.observations.slice(beforeObservationCount)
  const toolCalls: SessionQAToolCall[] = ctx.toolCalls.slice(beforeToolCallCount)
  const summary = observations.map((item) => `${item.title}: ${item.detail}`).join('\n\n')
    || toolCalls.map((item) => item.summary).join('\n')
    || `${action.action} 执行完成。`
  const hasFailedToolCall = toolCalls.some((item) => item.status === 'failed')

  return {
    ok: !hasFailedToolCall,
    toolName: action.action,
    args,
    summary,
    observations,
    toolCalls,
    evidenceQuality: ctx.evidenceQuality,
    state: buildNativeToolState(ctx)
  }
}

function shouldAcceptPlainAssistantAnswer(ctx: AgentContext, route: IntentRoute): boolean {
  return ctx.evidenceQuality !== 'none'
    || route.intent === 'direct_answer'
    || hasConclusiveSearchFailure(ctx.searchPayloads)
}

function appendLocalFallbackResultMessage(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  action: ToolLoopAction,
  result: NativeToolExecutionResult
) {
  messages.push({
    role: 'user',
    content: `系统已自动执行本地补充工具 ${action.action}，结果如下。请基于这些观察继续：\n${compactToolObservationForModel(result)}`
  })
}

async function answerDirectlyWithoutTools(
  ctx: AgentContext,
  historyText: string,
  maxTokens: number
): Promise<SessionQAAgentResult> {
  const promptText = `用户当前问题：
${ctx.question}

多轮上下文：
${historyText || '无'}

请直接、简洁地用中文回应。寒暄、确认、感谢不需要读取聊天记录；如果用户询问当前模型或服务商，基于“当前助手信息”回答；如果用户询问能力，可以说明你能查询和分析当前会话的聊天记录，但不要编造具体聊天事实。`
  const assistantInfo = `当前助手信息：
- 产品：CipherTalk 问答助手
- 服务商：${ctx.options.provider.displayName || ctx.options.provider.name}
- 当前模型：${ctx.options.model || '未知'}`
  const finalPromptText = `${assistantInfo}\n\n${promptText}`
  ctx.lastAgentPrompt = finalPromptText

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: `你是 CipherTalk 的问答助手。当前输入不需要工具或聊天记录证据，请自然回应。\n${assistantInfo}` },
    { role: 'user', content: finalPromptText }
  ]

  emitProgress(ctx.options, { id: 'answer', stage: 'answer', status: 'running', title: '生成回答', detail: '直接回答，无需调用工具' })
  const thinkFilterState = { isThinking: false }
  await ctx.options.provider.streamChat(messages, { model: ctx.options.model, temperature: 0.4, maxTokens, enableThinking: false }, (chunk) => {
    const visibleChunk = filterThinkChunk(chunk, thinkFilterState)
    if (!visibleChunk) return
    ctx.answerText += visibleChunk
    ctx.options.onChunk(visibleChunk)
  })

  const finalAnswerText = stripThinkBlocks(ctx.answerText)
  ctx.trackAnswerTokens(finalPromptText, finalAnswerText)
  emitProgress(ctx.options, { id: 'answer', stage: 'answer', status: 'completed', title: '生成回答', detail: '回答生成完成' })
  ctx.logger.lifecycle('Agent 直接回答完成', { ...ctx.getTokenUsage() })

  return {
    answerText: finalAnswerText,
    evidenceRefs: [],
    toolCalls: [],
    promptText: finalPromptText,
    tokenUsage: ctx.getTokenUsage()
  }
}

// ─── 普通文本自动推进：根据当前状态选择下一个工具 ────────

/**
 * 当模型输出普通文本但当前证据不足时，根据当前 Agent 状态自动选择一个合理的工具执行，
 * 避免 continue 空转导致重复输出。
 *
 * 选择策略按优先级：
 * 1. 如果启发式路由有未搜索的关键词 → search_messages
 * 2. 如果还没读过摘要事实 → read_summary_facts
 * 3. 如果路由有时间范围 → read_by_time_range
 * 4. 如果路由有参与者线索且未解析 → resolve_participant
 * 5. 兜底 → read_latest
 */
export function pickFallbackToolAction(ctx: AgentContext, route: IntentRoute): ToolLoopAction {
  // 优先用启发式路由建议的搜索关键词
  const nextSearchQuery = route.searchQueries.find((q) => !ctx.searchedQueries.has(q.toLowerCase()))
  if (nextSearchQuery && ctx.toolCallsUsed < MAX_TOOL_CALLS - 2) {
    return { action: 'search_messages', query: nextSearchQuery, reason: '模型输出普通文本但证据不足，自动执行路由推荐的搜索' }
  }

  // 还没读过摘要
  if (!ctx.summaryFactsRead && !ctx.observations.some((o) => o.title === '读取摘要事实')) {
    return { action: 'read_summary_facts', reason: '模型输出普通文本但证据不足，自动检查摘要事实' }
  }

  // 路由有时间范围线索
  if (route.timeRange && ctx.contextWindows.length === 0) {
    return {
      action: 'read_by_time_range',
      startTime: route.timeRange.startTime,
      endTime: route.timeRange.endTime,
      label: route.timeRange.label,
      reason: '模型输出普通文本但证据不足，自动按时间范围读取'
    }
  }

  // 路由有参与者线索但尚未解析
  if (route.participantHints.length > 0 && ctx.resolvedParticipants.length === 0) {
    return { action: 'resolve_participant', name: route.participantHints[0], reason: '模型输出普通文本但证据不足，自动解析参与者' }
  }

  if (!ctx.contextWindows.some((w) => w.source === 'latest')) {
    return { action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: '模型输出普通文本但证据不足，自动读取最近上下文兜底' }
  }

  return { action: 'answer', reason: '所有自动探测工具已执行完毕，强制进入总结环节。' }
}

// ─── 主函数 ──────────────────────────────────────────────────

export async function createSessionQANativeToolExecutor(
  options: SessionQAAgentOptions
): Promise<(toolName: string, args: Record<string, unknown>) => Promise<NativeToolExecutionResult>> {
  const route = enforceConcreteEvidenceRoute(routeFromHeuristics(options.question, options.summaryText), options.question)
  const contactMap = await loadSessionContactMap(options.sessionId)
  if (options.sessionName && !contactMap.has(options.sessionId)) {
    contactMap.set(options.sessionId, options.sessionName)
  }
  const ctx = new AgentContext(options, route, contactMap)

  return async (toolName: string, args: Record<string, unknown>) => {
    const parsed = parseNativeToolCallArguments(toolName, args)
    if (!parsed.action || parsed.error) {
      return createFailedNativeToolResult(ctx, toolName || 'unknown', args, parsed.error || '工具参数无效。')
    }
    return executeNativeToolAction(ctx, parsed.action, parsed.args)
  }
}

async function legacySessionQALoopDisabled(
  options: SessionQAAgentOptions
): Promise<SessionQAAgentResult> {
  const structuredContext = buildStructuredContext(options.structuredAnalysis)
  const historyText = buildHistoryContext(options.history)
  const heuristicRoute = routeFromHeuristics(options.question, options.summaryText)
  let route = heuristicRoute
  let aiIntentResult: AIIntentRouterResult | null = null

  emitProgress(options, {
    id: 'intent-route',
    stage: 'intent',
    status: 'running',
    title: '识别问题意图',
    detail: '正在判断是否需要读取聊天记录'
  })

  if (!(heuristicRoute.intent === 'direct_answer' && !heuristicRoute.needsSearch)) {
    try {
      aiIntentResult = await refineRouteWithAIIntent({
        provider: options.provider,
        model: options.model,
        question: options.question,
        sessionName: options.sessionName,
        historyText,
        heuristicRoute
      })
      route = aiIntentResult.route
    } catch {
      route = heuristicRoute
    }
  }

  if (!(route.intent === 'direct_answer' && !route.needsSearch)) {
    route = enforceConcreteEvidenceRoute(route, options.question)
  }

  emitProgress(options, {
    id: 'intent-route',
    stage: 'intent',
    status: 'completed',
    title: '识别问题意图',
    detail: `${getRouteLabel(route.intent)}；${route.needsSearch ? '需要读取聊天记录' : '无需读取聊天记录'}`
  })

  let contactMap = new Map<string, string>()
  if (!(route.intent === 'direct_answer' && !route.needsSearch)) {
    emitProgress(options, {
      id: 'load-contact-map',
      stage: 'context',
      status: 'running',
      title: '加载联系人信息',
      detail: '正在加载当前会话的联系人映射'
    })
    contactMap = await loadSessionContactMap(options.sessionId)
    emitProgress(options, {
      id: 'load-contact-map',
      stage: 'context',
      status: 'completed',
      title: '加载联系人信息',
      detail: `已加载 ${contactMap.size} 个联系人映射`,
      count: contactMap.size
    })
  }
  if (options.sessionName && !contactMap.has(options.sessionId)) {
    contactMap.set(options.sessionId, options.sessionName)
  }
  const ctx = new AgentContext(options, route, contactMap)
  if (aiIntentResult) {
    ctx.trackDecisionTokens(aiIntentResult.promptText, aiIntentResult.responseText)
  }

  const agentDecisionMaxTokens = clampTokenBudget(options.agentDecisionMaxTokens, DEFAULT_AGENT_DECISION_MAX_TOKENS, 512, MAX_AGENT_DECISION_MAX_TOKENS)
  const agentAnswerMaxTokens = clampTokenBudget(options.agentAnswerMaxTokens, DEFAULT_AGENT_ANSWER_MAX_TOKENS, 512, MAX_AGENT_ANSWER_MAX_TOKENS)

  if (route.intent === 'direct_answer' && !route.needsSearch) {
    return answerDirectlyWithoutTools(ctx, historyText, Math.min(agentAnswerMaxTokens, 1024))
  }

  const nativeTools = getNativeSessionQATools()
  const initialAgentPrompt = buildAutonomousAgentPrompt({
    sessionName: ctx.sessionName, question: ctx.question, route,
    summaryText: options.summaryText, structuredContext, historyText,
    observations: ctx.observations, knownHits: ctx.knownHits,
    resolvedParticipants: ctx.resolvedParticipants, aggregateText: ctx.aggregateText,
    summaryFactsRead: ctx.summaryFactsRead, toolCallsUsed: ctx.toolCallsUsed,
    evidenceQuality: ctx.evidenceQuality, searchRetries: ctx.searchRetries,
    searchPayloads: ctx.searchPayloads, contextWindows: ctx.contextWindows
  })
  ctx.lastAgentPrompt = initialAgentPrompt

  const toolLoopMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: '你是 CipherTalk 的聊天记录问答 Agent。你可以使用 OpenAI-compatible 原生 tools/tool_calls，也可以在问题不需要聊天记录证据时直接回答；不要输出 JSON action。需要调用工具时，先用一句简短中文告诉用户你将查看什么，然后立即调用工具。事实类问题证据不足时继续调用工具或明确说明证据不足。'
    },
    {
      role: 'user',
      content: initialAgentPrompt
    }
  ]

  try {
    if (typeof options.provider.chatWithTools !== 'function') {
      throw new Error(NATIVE_TOOL_CALLING_UNSUPPORTED_MESSAGE)
    }

    // ── 原生 tools/tool_calls 主循环 ──
    while (ctx.shouldContinueLoop()) {
      ctx.checkAbort()
      ctx.decisionAttempts += 1

      let nativeResponse
      let streamedDecisionText = ''
      const decisionProgressId = `decision-${ctx.decisionAttempts}`
      emitProgress(options, {
        id: decisionProgressId,
        stage: 'thought',
        status: 'running',
        title: '等待模型决策',
        detail: `第 ${ctx.decisionAttempts} 轮，正在判断下一步工具或回答`
      })
      try {
        const toolOptions: ChatWithToolsOptions = {
          model: options.model,
          temperature: 0.2,
          maxTokens: agentDecisionMaxTokens,
          enableThinking: options.enableThinking !== false,
          tools: nativeTools,
          toolChoice: 'auto'
        }
        if (typeof options.provider.streamChatWithTools === 'function') {
          nativeResponse = await options.provider.streamChatWithTools(toolLoopMessages, toolOptions, (chunk) => {
            streamedDecisionText += chunk
            ctx.emitAnswerChunk(chunk)
          })
        } else {
          nativeResponse = await options.provider.chatWithTools(toolLoopMessages, toolOptions)
        }
        const toolCallCount = Array.isArray((nativeResponse.message as any)?.tool_calls)
          ? (nativeResponse.message as any).tool_calls.length
          : 0
        emitProgress(options, {
          id: decisionProgressId,
          stage: 'thought',
          status: 'completed',
          title: '等待模型决策',
          detail: toolCallCount > 0 ? `模型请求调用 ${toolCallCount} 个工具` : '模型未请求工具调用',
          count: toolCallCount
        })
      } catch (error) {
        emitProgress(options, {
          id: decisionProgressId,
          stage: 'thought',
          status: 'failed',
          title: '等待模型决策',
          detail: compactText(String(error), 120)
        })
        if ((error instanceof Error && error.message === NATIVE_TOOL_CALLING_UNSUPPORTED_MESSAGE) || isNativeToolCallingUnsupportedError(error)) {
          throw new Error(NATIVE_TOOL_CALLING_UNSUPPORTED_MESSAGE)
        }
        throw error
      }

      const assistantMessage = nativeResponse.message
      const assistantText = stringifyAssistantContent(assistantMessage.content)
      const nativeToolCalls = Array.isArray((assistantMessage as any).tool_calls)
        ? (assistantMessage as any).tool_calls as Array<{ id: string; type: string; function?: { name?: string; arguments?: string } }>
        : []
      const decisionTrace = JSON.stringify({
        content: compactText(assistantText, 800),
        toolCalls: nativeToolCalls.map((call) => ({
          id: call.id,
          name: call.function?.name,
          arguments: compactText(call.function?.arguments || '', 800)
        })),
        finishReason: nativeResponse.finishReason
      })
      ctx.trackDecisionTokens(ctx.lastAgentPrompt, decisionTrace)

      toolLoopMessages.push(assistantMessage as OpenAI.Chat.ChatCompletionMessageParam)

      if (nativeToolCalls.length > 0) {
        let shouldGenerateFinalAnswer = false

        for (const toolCall of nativeToolCalls) {
          ctx.checkAbort()
          const toolName = String(toolCall.function?.name || '')
          const toolCallId = toolCall.id || `tool-${Date.now()}-${ctx.toolCallsUsed}`
          const parsed = parseNativeToolCallArguments(toolName, toolCall.function?.arguments)

          let result: NativeToolExecutionResult
          if (!parsed.action || parsed.error) {
            result = createFailedNativeToolResult(ctx, toolName || 'unknown', parsed.args, parsed.error || '工具参数无效。')
            toolLoopMessages.push({
              role: 'tool',
              tool_call_id: toolCallId,
              content: compactToolObservationForModel(result)
            } as OpenAI.Chat.ChatCompletionMessageParam)
            continue
          }

          let action = parsed.action
          const evidenceQuality = ctx.evidenceQuality
          const conclusiveSearchFailure = hasConclusiveSearchFailure(ctx.searchPayloads)

          if (action.action === 'read_latest' && route.timeRange) {
            action = {
              action: 'read_by_time_range',
              startTime: route.timeRange.startTime,
              endTime: route.timeRange.endTime,
              label: route.timeRange.label,
              limit: action.limit,
              reason: action.reason || '问题包含时间线索，改为按时间范围读取'
            }
          }

          if (evidenceQuality === 'none' && ctx.toolCallsUsed >= MAX_TOOL_CALLS - 1 && action.action !== 'read_latest' && action.action !== 'answer') {
            action = { action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: '工具预算即将耗尽' }
          }

          if (action.action === 'answer') {
            if (evidenceQuality === 'none' && route.intent !== 'direct_answer' && !conclusiveSearchFailure) {
              action = ctx.summaryFactsRead
                ? { action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: '模型准备回答但仍缺少证据，读取最近上下文兜底' }
                : { action: 'read_summary_facts', reason: '模型准备回答但尚无证据，先检查摘要事实' }
            } else if (evidenceQuality === 'weak' && ctx.toolCallsUsed < MAX_TOOL_CALLS - 2) {
              const hasSearchedWithNoHits = ctx.searchPayloads.length > 0 && ctx.searchPayloads.every((i) => i.payload.hits.length === 0)
              if (hasSearchedWithNoHits && ctx.searchRetries < MAX_SEARCH_RETRIES) {
                const nextQuery = route.searchQueries.find((q) => !ctx.searchedQueries.has(q.toLowerCase()))
                action = nextQuery
                  ? { action: 'search_messages', query: nextQuery, reason: '之前的搜索没有命中，换关键词重试' }
                  : { action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: '搜索没有命中且缺少新关键词' }
              }
            }
          }

          result = await executeNativeToolAction(ctx, action, parsed.args)
          toolLoopMessages.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: compactToolObservationForModel(result)
          } as OpenAI.Chat.ChatCompletionMessageParam)

          if (action.action === 'answer') {
            shouldGenerateFinalAnswer = true
            break
          }

          const autoFinalizeReason = getAutoFinalizeReason(ctx, action)
          if (autoFinalizeReason) {
            ctx.observations.push({ title: '停止继续检索', detail: autoFinalizeReason })
            shouldGenerateFinalAnswer = true
            break
          }
        }

        if (shouldGenerateFinalAnswer) {
          break
        }
        continue
      }

      if (assistantText) {
        if (shouldAcceptPlainAssistantAnswer(ctx, route)) {
          emitProgress(options, { id: 'answer', stage: 'answer', status: 'running', title: '生成回答', detail: 'Agent 已决定直接回答' })
          if (!streamedDecisionText) {
            ctx.emitVisibleText(assistantText)
          }
          ctx.trackAnswerTokens(ctx.lastAgentPrompt, assistantText)
          emitProgress(options, { id: 'answer', stage: 'answer', status: 'completed', title: '生成回答', detail: '回答生成完成' })
          ctx.logger.lifecycle('Agent 直接回答完成', { ...ctx.getTokenUsage() })
          return { answerText: stripThinkBlocks(ctx.answerText), evidenceRefs: dedupeEvidenceRefs(ctx.evidenceCandidates), toolCalls: ctx.toolCalls, promptText: ctx.lastAgentPrompt, tokenUsage: ctx.getTokenUsage() }
        }

        const fallbackAction = pickFallbackToolAction(ctx, route)
        if (fallbackAction.action === 'answer') {
          ctx.observations.push({ title: '开始回答', detail: fallbackAction.reason || '本地补充工具已执行完毕，进入最终回答。' })
          break
        }
        const fallbackResult = await executeNativeToolAction(ctx, fallbackAction, { ...fallbackAction })
        appendLocalFallbackResultMessage(toolLoopMessages, fallbackAction, fallbackResult)
        const autoFinalizeReason = getAutoFinalizeReason(ctx, fallbackAction)
        if (autoFinalizeReason) {
          ctx.observations.push({ title: '停止继续检索', detail: autoFinalizeReason })
          break
        }
        continue
      }

      const fallbackAction = pickFallbackToolAction(ctx, route)
      if (fallbackAction.action === 'answer') {
        ctx.observations.push({ title: '开始回答', detail: fallbackAction.reason || '模型未返回工具调用，进入最终回答。' })
        break
      }
      const fallbackResult = await executeNativeToolAction(ctx, fallbackAction, { ...fallbackAction })
      appendLocalFallbackResultMessage(toolLoopMessages, fallbackAction, fallbackResult)
      const autoFinalizeReason = getAutoFinalizeReason(ctx, fallbackAction)
      if (autoFinalizeReason) {
        ctx.observations.push({ title: '停止继续检索', detail: autoFinalizeReason })
        break
      }
    }

    // ── 循环结束后的兜底读取 ──
    if (route.intent !== 'direct_answer' && !ctx.hasEvidence && ctx.toolCallsUsed < MAX_TOOL_CALLS) {
      await executeReadLatest(ctx, { action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: '回答前仍缺少证据，读取最近消息兜底' })
    }
  } catch (error) {
    // 超时或取消时，用已有信息尽量给出回答
    if (error instanceof AgentAbortError) {
      if (ctx.hasEvidence) {
        ctx.emitVisibleText(`\n\n> ⚠️ ${error.message}，以下为基于已收集证据的部分回答。`)
      } else {
        ctx.emitVisibleText(`\n\n> ⚠️ ${error.message}`)
        ctx.logger.warn('Agent 中断（无证据）', { code: error.code, elapsed: ctx.elapsedMs })
        return { answerText: stripThinkBlocks(ctx.answerText), evidenceRefs: dedupeEvidenceRefs(ctx.evidenceCandidates), toolCalls: ctx.toolCalls, promptText: ctx.lastAgentPrompt, tokenUsage: ctx.getTokenUsage() }
      }
    } else {
      throw error
    }
  }

  // ── 生成最终回答 ──
  const contextMessageCount = dedupeMessagesByCursor(ctx.contextWindows.flatMap((w) => w.messages)).length
  const totalSearchHits = ctx.searchPayloads.reduce((sum, i) => sum + i.payload.hits.length, 0)

  emitProgress(options, {
    id: 'context', stage: 'context', status: 'completed', title: '整理回答依据',
    detail: `摘要${ctx.summaryFactsRead ? '可用' : '未用'}；搜索命中 ${totalSearchHits} 条；读取消息 ${contextMessageCount} 条${ctx.aggregateText ? '；已聚合' : ''}`,
    count: contextMessageCount
  })

  const promptText = buildAnswerPrompt({
    sessionName: ctx.sessionName, question: ctx.question, route,
    summaryText: options.summaryText, structuredContext,
    summaryFactsText: ctx.summaryFactsText, contextWindows: ctx.contextWindows,
    searchPayloads: ctx.searchPayloads, aggregateText: ctx.aggregateText,
    resolvedParticipants: ctx.resolvedParticipants, historyText,
    usedRecentFallback: ctx.usedRecentFallback
  })

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: '你是严谨的聊天记录问答助手。你必须基于给定上下文回答，并在证据不足时明确承认不足。' },
    { role: 'user', content: promptText }
  ]

  emitProgress(options, { id: 'answer', stage: 'answer', status: 'running', title: '生成回答', detail: '正在基于上下文生成回答' })

  const enableThinking = options.enableThinking !== false
  const thinkFilterState = { isThinking: false }
  ctx.ensureAnswerSeparator()
  await options.provider.streamChat(messages, { model: options.model, temperature: 0.3, maxTokens: agentAnswerMaxTokens, enableThinking }, (chunk) => {
    const visibleChunk = enableThinking ? chunk : filterThinkChunk(chunk, thinkFilterState)
    if (!visibleChunk) return
    ctx.emitAnswerChunk(visibleChunk)
  })

  const finalAnswerText = stripThinkBlocks(ctx.answerText)
  ctx.trackAnswerTokens(promptText, finalAnswerText)

  emitProgress(options, { id: 'answer', stage: 'answer', status: 'completed', title: '生成回答', detail: '回答生成完成' })

  const usage = ctx.getTokenUsage()
  ctx.logger.lifecycle('问答 Agent 完成', {
    elapsed: ctx.elapsedMs,
    toolCalls: ctx.toolCallsUsed,
    decisionAttempts: ctx.decisionAttempts,
    evidenceQuality: ctx.evidenceQuality,
    decisionTokens: usage.decisionTokens,
    answerTokens: usage.answerTokens,
    totalTokens: usage.totalTokens,
    budgetExceeded: usage.budgetExceeded
  })

  return {
    answerText: finalAnswerText,
    evidenceRefs: dedupeEvidenceRefs(ctx.evidenceCandidates),
    toolCalls: ctx.toolCalls,
    promptText: ctx.lastAgentPrompt ? `${ctx.lastAgentPrompt}\n\n--- final answer prompt ---\n${promptText}` : promptText,
    tokenUsage: ctx.getTokenUsage()
  }
}
