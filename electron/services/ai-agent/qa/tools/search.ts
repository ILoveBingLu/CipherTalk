/**
 * 搜索/检索工具集成
 */
import type { AIProvider } from '../../../ai/providers/base'
import { executeMcpTool } from '../../../mcp/dispatcher'
import { retrievalEngine } from '../../../retrieval/retrievalEngine'
import type { RetrievalEngineResult, RetrievalHit } from '../../../retrieval/retrievalTypes'
import type { McpSearchMessagesPayload, McpSearchHit, McpMessageItem, McpSessionContextPayload } from '../../../mcp/types'
import type { ContextWindow, SessionQAToolCall, QueryRewriteResult } from '../types'
import { MAX_SEARCH_HITS, MAX_CONTEXT_WINDOWS, MAX_CONTEXT_MESSAGES, MAX_REWRITE_INPUT_CHARS, MAX_REWRITE_KEYWORD_QUERIES, MAX_REWRITE_SEMANTIC_QUERIES, MAX_RETRIEVAL_EXPLAIN_TOP_K } from '../types'
import { compactText, stripThinkBlocks, stripJsonFence, uniqueCompactQueries } from '../utils/text'
import { toTimestampMs } from '../utils/time'
import { messageToMcpItem, evidenceRefToMcpItem, dedupeMessagesByCursor } from '../utils/message'
import { normalizeSearchQuery } from '../utils/search'

function normalizeRewriteArray(value: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  return uniqueCompactQueries(value.map((item: unknown) => String(item || '')), limit, maxLength)
}

export async function rewriteRetrievalQuery(
  provider: AIProvider | undefined, model: string | undefined,
  input: { question: string; searchQuery: string; sessionName?: string; senderUsername?: string; startTime?: number; endTime?: number }
): Promise<QueryRewriteResult> {
  if (!provider || !model) {
    return { applied: false, keywordQueries: [], semanticQueries: [], diagnostics: ['query_rewrite: skipped, reason=missing_provider_or_model'] }
  }
  try {
    const question = compactText(input.question, MAX_REWRITE_INPUT_CHARS)
    const response = await provider.chat([
      { role: 'system', content: '你是 CipherTalk 会话问答的检索查询改写器。只输出严格 JSON，不要解释，不要 Markdown。' },
      { role: 'user', content: `请把用户关于单个微信会话的问题改写为更适合混合检索的查询。必须保留人名、时间、地点、产品名、技术名、专有名词；不要编造事实；统计、计数、时间范围类问题不要改写成摘要型问题。输出 JSON 字段：semanticQuery, keywordQueries, semanticQueries, reason。\n\n会话：${input.sessionName || '当前会话'}\n用户原问题：${question}\n当前工具关键词：${input.searchQuery || '无'}\nsenderUsername 过滤：${input.senderUsername || '无'}\n开始时间秒：${input.startTime || '无'}\n结束时间秒：${input.endTime || '无'}\n\n约束：\n- semanticQuery 必须是 1 个适合语义检索的完整短句。\n- keywordQueries 最多 4 个。\n- semanticQueries 最多 3 个。\n- reason 一句话说明改写原因。` }
    ], { model, temperature: 0.1, maxTokens: 500, enableThinking: false })
    const parsed = JSON.parse(stripJsonFence(stripThinkBlocks(response))) as Record<string, unknown>
    const semanticQuery = compactText(String(parsed.semanticQuery || ''), 180)
    const keywordQueries = normalizeRewriteArray(parsed.keywordQueries, MAX_REWRITE_KEYWORD_QUERIES, 48)
    const semanticQueries = normalizeRewriteArray(parsed.semanticQueries, MAX_REWRITE_SEMANTIC_QUERIES, 160)
    const reason = compactText(String(parsed.reason || ''), 160)
    if (!semanticQuery && keywordQueries.length === 0 && semanticQueries.length === 0) {
      return { applied: false, keywordQueries: [], semanticQueries: [], reason, diagnostics: ['query_rewrite: failed, reason=empty_rewrite_result'] }
    }
    return { applied: true, semanticQuery: semanticQuery || semanticQueries[0], keywordQueries, semanticQueries, reason, diagnostics: [`query_rewrite: applied, semanticQuery=${compactText(semanticQuery || semanticQueries[0] || '', 120)}`] }
  } catch (error) {
    return { applied: false, keywordQueries: [], semanticQueries: [], diagnostics: [`query_rewrite: failed, reason=${compactText(String(error), 120)}`] }
  }
}

function retrievalSourceLabel(hit: RetrievalHit): McpSearchHit['retrievalSource'] {
  return hit.sources.includes('message_ann') ? 'vector_index' : 'keyword_index'
}

