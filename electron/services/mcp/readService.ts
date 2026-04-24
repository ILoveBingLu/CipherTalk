import { accessSync, constants, existsSync, mkdirSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod'
import { analyticsService } from '../analyticsService'
import { chatService, type ChatSession, type ContactInfo, type Message } from '../chatService'
import { ConfigService } from '../config'
import { exportService, type ExportOptions as ExportServiceOptions } from '../exportService'
import { groupAnalyticsService } from '../groupAnalyticsService'
import { imageDecryptService } from '../imageDecryptService'
import { snsService } from '../snsService'
import { chatSearchIndexService } from '../search/chatSearchIndexService'
import { videoService } from '../videoService'
import { McpToolError } from './result'
import {
  MCP_CONTACT_KINDS,
  MCP_MESSAGE_KINDS,
  type McpContactItem,
  type McpContactKind,
  type McpContactsPayload,
  type McpCursor,
  type McpExportChatPayload,
  type McpExportDateRange,
  type McpExportFormat,
  type McpExportMediaOptions,
  type McpExportMissingField,
  type McpGlobalStatisticsPayload,
  type McpContactRankingItem,
  type McpContactRankingsPayload,
  type McpActivityDistributionPayload,
  type McpMomentItem,
  type McpMomentsTimelinePayload,
  type McpMessageItem,
  type McpMessageKind,
  type McpMessageMatchField,
  type McpSearchMatchMode,
  type McpMessagesPayload,
  type McpStreamPartialPayloadMap,
  type McpStreamProgressPayload,
  type McpSearchHit,
  type McpSearchMessagesPayload,
  type McpResolveSessionPayload,
  type McpResolvedSessionCandidate,
  type McpSessionContextPayload,
  type McpSessionItem,
  type McpSessionKind,
  type McpSessionRef,
  type McpSessionsPayload
} from './types'

const MAX_LIST_LIMIT = 200
const MAX_SEARCH_LIMIT = 100
const MAX_CONTEXT_LIMIT = 100
const SEARCH_BATCH_SIZE = 200
const MAX_SEARCH_SESSIONS = 20
const MAX_SCAN_PER_SESSION = 1000
const MAX_SCAN_GLOBAL = 10000
const MAX_TARGETED_SCAN_PER_SESSION = 200000
const MAX_TARGETED_SCAN_GLOBAL = 200000

const listSessionsArgsSchema = z.object({
  q: z.string().optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
  unreadOnly: z.boolean().optional()
})

const resolveSessionArgsSchema = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().positive().optional()
})

const exportChatArgsSchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
  query: z.string().trim().min(1).optional(),
  format: z.enum(['chatlab', 'chatlab-jsonl', 'json', 'excel', 'html']).optional(),
  dateRange: z.object({
    start: z.number().int().positive(),
    end: z.number().int().positive()
  }).optional(),
  mediaOptions: z.object({
    exportAvatars: z.boolean().optional(),
    exportImages: z.boolean().optional(),
    exportVideos: z.boolean().optional(),
    exportEmojis: z.boolean().optional(),
    exportVoices: z.boolean().optional()
  }).optional(),
  outputDir: z.string().trim().min(1).optional(),
  validateOnly: z.boolean().optional()
}).superRefine((value, ctx) => {
  if (!value.sessionId && !value.query) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sessionId'],
      message: 'sessionId or query is required'
    })
  }
})

const getMessagesArgsSchema = z.object({
  sessionId: z.string().trim().min(1),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
  order: z.enum(['asc', 'desc']).optional(),
  keyword: z.string().optional(),
  startTime: z.number().int().positive().optional(),
  endTime: z.number().int().positive().optional(),
  includeRaw: z.boolean().optional(),
  includeMediaPaths: z.boolean().optional()
})

const listContactsArgsSchema = z.object({
  q: z.string().optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
  types: z.array(z.enum(MCP_CONTACT_KINDS)).optional()
})

const searchMessagesArgsSchema = z.object({
  query: z.string().trim().min(1),
  sessionId: z.string().trim().min(1).optional(),
  sessionIds: z.array(z.string().trim().min(1)).max(MAX_SEARCH_SESSIONS).optional(),
  startTime: z.number().int().positive().optional(),
  endTime: z.number().int().positive().optional(),
  kinds: z.array(z.enum(MCP_MESSAGE_KINDS)).optional(),
  direction: z.enum(['in', 'out']).optional(),
  senderUsername: z.string().trim().min(1).optional(),
  matchMode: z.enum(['substring', 'exact']).optional(),
  limit: z.number().int().positive().optional(),
  includeRaw: z.boolean().optional(),
  includeMediaPaths: z.boolean().optional()
})

const analyticsTimeRangeArgsSchema = z.object({
  startTime: z.number().int().positive().optional(),
  endTime: z.number().int().positive().optional()
})

const getMomentsTimelineArgsSchema = z.object({
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  usernames: z.array(z.string().trim().min(1)).optional(),
  keyword: z.string().optional(),
  startTime: z.number().int().positive().optional(),
  endTime: z.number().int().positive().optional(),
  includeRaw: z.boolean().optional()
})

const contactRankingsArgsSchema = analyticsTimeRangeArgsSchema.extend({
  limit: z.number().int().positive().optional()
})

const cursorSchema = z.object({
  sortSeq: z.number().int(),
  createTime: z.number().int().positive(),
  localId: z.number().int()
})

const getSessionContextArgsSchema = z.object({
  sessionId: z.string().trim().min(1),
  mode: z.enum(['latest', 'around']),
  anchorCursor: cursorSchema.optional(),
  beforeLimit: z.number().int().positive().optional(),
  afterLimit: z.number().int().positive().optional(),
  includeRaw: z.boolean().optional(),
  includeMediaPaths: z.boolean().optional()
}).superRefine((value, ctx) => {
  if (value.mode === 'around' && !value.anchorCursor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['anchorCursor'],
      message: 'anchorCursor is required when mode=around'
    })
  }
})

type ListSessionsArgs = z.infer<typeof listSessionsArgsSchema>
type ResolveSessionArgs = z.infer<typeof resolveSessionArgsSchema>
type ExportChatArgs = z.infer<typeof exportChatArgsSchema>
type GetMessagesArgs = z.infer<typeof getMessagesArgsSchema>
type ListContactsArgs = z.infer<typeof listContactsArgsSchema>
type SearchMessagesArgs = z.infer<typeof searchMessagesArgsSchema>
type GetMomentsTimelineArgs = z.infer<typeof getMomentsTimelineArgsSchema>
type GetSessionContextArgs = z.infer<typeof getSessionContextArgsSchema>
type ContactWithLastContact = ContactInfo & { lastContactTime?: number }
type MessageNormalizeOptions = {
  includeMediaPaths: boolean
  includeRaw: boolean
}
type McpContactRef = {
  contactId: string
  sessionId: string
  displayName: string
  remark?: string
  nickname?: string
  kind: McpContactKind
}
type McpSessionLookupEntry = {
  session: McpSessionRef
  aliases: string[]
}
type ScoredSessionCandidate = { entry: McpSessionLookupEntry; score: number }
type SearchRawHit = {
  session: McpSessionRef
  message: Message
  matchedField: McpMessageMatchField
  excerpt: string
  score: number
}
type SenderDisplayNameCacheEntry = {
  expiresAt: number
  value: Promise<string | null>
}
type GroupMemberDisplayMapCacheEntry = {
  expiresAt: number
  value: Promise<Map<string, string>>
}
type McpStreamReporter = {
  progress?: (payload: McpStreamProgressPayload) => void | Promise<void>
  partial?: <K extends keyof McpStreamPartialPayloadMap>(toolName: K, payload: McpStreamPartialPayloadMap[K]) => void | Promise<void>
}

const SUPPORTED_EXPORT_FORMATS: McpExportFormat[] = ['chatlab', 'chatlab-jsonl', 'json', 'excel', 'html']
const SENDER_DISPLAY_NAME_CACHE_TTL = 5 * 60 * 1000
const senderDisplayNameCache = new Map<string, SenderDisplayNameCacheEntry>()
const groupMemberDisplayMapCache = new Map<string, GroupMemberDisplayMapCacheEntry>()

function toTimestampMs(value?: number | null): number {
  if (!value || !Number.isFinite(value) || value <= 0) return 0
  return value < 1_000_000_000_000 ? value * 1000 : value
}

function detectSessionKind(sessionId: string): McpSessionKind {
  if (sessionId.includes('@chatroom')) return 'group'
  if (sessionId.startsWith('gh_')) return 'official'
  if (sessionId) return 'friend'
  return 'other'
}

function detectMessageKind(message: Pick<Message, 'localType' | 'rawContent' | 'parsedContent'>): McpMessageKind {
  const localType = Number(message.localType || 0)
  const raw = String(message.rawContent || message.parsedContent || '')
  const xmlTypeMatch = raw.match(/<type>\s*([^<]+)\s*<\/type>/i)
  const appMsgType = xmlTypeMatch?.[1]?.trim()

  if (localType === 1) return 'text'
  if (localType === 3) return 'image'
  if (localType === 34) return 'voice'
  if (localType === 42) return 'contact_card'
  if (localType === 43) return 'video'
  if (localType === 47) return 'emoji'
  if (localType === 48) return 'location'
  if (localType === 50) return 'voip'
  if (localType === 10000) return 'system'
  if (localType === 244813135921) return 'quote'

  if (localType === 49 || appMsgType) {
    switch (appMsgType) {
      case '3':
        return 'app_music'
      case '5':
      case '49':
        return 'app_link'
      case '6':
        return 'app_file'
      case '19':
        return 'app_chat_record'
      case '33':
      case '36':
        return 'app_mini_program'
      case '57':
        return 'app_quote'
      case '62':
        return 'app_pat'
      case '87':
        return 'app_announcement'
      case '115':
        return 'app_gift'
      case '2000':
        return 'app_transfer'
      case '2001':
        return 'app_red_packet'
      default:
        return 'app'
    }
  }

  return 'unknown'
}

