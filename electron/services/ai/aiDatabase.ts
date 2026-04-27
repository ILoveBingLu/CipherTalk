import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import type {
  AnalysisBlock,
  ExtractedStructuredAnalysis,
  StructuredAnalysis,
  SummaryEvidenceRef
} from '../ai-agent/types/analysis'
import { parseStoredStructuredAnalysis } from '../ai-agent/types/analysis'
import type {
  SessionQAConversationDetail,
  SessionQAConversationSummary,
  SessionQAConversationTitleStatus,
  SessionQAMessageRecord,
  SessionQAProgressEvent,
  SessionQAResult,
  SessionQAToolCall
} from '../../../src/types/ai'

type AnalysisRunStatus =
  | 'completed'
  | 'fallback_legacy'
  | 'backfill_facts_only'
  | 'legacy_placeholder'

type AnalysisSourceKind =
  | 'generate_summary'
  | 'generate_summary_legacy'
  | 'backfill_structured'
  | 'backfill_legacy'

export interface SaveAnalysisArtifactsInput {
  summaryId: number
  sessionId: string
  timeRangeStart: number
  timeRangeEnd: number
  timeRangeDays: number
  rawMessageCount: number
  effectiveMessageCount?: number
  blockCount: number
  provider: string
  model: string
  status: AnalysisRunStatus
  sourceKind: AnalysisSourceKind
  evidenceResolved: boolean
  blocksAvailable: boolean
  blocks?: AnalysisBlock[]
  blockAnalyses?: ExtractedStructuredAnalysis[]
  finalAnalysis?: StructuredAnalysis
  createdAt?: number
  updatedAt?: number
}

export interface AnalysisMemoryBlockRow {
  id: number
  runId: number
  summaryId: number
  sessionId: string
  blockIndex: number
  blockId: string
  startTime: number
  endTime: number
  messageCount: number
  charCount: number
  renderedText: string
  messagesJson: string
  extractedResultJson?: string | null
  createdAt: number
  updatedAt: number
}

export interface AnalysisMemoryFactRow {
  id: number
  runId: number
  summaryId: number
  sessionId: string
  factType: string
  factKey: string
  sortOrder: number
  displayText: string
  confidence: number | null
  importance: number | null
  severity: string | null
  owner: string | null
  deadline: string | null
  status: string | null
  eventDate: string | null
  payloadJson: string
  timeRangeStart: number
  timeRangeEnd: number
  evidenceRefs: SummaryEvidenceRef[]
  createdAt: number
  updatedAt: number
}

interface SummaryBackfillRow {
  id: number
  session_id: string
  time_range_start: number
  time_range_end: number
  time_range_days: number
  message_count: number
  provider: string
  model: string
  created_at: number
  structured_result_json?: string | null
}

interface FactRecord {
  factType: 'topic' | 'decision' | 'todo' | 'risk' | 'event' | 'open_question'
  factKey: string
  sortOrder: number
  displayText: string
  confidence?: number
  importance?: number
  severity?: string
  owner?: string
  deadline?: string
  status?: string
  eventDate?: string
  payloadJson: string
  evidenceRefs: SummaryEvidenceRef[]
}

const ANALYSIS_STORAGE_BOOTSTRAP_KEY = 'analysis_storage_bootstrap_v1_completed'

function normalizeComparableText(value?: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？；：、“”‘’（）【】《》,.!?:;"'()\-_/\\[\]{}]+/g, '')
}

function hasAnyEvidenceRefs(analysis?: StructuredAnalysis): boolean {
  if (!analysis) return false

  return [
    ...analysis.decisions,
    ...analysis.todos,
    ...analysis.risks,
    ...analysis.events
  ].some((item) => item.evidenceRefs.length > 0)
}

function buildTopicFactRecords(analysis: StructuredAnalysis): FactRecord[] {
  return analysis.topics.map((item, index) => ({
    factType: 'topic',
    factKey: normalizeComparableText(item.name),
    sortOrder: index,
    displayText: item.name,
    importance: item.importance,
    payloadJson: JSON.stringify(item),
    evidenceRefs: []
  }))
}

function buildDecisionFactRecords(analysis: StructuredAnalysis): FactRecord[] {
  return analysis.decisions.map((item, index) => ({
    factType: 'decision',
    factKey: normalizeComparableText(item.text),
    sortOrder: index,
    displayText: item.text,
    confidence: item.confidence,
    payloadJson: JSON.stringify(item),
    evidenceRefs: item.evidenceRefs
  }))
}

function buildTodoFactRecords(analysis: StructuredAnalysis): FactRecord[] {
  return analysis.todos.map((item, index) => ({
    factType: 'todo',
    factKey: `${normalizeComparableText(item.owner)}|${normalizeComparableText(item.task)}|${normalizeComparableText(item.deadline)}`,
    sortOrder: index,
    displayText: item.task,
    confidence: item.confidence,
    owner: item.owner,
    deadline: item.deadline,
    status: item.status,
    payloadJson: JSON.stringify(item),
    evidenceRefs: item.evidenceRefs
  }))
}

