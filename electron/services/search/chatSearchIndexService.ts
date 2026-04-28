import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { chatService, type Message } from '../chatService'
import { ConfigService } from '../config'
import {
  float32ArrayToBuffer,
  hashEmbeddingContent,
  localEmbeddingModelService
} from './embeddingModelService'
import { embeddingRuntimeService } from './embeddingRuntimeService'
import { SqliteVec0VectorStore } from '../vector/sqliteVec0VectorStore'

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

export type ChatVectorIndexProgressStage =
  | 'preparing'
  | 'downloading_model'
  | 'indexing_messages'
  | 'vectorizing_messages'
  | 'completed'

export type ChatVectorIndexProgressStatus =
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface ChatVectorIndexProgress {
  sessionId: string
  stage: ChatVectorIndexProgressStage
  status: ChatVectorIndexProgressStatus
  processedCount: number
  totalCount: number
  message: string
  vectorModel: string
  vectorModelName?: string
  vectorDim?: number
  vectorIndexVersion?: string
  vectorStoreName?: string
  vectorModelDtype?: string
  vectorModelSizeLabel?: string
  embeddingMode?: 'local' | 'online'
  vectorProviderName?: string
}

export interface ChatVectorIndexState {
  sessionId: string
  indexedCount: number
  vectorizedCount: number
  pendingCount: number
  isVectorComplete: boolean
  isVectorRunning: boolean
  vectorModel: string
  vectorModelName?: string
  vectorDim: number
  vectorIndexVersion: string
  vectorStoreName: string
  vectorModelDtype?: string
  vectorModelSizeLabel?: string
  embeddingMode?: 'local' | 'online'
  vectorProviderName?: string
  vectorProviderAvailable?: boolean
  vectorProviderError?: string
}

export interface ChatVectorSearchSessionResult {
  hits: ChatSearchIndexHit[]
  indexedCount: number
  vectorizedCount: number
  truncated: boolean
  model: string
}

