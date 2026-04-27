/**
 * Agent 上下文状态管理
 *
 * 将主循环中散落的闭包变量统一收敛到一个可管理的状态类中，
 * 解决隐式状态共享问题。
 */
import type {
  ContextWindow,
  EvidenceQuality,
  IntentRoute,
  KnownSearchHit,
  ParticipantResolution,
  SearchPayloadWithQuery,
  SessionQAAgentOptions,
  SessionQAToolCall,
  ToolObservation,
  TimeRangeHint,
  TokenUsage
} from './types'
import type { McpMessageItem, McpSearchMessagesPayload } from '../../mcp/types'
import type { SummaryEvidenceRef } from '../types/analysis'
import type { StructuredAnalysis } from '../types/analysis'
import { assessEvidenceQuality } from './evidence'
import { getMessageCursorKey, toEvidenceRef } from './utils/message'
import { stripThinkBlocks } from './utils/text'
import {
  MAX_TOOL_CALLS,
  MAX_TOOL_DECISION_ATTEMPTS,
  MAX_SEARCH_RETRIES,
  DEFAULT_TOKEN_BUDGET
} from './types'
import { AgentLogger } from './logger'

/**
 * Agent 运行时上下文
 *
 * 集中管理所有编排循环中的可变状态。
 */
export class AgentContext {
  // ─── 外部输入（只读）───────────────────────────────────────
  readonly sessionId: string
  readonly sessionName: string
  readonly question: string
  readonly route: IntentRoute
  readonly options: SessionQAAgentOptions
  readonly contactMap: Map<string, string>

  // ─── 可变状态 ─────────────────────────────────────────────
  toolCalls: SessionQAToolCall[] = []
  evidenceCandidates: SummaryEvidenceRef[] = []
  searchPayloads: SearchPayloadWithQuery[] = []
  contextWindows: ContextWindow[] = []
  observations: ToolObservation[] = []
  knownHits: KnownSearchHit[] = []
  searchedQueries = new Set<string>()
  readContextKeys = new Set<string>()
  resolvedParticipants: ParticipantResolution[] = []

  summaryFactsRead = false
  summaryFactsText = ''
  aggregateText = ''
  usedRecentFallback = false
  answerText = ''
  lastAgentPrompt = ''

  toolCallsUsed = 0
  decisionAttempts = 0
  searchRetries = 0

  // ─── Token 预算追踪 ───────────────────────────────────────────
  private decisionTokens = 0
  private answerTokens = 0
  private readonly tokenBudget: number

  // ─── 结构化日志 ────────────────────────────────────────────
  readonly logger: AgentLogger

  // ─── 超时与取消 ────────────────────────────────────────────
  readonly startTime = Date.now()
  private readonly abortController: AbortController

  constructor(options: SessionQAAgentOptions, route: IntentRoute, contactMap: Map<string, string> = new Map()) {
    this.options = options
    this.sessionId = options.sessionId
    this.sessionName = options.sessionName || options.sessionId
    this.question = options.question
    this.route = route
    this.contactMap = contactMap

    // 创建独立的 AbortController，合并外部 signal
    this.abortController = new AbortController()
    if (options.signal) {
      if (options.signal.aborted) {
        this.abortController.abort(options.signal.reason)
      } else {
        options.signal.addEventListener('abort', () => {
          this.abortController.abort(options.signal!.reason)
        }, { once: true })
      }
    }

    // Token 预算
    this.tokenBudget = DEFAULT_TOKEN_BUDGET

    // 结构化日志
    this.logger = new AgentLogger(options.sessionId)
    this.logger.lifecycle('问答 Agent 启动', {
      sessionId: options.sessionId,
      question: options.question.slice(0, 120),
      intent: route.intent,
      model: options.model
    })
  }

  // ─── 取消与超时检查 ─────────────────────────────────────────

  /** 获取当前 signal（传给子调用） */
  get signal(): AbortSignal {
    return this.abortController.signal
  }

  /** 检查是否已被取消 */
  get isCancelled(): boolean {
    return this.abortController.signal.aborted
  }

  /** 检查是否超时 */
  get isTimedOut(): boolean {
    const timeout = this.options.timeoutMs || 120_000
    return (Date.now() - this.startTime) > timeout
  }

  /** 已耗时（毫秒） */
  get elapsedMs(): number {
    return Date.now() - this.startTime
  }

