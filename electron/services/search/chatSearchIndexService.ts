import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { chatService, type Message } from '../chatService'
import { ConfigService } from '../config'

export type ChatSearchIndexProgressStage =
  | 'preparing_index'
  | 'indexing_messages'
  | 'searching_index'
  | 'completed'

export interface ChatSearchIndexProgress {
  stage: ChatSearchIndexProgressStage
  message: string
  sessionId: string
  messagesScanned?: number
  indexedCount?: number
}

export interface ChatSearchIndexState {
  sessionId: string
  indexedCount: number
  newestSortSeq: number
  newestCreateTime: number
  newestLocalId: number
  updatedAt: number
  isComplete: boolean
}

export interface ChatSearchIndexHit {
  sessionId: string
  message: Message
  excerpt: string
  matchedField: 'text' | 'raw'
  score: number
}

export interface ChatSearchSessionOptions {
  sessionId: string
  query: string
  limit: number
  matchMode?: 'substring' | 'exact'
  startTimeMs?: number
  endTimeMs?: number
  direction?: 'in' | 'out'
  senderUsername?: string
  onProgress?: (progress: ChatSearchIndexProgress) => void | Promise<void>
}

export interface ChatSearchSessionResult {
  hits: ChatSearchIndexHit[]
  indexedCount: number
  truncated: boolean
}

type MessageIndexRow = {
  id: number
  session_id: string
  local_id: number
  server_id: number
  local_type: number
  create_time: number
  sort_seq: number
  is_send: number | null
  sender_username: string | null
  parsed_content: string
  raw_content: string
  search_text: string
  token_text: string
  message_json: string
}

const INDEX_DB_NAME = 'chat_search_index.db'
const INDEX_SCHEMA_VERSION = '1'
const INDEX_BATCH_SIZE = 800
const MAX_INDEX_TEXT_CHARS = 8000
const MAX_EXCERPT_RADIUS = 48
const MAX_INDEX_SEARCH_CANDIDATES = 240

function cursorKey(message: Pick<Message, 'localId' | 'createTime' | 'sortSeq'>): string {
  return `${Number(message.localId || 0)}:${Number(message.createTime || 0)}:${Number(message.sortSeq || 0)}`
}

function compareCursorAsc(
  a: Pick<Message, 'sortSeq' | 'createTime' | 'localId'>,
  b: Pick<Message, 'sortSeq' | 'createTime' | 'localId'>
): number {
  return Number(a.sortSeq || 0) - Number(b.sortSeq || 0)
    || Number(a.createTime || 0) - Number(b.createTime || 0)
    || Number(a.localId || 0) - Number(b.localId || 0)
}

