/**
 * SessionQA Agent 公共类型、常量
 */
import type { McpCursor, McpMessageItem, McpSearchMessagesPayload } from '../../mcp/types'
import type { SummaryEvidenceRef } from '../types/analysis'

// ─── 公共接口（对外导出）───────────────────────────────────

export interface SessionQAHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface SessionQAToolCall {
  toolName: SessionQAToolName
  args: Record<string, unknown>
  summary: string
  status?: 'running' | 'completed' | 'failed' | 'cancelled'
  durationMs?: number
  evidenceCount?: number
}

export type SessionQAToolName =
  | 'read_summary_facts'
  | 'read_latest'
  | 'read_by_time_range'
  | 'resolve_participant'
  | 'search_messages'
  | 'read_context'
  | 'aggregate_messages'
  | 'get_session_statistics'
  | 'get_keyword_statistics'
  | 'answer'
  | 'get_session_context'
  | 'prepare_vector_index'

export type SessionQAProgressStage = 'intent' | 'tool' | 'context' | 'answer' | 'thought'
export type SessionQAProgressStatus = 'running' | 'completed' | 'failed'
export type SessionQAProgressSource = 'summary' | 'chat' | 'search_index' | 'vector' | 'aggregate' | 'model'

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
  requestId?: string
  source?: SessionQAProgressSource
  elapsedMs?: number
  diagnostics?: string[]
}

export interface SessionQAAgentOptions {
  sessionId: string
  sessionName?: string
  question: string
  summaryText?: string
  structuredAnalysis?: import('../types/analysis').StructuredAnalysis
  history?: SessionQAHistoryMessage[]
  provider: import('../../ai/providers/base').AIProvider
  model: string
  enableThinking?: boolean
  agentDecisionMaxTokens?: number
  agentAnswerMaxTokens?: number
  onChunk: (chunk: string) => void
  onProgress?: (event: SessionQAProgressEvent) => void
  /** 取消信号，支持中途中断 */
  signal?: AbortSignal
  /** 整体超时（毫秒），默认 120_000（2 分钟） */
  timeoutMs?: number
}

export interface SessionQAAgentResult {
  answerText: string
  evidenceRefs: SummaryEvidenceRef[]
  toolCalls: SessionQAToolCall[]
  promptText: string
  /** Token 使用统计 */
  tokenUsage: TokenUsage
}

/** Token 使用统计 */
export interface TokenUsage {
  /** 决策阶段估算 token */
  decisionTokens: number
  /** 回答阶段估算 token */
  answerTokens: number
  /** 总估算 token */
  totalTokens: number
  /** 是否触发预算限制 */
  budgetExceeded: boolean
}

// ─── 内部类型 ───────────────────────────────────────────────

export type SearchPayloadWithQuery = { query: string; payload: McpSearchMessagesPayload }
export type SearchHitWithQuery = McpSearchMessagesPayload['hits'][number] & { query: string }
export type KnownSearchHit = SearchHitWithQuery & { hitId: string }

export type ContextWindow = {
  source: 'search' | 'latest' | 'time_range'
  query?: string
  label?: string
  anchor?: McpMessageItem
  messages: McpMessageItem[]
}

export type ToolObservation = {
  title: string
  detail: string
}

export type SearchFailureReason =
  | 'content_not_found'
  | 'vector_unavailable'
  | 'keyword_miss_only'

export type QueryRewriteResult = {
  applied: boolean
  semanticQuery?: string
  keywordQueries: string[]
  semanticQueries: string[]
  reason?: string
  diagnostics: string[]
}

export type SessionQAIntentType =
  | 'direct_answer'
  | 'summary_answerable'
  | 'recent_status'
  | 'time_range'
  | 'participant_focus'
  | 'exact_evidence'
  | 'media_or_file'
  | 'broad_summary'
  | 'stats_or_count'
  | 'unclear'

export type TimeRangeHint = {
  startTime?: number
  endTime?: number
  label?: string
}

export type ParticipantResolution = {
  query: string
  senderUsername?: string
  displayName?: string
  confidence: 'high' | 'medium' | 'low'
  source: 'observed' | 'contacts' | 'fallback'
}

