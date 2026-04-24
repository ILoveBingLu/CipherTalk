import type OpenAI from 'openai'
import type { AIProvider } from '../../ai/providers/base'
import { executeMcpTool } from '../../mcp/dispatcher'
import type {
  McpContactsPayload,
  McpCursor,
  McpMessageItem,
  McpMessagesPayload,
  McpSearchMessagesPayload,
  McpSessionContextPayload
} from '../../mcp/types'
import { chatSearchIndexService } from '../../search/chatSearchIndexService'
import type { StructuredAnalysis, SummaryEvidenceRef } from '../types/analysis'

export interface SessionQAHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface SessionQAToolCall {
  toolName: SessionQAToolName
  args: Record<string, unknown>
  summary: string
}

export type SessionQAToolName =
  | 'read_summary_facts'
  | 'read_latest'
  | 'read_by_time_range'
  | 'resolve_participant'
  | 'search_messages'
  | 'read_context'
  | 'aggregate_messages'
  | 'answer'
  | 'get_session_context'

export type SessionQAProgressStage = 'intent' | 'tool' | 'context' | 'answer'
export type SessionQAProgressStatus = 'running' | 'completed' | 'failed'

export interface SessionQAProgressEvent {
  id: string
  stage: SessionQAProgressStage
  status: SessionQAProgressStatus
  title: string
  detail?: string
  toolName?: SessionQAToolCall['toolName']
  query?: string
  count?: number
  createdAt: number
}

export interface SessionQAAgentOptions {
  sessionId: string
  sessionName?: string
  question: string
  summaryText?: string
  structuredAnalysis?: StructuredAnalysis
  history?: SessionQAHistoryMessage[]
  provider: AIProvider
  model: string
  enableThinking?: boolean
  onChunk: (chunk: string) => void
  onProgress?: (event: SessionQAProgressEvent) => void
}

export interface SessionQAAgentResult {
  answerText: string
  evidenceRefs: SummaryEvidenceRef[]
  toolCalls: SessionQAToolCall[]
  promptText: string
}

const MAX_CONTEXT_MESSAGES = 40
const MAX_SEARCH_QUERIES = 6
const MAX_SEARCH_HITS = 8
const MAX_CONTEXT_WINDOWS = 4
const SEARCH_CONTEXT_BEFORE = 6
const SEARCH_CONTEXT_AFTER = 6
const MAX_TOOL_CALLS = 6
const MAX_TOOL_DECISION_ATTEMPTS = 10
const MAX_HISTORY_MESSAGES = 8
const MAX_SUMMARY_CHARS = 3000
const MAX_STRUCTURED_CHARS = 4000
const MAX_MESSAGE_TEXT = 220

type SearchPayloadWithQuery = { query: string; payload: McpSearchMessagesPayload }
type SearchHitWithQuery = McpSearchMessagesPayload['hits'][number] & { query: string }
type KnownSearchHit = SearchHitWithQuery & { hitId: string }
type ContextWindow = {
  source: 'search' | 'latest' | 'time_range'
  query?: string
  label?: string
  anchor?: McpMessageItem
  messages: McpMessageItem[]
}
type ToolObservation = {
  title: string
  detail: string
}
type SessionQAIntentType =
  | 'summary_answerable'
  | 'recent_status'
  | 'time_range'
  | 'participant_focus'
  | 'exact_evidence'
  | 'broad_summary'
  | 'stats_or_count'
  | 'unclear'
type TimeRangeHint = {
  startTime?: number
  endTime?: number
  label?: string
}
type ParticipantResolution = {
  query: string
  senderUsername?: string
  displayName?: string
  confidence: 'high' | 'medium' | 'low'
  source: 'observed' | 'contacts' | 'fallback'
}
type IntentRoute = {
  intent: SessionQAIntentType
  confidence: 'high' | 'medium' | 'low'
  reason?: string
  timeRange?: TimeRangeHint
  participantHints: string[]
  searchQueries: string[]
  needsSearch: boolean
  preferredPlan: ToolLoopAction['action'][]
}
type ToolLoopAction =
  | { action: 'read_summary_facts'; reason?: string }
  | { action: 'search_messages'; query: string; reason?: string }
  | { action: 'read_context'; hitId?: string; cursor?: McpCursor; beforeLimit?: number; afterLimit?: number; reason?: string }
  | { action: 'read_latest'; limit?: number; reason?: string }
  | { action: 'read_by_time_range'; startTime?: number; endTime?: number; label?: string; limit?: number; keyword?: string; senderUsername?: string; participantName?: string; reason?: string }
  | { action: 'resolve_participant'; name?: string; reason?: string }
  | { action: 'aggregate_messages'; metric?: 'speaker_count' | 'message_count' | 'kind_count' | 'timeline' | 'summary'; reason?: string }
  | { action: 'answer'; reason?: string }

function compactText(value?: string, limit = MAX_MESSAGE_TEXT): string {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return ''
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}

function buildProgressEvent(
  event: Omit<SessionQAProgressEvent, 'createdAt'>
): SessionQAProgressEvent {
  return {
    ...event,
    createdAt: Date.now()
  }
}

function emitProgress(
  options: SessionQAAgentOptions,
  event: Omit<SessionQAProgressEvent, 'createdAt'>
) {
  options.onProgress?.(buildProgressEvent(event))
}

function filterThinkChunk(chunk: string, state: { isThinking: boolean }): string {
  let remaining = chunk
  let visible = ''

  while (remaining.length > 0) {
    if (state.isThinking) {
      const closeIndex = remaining.indexOf('</think>')
      if (closeIndex < 0) {
        break
      }

      state.isThinking = false
      remaining = remaining.slice(closeIndex + '</think>'.length)
      continue
    }

    const openIndex = remaining.indexOf('<think>')
    if (openIndex < 0) {
      visible += remaining
      break
    }

    visible += remaining.slice(0, openIndex)
    state.isThinking = true
    remaining = remaining.slice(openIndex + '<think>'.length)
  }

  return visible
}