  /**
   * 检查是否应中断循环（取消或超时）
   * @throws 如果已被取消或超时，抛出错误
   */
  checkAbort(): void {
    if (this.isCancelled) {
      throw new AgentAbortError('问答已被用户取消', 'cancelled')
    }
    if (this.isTimedOut) {
      throw new AgentAbortError('问答超时，请缩小问题范围后重试', 'timeout')
    }
  }

  /**
   * 检查是否应该继续循环
   */
  shouldContinueLoop(): boolean {
    if (this.isCancelled || this.isTimedOut) return false
    if (this.toolCallsUsed >= MAX_TOOL_CALLS) return false
    if (this.decisionAttempts >= MAX_TOOL_DECISION_ATTEMPTS) return false
    if (this.isTokenBudgetExceeded) return false
    return true
  }

  // ─── Token 预算管理 ────────────────────────────────────────

  /**
   * 简单估算文本的 Token 数
   * 中文约 1.5 字符 = 1 token，英文约 4 字符 = 1 token
   */
  estimateTokens(text: string): number {
    if (!text) return 0
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length
    const otherChars = text.length - chineseChars
    return Math.ceil(chineseChars / 1.5 + otherChars / 4)
  }

  /** 记录决策阶段 Token 消耗 */
  trackDecisionTokens(promptText: string, responseText: string) {
    const tokens = this.estimateTokens(promptText) + this.estimateTokens(responseText)
    this.decisionTokens += tokens
    this.logger.decision(`决策 Token +${tokens}，累计 ${this.decisionTokens}`, { tokens, total: this.decisionTokens })
  }

  /** 记录回答阶段 Token 消耗 */
  trackAnswerTokens(promptText: string, responseText: string) {
    const tokens = this.estimateTokens(promptText) + this.estimateTokens(responseText)
    this.answerTokens += tokens
    this.logger.answer(`回答 Token +${tokens}，累计 ${this.answerTokens}`, { tokens, total: this.answerTokens })
  }

  /** 是否超出 Token 预算 */
  get isTokenBudgetExceeded(): boolean {
    return (this.decisionTokens + this.answerTokens) > this.tokenBudget
  }

  /** 获取 Token 使用统计 */
  getTokenUsage(): TokenUsage {
    return {
      decisionTokens: this.decisionTokens,
      answerTokens: this.answerTokens,
      totalTokens: this.decisionTokens + this.answerTokens,
      budgetExceeded: this.isTokenBudgetExceeded
    }
  }

  // ─── 证据管理 ──────────────────────────────────────────────

  /** 当前证据质量 */
  get evidenceQuality(): EvidenceQuality {
    return assessEvidenceQuality({
      searchPayloads: this.searchPayloads,
      contextWindows: this.contextWindows,
      summaryFactsRead: this.summaryFactsRead,
      aggregateText: this.aggregateText,
      intent: this.route.intent
    })
  }

  /** 是否有任何证据 */
  get hasEvidence(): boolean {
    return this.evidenceQuality !== 'none'
  }

  /** 添加搜索结果命中 */
  addKnownHits(query: string, payload?: McpSearchMessagesPayload) {
    if (!payload) return

    for (const hit of payload.hits) {
      const key = getMessageCursorKey(hit.message)
      if (this.knownHits.some((item) => getMessageCursorKey(item.message) === key)) continue
      const knownHit: KnownSearchHit = {
        ...hit,
        query,
        hitId: `h${this.knownHits.length + 1}`
      }
      this.knownHits.push(knownHit)
      const ref = toEvidenceRef(this.sessionId, hit.message, hit.excerpt)
      if (ref) this.evidenceCandidates.push(ref)
    }
  }

  /** 添加上下文消息的证据 */
  addContextEvidence(messages: McpMessageItem[], limit = 8) {
    for (const message of messages.slice(-limit)) {
      const ref = toEvidenceRef(this.sessionId, message)
      if (ref) this.evidenceCandidates.push(ref)
    }
  }

  // ─── 文本输出 ──────────────────────────────────────────────

  /** 输出可见文本给用户 */
  emitVisibleText(content: string) {
    const text = stripThinkBlocks(content).trim()
    if (!text) return
    const prefix = this.answerText && !/\s$/.test(this.answerText) ? '\n\n' : ''
    const visible = `${prefix}${text}`
    this.answerText += visible
    this.options.onChunk(visible)
  }
}

/**
 * Agent 中断错误（取消 / 超时）
 */
export class AgentAbortError extends Error {
  readonly code: 'cancelled' | 'timeout'

  constructor(message: string, code: 'cancelled' | 'timeout') {
    super(message)
    this.name = 'AgentAbortError'
    this.code = code
  }
}