function normalizeSearchText(value?: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[ \t\r\n]+/g, ' ')
    .replace(/[，。！？；：、“”‘’（）()[\]{}<>《》|\\/+=*_~`#$%^&-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function compactSearchText(value: string): string {
  const normalized = normalizeSearchText(value)
  return normalized.length > MAX_INDEX_TEXT_CHARS
    ? normalized.slice(0, MAX_INDEX_TEXT_CHARS)
    : normalized
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of values) {
    const normalized = normalizeSearchText(value)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }

  return result
}

function extractMessageSearchText(message: Message): string {
  const chatRecordText = Array.isArray(message.chatRecordList)
    ? message.chatRecordList
      .flatMap((item) => [
        item.datadesc,
        item.datatitle,
        item.sourcename,
        item.fileext
      ])
      .filter(Boolean)
      .join(' ')
    : ''

  const mediaFallback = (() => {
    switch (Number(message.localType || 0)) {
      case 3:
        return '[图片]'
      case 34:
        return '[语音]'
      case 43:
        return '[视频]'
      case 47:
        return '[表情]'
      case 49:
        return '[文件]'
      default:
        return ''
    }
  })()

  return [
    message.parsedContent,
    message.quotedContent,
    message.fileName,
    chatRecordText,
    message.rawContent,
    mediaFallback
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .join(' ')
}

function buildSearchTokens(value: string): string {
  const normalized = normalizeSearchText(value)
  const tokens: string[] = []

  for (const match of normalized.matchAll(/[\u3400-\u9fff]+/g)) {
    const segment = match[0]
    if (segment.length <= 3) {
      tokens.push(segment)
    }

    for (let size = 2; size <= 3; size += 1) {
      if (segment.length < size) continue
      for (let index = 0; index <= segment.length - size; index += 1) {
        tokens.push(segment.slice(index, index + size))
      }
    }
  }

  for (const match of normalized.matchAll(/[a-z0-9_@.\-]{2,}/g)) {
    tokens.push(match[0])
  }

  return uniqueStrings(tokens).join(' ')
}

function buildQueryTokens(query: string): string[] {
  const normalized = normalizeSearchText(query)
  const tokens: string[] = []

  for (const match of normalized.matchAll(/[\u3400-\u9fff]+/g)) {
    const segment = match[0]
    if (segment.length <= 3) {
      tokens.push(segment)
    }

    const gramSize = segment.length <= 4 ? 2 : 3
    if (segment.length >= gramSize) {
      for (let index = 0; index <= segment.length - gramSize; index += 1) {
        tokens.push(segment.slice(index, index + gramSize))
      }
    }
  }

  for (const match of normalized.matchAll(/[a-z0-9_@.\-]{2,}/g)) {
    tokens.push(match[0])
  }

  return uniqueStrings(tokens).slice(0, 12)
}

function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`
}

function buildFtsQuery(query: string): string {
  return buildQueryTokens(query).map(quoteFtsTerm).join(' ')
}

function createExcerpt(source: string, matchedIndex: number, queryLength: number): string {
  if (!source) return ''
  const safeIndex = Math.max(0, matchedIndex)
  const start = Math.max(0, safeIndex - MAX_EXCERPT_RADIUS)
  const end = Math.min(source.length, safeIndex + queryLength + MAX_EXCERPT_RADIUS)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < source.length ? '...' : ''
  return `${prefix}${source.slice(start, end)}${suffix}`
}

function findMatchInIndexedText(
  row: Pick<MessageIndexRow, 'parsed_content' | 'raw_content' | 'search_text' | 'token_text'>,
  query: string,
  matchMode: 'substring' | 'exact' = 'substring'
): { matchedField: 'text' | 'raw'; excerpt: string; score: number } {
  const exactQuery = String(query || '').trim()
  const normalizedQuery = normalizeSearchText(query)
  const compactQuery = normalizedQuery.replace(/\s+/g, '')
  const text = String(row.parsed_content || '')
  const raw = String(row.raw_content || '')
  const normalizedText = normalizeSearchText(text)
  const normalizedRaw = normalizeSearchText(raw)
  const normalizedSearchText = String(row.search_text || '')

  const matchIndex = matchMode === 'exact'
    ? text.indexOf(exactQuery)
    : normalizedText.indexOf(normalizedQuery)

  if (matchIndex >= 0) {
    return {
      matchedField: 'text',
      excerpt: createExcerpt(text || normalizedText, matchIndex, normalizedQuery.length),
      score: 1400 - Math.min(matchIndex, 500)
    }
  }

  const compactSearchIndex = compactQuery
    ? normalizedSearchText.replace(/\s+/g, '').indexOf(compactQuery)
    : -1
  if (compactSearchIndex >= 0) {
    return {
      matchedField: 'text',
      excerpt: createExcerpt(text || normalizedSearchText, Math.min(compactSearchIndex, Math.max(0, (text || normalizedSearchText).length - 1)), normalizedQuery.length),
      score: 1180 - Math.min(compactSearchIndex, 500)
    }
  }

  const rawIndex = matchMode === 'exact'
    ? raw.indexOf(exactQuery)
    : normalizedRaw.indexOf(normalizedQuery)
  if (rawIndex >= 0) {
    return {
      matchedField: 'raw',
      excerpt: createExcerpt(raw || normalizedRaw, rawIndex, normalizedQuery.length),
      score: 880 - Math.min(rawIndex, 500)
    }
  }

  const queryTokens = buildQueryTokens(query)
  const tokenText = String(row.token_text || '')
  const matchedTokens = queryTokens.filter((token) => tokenText.includes(token))
  const ratio = queryTokens.length > 0 ? matchedTokens.length / queryTokens.length : 0
  return {
    matchedField: 'text',
    excerpt: createExcerpt(text || normalizedSearchText, 0, Math.max(normalizedQuery.length, 1)),
    score: Number((720 + ratio * 260 + matchedTokens.length * 8).toFixed(2))
  }
}

function hasExactMessageMatch(row: Pick<MessageIndexRow, 'parsed_content' | 'raw_content'>, query: string): boolean {
  const exactQuery = String(query || '').trim()
  if (!exactQuery) return false
  return String(row.parsed_content || '').includes(exactQuery)
    || String(row.raw_content || '').includes(exactQuery)
}

function rowToMessage(row: MessageIndexRow): Message {
  try {
    const parsed = JSON.parse(row.message_json) as Message
    return {
      ...parsed,
      localId: Number(parsed.localId ?? row.local_id ?? 0),
      serverId: Number(parsed.serverId ?? row.server_id ?? 0),
      localType: Number(parsed.localType ?? row.local_type ?? 0),
      createTime: Number(parsed.createTime ?? row.create_time ?? 0),
      sortSeq: Number(parsed.sortSeq ?? row.sort_seq ?? 0),
      isSend: parsed.isSend ?? row.is_send ?? null,
      senderUsername: parsed.senderUsername ?? row.sender_username ?? null,
      parsedContent: String(parsed.parsedContent ?? row.parsed_content ?? ''),
      rawContent: String(parsed.rawContent ?? row.raw_content ?? '')
    }
  } catch {
    return {
      localId: Number(row.local_id || 0),
      serverId: Number(row.server_id || 0),
      localType: Number(row.local_type || 0),
      createTime: Number(row.create_time || 0),
      sortSeq: Number(row.sort_seq || 0),
      isSend: row.is_send ?? null,
      senderUsername: row.sender_username ?? null,
      parsedContent: String(row.parsed_content || ''),
      rawContent: String(row.raw_content || '')
    }
  }
}

function toTimestampSeconds(value?: number): number | undefined {
  if (!value || !Number.isFinite(value)) return undefined
  return value > 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value)
}