function retrievalHitToMcpSearchHit(sessionId: string, sessionName: string, hit: RetrievalHit, contactMap?: Map<string, string>): McpSearchHit {
  const expanded = hit.evidence[0]
  const anchor = expanded?.anchor ? messageToMcpItem(sessionId, expanded.anchor, contactMap)
    : expanded?.ref ? evidenceRefToMcpItem(expanded.ref, contactMap)
    : hit.memory.sourceRefs[0] ? evidenceRefToMcpItem(hit.memory.sourceRefs[0], contactMap)
    : { messageId: hit.memory.id, timestamp: Number(hit.memory.timeStart || hit.memory.timeEnd || 0), timestampMs: toTimestampMs(Number(hit.memory.timeStart || hit.memory.timeEnd || 0)), direction: 'in' as const, kind: 'text' as const, text: hit.memory.content, sender: { username: null, displayName: null, isSelf: false }, cursor: { localId: hit.memory.id, createTime: Number(hit.memory.timeStart || hit.memory.timeEnd || 0), sortSeq: hit.memory.id } }
  return { session: { sessionId, displayName: sessionName || sessionId, kind: sessionId.includes('@chatroom') ? 'group' : 'friend' }, message: anchor, excerpt: compactText(hit.memory.content || hit.memory.title, 240), matchedField: 'text', score: Number((hit.score * 1000).toFixed(2)), retrievalSource: retrievalSourceLabel(hit) }
}

function retrievalEvidenceToContextWindow(sessionId: string, query: string, hit: RetrievalHit, contactMap?: Map<string, string>): ContextWindow | null {
  const messages: McpMessageItem[] = []
  let anchor: McpMessageItem | undefined
  for (const evidence of hit.evidence.slice(0, 2)) {
    messages.push(...evidence.before.map((m) => messageToMcpItem(sessionId, m, contactMap)))
    if (evidence.anchor) { const a = messageToMcpItem(sessionId, evidence.anchor, contactMap); anchor = anchor || a; messages.push(a) }
    else { const f = evidenceRefToMcpItem(evidence.ref, contactMap); anchor = anchor || f; messages.push(f) }
    messages.push(...evidence.after.map((m) => messageToMcpItem(sessionId, m, contactMap)))
  }
  const deduped = dedupeMessagesByCursor(messages)
  if (deduped.length === 0) return null
  return { source: 'search', query, label: `${hit.memory.sourceType}:${hit.memory.id}`, anchor, messages: deduped }
}

function buildRetrievalDiagnostics(result: RetrievalEngineResult): string[] {
  const sourceLines = result.sourceStats.map((s) => !s.attempted ? `${s.name}: skipped=${s.skippedReason || 'unknown'}` : `${s.name}: hits=${s.hitCount}${s.error ? `, error=${compactText(s.error, 80)}` : ''}`)
  const rerank = result.rerank.applied ? 'rerank: applied' : result.rerank.attempted ? `rerank: attempted${result.rerank.error ? `, error=${compactText(result.rerank.error, 80)}` : ''}` : `rerank: skipped=${result.rerank.skippedReason || 'unknown'}`
  return [`memory retrieval: hits=${result.hits.length}, latency=${result.latencyMs}ms`, ...sourceLines, rerank]
}

function buildRetrievalExplainDiagnostics(input: { result: RetrievalEngineResult; keywordQueries: string[]; semanticQueries: string[] }): string[] {
  const { result, keywordQueries, semanticQueries } = input
  const topK = MAX_RETRIEVAL_EXPLAIN_TOP_K
  const lines: string[] = [`retrieval_plan: query="${compactText(result.query, 80)}" keywords=[${keywordQueries.slice(0, 4).map(q => `"${compactText(q, 48)}"`).join(',')}]`]
  for (const hit of result.hits.slice(0, topK)) {
    const m = hit.memory; const preview = compactText(m.title || m.content || '', 120)
    lines.push(`top${hit.rank}: ${m.sourceType}#${m.id} score=${hit.score.toFixed(4)} text="${preview}"`)
  }
  return lines
}

function retrievalResultToSearchPayload(sessionId: string, sessionName: string, result: RetrievalEngineResult, limit: number, contactMap?: Map<string, string>): McpSearchMessagesPayload {
  const hits = result.hits.slice(0, limit).map((h) => retrievalHitToMcpSearchHit(sessionId, sessionName, h, contactMap))
  const vectorStat = result.sourceStats.find((s) => s.name === 'message_ann')
  return {
    hits, limit, sessionsScanned: 1, messagesScanned: result.hits.length, truncated: result.hits.length > limit, source: 'index',
    vectorSearch: { requested: true, attempted: Boolean(vectorStat?.attempted), providerAvailable: vectorStat?.skippedReason !== 'vector_provider_unavailable', indexComplete: vectorStat?.skippedReason !== 'vector_index_incomplete', hitCount: vectorStat?.hitCount || 0, indexedMessages: result.hits.length, vectorizedMessages: vectorStat?.hitCount || 0, skippedReason: vectorStat && !vectorStat.attempted ? vectorStat.skippedReason : undefined, error: vectorStat?.error },
    rerank: { requested: true, attempted: result.rerank.attempted, enabled: result.rerank.skippedReason !== 'config_disabled' && result.rerank.skippedReason !== 'disabled', modelAvailable: !result.rerank.error, candidateCount: result.hits.length, rerankedCount: result.rerank.applied ? result.hits.length : 0, skippedReason: result.rerank.skippedReason, error: result.rerank.error },
    sessionSummaries: [{ session: { sessionId, displayName: sessionName || sessionId, kind: sessionId.includes('@chatroom') ? 'group' : 'friend' }, hitCount: hits.length, topScore: hits[0]?.score || 0, sampleExcerpts: hits.slice(0, 3).map((h) => h.excerpt) }]
  }
}

