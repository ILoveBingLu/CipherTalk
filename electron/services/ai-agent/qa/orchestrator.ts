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
  ContextWindow
} from './types'
import {
  MAX_CONTEXT_MESSAGES,
  MAX_SUMMARY_CHARS,
  MAX_STRUCTURED_CHARS,
  MAX_HISTORY_MESSAGES,
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
import { emitProgress } from './progress'
import { AgentContext, AgentAbortError } from './agentContext'
import { chooseNextAutonomousAgentAction } from './agentDecision'
import { assessEvidenceQuality, hasConclusiveSearchFailure, findKnownHitForAction, summarizeSearchObservation, getSearchDiagnostics, interpretSearchFailure } from './evidence'
import { searchSessionMessages, loadLatestContext, loadContextAroundMessage } from './tools/search'
import { loadSessionStatistics, loadKeywordStatistics, loadMessagesByTimeRange, loadMessagesByTimeRangeAll, formatSessionStatisticsText, formatKeywordStatisticsText } from './tools/statistics'
import { resolveParticipantName, findResolvedSenderUsername } from './tools/participant'
import { aggregateMessages } from './tools/aggregate'
import { buildAnswerPrompt } from './prompts/answer'
import { classifyAgentError, shouldRetryToolCall, getRetryDelayMs } from './errors'
import type { SummaryEvidenceRef } from '../types/analysis'

// ─── 辅助函数 ────────────────────────────────────────────────

function buildStructuredContext(analysis?: StructuredAnalysis): string {
  if (!analysis) return ''
  return compactText(JSON.stringify(analysis), MAX_STRUCTURED_CHARS)
}

function buildHistoryContext(history: SessionQAAgentOptions['history'] = []): string {
  return (history || [])
    .slice(-MAX_HISTORY_MESSAGES)
    .map((item) => `${item.role === 'user' ? '用户' : 'AI'}：${compactText(item.content, 500)}`)
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

  ctx.toolCalls.push({ toolName: 'read_summary_facts', args: { hasSummaryText: Boolean(stripThinkBlocks(ctx.options.summaryText || '').trim()), hasStructuredAnalysis: Boolean(structuredContext) }, summary: ctx.summaryFactsRead ? '已读取当前摘要和结构化摘要。' : '当前没有可用摘要事实。' })
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
  ctx.toolCalls.push({ toolName: 'resolve_participant', args: { sessionId: ctx.sessionId, name }, summary: resolution.senderUsername ? `解析为 ${resolution.displayName || resolution.senderUsername}` : '未解析到明确发送者，后续读取会不加发送者过滤。' })
  emitProgress(ctx.options, { id: progressId, stage: 'tool', status: resolution.senderUsername ? 'completed' : 'failed', title: '解析参与者', detail: resolution.senderUsername ? `${resolution.query} => ${resolution.displayName || resolution.senderUsername}` : `${resolution.query} 未解析到明确发送者`, toolName: 'resolve_participant', query: name, count: resolution.senderUsername ? 1 : 0 })
  ctx.observations.push({ title: '解析参与者', detail: resolution.senderUsername ? `${resolution.query} => ${resolution.displayName || resolution.senderUsername} (${resolution.senderUsername})，置信度 ${resolution.confidence}。` : `${resolution.query} 未解析到明确 senderUsername。` })
}

async function executeReadByTimeRange(ctx: AgentContext, action: ToolLoopAction & { action: 'read_by_time_range' }) {
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
    ctx.contextWindows.push({ source: 'time_range', label, messages })
    ctx.addContextEvidence(messages)
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
  ctx.toolCalls.push({ toolName: 'aggregate_messages', args: { metric: action.metric || 'summary', messageCount: messages.length }, summary: ctx.aggregateText, status: messages.length > 0 ? 'completed' : 'failed', evidenceCount: messages.length })
  emitProgress(ctx.options, { id: progressId, stage: 'tool', status: messages.length > 0 ? 'completed' : 'failed', title: '整理统计', detail: messages.length > 0 ? `已整理 ${messages.length} 条消息` : '没有可聚合的消息', toolName: 'aggregate_messages', count: messages.length })
  ctx.observations.push({ title: '整理统计', detail: ctx.aggregateText })
}

async function executeSearchMessages(ctx: AgentContext, action: ToolLoopAction & { action: 'search_messages' }) {
  const query = normalizeSearchQuery(action.query, 48)
  const queryKey = query.toLowerCase()
  if (!query || ctx.searchedQueries.has(queryKey)) {
    ctx.observations.push({ title: '跳过重复检索', detail: query ? `关键词"${query}"已检索过。` : '模型给出的关键词为空。' })
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
      for (const w of search.contextWindows) {
        ctx.contextWindows.push(w)
        ctx.addContextEvidence(w.messages)
        if (w.anchor) ctx.readContextKeys.add(getMessageCursorKey(w.anchor))
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
    ctx.toolCalls.push({ toolName: 'search_messages', args: { sessionId: ctx.sessionId, query }, summary: `检索失败：${String(error)}` })
    emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'failed', title: '搜索相关消息失败', detail: `关键词：${query}，${compactText(String(error), 120)}`, toolName: 'search_messages', query })
    ctx.observations.push({ title: '搜索相关消息失败', detail: `关键词：${query}，失败原因：${compactText(String(error), 160)}。` })
  }
}