export class ChatSearchIndexService {
  private db: Database.Database | null = null
  private dbPath: string | null = null

  private getCacheBasePath(): string {
    const configService = new ConfigService()
    try {
      const cachePath = String(configService.get('cachePath') || '').trim()
      return cachePath || join(process.cwd(), 'cache')
    } finally {
      configService.close()
    }
  }

  private getDb(): Database.Database {
    const basePath = this.getCacheBasePath()
    if (!existsSync(basePath)) {
      mkdirSync(basePath, { recursive: true })
    }

    const nextDbPath = join(basePath, INDEX_DB_NAME)
    if (this.db && this.dbPath === nextDbPath) {
      return this.db
    }

    if (this.db) {
      try {
        this.db.close()
      } catch {
        // ignore
      }
    }

    const db = new Database(nextDbPath)
    this.db = db
    this.dbPath = nextDbPath
    this.ensureSchema(db)
    return db
  }

  private ensureSchema(db: Database.Database): void {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)

    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value?: string } | undefined
    if (row?.value && row.value !== INDEX_SCHEMA_VERSION) {
      this.resetSchema(db)
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS message_index (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        local_id INTEGER NOT NULL,
        server_id INTEGER NOT NULL DEFAULT 0,
        local_type INTEGER NOT NULL DEFAULT 0,
        create_time INTEGER NOT NULL DEFAULT 0,
        sort_seq INTEGER NOT NULL DEFAULT 0,
        is_send INTEGER,
        sender_username TEXT,
        parsed_content TEXT NOT NULL DEFAULT '',
        raw_content TEXT NOT NULL DEFAULT '',
        search_text TEXT NOT NULL DEFAULT '',
        token_text TEXT NOT NULL DEFAULT '',
        message_json TEXT NOT NULL DEFAULT '{}',
        indexed_at INTEGER NOT NULL,
        UNIQUE(session_id, local_id, create_time, sort_seq)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS message_index_fts USING fts5(
        session_id UNINDEXED,
        cursor_key UNINDEXED,
        search_text,
        token_text,
        tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS session_index_state (
        session_id TEXT PRIMARY KEY,
        newest_sort_seq INTEGER NOT NULL DEFAULT 0,
        newest_create_time INTEGER NOT NULL DEFAULT 0,
        newest_local_id INTEGER NOT NULL DEFAULT 0,
        indexed_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        is_complete INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_message_index_session_time
        ON message_index(session_id, sort_seq DESC, create_time DESC, local_id DESC);
      CREATE INDEX IF NOT EXISTS idx_message_index_session_sender
        ON message_index(session_id, sender_username);
    `)

    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', INDEX_SCHEMA_VERSION)
  }

  private resetSchema(db: Database.Database): void {
    db.exec(`
      DROP TABLE IF EXISTS message_index_fts;
      DROP TABLE IF EXISTS message_index;
      DROP TABLE IF EXISTS session_index_state;
      DELETE FROM meta WHERE key = 'schema_version';
    `)
  }

  private getSessionState(db: Database.Database, sessionId: string): ChatSearchIndexState | null {
    const row = db.prepare('SELECT * FROM session_index_state WHERE session_id = ?').get(sessionId) as any
    if (!row) return null

    return {
      sessionId,
      indexedCount: Number(row.indexed_count || 0),
      newestSortSeq: Number(row.newest_sort_seq || 0),
      newestCreateTime: Number(row.newest_create_time || 0),
      newestLocalId: Number(row.newest_local_id || 0),
      updatedAt: Number(row.updated_at || 0),
      isComplete: Number(row.is_complete || 0) === 1
    }
  }

  private getIndexedCount(db: Database.Database, sessionId: string): number {
    const row = db.prepare('SELECT COUNT(*) AS count FROM message_index WHERE session_id = ?').get(sessionId) as { count?: number }
    return Number(row?.count || 0)
  }

  private upsertMessages(db: Database.Database, sessionId: string, messages: Message[]): void {
    if (messages.length === 0) return

    const upsert = db.prepare(`
      INSERT INTO message_index (
        session_id,
        local_id,
        server_id,
        local_type,
        create_time,
        sort_seq,
        is_send,
        sender_username,
        parsed_content,
        raw_content,
        search_text,
        token_text,
        message_json,
        indexed_at
      ) VALUES (
        @sessionId,
        @localId,
        @serverId,
        @localType,
        @createTime,
        @sortSeq,
        @isSend,
        @senderUsername,
        @parsedContent,
        @rawContent,
        @searchText,
        @tokenText,
        @messageJson,
        @indexedAt
      )
      ON CONFLICT(session_id, local_id, create_time, sort_seq) DO UPDATE SET
        server_id = excluded.server_id,
        local_type = excluded.local_type,
        is_send = excluded.is_send,
        sender_username = excluded.sender_username,
        parsed_content = excluded.parsed_content,
        raw_content = excluded.raw_content,
        search_text = excluded.search_text,
        token_text = excluded.token_text,
        message_json = excluded.message_json,
        indexed_at = excluded.indexed_at
    `)
    const selectId = db.prepare(`
      SELECT id FROM message_index
      WHERE session_id = ? AND local_id = ? AND create_time = ? AND sort_seq = ?
    `)
    const deleteFts = db.prepare('DELETE FROM message_index_fts WHERE rowid = ?')
    const insertFts = db.prepare(`
      INSERT INTO message_index_fts(rowid, session_id, cursor_key, search_text, token_text)
      VALUES (?, ?, ?, ?, ?)
    `)

    const run = db.transaction((items: Message[]) => {
      const indexedAt = Date.now()
      for (const message of items) {
        const searchText = compactSearchText(extractMessageSearchText(message))
        const tokenText = buildSearchTokens(searchText)
        const payload = {
          sessionId,
          localId: Number(message.localId || 0),
          serverId: Number(message.serverId || 0),
          localType: Number(message.localType || 0),
          createTime: Number(message.createTime || 0),
          sortSeq: Number(message.sortSeq || 0),
          isSend: message.isSend ?? null,
          senderUsername: message.senderUsername ?? null,
          parsedContent: String(message.parsedContent || ''),
          rawContent: String(message.rawContent || ''),
          searchText,
          tokenText,
          messageJson: JSON.stringify(message),
          indexedAt
        }

        upsert.run(payload)
        const row = selectId.get(sessionId, payload.localId, payload.createTime, payload.sortSeq) as { id?: number } | undefined
        if (!row?.id) continue

        deleteFts.run(row.id)
        insertFts.run(row.id, sessionId, cursorKey(message), searchText, tokenText)
      }
    })

    run(messages)
  }

  private updateSessionState(db: Database.Database, sessionId: string, newest: Message | null, isComplete: boolean): ChatSearchIndexState {
    const indexedCount = this.getIndexedCount(db, sessionId)
    const previous = this.getSessionState(db, sessionId)
    const previousNewest = previous
      ? {
        localId: previous.newestLocalId,
        createTime: previous.newestCreateTime,
        sortSeq: previous.newestSortSeq
      }
      : null
    const selectedNewest = newest && (!previousNewest || compareCursorAsc(previousNewest, newest) <= 0)
      ? newest
      : previousNewest

    const state = {
      sessionId,
      indexedCount,
      newestSortSeq: Number(selectedNewest?.sortSeq || 0),
      newestCreateTime: Number(selectedNewest?.createTime || 0),
      newestLocalId: Number(selectedNewest?.localId || 0),
      updatedAt: Date.now(),
      isComplete
    }

    db.prepare(`
      INSERT INTO session_index_state (
        session_id,
        newest_sort_seq,
        newest_create_time,
        newest_local_id,
        indexed_count,
        updated_at,
        is_complete
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        newest_sort_seq = excluded.newest_sort_seq,
        newest_create_time = excluded.newest_create_time,
        newest_local_id = excluded.newest_local_id,
        indexed_count = excluded.indexed_count,
        updated_at = excluded.updated_at,
        is_complete = excluded.is_complete
    `).run(
      state.sessionId,
      state.newestSortSeq,
      state.newestCreateTime,
      state.newestLocalId,
      state.indexedCount,
      state.updatedAt,
      state.isComplete ? 1 : 0
    )

    return state
  }

  private async report(progress: ChatSearchIndexProgress, onProgress?: ChatSearchSessionOptions['onProgress']): Promise<void> {
    await onProgress?.(progress)
  }

  async ensureSessionIndexed(
    sessionId: string,
    onProgress?: ChatSearchSessionOptions['onProgress']
  ): Promise<ChatSearchIndexState> {
    const db = this.getDb()
    const state = this.getSessionState(db, sessionId)
    let newest: Message | null = state?.isComplete && state.newestSortSeq > 0
      ? {
        localId: state.newestLocalId,
        serverId: 0,
        localType: 0,
        createTime: state.newestCreateTime,
        sortSeq: state.newestSortSeq,
        isSend: null,
        senderUsername: null,
        parsedContent: '',
        rawContent: ''
      }
      : null
    let scanned = 0

    await this.report({
      stage: 'preparing_index',
      sessionId,
      message: state?.isComplete ? '正在检查会话搜索索引增量' : '正在建立当前会话搜索索引',
      indexedCount: state?.indexedCount || 0
    }, onProgress)

    if (state?.isComplete && state.newestSortSeq > 0) {
      let cursor = {
        sortSeq: state.newestSortSeq,
        createTime: state.newestCreateTime,
        localId: state.newestLocalId
      }
      let hasMore = true

      while (hasMore) {
        const result = await chatService.getMessagesAfter(
          sessionId,
          cursor.sortSeq,
          INDEX_BATCH_SIZE,
          cursor.createTime,
          cursor.localId
        )
        if (!result.success) {
          throw new Error(result.error || '更新搜索索引失败')
        }

        const messages = result.messages || []
        if (messages.length === 0) break
        this.upsertMessages(db, sessionId, messages)
        scanned += messages.length
        newest = messages[messages.length - 1] || newest
        cursor = {
          sortSeq: newest.sortSeq,
          createTime: newest.createTime,
          localId: newest.localId
        }

        await this.report({
          stage: 'indexing_messages',
          sessionId,
          message: `已更新 ${scanned} 条新消息到搜索索引`,
          messagesScanned: scanned,
          indexedCount: this.getIndexedCount(db, sessionId)
        }, onProgress)

        hasMore = Boolean(result.hasMore)
      }

      const nextState = this.updateSessionState(db, sessionId, newest, true)
      await this.report({
        stage: 'completed',
        sessionId,
        message: `搜索索引已就绪，共 ${nextState.indexedCount} 条消息`,
        messagesScanned: scanned,
        indexedCount: nextState.indexedCount
      }, onProgress)
      return nextState
    }

    db.prepare('DELETE FROM message_index_fts WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM message_index WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM session_index_state WHERE session_id = ?').run(sessionId)

    const firstPage = await chatService.getMessages(sessionId, 0, INDEX_BATCH_SIZE)
    if (!firstPage.success) {
      throw new Error(firstPage.error || '建立搜索索引失败')
    }

    let messages = firstPage.messages || []
    let hasMore = Boolean(firstPage.hasMore)
    if (messages.length > 0) {
      this.upsertMessages(db, sessionId, messages)
      scanned += messages.length
      newest = messages[messages.length - 1]
      await this.report({
        stage: 'indexing_messages',
        sessionId,
        message: `已索引 ${scanned} 条消息`,
        messagesScanned: scanned,
        indexedCount: this.getIndexedCount(db, sessionId)
      }, onProgress)
    }

    while (hasMore && messages.length > 0) {
      const oldest = messages[0]
      const result = await chatService.getMessagesBefore(
        sessionId,
        oldest.sortSeq,
        INDEX_BATCH_SIZE,
        oldest.createTime,
        oldest.localId
      )
      if (!result.success) {
        throw new Error(result.error || '继续建立搜索索引失败')
      }

      messages = result.messages || []
      if (messages.length === 0) break
      this.upsertMessages(db, sessionId, messages)
      scanned += messages.length
      hasMore = Boolean(result.hasMore)

      await this.report({
        stage: 'indexing_messages',
        sessionId,
        message: `已索引 ${scanned} 条消息`,
        messagesScanned: scanned,
        indexedCount: this.getIndexedCount(db, sessionId)
      }, onProgress)
    }

    const nextState = this.updateSessionState(db, sessionId, newest, true)
    await this.report({
      stage: 'completed',
      sessionId,
      message: `搜索索引已就绪，共 ${nextState.indexedCount} 条消息`,
      messagesScanned: scanned,
      indexedCount: nextState.indexedCount
    }, onProgress)
    return nextState
  }

  async searchSession(options: ChatSearchSessionOptions): Promise<ChatSearchSessionResult> {
    const db = this.getDb()
    const state = await this.ensureSessionIndexed(options.sessionId, options.onProgress)
    const query = normalizeSearchText(options.query)
    if (!query) {
      return {
        hits: [],
        indexedCount: state.indexedCount,
        truncated: false
      }
    }

    await this.report({
      stage: 'searching_index',
      sessionId: options.sessionId,
      message: `正在搜索本地索引：${options.query}`,
      indexedCount: state.indexedCount
    }, options.onProgress)

    const startTime = toTimestampSeconds(options.startTimeMs)
    const endTime = toTimestampSeconds(options.endTimeMs)
    const senderUsername = normalizeSearchText(options.senderUsername)
    const direction = options.direction
    const candidateLimit = Math.min(MAX_INDEX_SEARCH_CANDIDATES, Math.max(options.limit * 8, options.limit + 20))
    const sqlFilters: string[] = ['m.session_id = @sessionId']
    const params: Record<string, unknown> = {
      sessionId: options.sessionId,
      limit: candidateLimit + 1
    }

    if (startTime) {
      sqlFilters.push('m.create_time >= @startTime')
      params.startTime = startTime
    }
    if (endTime) {
      sqlFilters.push('m.create_time <= @endTime')
      params.endTime = endTime
    }
    if (direction) {
      sqlFilters.push(direction === 'out' ? 'm.is_send = 1' : '(m.is_send IS NULL OR m.is_send != 1)')
    }
    if (senderUsername) {
      sqlFilters.push('lower(COALESCE(m.sender_username, \'\')) = @senderUsername')
      params.senderUsername = senderUsername
    }

    const rowsById = new Map<number, MessageIndexRow>()
    const ftsQuery = buildFtsQuery(query)
    if (ftsQuery) {
      const ftsRows = db.prepare(`
        SELECT m.*, bm25(message_index_fts) AS rank
        FROM message_index_fts
        JOIN message_index m ON m.id = message_index_fts.rowid
        WHERE message_index_fts MATCH @ftsQuery
          AND ${sqlFilters.join(' AND ')}
        ORDER BY rank ASC, m.sort_seq DESC, m.create_time DESC, m.local_id DESC
        LIMIT @limit
      `).all({
        ...params,
        ftsQuery
      }) as MessageIndexRow[]

      for (const row of ftsRows) {
        rowsById.set(row.id, row)
      }
    }

    const likeQuery = `%${query}%`
    const compactQuery = query.replace(/\s+/g, '')
    const likeRows = db.prepare(`
      SELECT m.*
      FROM message_index m
      WHERE ${sqlFilters.join(' AND ')}
        AND (
          m.search_text LIKE @likeQuery
          OR replace(m.search_text, ' ', '') LIKE @compactLikeQuery
        )
      ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
      LIMIT @limit
    `).all({
      ...params,
      likeQuery,
      compactLikeQuery: `%${compactQuery || query}%`
    }) as MessageIndexRow[]

    for (const row of likeRows) {
      rowsById.set(row.id, row)
    }

    const rows = Array.from(rowsById.values())
    const filteredRows = options.matchMode === 'exact'
      ? rows.filter((row) => hasExactMessageMatch(row, options.query))
      : rows
    const hits = filteredRows.map((row) => {
      const match = findMatchInIndexedText(row, options.query, options.matchMode)
      return {
        sessionId: options.sessionId,
        message: rowToMessage(row),
        excerpt: match.excerpt,
        matchedField: match.matchedField,
        score: match.score
      } satisfies ChatSearchIndexHit
    })
      .sort((a, b) => b.score - a.score || compareCursorAsc(b.message, a.message))

    return {
      hits: hits.slice(0, options.limit),
      indexedCount: state.indexedCount,
      truncated: rows.length > options.limit
    }
  }
}

export const chatSearchIndexService = new ChatSearchIndexService()
