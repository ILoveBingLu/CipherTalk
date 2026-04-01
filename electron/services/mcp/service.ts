import { existsSync, mkdirSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod'
import { analyticsService } from '../analyticsService'
import { chatService, type ChatSession, type ContactInfo, type Message } from '../chatService'
import { ConfigService } from '../config'
import { imageDecryptService } from '../imageDecryptService'
import { videoService } from '../videoService'
import { McpToolError } from './result'
import {
  MCP_CONTACT_KINDS,
  MCP_MESSAGE_KINDS,
  type McpContactItem,
  type McpContactKind,
  type McpContactsPayload,
  type McpCursor,
  type McpGlobalStatisticsPayload,
  type McpContactRankingItem,
  type McpContactRankingsPayload,
  type McpActivityDistributionPayload,
  type McpMessageItem,
  type McpMessageKind,
  type McpMessageMatchField,
  type McpSearchMatchMode,
  type McpMessagesPayload,
  type McpSearchHit,
  type McpSearchMessagesPayload,
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

const listSessionsArgsSchema = z.object({
  q: z.string().optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
  unreadOnly: z.boolean().optional()
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
type GetMessagesArgs = z.infer<typeof getMessagesArgsSchema>
type ListContactsArgs = z.infer<typeof listContactsArgsSchema>
type SearchMessagesArgs = z.infer<typeof searchMessagesArgsSchema>
type GetSessionContextArgs = z.infer<typeof getSessionContextArgsSchema>
type ContactWithLastContact = ContactInfo & { lastContactTime?: number }
type MessageNormalizeOptions = {
  includeMediaPaths: boolean
  includeRaw: boolean
}
type SearchRawHit = {
  session: McpSessionRef
  message: Message
  matchedField: McpMessageMatchField
  excerpt: string
  score: number
}

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

function toContactItem(contact: ContactWithLastContact): McpContactItem {
  const lastContactTimestamp = Number(contact.lastContactTime || 0)
  return {
    contactId: contact.username,
    displayName: contact.displayName,
    remark: contact.remark || undefined,
    nickname: contact.nickname || undefined,
    kind: contact.type as McpContactKind,
    lastContactTimestamp,
    lastContactTimestampMs: toTimestampMs(lastContactTimestamp)
  }
}

function resolveSessionRef(sessionId: string, sessionMap: Map<string, McpSessionRef>): McpSessionRef {
  return sessionMap.get(sessionId) || {
    sessionId,
    displayName: sessionId,
    kind: detectSessionKind(sessionId)
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
  if (!message.videoMd5) return null

  try {
    const info = videoService.getVideoInfo(String(message.videoMd5))
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

async function normalizeMessage(
  sessionId: string,
  message: Message,
  options: MessageNormalizeOptions
): Promise<McpMessageItem> {
  const kind = detectMessageKind(message)
  const direction = Number(message.isSend) === 1 ? 'out' : 'in'
  const normalized: McpMessageItem = {
    messageId: Number(message.localId || message.serverId || 0),
    timestamp: Number(message.createTime || 0),
    timestampMs: toTimestampMs(Number(message.createTime || 0)),
    direction,
    kind,
    text: String(message.parsedContent || message.rawContent || ''),
    sender: {
      username: message.senderUsername ?? null,
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
  async listSessions(rawArgs: ListSessionsArgs): Promise<McpSessionsPayload> {
    const args = listSessionsArgsSchema.safeParse(rawArgs)
    if (!args.success) {
      throw new McpToolError('BAD_REQUEST', 'Invalid list_sessions arguments.', args.error.message)
    }

    const query = normalizeQuery(args.data.q)
    const offset = Math.max(0, args.data.offset ?? 0)
    const limit = Math.min(args.data.limit ?? 100, MAX_LIST_LIMIT)
    const unreadOnly = Boolean(args.data.unreadOnly)

    let sessions = (await getSessionCatalog()).items

    if (query) {
      sessions = sessions.filter((session) => {
        return [
          session.sessionId,
          session.displayName,
          session.lastMessagePreview
        ].some((value) => value.toLowerCase().includes(query))
      })
    }

    if (unreadOnly) {
      sessions = sessions.filter((session) => session.unreadCount > 0)
    }

    const total = sessions.length
    const items = sessions.slice(offset, offset + limit)

    return {
      items,
      total,
      offset,
      limit,
      hasMore: offset + items.length < total
    }
  }

  async listContacts(rawArgs: ListContactsArgs): Promise<McpContactsPayload> {
    const args = listContactsArgsSchema.safeParse(rawArgs)
    if (!args.success) {
      throw new McpToolError('BAD_REQUEST', 'Invalid list_contacts arguments.', args.error.message)
    }

    const query = normalizeQuery(args.data.q)
    const offset = Math.max(0, args.data.offset ?? 0)
    const limit = Math.min(args.data.limit ?? 100, MAX_LIST_LIMIT)
    const typeSet = args.data.types?.length ? new Set(args.data.types) : null

    const result = await chatService.getContacts()
    if (!result.success) {
      mapChatError(result.error)
    }

    let contacts = (result.contacts || []).map((contact) => toContactItem(contact as ContactWithLastContact))

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

  async getMessages(rawArgs: GetMessagesArgs, defaultIncludeMediaPaths: boolean): Promise<McpMessagesPayload> {
    const args = getMessagesArgsSchema.safeParse(rawArgs)
    if (!args.success) {
      throw new McpToolError('BAD_REQUEST', 'Invalid get_messages arguments.', args.error.message)
    }

    const {
      sessionId,
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

      if (!result.hasMore) {
        reachedEnd = true
        break
      }
    }

    matched.sort((a, b) => order === 'asc' ? compareMessageCursorAsc(a, b) : compareMessageCursorDesc(a, b))

    const page = matched.slice(offset, offset + limit)
    const items = await normalizeMessages(sessionId, page, { includeMediaPaths, includeRaw })

    return {
      items,
      offset,
      limit,
      hasMore: reachedEnd ? matched.length > offset + items.length : true
    }
  }

  async searchMessages(rawArgs: SearchMessagesArgs, defaultIncludeMediaPaths: boolean): Promise<McpSearchMessagesPayload> {
    const args = searchMessagesArgsSchema.safeParse(rawArgs)
    if (!args.success) {
      throw new McpToolError('BAD_REQUEST', 'Invalid search_messages arguments.', args.error.message)
    }

    const { items: sessions, map: sessionMap } = await getSessionCatalog()
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
      ? sessionIdCandidates.map((sessionId) => resolveSessionRef(sessionId, sessionMap))
      : sessions.slice(0, MAX_SEARCH_SESSIONS).map((session) => ({
          sessionId: session.sessionId,
          displayName: session.displayName,
          kind: session.kind
        }))

    const kindSet = args.data.kinds?.length ? new Set(args.data.kinds) : undefined
    const senderUsername = normalizeQuery(args.data.senderUsername)
    const startTimeMs = toTimestampMs(args.data.startTime)
    const endTimeMs = toTimestampMs(args.data.endTime)

    const rawHits: SearchRawHit[] = []
    let sessionsScanned = 0
    let messagesScanned = 0
    let truncated = false
    let bestScore = Number.NEGATIVE_INFINITY
    let hitTargetReached = false

    for (const session of targetSessions) {
      sessionsScanned += 1

      let sessionOffset = 0
      let sessionScanned = 0

      while (sessionScanned < MAX_SCAN_PER_SESSION && messagesScanned < MAX_SCAN_GLOBAL) {
        const bestScoreBeforeBatch = bestScore
        let roundBestScore = Number.NEGATIVE_INFINITY

        const fetchLimit = Math.min(
          SEARCH_BATCH_SIZE,
          MAX_SCAN_PER_SESSION - sessionScanned,
          MAX_SCAN_GLOBAL - messagesScanned
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

        if (rawHits.length >= limit * 3) {
          hitTargetReached = true
          if (roundBestScore === Number.NEGATIVE_INFINITY || roundBestScore <= bestScoreBeforeBatch) {
            truncated = true
            break
          }
        }

        if (!result.hasMore) break
      }

      if (truncated && rawHits.length >= limit * 3) {
        break
      }

      if (messagesScanned >= MAX_SCAN_GLOBAL) {
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

    return {
      hits,
      limit,
      sessionsScanned,
      messagesScanned,
      truncated
    }
  }

  async getSessionContext(rawArgs: GetSessionContextArgs, defaultIncludeMediaPaths: boolean): Promise<McpSessionContextPayload> {
    const args = getSessionContextArgsSchema.safeParse(rawArgs)
    if (!args.success) {
      throw new McpToolError('BAD_REQUEST', 'Invalid get_session_context arguments.', args.error.message)
    }

    const { map: sessionMap } = await getSessionCatalog()
    const session = resolveSessionRef(args.data.sessionId, sessionMap)
    const includeRaw = args.data.includeRaw ?? false
    const includeMediaPaths = args.data.includeMediaPaths ?? defaultIncludeMediaPaths

    if (args.data.mode === 'latest') {
      const latestLimit = Math.min(args.data.beforeLimit ?? 30, MAX_CONTEXT_LIMIT)
      const result = await chatService.getMessages(args.data.sessionId, 0, latestLimit)
      if (!result.success) {
        mapChatError(result.error)
      }

      const messages = await normalizeMessages(args.data.sessionId, result.messages || [], {
        includeMediaPaths,
        includeRaw
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

    const [beforeResult, anchorResult, afterResult] = await Promise.all([
      chatService.getMessagesBefore(
        args.data.sessionId,
        anchorCursor.sortSeq,
        beforeLimit,
        anchorCursor.createTime,
        anchorCursor.localId
      ),
      chatService.getMessagesAfter(
        args.data.sessionId,
        anchorCursor.sortSeq,
        1,
        anchorCursor.createTime,
        anchorCursor.localId - 1
      ),
      chatService.getMessagesAfter(
        args.data.sessionId,
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
      normalizeMessages(args.data.sessionId, beforeResult.messages || [], {
        includeMediaPaths,
        includeRaw
      }),
      normalizeMessage(args.data.sessionId, anchorMessage, {
        includeMediaPaths,
        includeRaw
      }),
      normalizeMessages(args.data.sessionId, afterResult.messages || [], {
        includeMediaPaths,
        includeRaw
      })
    ])

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