export interface ChatSearchMemoryMessage {
  id: number
  sessionId: string
  localId: number
  serverId: number
  localType: number
  createTime: number
  sortSeq: number
  isSend: number | null
  senderUsername: string | null
  parsedContent: string
  rawContent: string
  searchText: string
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

type SessionVectorStateRow = {
  session_id: string
  vector_model: string
  confirmed_at: number | null
  completed_at: number | null
  updated_at: number
  is_complete: number
  last_error: string | null
}

type VectorTask = {
  promise: Promise<ChatVectorIndexState>
  cancelRequested: boolean
}

const INDEX_DB_NAME = 'chat_search_index.db'
const INDEX_SCHEMA_VERSION = '5'
const INDEX_BATCH_SIZE = 800
const MAX_INDEX_TEXT_CHARS = 8000
const MAX_EXCERPT_RADIUS = 48
const MAX_INDEX_SEARCH_CANDIDATES = 240
const VECTOR_BATCH_SIZE = 8
const VECTOR_BATCH_IDLE_MS = 60
const VECTOR_SEARCH_OVERFETCH = 8
const VECTOR_MIN_SCORE = 0.35
const VECTOR_SCORE_BASE = 650
const VECTOR_SCORE_SCALE = 500
const VECTOR_INDEX_CANCELLED_ERROR = 'VECTOR_INDEX_CANCELLED'
const VECTOR_CHUNK_WINDOW = 3
const VECTOR_CHUNK_TIME_GAP = 300

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

function compareIndexRowCursorAsc(
  a: Pick<MessageIndexRow, 'sort_seq' | 'create_time' | 'local_id'>,
  b: Pick<MessageIndexRow, 'sort_seq' | 'create_time' | 'local_id'>
): number {
  return Number(a.sort_seq || 0) - Number(b.sort_seq || 0)
    || Number(a.create_time || 0) - Number(b.create_time || 0)
    || Number(a.local_id || 0) - Number(b.local_id || 0)
}

function vectorSessionKey(sessionId: string): number {
  let hash = 2166136261
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
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

type ChunkContextRow = {
  id: number
  sort_seq: number
  create_time: number
  sender_username: string | null
  search_text: string
}

type VectorEmbeddingRow = Pick<MessageIndexRow, 'id' | 'session_id' | 'search_text'> & {
  indexed_at?: number
  content_hash?: string
}

type SessionVectorHashRow = VectorEmbeddingRow & Pick<ChunkContextRow, 'sort_seq' | 'create_time' | 'sender_username'> & {
  vector_content_hash: string | null
}

function buildChunkedEmbeddingText(
  centerIndex: number,
  allMessages: ChunkContextRow[]
): string {
  const center = allMessages[centerIndex]
  if (!center) return ''

  const windowMessages: ChunkContextRow[] = []

  for (let i = centerIndex - 1; i >= Math.max(0, centerIndex - VECTOR_CHUNK_WINDOW); i--) {
    const msg = allMessages[i]
    if (Math.abs(center.create_time - msg.create_time) > VECTOR_CHUNK_TIME_GAP) break
    windowMessages.unshift(msg)
  }

  windowMessages.push(center)

  for (let i = centerIndex + 1; i <= Math.min(allMessages.length - 1, centerIndex + VECTOR_CHUNK_WINDOW); i++) {
    const msg = allMessages[i]
    if (Math.abs(msg.create_time - center.create_time) > VECTOR_CHUNK_TIME_GAP) break
    windowMessages.push(msg)
  }

  return windowMessages
    .map((msg) => {
      const sender = msg.sender_username || '?'
      const text = msg.search_text.slice(0, 200)
      return `${sender}: ${text}`
    })
    .join('\n')
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

function createVectorExcerpt(row: Pick<MessageIndexRow, 'parsed_content' | 'search_text'>, query: string): string {
  const text = String(row.parsed_content || row.search_text || '')
  if (!text) return ''

  const normalizedQuery = normalizeSearchText(query)
  const exactIndex = normalizedQuery ? normalizeSearchText(text).indexOf(normalizedQuery) : -1
  if (exactIndex >= 0) {
    return createExcerpt(text, Math.min(exactIndex, Math.max(0, text.length - 1)), Math.max(normalizedQuery.length, 1))
  }

  const token = buildQueryTokens(query)[0]
  if (token) {
    const tokenIndex = normalizeSearchText(text).indexOf(token)
    if (tokenIndex >= 0) {
      return createExcerpt(text, Math.min(tokenIndex, Math.max(0, text.length - 1)), token.length)
    }
  }

  return createExcerpt(text, 0, Math.min(text.length, 24))
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
  private vectorTasks = new Map<string, VectorTask>()
  private vectorStore = new SqliteVec0VectorStore()

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
      this.ensureVectorCollection(this.db)
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
    this.vectorStore.load(db)
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

      CREATE TABLE IF NOT EXISTS message_vector_index (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        vector_model TEXT NOT NULL,
        embedding_blob BLOB NOT NULL,
        dim INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        indexed_at INTEGER NOT NULL,
        UNIQUE(message_id, vector_model)
      );

      CREATE TABLE IF NOT EXISTS session_vector_state (
        session_id TEXT NOT NULL,
        vector_model TEXT NOT NULL,
        confirmed_at INTEGER,
        completed_at INTEGER,
        updated_at INTEGER NOT NULL,
        is_complete INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        PRIMARY KEY(session_id, vector_model)
      );

      CREATE INDEX IF NOT EXISTS idx_message_index_session_time
        ON message_index(session_id, sort_seq DESC, create_time DESC, local_id DESC);
      CREATE INDEX IF NOT EXISTS idx_message_index_session_sender
        ON message_index(session_id, sender_username);
      CREATE INDEX IF NOT EXISTS idx_message_vector_session_model
        ON message_vector_index(session_id, vector_model);
      CREATE INDEX IF NOT EXISTS idx_message_vector_message_model
        ON message_vector_index(message_id, vector_model);
      CREATE INDEX IF NOT EXISTS idx_session_vector_state_session
        ON session_vector_state(session_id);
    `)

    this.ensureVectorCollection(db)

    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', INDEX_SCHEMA_VERSION)
  }

  private ensureVectorCollection(db: Database.Database): void {
    const dim = this.getCurrentVectorProfile().dim || localEmbeddingModelService.getCurrentVectorDim()
    const state = this.vectorStore.ensureCollection(db, {
      dim
    })
    if (state.recreated) {
      db.prepare('DELETE FROM message_vector_index').run()
      db.prepare('DELETE FROM session_vector_state').run()
    }
  }

  private resetSchema(db: Database.Database): void {
    db.exec(`
      DROP TABLE IF EXISTS message_index_fts;
      DROP TABLE IF EXISTS message_embedding_vec;
      DROP TABLE IF EXISTS message_vector_index;
      DROP TABLE IF EXISTS session_vector_state;
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

  private getCurrentVectorProfile() {
    return embeddingRuntimeService.getCurrentProfile()
  }

  private getCurrentVectorModelId(): string {
    return embeddingRuntimeService.getCurrentVectorModelId()
  }

  private getSessionVectorHashRows(
    db: Database.Database,
    sessionId: string,
    vectorModel = this.getCurrentVectorModelId()
  ): SessionVectorHashRow[] {
    const rows = db.prepare(`
      SELECT
        m.id,
        m.session_id,
        m.sort_seq,
        m.create_time,
        m.sender_username,
        m.search_text,
        m.indexed_at,
        v.content_hash AS vector_content_hash
      FROM message_index m
      LEFT JOIN message_vector_index v
        ON v.message_id = m.id AND v.vector_model = ?
      WHERE m.session_id = ?
      ORDER BY m.sort_seq ASC, m.create_time ASC, m.local_id ASC
    `).all(vectorModel, sessionId) as Array<SessionVectorHashRow & { vector_content_hash?: string | null }>

    return rows.map((row, index) => {
      const embeddingText = buildChunkedEmbeddingText(index, rows)
      return {
        id: row.id,
        session_id: row.session_id,
        sort_seq: row.sort_seq,
        create_time: row.create_time,
        sender_username: row.sender_username,
        search_text: embeddingText,
        indexed_at: row.indexed_at,
        content_hash: hashEmbeddingContent(embeddingText),
        vector_content_hash: row.vector_content_hash || null
      }
    })
  }

  private getPendingVectorRows(db: Database.Database, sessionId: string, limit: number): VectorEmbeddingRow[] {
    return this.getSessionVectorHashRows(db, sessionId)
      .filter((row) => row.vector_content_hash !== row.content_hash)
      .slice(0, Math.max(0, limit))
      .map((row) => ({
        id: row.id,
        session_id: row.session_id,
        search_text: row.search_text,
        indexed_at: row.indexed_at,
        content_hash: row.content_hash
      }))
  }

  private getVectorizedCount(db: Database.Database, sessionId: string): number {
    return this.getSessionVectorHashRows(db, sessionId)
      .filter((row) => row.vector_content_hash === row.content_hash)
      .length
  }

  private getVectorTaskKey(sessionId: string): string {
    return `${sessionId}:${this.getCurrentVectorModelId()}`
  }

  private getVectorStateRow(db: Database.Database, sessionId: string): SessionVectorStateRow | null {
    const vectorModel = this.getCurrentVectorModelId()
    const row = db.prepare(`
      SELECT *
      FROM session_vector_state
      WHERE session_id = ? AND vector_model = ?
    `).get(sessionId, vectorModel) as SessionVectorStateRow | undefined
    return row || null
  }

  private isSessionVectorComplete(db: Database.Database, sessionId: string): boolean {
    return Number(this.getVectorStateRow(db, sessionId)?.is_complete || 0) === 1
  }

  private setSessionVectorState(db: Database.Database, input: {
    sessionId: string
    confirmedAt?: number | null
    completedAt?: number | null
    isComplete: boolean
    lastError?: string | null
  }): void {
    const now = Date.now()
    db.prepare(`
      INSERT INTO session_vector_state (
        session_id,
        vector_model,
        confirmed_at,
        completed_at,
        updated_at,
        is_complete,
        last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, vector_model) DO UPDATE SET
        confirmed_at = COALESCE(excluded.confirmed_at, session_vector_state.confirmed_at),
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at,
        is_complete = excluded.is_complete,
        last_error = excluded.last_error
    `).run(
      input.sessionId,
      this.getCurrentVectorModelId(),
      input.confirmedAt ?? null,
      input.completedAt ?? null,
      now,
      input.isComplete ? 1 : 0,
      input.lastError ?? null
    )
  }

  getSessionVectorIndexState(sessionId: string): ChatVectorIndexState {
    const db = this.getDb()
    const profile = this.getCurrentVectorProfile()
    const indexedCount = this.getIndexedCount(db, sessionId)
    const vectorizedCount = this.getVectorizedCount(db, sessionId)
    const isRunning = this.vectorTasks.has(this.getVectorTaskKey(sessionId))
    const row = this.getVectorStateRow(db, sessionId)
    const runtimeAvailable = this.vectorStore.isAvailable() && (profile.mode !== 'online' || profile.enabled !== false)
    const runtimeError = this.vectorStore.getError() || (profile.mode === 'online' && profile.enabled === false ? '未配置在线语义向量服务' : '')
    const isComplete = runtimeAvailable
      && Number(row?.is_complete || 0) === 1
      && vectorizedCount >= indexedCount

    return {
      sessionId,
      indexedCount,
      vectorizedCount,
      pendingCount: Math.max(0, indexedCount - vectorizedCount),
      isVectorComplete: isComplete,
      isVectorRunning: isRunning,
      vectorModel: this.getCurrentVectorModelId(),
      vectorModelName: profile.displayName,
      vectorDim: profile.dim,
      vectorIndexVersion: INDEX_SCHEMA_VERSION,
      vectorStoreName: this.vectorStore.name,
      vectorModelDtype: profile.dtype,
      vectorModelSizeLabel: profile.sizeLabel,
      embeddingMode: profile.mode,
      vectorProviderName: profile.providerName,
      vectorProviderAvailable: runtimeAvailable,
      vectorProviderError: runtimeError
    }
  }

  getSessionSearchIndexState(sessionId: string): ChatSearchIndexState | null {
    const db = this.getDb()
    return this.getSessionState(db, sessionId)
  }

  ensureSessionIndexedInBackground(sessionId: string): void {
    void this.ensureSessionIndexed(sessionId).catch((error) => {
      console.warn('[ChatSearchIndex] 后台搜索索引准备失败:', error)
    })
  }

  private async yieldToEventLoop(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }

  private async idleBetweenVectorBatches(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, VECTOR_BATCH_IDLE_MS))
  }

  private getVectorBatchSize(): number {
    return embeddingRuntimeService.getCurrentBatchSize(VECTOR_BATCH_SIZE)
  }

  private async reportVectorProgress(
    progress: Omit<
      ChatVectorIndexProgress,
      'vectorModel' | 'vectorModelName' | 'vectorDim' | 'vectorIndexVersion' | 'vectorStoreName' | 'vectorModelDtype' | 'vectorModelSizeLabel' | 'embeddingMode' | 'vectorProviderName'
    >,
    onProgress?: (progress: ChatVectorIndexProgress) => void | Promise<void>
  ): Promise<void> {
    const profile = this.getCurrentVectorProfile()
    await onProgress?.({
      ...progress,
      vectorModel: this.getCurrentVectorModelId(),
      vectorModelName: profile.displayName,
      vectorDim: profile.dim,
      vectorIndexVersion: INDEX_SCHEMA_VERSION,
      vectorStoreName: this.vectorStore.name,
      vectorModelDtype: profile.dtype,
      vectorModelSizeLabel: profile.sizeLabel,
      embeddingMode: profile.mode,
      vectorProviderName: profile.providerName
    })
  }

  private async upsertVectorRows(
    db: Database.Database,
    rows: VectorEmbeddingRow[]
  ): Promise<void> {
    if (rows.length === 0) return
    if (!this.vectorStore.isAvailable()) {
      throw new Error(`本地语义检索不可用：${this.vectorStore.getError() || 'sqlite-vec 未加载'}`)
    }

    const vectorModelId = this.getCurrentVectorModelId()
    const embeddings = await embeddingRuntimeService.embedTexts(rows.map((row) => row.search_text), { inputType: 'document' })

    const upsertVector = db.prepare(`
      INSERT INTO message_vector_index (
        message_id,
        session_id,
        vector_model,
        embedding_blob,
        dim,
        content_hash,
        indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id, vector_model) DO UPDATE SET
        session_id = excluded.session_id,
        embedding_blob = excluded.embedding_blob,
        dim = excluded.dim,
        content_hash = excluded.content_hash,
        indexed_at = excluded.indexed_at
    `)
    const selectVectorId = db.prepare(`
      SELECT id FROM message_vector_index
      WHERE message_id = ? AND vector_model = ?
    `)
    const selectExistingVector = db.prepare(`
      SELECT id, content_hash FROM message_vector_index
      WHERE message_id = ? AND vector_model = ?
    `)
    const deleteVector = db.prepare('DELETE FROM message_vector_index WHERE id = ?')

    const run = db.transaction((items: VectorEmbeddingRow[]) => {
      const now = Date.now()
      for (let index = 0; index < items.length; index += 1) {
        const row = items[index]
        const vector = embeddings[index]
        const embedding = float32ArrayToBuffer(vector)
        const contentHash = row.content_hash || hashEmbeddingContent(row.search_text)
        const existing = selectExistingVector.get(row.id, vectorModelId) as { id?: number; content_hash?: string } | undefined
        if (existing?.id && existing.content_hash !== contentHash) {
          this.vectorStore.deleteByVectorId(db, Number(existing.id))
          deleteVector.run(Number(existing.id))
        }
        upsertVector.run(
          row.id,
          row.session_id,
          vectorModelId,
          embedding,
          vector.length,
          contentHash,
          row.indexed_at || now
        )
        const vectorRow = selectVectorId.get(row.id, vectorModelId) as { id?: number } | undefined
        if (vectorRow?.id) {
          this.vectorStore.upsert(db, {
            vectorId: Number(vectorRow.id),
            sessionKey: vectorSessionKey(row.session_id),
            sessionId: row.session_id,
            modelId: vectorModelId,
            embedding
          })
        }
      }
    })

    run(rows)
  }

  private async upsertMessages(db: Database.Database, sessionId: string, messages: Message[], options: {
    vectorize?: boolean
  } = {}): Promise<void> {
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
    const vectorRows: VectorEmbeddingRow[] = []

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
        if (options.vectorize) {
          vectorRows.push({
            id: row.id,
            session_id: sessionId,
            search_text: searchText,
            indexed_at: indexedAt
          })
        }
      }
    })

    run(messages)
    if (vectorRows.length > 0) {
      try {
        const contextRows = db.prepare(`
          SELECT id, sort_seq, create_time, sender_username, search_text
          FROM message_index WHERE session_id = ?
          ORDER BY sort_seq ASC, create_time ASC, local_id ASC
        `).all(sessionId) as ChunkContextRow[]
        const contextIdMap = new Map<number, number>()
        for (let i = 0; i < contextRows.length; i++) {
          contextIdMap.set(contextRows[i].id, i)
        }
        for (const row of vectorRows) {
          const idx = contextIdMap.get(row.id)
          if (idx !== undefined) {
            row.search_text = buildChunkedEmbeddingText(idx, contextRows)
            row.content_hash = hashEmbeddingContent(row.search_text)
          }
        }

        const vectorBatchSize = this.getVectorBatchSize()
        for (let index = 0; index < vectorRows.length; index += vectorBatchSize) {
          await this.upsertVectorRows(db, vectorRows.slice(index, index + vectorBatchSize))
          if (index + vectorBatchSize < vectorRows.length) {
            await this.idleBetweenVectorBatches()
          }
        }
      } catch (error) {
        this.setSessionVectorState(db, {
          sessionId,
          completedAt: null,
          isComplete: false,
          lastError: String(error)
        })
      }
    }
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

  private getVectorIdsBySession(db: Database.Database, sessionId: string): number[] {
    return (db.prepare('SELECT id FROM message_vector_index WHERE session_id = ?').all(sessionId) as Array<{ id?: number }>)
      .map((row) => Number(row.id || 0))
      .filter((id) => id > 0)
  }

  async ensureSessionIndexed(
    sessionId: string,
    onProgress?: ChatSearchSessionOptions['onProgress']
  ): Promise<ChatSearchIndexState> {
    const db = this.getDb()
    const state = this.getSessionState(db, sessionId)
    const vectorizeDuringIndexing = this.isSessionVectorComplete(db, sessionId)
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
        await this.upsertMessages(db, sessionId, messages, { vectorize: vectorizeDuringIndexing })
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
    this.vectorStore.deleteByVectorIds(db, this.getVectorIdsBySession(db, sessionId))
    db.prepare('DELETE FROM message_vector_index WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM message_index WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM session_index_state WHERE session_id = ?').run(sessionId)

    const firstPage = await chatService.getMessages(sessionId, 0, INDEX_BATCH_SIZE)
    if (!firstPage.success) {
      throw new Error(firstPage.error || '建立搜索索引失败')
    }

    let messages = firstPage.messages || []
    let hasMore = Boolean(firstPage.hasMore)
    if (messages.length > 0) {
      await this.upsertMessages(db, sessionId, messages, { vectorize: vectorizeDuringIndexing })
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
      await this.upsertMessages(db, sessionId, messages, { vectorize: vectorizeDuringIndexing })
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

  async prepareSessionVectorIndex(
    sessionId: string,
    onProgress?: (progress: ChatVectorIndexProgress) => void | Promise<void>
  ): Promise<ChatVectorIndexState> {
    const key = this.getVectorTaskKey(sessionId)
    const existingTask = this.vectorTasks.get(key)
    if (existingTask) {
      await this.reportVectorProgress({
        sessionId,
        stage: 'preparing',
        status: 'running',
        processedCount: this.getSessionVectorIndexState(sessionId).vectorizedCount,
        totalCount: this.getSessionVectorIndexState(sessionId).indexedCount,
        message: '当前会话正在向量化，复用已有任务'
      }, onProgress)
      return existingTask.promise
    }

    const task: VectorTask = {
      cancelRequested: false,
      promise: Promise.resolve(this.getSessionVectorIndexState(sessionId))
    }
    task.promise = this.runPrepareSessionVectorIndex(sessionId, task, onProgress)
    this.vectorTasks.set(key, task)

    try {
      return await task.promise
    } finally {
      this.vectorTasks.delete(key)
    }
  }

  cancelSessionVectorIndex(sessionId: string): ChatVectorIndexState {
    const task = this.vectorTasks.get(this.getVectorTaskKey(sessionId))
    if (task) {
      task.cancelRequested = true
    }
    return this.getSessionVectorIndexState(sessionId)
  }

  clearSemanticVectorIndex(vectorModel = this.getCurrentVectorModelId()): { success: boolean; deletedCount: number; vectorModel: string } {
    const db = this.getDb()
    const resolvedVectorModel = vectorModel.includes('@') ? vectorModel : localEmbeddingModelService.getVectorModelId(vectorModel)
    const row = db.prepare('SELECT COUNT(*) AS count FROM message_vector_index WHERE vector_model = ?').get(resolvedVectorModel) as { count?: number }
    this.vectorStore.clearModel(db, resolvedVectorModel)
    db.prepare('DELETE FROM message_vector_index WHERE vector_model = ?').run(resolvedVectorModel)
    db.prepare('DELETE FROM session_vector_state WHERE vector_model = ?').run(resolvedVectorModel)
    return {
      success: true,
      deletedCount: Number(row?.count || 0),
      vectorModel: resolvedVectorModel
    }
  }

  private async runPrepareSessionVectorIndex(
    sessionId: string,
    task: VectorTask,
    onProgress?: (progress: ChatVectorIndexProgress) => void | Promise<void>
  ): Promise<ChatVectorIndexState> {
    const db = this.getDb()

    await this.reportVectorProgress({
      sessionId,
      stage: 'preparing',
      status: 'running',
      processedCount: 0,
      totalCount: 0,
      message: '正在准备当前会话搜索索引'
    }, onProgress)

    try {
      if (!this.vectorStore.isAvailable()) {
        throw new Error(`本地语义检索不可用：${this.vectorStore.getError() || 'sqlite-vec 未加载'}`)
      }

      const profile = this.getCurrentVectorProfile()
      if (profile.mode === 'online') {
        embeddingRuntimeService.ensureReady()
      } else {
        const modelStatus = await localEmbeddingModelService.getModelStatus(profile.id)
        if (!modelStatus.exists) {
          await this.reportVectorProgress({
            sessionId,
            stage: 'downloading_model',
            status: 'running',
            processedCount: 0,
            totalCount: 0,
            message: `正在下载本地语义模型：${profile.displayName}`
          }, onProgress)
          await localEmbeddingModelService.downloadModel(profile.id, async (progress) => {
            await this.reportVectorProgress({
              sessionId,
              stage: 'downloading_model',
              status: 'running',
              processedCount: progress.loaded || 0,
              totalCount: progress.total || 0,
              message: progress.percent !== undefined
                ? `正在下载 ${profile.displayName}：${progress.percent}%`
                : `正在下载 ${profile.displayName}`
            }, onProgress)
          })
        }
      }

      const searchState = await this.ensureSessionIndexed(sessionId, async (progress) => {
        if (task.cancelRequested) {
          throw new Error(VECTOR_INDEX_CANCELLED_ERROR)
        }
        await this.reportVectorProgress({
          sessionId,
          stage: 'indexing_messages',
          status: 'running',
          processedCount: progress.indexedCount ?? progress.messagesScanned ?? 0,
          totalCount: progress.indexedCount ?? 0,
          message: progress.message
        }, onProgress)
        if (task.cancelRequested) {
          throw new Error(VECTOR_INDEX_CANCELLED_ERROR)
        }
      })

      let currentState = this.getSessionVectorIndexState(sessionId)
      if (currentState.isVectorComplete) {
        await this.reportVectorProgress({
          sessionId,
          stage: 'completed',
          status: 'completed',
          processedCount: currentState.vectorizedCount,
          totalCount: currentState.indexedCount,
          message: `本地语义向量索引已就绪，共 ${currentState.vectorizedCount} 条消息`
        }, onProgress)
        return currentState
      }

      this.setSessionVectorState(db, {
        sessionId,
        confirmedAt: Date.now(),
        completedAt: null,
        isComplete: false,
        lastError: null
      })

      if (searchState.indexedCount === 0) {
        this.setSessionVectorState(db, {
          sessionId,
          completedAt: Date.now(),
          isComplete: true,
          lastError: null
        })
        currentState = this.getSessionVectorIndexState(sessionId)
        await this.reportVectorProgress({
          sessionId,
          stage: 'completed',
          status: 'completed',
          processedCount: 0,
          totalCount: 0,
          message: '当前会话暂无可向量化消息'
        }, onProgress)
        return currentState
      }

      while (true) {
        if (task.cancelRequested) {
          this.setSessionVectorState(db, {
            sessionId,
            completedAt: null,
            isComplete: false,
            lastError: 'cancelled'
          })
          currentState = this.getSessionVectorIndexState(sessionId)
          await this.reportVectorProgress({
            sessionId,
            stage: 'vectorizing_messages',
            status: 'cancelled',
            processedCount: currentState.vectorizedCount,
            totalCount: currentState.indexedCount,
            message: '已取消当前会话向量化'
          }, onProgress)
          return currentState
        }

        const rows = this.getPendingVectorRows(db, sessionId, this.getVectorBatchSize())

        if (rows.length === 0) break

        await this.upsertVectorRows(db, rows)
        currentState = this.getSessionVectorIndexState(sessionId)
        await this.reportVectorProgress({
          sessionId,
          stage: 'vectorizing_messages',
          status: 'running',
          processedCount: currentState.vectorizedCount,
          totalCount: currentState.indexedCount,
          message: `已向量化 ${currentState.vectorizedCount}/${currentState.indexedCount} 条消息`
        }, onProgress)
        await this.idleBetweenVectorBatches()
      }

      this.setSessionVectorState(db, {
        sessionId,
        completedAt: Date.now(),
        isComplete: true,
        lastError: null
      })
      currentState = this.getSessionVectorIndexState(sessionId)

      await this.reportVectorProgress({
        sessionId,
        stage: 'completed',
        status: 'completed',
        processedCount: currentState.vectorizedCount,
        totalCount: currentState.indexedCount,
        message: `本地语义向量索引已完成，共 ${currentState.vectorizedCount} 条消息`
      }, onProgress)

      return currentState
    } catch (error) {
      if (error instanceof Error && error.message === VECTOR_INDEX_CANCELLED_ERROR) {
        this.setSessionVectorState(db, {
          sessionId,
          completedAt: null,
          isComplete: false,
          lastError: 'cancelled'
        })
        const cancelledState = this.getSessionVectorIndexState(sessionId)
        await this.reportVectorProgress({
          sessionId,
          stage: 'indexing_messages',
          status: 'cancelled',
          processedCount: cancelledState.vectorizedCount,
          totalCount: cancelledState.indexedCount,
          message: '已取消当前会话向量化'
        }, onProgress)
        return cancelledState
      }

      this.setSessionVectorState(db, {
        sessionId,
        completedAt: null,
        isComplete: false,
        lastError: String(error)
      })
      const failedState = this.getSessionVectorIndexState(sessionId)
      await this.reportVectorProgress({
        sessionId,
        stage: 'vectorizing_messages',
        status: 'failed',
        processedCount: failedState.vectorizedCount,
        totalCount: failedState.indexedCount,
        message: `向量化失败：${String(error)}`
      }, onProgress)
      throw error
    }
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

  async searchSessionByVector(options: ChatSearchSessionOptions): Promise<ChatVectorSearchSessionResult> {
    const db = this.getDb()
    const state = await this.ensureSessionIndexed(options.sessionId, options.onProgress)
    const vectorState = this.getSessionVectorIndexState(options.sessionId)
    const vectorizedCount = vectorState.vectorizedCount

    if (!this.vectorStore.isAvailable() || !vectorState.isVectorComplete || !normalizeSearchText(options.query)) {
      return {
        hits: [],
        indexedCount: state.indexedCount,
        vectorizedCount,
        truncated: false,
        model: this.getCurrentVectorModelId()
      }
    }

    const queryVector = await embeddingRuntimeService.embedText(options.query, { inputType: 'query' })
    const queryEmbedding = float32ArrayToBuffer(queryVector)

    await this.report({
      stage: 'searching_index',
      sessionId: options.sessionId,
      message: `正在进行本地语义检索：${options.query}`,
      indexedCount: state.indexedCount
    }, options.onProgress)

    const startTime = toTimestampSeconds(options.startTimeMs)
    const endTime = toTimestampSeconds(options.endTimeMs)
    const senderUsername = normalizeSearchText(options.senderUsername)
    const direction = options.direction
    const scanLimit = Math.max(options.limit * VECTOR_SEARCH_OVERFETCH, options.limit + 20)
    const params: Record<string, unknown> = {
      sessionId: options.sessionId,
      vectorModel: this.getCurrentVectorModelId()
    }

    const postFilters: string[] = []
    if (startTime) {
      postFilters.push('m.create_time >= @startTime')
      params.startTime = startTime
    }
    if (endTime) {
      postFilters.push('m.create_time <= @endTime')
      params.endTime = endTime
    }
    if (direction) {
      postFilters.push(direction === 'out' ? 'm.is_send = 1' : '(m.is_send IS NULL OR m.is_send != 1)')
    }
    if (senderUsername) {
      postFilters.push('lower(COALESCE(m.sender_username, \'\')) = @senderUsername')
      params.senderUsername = senderUsername
    }
    const postWhere = postFilters.length > 0 ? `AND ${postFilters.join(' AND ')}` : ''

    const vectorHits = this.vectorStore.search(db, {
      sessionKey: vectorSessionKey(options.sessionId),
      queryEmbedding,
      limit: scanLimit + 1
    })
    const distanceByVectorId = new Map<number, number>()
    for (const hit of vectorHits) {
      distanceByVectorId.set(hit.vectorId, hit.distance)
    }

    const vectorIds = vectorHits.map((hit) => hit.vectorId).filter((id) => id > 0)
    const vectorIdParams: Record<string, number> = {}
    for (let index = 0; index < vectorIds.length; index += 1) {
      vectorIdParams[`vectorId${index}`] = vectorIds[index]
    }
    const vectorIdPlaceholders = vectorIds.map((_, index) => `@vectorId${index}`).join(', ')
    const rows = vectorIds.length === 0
      ? []
      : db.prepare(`
      SELECT m.*, v.id AS vector_id
      FROM message_vector_index v
      JOIN message_index m ON m.id = v.message_id AND m.session_id = @sessionId
      WHERE v.id IN (${vectorIdPlaceholders})
        AND v.vector_model = @vectorModel
      ${postWhere}
    `).all({
        ...params,
        ...vectorIdParams
      }) as Array<MessageIndexRow & { vector_id: number }>
    const scored = rows
      .map((row) => {
        const distance = distanceByVectorId.get(Number(row.vector_id || 0)) ?? 1
        const vectorScore = Math.max(0, Math.min(1, 1 - Number(distance || 0)))
        return {
          row,
          vectorScore
        }
      })
      .filter((item) => item.vectorScore >= VECTOR_MIN_SCORE)
      .sort((a, b) => b.vectorScore - a.vectorScore || compareIndexRowCursorAsc(b.row, a.row))
      .slice(0, options.limit)

    const hits = scored.map(({ row, vectorScore }) => ({
      sessionId: options.sessionId,
      message: rowToMessage(row),
      excerpt: createVectorExcerpt(row, options.query),
      matchedField: 'text' as const,
      score: Number((VECTOR_SCORE_BASE + vectorScore * VECTOR_SCORE_SCALE).toFixed(2))
    } satisfies ChatSearchIndexHit))

    return {
      hits,
      indexedCount: state.indexedCount,
      vectorizedCount,
      truncated: rows.length > scanLimit,
      model: this.getCurrentVectorModelId()
    }
  }

  async listSessionMemoryMessages(
    sessionId: string,
    onProgress?: ChatSearchSessionOptions['onProgress']
  ): Promise<ChatSearchMemoryMessage[]> {
    await this.ensureSessionIndexed(sessionId, onProgress)
    const rows = this.getDb().prepare(`
      SELECT
        id,
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
        search_text
      FROM message_index
      WHERE session_id = ?
        AND trim(search_text) != ''
      ORDER BY sort_seq ASC, create_time ASC, local_id ASC
    `).all(sessionId) as Array<Pick<MessageIndexRow,
      | 'id'
      | 'session_id'
      | 'local_id'
      | 'server_id'
      | 'local_type'
      | 'create_time'
      | 'sort_seq'
      | 'is_send'
      | 'sender_username'
      | 'parsed_content'
      | 'raw_content'
      | 'search_text'
    >>

    return rows.map((row) => ({
      id: Number(row.id || 0),
      sessionId: row.session_id,
      localId: Number(row.local_id || 0),
      serverId: Number(row.server_id || 0),
      localType: Number(row.local_type || 0),
      createTime: Number(row.create_time || 0),
      sortSeq: Number(row.sort_seq || 0),
      isSend: row.is_send ?? null,
      senderUsername: row.sender_username ?? null,
      parsedContent: String(row.parsed_content || ''),
      rawContent: String(row.raw_content || ''),
      searchText: String(row.search_text || '')
    }))
  }
}

export const chatSearchIndexService = new ChatSearchIndexService()
