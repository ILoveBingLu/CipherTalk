import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import type OpenAI from 'openai'
import { ConfigService } from '../../config'
import type { AIProvider } from '../../ai/providers/base'
import { localEmbeddingModelService } from '../../search/embeddingModelService'
import { onlineEmbeddingService } from '../../search/onlineEmbeddingService'
import type { AgentDefinition, AgentEvent } from '../types'

const AGENT_SESSION_DB_NAME = 'agent_sessions.db'
const RECENT_CONTEXT_MESSAGE_COUNT = 10
const SUMMARY_TRIGGER_MESSAGE_COUNT = 18
const SUMMARY_KEEP_RECENT_COUNT = 8
const SUMMARY_STEP_MESSAGE_COUNT = 8
const SUMMARY_MAX_INPUT_CHARS = 18000
const SUMMARY_MAX_TEXT_CHARS = 6000
const OBSERVATION_MIN_TOKEN_COUNT = 8
const OBSERVATION_MAX_CONTENT_CHARS = 1600
const OBSERVATION_CONTEXT_LIMIT = 8
const OBSERVATION_VECTOR_CANDIDATE_LIMIT = 200
const OBSERVATION_VECTOR_MIN_SCORE = 0.32

const AGENT_OBSERVATION_TYPES = [
  'preference',
  'fact',
  'decision',
  'task',
  'constraint',
  'note'
] as const

export type AgentObservationType = (typeof AGENT_OBSERVATION_TYPES)[number]

const MEMORY_SIGNAL_PATTERNS = {
  preference: [
    /以后|后续|记住|记得|默认|偏好|习惯/,
    /\b(remember|prefer|preference|by default|from now on|in future|going forward|always use)\b/i
  ],
  constraint: [
    /必须|不要|不需要|禁止|只能|统一|固定|始终|约束/,
    /\b(you must|must not|don't|do not|never|only|constraint|always|requirement|required)\b/i
  ],
  decision: [
    /确认|决定|按照|采用|改成|回退|删除|保留/,
    /\b(decided|confirm|confirmed|adopt|switch to|change to|revert|remove|keep)\b/i
  ],
  task: [
    /需求|规则|待办|下一步|阶段|计划/,
    /\b(todo|next step|plan|phase|follow up|requirement|rule)\b/i
  ]
} as const

export type AgentStoredMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  selection?: unknown
  agentName?: string
  error?: boolean
  events?: AgentEvent[]
  sequence: number
}

export type AgentStoredSession = {
  id: string
  title: string
  agentId?: string
  createdAt: number
  updatedAt: number
  messageCount: number
  summaryCount: number
  observationCount: number
  latestMessage?: AgentStoredMessage
}

export type AgentSessionDetail = AgentStoredSession & {
  messages: AgentStoredMessage[]
  latestSummary?: AgentContextSummary | null
}

export type AgentContextSummary = {
  id: string
  sessionId: string
  agentId: string
  content: string
  coveredUntilSequence: number
  messageCount: number
  createdAt: number
  updatedAt: number
}

export type AgentRunMemoryContext = {
  systemContext: string
  historyMessages: OpenAI.Chat.ChatCompletionMessageParam[]
  summary?: AgentContextSummary | null
  observations: AgentObservation[]
  stats: {
    summaryCount: number
    observationCount: number
    summarizedMessages: number
    recentMessages: number
    estimatedContextTokens: number
  }
}

export type AgentVectorRecallConfig = {
  enabled: boolean
  mode?: 'inherit' | 'local' | 'online'
  localProfileId?: string
}

export type AgentSessionMemoryState = {
  sessionId: string
  summaryCount: number
  observationCount: number
  summarizedMessages: number
  recentMessages: number
  estimatedContextTokens: number
  latestSummary?: AgentContextSummary | null
}

export type AgentObservation = {
  id: string
  sessionId: string
  agentId?: string
  type: AgentObservationType
  title: string
  content: string
  tags: string[]
  sourceMessageId?: string
  createdAt: number
  updatedAt: number
}

type AgentSessionRow = {
  id: string
  title: string
  agent_id: string | null
  created_at: number
  updated_at: number
}

type AgentMessageRow = {
  id: string
  session_id: string
  role: string
  content: string
  selection_json: string | null
  agent_name: string | null
  error: number
  events_json: string | null
  created_at: number
  sequence: number
}

type AgentSummaryRow = {
  id: string
  session_id: string
  agent_id: string
  content: string
  covered_until_sequence: number
  message_count: number
  created_at: number
  updated_at: number
}

type AgentObservationRow = {
  id: string
  session_id: string
  agent_id: string | null
  type: string
  title: string
  content: string
  content_hash: string
  tags_json: string
  source_message_id: string | null
  created_at: number
  updated_at: number
}

type AgentObservationEmbeddingRow = {
  id: string
  observation_id: string
  model_id: string
  vector_dim: number
  vector_json: string
  content_hash: string
  updated_at: number
}