function compareMessageCursorAsc(
  a: Pick<Message, 'sortSeq' | 'createTime' | 'localId'>,
  b: Pick<Message, 'sortSeq' | 'createTime' | 'localId'>
): number {
  return Number(a.sortSeq || 0) - Number(b.sortSeq || 0)
    || Number(a.createTime || 0) - Number(b.createTime || 0)
    || Number(a.localId || 0) - Number(b.localId || 0)
}

function compareMessageCursorDesc(
  a: Pick<Message, 'sortSeq' | 'createTime' | 'localId'>,
  b: Pick<Message, 'sortSeq' | 'createTime' | 'localId'>
): number {
  return compareMessageCursorAsc(b, a)
}

function buildCursor(message: Pick<Message, 'sortSeq' | 'createTime' | 'localId'>): McpCursor {
  return {
    sortSeq: Number(message.sortSeq || 0),
    createTime: Number(message.createTime || 0),
    localId: Number(message.localId || 0)
  }
}

function sameCursor(
  message: Pick<Message, 'sortSeq' | 'createTime' | 'localId'>,
  cursor: McpCursor
): boolean {
  return Number(message.sortSeq || 0) === cursor.sortSeq
    && Number(message.createTime || 0) === cursor.createTime
    && Number(message.localId || 0) === cursor.localId
}