export async function searchSessionMessages(sessionId: string, query: string, filters: {
  provider?: AIProvider; model?: string; originalQuestion?: string; semanticQuery?: string; senderUsername?: string; startTime?: number; endTime?: number; limit?: number; sessionName?: string; contactMap?: Map<string, string>
} = {}): Promise<{ payload?: McpSearchMessagesPayload; toolCall?: SessionQAToolCall; contextWindows?: ContextWindow[]; diagnostics?: string[] }> {
  const retrievalQuery = filters.originalQuestion || query
  const rewrite = await rewriteRetrievalQuery(filters.provider, filters.model, { question: retrievalQuery, searchQuery: query, sessionName: filters.sessionName || sessionId, senderUsername: filters.senderUsername, startTime: filters.startTime, endTime: filters.endTime })
  const fallbackSemanticQuery = filters.semanticQuery || `${query} ${retrievalQuery}`.trim()
  const semanticQuery = rewrite.semanticQuery || fallbackSemanticQuery
  const keywordQueries = uniqueCompactQueries([query, retrievalQuery, ...rewrite.keywordQueries], MAX_REWRITE_KEYWORD_QUERIES + 2, 80)
  const semanticQueries = uniqueCompactQueries([semanticQuery, fallbackSemanticQuery, ...rewrite.semanticQueries], MAX_REWRITE_SEMANTIC_QUERIES + 2, 180)
  try {
    const retrieval = await retrievalEngine.search({ sessionId, query: retrievalQuery, semanticQuery, keywordQueries, semanticQueries, startTimeMs: filters.startTime ? filters.startTime * 1000 : undefined, endTimeMs: filters.endTime ? filters.endTime * 1000 : undefined, senderUsername: filters.senderUsername, limit: filters.limit || MAX_SEARCH_HITS, rerank: true, expandEvidence: true })
    const payload = retrievalResultToSearchPayload(sessionId, filters.sessionName || sessionId, retrieval, filters.limit || MAX_SEARCH_HITS, filters.contactMap)
    const contextWindows = retrieval.hits.slice(0, MAX_CONTEXT_WINDOWS).map((h) => retrievalEvidenceToContextWindow(sessionId, query, h, filters.contactMap)).filter((w): w is ContextWindow => Boolean(w))
    const diagnostics = [...rewrite.diagnostics, ...buildRetrievalDiagnostics(retrieval), ...buildRetrievalExplainDiagnostics({ result: retrieval, keywordQueries, semanticQueries })]
    return { payload, contextWindows, diagnostics, toolCall: { toolName: 'search_messages', args: { sessionId, query, retrievalEngine: 'memory_hybrid', queryRewrite: rewrite.applied ? 'applied' : 'fallback', limit: filters.limit || MAX_SEARCH_HITS }, summary: `新记忆检索命中 ${payload.hits.length} 条`, status: 'completed', evidenceCount: payload.hits.length } }
  } catch (error) {
    console.warn('[SessionQAAgent] 新记忆检索失败，回退旧 search_messages:', error)
  }
  const args = { sessionId, query, ...(filters.semanticQuery ? { semanticQuery: filters.semanticQuery } : {}), limit: filters.limit || MAX_SEARCH_HITS, matchMode: 'substring', includeRaw: false, rerank: true, ...(filters.senderUsername ? { senderUsername: filters.senderUsername } : {}), ...(filters.startTime ? { startTime: filters.startTime } : {}), ...(filters.endTime ? { endTime: filters.endTime } : {}) }
  const result = await executeMcpTool('search_messages', args)
  return { payload: result.payload as McpSearchMessagesPayload, diagnostics: rewrite.diagnostics, toolCall: { toolName: 'search_messages', args, summary: result.summary, status: 'completed', evidenceCount: ((result.payload as McpSearchMessagesPayload)?.hits || []).length } }
}

export async function loadLatestContext(sessionId: string, limit = MAX_CONTEXT_MESSAGES): Promise<{ payload?: McpSessionContextPayload; toolCall?: SessionQAToolCall }> {
  const args = { sessionId, mode: 'latest', beforeLimit: limit, includeRaw: false }
  const result = await executeMcpTool('get_session_context', args)
  return { payload: result.payload as McpSessionContextPayload, toolCall: { toolName: 'read_latest', args, summary: result.summary } }
}

export async function loadContextAroundMessage(sessionId: string, message: McpMessageItem, beforeLimit: number, afterLimit: number): Promise<{ payload?: McpSessionContextPayload; toolCall?: SessionQAToolCall }> {
  const args = { sessionId, mode: 'around', anchorCursor: message.cursor, beforeLimit, afterLimit, includeRaw: false }
  const result = await executeMcpTool('get_session_context', args)
  return { payload: result.payload as McpSessionContextPayload, toolCall: { toolName: 'read_context', args, summary: result.summary } }
}