function buildRiskFactRecords(analysis: StructuredAnalysis): FactRecord[] {
  return analysis.risks.map((item, index) => ({
    factType: 'risk',
    factKey: normalizeComparableText(item.text),
    sortOrder: index,
    displayText: item.text,
    confidence: item.confidence,
    severity: item.severity,
    payloadJson: JSON.stringify(item),
    evidenceRefs: item.evidenceRefs
  }))
}

function buildEventFactRecords(analysis: StructuredAnalysis): FactRecord[] {
  return analysis.events.map((item, index) => ({
    factType: 'event',
    factKey: `${normalizeComparableText(item.text)}|${normalizeComparableText(item.date)}`,
    sortOrder: index,
    displayText: item.text,
    confidence: item.confidence,
    eventDate: item.date,
    payloadJson: JSON.stringify(item),
    evidenceRefs: item.evidenceRefs
  }))
}

function buildOpenQuestionFactRecords(analysis: StructuredAnalysis): FactRecord[] {
  return analysis.openQuestions.map((item, index) => ({
    factType: 'open_question',
    factKey: normalizeComparableText(item.text),
    sortOrder: index,
    displayText: item.text,
    payloadJson: JSON.stringify(item),
    evidenceRefs: []
  }))
}

function buildFactRecords(analysis?: StructuredAnalysis): FactRecord[] {
  if (!analysis) {
    return []
  }

  return [
    ...buildTopicFactRecords(analysis),
    ...buildDecisionFactRecords(analysis),
    ...buildTodoFactRecords(analysis),
    ...buildRiskFactRecords(analysis),
    ...buildEventFactRecords(analysis),
    ...buildOpenQuestionFactRecords(analysis)
  ].filter((item) => item.factKey && item.displayText)
}

/**
 * AI 专用数据库管理
 */
export class AIDatabase {
  private db: Database.Database | null = null
  private dbPath: string | null = null

  /**
   * 初始化数据库
   */
  init(cachePath: string, wxid: string): void {
    void wxid

    this.dbPath = join(cachePath, 'ai_summary.db')

    const dir = dirname(this.dbPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    this.db = new Database(this.dbPath)
    this.createTables()

    try {
      this.bootstrapAnalysisStorageBackfill()
      this.catchUpMissingAnalysisRuns()
    } catch (error) {
      console.warn('[AIDatabase] 分析存储回填初始化失败，将在后续启动继续补录:', error)
    }
  }

  /**
   * 创建表结构
   */
  private createTables(): void {
    if (!this.db) return

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        time_range_start INTEGER NOT NULL,
        time_range_end INTEGER NOT NULL,
        time_range_days INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        summary_text TEXT NOT NULL,
        tokens_used INTEGER,
        cost REAL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id);
      CREATE INDEX IF NOT EXISTS idx_summaries_created ON summaries(created_at);
      CREATE INDEX IF NOT EXISTS idx_summaries_time_range ON summaries(time_range_start, time_range_end);

      CREATE TABLE IF NOT EXISTS usage_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        total_tokens INTEGER DEFAULT 0,
        total_cost REAL DEFAULT 0,
        request_count INTEGER DEFAULT 0,
        UNIQUE(date, provider, model)
      );

      CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_stats(date);