export type IntentRoute = {
  intent: SessionQAIntentType
  confidence: 'high' | 'medium' | 'low'
  reason?: string
  timeRange?: TimeRangeHint
  participantHints: string[]
  searchQueries: string[]
  needsSearch: boolean
  preferredPlan: ToolLoopAction['action'][]
}

export type ToolLoopAction =
  | { action: 'read_summary_facts'; reason?: string }
  | { action: 'search_messages'; query: string; reason?: string }
  | { action: 'read_context'; hitId?: string; cursor?: McpCursor; beforeLimit?: number; afterLimit?: number; reason?: string }
  | { action: 'read_latest'; limit?: number; reason?: string }
  | { action: 'read_by_time_range'; startTime?: number; endTime?: number; label?: string; limit?: number; keyword?: string; senderUsername?: string; participantName?: string; reason?: string }
  | { action: 'resolve_participant'; name?: string; reason?: string }
  | { action: 'aggregate_messages'; metric?: 'speaker_count' | 'message_count' | 'kind_count' | 'timeline' | 'summary'; reason?: string }
  | { action: 'get_session_statistics'; startTime?: number; endTime?: number; label?: string; participantLimit?: number; includeSamples?: boolean; reason?: string }
  | { action: 'get_keyword_statistics'; keywords: string[]; startTime?: number; endTime?: number; label?: string; matchMode?: 'substring' | 'exact'; participantLimit?: number; reason?: string }
  | { action: 'answer'; reason?: string }

export type AutonomousAgentAction =
  | { action: 'assistant_text'; content: string }
  | { action: 'tool_call'; tool: ToolLoopAction; reason?: string }
  | { action: 'final_answer'; content?: string; reason?: string }

export type EvidenceQuality = 'none' | 'weak' | 'sufficient'

// ─── 常量 ───────────────────────────────────────────────────

export const MAX_CONTEXT_MESSAGES = 40
export const MAX_SEARCH_QUERIES = 6
export const MAX_SEARCH_HITS = 20
export const MAX_CONTEXT_WINDOWS = 4
export const SEARCH_CONTEXT_BEFORE = 6
export const SEARCH_CONTEXT_AFTER = 6
export const MAX_TOOL_CALLS = 30
export const MAX_TOOL_DECISION_ATTEMPTS = 40
export const MAX_SEARCH_RETRIES = 4
export const MAX_HISTORY_MESSAGES = 8
export const MAX_SUMMARY_CHARS = 3000
export const MAX_STRUCTURED_CHARS = 4000
export const MAX_MESSAGE_TEXT = 220
export const MAX_REWRITE_INPUT_CHARS = 800
export const MAX_REWRITE_KEYWORD_QUERIES = 4
export const MAX_REWRITE_SEMANTIC_QUERIES = 3
export const MAX_RETRIEVAL_EXPLAIN_TOP_K = 5
export const DEFAULT_AGENT_DECISION_MAX_TOKENS = 2048
export const DEFAULT_AGENT_ANSWER_MAX_TOKENS = 8192
export const MAX_AGENT_DECISION_MAX_TOKENS = 32768
export const MAX_AGENT_ANSWER_MAX_TOKENS = 65536
/** 默认整体超时：5 分钟（安全网，正常流程不应触发） */
export const DEFAULT_TIMEOUT_MS = 300_000
/** 单次工具调用超时：30 秒 */
export const TOOL_CALL_TIMEOUT_MS = 30_000
/** 默认 Token 预算上限（安全网，正常流程不应触发） */
export const DEFAULT_TOKEN_BUDGET = 500_000

// ─── 错误分类 ────────────────────────────────────────────────

/** Agent 错误严重级别 */
export type AgentErrorSeverity = 'retryable' | 'non_retryable' | 'degraded'

/** 分类后的 Agent 错误 */
export interface ClassifiedAgentError {
  severity: AgentErrorSeverity
  category: 'network' | 'rate_limit' | 'auth' | 'parse' | 'database' | 'timeout' | 'unknown'
  message: string
  originalError: unknown
  shouldRetry: boolean
  retryDelayMs?: number
}