function nowMs(): number {
  return Date.now()
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function getCacheBasePath(): string {
  const configService = new ConfigService()
  try {
    const cachePath = String(configService.get('cachePath') || '').trim()
    return cachePath || join(process.cwd(), 'cache')
  } finally {
    configService.close()
  }
}

function safeJsonParse(value: string | null | undefined, fallback: unknown): unknown {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function safeJsonStringify(value: unknown): string | null {
  if (value === undefined) return null
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function parseStringArray(value: string | null | undefined): string[] {
  const parsed = safeJsonParse(value, [])
  if (!Array.isArray(parsed)) return []
  return parsed.map((item) => String(item || '').trim()).filter(Boolean)
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function compactText(value: string, limit: number): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}...` : normalized
}

function preserveMarkdownText(value: string, limit: number): string {
  const normalized = String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!normalized) return ''
  return normalized.length > limit ? `${normalized.slice(0, limit - 1).trimEnd()}...` : normalized
}

function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  const otherChars = text.length - chineseChars
  return Math.ceil(chineseChars / 1.5 + otherChars / 4)
}

function titleFromMessage(message: string): string {
  return String(message || '')
    .replace(/(?:#|@|\$|!|\/|t:)\[[^\]]+\]/g, '')
    .replace(/[#@!/$]([^\s]+)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 22) || '新的对话'
}

function toStoredMessage(row: AgentMessageRow): AgentStoredMessage {
  return {
    id: row.id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    createdAt: Number(row.created_at || 0),
    selection: safeJsonParse(row.selection_json, undefined),
    agentName: row.agent_name || undefined,
    error: Boolean(row.error),
    events: safeJsonParse(row.events_json, []) as AgentEvent[],
    sequence: Number(row.sequence || 0)
  }
}

function toSummary(row: AgentSummaryRow): AgentContextSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    content: row.content,
    coveredUntilSequence: Number(row.covered_until_sequence || 0),
    messageCount: Number(row.message_count || 0),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0)
  }
}

function toObservation(row: AgentObservationRow): AgentObservation {
  const type = AGENT_OBSERVATION_TYPES.includes(row.type as AgentObservationType)
    ? row.type as AgentObservationType
    : 'note'
  return {
    id: row.id,
    sessionId: row.session_id,
    agentId: row.agent_id || undefined,
    type,
    title: row.title,
    content: row.content,
    tags: parseStringArray(row.tags_json),
    sourceMessageId: row.source_message_id || undefined,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0)
  }
}

function renderMessagesForSummary(messages: AgentStoredMessage[]): string {
  const lines = messages.map((message) => {
    const role = message.role === 'user' ? '用户' : 'Agent'
    return `[${message.sequence}] ${role}: ${compactText(message.content, 1200)}`
  })
  return preserveMarkdownText(lines.join('\n\n'), SUMMARY_MAX_INPUT_CHARS)
}

function buildSummaryPrompt(input: {
  previousSummary?: AgentContextSummary | null
  messages: AgentStoredMessage[]
}): string {
  return `请为下面的 Agent 对话生成一份“滚动上下文摘要”。

要求：
1. 只保留对后续对话有价值的信息，不要记录无意义寒暄。
2. 保留用户长期偏好、已确认事实、关键结论、待办、未解决问题和重要约束。
3. 如果已有旧摘要，请合并旧摘要与新增消息，输出一份新的完整摘要，不要只摘要新增部分。
4. 这是当前会话的一份滚动快照，不要输出多份历史摘要，也不要写“本轮新增摘要”。
5. 输出 Markdown，结构固定为：请求与目标、已确认信息、已完成、待继续、注意事项。
6. 不要编造未在材料中出现的内容。

旧摘要：
${preserveMarkdownText(input.previousSummary?.content || '无', SUMMARY_MAX_TEXT_CHARS)}

待压缩消息：
${renderMessagesForSummary(input.messages) || '无'}`
}

function buildInjectedContext(input: {
  summary?: AgentContextSummary | null
  observations?: AgentObservation[]
  stats: AgentRunMemoryContext['stats']
}): string {
  const parts: string[] = []
  if (input.summary?.content) {
    parts.push(`### 当前 Agent 会话压缩记忆\n${input.summary.content}`)
  }
  if (input.observations?.length) {
    const lines = input.observations.map((observation, index) => (
      `${index + 1}. [${observation.type}] ${observation.title}\n${compactText(observation.content, 420)}`
    ))
    parts.push(`### 相关长期记忆\n${lines.join('\n\n')}`)
  }
  parts.push(`### 上下文使用说明
- 上面的压缩记忆和最近消息来自当前 Agent 历史会话。
- 相关长期记忆来自当前会话和当前 Agent 的历史沉淀。
- 它们用于保持连续性，但当前用户的新消息优先级最高。
- 如果历史信息与用户当前指令冲突，以当前指令为准。`)
  parts.push(`### 上下文统计
滚动摘要: ${input.stats.summaryCount ? '已生成' : '未生成'}
长期记忆数: ${input.stats.observationCount}
已压缩消息数: ${input.stats.summarizedMessages}
最近原文消息数: ${input.stats.recentMessages}`)
  return parts.join('\n\n')
}

function uniqueStrings(values: unknown[], limit = 8): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const text = String(value || '').replace(/\s+/g, ' ').trim()
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    result.push(text)
    if (result.length >= limit) break
  }
  return result
}

function renderEventsForObservation(events: AgentEvent[]): string {
  const lines: string[] = []
  for (const event of events) {
    if (event.type === 'tool_call') {
      lines.push(`[tool_call] ${event.name || event.toolId}: ${compactText(JSON.stringify(event.args || {}), 900)}`)
    } else if (event.type === 'tool_result') {
      lines.push(`[tool_result] ${event.name || event.toolId}: ${compactText(event.result?.content || event.result?.error || '', 900)}`)
    } else if (event.type === 'thought') {
      lines.push(`[thought] ${compactText(event.content || '', 600)}`)
    }
  }
  return compactText(lines.join('\n'), 8000)
}

function hasExplicitUserMemorySignal(userMessage: string): boolean {
  return Object.values(MEMORY_SIGNAL_PATTERNS)
    .some((patterns) => patterns.some((pattern) => pattern.test(userMessage)))
}

function hasMeaningfulToolMemorySignal(events: AgentEvent[]): boolean {
  return events.some((event) => {
    if (event.type !== 'tool_result') return false
    return Boolean(String(event.result?.error || '').trim())
  })
}

function hasObservationSignal(input: {
  userMessage: string
  assistantText: string
  events: AgentEvent[]
}): boolean {
  const userMessage = String(input.userMessage || '')
  return hasExplicitUserMemorySignal(userMessage) || hasMeaningfulToolMemorySignal(input.events)
}

function inferObservationType(input: { userMessage: string; content: string; events: AgentEvent[] }): AgentObservationType {
  const text = `${input.userMessage}\n${input.content}`
  if (MEMORY_SIGNAL_PATTERNS.preference.some((pattern) => pattern.test(text))) return 'preference'
  if (MEMORY_SIGNAL_PATTERNS.constraint.some((pattern) => pattern.test(text))) return 'constraint'
  if (MEMORY_SIGNAL_PATTERNS.decision.some((pattern) => pattern.test(text))) return 'decision'
  if (MEMORY_SIGNAL_PATTERNS.task.some((pattern) => pattern.test(text))) return 'task'
  if (input.events.some((event) => event.type === 'tool_call' || event.type === 'tool_result')) return 'fact'
  return 'note'
}