function uniqueMessageList(messages: Message[]): Message[] {
  const seen = new Set<string>()
  return messages.filter((message) => {
    const key = `${message.serverId}-${message.localId}-${message.createTime}-${message.sortSeq}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizeQuery(value?: string): string {
  return String(value || '').trim().toLowerCase()
}

function createExcerpt(source: string, matchedIndex: number, queryLength: number): string {
  if (!source) return ''
  const radius = 48
  const safeIndex = Math.max(0, matchedIndex)
  const start = Math.max(0, safeIndex - radius)
  const end = Math.min(source.length, safeIndex + queryLength + radius)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < source.length ? '...' : ''
  return `${prefix}${source.slice(start, end)}${suffix}`
}

function buildTimeRange(startTime?: number, endTime?: number) {
  const normalizedStartTime = startTime && Number.isFinite(startTime) ? Number(startTime) : undefined
  const normalizedEndTime = endTime && Number.isFinite(endTime) ? Number(endTime) : undefined

  return {
    startTime: normalizedStartTime,
    startTimeMs: normalizedStartTime ? toTimestampMs(normalizedStartTime) : undefined,
    endTime: normalizedEndTime,
    endTimeMs: normalizedEndTime ? toTimestampMs(normalizedEndTime) : undefined
  }
}

function buildSearchScore(args: {
  matchedField: McpMessageMatchField
  matchIndex: number
  excerptLength: number
}): number {
  const fieldScore = args.matchedField === 'text' ? 1000 : 700
  const positionScore = Math.max(0, 240 - Math.min(args.matchIndex, 240))
  const excerptPenalty = Math.min(args.excerptLength, 200) / 10
  return Number((fieldScore + positionScore - excerptPenalty).toFixed(2))
}

function findKeywordMatch(
  message: Message,
  query: string,
  matchMode: McpSearchMatchMode = 'substring'
): { matchedField: McpMessageMatchField; excerpt: string; score: number } | null {
  const exactQuery = String(query || '').trim()
  const normalizedQuery = normalizeQuery(query)
  if (!normalizedQuery || !exactQuery) return null

  const text = String(message.parsedContent || '')
  const raw = String(message.rawContent || '')
  const textIndex = matchMode === 'exact'
    ? text.indexOf(exactQuery)
    : text.toLowerCase().indexOf(normalizedQuery)
  if (textIndex >= 0) {
    const excerpt = createExcerpt(text, textIndex, normalizedQuery.length)
    return {
      matchedField: 'text',
      excerpt,
      score: buildSearchScore({
        matchedField: 'text',
        matchIndex: textIndex,
        excerptLength: excerpt.length
      })
    }
  }

  const rawIndex = matchMode === 'exact'
    ? raw.indexOf(exactQuery)
    : raw.toLowerCase().indexOf(normalizedQuery)
  if (rawIndex >= 0) {
    const excerpt = createExcerpt(raw, rawIndex, normalizedQuery.length)
    return {
      matchedField: 'raw',
      excerpt,
      score: buildSearchScore({
        matchedField: 'raw',
        matchIndex: rawIndex,
        excerptLength: excerpt.length
      })
    }
  }

  return null
}

function toSessionRef(session: Pick<ChatSession, 'username' | 'displayName'>): McpSessionRef {
  return {
    sessionId: session.username,
    displayName: session.displayName || session.username,
    kind: detectSessionKind(session.username)
  }
}

function toSessionItem(session: ChatSession): McpSessionItem {
  return {
    ...toSessionRef(session),
    lastMessagePreview: session.summary || '',
    unreadCount: Number(session.unreadCount || 0),
    lastTimestamp: Number(session.lastTimestamp || 0),
    lastTimestampMs: toTimestampMs(Number(session.lastTimestamp || 0))
  }
}

function toContactRef(contact: ContactWithLastContact): McpContactRef {
  return {
    contactId: contact.username,
    sessionId: contact.username,
    displayName: contact.displayName,
    remark: contact.remark || undefined,
    nickname: contact.nickname || undefined,
    kind: contact.type as McpContactKind
  }
}

function toContactItem(contact: ContactWithLastContact, hasSession: boolean): McpContactItem {
  const lastContactTimestamp = Number(contact.lastContactTime || 0)
  return {
    contactId: contact.username,
    sessionId: contact.username,
    hasSession,
    displayName: contact.displayName,
    remark: contact.remark || undefined,
    nickname: contact.nickname || undefined,
    kind: contact.type as McpContactKind,
    lastContactTimestamp,
    lastContactTimestampMs: toTimestampMs(lastContactTimestamp)
  }
}

function buildContactSearchKeys(contact: McpContactRef): string[] {
  return [
    contact.contactId,
    contact.sessionId,
    contact.displayName,
    contact.remark || '',
    contact.nickname || ''
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = String(value || '').trim()
    if (!trimmed) continue
    const normalized = normalizeQuery(trimmed)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(trimmed)
  }
  return result
}

function isSubsequence(query: string, target: string): boolean {
  let qi = 0
  let ti = 0
  while (qi < query.length && ti < target.length) {
    if (query[qi] === target[ti]) qi += 1
    ti += 1
  }
  return qi === query.length
}

function scoreLookupValue(query: string, rawTarget: string): number {
  const target = normalizeQuery(rawTarget)
  if (!query || !target) return 0
  if (target === query) return 1000
  if (target.startsWith(query)) return 820 + Math.min(query.length * 8, 120)
  if (target.includes(query)) return 640 + Math.min(query.length * 6, 100) - Math.min(Math.max(target.length - query.length, 0), 80)
  if (query.startsWith(target)) return 420 + Math.min(target.length * 5, 80)
  if (isSubsequence(query, target)) return 260 + Math.min(query.length * 4, 60)
  return 0
}

function buildSessionLookupEntries(
  sessions: McpSessionItem[],
  contacts: McpContactRef[]
): McpSessionLookupEntry[] {
  const entryMap = new Map<string, McpSessionLookupEntry>()

  for (const session of sessions) {
    entryMap.set(session.sessionId, {
      session: {
        sessionId: session.sessionId,
        displayName: session.displayName,
        kind: session.kind
      },
      aliases: uniqueStrings([session.sessionId, session.displayName])
    })
  }

  for (const contact of contacts) {
    const entry = entryMap.get(contact.sessionId)
    if (!entry) continue
    entry.aliases = uniqueStrings([
      ...entry.aliases,
      contact.contactId,
      contact.displayName,
      contact.remark || '',
      contact.nickname || ''
    ])
  }

  return Array.from(entryMap.values())
}

function formatSessionCandidateHint(rawInput: string, candidates: McpSessionLookupEntry[]): string {
  if (candidates.length === 0) {
    return `未找到与“${rawInput}”匹配的会话。可先用 list_sessions 或 list_contacts 做泛搜索。`
  }

  const preview = candidates
    .slice(0, 5)
    .map((candidate) => `- ${candidate.session.displayName} (${candidate.session.sessionId})`)
    .join('\n')

  return `“${rawInput}”匹配到多个候选，请改用更具体的信息重试：\n${preview}`
}

async function reportProgress(reporter: McpStreamReporter | undefined, payload: McpStreamProgressPayload): Promise<void> {
  await reporter?.progress?.(payload)
}

async function reportPartial<K extends keyof McpStreamPartialPayloadMap>(
  reporter: McpStreamReporter | undefined,
  toolName: K,
  payload: McpStreamPartialPayloadMap[K]
): Promise<void> {
  await reporter?.partial?.(toolName, payload)
}

async function getContactCatalog(): Promise<{ items: McpContactRef[]; map: Map<string, McpContactRef> }> {
  const result = await chatService.getContacts()
  if (!result.success) {
    mapChatError(result.error)
  }

  const items = (result.contacts || []).map((contact) => toContactRef(contact as ContactWithLastContact))
  const map = new Map<string, McpContactRef>()

  for (const item of items) {
    for (const key of buildContactSearchKeys(item)) {
      map.set(normalizeQuery(key), item)
    }
  }

  return { items, map }
}

function tryResolveContactRef(
  rawValue: string,
  contactMap: Map<string, McpContactRef>
): McpContactRef | null {
  const normalized = normalizeQuery(rawValue)
  if (!normalized) return null

  const exact = contactMap.get(normalized)
  if (exact) return exact

  const partialMatches = Array.from(new Set(
    Array.from(contactMap.values()).filter((contact) =>
      buildContactSearchKeys(contact).some((value) => normalizeQuery(value).includes(normalized))
    )
  )) as McpContactRef[]

  return partialMatches.length === 1 ? partialMatches[0] : null
}

function findSessionCandidates(
  rawInput: string,
  sessions: McpSessionItem[],
  contacts: McpContactRef[]
): ScoredSessionCandidate[] {
  const query = normalizeQuery(rawInput)
  if (!query) return []

  return buildSessionLookupEntries(sessions, contacts)
    .map((entry) => ({
      entry,
      score: Math.max(...entry.aliases.map((alias) => scoreLookupValue(query, alias)), 0)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.session.displayName.localeCompare(b.entry.session.displayName, 'zh-CN'))
}

function toCandidateConfidence(score: number): 'high' | 'medium' | 'low' {
  if (score >= 1000 || score >= 820) return 'high'
  if (score >= 640) return 'medium'
  return 'low'
}

function buildCandidateEvidence(candidate: ScoredSessionCandidate, query: string): string[] {
  const normalizedQuery = normalizeQuery(query)
  const evidence: string[] = []

  for (const alias of candidate.entry.aliases) {
    const normalizedAlias = normalizeQuery(alias)
    if (!normalizedAlias) continue
    if (normalizedAlias === normalizedQuery) {
      evidence.push(`Exact alias match: ${alias}`)
    } else if (normalizedAlias.startsWith(normalizedQuery)) {
      evidence.push(`Prefix alias match: ${alias}`)
    } else if (normalizedAlias.includes(normalizedQuery)) {
      evidence.push(`Fuzzy alias match: ${alias}`)
    } else if (isSubsequence(normalizedQuery, normalizedAlias)) {
      evidence.push(`Subsequence alias match: ${alias}`)
    }

    if (evidence.length >= 3) break
  }

  if (candidate.score >= 1000) {
    evidence.push('High-confidence score from exact resolution.')
  } else if (candidate.score >= 820) {
    evidence.push('High-confidence score from strong fuzzy match.')
  } else if (candidate.score >= 640) {
    evidence.push('Medium-confidence score from partial fuzzy match.')
  }

  return uniqueStrings(evidence).slice(0, 4)
}

function toResolvedCandidate(candidate: ScoredSessionCandidate, query: string): McpResolvedSessionCandidate {
  return {
    ...candidate.entry.session,
    score: candidate.score,
    confidence: toCandidateConfidence(candidate.score),
    aliases: candidate.entry.aliases,
    evidence: buildCandidateEvidence(candidate, query)
  }
}

function buildSearchSessionSummaries(hits: McpSearchHit[]): McpSearchMessagesPayload['sessionSummaries'] {
  const grouped = new Map<string, {
    session: McpSessionRef
    hitCount: number
    topScore: number
    sampleExcerpts: string[]
  }>()

  for (const hit of hits) {
    const key = hit.session.sessionId
    const existing = grouped.get(key)
    if (!existing) {
      grouped.set(key, {
        session: hit.session,
        hitCount: 1,
        topScore: hit.score,
        sampleExcerpts: hit.excerpt ? [hit.excerpt] : []
      })
      continue
    }

    existing.hitCount += 1
    existing.topScore = Math.max(existing.topScore, hit.score)
    if (hit.excerpt && existing.sampleExcerpts.length < 2 && !existing.sampleExcerpts.includes(hit.excerpt)) {
      existing.sampleExcerpts.push(hit.excerpt)
    }
  }

  return Array.from(grouped.values())
    .sort((a, b) => b.hitCount - a.hitCount || b.topScore - a.topScore)
}

function toMomentItem(raw: any, includeRaw: boolean): McpMomentItem {
  return {
    id: String(raw.id || ''),
    username: String(raw.username || ''),
    nickname: String(raw.nickname || raw.username || ''),
    avatarUrl: raw.avatarUrl || undefined,
    createTime: Number(raw.createTime || 0),
    createTimeMs: toTimestampMs(Number(raw.createTime || 0)),
    contentDesc: String(raw.contentDesc || ''),
    type: raw.type !== undefined ? Number(raw.type) : undefined,
    media: Array.isArray(raw.media) ? raw.media.map((item: any) => ({
      url: String(item.url || ''),
      thumb: String(item.thumb || ''),
      md5: item.md5 || undefined,
      token: item.token || undefined,
      key: item.key || undefined,
      thumbKey: item.thumbKey || undefined,
      encIdx: item.encIdx || undefined,
      width: item.width !== undefined ? Number(item.width) : undefined,
      height: item.height !== undefined ? Number(item.height) : undefined,
      livePhoto: item.livePhoto ? {
        url: String(item.livePhoto.url || ''),
        thumb: String(item.livePhoto.thumb || ''),
        md5: item.livePhoto.md5 || undefined,
        token: item.livePhoto.token || undefined,
        key: item.livePhoto.key || undefined,
        encIdx: item.livePhoto.encIdx || undefined
      } : undefined
    })) : [],
    shareInfo: raw.shareInfo ? {
      title: String(raw.shareInfo.title || ''),
      description: String(raw.shareInfo.description || ''),
      contentUrl: String(raw.shareInfo.contentUrl || ''),
      thumbUrl: String(raw.shareInfo.thumbUrl || ''),
      thumbKey: raw.shareInfo.thumbKey || undefined,
      thumbToken: raw.shareInfo.thumbToken || undefined,
      appName: raw.shareInfo.appName || undefined,
      type: raw.shareInfo.type !== undefined ? Number(raw.shareInfo.type) : undefined
    } : undefined,
    likes: Array.isArray(raw.likes) ? raw.likes.map((item: any) => String(item || '')).filter(Boolean) : [],
    comments: Array.isArray(raw.comments) ? raw.comments.map((item: any) => ({
      id: String(item.id || ''),
      nickname: String(item.nickname || ''),
      content: String(item.content || ''),
      refCommentId: String(item.refCommentId || ''),
      refNickname: item.refNickname || undefined,
      emojis: Array.isArray(item.emojis) ? item.emojis.map((emoji: any) => ({
        url: String(emoji.url || ''),
        md5: String(emoji.md5 || ''),
        width: Number(emoji.width || 0),
        height: Number(emoji.height || 0),
        encryptUrl: emoji.encryptUrl || undefined,
        aesKey: emoji.aesKey || undefined
      })) : [],
      images: Array.isArray(item.images) ? item.images.map((image: any) => ({
        url: String(image.url || ''),
        token: image.token || undefined,
        key: image.key || undefined,
        encIdx: image.encIdx || undefined,
        thumbUrl: image.thumbUrl || undefined,
        thumbUrlToken: image.thumbUrlToken || undefined,
        thumbKey: image.thumbKey || undefined,
        thumbEncIdx: image.thumbEncIdx || undefined,
        width: image.width !== undefined ? Number(image.width) : undefined,
        height: image.height !== undefined ? Number(image.height) : undefined,
        heightPercentage: image.heightPercentage !== undefined ? Number(image.heightPercentage) : undefined,
        fileSize: image.fileSize !== undefined ? Number(image.fileSize) : undefined,
        minArea: image.minArea !== undefined ? Number(image.minArea) : undefined,
        mediaId: image.mediaId || undefined,
        md5: image.md5 || undefined
      })) : []
    })) : [],
    rawXml: includeRaw ? (raw.rawXml ? String(raw.rawXml) : undefined) : undefined
  }
}

function getDefaultExportPath(): string | null {
  const config = new ConfigService()
  try {
    const exportPath = String(config.get('exportPath') || '').trim()
    return exportPath || null
  } finally {
    config.close()
  }
}

function isWritableDirectory(dir: string): boolean {
  try {
    if (!dir) return false
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

function isCompleteMediaOptions(
  mediaOptions?: ExportChatArgs['mediaOptions']
): mediaOptions is McpExportMediaOptions {
  return Boolean(
    mediaOptions
    && typeof mediaOptions.exportAvatars === 'boolean'
    && typeof mediaOptions.exportImages === 'boolean'
    && typeof mediaOptions.exportVideos === 'boolean'
    && typeof mediaOptions.exportEmojis === 'boolean'
    && typeof mediaOptions.exportVoices === 'boolean'
  )
}

function getNextExportQuestion(missingFields: McpExportMissingField[]): string | undefined {
  if (missingFields.includes('session')) {
    return '请先确认要导出哪个会话，可以提供 sessionId 或更具体的联系人线索。'
  }
  if (missingFields.includes('dateRange')) {
    return '请补充导出的时间范围，至少需要开始时间和结束时间。'
  }
  if (missingFields.includes('format')) {
    return '请确认导出格式，仅支持 chatlab、chatlab-jsonl、json、excel、html。'
  }
  if (missingFields.includes('mediaOptions')) {
    return '请明确是否导出头像、图片、视频、表情、语音。'
  }
  if (missingFields.includes('outputDir')) {
    return '默认导出目录不可用，请提供一个可写入的导出目录。'
  }
  return undefined
}

function buildExportFollowUpQuestions(missingFields: McpExportMissingField[]): Array<{
  field: McpExportMissingField
  question: string
}> {
  const questions: Array<{ field: McpExportMissingField; question: string }> = []

  for (const field of missingFields) {
    if (field === 'session') {
      questions.push({
        field,
        question: '你要导出哪个会话？可以给我更具体的联系人、备注名或 sessionId。'
      })
    } else if (field === 'dateRange') {
      questions.push({
        field,
        question: '这次导出的时间范围是什么？请给我开始时间和结束时间。'
      })
    } else if (field === 'format') {
      questions.push({
        field,
        question: '你要导出成哪种格式？目前支持 chatlab、chatlab-jsonl、json、excel、html。'
      })
    } else if (field === 'mediaOptions') {
      questions.push({
        field,
        question: '媒体要怎么导？请分别确认是否包含头像、图片、视频、表情、语音。'
      })
    } else if (field === 'outputDir') {
      questions.push({
        field,
        question: '默认导出目录不可用，请给我一个可写入的导出目录。'
      })
    }
  }

  return questions
}

function buildPredictedExportPath(
  outputDir: string,
  resolvedSession: Pick<McpResolvedSessionCandidate, 'displayName'>,
  format: McpExportFormat,
  mediaOptions: McpExportMediaOptions
): string {
  const safeName = resolvedSession.displayName.replace(/[<>:"/\\|?*]/g, '_').replace(/\.+$/, '').trim() || 'export'
  const ext = format === 'chatlab-jsonl'
    ? '.jsonl'
    : format === 'excel'
      ? '.xlsx'
      : format === 'html'
        ? '.html'
        : '.json'
  const hasMedia = mediaOptions.exportImages || mediaOptions.exportVideos || mediaOptions.exportEmojis || mediaOptions.exportVoices
  const sessionOutputDir = hasMedia ? join(outputDir, safeName) : outputDir
  return join(sessionOutputDir, `${safeName}${ext}`)
}

function toExportServiceOptions(
  format: McpExportFormat,
  dateRange: McpExportDateRange,
  mediaOptions: McpExportMediaOptions
): ExportServiceOptions {
  return {
    format,
    dateRange,
    exportAvatars: mediaOptions.exportAvatars,
    exportImages: mediaOptions.exportImages,
    exportVideos: mediaOptions.exportVideos,
    exportEmojis: mediaOptions.exportEmojis,
    exportVoices: mediaOptions.exportVoices
  }
}

function resolveSessionRefStrict(
  rawInput: string,
  sessions: McpSessionItem[],
  sessionMap: Map<string, McpSessionRef>,
  contacts: McpContactRef[],
  contactMap: Map<string, McpContactRef>
): McpSessionRef {
  const direct = resolveSessionRef(rawInput, sessionMap, contactMap)
  if (sessionMap.has(direct.sessionId)) {
    return direct
  }

  const candidates = findSessionCandidates(rawInput, sessions, contacts)
  if (candidates.length === 0) {
    throw new McpToolError('SESSION_NOT_FOUND', 'Session not found.', formatSessionCandidateHint(rawInput, []))
  }

  const [first, second] = candidates
  if (candidates.length === 1 || !second || first.score - second.score >= 140 || first.score >= 1000) {
    return first.entry.session
  }

  throw new McpToolError('BAD_REQUEST', 'Session is ambiguous.', formatSessionCandidateHint(
    rawInput,
    candidates.map((item) => item.entry)
  ))
}

async function resolveSessionRefStrictWithProgress(
  rawInput: string,
  sessions: McpSessionItem[],
  sessionMap: Map<string, McpSessionRef>,
  contacts: McpContactRef[],
  contactMap: Map<string, McpContactRef>,
  reporter?: McpStreamReporter
): Promise<McpSessionRef> {
  await reportProgress(reporter, {
    stage: 'resolving_input',
    message: `Resolving session reference from "${rawInput}".`
  })
  await reportProgress(reporter, {
    stage: 'searching_contacts',
    message: 'Searching contacts and aliases.'
  })
  await reportProgress(reporter, {
    stage: 'searching_sessions',
    message: 'Searching sessions and recent conversation entries.'
  })

  const direct = resolveSessionRef(rawInput, sessionMap, contactMap)
  if (sessionMap.has(direct.sessionId)) {
    await reportProgress(reporter, {
      stage: 'resolving_candidates',
      message: `Resolved to ${direct.displayName}.`,
      candidates: [direct],
      candidateCount: 1
    })
    return direct
  }

  const candidates = findSessionCandidates(rawInput, sessions, contacts)
  await reportProgress(reporter, {
    stage: 'resolving_candidates',
    message: candidates.length > 0 ? `Found ${candidates.length} candidate sessions.` : 'No candidate sessions found.',
    candidates: candidates.slice(0, 5).map((item) => item.entry.session),
    candidateCount: candidates.length
  })

  return resolveSessionRefStrict(rawInput, sessions, sessionMap, contacts, contactMap)
}

function resolveSessionRef(
  rawSessionId: string,
  sessionMap: Map<string, McpSessionRef>,
  contactMap?: Map<string, McpContactRef>
): McpSessionRef {
  const directSession = sessionMap.get(rawSessionId)
  if (directSession) return directSession

  const contact = contactMap ? tryResolveContactRef(rawSessionId, contactMap) : null
  if (contact) {
    return sessionMap.get(contact.sessionId) || {
      sessionId: contact.sessionId,
      displayName: contact.displayName || contact.sessionId,
      kind: detectSessionKind(contact.sessionId)
    }
  }

  return {
    sessionId: rawSessionId,
    displayName: rawSessionId,
    kind: detectSessionKind(rawSessionId)
  }
}

function mapChatError(errorMessage?: string): never {
  const message = errorMessage || 'Unknown chat service error.'

  if (
    message.includes('请先在设置页面配置微信ID') ||
    message.includes('请先解密数据库') ||
    message.includes('未找到账号') ||
    message.includes('未找到 session.db') ||
    message.includes('未找到会话表') ||
    message.includes('数据库未连接') ||
    message.includes('联系人数据库未连接')
  ) {
    throw new McpToolError('DB_NOT_READY', 'Chat database is not ready.', message)
  }

  if (message.includes('未找到该会话的消息表')) {
    throw new McpToolError('SESSION_NOT_FOUND', 'Session not found.', message)
  }

  throw new McpToolError('INTERNAL_ERROR', 'Failed to query CipherTalk data.', message)
}

async function getEmojiLocalPath(message: Message): Promise<string | null> {
  if (!message.emojiMd5 && !message.emojiCdnUrl) return null

  try {
    const result = await chatService.downloadEmoji(
      String(message.emojiCdnUrl || ''),
      message.emojiMd5,
      message.productId,
      Number(message.createTime || 0)
    )

    return result.success ? result.cachePath || result.localPath || null : null
  } catch {
    return null
  }
}

async function getImageLocalPath(sessionId: string, message: Message): Promise<string | null> {
  if (!message.imageMd5 && !message.imageDatName) return null

  try {
    const resolved = await imageDecryptService.resolveCachedImage({
      sessionId,
      imageMd5: message.imageMd5,
      imageDatName: message.imageDatName
    })

    if (resolved.success && resolved.localPath) {
      return resolved.localPath
    }

    const decrypted = await imageDecryptService.decryptImage({
      sessionId,
      imageMd5: message.imageMd5,
      imageDatName: message.imageDatName,
      force: false
    })

    return decrypted.success ? decrypted.localPath || null : null
  } catch {
    return null
  }
}

function getVideoLocalPath(message: Message): string | null {
  if (!message.videoMd5 && !message.rawContent) return null

  try {
    const info = videoService.getVideoInfo(String(message.videoMd5 || ''), String(message.rawContent || ''))
    return info.exists ? info.videoUrl || null : null
  } catch {
    return null
  }
}

async function getVoiceLocalPath(sessionId: string, message: Message): Promise<string | null> {
  const localId = Number(message.localId || 0)
  const createTime = Number(message.createTime || 0)
  if (!localId || !createTime) return null

  try {
    const voiceResult = await chatService.getVoiceData(sessionId, String(localId), createTime)
    if (!voiceResult.success || !voiceResult.data) return null

    const configService = new ConfigService()
    const cachePath = String(configService.get('cachePath') || '')
    configService.close()

    const baseDir = cachePath || join(process.cwd(), 'cache')
    const voiceDir = join(baseDir, 'McpVoices', sessionId.replace(/[\\/:*?"<>|]/g, '_'))
    if (!existsSync(voiceDir)) {
      mkdirSync(voiceDir, { recursive: true })
    }

    const absolutePath = join(voiceDir, `${createTime}_${localId}.wav`)
    await writeFile(absolutePath, Buffer.from(voiceResult.data, 'base64'))
    return absolutePath
  } catch {
    return null
  }
}

function getFileLocalPath(message: Message): string | null {
  const fileName = String(message.fileName || '')
  if (!fileName) return null

  const configService = new ConfigService()
  try {
    const dbPath = String(configService.get('dbPath') || '')
    const myWxid = String(configService.get('myWxid') || '')
    if (!dbPath || !myWxid) return null

    const createTimeMs = toTimestampMs(Number(message.createTime || 0))
    const fileDate = createTimeMs ? new Date(createTimeMs) : new Date()
    const monthDir = `${fileDate.getFullYear()}-${String(fileDate.getMonth() + 1).padStart(2, '0')}`
    return join(dbPath, myWxid, 'msg', 'file', monthDir, fileName)
  } finally {
    configService.close()
  }
}

function isWxidLike(value?: string | null): boolean {
  const text = String(value || '').trim()
  return /^wxid_/i.test(text) || /^gh_/i.test(text) || text.includes('@chatroom')
}

function normalizeDisplayName(value?: string | null): string | null {
  const text = String(value || '').trim()
  return text || null
}

async function getCachedSenderDisplayName(
  scope: string,
  key: string,
  loader: () => Promise<string | null>
): Promise<string | null> {
  const cacheKey = `${scope}:${key}`
  const cached = senderDisplayNameCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value
  }

  const value = loader()
  senderDisplayNameCache.set(cacheKey, {
    expiresAt: Date.now() + SENDER_DISPLAY_NAME_CACHE_TTL,
    value
  })
  return value
}

async function getSelfDisplayName(): Promise<string | null> {
  try {
    const result = await chatService.getMyUserInfo()
    if (!result.success || !result.userInfo) return null
    return normalizeDisplayName(result.userInfo.nickName || result.userInfo.alias)
  } catch {
    return null
  }
}

async function getGroupMemberDisplayMap(sessionId: string): Promise<Map<string, string>> {
  try {
    const result = await groupAnalyticsService.getGroupMembers(sessionId)
    const map = new Map<string, string>()
    if (!result.success || !result.data) return map

    for (const member of result.data) {
      const displayName = normalizeDisplayName(member.displayName)
      if (member.username && displayName) {
        map.set(member.username, displayName)
      }
    }

    return map
  } catch {
    return new Map()
  }
}

async function getCachedGroupMemberDisplayMap(sessionId: string): Promise<Map<string, string>> {
  const cached = groupMemberDisplayMapCache.get(sessionId)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value
  }

  const value = getGroupMemberDisplayMap(sessionId)
  groupMemberDisplayMapCache.set(sessionId, {
    expiresAt: Date.now() + SENDER_DISPLAY_NAME_CACHE_TTL,
    value
  })
  return value
}

async function resolveGroupMemberDisplayName(sessionId: string, username: string): Promise<string | null> {
  const map = await getCachedGroupMemberDisplayMap(sessionId)
  return normalizeDisplayName(map.get(username))
}

async function resolveContactDisplayName(username: string): Promise<string | null> {
  try {
    const contact = await chatService.getContactAvatar(username)
    return normalizeDisplayName(contact?.displayName)
  } catch {
    return null
  }
}

async function resolveSenderDisplayName(sessionId: string, message: Message): Promise<string | null> {
  const direction = Number(message.isSend) === 1 ? 'out' : 'in'
  const senderUsername = normalizeDisplayName(message.senderUsername)
  const fallbackUsername = sessionId.includes('@chatroom') ? senderUsername : (senderUsername || sessionId)

  if (direction === 'out') {
    const selfName = await getCachedSenderDisplayName('self', 'self', getSelfDisplayName)
    return selfName || '我'
  }

  if (!fallbackUsername) return null

  if (sessionId.includes('@chatroom')) {
    const groupName = await getCachedSenderDisplayName(
      'group',
      `${sessionId}:${fallbackUsername}`,
      () => resolveGroupMemberDisplayName(sessionId, fallbackUsername)
    )
    if (groupName && !isWxidLike(groupName)) return groupName
  }

  const contactName = await getCachedSenderDisplayName(
    'contact',
    fallbackUsername,
    () => resolveContactDisplayName(fallbackUsername)
  )
  return contactName || null
}

async function normalizeMessage(
  sessionId: string,
  message: Message,
  options: MessageNormalizeOptions
): Promise<McpMessageItem> {
  const kind = detectMessageKind(message)
  const direction = Number(message.isSend) === 1 ? 'out' : 'in'
  const displayName = await resolveSenderDisplayName(sessionId, message)
  const normalized: McpMessageItem = {
    messageId: Number(message.localId || message.serverId || 0),
    timestamp: Number(message.createTime || 0),
    timestampMs: toTimestampMs(Number(message.createTime || 0)),
    direction,
    kind,
    text: String(message.parsedContent || message.rawContent || ''),
    sender: {
      username: message.senderUsername ?? null,
      displayName,
      isSelf: direction === 'out'
    },
    cursor: buildCursor(message)
  }

  if (options.includeRaw) {
    normalized.raw = String(message.rawContent || '')
  }

  switch (kind) {
    case 'emoji':
      normalized.media = {
        type: 'emoji',
        md5: message.emojiMd5 || null
      }
      if (options.includeMediaPaths) {
        normalized.media.localPath = await getEmojiLocalPath(message)
      }
      break
    case 'image':
      normalized.media = {
        type: 'image',
        md5: message.imageMd5 || null,
        isLivePhoto: Boolean(message.isLivePhoto)
      }
      if (options.includeMediaPaths) {
        normalized.media.localPath = await getImageLocalPath(sessionId, message)
      }
      break
    case 'video':
      normalized.media = {
        type: 'video',
        md5: message.videoMd5 || null,
        durationSeconds: Number(message.videoDuration || 0) || null,
        isLivePhoto: Boolean(message.isLivePhoto)
      }
      if (options.includeMediaPaths) {
        normalized.media.localPath = getVideoLocalPath(message)
      }
      break
    case 'voice':
      normalized.media = {
        type: 'voice',
        durationSeconds: Number(message.voiceDuration || 0) || null
      }
      if (options.includeMediaPaths) {
        normalized.media.localPath = await getVoiceLocalPath(sessionId, message)
      }
      break
    case 'app_file': {
      const localPath = options.includeMediaPaths ? getFileLocalPath(message) : null
      normalized.media = {
        type: 'file',
        md5: message.fileMd5 || null,
        fileName: message.fileName || null,
        fileSize: Number(message.fileSize || 0) || null,
        localPath,
        exists: localPath ? existsSync(localPath) : null
      }
      break
    }
    default:
      break
  }

  return normalized
}

async function normalizeMessages(
  sessionId: string,
  messages: Message[],
  options: MessageNormalizeOptions
): Promise<McpMessageItem[]> {
  return Promise.all(messages.map((message) => normalizeMessage(sessionId, message, options)))
}

async function getSessionCatalog(): Promise<{ items: McpSessionItem[]; map: Map<string, McpSessionRef> }> {
  const result = await chatService.getSessions()
  if (!result.success) {
    mapChatError(result.error)
  }

  const items = (result.sessions || [])
    .map((session) => toSessionItem(session))
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp || a.displayName.localeCompare(b.displayName, 'zh-CN'))

  const map = new Map<string, McpSessionRef>()
  for (const item of items) {
    map.set(item.sessionId, {
      sessionId: item.sessionId,
      displayName: item.displayName,
      kind: item.kind
    })
  }

  return { items, map }
}

function messageMatchesFilters(
  message: Message,
  filters: {
    startTimeMs?: number
    endTimeMs?: number
    kinds?: Set<McpMessageKind>
    direction?: 'in' | 'out'
    senderUsername?: string
  }
): boolean {
  const timestampMs = toTimestampMs(Number(message.createTime || 0))
  if (filters.startTimeMs && timestampMs < filters.startTimeMs) return false
  if (filters.endTimeMs && timestampMs > filters.endTimeMs) return false

  if (filters.kinds?.size) {
    const kind = detectMessageKind(message)
    if (!filters.kinds.has(kind)) return false
  }

  if (filters.direction) {
    const direction = Number(message.isSend) === 1 ? 'out' : 'in'
    if (direction !== filters.direction) return false
  }

  if (filters.senderUsername) {
    const senderUsername = String(message.senderUsername || '').trim().toLowerCase()
    if (senderUsername !== filters.senderUsername) return false
  }

  return true
}

export class McpReadService {
  async resolveSession(rawArgs: ResolveSessionArgs, reporter?: McpStreamReporter): Promise<McpResolveSessionPayload> {
    const args = resolveSessionArgsSchema.safeParse(rawArgs)
    if (!args.success) {
      throw new McpToolError('BAD_REQUEST', 'Invalid resolve_session arguments.', args.error.message)
    }

    const limit = Math.min(args.data.limit ?? 5, 10)
    const [{ items: sessions, map: sessionMap }, { items: contacts, map: contactMap }] = await Promise.all([
      getSessionCatalog(),
      getContactCatalog()
    ])

    await reportProgress(reporter, {
      stage: 'resolving_input',
      message: `Resolving session candidates for "${args.data.query}".`
    })

    const direct = resolveSessionRef(args.data.query, sessionMap, contactMap)
    let candidates = findSessionCandidates(args.data.query, sessions, contacts)

    if (sessionMap.has(direct.sessionId) && !candidates.some((item) => item.entry.session.sessionId === direct.sessionId)) {
      const directEntry = buildSessionLookupEntries(sessions, contacts).find((entry) => entry.session.sessionId === direct.sessionId)
      if (directEntry) {
        candidates = [{ entry: directEntry, score: 1000 }, ...candidates]
      }
    }

    const dedupedCandidates = Array.from(new Map(
      candidates.map((candidate) => [candidate.entry.session.sessionId, candidate])
    ).values()).slice(0, limit)

    await reportProgress(reporter, {
      stage: 'resolving_candidates',
      message: dedupedCandidates.length > 0 ? `Found ${dedupedCandidates.length} session candidates.` : 'No session candidates found.',
      candidates: dedupedCandidates.map((candidate) => candidate.entry.session),
      candidateCount: dedupedCandidates.length
    })

    const recommended = dedupedCandidates[0] ? toResolvedCandidate(dedupedCandidates[0], args.data.query) : undefined
    const exact = Boolean(recommended && recommended.score >= 1000)
    const resolved = Boolean(recommended && (dedupedCandidates.length === 1 || recommended.confidence === 'high'))

    const payload: McpResolveSessionPayload = {
      query: args.data.query,
      resolved,
      exact,
      recommended,
      candidates: dedupedCandidates.map((candidate) => toResolvedCandidate(candidate, args.data.query)),
      suggestedNextAction: resolved
        ? 'get_session_context'
        : dedupedCandidates.length > 0
          ? 'search_messages'
          : 'list_contacts',
      message: resolved
        ? `Resolved "${args.data.query}" to ${recommended?.displayName}.`
        : dedupedCandidates.length > 0
          ? `Found ${dedupedCandidates.length} plausible session candidates for "${args.data.query}".`
          : `No session candidates found for "${args.data.query}".`
    }

    await reportPartial(reporter, 'resolve_session', payload)
    return payload
  }

  async exportChat(rawArgs: ExportChatArgs, reporter?: McpStreamReporter): Promise<McpExportChatPayload> {
    const args = exportChatArgsSchema.safeParse(rawArgs)
    if (!args.success) {
      throw new McpToolError('BAD_REQUEST', 'Invalid export_chat arguments.', args.error.message)
    }

    const data = args.data
    const validateOnly = Boolean(data.validateOnly)
    await reportProgress(reporter, {
      stage: 'validating_export_request',
      message: 'Validating export request.'
    })

    const [{ items: sessions, map: sessionMap }, { items: contacts, map: contactMap }] = await Promise.all([
      getSessionCatalog(),
      getContactCatalog()
    ])

    let resolvedSession: McpResolvedSessionCandidate | undefined
    let candidates: McpResolvedSessionCandidate[] = []

    if (data.sessionId || data.query) {
      const query = data.sessionId || data.query || ''
      const matchedCandidates = findSessionCandidates(query, sessions, contacts).slice(0, 5)
      candidates = matchedCandidates.map((candidate) => toResolvedCandidate(candidate, query))

      try {
        const resolved = await resolveSessionRefStrictWithProgress(query, sessions, sessionMap, contacts, contactMap, reporter)
        const matched = matchedCandidates.find((candidate) => candidate.entry.session.sessionId === resolved.sessionId)
        resolvedSession = matched ? toResolvedCandidate(matched, query) : {
          ...resolved,
          score: 1000,
          confidence: 'high',
          aliases: [resolved.displayName, resolved.sessionId],
          evidence: ['Resolved directly from the provided session clue.']
        }
      } catch (error) {
        if (!(error instanceof McpToolError) || (error.code !== 'BAD_REQUEST' && error.code !== 'SESSION_NOT_FOUND')) {
          throw error
        }
      }
    }

    const missingFields: McpExportMissingField[] = []
    if (!resolvedSession) {
      missingFields.push('session')
    }
    if (!data.dateRange || !data.dateRange.start || !data.dateRange.end) {
      missingFields.push('dateRange')
    } else if (data.dateRange.start > data.dateRange.end) {
      throw new McpToolError('BAD_REQUEST', 'Invalid export date range.', 'dateRange.start must be earlier than or equal to dateRange.end.')
    }
    if (!data.format) {
      missingFields.push('format')
    } else if (!SUPPORTED_EXPORT_FORMATS.includes(data.format)) {
      throw new McpToolError('BAD_REQUEST', 'Unsupported export format.', `Only ${SUPPORTED_EXPORT_FORMATS.join(', ')} are supported.`)
    }
    if (!isCompleteMediaOptions(data.mediaOptions)) {
      missingFields.push('mediaOptions')
    }

    const requestedOutputDir = String(data.outputDir || '').trim()
    const outputDir = requestedOutputDir || getDefaultExportPath() || ''
    if (!outputDir || !isWritableDirectory(outputDir)) {
      missingFields.push('outputDir')
    }

    const nextQuestion = getNextExportQuestion(missingFields)
    const followUpQuestions = buildExportFollowUpQuestions(missingFields)
    const payload: McpExportChatPayload = {
      canExport: missingFields.length === 0,
      validateOnly,
      missingFields,
      nextQuestion,
      followUpQuestions,
      resolvedSession,
      candidates,
      outputDir: outputDir || undefined,
      format: data.format,
      dateRange: data.dateRange,
      mediaOptions: isCompleteMediaOptions(data.mediaOptions) ? data.mediaOptions : undefined,
      message: missingFields.length === 0
        ? validateOnly
          ? 'Export request is complete and ready to run.'
          : 'Export request validated and ready to execute.'
        : 'Export request is incomplete and needs more information.'
    }

    await reportPartial(reporter, 'export_chat', payload)

    if (missingFields.length > 0 || validateOnly) {
      return payload
    }

    await reportProgress(reporter, {
      stage: 'preparing_export',
      message: `Preparing export for ${resolvedSession!.displayName}.`,
      candidates: [{ sessionId: resolvedSession!.sessionId, displayName: resolvedSession!.displayName, kind: resolvedSession!.kind }],
      candidateCount: 1
    })

    const exportOptions = toExportServiceOptions(
      data.format!,
      data.dateRange!,
      data.mediaOptions as McpExportMediaOptions
    )

    const predictedOutputPath = buildPredictedExportPath(
      outputDir,
      resolvedSession!,
      data.format!,
      data.mediaOptions as McpExportMediaOptions
    )

    const result = await exportService.exportSessions(
      [resolvedSession!.sessionId],
      outputDir,
      exportOptions,
      (progress) => {
        const stage = progress.phase === 'writing'
          ? 'writing'
          : progress.phase === 'exporting'
            ? 'exporting'
            : progress.phase === 'complete'
              ? 'completed'
              : 'preparing_export'

        void reportProgress(reporter, {
          stage,
          message: progress.detail || progress.phase,
          sessionsScanned: progress.current,
          candidates: [{ sessionId: resolvedSession!.sessionId, displayName: resolvedSession!.displayName, kind: resolvedSession!.kind }],
          candidateCount: 1
        })
      }
    )

    const completedPayload: McpExportChatPayload = {
      ...payload,
      canExport: true,
      success: result.success,
      successCount: result.successCount,
      failCount: result.failCount,
      error: result.error,
      outputPath: predictedOutputPath,
      message: result.success
        ? `Exported chat for ${resolvedSession!.displayName}.`
        : `Failed to export chat for ${resolvedSession!.displayName}.`
    }

    await reportPartial(reporter, 'export_chat', completedPayload)
    return completedPayload
  }

  async listSessions(rawArgs: ListSessionsArgs, reporter?: McpStreamReporter): Promise<McpSessionsPayload> {
    const args = listSessionsArgsSchema.safeParse(rawArgs)
    if (!args.success) {
      throw new McpToolError('BAD_REQUEST', 'Invalid list_sessions arguments.', args.error.message)
    }

    const query = normalizeQuery(args.data.q)
    const offset = Math.max(0, args.data.offset ?? 0)
    const limit = Math.min(args.data.limit ?? 100, MAX_LIST_LIMIT)
    const unreadOnly = Boolean(args.data.unreadOnly)
    await reportProgress(reporter, {
      stage: 'searching_sessions',
      message: query ? `Searching sessions for "${args.data.q}".` : 'Listing sessions.'
    })

    const [{ items: sessionItems }, { map: contactMap }] = await Promise.all([
      getSessionCatalog(),
      getContactCatalog()
    ])

    let sessions = sessionItems

    if (query) {
      sessions = sessions.filter((session) => {
        return [
          session.sessionId,
          session.displayName,
          session.lastMessagePreview,
          ...buildContactSearchKeys(contactMap.get(normalizeQuery(session.sessionId)) || {
            contactId: session.sessionId,
            sessionId: session.sessionId,
            displayName: '',
            remark: '',
            nickname: '',
            kind: session.kind === 'group' ? 'group' : session.kind === 'official' ? 'official' : 'friend'
          })
        ].some((value) => value.toLowerCase().includes(query))
      })
    }

    if (unreadOnly) {
      sessions = sessions.filter((session) => session.unreadCount > 0)
    }

    const total = sessions.length
    const items = sessions.slice(offset, offset + limit)
    await reportPartial(reporter, 'list_sessions', {
      items,
      total,
      offset,
      limit,
      hasMore: offset + items.length < total
    })

    return {
      items,
      total,
      offset,
      limit,
      hasMore: offset + items.length < total
    }
  }

  async listContacts(rawArgs: ListContactsArgs, reporter?: McpStreamReporter): Promise<McpContactsPayload> {
    const args = listContactsArgsSchema.safeParse(rawArgs)
    if (!args.success) {
      throw new McpToolError('BAD_REQUEST', 'Invalid list_contacts arguments.', args.error.message)
    }

    const query = normalizeQuery(args.data.q)
    const offset = Math.max(0, args.data.offset ?? 0)
    const limit = Math.min(args.data.limit ?? 100, MAX_LIST_LIMIT)
    const typeSet = args.data.types?.length ? new Set(args.data.types) : null
    await reportProgress(reporter, {
      stage: 'searching_contacts',
      message: query ? `Searching contacts for "${args.data.q}".` : 'Listing contacts.'
    })

    const result = await chatService.getContacts()
    if (!result.success) {
      mapChatError(result.error)
    }

    const { map: sessionMap } = await getSessionCatalog()
    let contacts = (result.contacts || []).map((contact) => {
      const typedContact = contact as ContactWithLastContact
      return toContactItem(typedContact, sessionMap.has(typedContact.username))
    })

    if (typeSet) {
      contacts = contacts.filter((contact) => typeSet.has(contact.kind))
    }

    if (query) {
      contacts = contacts.filter((contact) => {
        return [
          contact.contactId,
          contact.displayName,
          contact.remark || '',
          contact.nickname || ''
        ].some((value) => value.toLowerCase().includes(query))
      })
    }

    const total = contacts.length
    const items = contacts.slice(offset, offset + limit)
    await reportPartial(reporter, 'list_contacts', {
      items,
      total,
      offset,
      limit,
      hasMore: offset + items.length < total
    })

    return {
      items,
      total,
      offset,
      limit,
      hasMore: offset + items.length < total
    }
  }

  async getGlobalStatistics(rawArgs: z.infer<typeof analyticsTimeRangeArgsSchema>): Promise<McpGlobalStatisticsPayload> {
    const args = analyticsTimeRangeArgsSchema.safeParse(rawArgs)
    if (!args.success) {
      throw new McpToolError('BAD_REQUEST', 'Invalid get_global_statistics arguments.', args.error.message)
    }

    const result = await analyticsService.getOverallStatistics(args.data.startTime, args.data.endTime)
    if (!result.success || !result.data) {
      mapChatError(result.error)
    }

    return {
      ...result.data,
      firstMessageTimeMs: result.data.firstMessageTime ? toTimestampMs(result.data.firstMessageTime) : null,
      lastMessageTimeMs: result.data.lastMessageTime ? toTimestampMs(result.data.lastMessageTime) : null,
      timeRange: buildTimeRange(args.data.startTime, args.data.endTime)
    }
  }

  async getContactRankings(rawArgs: z.infer<typeof contactRankingsArgsSchema>): Promise<McpContactRankingsPayload> {
    const args = contactRankingsArgsSchema.safeParse(rawArgs)
    if (!args.success) {
      throw new McpToolError('BAD_REQUEST', 'Invalid get_contact_rankings arguments.', args.error.message)
    }

    const limit = Math.min(args.data.limit ?? 20, MAX_SEARCH_LIMIT)
    const result = await analyticsService.getContactRankings(limit, args.data.startTime, args.data.endTime)
    if (!result.success || !result.data) {
      mapChatError(result.error)
    }

    const items: McpContactRankingItem[] = result.data.map((item) => ({
      contactId: item.username,
      displayName: item.displayName,
      avatarUrl: item.avatarUrl,
      messageCount: item.messageCount,
      sentCount: item.sentCount,
      receivedCount: item.receivedCount,
      lastMessageTime: item.lastMessageTime,
      lastMessageTimeMs: item.lastMessageTime ? toTimestampMs(item.lastMessageTime) : null
    }))

    return {
      items,
      limit,
      timeRange: buildTimeRange(args.data.startTime, args.data.endTime)
    }
  }

  async getActivityDistribution(rawArgs: z.infer<typeof analyticsTimeRangeArgsSchema>): Promise<McpActivityDistributionPayload> {
    const args = analyticsTimeRangeArgsSchema.safeParse(rawArgs)
    if (!args.success) {
      throw new McpToolError('BAD_REQUEST', 'Invalid get_activity_distribution arguments.', args.error.message)
    }

    const result = await analyticsService.getTimeDistribution(args.data.startTime, args.data.endTime)
    if (!result.success || !result.data) {
      mapChatError(result.error)
    }

    return {
      ...result.data,
      timeRange: buildTimeRange(args.data.startTime, args.data.endTime)
    }
  }

  async getMomentsTimeline(rawArgs: GetMomentsTimelineArgs): Promise<McpMomentsTimelinePayload> {
    const args = getMomentsTimelineArgsSchema.safeParse(rawArgs)
    if (!args.success) {
      throw new McpToolError('BAD_REQUEST', 'Invalid get_moments_timeline arguments.', args.error.message)
    }

    const limit = Math.min(args.data.limit ?? 20, MAX_LIST_LIMIT)
    const offset = Math.max(0, args.data.offset ?? 0)
    const includeRaw = args.data.includeRaw ?? false
    const result = await snsService.getTimeline(
      limit,
      offset,
      args.data.usernames,
      args.data.keyword,
      args.data.startTime,
      args.data.endTime
    )

    if (!result.success) {
      if (String(result.error || '').includes('请先')) {
        throw new McpToolError('DB_NOT_READY', result.error || '朋友圈数据库未就绪。')
      }
      throw new McpToolError('INTERNAL_ERROR', result.error || 'Failed to load moments timeline.')
    }

    const rawItems = (result.timeline || []).slice().sort((a, b) =>
      Number(b.createTime || 0) - Number(a.createTime || 0)
    )
    return {
      items: rawItems.map((item) => toMomentItem(item, includeRaw)),
      offset,
      limit,
      hasMore: rawItems.length >= limit
    }
  }

  async getMessages(rawArgs: GetMessagesArgs, defaultIncludeMediaPaths: boolean, reporter?: McpStreamReporter): Promise<McpMessagesPayload> {
    const args = getMessagesArgsSchema.safeParse(rawArgs)
    if (!args.success) {
      throw new McpToolError('BAD_REQUEST', 'Invalid get_messages arguments.', args.error.message)
    }

    const {
      sessionId: rawSessionId,
      keyword,
      includeRaw = false,
      order = 'asc'
    } = args.data

    const offset = Math.max(0, args.data.offset ?? 0)
    const limit = Math.min(args.data.limit ?? 50, MAX_LIST_LIMIT)
    const includeMediaPaths = args.data.includeMediaPaths ?? defaultIncludeMediaPaths
    const keywordQuery = normalizeQuery(keyword)
    const startTimeMs = toTimestampMs(args.data.startTime)
    const endTimeMs = toTimestampMs(args.data.endTime)
    const [{ items: sessions, map: sessionMap }, { items: contacts, map: contactMap }] = await Promise.all([
      getSessionCatalog(),
      getContactCatalog()
    ])
    const session = await resolveSessionRefStrictWithProgress(rawSessionId, sessions, sessionMap, contacts, contactMap, reporter)
    const sessionId = session.sessionId
    await reportProgress(reporter, {
      stage: 'scanning_messages',
      message: `Scanning messages in ${session.displayName}.`,
      sessionsScanned: 1,
      messagesScanned: 0
    })

    const matched: Message[] = []
    let scanOffset = 0
    let scanned = 0
    let reachedEnd = false
    const targetCount = offset + limit + 1

    while (scanned < 5000 && matched.length < targetCount) {
      const result = await chatService.getMessages(sessionId, scanOffset, SEARCH_BATCH_SIZE)
      if (!result.success) {
        mapChatError(result.error)
      }

      const part = result.messages || []
      if (part.length === 0) {
        reachedEnd = true
        break
      }

      for (const message of part) {
        if (!messageMatchesFilters(message, { startTimeMs, endTimeMs })) continue
        if (keywordQuery && !findKeywordMatch(message, keywordQuery)) continue
        matched.push(message)
      }

      scanOffset += part.length
      scanned += part.length
      await reportProgress(reporter, {
        stage: 'scanning_messages',
        message: `Scanned ${scanned} messages in ${session.displayName}.`,
        sessionsScanned: 1,
        messagesScanned: scanned
      })

      if (!result.hasMore) {
        reachedEnd = true
        break
      }
    }

    matched.sort((a, b) => order === 'asc' ? compareMessageCursorAsc(a, b) : compareMessageCursorDesc(a, b))

    const page = matched.slice(offset, offset + limit)
    const items = await normalizeMessages(sessionId, page, { includeMediaPaths, includeRaw })
    await reportPartial(reporter, 'get_messages', {
      items,
      offset,
      limit,
      hasMore: reachedEnd ? matched.length > offset + items.length : true
    })

    return {
      items,
      offset,
      limit,
      hasMore: reachedEnd ? matched.length > offset + items.length : true
    }
  }

  async searchMessages(rawArgs: SearchMessagesArgs, defaultIncludeMediaPaths: boolean, reporter?: McpStreamReporter): Promise<McpSearchMessagesPayload> {
    const args = searchMessagesArgsSchema.safeParse(rawArgs)
    if (!args.success) {
      throw new McpToolError('BAD_REQUEST', 'Invalid search_messages arguments.', args.error.message)
    }

    const [{ items: sessions, map: sessionMap }, { items: contacts, map: contactMap }] = await Promise.all([
      getSessionCatalog(),
      getContactCatalog()
    ])
    const includeRaw = args.data.includeRaw ?? false
    const includeMediaPaths = args.data.includeMediaPaths ?? defaultIncludeMediaPaths
    const limit = Math.min(args.data.limit ?? 20, MAX_SEARCH_LIMIT)
    const matchMode = args.data.matchMode ?? 'substring'
    const sessionIdCandidates = Array.from(new Set([
      ...(args.data.sessionId ? [args.data.sessionId] : []),
      ...(args.data.sessionIds || [])
    ]))

    if (sessionIdCandidates.length > MAX_SEARCH_SESSIONS) {
      throw new McpToolError('BAD_REQUEST', `At most ${MAX_SEARCH_SESSIONS} sessionIds can be searched at once.`)
    }

    const targetSessions = sessionIdCandidates.length > 0
      ? await Promise.all(sessionIdCandidates.map((sessionId) => resolveSessionRefStrictWithProgress(sessionId, sessions, sessionMap, contacts, contactMap, reporter)))
      : sessions.map((session) => ({
          sessionId: session.sessionId,
          displayName: session.displayName,
          kind: session.kind
        }))
    const exhaustiveTargetedSearch = sessionIdCandidates.length > 0
    const sessionScanLimit = exhaustiveTargetedSearch ? MAX_TARGETED_SCAN_PER_SESSION : MAX_SCAN_PER_SESSION
    const globalScanLimit = exhaustiveTargetedSearch ? MAX_TARGETED_SCAN_GLOBAL : MAX_SCAN_GLOBAL

    const kindSet = args.data.kinds?.length ? new Set(args.data.kinds) : undefined
    const senderUsername = normalizeQuery(args.data.senderUsername)
    const startTimeMs = toTimestampMs(args.data.startTime)
    const endTimeMs = toTimestampMs(args.data.endTime)

    if (exhaustiveTargetedSearch) {
      try {
        const indexedRawHits: SearchRawHit[] = []
        let indexedMessages = 0
        let indexedTruncated = false

        await reportProgress(reporter, {
          stage: 'scanning_messages',
          message: `Preparing local search index for ${targetSessions.length} session(s).`,
          sessionsScanned: 0,
          messagesScanned: 0
        })

        for (const session of targetSessions) {
          const indexed = await chatSearchIndexService.searchSession({
            sessionId: session.sessionId,
            query: args.data.query,
            limit: Math.max(limit * 4, limit + 20),
            matchMode,
            startTimeMs,
            endTimeMs,
            direction: args.data.direction,
            senderUsername: args.data.senderUsername,
            onProgress: async (progress) => {
              await reportProgress(reporter, {
                stage: progress.stage === 'searching_index' ? 'streaming_hits' : 'scanning_messages',
                message: progress.message,
                sessionsScanned: targetSessions.indexOf(session) + 1,
                messagesScanned: progress.indexedCount ?? progress.messagesScanned
              })
            }
          })

          indexedMessages += indexed.indexedCount
          indexedTruncated = indexedTruncated || indexed.truncated

          for (const hit of indexed.hits) {
            if (!messageMatchesFilters(hit.message, {
              startTimeMs,
              endTimeMs,
              kinds: kindSet,
              direction: args.data.direction,
              senderUsername
            })) {
              continue
            }

            indexedRawHits.push({
              session,
              message: hit.message,
              matchedField: hit.matchedField,
              excerpt: hit.excerpt,
              score: hit.score
            })
          }
        }

        indexedRawHits.sort((a, b) => b.score - a.score || compareMessageCursorDesc(a.message, b.message))
        const hits = await Promise.all(indexedRawHits.slice(0, limit).map(async (hit): Promise<McpSearchHit> => ({
          session: hit.session,
          message: await normalizeMessage(hit.session.sessionId, hit.message, {
            includeMediaPaths,
            includeRaw
          }),
          excerpt: hit.excerpt,
          matchedField: hit.matchedField,
          score: hit.score
        })))
        const sessionSummaries = buildSearchSessionSummaries(hits)

        await reportPartial(reporter, 'search_messages', {
          hits,
          limit,
          sessionsScanned: targetSessions.length,
          messagesScanned: indexedMessages,
          truncated: indexedTruncated,
          sessionSummaries,
          source: 'index',
          indexStatus: {
            ready: true,
            indexedSessions: targetSessions.length,
            indexedMessages
          }
        })

        return {
          hits,
          limit,
          sessionsScanned: targetSessions.length,
          messagesScanned: indexedMessages,
          truncated: indexedTruncated,
          sessionSummaries,
          source: 'index',
          indexStatus: {
            ready: true,
            indexedSessions: targetSessions.length,
            indexedMessages
          }
        }
      } catch (error) {
        console.warn('[McpReadService] Indexed search failed, falling back to scan:', error)
        await reportProgress(reporter, {
          stage: 'scanning_messages',
          message: `Local index search failed, falling back to scan: ${String(error)}`,
          sessionsScanned: 0,
          messagesScanned: 0
        })
      }
    }

    const rawHits: SearchRawHit[] = []
    let sessionsScanned = 0
    let messagesScanned = 0
    let truncated = false
    let bestScore = Number.NEGATIVE_INFINITY
    let hitTargetReached = false
    await reportProgress(reporter, {
      stage: 'scanning_messages',
      message: `Searching ${targetSessions.length} sessions for "${args.data.query}".`,
      sessionsScanned: 0,
      messagesScanned: 0
    })

    for (const session of targetSessions) {
      sessionsScanned += 1

      let sessionOffset = 0
      let sessionScanned = 0

      while (sessionScanned < sessionScanLimit && messagesScanned < globalScanLimit) {
        const bestScoreBeforeBatch = bestScore
        let roundBestScore = Number.NEGATIVE_INFINITY

        const fetchLimit = Math.min(
          SEARCH_BATCH_SIZE,
          sessionScanLimit - sessionScanned,
          globalScanLimit - messagesScanned
        )

        if (fetchLimit <= 0) {
          truncated = true
          break
        }

        const result = await chatService.getMessages(session.sessionId, sessionOffset, fetchLimit)
        if (!result.success) {
          mapChatError(result.error)
        }

        const part = result.messages || []
        if (part.length === 0) break

        sessionOffset += part.length
        sessionScanned += part.length
        messagesScanned += part.length
        await reportProgress(reporter, {
          stage: 'scanning_messages',
          message: `Scanned ${messagesScanned} messages across ${sessionsScanned} sessions.`,
          sessionsScanned,
          messagesScanned
        })

        for (const message of part) {
          if (!messageMatchesFilters(message, {
            startTimeMs,
            endTimeMs,
            kinds: kindSet,
            direction: args.data.direction,
            senderUsername
          })) {
            continue
          }

          const match = findKeywordMatch(message, args.data.query, matchMode)
          if (!match) continue

          rawHits.push({
            session,
            message,
            matchedField: match.matchedField,
            excerpt: match.excerpt,
            score: match.score
          })
          roundBestScore = Math.max(roundBestScore, match.score)
          bestScore = Math.max(bestScore, match.score)
        }

        if (!exhaustiveTargetedSearch && rawHits.length >= limit * 3) {
          hitTargetReached = true
          await reportProgress(reporter, {
            stage: 'streaming_hits',
            message: `Collected ${rawHits.length} candidate hits.`,
            sessionsScanned,
            messagesScanned
          })
          if (roundBestScore === Number.NEGATIVE_INFINITY || roundBestScore <= bestScoreBeforeBatch) {
            truncated = true
            break
          }
        }

        if (!result.hasMore) break
      }

      if (sessionScanned >= sessionScanLimit) {
        truncated = true
      }

      if (!exhaustiveTargetedSearch && truncated && rawHits.length >= limit * 3) {
        break
      }

      if (messagesScanned >= globalScanLimit) {
        truncated = true
        break
      }
    }

    rawHits.sort((a, b) => b.score - a.score || compareMessageCursorDesc(a.message, b.message))

    const hits = await Promise.all(rawHits.slice(0, limit).map(async (hit): Promise<McpSearchHit> => ({
      session: hit.session,
      message: await normalizeMessage(hit.session.sessionId, hit.message, {
        includeMediaPaths,
        includeRaw
      }),
      excerpt: hit.excerpt,
      matchedField: hit.matchedField,
      score: hit.score
    })))
    const sessionSummaries = buildSearchSessionSummaries(hits)
    await reportPartial(reporter, 'search_messages', {
      hits,
      limit,
      sessionsScanned,
      messagesScanned,
      truncated,
      sessionSummaries,
      source: 'scan',
      indexStatus: exhaustiveTargetedSearch
        ? {
          ready: false,
          indexedSessions: 0,
          indexedMessages: 0,
          error: 'Indexed search unavailable; used scan fallback.'
        }
        : undefined
    })

    return {
      hits,
      limit,
      sessionsScanned,
      messagesScanned,
      truncated,
      sessionSummaries,
      source: 'scan',
      indexStatus: exhaustiveTargetedSearch
        ? {
          ready: false,
          indexedSessions: 0,
          indexedMessages: 0,
          error: 'Indexed search unavailable; used scan fallback.'
        }
        : undefined
    }
  }

  async getSessionContext(rawArgs: GetSessionContextArgs, defaultIncludeMediaPaths: boolean, reporter?: McpStreamReporter): Promise<McpSessionContextPayload> {
    const args = getSessionContextArgsSchema.safeParse(rawArgs)
    if (!args.success) {
      throw new McpToolError('BAD_REQUEST', 'Invalid get_session_context arguments.', args.error.message)
    }

    const [{ items: sessions, map: sessionMap }, { items: contacts, map: contactMap }] = await Promise.all([
      getSessionCatalog(),
      getContactCatalog()
    ])
    const session = await resolveSessionRefStrictWithProgress(args.data.sessionId, sessions, sessionMap, contacts, contactMap, reporter)
    const resolvedSessionId = session.sessionId
    const includeRaw = args.data.includeRaw ?? false
    const includeMediaPaths = args.data.includeMediaPaths ?? defaultIncludeMediaPaths

    if (args.data.mode === 'latest') {
      const latestLimit = Math.min(args.data.beforeLimit ?? 30, MAX_CONTEXT_LIMIT)
      await reportProgress(reporter, {
        stage: 'scanning_messages',
        message: `Loading latest context for ${session.displayName}.`,
        sessionsScanned: 1
      })
      const result = await chatService.getMessages(resolvedSessionId, 0, latestLimit)
      if (!result.success) {
        mapChatError(result.error)
      }

      const messages = await normalizeMessages(resolvedSessionId, result.messages || [], {
        includeMediaPaths,
        includeRaw
      })
      await reportPartial(reporter, 'get_session_context', {
        session,
        mode: 'latest',
        items: messages,
        hasMoreBefore: Boolean(result.hasMore),
        hasMoreAfter: false
      })

      return {
        session,
        mode: 'latest',
        items: messages,
        hasMoreBefore: Boolean(result.hasMore),
        hasMoreAfter: false
      }
    }

    const anchorCursor = args.data.anchorCursor!
    const beforeLimit = Math.min(args.data.beforeLimit ?? 20, MAX_CONTEXT_LIMIT)
    const afterLimit = Math.min(args.data.afterLimit ?? 20, MAX_CONTEXT_LIMIT)
    await reportProgress(reporter, {
      stage: 'scanning_messages',
      message: `Loading context around anchor in ${session.displayName}.`,
      sessionsScanned: 1
    })

    const [beforeResult, anchorResult, afterResult] = await Promise.all([
      chatService.getMessagesBefore(
        resolvedSessionId,
        anchorCursor.sortSeq,
        beforeLimit,
        anchorCursor.createTime,
        anchorCursor.localId
      ),
      chatService.getMessagesAfter(
        resolvedSessionId,
        anchorCursor.sortSeq,
        1,
        anchorCursor.createTime,
        anchorCursor.localId - 1
      ),
      chatService.getMessagesAfter(
        resolvedSessionId,
        anchorCursor.sortSeq,
        afterLimit,
        anchorCursor.createTime,
        anchorCursor.localId
      )
    ])

    if (!beforeResult.success) mapChatError(beforeResult.error)
    if (!anchorResult.success) mapChatError(anchorResult.error)
    if (!afterResult.success) mapChatError(afterResult.error)

    const anchorMessage = (anchorResult.messages || []).find((message) => sameCursor(message, anchorCursor))
    if (!anchorMessage) {
      throw new McpToolError('BAD_REQUEST', 'Anchor cursor was not found in this session.')
    }

    const [beforeItems, anchorItem, afterItems] = await Promise.all([
      normalizeMessages(resolvedSessionId, beforeResult.messages || [], {
        includeMediaPaths,
        includeRaw
      }),
      normalizeMessage(resolvedSessionId, anchorMessage, {
        includeMediaPaths,
        includeRaw
      }),
      normalizeMessages(resolvedSessionId, afterResult.messages || [], {
        includeMediaPaths,
        includeRaw
      })
    ])
    await reportPartial(reporter, 'get_session_context', {
      session,
      mode: 'around',
      anchor: anchorItem,
      items: [...beforeItems, anchorItem, ...afterItems],
      hasMoreBefore: Boolean(beforeResult.hasMore),
      hasMoreAfter: Boolean(afterResult.hasMore)
    })

    return {
      session,
      mode: 'around',
      anchor: anchorItem,
      items: [...beforeItems, anchorItem, ...afterItems],
      hasMoreBefore: Boolean(beforeResult.hasMore),
      hasMoreAfter: Boolean(afterResult.hasMore)
    }
  }
}