async function executeReadContext(ctx: AgentContext, action: ToolLoopAction & { action: 'read_context' }) {
  const target = findKnownHitForAction(action, ctx.knownHits)
  if (!target) {
    ctx.observations.push({ title: '读取命中上下文', detail: '没有可读取的搜索命中，请先搜索。' })
    return
  }
  const contextKey = getMessageCursorKey(target.message)
  if (ctx.readContextKeys.has(contextKey)) {
    ctx.observations.push({ title: '跳过重复上下文', detail: `${target.hitId} 已读取过前后文。` })
    return
  }

  ctx.readContextKeys.add(contextKey)
  ctx.toolCallsUsed += 1
  const beforeLimit = clampToolLimit(action.beforeLimit, SEARCH_CONTEXT_BEFORE, 12)
  const afterLimit = clampToolLimit(action.afterLimit, SEARCH_CONTEXT_AFTER, 12)
  const progressId = `tool-loop-${ctx.toolCallsUsed}-context`

  emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'running', title: '读取命中上下文', detail: `${target.hitId}，前 ${beforeLimit} 后 ${afterLimit}`, toolName: 'read_context', query: target.query })

  try {
    const context = await loadContextAroundMessage(ctx.sessionId, target.message, beforeLimit, afterLimit)
    if (context.toolCall) ctx.toolCalls.push(context.toolCall)
    const messages = context.payload?.items || []
    ctx.contextWindows.push({ source: 'search', query: target.query, anchor: target.message, messages })
    for (const m of messages) {
      const ref = toEvidenceRef(ctx.sessionId, m)
      if (ref) ctx.evidenceCandidates.push(ref)
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
  ctx.toolCallsUsed += 1
  const latestLimit = clampToolLimit(action.limit, MAX_CONTEXT_MESSAGES, MAX_CONTEXT_MESSAGES)
  const progressId = `tool-loop-${ctx.toolCallsUsed}-latest`

  emitProgress(ctx.options, { id: progressId, stage: 'tool', status: 'running', title: '读取最近上下文', detail: `读取最近 ${latestLimit} 条消息`, toolName: 'read_latest' })

  try {
    const latest = await loadLatestContext(ctx.sessionId, latestLimit)
    if (latest.toolCall) ctx.toolCalls.push(latest.toolCall)
    const latestMessages = latest.payload?.items || []
    ctx.contextWindows.push({ source: 'latest', messages: latestMessages })
    for (const m of latestMessages.slice(-8)) {
      const ref = toEvidenceRef(ctx.sessionId, m)
      if (ref) ctx.evidenceCandidates.push(ref)
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

// ─── 主函数 ──────────────────────────────────────────────────

export async function answerSessionQuestionWithAgent(
  options: SessionQAAgentOptions
): Promise<SessionQAAgentResult> {
  const structuredContext = buildStructuredContext(options.structuredAnalysis)
  const historyText = buildHistoryContext(options.history)
  const route = enforceConcreteEvidenceRoute(routeFromHeuristics(options.question, options.summaryText), options.question)
  const contactMap = await loadSessionContactMap(options.sessionId)
  if (options.sessionName && !contactMap.has(options.sessionId)) {
    contactMap.set(options.sessionId, options.sessionName)
  }
  const ctx = new AgentContext(options, route, contactMap)

  const agentDecisionMaxTokens = clampTokenBudget(options.agentDecisionMaxTokens, DEFAULT_AGENT_DECISION_MAX_TOKENS, 512, MAX_AGENT_DECISION_MAX_TOKENS)
  const agentAnswerMaxTokens = clampTokenBudget(options.agentAnswerMaxTokens, DEFAULT_AGENT_ANSWER_MAX_TOKENS, 512, MAX_AGENT_ANSWER_MAX_TOKENS)
  const finalAnswerContentCharLimit = Math.max(4000, agentAnswerMaxTokens * 4)

  try {
    // ── 主决策循环 ──
    while (ctx.shouldContinueLoop()) {
      ctx.checkAbort()
      ctx.decisionAttempts += 1

      const evidenceQuality = ctx.evidenceQuality
      const conclusiveSearchFailure = hasConclusiveSearchFailure(ctx.searchPayloads)

      const agentDecision = await chooseNextAutonomousAgentAction(options.provider, options.model, {
        sessionName: ctx.sessionName, question: ctx.question, route,
        summaryText: options.summaryText, structuredContext, historyText,
        observations: ctx.observations, knownHits: ctx.knownHits,
        resolvedParticipants: ctx.resolvedParticipants, aggregateText: ctx.aggregateText,
        summaryFactsRead: ctx.summaryFactsRead, toolCallsUsed: ctx.toolCallsUsed,
        evidenceQuality, searchRetries: ctx.searchRetries,
        searchPayloads: ctx.searchPayloads, contextWindows: ctx.contextWindows
      }, { decisionMaxTokens: agentDecisionMaxTokens, finalAnswerContentCharLimit })
      ctx.lastAgentPrompt = agentDecision.prompt

      // 处理 assistant_text
      if (agentDecision.action.action === 'assistant_text') {
        emitProgress(ctx.options, {
          id: `thought-${Date.now()}-${ctx.decisionAttempts}`,
          stage: 'thought',
          status: 'completed',
          title: agentDecision.action.content,
          detail: agentDecision.action.content
        })
        ctx.observations.push({ title: 'Agent 输出', detail: agentDecision.action.content })
        continue
      }

      // 处理 final_answer
      if (agentDecision.action.action === 'final_answer') {
        if (evidenceQuality === 'none' && route.intent !== 'direct_answer' && !conclusiveSearchFailure) {
          const hasTriedSummary = ctx.observations.some((i) => i.title === '读取摘要事实')
          const fallbackAction: ToolLoopAction = ctx.summaryFactsRead || hasTriedSummary
            ? { action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: '模型准备回答但仍缺少证据，读取最近上下文兜底' }
            : { action: 'read_summary_facts', reason: '模型准备回答但尚无证据，先检查摘要事实' }
          ctx.observations.push({ title: '延后回答', detail: agentDecision.action.reason || '当前没有证据，继续收集上下文。' })
          agentDecision.action = { action: 'tool_call', tool: fallbackAction }
        } else if (agentDecision.action.content) {
          emitProgress(options, { id: 'answer', stage: 'answer', status: 'running', title: '生成回答', detail: 'Agent 已决定直接回答' })
          ctx.emitVisibleText(agentDecision.action.content)
          emitProgress(options, { id: 'answer', stage: 'answer', status: 'completed', title: '生成回答', detail: '回答生成完成' })
          ctx.logger.lifecycle('Agent 直接回答完成', { ...ctx.getTokenUsage() })
          return { answerText: stripThinkBlocks(ctx.answerText), evidenceRefs: dedupeEvidenceRefs(ctx.evidenceCandidates), toolCalls: ctx.toolCalls, promptText: ctx.lastAgentPrompt, tokenUsage: ctx.getTokenUsage() }
        } else {
          ctx.observations.push({ title: '开始回答', detail: agentDecision.action.reason || 'Agent 判断已有可用证据，进入最终回答。' })
          break
        }
      }

      // 处理 tool_call
      let action: ToolLoopAction = agentDecision.action.action === 'tool_call'
        ? agentDecision.action.tool
        : { action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: 'Agent 动作无效，读取最近上下文兜底' }

      // 预算即将耗尽时强制读取最近消息
      if (evidenceQuality === 'none' && ctx.toolCallsUsed >= MAX_TOOL_CALLS - 1 && action.action !== 'read_latest') {
        action = { action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: '工具预算即将耗尽' }
      }

      // answer 动作的证据检查
      if (action.action === 'answer') {
        if (evidenceQuality === 'none' && !conclusiveSearchFailure) {
          action = ctx.summaryFactsRead
            ? { action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: '摘要事实不足，回答前读取最近上下文' }
            : { action: 'read_summary_facts', reason: '尚无可用证据，先检查摘要事实' }
        } else if (evidenceQuality === 'weak' && ctx.toolCallsUsed < MAX_TOOL_CALLS - 2) {
          const hasSearchedWithNoHits = ctx.searchPayloads.length > 0 && ctx.searchPayloads.every((i) => i.payload.hits.length === 0)
          if (hasSearchedWithNoHits && ctx.searchRetries < MAX_SEARCH_RETRIES) {
            const nextQuery = route.searchQueries.find((q) => !ctx.searchedQueries.has(q.toLowerCase()))
            action = nextQuery
              ? { action: 'search_messages', query: nextQuery, reason: '之前的搜索没有命中，换关键词重试' }
              : { action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: '搜索没有命中且缺少新关键词' }
          } else {
            ctx.observations.push({ title: '开始回答', detail: '证据有限但已尝试多种策略，进入回答生成。' })
            break
          }
        } else {
          ctx.observations.push({ title: '开始回答', detail: action.reason || '已有可用证据，进入回答生成。' })
          break
        }
      }

      // 分发工具执行
      await dispatchToolAction(ctx, action)
    }

    // ── 循环结束后的兜底读取 ──
    if (!ctx.hasEvidence && ctx.toolCallsUsed < MAX_TOOL_CALLS) {
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
    { role: 'system', content: '你是严谨的本地聊天记录问答助手。你必须基于给定上下文回答，并在证据不足时明确承认不足。' },
    { role: 'user', content: promptText }
  ]

  emitProgress(options, { id: 'answer', stage: 'answer', status: 'running', title: '生成回答', detail: '正在基于上下文生成回答' })

  const enableThinking = options.enableThinking !== false
  const thinkFilterState = { isThinking: false }
  await options.provider.streamChat(messages, { model: options.model, temperature: 0.3, maxTokens: agentAnswerMaxTokens, enableThinking }, (chunk) => {
    const visibleChunk = enableThinking ? chunk : filterThinkChunk(chunk, thinkFilterState)
    if (!visibleChunk) return
    ctx.answerText += visibleChunk
    options.onChunk(visibleChunk)
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