function buildFallbackObservationContent(input: {
  userMessage: string
  assistantText: string
  events: AgentEvent[]
}): string {
  if (!hasObservationSignal(input)) return ''
  const sections: string[] = []
  const userMessage = compactText(
    input.userMessage.replace(/(?:#|@|\$|!|\/|t:)\[[^\]]+\]/g, '').trim(),
    700
  )
  if (userMessage) {
    sections.push(`## 用户明确要求\n- ${userMessage}`)
  }
  const eventText = renderEventsForObservation(input.events)
  if (eventText) {
    sections.push(`## 工具与执行线索\n${eventText}`)
  }
  const assistantText = compactText(input.assistantText, 700)
  if (assistantText) {
    sections.push(`## Agent 回应要点\n- ${assistantText}`)
  }
  return compactText(sections.join('\n\n'), OBSERVATION_MAX_CONTENT_CHARS)
}

function normalizeObservationContent(raw: string): string {
  const content = preserveMarkdownText(String(raw || '').replace(/<think>[\s\S]*?<\/think>/g, ''), OBSERVATION_MAX_CONTENT_CHARS)
  if (!content || /^无长期记忆[。.]?$/.test(content)) return ''
  return content
}

function normalizeVectorValues(vector: Float32Array | number[]): number[] {
  const values = Array.from(vector).map((value) => Number(value) || 0)
  let norm = 0
  for (const value of values) norm += value * value
  norm = Math.sqrt(norm) || 1
  return values.map((value) => value / norm)
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length)
  if (!length) return 0
  let score = 0
  for (let index = 0; index < length; index += 1) score += a[index] * b[index]
  return score
}

function parseVectorJson(value: string): number[] {
  const parsed = safeJsonParse(value, [])
  return Array.isArray(parsed) ? parsed.map((item) => Number(item) || 0) : []
}

function observationEmbeddingText(observation: AgentObservation): string {
  return preserveMarkdownText([
    `[${observation.type}] ${observation.title}`,
    observation.content,
    observation.tags.length ? `Tags: ${observation.tags.join(', ')}` : ''
  ].filter(Boolean).join('\n\n'), 2400)
}

function normalizeVectorRecallConfig(config?: AgentVectorRecallConfig): Required<AgentVectorRecallConfig> {
  return {
    enabled: config?.enabled !== false,
    mode: config?.mode === 'local' || config?.mode === 'online' ? config.mode : 'inherit',
    localProfileId: String(config?.localProfileId || '').trim() || 'bge-large-zh-v1.5-int8'
  }
}

function buildObservationExtractionPrompt(input: {
  userMessage: string
  assistantText: string
  events: AgentEvent[]
}): string {
  return `请从下面这次 Agent 对话中整理一份长期记忆 Markdown。

要求：
1. 只记录后续对话仍可能有用的稳定信息，忽略普通寒暄、临时措辞、无价值过程。
2. 不要记录敏感密钥、token、完整隐私内容。
3. 不要编造材料里没有出现的信息。
4. 如果用户用中文或英文表达了偏好、规则、约束、决策、待办、需求变更，必须记录。
5. 如果工具调用暴露了项目事实、错误原因、修复方案、文件位置，也要记录。
6. 如果确实没有值得长期保存的信息，只输出：无长期记忆。
7. 只输出 Markdown 正文，不要 JSON，不要代码块。
8. 建议结构：用户偏好、已确认事实、决策与约束、待继续事项。没有内容的小节可以省略。

用户消息：
${compactText(input.userMessage, 3000)}

工具与思考概要：
${renderEventsForObservation(input.events) || '无'}

Agent 最终回复：
${compactText(input.assistantText, 6000)}`
}

export class AgentSessionStore {
  private db: Database.Database | null = null
  private dbPath: string | null = null

  getDbPath(): string {
    return join(getCacheBasePath(), AGENT_SESSION_DB_NAME)
  }

  getDb(): Database.Database {
    const dbPath = this.getDbPath()
    const dir = dirname(dbPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    if (this.db && this.dbPath === dbPath) return this.db
    if (this.db) this.close()

    const db = new Database(dbPath)
    this.db = db
    this.dbPath = dbPath
    this.ensureSchema(db)
    return db
  }

  close(): void {
    if (!this.db) return
    try {
      this.db.close()
    } finally {
      this.db = null
      this.dbPath = null
    }
  }

  private ensureSchema(db: Database.Database): void {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        agent_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        selection_json TEXT,
        agent_name TEXT,
        error INTEGER NOT NULL DEFAULT 0,
        events_json TEXT,
        created_at INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_context_summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        covered_until_sequence INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_observations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT,
        type TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        source_message_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_observation_embeddings (
        id TEXT PRIMARY KEY,
        observation_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        vector_dim INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(observation_id) REFERENCES agent_observations(id) ON DELETE CASCADE,
        UNIQUE(observation_id, model_id, vector_dim)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated ON agent_sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_messages_session_sequence ON agent_messages(session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_agent_summaries_session ON agent_context_summaries(session_id, covered_until_sequence DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_observations_session ON agent_observations(session_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_observations_agent ON agent_observations(agent_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_observation_embeddings_observation
        ON agent_observation_embeddings(observation_id);
      CREATE INDEX IF NOT EXISTS idx_agent_observation_embeddings_model
        ON agent_observation_embeddings(model_id, vector_dim);
    `)
    this.ensureColumn(db, 'agent_observations', 'content_hash', "TEXT NOT NULL DEFAULT ''")
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_observation_hash
        ON agent_observations(session_id, type, content_hash);
    `)
  }

  private ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (rows.some((row) => row.name === column)) return
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run()
  }

  createSession(input: { title?: string; agentId?: string } = {}): AgentStoredSession {
    const timestamp = nowMs()
    const id = createId('agent-session')
    this.getDb().prepare(`
      INSERT INTO agent_sessions(id, title, agent_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, input.title || '新的对话', input.agentId || null, timestamp, timestamp)
    return this.getSession(id) as AgentStoredSession
  }

  ensureSession(id: string | undefined, input: { agentId?: string; firstMessage?: string } = {}): AgentStoredSession {
    const normalizedId = String(id || '').trim()
    const existing = normalizedId ? this.getSession(normalizedId) : null
    if (existing) return existing
    return this.createSession({
      agentId: input.agentId,
      title: input.firstMessage ? titleFromMessage(input.firstMessage) : '新的对话'
    })
  }

  listSessions(options: { search?: string; limit?: number } = {}): AgentStoredSession[] {
    const db = this.getDb()
    const search = String(options.search || '').trim()
    const limit = Math.max(1, Math.min(Math.floor(options.limit || 40), 200))
    const rows = db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM agent_messages m WHERE m.session_id = s.id) AS message_count,
        (SELECT COUNT(*) FROM agent_context_summaries cs WHERE cs.session_id = s.id) AS summary_count,
        (SELECT COUNT(*) FROM agent_observations ao WHERE ao.session_id = s.id) AS observation_count
      FROM agent_sessions s
      WHERE @search = ''
        OR s.title LIKE @likeSearch
        OR EXISTS (
          SELECT 1 FROM agent_messages sm
          WHERE sm.session_id = s.id AND sm.content LIKE @likeSearch
        )
      ORDER BY s.updated_at DESC
      LIMIT @limit
    `).all({
      search,
      likeSearch: `%${search}%`,
      limit
    }) as Array<AgentSessionRow & { message_count: number; summary_count: number; observation_count: number }>

    return rows.map((row) => {
      const latestMessage = this.getLatestMessage(row.id)
      return {
        id: row.id,
        title: row.title,
        agentId: row.agent_id || undefined,
        createdAt: Number(row.created_at || 0),
        updatedAt: Number(row.updated_at || 0),
        messageCount: Number(row.message_count || 0),
        summaryCount: Number(row.summary_count || 0) > 0 ? 1 : 0,
        observationCount: Number(row.observation_count || 0),
        ...(latestMessage ? { latestMessage } : {})
      }
    })
  }

  getSession(id: string): AgentSessionDetail | null {
    const row = this.getDb().prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as AgentSessionRow | undefined
    if (!row) return null
    const messages = this.listMessages(id)
    const latestSummary = this.getLatestSummary(id)
    return {
      id: row.id,
      title: row.title,
      agentId: row.agent_id || undefined,
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
      messageCount: messages.length,
      summaryCount: latestSummary ? 1 : 0,
      observationCount: this.countObservations(id),
      latestMessage: messages[messages.length - 1],
      messages,
      latestSummary
    }
  }

  updateSession(id: string, patch: { title?: string; agentId?: string | null }): AgentStoredSession | null {
    const current = this.getSession(id)
    if (!current) return null
    const nextTitle = patch.title === undefined ? current.title : String(patch.title || '').trim() || current.title
    const nextAgentId = patch.agentId === undefined ? current.agentId || null : patch.agentId || null
    this.getDb().prepare(`
      UPDATE agent_sessions
      SET title = ?, agent_id = ?, updated_at = ?
      WHERE id = ?
    `).run(nextTitle, nextAgentId, nowMs(), id)
    return this.getSession(id)
  }

  deleteSession(id: string): boolean {
    const result = this.getDb().prepare('DELETE FROM agent_sessions WHERE id = ?').run(id)
    return result.changes > 0
  }

  getMemoryState(sessionId: string): AgentSessionMemoryState {
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId || !this.getSession(normalizedSessionId)) {
      return {
        sessionId: normalizedSessionId,
        summaryCount: 0,
        summarizedMessages: 0,
        recentMessages: 0,
        estimatedContextTokens: 0,
        observationCount: 0,
        latestSummary: null
      }
    }

    const latestSummary = this.getLatestSummary(normalizedSessionId)
    const session = this.getSession(normalizedSessionId)
    const observations = this.listObservations({ sessionId: normalizedSessionId, agentId: session?.agentId, limit: 100 })
    const recentMessages = this.listRecentMessages(normalizedSessionId, RECENT_CONTEXT_MESSAGE_COUNT)
      .filter((message) => message.content.trim() && !message.error)
    const summaryCount = latestSummary ? 1 : 0
    const stats = {
      summaryCount,
      observationCount: observations.length,
      summarizedMessages: latestSummary?.messageCount || 0,
      recentMessages: recentMessages.length,
      estimatedContextTokens: 0
    }
    const systemContext = buildInjectedContext({ summary: latestSummary, observations: observations.slice(0, OBSERVATION_CONTEXT_LIMIT), stats })
    stats.estimatedContextTokens = estimateTokens(`${systemContext}\n${recentMessages.map((message) => message.content).join('\n')}`)
    return {
      sessionId: normalizedSessionId,
      summaryCount,
      observationCount: observations.length,
      summarizedMessages: stats.summarizedMessages,
      recentMessages: stats.recentMessages,
      estimatedContextTokens: stats.estimatedContextTokens,
      latestSummary
    }
  }

  clearSessionSummaries(sessionId: string): number {
    const result = this.getDb().prepare('DELETE FROM agent_context_summaries WHERE session_id = ?')
      .run(String(sessionId || '').trim())
    return result.changes
  }

  listSummaries(sessionId: string): AgentContextSummary[] {
    const rows = this.getDb().prepare(`
      SELECT * FROM agent_context_summaries
      WHERE session_id = ?
      ORDER BY covered_until_sequence DESC, updated_at DESC
      LIMIT 1
    `).all(String(sessionId || '').trim()) as AgentSummaryRow[]
    return rows.map(toSummary)
  }

  updateSummary(id: string, content: string): AgentContextSummary | null {
    const normalizedId = String(id || '').trim()
    const normalizedContent = String(content || '').trim()
    if (!normalizedId || !normalizedContent) return null
    this.getDb().prepare(`
      UPDATE agent_context_summaries
      SET content = ?, updated_at = ?
      WHERE id = ?
    `).run(normalizedContent, nowMs(), normalizedId)
    const row = this.getDb().prepare('SELECT * FROM agent_context_summaries WHERE id = ?')
      .get(normalizedId) as AgentSummaryRow | undefined
    return row ? toSummary(row) : null
  }

  deleteSummary(id: string): { success: boolean; sessionId?: string } {
    const normalizedId = String(id || '').trim()
    const row = this.getDb().prepare('SELECT session_id FROM agent_context_summaries WHERE id = ?')
      .get(normalizedId) as { session_id: string } | undefined
    const result = row
      ? this.getDb().prepare('DELETE FROM agent_context_summaries WHERE session_id = ?').run(row.session_id)
      : this.getDb().prepare('DELETE FROM agent_context_summaries WHERE id = ?').run(normalizedId)
    return { success: result.changes > 0, sessionId: row?.session_id }
  }

  clearSessionObservations(sessionId: string): number {
    const result = this.getDb().prepare('DELETE FROM agent_observations WHERE session_id = ?')
      .run(String(sessionId || '').trim())
    return result.changes
  }

  updateObservation(id: string, patch: { title?: string; content?: string; type?: AgentObservationType; tags?: string[] }): AgentObservation | null {
    const normalizedId = String(id || '').trim()
    const current = this.getDb().prepare('SELECT * FROM agent_observations WHERE id = ?')
      .get(normalizedId) as AgentObservationRow | undefined
    if (!current) return null

    const nextType = AGENT_OBSERVATION_TYPES.includes(patch.type as AgentObservationType)
      ? patch.type as AgentObservationType
      : toObservation(current).type
    const nextTitle = String((patch.title ?? current.title) || '').trim() || current.title
    const nextContent = String((patch.content ?? current.content) || '').trim() || current.content
    const nextTags = Array.isArray(patch.tags) ? uniqueStrings(patch.tags, 8) : parseStringArray(current.tags_json)
    const contentHash = hashText(`${nextType}\n${nextTitle}\n${nextContent}`)
    this.getDb().prepare(`
      UPDATE agent_observations
      SET type = ?, title = ?, content = ?, content_hash = ?, tags_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      nextType,
      nextTitle,
      nextContent,
      contentHash,
      safeJsonStringify(nextTags) || '[]',
      nowMs(),
      normalizedId
    )
    const row = this.getDb().prepare('SELECT * FROM agent_observations WHERE id = ?')
      .get(normalizedId) as AgentObservationRow | undefined
    return row ? toObservation(row) : null
  }

  deleteObservation(id: string): { success: boolean; sessionId?: string } {
    const normalizedId = String(id || '').trim()
    const row = this.getDb().prepare('SELECT session_id FROM agent_observations WHERE id = ?')
      .get(normalizedId) as { session_id: string } | undefined
    const result = this.getDb().prepare('DELETE FROM agent_observations WHERE id = ?').run(normalizedId)
    return { success: result.changes > 0, sessionId: row?.session_id }
  }

  appendMessage(input: {
    sessionId: string
    role: 'user' | 'assistant'
    content: string
    selection?: unknown
    agentName?: string
    error?: boolean
    events?: AgentEvent[]
    createdAt?: number
  }): AgentStoredMessage {
    const db = this.getDb()
    const session = this.getSession(input.sessionId)
    if (!session) throw new Error(`Agent session not found: ${input.sessionId}`)
    const row = db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM agent_messages WHERE session_id = ?')
      .get(input.sessionId) as { next_sequence: number }
    const timestamp = input.createdAt || nowMs()
    const id = createId(input.role)
    db.prepare(`
      INSERT INTO agent_messages(
        id, session_id, role, content, selection_json, agent_name,
        error, events_json, created_at, sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.sessionId,
      input.role,
      input.content,
      safeJsonStringify(input.selection),
      input.agentName || null,
      input.error ? 1 : 0,
      safeJsonStringify(input.events || []),
      timestamp,
      Number(row.next_sequence || 1)
    )
    const nextTitle = session.messageCount === 0 && input.role === 'user'
      ? titleFromMessage(input.content)
      : session.title
    db.prepare('UPDATE agent_sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(nextTitle, timestamp, input.sessionId)
    return this.getMessage(id) as AgentStoredMessage
  }

  async prepareRunContext(options: {
    sessionId: string
    agent: AgentDefinition
    provider: AIProvider
    model: string
    userMessage?: string
    vectorRecall?: AgentVectorRecallConfig
  }): Promise<AgentRunMemoryContext> {
    try {
      await this.ensureCompressedSummary(options)
    } catch (error) {
      console.warn('[AgentSessionStore] 上下文压缩失败，继续使用现有历史:', error)
    }
    const latestSummary = this.getLatestSummary(options.sessionId)
    const observations = await this.searchObservations({
      sessionId: options.sessionId,
      agentId: options.agent.id,
      query: options.userMessage || '',
      limit: OBSERVATION_CONTEXT_LIMIT,
      vectorRecall: options.vectorRecall
    })
    const recentMessages = this.listRecentMessages(options.sessionId, RECENT_CONTEXT_MESSAGE_COUNT)
    const historyMessages = recentMessages
      .filter((message) => message.content.trim() && !message.error)
      .map((message): OpenAI.Chat.ChatCompletionMessageParam => ({
        role: message.role,
        content: message.content
      }))
    const summaryCount = latestSummary ? 1 : 0
    const stats = {
      summaryCount,
      observationCount: observations.length,
      summarizedMessages: latestSummary?.messageCount || 0,
      recentMessages: historyMessages.length,
      estimatedContextTokens: 0
    }
    const systemContext = buildInjectedContext({ summary: latestSummary, observations, stats })
    stats.estimatedContextTokens = estimateTokens(`${systemContext}\n${historyMessages.map((item) => String(item.content || '')).join('\n')}`)
    return {
      systemContext,
      historyMessages,
      summary: latestSummary,
      observations,
      stats
    }
  }

  async extractObservationsFromRun(options: {
    sessionId: string
    agent: AgentDefinition
    provider: AIProvider
    model: string
    userMessage: string
    assistantText: string
    events: AgentEvent[]
    sourceMessageId?: string
    vectorRecall?: AgentVectorRecallConfig
  }): Promise<AgentObservation[]> {
    const meaningfulText = `${options.userMessage}\n${options.assistantText}\n${renderEventsForObservation(options.events)}`
    const shouldExtract = hasObservationSignal(options)
    if (!shouldExtract || estimateTokens(meaningfulText) < OBSERVATION_MIN_TOKEN_COUNT) return []

    let content = ''
    try {
      const raw = await options.provider.chat([
        {
          role: 'system',
          content: '你是 CipherTalk Agent 的长期记忆整理器。你只输出可直接保存的 Markdown 正文。'
        },
        {
          role: 'user',
          content: buildObservationExtractionPrompt({
            userMessage: options.userMessage,
            assistantText: options.assistantText,
            events: options.events
          })
        }
      ], {
        model: options.model,
        temperature: 0.2,
        maxTokens: 1200,
        enableThinking: false
      })
      content = normalizeObservationContent(raw)
    } catch (error) {
      console.warn('[AgentSessionStore] 长期记忆模型抽取失败，尝试规则兜底:', error)
    }

    if (!content && hasObservationSignal(options)) {
      content = buildFallbackObservationContent(options)
    }
    if (!content) return []

    const observation = this.upsertObservation({
      sessionId: options.sessionId,
      agentId: options.agent.id,
      type: inferObservationType({ userMessage: options.userMessage, content, events: options.events }),
      title: titleFromMessage(options.userMessage),
      content,
      tags: [],
      sourceMessageId: options.sourceMessageId
    })
    if (observation) {
      await this.ensureObservationEmbedding(observation, normalizeVectorRecallConfig(options.vectorRecall)).catch((error) => {
        console.warn('[AgentSessionStore] 长期记忆向量化失败，已保留 LIKE 回退:', error)
      })
    }
    return observation ? [observation] : []
  }

  listObservations(options: {
    sessionId?: string
    agentId?: string
    limit?: number
  }): AgentObservation[] {
    const clauses: string[] = []
    const params: Record<string, unknown> = {}
    if (options.sessionId) {
      clauses.push('session_id = @sessionId')
      params.sessionId = options.sessionId
    }
    if (options.agentId) {
      clauses.push('agent_id = @agentId')
      params.agentId = options.agentId
    }
    const limit = Math.max(1, Math.min(Math.floor(options.limit || 100), 500))
    params.limit = limit
    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.getDb().prepare(`
      SELECT * FROM agent_observations
      ${whereSql}
      ORDER BY updated_at DESC
      LIMIT @limit
    `).all(params) as AgentObservationRow[]
    return rows.map(toObservation)
  }

  async searchObservations(options: {
    sessionId: string
    agentId?: string
    query: string
    limit?: number
    vectorRecall?: AgentVectorRecallConfig
  }): Promise<AgentObservation[]> {
    const vectorConfig = normalizeVectorRecallConfig(options.vectorRecall)
    if (vectorConfig.enabled) {
      try {
        const vectorResults = await this.searchObservationsByVector(options, vectorConfig)
        if (vectorResults.length) {
          const fallback = this.searchObservationsByLike(options)
          const seen = new Set(vectorResults.map((item) => item.id))
          return [
            ...vectorResults,
            ...fallback.filter((item) => !seen.has(item.id))
          ].slice(0, Math.max(1, Math.min(Math.floor(options.limit || OBSERVATION_CONTEXT_LIMIT), 50)))
        }
      } catch (error) {
        console.warn('[AgentSessionStore] 长期记忆向量召回不可用，回退 LIKE:', error)
      }
    }
    return this.searchObservationsByLike(options)
  }

  private searchObservationsByLike(options: {
    sessionId: string
    agentId?: string
    query: string
    limit?: number
  }): AgentObservation[] {
    const query = String(options.query || '').replace(/\s+/g, ' ').trim()
    const limit = Math.max(1, Math.min(Math.floor(options.limit || OBSERVATION_CONTEXT_LIMIT), 50))
    const terms = uniqueStrings(
      query
        .replace(/(?:#|@|\$|!|\/|t:)\[[^\]]+\]/g, ' ')
        .split(/[\s,，。！？；:："'“”‘’()[\]{}<>《》]+/)
        .filter((term) => term.length >= 2),
      8
    )

    const params: Record<string, unknown> = {
      sessionId: options.sessionId,
      agentId: options.agentId || '',
      limit
    }

    if (terms.length === 0) {
      const rows = this.getDb().prepare(`
        SELECT *,
          CASE WHEN session_id = @sessionId THEN 10 ELSE 0 END
          + CASE WHEN agent_id = @agentId THEN 4 ELSE 0 END AS scope_score
        FROM agent_observations
        WHERE session_id = @sessionId OR (@agentId != '' AND agent_id = @agentId)
        ORDER BY scope_score DESC, updated_at DESC
        LIMIT @limit
      `).all(params) as AgentObservationRow[]
      return rows.map(toObservation)
    }
    const likeClauses = terms.map((term, index) => {
      params[`term${index}`] = `%${term}%`
      return `(title LIKE @term${index} OR content LIKE @term${index} OR tags_json LIKE @term${index})`
    })
    const rows = this.getDb().prepare(`
      SELECT *,
        CASE WHEN session_id = @sessionId THEN 10 ELSE 0 END
        + CASE WHEN agent_id = @agentId THEN 4 ELSE 0 END AS scope_score
      FROM agent_observations
      WHERE (session_id = @sessionId OR (@agentId != '' AND agent_id = @agentId))
        AND (${likeClauses.join(' OR ')})
      ORDER BY scope_score DESC, updated_at DESC
      LIMIT @limit
    `).all(params) as AgentObservationRow[]
    return rows.map(toObservation)
  }

  private async searchObservationsByVector(
    options: {
      sessionId: string
      agentId?: string
      query: string
      limit?: number
    },
    vectorConfig: Required<AgentVectorRecallConfig>
  ): Promise<AgentObservation[]> {
    const query = String(options.query || '')
      .replace(/(?:#|@|\$|!|\/|t:)\[[^\]]+\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!query || estimateTokens(query) < 2) return []

    const embeddingRuntime = await this.embedAgentMemoryText(query, vectorConfig, 'query')
    const candidates = this.listObservationCandidates({
      sessionId: options.sessionId,
      agentId: options.agentId,
      limit: OBSERVATION_VECTOR_CANDIDATE_LIMIT
    })
    if (!candidates.length) return []

    await this.ensureObservationEmbeddings(candidates, vectorConfig, embeddingRuntime.modelId, embeddingRuntime.dim)
    const embeddings = this.listObservationEmbeddings(candidates.map((item) => item.id), embeddingRuntime.modelId, embeddingRuntime.dim)
    if (!embeddings.length) return []

    const observationById = new Map(candidates.map((item) => [item.id, item]))
    const queryVector = embeddingRuntime.vector
    const limit = Math.max(1, Math.min(Math.floor(options.limit || OBSERVATION_CONTEXT_LIMIT), 50))
    return embeddings
      .map((embedding) => {
        const observation = observationById.get(embedding.observation_id)
        if (!observation) return null
        const score = cosineSimilarity(queryVector, parseVectorJson(embedding.vector_json))
        const scopeBoost = observation.sessionId === options.sessionId ? 0.08 : 0
        return { observation, score: score + scopeBoost }
      })
      .filter((item): item is { observation: AgentObservation; score: number } => Boolean(item && item.score >= OBSERVATION_VECTOR_MIN_SCORE))
      .sort((a, b) => b.score - a.score || b.observation.updatedAt - a.observation.updatedAt)
      .slice(0, limit)
      .map((item) => item.observation)
  }

  private listObservationCandidates(options: {
    sessionId: string
    agentId?: string
    limit: number
  }): AgentObservation[] {
    const rows = this.getDb().prepare(`
      SELECT *,
        CASE WHEN session_id = @sessionId THEN 10 ELSE 0 END
        + CASE WHEN agent_id = @agentId THEN 4 ELSE 0 END AS scope_score
      FROM agent_observations
      WHERE session_id = @sessionId OR (@agentId != '' AND agent_id = @agentId)
      ORDER BY scope_score DESC, updated_at DESC
      LIMIT @limit
    `).all({
      sessionId: options.sessionId,
      agentId: options.agentId || '',
      limit: Math.max(1, Math.min(Math.floor(options.limit), 500))
    }) as AgentObservationRow[]
    return rows.map(toObservation)
  }

  private listObservationEmbeddings(observationIds: string[], modelId: string, dim: number): AgentObservationEmbeddingRow[] {
    const ids = uniqueStrings(observationIds, 500)
    if (!ids.length) return []
    const placeholders = ids.map((_, index) => `@id${index}`).join(',')
    const params: Record<string, unknown> = {
      modelId,
      dim
    }
    ids.forEach((id, index) => {
      params[`id${index}`] = id
    })
    return this.getDb().prepare(`
      SELECT * FROM agent_observation_embeddings
      WHERE observation_id IN (${placeholders})
        AND model_id = @modelId
        AND vector_dim = @dim
    `).all(params) as AgentObservationEmbeddingRow[]
  }

  private async ensureObservationEmbeddings(
    observations: AgentObservation[],
    vectorConfig: Required<AgentVectorRecallConfig>,
    modelId: string,
    dim: number
  ): Promise<void> {
    for (const observation of observations) {
      const contentHash = hashText(observationEmbeddingText(observation))
      const existing = this.getDb().prepare(`
        SELECT id FROM agent_observation_embeddings
        WHERE observation_id = ? AND model_id = ? AND vector_dim = ? AND content_hash = ?
        LIMIT 1
      `).get(observation.id, modelId, dim, contentHash) as { id: string } | undefined
      if (existing) continue
      await this.ensureObservationEmbedding(observation, vectorConfig, { modelId, dim })
    }
  }

  private async ensureObservationEmbedding(
    observation: AgentObservation,
    vectorConfig: Required<AgentVectorRecallConfig>,
    expected?: { modelId: string; dim: number }
  ): Promise<void> {
    if (!vectorConfig.enabled) return
    const content = observationEmbeddingText(observation)
    if (!content) return
    const result = await this.embedAgentMemoryText(content, vectorConfig, 'document')
    if (expected && (result.modelId !== expected.modelId || result.dim !== expected.dim)) return
    this.upsertObservationEmbedding({
      observationId: observation.id,
      modelId: result.modelId,
      dim: result.dim,
      vector: result.vector,
      contentHash: hashText(content)
    })
  }

  private async embedAgentMemoryText(
    text: string,
    config: Required<AgentVectorRecallConfig>,
    inputType: 'query' | 'document'
  ): Promise<{ vector: number[]; modelId: string; dim: number }> {
    let mode = config.mode
    if (mode === 'inherit') {
      const configService = new ConfigService()
      try {
        mode = configService.get('aiEmbeddingMode' as any) === 'online' ? 'online' : 'local'
      } finally {
        configService.close()
      }
    }
    if (mode === 'online') {
      onlineEmbeddingService.ensureReady()
      const vector = await onlineEmbeddingService.embedText(text, { inputType })
      return {
        vector: normalizeVectorValues(vector),
        modelId: onlineEmbeddingService.getVectorModelId(),
        dim: onlineEmbeddingService.getCurrentVectorDim()
      }
    }

    const profileId = config.mode === 'inherit'
      ? localEmbeddingModelService.getCurrentProfileId()
      : config.localProfileId
    const vector = await localEmbeddingModelService.embedText(text, profileId, { inputType })
    return {
      vector: normalizeVectorValues(vector),
      modelId: localEmbeddingModelService.getVectorModelId(profileId),
      dim: localEmbeddingModelService.getCurrentVectorDim(profileId)
    }
  }

  private upsertObservationEmbedding(input: {
    observationId: string
    modelId: string
    dim: number
    vector: number[]
    contentHash: string
  }): void {
    const timestamp = nowMs()
    this.getDb().prepare(`
      INSERT INTO agent_observation_embeddings(
        id, observation_id, model_id, vector_dim, vector_json, content_hash, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(observation_id, model_id, vector_dim) DO UPDATE SET
        vector_json = excluded.vector_json,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
    `).run(
      createId('agent-memory-vector'),
      input.observationId,
      input.modelId,
      input.dim,
      JSON.stringify(input.vector),
      input.contentHash,
      timestamp
    )
  }

  async compressSessionContext(options: {
    sessionId: string
    agent: AgentDefinition
    provider: AIProvider
    model: string
  }): Promise<AgentContextSummary | null> {
    await this.ensureCompressedSummary({ ...options, force: true })
    return this.getLatestSummary(options.sessionId)
  }

  private async ensureCompressedSummary(options: {
    sessionId: string
    agent: AgentDefinition
    provider: AIProvider
    model: string
    force?: boolean
  }): Promise<void> {
    const messages = this.listMessages(options.sessionId).filter((message) => message.content.trim())
    if (!options.force && messages.length < SUMMARY_TRIGGER_MESSAGE_COUNT) return
    if (options.force && messages.length < 3) return

    const keepRecentCount = options.force
      ? Math.min(SUMMARY_KEEP_RECENT_COUNT, Math.max(2, Math.floor(messages.length / 3)))
      : SUMMARY_KEEP_RECENT_COUNT
    const cutoffIndex = Math.max(0, messages.length - keepRecentCount - 1)
    const cutoffSequence = messages[cutoffIndex]?.sequence || 0
    if (!cutoffSequence) return

    const previousSummary = this.getLatestSummary(options.sessionId)
    if (!options.force && previousSummary && previousSummary.coveredUntilSequence >= cutoffSequence) return
    if (
      !options.force
      &&
      previousSummary
      && cutoffSequence - previousSummary.coveredUntilSequence < SUMMARY_STEP_MESSAGE_COUNT
    ) {
      return
    }

    const messagesToSummarize = messages.filter((message) => (
      message.sequence <= cutoffSequence &&
      (!previousSummary || message.sequence > previousSummary.coveredUntilSequence)
    ))
    if (!messagesToSummarize.length && previousSummary) return

    const rawSummary = await options.provider.chat([
      {
        role: 'system',
        content: '你是 CipherTalk Agent 的上下文压缩器。你只做忠实摘要，不编造内容。'
      },
      {
        role: 'user',
        content: buildSummaryPrompt({ previousSummary, messages: messagesToSummarize })
      }
    ], {
      model: options.model,
      temperature: 0.2,
      maxTokens: 1200,
      enableThinking: false
    })

    const content = preserveMarkdownText(rawSummary, SUMMARY_MAX_TEXT_CHARS)
    if (!content) return
    this.upsertRollingSummary({
      sessionId: options.sessionId,
      agentId: options.agent.id,
      content,
      coveredUntilSequence: cutoffSequence,
      messageCount: messages.filter((message) => message.sequence <= cutoffSequence).length
    })
  }

  private upsertRollingSummary(input: {
    sessionId: string
    agentId: string
    content: string
    coveredUntilSequence: number
    messageCount: number
  }): AgentContextSummary {
    const timestamp = nowMs()
    const existing = this.getLatestSummary(input.sessionId)
    if (existing) {
      this.getDb().prepare(`
        UPDATE agent_context_summaries
        SET agent_id = ?, content = ?, covered_until_sequence = ?, message_count = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.agentId,
        input.content,
        input.coveredUntilSequence,
        input.messageCount,
        timestamp,
        existing.id
      )
      this.pruneStaleSummaries(input.sessionId, existing.id)
      return this.getLatestSummary(input.sessionId) as AgentContextSummary
    } else {
      const id = createId('agent-summary')
      this.getDb().prepare(`
        INSERT INTO agent_context_summaries(
          id, session_id, agent_id, content, covered_until_sequence,
          message_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.sessionId,
        input.agentId,
        input.content,
        input.coveredUntilSequence,
        input.messageCount,
        timestamp,
        timestamp
      )
    }
    return this.getLatestSummary(input.sessionId) as AgentContextSummary
  }

  private pruneStaleSummaries(sessionId: string, keepId: string): void {
    this.getDb().prepare(`
      DELETE FROM agent_context_summaries
      WHERE session_id = ? AND id != ?
    `).run(sessionId, keepId)
  }

  private upsertObservation(input: {
    sessionId: string
    agentId?: string
    type: AgentObservationType
    title: string
    content: string
    tags?: string[]
    sourceMessageId?: string
  }): AgentObservation | null {
    const timestamp = nowMs()
    const contentHash = hashText(`${input.type}\n${input.title}\n${input.content}`)
    const existing = this.getDb().prepare(`
      SELECT * FROM agent_observations
      WHERE session_id = ? AND type = ? AND content_hash = ?
      LIMIT 1
    `).get(input.sessionId, input.type, contentHash) as AgentObservationRow | undefined

    if (existing) {
      this.getDb().prepare(`
        UPDATE agent_observations
        SET title = ?, content = ?, tags_json = ?, source_message_id = COALESCE(?, source_message_id), updated_at = ?
        WHERE id = ?
      `).run(
        input.title,
        input.content,
        safeJsonStringify(input.tags || []) || '[]',
        input.sourceMessageId || null,
        timestamp,
        existing.id
      )
      const row = this.getDb().prepare('SELECT * FROM agent_observations WHERE id = ?').get(existing.id) as AgentObservationRow | undefined
      return row ? toObservation(row) : null
    }

    const id = createId('agent-memory')
    this.getDb().prepare(`
      INSERT INTO agent_observations(
        id, session_id, agent_id, type, title, content, content_hash,
        tags_json, source_message_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.sessionId,
      input.agentId || null,
      input.type,
      input.title,
      input.content,
      contentHash,
      safeJsonStringify(input.tags || []) || '[]',
      input.sourceMessageId || null,
      timestamp,
      timestamp
    )
    const row = this.getDb().prepare('SELECT * FROM agent_observations WHERE id = ?').get(id) as AgentObservationRow | undefined
    return row ? toObservation(row) : null
  }

  private getMessage(id: string): AgentStoredMessage | null {
    const row = this.getDb().prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as AgentMessageRow | undefined
    return row ? toStoredMessage(row) : null
  }

  private getLatestMessage(sessionId: string): AgentStoredMessage | null {
    const row = this.getDb().prepare(`
      SELECT * FROM agent_messages
      WHERE session_id = ?
      ORDER BY sequence DESC
      LIMIT 1
    `).get(sessionId) as AgentMessageRow | undefined
    return row ? toStoredMessage(row) : null
  }

  private listMessages(sessionId: string): AgentStoredMessage[] {
    const rows = this.getDb().prepare(`
      SELECT * FROM agent_messages
      WHERE session_id = ?
      ORDER BY sequence ASC
    `).all(sessionId) as AgentMessageRow[]
    return rows.map(toStoredMessage)
  }

  truncateMessagesAfter(sessionId: string, messageSequence: number): number {
    const result = this.getDb().prepare(`
      DELETE FROM agent_messages
      WHERE session_id = ? AND sequence >= ?
    `).run(sessionId, messageSequence)
    this.getDb().prepare('UPDATE agent_sessions SET updated_at = ? WHERE id = ?')
      .run(nowMs(), sessionId)
    return result.changes
  }

  private listRecentMessages(sessionId: string, limit: number): AgentStoredMessage[] {
    const rows = this.getDb().prepare(`
      SELECT * FROM agent_messages
      WHERE session_id = ?
      ORDER BY sequence DESC
      LIMIT ?
    `).all(sessionId, limit) as AgentMessageRow[]
    return rows.map(toStoredMessage).reverse()
  }

  private getLatestSummary(sessionId: string): AgentContextSummary | null {
    const row = this.getDb().prepare(`
      SELECT * FROM agent_context_summaries
      WHERE session_id = ?
      ORDER BY covered_until_sequence DESC, updated_at DESC
      LIMIT 1
    `).get(sessionId) as AgentSummaryRow | undefined
    return row ? toSummary(row) : null
  }

  private countObservations(sessionId: string): number {
    const row = this.getDb().prepare('SELECT COUNT(*) AS count FROM agent_observations WHERE session_id = ?')
      .get(sessionId) as { count: number } | undefined
    return Number(row?.count || 0)
  }
}

export const agentSessionStore = new AgentSessionStore()