function stripThinkBlocks(value: string): string {
  return value.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

function stripJsonFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

function formatTime(timestampMs: number): string {
  if (!timestampMs) return 'unknown'
  const date = new Date(timestampMs)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}

function describeSender(message: McpMessageItem): string {
  if (message.sender.isSelf) return '我'
  return message.sender.displayName || message.sender.username || '对方'
}

function formatMessageLine(message: McpMessageItem): string {
  const text = compactText(message.text, MAX_MESSAGE_TEXT) || `[${message.kind}]`
  return `- ${formatTime(message.timestampMs)} | ${describeSender(message)} | ${text}`
}

function toEvidenceRef(sessionId: string, message: McpMessageItem, preview?: string): SummaryEvidenceRef | null {
  if (!message.cursor) return null

  return {
    sessionId,
    localId: message.cursor.localId,
    createTime: message.cursor.createTime,
    sortSeq: message.cursor.sortSeq,
    senderUsername: message.sender.username || undefined,
    senderDisplayName: describeSender(message),
    previewText: compactText(preview || message.text, 180) || `[${message.kind}]`
  }
}

function dedupeEvidenceRefs(items: SummaryEvidenceRef[]): SummaryEvidenceRef[] {
  const seen = new Set<string>()
  const result: SummaryEvidenceRef[] = []

  for (const item of items) {
    const key = `${item.localId}:${item.createTime}:${item.sortSeq}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
    if (result.length >= 8) break
  }

  return result
}

function getMessageCursorKey(message: McpMessageItem): string {
  return `${message.cursor.localId}:${message.cursor.createTime}:${message.cursor.sortSeq}`
}

function dedupeMessagesByCursor(messages: McpMessageItem[]): McpMessageItem[] {
  const seen = new Set<string>()
  const result: McpMessageItem[] = []

  for (const message of messages) {
    const key = getMessageCursorKey(message)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(message)
  }

  return result.sort((a, b) => {
    if (a.cursor.sortSeq !== b.cursor.sortSeq) return a.cursor.sortSeq - b.cursor.sortSeq
    if (a.cursor.createTime !== b.cursor.createTime) return a.cursor.createTime - b.cursor.createTime
    return a.cursor.localId - b.cursor.localId
  })
}

function dedupeSearchHits(hits: SearchHitWithQuery[]): SearchHitWithQuery[] {
  const seen = new Set<string>()
  const result: SearchHitWithQuery[] = []

  for (const hit of hits) {
    const key = getMessageCursorKey(hit.message)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(hit)
  }

  return result.sort((a, b) => b.score - a.score || b.message.timestampMs - a.message.timestampMs)
}

function normalizeSearchQuery(value: string, limit = 32): string {
  return compactText(value, limit)
    .replace(/[？?！!。，,；;：:"“”‘’()（）【】\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isGenericSearchQuery(value: string): boolean {
  const normalized = normalizeSearchQuery(value).replace(/\s+/g, '')
  if (!normalized) return true
  return /^(什么|哪个|哪些|什么时候|为什么|怎么|如何|最近|刚刚|刚才|我们|他们|对方|是否|有没有|是不是|可以|看到|知道|消息|聊天|内容|问题|回复|回答)$/.test(normalized)
}

function expandSearchQueries(question: string, modelQueries: string[]): string[] {
  const candidates: string[] = []
  const push = (value: string) => {
    const query = normalizeSearchQuery(value)
    if (!query || isGenericSearchQuery(query)) return
    candidates.push(query)
  }

  for (const query of modelQueries) {
    push(query)
    const compact = query.replace(/\s+/g, '')
    if (/[\u4e00-\u9fa5]/.test(compact) && compact.length >= 4) {
      push(compact.slice(-2))
      push(compact.slice(-3))
    }
  }

  for (const query of extractHeuristicQueries(question)) {
    push(query)
    const compact = query.replace(/\s+/g, '')
    if (/[\u4e00-\u9fa5]/.test(compact) && compact.length >= 4) {
      push(compact.slice(-2))
      push(compact.slice(-3))
    }
  }

  const seen = new Set<string>()
  const unique: string[] = []
  for (const query of candidates) {
    const normalized = query.toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    unique.push(query)
    if (unique.length >= MAX_SEARCH_QUERIES) break
  }

  return unique
}

function shouldUseRecentFallback(question: string): boolean {
  return /(最近|刚刚|刚才|今天|昨天|前面|上面|最后|最新|刚聊|recent|latest)/i.test(question)
}

function extractHeuristicQueries(question: string): string[] {
  const normalized = question
    .replace(/[？?！!。，,；;：:"“”‘’()（）【】\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const words = normalized
    .split(' ')
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .filter((item) => !/^(什么|哪个|哪些|什么时候|为什么|怎么|如何|最近|我们|他们|对方|是否|有没有|是不是)$/.test(item))

  if (words.length > 0) {
    return words.slice(0, MAX_SEARCH_QUERIES)
  }

  const compact = normalized.replace(/\s+/g, '')
  if (compact.length >= 4) {
    return [compact.slice(0, Math.min(8, compact.length))]
  }

  return []
}

async function proposeSearchQueries(
  provider: AIProvider,
  model: string,
  question: string
): Promise<string[]> {
  const fallback = extractHeuristicQueries(question)

  try {
    const response = await provider.chat([
      {
        role: 'system',
        content: '你负责把用户关于单个聊天会话的问题改写为少量中文消息检索关键词。只输出 JSON。'
      },
      {
        role: 'user',
        content: `从下面问题中提取 0 到 3 个适合在微信聊天记录里做 substring 检索的关键词。不要输出泛词、人称代词或完整问句。\n\n问题：${question}\n\nJSON 格式：{"queries":["关键词1","关键词2"]}`
      }
    ], {
      model,
      temperature: 0.1,
      maxTokens: 180,
      enableThinking: false
    })

    const parsed = JSON.parse(stripJsonFence(response)) as { queries?: unknown }
    if (!Array.isArray(parsed.queries)) return fallback

    const queries = parsed.queries
      .map((item) => compactText(String(item || ''), 24))
      .filter((item) => item.length >= 2)
      .filter((item, index, array) => array.indexOf(item) === index)
      .slice(0, MAX_SEARCH_QUERIES)

    return queries.length > 0 ? queries : fallback
  } catch {
    return fallback
  }
}

function toUnixSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000)
}

function startOfDay(date: Date): Date {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

function endOfDay(date: Date): Date {
  const next = new Date(date)
  next.setHours(23, 59, 59, 999)
  return next
}

function shiftDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function applyDayPart(range: TimeRangeHint, question: string): TimeRangeHint {
  if (!range.startTime || !range.endTime) return range
  const start = new Date(range.startTime * 1000)
  const end = new Date(range.startTime * 1000)
  let matched = false

  if (/(凌晨|半夜)/.test(question)) {
    start.setHours(0, 0, 0, 0)
    end.setHours(5, 59, 59, 999)
    matched = true
  } else if (/早上|上午/.test(question)) {
    start.setHours(6, 0, 0, 0)
    end.setHours(11, 59, 59, 999)
    matched = true
  } else if (/中午/.test(question)) {
    start.setHours(11, 0, 0, 0)
    end.setHours(13, 59, 59, 999)
    matched = true
  } else if (/下午/.test(question)) {
    start.setHours(12, 0, 0, 0)
    end.setHours(17, 59, 59, 999)
    matched = true
  } else if (/晚上|夜里/.test(question)) {
    start.setHours(18, 0, 0, 0)
    end.setHours(23, 59, 59, 999)
    matched = true
  }

  if (!matched) return range
  return {
    ...range,
    startTime: toUnixSeconds(start),
    endTime: toUnixSeconds(end),
    label: `${range.label || '指定日期'}${question.match(/凌晨|半夜|早上|上午|中午|下午|晚上|夜里/)?.[0] || ''}`
  }
}

function inferTimeRangeFromQuestion(question: string, now = new Date()): TimeRangeHint | undefined {
  const normalized = question.replace(/\s+/g, '')
  let range: TimeRangeHint | undefined

  if (/前天/.test(normalized)) {
    const date = shiftDays(now, -2)
    range = { startTime: toUnixSeconds(startOfDay(date)), endTime: toUnixSeconds(endOfDay(date)), label: '前天' }
  } else if (/昨天|昨日/.test(normalized)) {
    const date = shiftDays(now, -1)
    range = { startTime: toUnixSeconds(startOfDay(date)), endTime: toUnixSeconds(endOfDay(date)), label: '昨天' }
  } else if (/今天|今日/.test(normalized)) {
    range = { startTime: toUnixSeconds(startOfDay(now)), endTime: toUnixSeconds(endOfDay(now)), label: '今天' }
  } else if (/上周/.test(normalized)) {
    const day = now.getDay() || 7
    const thisMonday = shiftDays(startOfDay(now), 1 - day)
    const lastMonday = shiftDays(thisMonday, -7)
    const lastSunday = shiftDays(lastMonday, 6)
    range = { startTime: toUnixSeconds(lastMonday), endTime: toUnixSeconds(endOfDay(lastSunday)), label: '上周' }
  } else if (/本周|这周/.test(normalized)) {
    const day = now.getDay() || 7
    const thisMonday = shiftDays(startOfDay(now), 1 - day)
    range = { startTime: toUnixSeconds(thisMonday), endTime: toUnixSeconds(endOfDay(now)), label: '本周' }
  } else if (/上个月|上月/.test(normalized)) {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)
    range = { startTime: toUnixSeconds(start), endTime: toUnixSeconds(end), label: '上个月' }
  } else if (/这个月|本月/.test(normalized)) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    range = { startTime: toUnixSeconds(start), endTime: toUnixSeconds(endOfDay(now)), label: '本月' }
  }

  const dateMatch = normalized.match(/(\d{1,2})[月/-](\d{1,2})[日号]?/)
  if (!range && dateMatch) {
    const month = Number(dateMatch[1])
    const day = Number(dateMatch[2])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const date = new Date(now.getFullYear(), month - 1, day)
      range = { startTime: toUnixSeconds(startOfDay(date)), endTime: toUnixSeconds(endOfDay(date)), label: `${month}月${day}日` }
    }
  }

  return range ? applyDayPart(range, question) : undefined
}

function normalizeIntentType(value: unknown): SessionQAIntentType {
  const intent = String(value || '').trim()
  const allowed: SessionQAIntentType[] = [
    'summary_answerable',
    'recent_status',
    'time_range',
    'participant_focus',
    'exact_evidence',
    'broad_summary',
    'stats_or_count',
    'unclear'
  ]
  return allowed.includes(intent as SessionQAIntentType) ? intent as SessionQAIntentType : 'unclear'
}

function normalizeConfidence(value: unknown): 'high' | 'medium' | 'low' {
  const confidence = String(value || '').trim()
  return confidence === 'high' || confidence === 'medium' || confidence === 'low' ? confidence : 'medium'
}

function normalizeStringArray(value: unknown, limit = 4): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    const text = compactText(String(item || ''), 48)
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(text)
    if (result.length >= limit) break
  }
  return result
}

function normalizeTimeRangeHint(value: unknown, fallback?: TimeRangeHint): TimeRangeHint | undefined {
  if (!isRecord(value)) return fallback
  const startTime = Number(value.startTime ?? value.start_time)
  const endTime = Number(value.endTime ?? value.end_time)
  const label = compactText(String(value.label || ''), 40) || fallback?.label
  return {
    startTime: Number.isFinite(startTime) && startTime > 0 ? Math.floor(startTime) : fallback?.startTime,
    endTime: Number.isFinite(endTime) && endTime > 0 ? Math.floor(endTime) : fallback?.endTime,
    label
  }
}

function buildDefaultPreferredPlan(intent: SessionQAIntentType): ToolLoopAction['action'][] {
  switch (intent) {
    case 'summary_answerable':
      return ['read_summary_facts', 'answer']
    case 'recent_status':
      return ['read_latest', 'answer']
    case 'time_range':
      return ['read_by_time_range', 'aggregate_messages', 'answer']
    case 'participant_focus':
      return ['resolve_participant', 'read_by_time_range', 'answer']
    case 'exact_evidence':
      return ['search_messages', 'read_context', 'answer']
    case 'broad_summary':
      return ['read_summary_facts', 'read_latest', 'answer']
    case 'stats_or_count':
      return ['read_by_time_range', 'aggregate_messages', 'answer']
    default:
      return ['read_summary_facts', 'read_latest', 'answer']
  }
}

function routeFromHeuristics(question: string, summaryText?: string): IntentRoute {
  const timeRange = inferTimeRangeFromQuestion(question)
  const hasSummary = Boolean(stripThinkBlocks(summaryText || '').trim())
  const queries = expandSearchQueries(question, extractHeuristicQueries(question))
  const participantHints = extractHeuristicQueries(question)
    .filter((item) => item.length >= 2 && item.length <= 12)
    .slice(0, 2)

  let intent: SessionQAIntentType = 'unclear'
  if (/(谁.*(最多|最少|发言|说话|次数)|多少条|几条|统计|次数|频率|排行)/.test(question)) {
    intent = 'stats_or_count'
  } else if (/(最近|刚刚|刚才|最新|现在|当前|前面|上面|最后)/.test(question)) {
    intent = 'recent_status'
  } else if (timeRange) {
    intent = 'time_range'
  } else if (/(总结|概括|关系|变化|趋势|梳理|复盘)/.test(question)) {
    intent = hasSummary ? 'summary_answerable' : 'broad_summary'
  } else if (/(有没有|是否|说过|提到|原文|哪条|文件|链接|图片|语音|React|Markdown|http|www\.)/i.test(question)) {
    intent = 'exact_evidence'
  } else if (/(谁|哪个人|他说|她说|发了什么|说了什么)/.test(question)) {
    intent = 'participant_focus'
  } else if (hasSummary) {
    intent = 'summary_answerable'
  }

  return {
    intent,
    confidence: 'medium',
    reason: '本地启发式路由',
    timeRange,
    participantHints,
    searchQueries: queries,
    needsSearch: intent === 'exact_evidence',
    preferredPlan: buildDefaultPreferredPlan(intent)
  }
}

async function routeQuestionIntent(
  provider: AIProvider,
  model: string,
  input: {
    question: string
    sessionName: string
    summaryText?: string
    structuredContext?: string
    historyText: string
  }
): Promise<IntentRoute> {
  const fallback = routeFromHeuristics(input.question, input.summaryText)
  const currentDate = formatTime(Date.now())

  try {
    const response = await provider.chat([
      {
        role: 'system',
        content: '你是 CipherTalk 问答 Agent 的意图路由器。只输出严格 JSON，不要解释。'
      },
      {
        role: 'user',
        content: `请把用户关于单个微信会话的问题路由到最合适的数据工具路线。

当前时间：${currentDate}
会话：${input.sessionName}
问题：${input.question}
多轮上下文：${input.historyText || '无'}
是否有当前摘要：${stripThinkBlocks(input.summaryText || '').trim() ? '有' : '无'}
结构化摘要预览：${compactText(input.structuredContext || '', 1200) || '无'}

可选 intent：
summary_answerable, recent_status, time_range, participant_focus, exact_evidence, broad_summary, stats_or_count, unclear

输出 JSON：
{
  "intent":"recent_status",
  "confidence":"high|medium|low",
  "reason":"一句话原因",
  "timeRange":{"startTime":秒级时间戳,"endTime":秒级时间戳,"label":"昨天晚上"},
  "participantHints":["张三"],
  "searchQueries":["关键词"],
  "needsSearch":false,
  "preferredPlan":["read_latest","answer"]
}`
      }
    ], {
      model,
      temperature: 0.1,
      maxTokens: 420,
      enableThinking: false
    })

    const parsed = JSON.parse(stripJsonFence(stripThinkBlocks(response))) as Record<string, unknown>
    const intent = normalizeIntentType(parsed.intent)
    const timeRange = normalizeTimeRangeHint(parsed.timeRange, fallback.timeRange)
    const preferredPlan = normalizeStringArray(parsed.preferredPlan, 6)
      .map((item) => item as ToolLoopAction['action'])
      .filter((item) => [
        'read_summary_facts',
        'read_latest',
        'read_by_time_range',
        'resolve_participant',
        'search_messages',
        'read_context',
        'aggregate_messages',
        'answer'
      ].includes(item))

    return {
      intent,
      confidence: normalizeConfidence(parsed.confidence),
      reason: compactText(String(parsed.reason || fallback.reason || ''), 160),
      timeRange,
      participantHints: normalizeStringArray(parsed.participantHints, 4).concat(fallback.participantHints).slice(0, 4),
      searchQueries: normalizeStringArray(parsed.searchQueries, 4).concat(fallback.searchQueries).slice(0, MAX_SEARCH_QUERIES),
      needsSearch: typeof parsed.needsSearch === 'boolean' ? parsed.needsSearch : fallback.needsSearch,
      preferredPlan: preferredPlan.length > 0 ? preferredPlan : buildDefaultPreferredPlan(intent)
    }
  } catch {
    return fallback
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clampToolLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(Math.floor(parsed), max))
}

function normalizeToolAction(raw: unknown): ToolLoopAction | null {
  if (!isRecord(raw)) return null

  const actionName = String(raw.action || raw.tool || '').trim()
  const reason = compactText(String(raw.reason || ''), 120) || undefined

  if (actionName === 'read_summary_facts') {
    return { action: 'read_summary_facts', reason }
  }

  if (actionName === 'search_messages') {
    const query = normalizeSearchQuery(String(raw.query || raw.keyword || ''), 48)
    if (!query) return null
    return { action: 'search_messages', query, reason }
  }

  if (actionName === 'read_context') {
    const cursor = isRecord(raw.cursor)
      ? {
        localId: Number(raw.cursor.localId || 0),
        createTime: Number(raw.cursor.createTime || 0),
        sortSeq: Number(raw.cursor.sortSeq || 0)
      }
      : undefined

    return {
      action: 'read_context',
      hitId: compactText(String(raw.hitId || raw.hit_id || ''), 16) || undefined,
      cursor: cursor && cursor.localId && cursor.createTime ? cursor : undefined,
      beforeLimit: clampToolLimit(raw.beforeLimit ?? raw.before_limit, SEARCH_CONTEXT_BEFORE, 12),
      afterLimit: clampToolLimit(raw.afterLimit ?? raw.after_limit, SEARCH_CONTEXT_AFTER, 12),
      reason
    }
  }

  if (actionName === 'read_latest') {
    return {
      action: 'read_latest',
      limit: clampToolLimit(raw.limit, MAX_CONTEXT_MESSAGES, MAX_CONTEXT_MESSAGES),
      reason
    }
  }

  if (actionName === 'read_by_time_range') {
    const startTime = Number(raw.startTime ?? raw.start_time)
    const endTime = Number(raw.endTime ?? raw.end_time)
    return {
      action: 'read_by_time_range',
      startTime: Number.isFinite(startTime) && startTime > 0 ? Math.floor(startTime) : undefined,
      endTime: Number.isFinite(endTime) && endTime > 0 ? Math.floor(endTime) : undefined,
      label: compactText(String(raw.label || ''), 40) || undefined,
      limit: clampToolLimit(raw.limit, MAX_CONTEXT_MESSAGES, 100),
      keyword: normalizeSearchQuery(String(raw.keyword || ''), 48) || undefined,
      senderUsername: compactText(String(raw.senderUsername || raw.sender_username || ''), 80) || undefined,
      participantName: compactText(String(raw.participantName || raw.participant_name || raw.name || ''), 48) || undefined,
      reason
    }
  }

  if (actionName === 'resolve_participant') {
    return {
      action: 'resolve_participant',
      name: compactText(String(raw.name || raw.query || raw.participantName || raw.participant_name || ''), 48) || undefined,
      reason
    }
  }

  if (actionName === 'aggregate_messages') {
    const metric = String(raw.metric || '').trim()
    return {
      action: 'aggregate_messages',
      metric: ['speaker_count', 'message_count', 'kind_count', 'timeline', 'summary'].includes(metric)
        ? metric as Extract<ToolLoopAction, { action: 'aggregate_messages' }>['metric']
        : 'summary',
      reason
    }
  }

  if (actionName === 'answer') {
    return { action: 'answer', reason }
  }

  return null
}

function parseToolLoopAction(value: string): ToolLoopAction | null {
  try {
    const parsed = JSON.parse(stripJsonFence(stripThinkBlocks(value)))
    return normalizeToolAction(parsed)
  } catch {
    return null
  }
}

function formatCursor(cursor: McpCursor): string {
  return `{"localId":${cursor.localId},"createTime":${cursor.createTime},"sortSeq":${cursor.sortSeq}}`
}

function formatKnownHit(hit: KnownSearchHit): string {
  return `${hit.hitId} | ${formatMessageLine(hit.message)} | score=${Math.round(hit.score)} | cursor=${formatCursor(hit.message.cursor)}`
}

function buildObservationText(observations: ToolObservation[]): string {
  if (observations.length === 0) return '暂无工具观察。'

  return observations
    .slice(-10)
    .map((item, index) => `${index + 1}. ${item.title}\n${item.detail}`)
    .join('\n\n')
}

function buildKnownHitsText(hits: KnownSearchHit[]): string {
  if (hits.length === 0) return '暂无命中。'
  return hits.slice(0, 16).map(formatKnownHit).join('\n')
}

function buildToolDecisionPrompt(input: {
  sessionName: string
  question: string
  route: IntentRoute
  summaryText?: string
  structuredContext?: string
  historyText: string
  observations: ToolObservation[]
  knownHits: KnownSearchHit[]
  resolvedParticipants: ParticipantResolution[]
  aggregateText?: string
  summaryFactsRead: boolean
  toolCallsUsed: number
}): string {
  return `你是 CipherTalk 的本地聊天记录问答 Agent。你需要决定下一步工具动作，不能直接编造事实。

会话：${input.sessionName}

用户问题：
${input.question}

多轮上下文：
${input.historyText || '无'}

当前摘要：
${compactText(stripThinkBlocks(input.summaryText || ''), MAX_SUMMARY_CHARS) || '无'}

结构化摘要 JSON：
${input.structuredContext || '无'}

意图路由：
intent=${input.route.intent}, confidence=${input.route.confidence}, reason=${input.route.reason || '无'}
preferredPlan=${input.route.preferredPlan.join(' -> ')}
timeRange=${input.route.timeRange?.label || '无'} ${input.route.timeRange?.startTime || ''}-${input.route.timeRange?.endTime || ''}
participantHints=${input.route.participantHints.join('、') || '无'}
searchQueries=${input.route.searchQueries.join('、') || '无'}

已解析参与者：
${input.resolvedParticipants.length > 0
    ? input.resolvedParticipants.map((item) => `${item.displayName || item.query} => ${item.senderUsername || '未解析'} (${item.confidence})`).join('\n')
    : '无'}

已读摘要事实：${input.summaryFactsRead ? '是' : '否'}
聚合结果：
${input.aggregateText || '无'}

已知搜索命中：
${buildKnownHitsText(input.knownHits)}

工具观察：
${buildObservationText(input.observations)}

工具预算：已使用 ${input.toolCallsUsed}/${MAX_TOOL_CALLS} 次。只允许以下动作：
1. {"action":"read_summary_facts","reason":"先用摘要/结构化事实判断"}
2. {"action":"read_latest","limit":40,"reason":"读取最近消息"}
3. {"action":"read_by_time_range","startTime":秒级时间戳,"endTime":秒级时间戳,"label":"昨天晚上","limit":80,"participantName":"张三","reason":"按时间读取"}
4. {"action":"resolve_participant","name":"张三","reason":"解析昵称/备注到 senderUsername"}
5. {"action":"search_messages","query":"关键词或短语","reason":"只在需要精确证据时搜索"}
6. {"action":"read_context","hitId":"h1","reason":"读取命中前后文"}
7. {"action":"aggregate_messages","metric":"speaker_count|message_count|kind_count|timeline|summary","reason":"整理统计/趋势"}
8. {"action":"answer","reason":"证据足够或预算即将耗尽"}

决策规则：
- 摘要可答时优先 read_summary_facts，然后 answer，不要搜索。
- 最近/刚刚/当前进展类问题优先 read_latest，不要先搜索。
- 时间类问题优先 read_by_time_range。
- 人物类问题先 resolve_participant，再按 sender 或时间读取。
- 只有原话、具体事项、文件、链接、是否提到某词时才 search_messages。
- 搜索命中后再 read_context；搜索 0 命中时才改写关键词继续搜。
- 统计类问题需要 aggregate_messages 后再 answer。
- 没有任何摘要事实、上下文、聚合结果或搜索命中前，不要 answer。
- 只输出一个 JSON 对象，不要 Markdown，不要解释。`
}

async function chooseNextToolAction(
  provider: AIProvider,
  model: string,
  input: Parameters<typeof buildToolDecisionPrompt>[0]
): Promise<ToolLoopAction> {
  try {
    const response = await provider.chat([
      {
        role: 'system',
        content: '你只输出一个严格 JSON 对象，用于选择本地聊天记录问答工具。'
      },
      {
        role: 'user',
        content: buildToolDecisionPrompt(input)
      }
    ], {
      model,
      temperature: 0.1,
      maxTokens: 260,
      enableThinking: false
    })

    return parseToolLoopAction(response) || { action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: '工具决策无法解析，先读取最近上下文兜底' }
  } catch {
    return { action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: '工具决策失败，先读取最近上下文兜底' }
  }
}

function hasAnswerEvidence(input: {
  searchPayloads: SearchPayloadWithQuery[]
  contextWindows: ContextWindow[]
  summaryFactsRead: boolean
  aggregateText?: string
}): boolean {
  const summaryHasFacts = input.summaryFactsRead
  const aggregateText = compactText(input.aggregateText || '', 120)
  const aggregateHasFacts = Boolean(aggregateText) && !/^没有可聚合的消息/.test(aggregateText)

  return summaryHasFacts
    || aggregateHasFacts
    || input.searchPayloads.some((item) => item.payload.hits.length > 0)
    || input.contextWindows.some((window) => window.messages.length > 0)
}

function findKnownHitForAction(action: Extract<ToolLoopAction, { action: 'read_context' }>, knownHits: KnownSearchHit[]): KnownSearchHit | null {
  if (action.hitId) {
    const exact = knownHits.find((hit) => hit.hitId.toLowerCase() === action.hitId!.toLowerCase())
    if (exact) return exact
  }

  if (action.cursor) {
    return knownHits.find((hit) =>
      hit.message.cursor.localId === action.cursor!.localId
      && hit.message.cursor.createTime === action.cursor!.createTime
      && hit.message.cursor.sortSeq === action.cursor!.sortSeq
    ) || null
  }

  return knownHits[0] || null
}

function summarizeSearchObservation(query: string, payload?: McpSearchMessagesPayload, knownHits: KnownSearchHit[] = []): string {
  const hits = payload?.hits || []
  if (hits.length === 0) {
    return `关键词：${query}，命中 0 条。`
  }

  const latestKnown = knownHits.slice(-Math.min(hits.length, MAX_SEARCH_HITS))
  const lines = latestKnown.map(formatKnownHit).join('\n')
  return `关键词：${query}，命中 ${hits.length} 条。\n${lines}`
}

async function loadLatestContext(sessionId: string, limit = MAX_CONTEXT_MESSAGES): Promise<{
  payload?: McpSessionContextPayload
  toolCall?: SessionQAToolCall
}> {
  const args = {
    sessionId,
    mode: 'latest',
    beforeLimit: limit,
    includeRaw: false
  }
  const result = await executeMcpTool('get_session_context', args)
  return {
    payload: result.payload as McpSessionContextPayload,
    toolCall: {
      toolName: 'read_latest',
      args,
      summary: result.summary
    }
  }
}

async function searchSessionMessages(sessionId: string, query: string, filters: {
  senderUsername?: string
  startTime?: number
  endTime?: number
  limit?: number
} = {}): Promise<{
  payload?: McpSearchMessagesPayload
  toolCall?: SessionQAToolCall
}> {
  const args = {
    sessionId,
    query,
    limit: filters.limit || MAX_SEARCH_HITS,
    matchMode: 'substring',
    includeRaw: false,
    ...(filters.senderUsername ? { senderUsername: filters.senderUsername } : {}),
    ...(filters.startTime ? { startTime: filters.startTime } : {}),
    ...(filters.endTime ? { endTime: filters.endTime } : {})
  }
  const result = await executeMcpTool('search_messages', args)
  return {
    payload: result.payload as McpSearchMessagesPayload,
    toolCall: {
      toolName: 'search_messages',
      args,
      summary: result.summary
    }
  }
}

async function loadContextAroundMessage(
  sessionId: string,
  message: McpMessageItem,
  beforeLimit = SEARCH_CONTEXT_BEFORE,
  afterLimit = SEARCH_CONTEXT_AFTER
): Promise<{
  payload?: McpSessionContextPayload
  toolCall?: SessionQAToolCall
}> {
  const args = {
    sessionId,
    mode: 'around',
    anchorCursor: message.cursor,
    beforeLimit,
    afterLimit,
    includeRaw: false
  }
  const result = await executeMcpTool('get_session_context', args)
  return {
    payload: result.payload as McpSessionContextPayload,
    toolCall: {
      toolName: 'read_context',
      args,
      summary: result.summary
    }
  }
}

async function loadMessagesByTimeRange(
  sessionId: string,
  input: {
    startTime?: number
    endTime?: number
    keyword?: string
    senderUsername?: string
    limit?: number
    order?: 'asc' | 'desc'
  }
): Promise<{
  payload?: McpMessagesPayload
  toolCall?: SessionQAToolCall
}> {
  const args = {
    sessionId,
    offset: 0,
    limit: input.limit || 80,
    order: input.order || 'asc',
    includeRaw: false,
    ...(input.startTime ? { startTime: input.startTime } : {}),
    ...(input.endTime ? { endTime: input.endTime } : {}),
    ...(input.keyword ? { keyword: input.keyword } : {})
  }
  const result = await executeMcpTool('get_messages', args)
  const payload = (result.payload || {
    items: [],
    offset: 0,
    limit: input.limit || 80,
    hasMore: false
  }) as McpMessagesPayload
  const items = input.senderUsername
    ? (payload.items || []).filter((message) => message.sender.username === input.senderUsername)
    : payload.items || []

  return {
    payload: {
      ...payload,
      items,
      limit: input.limit || payload.limit
    },
    toolCall: {
      toolName: 'read_by_time_range',
      args: {
        ...args,
        ...(input.senderUsername ? { senderUsername: input.senderUsername } : {})
      },
      summary: result.summary
    }
  }
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

function formatTimeRangeLabel(range?: TimeRangeHint): string {
  if (!range?.startTime && !range?.endTime) return range?.label || '未指定时间范围'
  const start = range.startTime ? formatTime(range.startTime * 1000) : '开始'
  const end = range.endTime ? formatTime(range.endTime * 1000) : '结束'
  return range.label ? `${range.label}（${start} - ${end}）` : `${start} - ${end}`
}

function getRouteLabel(intent: SessionQAIntentType): string {
  const labels: Record<SessionQAIntentType, string> = {
    summary_answerable: '摘要可答',
    recent_status: '最近进展',
    time_range: '时间范围',
    participant_focus: '参与者聚焦',
    exact_evidence: '精确证据',
    broad_summary: '趋势总结',
    stats_or_count: '统计计数',
    unclear: '不明确'
  }
  return labels[intent]
}

function buildInitialActionQueue(route: IntentRoute, question: string): ToolLoopAction[] {
  const firstQuery = route.searchQueries.find((query) => !isGenericSearchQuery(query))
    || expandSearchQueries(question, [])[0]
    || ''
  const participantName = route.participantHints[0]
  const range = route.timeRange
  const actions: ToolLoopAction[] = []

  for (const actionName of route.preferredPlan) {
    if (actionName === 'read_summary_facts') {
      actions.push({ action: 'read_summary_facts', reason: '优先检查当前摘要是否已经覆盖问题' })
    } else if (actionName === 'read_latest') {
      actions.push({ action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: '问题指向最近或当前对话进展' })
    } else if (actionName === 'read_by_time_range') {
      actions.push({
        action: 'read_by_time_range',
        startTime: range?.startTime,
        endTime: range?.endTime,
        label: range?.label,
        limit: route.intent === 'stats_or_count' ? 100 : 80,
        participantName,
        reason: range ? `按${formatTimeRangeLabel(range)}读取消息` : '按问题相关时间读取消息'
      })
    } else if (actionName === 'resolve_participant') {
      actions.push({ action: 'resolve_participant', name: participantName, reason: '先把昵称/备注解析为发送者' })
    } else if (actionName === 'search_messages' && firstQuery) {
      actions.push({ action: 'search_messages', query: firstQuery, reason: '需要检索具体词、原话或事项' })
    } else if (actionName === 'read_context') {
      actions.push({ action: 'read_context', reason: '围绕搜索命中读取前后文' })
    } else if (actionName === 'aggregate_messages') {
      actions.push({
        action: 'aggregate_messages',
        metric: route.intent === 'stats_or_count' ? 'speaker_count' : 'summary',
        reason: '对已读取消息做统计或趋势整理'
      })
    } else if (actionName === 'answer') {
      actions.push({ action: 'answer', reason: '按路线尝试生成回答' })
    }
  }

  const insertBeforeAnswer = (action: ToolLoopAction) => {
    const answerIndex = actions.findIndex((item) => item.action === 'answer')
    if (answerIndex >= 0) {
      actions.splice(answerIndex, 0, action)
    } else {
      actions.push(action)
    }
  }

  if (route.intent === 'exact_evidence') {
    if (!actions.some((item) => item.action === 'search_messages') && firstQuery) {
      insertBeforeAnswer({ action: 'search_messages', query: firstQuery, reason: '需要精确证据' })
    }
    if (actions.some((item) => item.action === 'search_messages') && !actions.some((item) => item.action === 'read_context')) {
      insertBeforeAnswer({ action: 'read_context', reason: '读取搜索命中的前后文' })
    }
  }

  if (route.intent === 'time_range' && !actions.some((item) => item.action === 'read_by_time_range')) {
    insertBeforeAnswer({
      action: 'read_by_time_range',
      startTime: range?.startTime,
      endTime: range?.endTime,
      label: range?.label,
      limit: 80,
      reason: '时间类问题需要先按时间读取消息'
    })
  }

  if (route.intent === 'stats_or_count') {
    if (!actions.some((item) => item.action === 'read_by_time_range')) {
      insertBeforeAnswer({
        action: 'read_by_time_range',
        startTime: range?.startTime,
        endTime: range?.endTime,
        label: range?.label,
        limit: 100,
        reason: '统计问题需要先读取待统计消息'
      })
    }
    if (!actions.some((item) => item.action === 'aggregate_messages')) {
      insertBeforeAnswer({ action: 'aggregate_messages', metric: 'speaker_count', reason: '统计问题需要聚合已读取消息' })
    }
  }

  if (route.intent === 'participant_focus') {
    if (!actions.some((item) => item.action === 'resolve_participant')) {
      actions.unshift({ action: 'resolve_participant', name: participantName, reason: '先把昵称/备注解析为发送者' })
    }
    if (!actions.some((item) => item.action === 'read_by_time_range')) {
      insertBeforeAnswer({ action: 'read_by_time_range', participantName, limit: 80, reason: '读取该参与者相关消息' })
    }
  }

  if (actions.length === 0) {
    if (route.intent === 'exact_evidence' && firstQuery) {
      actions.push({ action: 'search_messages', query: firstQuery, reason: '需要精确证据' })
      actions.push({ action: 'read_context', reason: '读取搜索命中的前后文' })
    } else if (route.intent === 'recent_status') {
      actions.push({ action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: '读取最近消息' })
    } else {
      actions.push({ action: 'read_summary_facts', reason: '先检查摘要事实' })
      actions.push({ action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: '摘要不足时读取最近消息' })
    }
    actions.push({ action: 'answer', reason: '基于已有证据回答' })
  }

  if (actions[actions.length - 1]?.action !== 'answer') {
    actions.push({ action: 'answer', reason: '基于已有证据回答' })
  }

  return actions
}

function participantMatches(query: string, message: McpMessageItem): boolean {
  const normalized = query.toLowerCase()
  if (!normalized) return false
  return [
    message.sender.displayName || '',
    message.sender.username || '',
    message.sender.isSelf ? '我' : ''
  ].some((value) => {
    const candidate = value.toLowerCase()
    return Boolean(candidate) && (candidate.includes(normalized) || normalized.includes(candidate))
  })
}

async function resolveParticipantName(input: {
  sessionId: string
  name?: string
  contextWindows: ContextWindow[]
  knownHits: KnownSearchHit[]
}): Promise<ParticipantResolution> {
  const query = compactText(input.name || '', 48)
  const observedMessages = dedupeMessagesByCursor([
    ...input.contextWindows.flatMap((window) => window.messages),
    ...input.knownHits.map((hit) => hit.message)
  ])

  if (query) {
    const observed = observedMessages.find((message) => participantMatches(query, message))
    if (observed?.sender.username || observed?.sender.displayName) {
      return {
        query,
        senderUsername: observed.sender.username || undefined,
        displayName: describeSender(observed),
        confidence: observed.sender.username ? 'high' : 'medium',
        source: 'observed'
      }
    }
  }

  if (query) {
    try {
      const result = await executeMcpTool('list_contacts', { q: query, limit: 10, offset: 0 })
      const payload = result.payload as McpContactsPayload
      const exact = payload.items.find((contact) => {
        const names = [contact.displayName, contact.remark || '', contact.nickname || '', contact.contactId]
        return names.some((name) => name && (name === query || name.toLowerCase() === query.toLowerCase()))
      }) || payload.items[0]

      if (exact) {
        return {
          query,
          senderUsername: exact.contactId,
          displayName: exact.displayName || exact.remark || exact.nickname || exact.contactId,
          confidence: exact.displayName === query || exact.remark === query || exact.nickname === query ? 'high' : 'medium',
          source: 'contacts'
        }
      }
    } catch {
      // 参与者解析失败不应中断问答，后续会回退到未过滤读取。
    }
  }

  return {
    query: query || '未指定参与者',
    confidence: 'low',
    source: 'fallback'
  }
}

function findResolvedSenderUsername(
  action: Extract<ToolLoopAction, { action: 'read_by_time_range' }>,
  resolvedParticipants: ParticipantResolution[]
): string | undefined {
  if (action.senderUsername) return action.senderUsername
  if (!action.participantName) {
    return resolvedParticipants.find((item) => item.senderUsername)?.senderUsername
  }
  const normalized = action.participantName.toLowerCase()
  return resolvedParticipants.find((item) => {
    const displayName = (item.displayName || '').toLowerCase()
    return item.query.toLowerCase() === normalized
      || (Boolean(displayName) && (displayName.includes(normalized) || normalized.includes(displayName)))
  })?.senderUsername
}

function aggregateMessages(messages: McpMessageItem[], metric: Extract<ToolLoopAction, { action: 'aggregate_messages' }>['metric'] = 'summary'): string {
  const unique = dedupeMessagesByCursor(messages)
  if (unique.length === 0) return '没有可聚合的消息。'

  const speakerCounts = new Map<string, number>()
  const kindCounts = new Map<string, number>()
  const dayCounts = new Map<string, number>()

  for (const message of unique) {
    const speaker = describeSender(message)
    speakerCounts.set(speaker, (speakerCounts.get(speaker) || 0) + 1)
    kindCounts.set(message.kind, (kindCounts.get(message.kind) || 0) + 1)
    const day = formatTime(message.timestampMs).slice(0, 10)
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1)
  }

  const formatTop = (map: Map<string, number>, limit = 8) => Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => `${name}: ${count}`)
    .join('；')

  const first = unique[0]
  const last = unique[unique.length - 1]
  const samples = unique
    .filter((message) => message.text)
    .slice(0, 8)
    .map(formatMessageLine)
    .join('\n')

  if (metric === 'speaker_count') {
    return `消息数：${unique.length}\n发言排行：${formatTop(speakerCounts)}\n时间范围：${formatTime(first.timestampMs)} - ${formatTime(last.timestampMs)}`
  }

  if (metric === 'message_count') {
    return `消息数：${unique.length}\n按日期：${formatTop(dayCounts, 10)}\n时间范围：${formatTime(first.timestampMs)} - ${formatTime(last.timestampMs)}`
  }

  if (metric === 'kind_count') {
    return `消息数：${unique.length}\n消息类型：${formatTop(kindCounts)}`
  }

  if (metric === 'timeline') {
    return `消息数：${unique.length}\n按日期：${formatTop(dayCounts, 10)}\n代表消息：\n${samples || '无文本消息。'}`
  }

  return `消息数：${unique.length}\n时间范围：${formatTime(first.timestampMs)} - ${formatTime(last.timestampMs)}\n发言分布：${formatTop(speakerCounts)}\n消息类型：${formatTop(kindCounts)}\n代表消息：\n${samples || '无文本消息。'}`
}

function buildStructuredContext(analysis?: StructuredAnalysis): string {
  if (!analysis) return ''

  return compactText(JSON.stringify(analysis), MAX_STRUCTURED_CHARS)
}

function buildHistoryContext(history: SessionQAHistoryMessage[] = []): string {
  return history
    .slice(-MAX_HISTORY_MESSAGES)
    .map((item) => `${item.role === 'user' ? '用户' : 'AI'}：${compactText(item.content, 500)}`)
    .join('\n')
}

function buildAnswerPrompt(input: {
  sessionName: string
  question: string
  route: IntentRoute
  summaryText?: string
  structuredContext?: string
  summaryFactsText?: string
  contextWindows: ContextWindow[]
  searchPayloads: SearchPayloadWithQuery[]
  aggregateText?: string
  resolvedParticipants: ParticipantResolution[]
  historyText: string
  usedRecentFallback: boolean
}): string {
  const contextText = input.contextWindows.length > 0
    ? input.contextWindows.map((window, index) => {
      const heading = window.source === 'search'
        ? `上下文窗口 ${index + 1}（关键词：${window.query || '未知'}，围绕命中消息）`
        : window.source === 'time_range'
          ? `上下文窗口 ${index + 1}（按时间读取：${window.label || '指定范围'}）`
          : `上下文窗口 ${index + 1}（最近消息）`
      const lines = window.messages.length > 0
        ? window.messages.map(formatMessageLine).join('\n')
        : '无上下文消息。'
      return `${heading}\n${lines}`
    }).join('\n\n')
    : '无可用上下文。'

  const searchContext = input.searchPayloads.length > 0
    ? input.searchPayloads.map(({ query, payload }) => {
      const lines = payload.hits.length > 0
        ? payload.hits.map((hit) => formatMessageLine(hit.message)).join('\n')
        : '无命中。'
      return `关键词：${query}\n${lines}`
    }).join('\n\n')
    : '本次未执行关键词检索，或检索没有命中。'

  const participantText = input.resolvedParticipants.length > 0
    ? input.resolvedParticipants
      .map((item) => `${item.query} => ${item.displayName || '未命名'} / ${item.senderUsername || '未解析'} / ${item.confidence}`)
      .join('\n')
    : '无'

  return `你是 CipherTalk 的单会话 AI 助手。请只基于提供的本地聊天上下文回答，不要编造未出现的事实。

会话：${input.sessionName}

用户问题：
${input.question}

多轮上下文：
${input.historyText || '无'}

当前摘要：
${compactText(stripThinkBlocks(input.summaryText || ''), MAX_SUMMARY_CHARS) || '无'}

结构化摘要 JSON：
${input.structuredContext || '无'}

本轮意图路由：
${getRouteLabel(input.route.intent)}（${input.route.confidence}）：${input.route.reason || '无'}

已读取摘要事实：
${input.summaryFactsText || '无'}

已解析参与者：
${participantText}

按需读取的消息上下文：
${contextText}

关键词检索结果：
${searchContext}

聚合/统计结果：
${input.aggregateText || '无'}

上下文策略：
${input.usedRecentFallback
    ? '本次读取了最近消息，适合回答最近进展或作为证据兜底。'
    : input.searchPayloads.length > 0
      ? '本次执行了关键词检索，并在需要时围绕命中读取上下文。'
      : '本次根据意图路由使用摘要、时间范围、参与者或聚合工具，没有把关键词搜索作为默认入口。'}

回答要求：
1. 用中文直接回答问题。
2. 如果证据不足，明确说“当前证据不足”，并说明还需要什么线索。
3. 能引用依据时，在回答末尾加“依据”小节，用时间、发送人和原文预览列 1 到 5 条。
4. 不要输出工具调用过程，不要输出 JSON。`
}

export async function answerSessionQuestionWithAgent(
  options: SessionQAAgentOptions
): Promise<SessionQAAgentResult> {
  const toolCalls: SessionQAToolCall[] = []
  const evidenceCandidates: SummaryEvidenceRef[] = []
  const searchPayloads: SearchPayloadWithQuery[] = []
  const contextWindows: ContextWindow[] = []
  const observations: ToolObservation[] = []
  const knownHits: KnownSearchHit[] = []
  const searchedQueries = new Set<string>()
  const readContextKeys = new Set<string>()
  const structuredContext = buildStructuredContext(options.structuredAnalysis)
  const historyText = buildHistoryContext(options.history)
  const resolvedParticipants: ParticipantResolution[] = []
  let summaryFactsRead = false
  let summaryFactsText = ''
  let aggregateText = ''
  let usedRecentFallback = false
  let searchIndexPrepared = false

  emitProgress(options, {
    id: 'intent',
    stage: 'intent',
    status: 'running',
    title: '识别问题意图',
    detail: '正在判断应该读摘要、最近消息、时间范围、参与者、搜索还是统计'
  })

  const route = await routeQuestionIntent(options.provider, options.model, {
    question: options.question,
    sessionName: options.sessionName || options.sessionId,
    summaryText: options.summaryText,
    structuredContext,
    historyText
  })
  const pendingActions = buildInitialActionQueue(route, options.question)

  emitProgress(options, {
    id: 'intent',
    stage: 'intent',
    status: 'completed',
    title: `识别意图：${getRouteLabel(route.intent)}`,
    detail: `路线：${route.preferredPlan.join(' -> ')}${route.reason ? `；${route.reason}` : ''}`,
    count: route.preferredPlan.length
  })

  const ensureSearchIndexReady = async () => {
    if (searchIndexPrepared) return
    searchIndexPrepared = true

    emitProgress(options, {
      id: 'tool-index',
      stage: 'tool',
      status: 'running',
      title: '准备搜索索引',
      detail: '当前路线需要检索，正在检查会话本地搜索索引',
      toolName: 'search_messages'
    })

    try {
      const indexState = await chatSearchIndexService.ensureSessionIndexed(options.sessionId, (progress) => {
        emitProgress(options, {
          id: 'tool-index',
          stage: 'tool',
          status: 'running',
          title: progress.stage === 'preparing_index' ? '准备搜索索引' : '更新搜索索引',
          detail: progress.message,
          toolName: 'search_messages',
          count: progress.indexedCount ?? progress.messagesScanned
        })
      })

      emitProgress(options, {
        id: 'tool-index',
        stage: 'tool',
        status: 'completed',
        title: '搜索索引已就绪',
        detail: `当前会话已索引 ${indexState.indexedCount} 条消息`,
        toolName: 'search_messages',
        count: indexState.indexedCount
      })

      observations.push({
        title: '搜索索引',
        detail: `当前会话索引已就绪，共 ${indexState.indexedCount} 条消息。`
      })
    } catch (error) {
      emitProgress(options, {
        id: 'tool-index',
        stage: 'tool',
        status: 'failed',
        title: '搜索索引准备失败',
        detail: `${compactText(String(error), 120)}；后续检索会回退到扫描`,
        toolName: 'search_messages'
      })
      observations.push({
        title: '搜索索引',
        detail: `索引准备失败：${compactText(String(error), 160)}。后续 search_messages 将尝试回退扫描。`
      })
    }
  }

  const addKnownHits = (query: string, payload?: McpSearchMessagesPayload) => {
    if (!payload) return

    for (const hit of payload.hits) {
      const key = getMessageCursorKey(hit.message)
      if (knownHits.some((item) => getMessageCursorKey(item.message) === key)) continue
      const knownHit: KnownSearchHit = {
        ...hit,
        query,
        hitId: `h${knownHits.length + 1}`
      }
      knownHits.push(knownHit)
      const ref = toEvidenceRef(options.sessionId, hit.message, hit.excerpt)
      if (ref) evidenceCandidates.push(ref)
    }
  }

  const addContextEvidence = (messages: McpMessageItem[], limit = 8) => {
    for (const message of messages.slice(-limit)) {
      const ref = toEvidenceRef(options.sessionId, message)
      if (ref) evidenceCandidates.push(ref)
    }
  }

  const currentEvidenceState = () => hasAnswerEvidence({
    searchPayloads,
    contextWindows,
    summaryFactsRead,
    aggregateText
  })

  let toolCallsUsed = 0
  let decisionAttempts = 0

  while (toolCallsUsed < MAX_TOOL_CALLS && decisionAttempts < MAX_TOOL_DECISION_ATTEMPTS) {
    decisionAttempts += 1
    let action = pendingActions.shift() || await chooseNextToolAction(options.provider, options.model, {
        sessionName: options.sessionName || options.sessionId,
        question: options.question,
        route,
        summaryText: options.summaryText,
        structuredContext,
        historyText,
        observations,
        knownHits,
        resolvedParticipants,
        aggregateText,
        summaryFactsRead,
        toolCallsUsed
      })

    if (!currentEvidenceState() && toolCallsUsed >= MAX_TOOL_CALLS - 1 && action.action !== 'read_latest') {
      action = {
        action: 'read_latest',
        limit: MAX_CONTEXT_MESSAGES,
        reason: '工具预算即将耗尽，先读取最近消息作为最低限度依据'
      }
    }

    if (action.action === 'answer') {
      if (currentEvidenceState()) {
        observations.push({
          title: '开始回答',
          detail: action.reason || '已有可用证据，进入回答生成。'
        })
        break
      }

      action = summaryFactsRead
        ? { action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: '摘要事实不足，回答前读取最近上下文' }
        : { action: 'read_summary_facts', reason: '尚无可用证据，先检查摘要事实' }
    }

    if (action.action === 'read_summary_facts') {
      toolCallsUsed += 1
      const progressId = `tool-loop-${toolCallsUsed}-summary`

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'running',
        title: '读取摘要事实',
        detail: action.reason || '读取当前摘要和结构化摘要',
        toolName: 'read_summary_facts'
      })

      summaryFactsText = buildSummaryFactsText(options.summaryText, structuredContext)
      summaryFactsRead = Boolean(summaryFactsText)
      if (summaryFactsRead) {
        evidenceCandidates.push(...collectStructuredEvidenceRefs(options.structuredAnalysis))
      }

      toolCalls.push({
        toolName: 'read_summary_facts',
        args: {
          hasSummaryText: Boolean(stripThinkBlocks(options.summaryText || '').trim()),
          hasStructuredAnalysis: Boolean(structuredContext)
        },
        summary: summaryFactsRead ? '已读取当前摘要和结构化摘要。' : '当前没有可用摘要事实。'
      })

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'completed',
        title: '读取摘要事实',
        detail: summaryFactsRead ? '当前摘要/结构化摘要可作为回答依据' : '当前摘要为空或不足',
        toolName: 'read_summary_facts',
        count: summaryFactsRead ? 1 : 0
      })

      observations.push({
        title: '读取摘要事实',
        detail: summaryFactsRead ? summaryFactsText : '当前没有可用摘要事实。'
      })

      continue
    }

    if (action.action === 'resolve_participant') {
      toolCallsUsed += 1
      const name = action.name || route.participantHints[0] || ''
      const progressId = `tool-loop-${toolCallsUsed}-participant`

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'running',
        title: '解析参与者',
        detail: name ? `正在解析：${name}` : '正在从问题中解析参与者',
        toolName: 'resolve_participant',
        query: name
      })

      const resolution = await resolveParticipantName({
        sessionId: options.sessionId,
        name,
        contextWindows,
        knownHits
      })
      resolvedParticipants.push(resolution)
      toolCalls.push({
        toolName: 'resolve_participant',
        args: { sessionId: options.sessionId, name },
        summary: resolution.senderUsername
          ? `解析为 ${resolution.displayName || resolution.senderUsername}`
          : '未解析到明确发送者，后续读取会不加发送者过滤。'
      })

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: resolution.senderUsername ? 'completed' : 'failed',
        title: '解析参与者',
        detail: resolution.senderUsername
          ? `${resolution.query} => ${resolution.displayName || resolution.senderUsername}`
          : `${resolution.query} 未解析到明确发送者`,
        toolName: 'resolve_participant',
        query: name,
        count: resolution.senderUsername ? 1 : 0
      })

      observations.push({
        title: '解析参与者',
        detail: resolution.senderUsername
          ? `${resolution.query} => ${resolution.displayName || resolution.senderUsername} (${resolution.senderUsername})，置信度 ${resolution.confidence}。`
          : `${resolution.query} 未解析到明确 senderUsername。`
      })

      continue
    }

    if (action.action === 'read_by_time_range') {
      toolCallsUsed += 1
      const inferredRange = route.timeRange || inferTimeRangeFromQuestion(options.question)
      const range: TimeRangeHint = {
        startTime: action.startTime || inferredRange?.startTime,
        endTime: action.endTime || inferredRange?.endTime,
        label: action.label || inferredRange?.label
      }
      const senderUsername = findResolvedSenderUsername(action, resolvedParticipants)
      const hasRange = Boolean(range.startTime || range.endTime)
      const limit = clampToolLimit(action.limit, hasRange ? 80 : MAX_CONTEXT_MESSAGES, 100)
      const progressId = `tool-loop-${toolCallsUsed}-time`
      const label = hasRange ? formatTimeRangeLabel(range) : '最近一批消息'
      const participantLabel = action.participantName || resolvedParticipants[0]?.displayName || resolvedParticipants[0]?.query || ''

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'running',
        title: hasRange ? '按时间读取消息' : '读取最近消息',
        detail: `${label}${participantLabel ? `；参与者：${participantLabel}` : ''}`,
        toolName: 'read_by_time_range',
        query: action.keyword
      })

      try {
        const payload = await loadMessagesByTimeRange(options.sessionId, {
          startTime: range.startTime,
          endTime: range.endTime,
          keyword: action.keyword,
          senderUsername,
          limit,
          order: hasRange ? 'asc' : 'desc'
        })
        if (payload.toolCall) toolCalls.push(payload.toolCall)
        const messages = payload.payload?.items || []
        contextWindows.push({
          source: 'time_range',
          label: `${label}${senderUsername ? `；发送者：${senderUsername}` : participantLabel ? `；参与者：${participantLabel}` : ''}`,
          messages
        })
        addContextEvidence(messages)

        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: 'completed',
          title: hasRange ? '按时间读取消息' : '读取最近消息',
          detail: `读取到 ${messages.length} 条消息`,
          toolName: 'read_by_time_range',
          query: action.keyword,
          count: messages.length
        })

        observations.push({
          title: hasRange ? '按时间读取消息' : '读取最近消息',
          detail: `${label}${senderUsername ? `，senderUsername=${senderUsername}` : ''}，读取到 ${messages.length} 条。\n${messages.slice(0, 12).map(formatMessageLine).join('\n') || '无消息。'}`
        })
      } catch (error) {
        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: 'failed',
          title: hasRange ? '按时间读取失败' : '读取最近消息失败',
          detail: compactText(String(error), 120),
          toolName: 'read_by_time_range',
          query: action.keyword
        })

        observations.push({
          title: hasRange ? '按时间读取失败' : '读取最近消息失败',
          detail: `失败原因：${compactText(String(error), 160)}。`
        })
      }

      continue
    }

    if (action.action === 'aggregate_messages') {
      toolCallsUsed += 1
      const progressId = `tool-loop-${toolCallsUsed}-aggregate`
      const messages = dedupeMessagesByCursor(contextWindows.flatMap((window) => window.messages))

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'running',
        title: '整理统计',
        detail: action.reason || '对已读取消息做计数、分组和趋势整理',
        toolName: 'aggregate_messages',
        count: messages.length
      })

      aggregateText = aggregateMessages(messages, action.metric)
      toolCalls.push({
        toolName: 'aggregate_messages',
        args: { metric: action.metric || 'summary', messageCount: messages.length },
        summary: aggregateText
      })

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: messages.length > 0 ? 'completed' : 'failed',
        title: '整理统计',
        detail: messages.length > 0 ? `已整理 ${messages.length} 条消息` : '没有可聚合的消息',
        toolName: 'aggregate_messages',
        count: messages.length
      })

      observations.push({
        title: '整理统计',
        detail: aggregateText
      })

      continue
    }

    if (action.action === 'search_messages') {
      const query = normalizeSearchQuery(action.query, 48)
      const queryKey = query.toLowerCase()
      if (!query || searchedQueries.has(queryKey)) {
        observations.push({
          title: '跳过重复检索',
          detail: query ? `关键词“${query}”已检索过，请换更短或同义关键词。` : '模型给出的关键词为空。'
        })
        continue
      }

      searchedQueries.add(queryKey)
      toolCallsUsed += 1
      const progressId = `tool-loop-${toolCallsUsed}-search`
      await ensureSearchIndexReady()

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'running',
        title: '搜索相关消息',
        detail: action.reason ? `关键词：${query}；${action.reason}` : `关键词：${query}`,
        toolName: 'search_messages',
        query
      })

      try {
        const search = await searchSessionMessages(options.sessionId, query, {
          startTime: route.timeRange?.startTime,
          endTime: route.timeRange?.endTime,
          senderUsername: route.intent === 'participant_focus'
            ? resolvedParticipants.find((item) => item.senderUsername)?.senderUsername
            : undefined
        })
        if (search.toolCall) toolCalls.push(search.toolCall)
        if (search.payload) {
          searchPayloads.push({ query, payload: search.payload })
          addKnownHits(query, search.payload)
        }

        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: 'completed',
          title: '搜索相关消息',
          detail: `关键词：${query}，命中 ${search.payload?.hits.length || 0} 条`,
          toolName: 'search_messages',
          query,
          count: search.payload?.hits.length || 0
        })

        observations.push({
          title: '搜索相关消息',
          detail: summarizeSearchObservation(query, search.payload, knownHits)
        })
      } catch (error) {
        toolCalls.push({
          toolName: 'search_messages',
          args: { sessionId: options.sessionId, query },
          summary: `检索失败：${String(error)}`
        })

        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: 'failed',
          title: '搜索相关消息失败',
          detail: `关键词：${query}，${compactText(String(error), 120)}`,
          toolName: 'search_messages',
          query
        })

        observations.push({
          title: '搜索相关消息失败',
          detail: `关键词：${query}，失败原因：${compactText(String(error), 160)}。`
        })
      }

      continue
    }

    if (action.action === 'read_context') {
      const target = findKnownHitForAction(action, knownHits)
      if (!target) {
        observations.push({
          title: '读取命中上下文',
          detail: '没有可读取的搜索命中，请先搜索或读取最近消息。'
        })
        continue
      }

      const contextKey = getMessageCursorKey(target.message)
      if (readContextKeys.has(contextKey)) {
        observations.push({
          title: '跳过重复上下文',
          detail: `${target.hitId} 已读取过前后文，请选择其他命中或开始回答。`
        })
        continue
      }

      readContextKeys.add(contextKey)
      toolCallsUsed += 1
      const beforeLimit = clampToolLimit(action.beforeLimit, SEARCH_CONTEXT_BEFORE, 12)
      const afterLimit = clampToolLimit(action.afterLimit, SEARCH_CONTEXT_AFTER, 12)
      const progressId = `tool-loop-${toolCallsUsed}-context`

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'running',
        title: '读取命中上下文',
        detail: `${target.hitId}，关键词：${target.query}，读取前 ${beforeLimit} 条后 ${afterLimit} 条`,
        toolName: 'read_context',
        query: target.query
      })

      try {
        const context = await loadContextAroundMessage(options.sessionId, target.message, beforeLimit, afterLimit)
        if (context.toolCall) toolCalls.push(context.toolCall)
        const messages = context.payload?.items || []
        contextWindows.push({
          source: 'search',
          query: target.query,
          anchor: target.message,
          messages
        })

        for (const message of messages) {
          const ref = toEvidenceRef(options.sessionId, message)
          if (ref) evidenceCandidates.push(ref)
        }

        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: 'completed',
          title: '读取命中上下文',
          detail: `${target.hitId}，读取到 ${messages.length} 条上下文消息`,
          toolName: 'read_context',
          query: target.query,
          count: messages.length
        })

        observations.push({
          title: '读取命中上下文',
          detail: `${target.hitId}，关键词：${target.query}，读取到 ${messages.length} 条。\n${messages.slice(0, 10).map(formatMessageLine).join('\n')}`
        })
      } catch (error) {
        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: 'failed',
          title: '读取命中上下文失败',
          detail: `${target.hitId}，${compactText(String(error), 120)}`,
          toolName: 'read_context',
          query: target.query
        })

        observations.push({
          title: '读取命中上下文失败',
          detail: `${target.hitId}，失败原因：${compactText(String(error), 160)}。`
        })
      }

      continue
    }

    if (action.action === 'read_latest') {
      usedRecentFallback = true
      toolCallsUsed += 1
      const latestLimit = clampToolLimit(action.limit, MAX_CONTEXT_MESSAGES, MAX_CONTEXT_MESSAGES)
      const progressId = `tool-loop-${toolCallsUsed}-latest`

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'running',
        title: '读取最近上下文',
        detail: action.reason ? `读取最近 ${latestLimit} 条；${action.reason}` : `读取最近 ${latestLimit} 条消息`,
        toolName: 'read_latest'
      })

      try {
        const latest = await loadLatestContext(options.sessionId, latestLimit)
        if (latest.toolCall) toolCalls.push(latest.toolCall)
        const latestMessages = latest.payload?.items || []
        contextWindows.push({
          source: 'latest',
          messages: latestMessages
        })

        for (const message of latestMessages.slice(-8)) {
          const ref = toEvidenceRef(options.sessionId, message)
          if (ref) evidenceCandidates.push(ref)
        }

        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: 'completed',
          title: '读取最近上下文',
          detail: `读取到 ${latestMessages.length} 条最近消息`,
          toolName: 'read_latest',
          count: latestMessages.length
        })

        observations.push({
          title: '读取最近上下文',
          detail: `读取到 ${latestMessages.length} 条最近消息。\n${latestMessages.slice(0, 10).map(formatMessageLine).join('\n')}`
        })
      } catch (error) {
        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: 'failed',
          title: '读取最近上下文失败',
          detail: compactText(String(error), 120),
          toolName: 'read_latest'
        })

        observations.push({
          title: '读取最近上下文失败',
          detail: `失败原因：${compactText(String(error), 160)}。`
        })
      }

      continue
    }
  }

  if (!currentEvidenceState() && toolCallsUsed < MAX_TOOL_CALLS) {
    usedRecentFallback = true
    toolCallsUsed += 1
    const progressId = `tool-loop-${toolCallsUsed}-latest-final`

    emitProgress(options, {
      id: progressId,
      stage: 'tool',
      status: 'running',
      title: '读取最近上下文',
      detail: '回答前仍缺少证据，读取最近消息兜底',
      toolName: 'read_latest'
    })

    try {
      const latest = await loadLatestContext(options.sessionId, MAX_CONTEXT_MESSAGES)
      if (latest.toolCall) toolCalls.push(latest.toolCall)
      const latestMessages = latest.payload?.items || []
      contextWindows.push({
        source: 'latest',
        messages: latestMessages
      })

      for (const message of latestMessages.slice(-8)) {
        const ref = toEvidenceRef(options.sessionId, message)
        if (ref) evidenceCandidates.push(ref)
      }

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'completed',
        title: '读取最近上下文',
        detail: `读取到 ${latestMessages.length} 条最近消息`,
        toolName: 'read_latest',
        count: latestMessages.length
      })
    } catch (error) {
      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'failed',
        title: '读取最近上下文失败',
        detail: compactText(String(error), 120),
        toolName: 'read_latest'
      })
    }
  }

  const contextMessageCount = dedupeMessagesByCursor(contextWindows.flatMap((window) => window.messages)).length
  const totalSearchHits = searchPayloads.reduce((sum, item) => sum + item.payload.hits.length, 0)

  emitProgress(options, {
    id: 'context',
    stage: 'context',
    status: 'completed',
    title: '整理回答依据',
    detail: `意图：${getRouteLabel(route.intent)}；摘要${summaryFactsRead ? '可用' : '未用'}；搜索命中 ${totalSearchHits} 条；读取消息 ${contextMessageCount} 条${aggregateText ? '；已聚合' : ''}`,
    count: contextMessageCount
  })

  const promptText = buildAnswerPrompt({
    sessionName: options.sessionName || options.sessionId,
    question: options.question,
    route,
    summaryText: options.summaryText,
    structuredContext,
    summaryFactsText,
    contextWindows,
    searchPayloads,
    aggregateText,
    resolvedParticipants,
    historyText,
    usedRecentFallback
  })

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: '你是严谨的本地聊天记录问答助手。你必须基于给定上下文回答，并在证据不足时明确承认不足。'
    },
    {
      role: 'user',
      content: promptText
    }
  ]

  emitProgress(options, {
    id: 'answer',
    stage: 'answer',
    status: 'running',
    title: '生成回答',
    detail: '正在基于上下文生成回答'
  })

  let answerText = ''
  const enableThinking = options.enableThinking !== false
  const thinkFilterState = { isThinking: false }
  await options.provider.streamChat(
    messages,
    {
      model: options.model,
      temperature: 0.3,
      maxTokens: 1600,
      enableThinking
    },
    (chunk) => {
      const visibleChunk = enableThinking ? chunk : filterThinkChunk(chunk, thinkFilterState)
      if (!visibleChunk) return
      answerText += visibleChunk
      options.onChunk(visibleChunk)
    }
  )

  const finalAnswerText = stripThinkBlocks(answerText)

  emitProgress(options, {
    id: 'answer',
    stage: 'answer',
    status: 'completed',
    title: '生成回答',
    detail: '回答生成完成'
  })

  return {
    answerText: finalAnswerText,
    evidenceRefs: dedupeEvidenceRefs(evidenceCandidates),
    toolCalls,
    promptText
  }
}