      CREATE TABLE IF NOT EXISTS summary_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cache_key TEXT UNIQUE NOT NULL,
        summary_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (summary_id) REFERENCES summaries(id)
      );

      CREATE INDEX IF NOT EXISTS idx_cache_key ON summary_cache(cache_key);
      CREATE INDEX IF NOT EXISTS idx_cache_expires ON summary_cache(expires_at);

      CREATE TABLE IF NOT EXISTS db_meta (
        meta_key TEXT PRIMARY KEY,
        meta_value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS analysis_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        summary_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        time_range_start INTEGER NOT NULL,
        time_range_end INTEGER NOT NULL,
        time_range_days INTEGER NOT NULL,
        raw_message_count INTEGER NOT NULL,
        effective_message_count INTEGER,
        block_count INTEGER NOT NULL DEFAULT 0,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        evidence_resolved INTEGER NOT NULL DEFAULT 0,
        blocks_available INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_runs_summary ON analysis_runs(summary_id);
      CREATE INDEX IF NOT EXISTS idx_analysis_runs_session ON analysis_runs(session_id);

      CREATE TABLE IF NOT EXISTS analysis_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        block_index INTEGER NOT NULL,
        block_id TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        char_count INTEGER NOT NULL,
        rendered_text TEXT NOT NULL,
        messages_json TEXT NOT NULL,
        extracted_result_json TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_blocks_run_block ON analysis_blocks(run_id, block_index);
      CREATE INDEX IF NOT EXISTS idx_analysis_blocks_run ON analysis_blocks(run_id);

      CREATE TABLE IF NOT EXISTS extracted_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        fact_type TEXT NOT NULL,
        fact_key TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        display_text TEXT NOT NULL,
        confidence REAL,
        importance REAL,
        severity TEXT,
        owner TEXT,
        deadline TEXT,
        status TEXT,
        event_date TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_extracted_facts_run_type_key ON extracted_facts(run_id, fact_type, fact_key);
      CREATE INDEX IF NOT EXISTS idx_extracted_facts_run_sort ON extracted_facts(run_id, fact_type, sort_order);

      CREATE TABLE IF NOT EXISTS evidence_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fact_id INTEGER NOT NULL,
        run_id INTEGER NOT NULL,
        evidence_order INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        local_id INTEGER NOT NULL,
        create_time INTEGER NOT NULL,
        sort_seq INTEGER NOT NULL,
        sender_username TEXT,
        sender_display_name TEXT,
        preview_text TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_links_fact_message ON evidence_links(fact_id, local_id, create_time, sort_seq);
      CREATE INDEX IF NOT EXISTS idx_evidence_links_run ON evidence_links(run_id);

      CREATE TABLE IF NOT EXISTS qa_conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        session_name TEXT,
        title TEXT NOT NULL DEFAULT '新对话',
        title_status TEXT NOT NULL DEFAULT 'pending',
        linked_summary_id INTEGER,
        provider TEXT,
        model TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_message_at INTEGER NOT NULL,
        deleted_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_qa_conversations_session ON qa_conversations(session_id, deleted_at, last_message_at);
      CREATE INDEX IF NOT EXISTS idx_qa_conversations_updated ON qa_conversations(updated_at);

      CREATE TABLE IF NOT EXISTS qa_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        think_content TEXT,
        error TEXT,
        result_json TEXT,
        evidence_refs_json TEXT,
        tool_calls_json TEXT,
        progress_events_json TEXT,
        tokens_used INTEGER,
        cost REAL,
        provider TEXT,
        model TEXT,
        request_id TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES qa_conversations(id)
      );

      CREATE INDEX IF NOT EXISTS idx_qa_messages_conversation ON qa_messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_qa_messages_request ON qa_messages(request_id);
    `)

    try {
      this.db.exec("ALTER TABLE summaries ADD COLUMN prompt_text TEXT")
    } catch (e) {
      // 忽略错误，列已存在
    }

    try {
      this.db.exec("ALTER TABLE summaries ADD COLUMN custom_name TEXT")
    } catch (e) {
      // 忽略错误，列已存在
    }

    try {
      this.db.exec("ALTER TABLE summaries ADD COLUMN structured_result_json TEXT")
    } catch (e) {
      // 忽略错误，列已存在
    }

    try {
      this.db.exec("ALTER TABLE qa_messages ADD COLUMN progress_events_json TEXT")
    } catch (e) {
      // 忽略错误，列已存在
    }
  }

  /**
   * 获取数据库实例
   */
  getDb(): Database.Database {
    if (!this.db) {
      throw new Error('数据库未初始化')
    }
    return this.db
  }

  /**
   * 保存摘要
   */
  saveSummary(summary: {
    sessionId: string
    timeRangeStart: number
    timeRangeEnd: number
    timeRangeDays: number
    messageCount: number
    summaryText: string
    tokensUsed: number
    cost: number
    provider: string
    model: string
    promptText?: string
    structuredResultJson?: string
    createdAt?: number
  }): number {
    const db = this.getDb()
    const createdAt = summary.createdAt || Date.now()

    console.log('[AIDatabase] 保存摘要:', {
      sessionId: summary.sessionId,
      timeRangeDays: summary.timeRangeDays,
      messageCount: summary.messageCount,
      provider: summary.provider,
      model: summary.model
    })

    const result = db.prepare(`
      INSERT INTO summaries (
        session_id, time_range_start, time_range_end, time_range_days,
        message_count, summary_text, tokens_used, cost,
        provider, model, created_at, prompt_text, structured_result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      summary.sessionId,
      summary.timeRangeStart,
      summary.timeRangeEnd,
      summary.timeRangeDays,
      summary.messageCount,
      summary.summaryText,
      summary.tokensUsed,
      summary.cost,
      summary.provider,
      summary.model,
      createdAt,
      summary.promptText || '',
      summary.structuredResultJson || null
    )

    console.log('[AIDatabase] 摘要已保存，ID:', result.lastInsertRowid)

    return result.lastInsertRowid as number
  }

  saveAnalysisArtifacts(input: SaveAnalysisArtifactsInput): void {
    const db = this.getDb()

    const saveTx = db.transaction((payload: SaveAnalysisArtifactsInput) => {
      const createdAt = payload.createdAt || Date.now()
      const updatedAt = payload.updatedAt || createdAt

      const existingRun = db.prepare(`
        SELECT id FROM analysis_runs WHERE summary_id = ?
      `).get(payload.summaryId) as { id: number } | undefined

      let runId = existingRun?.id

      if (runId) {
        db.prepare('DELETE FROM evidence_links WHERE run_id = ?').run(runId)
        db.prepare('DELETE FROM extracted_facts WHERE run_id = ?').run(runId)
        db.prepare('DELETE FROM analysis_blocks WHERE run_id = ?').run(runId)

        db.prepare(`
          UPDATE analysis_runs
          SET
            session_id = ?,
            time_range_start = ?,
            time_range_end = ?,
            time_range_days = ?,
            raw_message_count = ?,
            effective_message_count = ?,
            block_count = ?,
            provider = ?,
            model = ?,
            status = ?,
            source_kind = ?,
            evidence_resolved = ?,
            blocks_available = ?,
            updated_at = ?
          WHERE id = ?
        `).run(
          payload.sessionId,
          payload.timeRangeStart,
          payload.timeRangeEnd,
          payload.timeRangeDays,
          payload.rawMessageCount,
          payload.effectiveMessageCount ?? null,
          payload.blockCount,
          payload.provider,
          payload.model,
          payload.status,
          payload.sourceKind,
          payload.evidenceResolved ? 1 : 0,
          payload.blocksAvailable ? 1 : 0,
          updatedAt,
          runId
        )
      } else {
        const result = db.prepare(`
          INSERT INTO analysis_runs (
            summary_id, session_id, time_range_start, time_range_end, time_range_days,
            raw_message_count, effective_message_count, block_count,
            provider, model, status, source_kind,
            evidence_resolved, blocks_available, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          payload.summaryId,
          payload.sessionId,
          payload.timeRangeStart,
          payload.timeRangeEnd,
          payload.timeRangeDays,
          payload.rawMessageCount,
          payload.effectiveMessageCount ?? null,
          payload.blockCount,
          payload.provider,
          payload.model,
          payload.status,
          payload.sourceKind,
          payload.evidenceResolved ? 1 : 0,
          payload.blocksAvailable ? 1 : 0,
          createdAt,
          updatedAt
        )

        runId = result.lastInsertRowid as number
      }

      if (payload.blocksAvailable && payload.blocks?.length) {
        const insertBlock = db.prepare(`
          INSERT INTO analysis_blocks (
            run_id, block_index, block_id, start_time, end_time,
            message_count, char_count, rendered_text, messages_json, extracted_result_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)

        payload.blocks.forEach((block, index) => {
          insertBlock.run(
            runId,
            index,
            block.blockId,
            block.startTime,
            block.endTime,
            block.messageCount,
            block.charCount,
            block.renderedText,
            JSON.stringify(block.messages),
            payload.blockAnalyses?.[index] ? JSON.stringify(payload.blockAnalyses[index]) : null
          )
        })
      }

      const factRecords = buildFactRecords(payload.finalAnalysis)
      if (factRecords.length > 0) {
        const insertFact = db.prepare(`
          INSERT INTO extracted_facts (
            run_id, fact_type, fact_key, sort_order, display_text,
            confidence, importance, severity, owner, deadline, status, event_date, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)

        const insertEvidenceLink = db.prepare(`
          INSERT INTO evidence_links (
            fact_id, run_id, evidence_order, session_id, local_id, create_time,
            sort_seq, sender_username, sender_display_name, preview_text
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)

        for (const factRecord of factRecords) {
          const factResult = insertFact.run(
            runId,
            factRecord.factType,
            factRecord.factKey,
            factRecord.sortOrder,
            factRecord.displayText,
            factRecord.confidence ?? null,
            factRecord.importance ?? null,
            factRecord.severity ?? null,
            factRecord.owner ?? null,
            factRecord.deadline ?? null,
            factRecord.status ?? null,
            factRecord.eventDate ?? null,
            factRecord.payloadJson
          )

          const factId = factResult.lastInsertRowid as number
          factRecord.evidenceRefs.forEach((evidenceRef, evidenceIndex) => {
            insertEvidenceLink.run(
              factId,
              runId,
              evidenceIndex,
              evidenceRef.sessionId,
              evidenceRef.localId,
              evidenceRef.createTime,
              evidenceRef.sortSeq,
              evidenceRef.senderUsername ?? null,
              evidenceRef.senderDisplayName ?? null,
              evidenceRef.previewText
            )
          })
        }
      }
    })

    saveTx(input)
  }

  bootstrapAnalysisStorageBackfill(): void {
    const db = this.getDb()
    const bootstrapCompleted = this.getMetaValue(ANALYSIS_STORAGE_BOOTSTRAP_KEY)

    if (bootstrapCompleted === '1') {
      return
    }

    const insertedCount = this.backfillMissingAnalysisRuns()
    this.setMetaValue(ANALYSIS_STORAGE_BOOTSTRAP_KEY, '1')
    console.log('[AIDatabase] analysis storage bootstrap backfill 完成:', { insertedCount })
  }

  catchUpMissingAnalysisRuns(): void {
    const insertedCount = this.backfillMissingAnalysisRuns()
    if (insertedCount > 0) {
      console.log('[AIDatabase] analysis storage catch-up 完成:', { insertedCount })
    }
  }

  /**
   * 保存缓存
   */
  saveCache(cacheKey: string, summaryId: number, expiresAt: number): void {
    const db = this.getDb()

    db.prepare(`
      INSERT OR REPLACE INTO summary_cache (cache_key, summary_id, expires_at)
      VALUES (?, ?, ?)
    `).run(cacheKey, summaryId, expiresAt)
  }

  /**
   * 获取缓存的摘要
   */
  getCachedSummary(cacheKey: string): any | null {
    const db = this.getDb()
    const now = Date.now()

    const row: any = db.prepare(`
      SELECT s.* FROM summaries s
      JOIN summary_cache c ON s.id = c.summary_id
      WHERE c.cache_key = ? AND c.expires_at > ?
    `).get(cacheKey, now)

    if (!row) return null

    return {
      id: row.id,
      sessionId: row.session_id,
      timeRangeStart: row.time_range_start,
      timeRangeEnd: row.time_range_end,
      timeRangeDays: row.time_range_days,
      messageCount: row.message_count,
      summaryText: row.summary_text,
      tokensUsed: row.tokens_used,
      cost: row.cost,
      provider: row.provider,
      model: row.model,
      createdAt: row.created_at,
      promptText: row.prompt_text,
      structuredAnalysis: this.parseStructuredAnalysisColumn(row.structured_result_json)
    }
  }

  /**
   * 更新使用统计
   */
  updateUsageStats(provider: string, model: string, tokens: number, cost: number): void {
    const db = this.getDb()
    const date = new Date().toISOString().split('T')[0]

    db.prepare(`
      INSERT INTO usage_stats (date, provider, model, total_tokens, total_cost, request_count)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(date, provider, model) DO UPDATE SET
        total_tokens = total_tokens + excluded.total_tokens,
        total_cost = total_cost + excluded.total_cost,
        request_count = request_count + 1
    `).run(date, provider, model, tokens, cost)
  }

  /**
   * 获取使用统计
   */
  getUsageStats(startDate?: string, endDate?: string): any[] {
    const db = this.getDb()

    let query = 'SELECT * FROM usage_stats'
    const params: any[] = []

    if (startDate && endDate) {
      query += ' WHERE date >= ? AND date <= ?'
      params.push(startDate, endDate)
    } else if (startDate) {
      query += ' WHERE date >= ?'
      params.push(startDate)
    } else if (endDate) {
      query += ' WHERE date <= ?'
      params.push(endDate)
    }

    query += ' ORDER BY date DESC'

    return db.prepare(query).all(...params)
  }

  /**
   * 获取会话的摘要历史
   */
  getSummaryHistory(sessionId: string, limit: number = 10): Array<{
    id: number
    sessionId: string
    timeRangeStart: number
    timeRangeEnd: number
    timeRangeDays: number
    messageCount: number
    summaryText: string
    tokensUsed: number
    cost: number
    provider: string
    model: string
    createdAt: number
    promptText?: string
    customName?: string
    structuredAnalysis?: StructuredAnalysis
  }> {
    const db = this.getDb()

    console.log('[AIDatabase] 查询历史记录:', { sessionId, limit })

    const rows = db.prepare(`
      SELECT * FROM summaries
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(sessionId, limit)

    console.log('[AIDatabase] 查询到', rows.length, '条历史记录')

    return rows.map((row: any) => ({
      id: row.id,
      sessionId: row.session_id,
      timeRangeStart: row.time_range_start,
      timeRangeEnd: row.time_range_end,
      timeRangeDays: row.time_range_days,
      messageCount: row.message_count,
      summaryText: row.summary_text,
      tokensUsed: row.tokens_used,
      cost: row.cost,
      provider: row.provider,
      model: row.model,
      createdAt: row.created_at,
      promptText: row.prompt_text,
      customName: row.custom_name,
      structuredAnalysis: this.parseStructuredAnalysisColumn(row.structured_result_json)
    }))
  }

  listAnalysisMemoryBlocks(sessionId: string): AnalysisMemoryBlockRow[] {
    const db = this.getDb()
    const rows = db.prepare(`
      SELECT
        b.id,
        b.run_id,
        r.summary_id,
        r.session_id,
        b.block_index,
        b.block_id,
        b.start_time,
        b.end_time,
        b.message_count,
        b.char_count,
        b.rendered_text,
        b.messages_json,
        b.extracted_result_json,
        r.created_at,
        r.updated_at
      FROM analysis_blocks b
      JOIN analysis_runs r ON r.id = b.run_id
      WHERE r.session_id = ?
      ORDER BY r.created_at ASC, b.block_index ASC, b.id ASC
    `).all(sessionId) as any[]

    return rows.map((row) => ({
      id: Number(row.id || 0),
      runId: Number(row.run_id || 0),
      summaryId: Number(row.summary_id || 0),
      sessionId: row.session_id,
      blockIndex: Number(row.block_index || 0),
      blockId: String(row.block_id || ''),
      startTime: Number(row.start_time || 0),
      endTime: Number(row.end_time || 0),
      messageCount: Number(row.message_count || 0),
      charCount: Number(row.char_count || 0),
      renderedText: String(row.rendered_text || ''),
      messagesJson: String(row.messages_json || '[]'),
      extractedResultJson: row.extracted_result_json ?? null,
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0)
    }))
  }

  listAnalysisMemoryFacts(sessionId: string): AnalysisMemoryFactRow[] {
    const db = this.getDb()
    const rows = db.prepare(`
      SELECT
        f.id,
        f.run_id,
        r.summary_id,
        r.session_id,
        f.fact_type,
        f.fact_key,
        f.sort_order,
        f.display_text,
        f.confidence,
        f.importance,
        f.severity,
        f.owner,
        f.deadline,
        f.status,
        f.event_date,
        f.payload_json,
        r.time_range_start,
        r.time_range_end,
        r.created_at,
        r.updated_at
      FROM extracted_facts f
      JOIN analysis_runs r ON r.id = f.run_id
      WHERE r.session_id = ?
      ORDER BY r.created_at ASC, f.sort_order ASC, f.id ASC
    `).all(sessionId) as any[]

    const evidenceRows = db.prepare(`
      SELECT *
      FROM evidence_links
      WHERE fact_id = ?
      ORDER BY evidence_order ASC, id ASC
    `)

    return rows.map((row) => {
      const evidence = evidenceRows.all(row.id) as any[]
      return {
        id: Number(row.id || 0),
        runId: Number(row.run_id || 0),
        summaryId: Number(row.summary_id || 0),
        sessionId: row.session_id,
        factType: String(row.fact_type || ''),
        factKey: String(row.fact_key || ''),
        sortOrder: Number(row.sort_order || 0),
        displayText: String(row.display_text || ''),
        confidence: row.confidence == null ? null : Number(row.confidence),
        importance: row.importance == null ? null : Number(row.importance),
        severity: row.severity ?? null,
        owner: row.owner ?? null,
        deadline: row.deadline ?? null,
        status: row.status ?? null,
        eventDate: row.event_date ?? null,
        payloadJson: String(row.payload_json || '{}'),
        timeRangeStart: Number(row.time_range_start || 0),
        timeRangeEnd: Number(row.time_range_end || 0),
        evidenceRefs: evidence.map((item) => ({
          sessionId: String(item.session_id || row.session_id || ''),
          localId: Number(item.local_id || 0),
          createTime: Number(item.create_time || 0),
          sortSeq: Number(item.sort_seq || 0),
          senderUsername: item.sender_username || undefined,
          senderDisplayName: item.sender_display_name || undefined,
          previewText: String(item.preview_text || '')
        })),
        createdAt: Number(row.created_at || 0),
        updatedAt: Number(row.updated_at || 0)
      }
    })
  }

  /**
   * 删除摘要
   */
  deleteSummary(id: number): boolean {
    const db = this.getDb()

    try {
      const deleteTx = db.transaction((summaryId: number) => {
        db.prepare('DELETE FROM summary_cache WHERE summary_id = ?').run(summaryId)
        db.prepare(`
          DELETE FROM evidence_links
          WHERE run_id IN (SELECT id FROM analysis_runs WHERE summary_id = ?)
        `).run(summaryId)
        db.prepare(`
          DELETE FROM extracted_facts
          WHERE run_id IN (SELECT id FROM analysis_runs WHERE summary_id = ?)
        `).run(summaryId)
        db.prepare(`
          DELETE FROM analysis_blocks
          WHERE run_id IN (SELECT id FROM analysis_runs WHERE summary_id = ?)
        `).run(summaryId)
        db.prepare('DELETE FROM analysis_runs WHERE summary_id = ?').run(summaryId)
        return db.prepare('DELETE FROM summaries WHERE id = ?').run(summaryId)
      })

      const result = deleteTx(id)
      return result.changes > 0
    } catch (e) {
      console.error('[AIDatabase] 删除摘要失败:', e)
      return false
    }
  }

  /**
   * 重命名摘要
   */
  renameSummary(id: number, customName: string): boolean {
    const db = this.getDb()

    try {
      const result = db.prepare('UPDATE summaries SET custom_name = ? WHERE id = ?').run(customName, id)
      return result.changes > 0
    } catch (e) {
      console.error('[AIDatabase] 重命名摘要失败:', e)
      return false
    }
  }

  createSessionQAConversation(input: {
    sessionId: string
    sessionName?: string
    linkedSummaryId?: number
    provider?: string
    model?: string
  }): SessionQAConversationSummary {
    const db = this.getDb()
    const now = Date.now()
    const result = db.prepare(`
      INSERT INTO qa_conversations (
        session_id, session_name, title, title_status, linked_summary_id,
        provider, model, created_at, updated_at, last_message_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sessionId,
      input.sessionName || null,
      '新对话',
      'pending',
      input.linkedSummaryId ?? null,
      input.provider || null,
      input.model || null,
      now,
      now,
      now
    )

    return this.getSessionQAConversationSummary(result.lastInsertRowid as number)!
  }

  listSessionQAConversations(sessionId: string, limit: number = 30): SessionQAConversationSummary[] {
    const db = this.getDb()
    const normalizedLimit = Math.max(1, Math.min(100, Math.floor(limit || 30)))
    const rows = db.prepare(`
      SELECT
        c.*,
        (
          SELECT COUNT(*)
          FROM qa_messages m
          WHERE m.conversation_id = c.id
        ) AS message_count,
        (
          SELECT COALESCE(NULLIF(m.content, ''), m.error, '')
          FROM qa_messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 1
        ) AS last_message_preview
      FROM qa_conversations c
      WHERE c.session_id = ? AND c.deleted_at IS NULL
      ORDER BY c.last_message_at DESC, c.updated_at DESC, c.id DESC
      LIMIT ?
    `).all(sessionId, normalizedLimit)

    return rows.map((row: any) => this.mapQAConversationRow(row))
  }

  getSessionQAConversation(conversationId: number): SessionQAConversationDetail | null {
    const summary = this.getSessionQAConversationSummary(conversationId)
    if (!summary) return null

    const db = this.getDb()
    const rows = db.prepare(`
      SELECT *
      FROM qa_messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(conversationId)

    return {
      ...summary,
      messages: rows.map((row: any) => this.mapQAMessageRow(row))
    }
  }

  getSessionQAConversationSummary(conversationId: number): SessionQAConversationSummary | null {
    const db = this.getDb()
    const row = db.prepare(`
      SELECT
        c.*,
        (
          SELECT COUNT(*)
          FROM qa_messages m
          WHERE m.conversation_id = c.id
        ) AS message_count,
        (
          SELECT COALESCE(NULLIF(m.content, ''), m.error, '')
          FROM qa_messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 1
        ) AS last_message_preview
      FROM qa_conversations c
      WHERE c.id = ? AND c.deleted_at IS NULL
    `).get(conversationId)

    return row ? this.mapQAConversationRow(row) : null
  }

  renameSessionQAConversation(conversationId: number, title: string): boolean {
    const db = this.getDb()
    const normalizedTitle = this.normalizeQATitle(title)
    if (!normalizedTitle) return false

    const result = db.prepare(`
      UPDATE qa_conversations
      SET title = ?, title_status = 'manual', updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(normalizedTitle, Date.now(), conversationId)

    return result.changes > 0
  }

  deleteSessionQAConversation(conversationId: number): boolean {
    const db = this.getDb()
    const now = Date.now()
    const result = db.prepare(`
      UPDATE qa_conversations
      SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(now, now, conversationId)

    return result.changes > 0
  }

  saveSessionQAMessage(input: {
    conversationId: number
    role: 'user' | 'assistant'
    content: string
    thinkContent?: string
    error?: string
    result?: SessionQAResult
    evidenceRefs?: SummaryEvidenceRef[]
    toolCalls?: SessionQAToolCall[]
    progressEvents?: SessionQAProgressEvent[]
    tokensUsed?: number
    cost?: number
    provider?: string
    model?: string
    requestId?: string
    createdAt?: number
  }): number {
    const db = this.getDb()
    const createdAt = input.createdAt || Date.now()
    const result = db.prepare(`
      INSERT INTO qa_messages (
        conversation_id, role, content, think_content, error,
        result_json, evidence_refs_json, tool_calls_json,
        progress_events_json, tokens_used, cost, provider, model, request_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.conversationId,
      input.role,
      input.content || '',
      input.thinkContent || null,
      input.error || null,
      input.result ? JSON.stringify(input.result) : null,
      input.evidenceRefs ? JSON.stringify(input.evidenceRefs) : null,
      input.toolCalls ? JSON.stringify(input.toolCalls) : null,
      input.progressEvents ? JSON.stringify(input.progressEvents) : null,
      input.tokensUsed ?? null,
      input.cost ?? null,
      input.provider || null,
      input.model || null,
      input.requestId || null,
      createdAt
    )

    db.prepare(`
      UPDATE qa_conversations
      SET
        provider = COALESCE(?, provider),
        model = COALESCE(?, model),
        updated_at = ?,
        last_message_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(
      input.provider || null,
      input.model || null,
      Date.now(),
      createdAt,
      input.conversationId
    )

    return result.lastInsertRowid as number
  }

  updateSessionQAConversationTitle(
    conversationId: number,
    title: string,
    titleStatus: Extract<SessionQAConversationTitleStatus, 'generated' | 'fallback'>
  ): boolean {
    const db = this.getDb()
    const normalizedTitle = this.normalizeQATitle(title)
    if (!normalizedTitle) return false

    const result = db.prepare(`
      UPDATE qa_conversations
      SET title = ?, title_status = ?, updated_at = ?
      WHERE id = ?
        AND deleted_at IS NULL
        AND title_status != 'manual'
        AND title_status != 'generated'
    `).run(normalizedTitle, titleStatus, Date.now(), conversationId)

    return result.changes > 0
  }

  /**
   * 清理过期缓存
   */
  cleanExpiredCache(): void {
    const db = this.getDb()
    const now = Date.now()

    db.prepare('DELETE FROM summary_cache WHERE expires_at <= ?').run(now)
  }

  /**
   * 关闭数据库
   */
  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  private mapQAConversationRow(row: any): SessionQAConversationSummary {
    return {
      id: row.id,
      sessionId: row.session_id,
      sessionName: row.session_name || undefined,
      title: row.title || '新对话',
      titleStatus: (row.title_status || 'pending') as SessionQAConversationTitleStatus,
      linkedSummaryId: row.linked_summary_id ?? undefined,
      provider: row.provider || undefined,
      model: row.model || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastMessageAt: row.last_message_at,
      messageCount: row.message_count || 0,
      lastMessagePreview: this.compactQAPreview(row.last_message_preview)
    }
  }

  private mapQAMessageRow(row: any): SessionQAMessageRecord {
    const result = this.parseJson<SessionQAResult>(row.result_json)
    const evidenceRefs = this.parseJson<SummaryEvidenceRef[]>(row.evidence_refs_json)
    const toolCalls = this.parseJson<SessionQAToolCall[]>(row.tool_calls_json)
    const progressEvents = this.parseJson<SessionQAProgressEvent[]>(row.progress_events_json)

    return {
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role === 'assistant' ? 'assistant' : 'user',
      content: row.content || '',
      thinkContent: row.think_content || undefined,
      error: row.error || undefined,
      result: result || undefined,
      evidenceRefs: evidenceRefs || result?.evidenceRefs,
      toolCalls: toolCalls || result?.toolCalls,
      progressEvents: progressEvents || undefined,
      tokensUsed: row.tokens_used ?? undefined,
      cost: row.cost ?? undefined,
      provider: row.provider || undefined,
      model: row.model || undefined,
      requestId: row.request_id || undefined,
      createdAt: row.created_at
    }
  }

  private parseJson<T>(rawValue: unknown): T | null {
    if (!rawValue || typeof rawValue !== 'string') return null
    try {
      return JSON.parse(rawValue) as T
    } catch {
      return null
    }
  }

  private compactQAPreview(value?: string | null, limit = 80): string | undefined {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim()
    if (!normalized) return undefined
    return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
  }

  private normalizeQATitle(value?: string): string {
    return String(value || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/^[\s"'“”‘’「」『』《》【】\[\]()（）]+|[\s"'“”‘’「」『』《》【】\[\]()（）。.!！?？,，;；:：]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 32)
  }

  private parseStructuredAnalysisColumn(rawValue: unknown): StructuredAnalysis | undefined {
    const parsed = parseStoredStructuredAnalysis(rawValue)
    if (!parsed && rawValue) {
      console.warn('[AIDatabase] structured_result_json 解析失败，已忽略该字段')
    }
    return parsed
  }

  private getMetaValue(metaKey: string): string | undefined {
    const db = this.getDb()
    const row = db.prepare(`
      SELECT meta_value FROM db_meta WHERE meta_key = ?
    `).get(metaKey) as { meta_value: string } | undefined

    return row?.meta_value
  }

  private setMetaValue(metaKey: string, metaValue: string): void {
    const db = this.getDb()
    db.prepare(`
      INSERT INTO db_meta (meta_key, meta_value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(meta_key) DO UPDATE SET
        meta_value = excluded.meta_value,
        updated_at = excluded.updated_at
    `).run(metaKey, metaValue, Date.now())
  }

  private backfillMissingAnalysisRuns(): number {
    const candidates = this.getBackfillCandidates()
    let insertedCount = 0

    for (const summaryRow of candidates) {
      try {
        const structuredAnalysis = this.parseStructuredAnalysisColumn(summaryRow.structured_result_json)
        const payload: SaveAnalysisArtifactsInput = structuredAnalysis
          ? {
              summaryId: summaryRow.id,
              sessionId: summaryRow.session_id,
              timeRangeStart: summaryRow.time_range_start,
              timeRangeEnd: summaryRow.time_range_end,
              timeRangeDays: summaryRow.time_range_days,
              rawMessageCount: summaryRow.message_count,
              effectiveMessageCount: undefined,
              blockCount: 0,
              provider: summaryRow.provider,
              model: summaryRow.model,
              status: 'backfill_facts_only',
              sourceKind: 'backfill_structured',
              evidenceResolved: hasAnyEvidenceRefs(structuredAnalysis),
              blocksAvailable: false,
              finalAnalysis: structuredAnalysis,
              createdAt: summaryRow.created_at,
              updatedAt: Date.now()
            }
          : {
              summaryId: summaryRow.id,
              sessionId: summaryRow.session_id,
              timeRangeStart: summaryRow.time_range_start,
              timeRangeEnd: summaryRow.time_range_end,
              timeRangeDays: summaryRow.time_range_days,
              rawMessageCount: summaryRow.message_count,
              effectiveMessageCount: undefined,
              blockCount: 0,
              provider: summaryRow.provider,
              model: summaryRow.model,
              status: 'legacy_placeholder',
              sourceKind: 'backfill_legacy',
              evidenceResolved: false,
              blocksAvailable: false,
              createdAt: summaryRow.created_at,
              updatedAt: Date.now()
            }

        this.saveAnalysisArtifacts(payload)
        insertedCount += 1
      } catch (error) {
        console.warn('[AIDatabase] 回填 analysis_runs 失败，已跳过该摘要:', {
          summaryId: summaryRow.id,
          error: String(error)
        })
      }
    }

    return insertedCount
  }

  private getBackfillCandidates(): SummaryBackfillRow[] {
    const db = this.getDb()
    return db.prepare(`
      SELECT
        s.id,
        s.session_id,
        s.time_range_start,
        s.time_range_end,
        s.time_range_days,
        s.message_count,
        s.provider,
        s.model,
        s.created_at,
        s.structured_result_json
      FROM summaries s
      LEFT JOIN analysis_runs ar ON ar.summary_id = s.id
      WHERE ar.id IS NULL
      ORDER BY s.id ASC
    `).all() as SummaryBackfillRow[]
  }
}

export const aiDatabase = new AIDatabase()
