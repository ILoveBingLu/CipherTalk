import { existsSync, mkdirSync } from 'fs'
import { writeFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { join } from 'path'
import { ConfigService } from './config'
import { chatService } from './chatService'
import { imageDecryptService } from './imageDecryptService'
import { videoService } from './videoService'
import { getAppVersion } from './runtimePaths'

type ContactType = 'friend' | 'group' | 'official' | 'former_friend' | 'other'
type SessionTypeFilter = 'friend' | 'group' | 'official' | 'other'

export interface HttpApiRuntimeStatus {
  enabled: boolean
  running: boolean
  host: string
  port: number
  startedAt: number
  token: string
  startError: string
}

export interface ApiErrorShape {
  code: string
  message: string
  hint?: string
}

export class ApiQueryError extends Error {
  statusCode: number
  code: string
  hint?: string

  constructor(statusCode: number, code: string, message: string, hint?: string) {
    super(message)
    this.name = 'ApiQueryError'
    this.statusCode = statusCode
    this.code = code
    this.hint = hint
  }

  toResponse(): ApiErrorShape {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint
    }
  }
}

export interface QuerySessionsInput {
  q?: string
  type?: string[] | null
  unreadOnly?: boolean
  sort?: string
  offset?: number
  limit?: number
}

export interface QueryMessagesInput {
  sessionId: string
  offset?: number
  limit?: number
  sort?: string
  keyword?: string
  msgType?: number[] | null
  messageKind?: string[] | null
  appMsgType?: string[] | null
  startTime?: number | null
  endTime?: number | null
  includeRaw?: boolean
  resolveMediaPath?: boolean
  resolveVoicePath?: boolean
  adaptive?: boolean
  maxScan?: number
  fields?: string[] | null
}

export interface QueryContactsInput {
  q?: string
  type?: string[] | null
  includeAvatar?: boolean
  sort?: string
  offset?: number
  limit?: number
}

function parseBoolean(value: string | null | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return defaultValue
}

function parseIntInRange(value: string | number | null | undefined, defaultValue: number, min: number, max: number): number {
  if (value == null || value === '') return defaultValue
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return defaultValue
  return Math.max(min, Math.min(max, n))
}

function parseNumberList(value: string | null | undefined): number[] | null {
  if (!value) return null
  const nums = value
    .split(',')
    .map((x) => Number.parseInt(x.trim(), 10))
    .filter((x) => Number.isFinite(x))
  return nums.length > 0 ? nums : null
}

function parseStringSet(value: string | null | undefined): Set<string> | null {
  if (!value) return null
  const values = value
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
  return values.length > 0 ? new Set(values) : null
}

function parseFields(value: string | null | undefined): Set<string> {
  const defaults = ['base', 'type', 'time', 'sender', 'metadata', 'media']
  if (!value || !value.trim()) {
    return new Set(defaults)
  }

  const parts = value
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)

  if (parts.includes('all')) {
    return new Set([
      'all',
      'base',
      'type',
      'time',
      'sender',
      'metadata',
      'media',
      'quote',
      'file',
      'transfer',
      'chatrecord',
      'raw',
      'schema'
    ])
  }

  return new Set(parts)
}

function parseTimestampMs(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null
  const raw = typeof value === 'number' ? value : Number.parseInt(value, 10)
  if (!Number.isFinite(raw) || raw <= 0) return null
  return raw < 1_000_000_000_000 ? raw * 1000 : raw
}

function normalizeTimestampMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return value < 1_000_000_000_000 ? value * 1000 : value
}

function extractXmlType(content?: string): string | undefined {
  if (!content) return undefined
  const match = content.match(/<type>\s*([^<]+)\s*<\/type>/i)
  return match?.[1]?.trim()
}

function fileUrlToPathMaybe(input?: string | null): string | null {
  if (!input) return null
  if (input.startsWith('file:///')) {
    try {
      return fileURLToPath(input)
    } catch {
      return null
    }
  }
  return input
}

function sanitizePathPart(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_')
}

function pruneEmpty(value: any): any {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return value === '' ? undefined : value
  if (Array.isArray(value)) {
    const next = value
      .map((v) => pruneEmpty(v))
      .filter((v) => v !== undefined)
    return next.length > 0 ? next : undefined
  }
  if (typeof value === 'object') {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(value)) {
      const pruned = pruneEmpty(v)
      if (pruned !== undefined) out[k] = pruned
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  return value
}

function detectMessageKind(message: Record<string, any>): {
  messageKind: string
  typeLabel: string
  appMsgType?: string
} {
  const localType = Number(message.localType || 0)
  const raw = String(message.rawContent || message.parsedContent || '')
  const appMsgType = extractXmlType(raw)

  if (localType === 1) return { messageKind: 'text', typeLabel: '文本' }
  if (localType === 3) return { messageKind: 'image', typeLabel: '图片' }
  if (localType === 34) return { messageKind: 'voice', typeLabel: '语音' }
  if (localType === 42) return { messageKind: 'contact_card', typeLabel: '名片' }
  if (localType === 43) return { messageKind: 'video', typeLabel: '视频' }
  if (localType === 47) return { messageKind: 'emoji', typeLabel: '表情' }
  if (localType === 48) return { messageKind: 'location', typeLabel: '位置' }
  if (localType === 50) return { messageKind: 'voip', typeLabel: '音视频通话' }
  if (localType === 10000) return { messageKind: 'system', typeLabel: '系统消息' }
  if (localType === 244813135921) return { messageKind: 'quote', typeLabel: '引用消息' }

  if (localType === 49 || appMsgType) {
    switch (appMsgType) {
      case '3':
        return { messageKind: 'app_music', typeLabel: '音乐分享', appMsgType }
      case '5':
      case '49':
        return { messageKind: 'app_link', typeLabel: '链接', appMsgType }
      case '6':
        return { messageKind: 'app_file', typeLabel: '文件', appMsgType }
      case '19':
        return { messageKind: 'app_chat_record', typeLabel: '聊天记录', appMsgType }
      case '33':
      case '36':
        return { messageKind: 'app_mini_program', typeLabel: '小程序', appMsgType }
      case '57':
        return { messageKind: 'app_quote', typeLabel: '引用消息', appMsgType }
      case '62':
        return { messageKind: 'app_pat', typeLabel: '拍一拍', appMsgType }
      case '87':
        return { messageKind: 'app_announcement', typeLabel: '群公告', appMsgType }
      case '115':
        return { messageKind: 'app_gift', typeLabel: '微信礼物', appMsgType }
      case '2000':
        return { messageKind: 'app_transfer', typeLabel: '转账', appMsgType }
      case '2001':
        return { messageKind: 'app_red_packet', typeLabel: '红包', appMsgType }
      default:
        return { messageKind: 'app', typeLabel: '应用消息', appMsgType }
    }
  }

  return { messageKind: 'unknown', typeLabel: `未知类型(${localType})` }
}

function parseTypeFilter(values?: string[] | null): Set<ContactType> | null {
  if (!values?.length) return null
  const allowed: ContactType[] = ['friend', 'group', 'official', 'former_friend', 'other']
  const result = new Set<ContactType>()
  values.forEach((x) => {
    if (allowed.includes(x as ContactType)) {
      result.add(x as ContactType)
    }
  })
  return result.size > 0 ? result : null
}

function parseSessionTypeFilter(values?: string[] | null): Set<SessionTypeFilter> | null {
  if (!values?.length) return null
  const allowed: SessionTypeFilter[] = ['friend', 'group', 'official', 'other']
  const result = new Set<SessionTypeFilter>()
  values.forEach((x) => {
    if (allowed.includes(x as SessionTypeFilter)) {
      result.add(x as SessionTypeFilter)
    }
  })
  return result.size > 0 ? result : null
}

function detectSessionType(username: string): SessionTypeFilter {
  if (username.includes('@chatroom')) return 'group'
  if (username.startsWith('gh_')) return 'official'
  if (username) return 'friend'
  return 'other'
}

function getBaseUrl(status: HttpApiRuntimeStatus): string {
  return `http://${status.host}:${status.port}/v1`
}

export function queryHealth() {
  return { status: 'ok' }
}

export function queryStatus(status: HttpApiRuntimeStatus, verbose = false) {
  const configService = new ConfigService()
  const hasDbPath = Boolean(configService.get('dbPath'))
  const hasWxid = Boolean(configService.get('myWxid'))
  const hasDecryptKey = Boolean(configService.get('decryptKey'))
  configService.close()

  const isApiEnabled = status.enabled
  const isApiRunning = status.running
  const isDbConfigReady = hasDbPath && hasWxid && hasDecryptKey

  let state: 'ready' | 'disabled' | 'starting_or_error' | 'needs_config' = 'ready'
  let message = 'HTTP API is ready for external calls.'

  if (!isApiEnabled) {
    state = 'disabled'
    message = 'HTTP API is disabled. Enable it in Settings > Open API.'
  } else if (!isApiRunning) {
    state = 'starting_or_error'
    message = status.startError || 'HTTP API is enabled but not running. Try restart in settings.'
  } else if (!isDbConfigReady) {
    state = 'needs_config'
    message = 'API is running, but database-related features need dbPath/decryptKey/wxid configuration.'
  }

  const basePayload = {
    summary: {
      state,
      usable: isApiEnabled && isApiRunning,
      message
    },
    server: {
      running: isApiRunning,
      enabled: isApiEnabled,
      host: status.host,
      port: status.port,
      uptimeMs: status.startedAt ? Date.now() - status.startedAt : 0
    },
    auth: {
      required: Boolean(status.token),
      scheme: 'Authorization: Bearer <token>'
    },
    config: {
      dbConfigReady: isDbConfigReady
    }
  }

  if (!verbose) {
    return basePayload
  }

  return {
    ...basePayload,
    usage: {
      baseUrl: getBaseUrl(status),
      health: '/v1/health',
      status: '/v1/status',
      auth: status.token ? 'Authorization: Bearer <token>' : 'No auth token required'
    },
    app: {
      version: getAppVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      platform: process.platform
    },
    debug: {
      checks: {
        apiEnabled: isApiEnabled,
        apiRunning: isApiRunning,
        dbConfigReady: isDbConfigReady,
        authRequired: Boolean(status.token)
      },
      tokenPreview: status.token ? `${status.token.slice(0, 3)}***${status.token.slice(-3)}` : '',
      startedAt: status.startedAt ? new Date(status.startedAt).toISOString() : '',
      lastError: status.startError
    }
  }
}

export async function querySessions(input: QuerySessionsInput) {
  const q = (input.q || '').trim().toLowerCase()
  const typeFilter = parseSessionTypeFilter(input.type || null)
  const unreadOnly = Boolean(input.unreadOnly)
  const sort = (input.sort || 'sortTimestamp_desc').trim()
  const offset = parseIntInRange(input.offset, 0, 0, 100000)
  const limit = parseIntInRange(input.limit, 100, 1, 500)

  const sessionsResult = await chatService.getSessions()
  if (!sessionsResult.success) {
    throw new ApiQueryError(
      503,
      'DB_NOT_CONNECTED',
      sessionsResult.error || 'Failed to read sessions',
      'Please complete DB decrypt/setup in Settings and ensure data is available.'
    )
  }

  let sessions = (sessionsResult.sessions || []).map((item) => {
    const sessionType = detectSessionType(item.username || '')
    return {
      username: item.username,
      displayName: item.displayName || item.username,
      avatarUrl: item.avatarUrl,
      summary: item.summary,
      unreadCount: item.unreadCount || 0,
      sortTimestamp: item.sortTimestamp || 0,
      lastTimestamp: item.lastTimestamp || 0,
      lastMsgType: item.lastMsgType || 0,
      sessionType
    }
  })

  if (typeFilter) {
    sessions = sessions.filter((item) => typeFilter.has(item.sessionType))
  }

  if (unreadOnly) {
    sessions = sessions.filter((item) => Number(item.unreadCount || 0) > 0)
  }

  if (q) {
    sessions = sessions.filter((item) => {
      const username = String(item.username || '').toLowerCase()
      const displayName = String(item.displayName || '').toLowerCase()
      const summary = String(item.summary || '').toLowerCase()
      return username.includes(q) || displayName.includes(q) || summary.includes(q)
    })
  }

  if (sort === 'name_asc') {
    sessions.sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || ''), 'zh-CN'))
  } else if (sort === 'name_desc') {
    sessions.sort((a, b) => String(b.displayName || '').localeCompare(String(a.displayName || ''), 'zh-CN'))
  } else if (sort === 'lastTimestamp_asc') {
    sessions.sort((a, b) => Number(a.lastTimestamp || 0) - Number(b.lastTimestamp || 0))
  } else if (sort === 'lastTimestamp_desc') {
    sessions.sort((a, b) => Number(b.lastTimestamp || 0) - Number(a.lastTimestamp || 0))
  } else if (sort === 'unreadCount_desc') {
    sessions.sort((a, b) => Number(b.unreadCount || 0) - Number(a.unreadCount || 0))
  } else {
    sessions.sort((a, b) => Number(b.sortTimestamp || 0) - Number(a.sortTimestamp || 0))
  }

  const total = sessions.length
  const paged = sessions.slice(offset, offset + limit)
  const hasMore = offset + paged.length < total

  return {
    total,
    offset,
    limit,
    hasMore,
    sort,
    filters: {
      q,
      type: typeFilter ? Array.from(typeFilter) : null,
      unreadOnly
    },
    sessions: paged
  }
}

export async function queryMessages(input: QueryMessagesInput) {
  const sessionId = (input.sessionId || '').trim()
  if (!sessionId) {
    throw new ApiQueryError(
      400,
      'BAD_REQUEST',
      'Missing required parameter: sessionId',
      'Use query parameter: sessionId=<chat_username>'
    )
  }

  const offset = parseIntInRange(input.offset, 0, 0, 100000)
  const limit = parseIntInRange(input.limit, 50, 1, 200)
  const sort = (input.sort || 'createTime_desc').trim()
  const keyword = (input.keyword || '').trim().toLowerCase()
  const msgTypeFilter = input.msgType || null
  const messageKindFilter = input.messageKind?.length ? new Set(input.messageKind.map((x) => x.toLowerCase())) : null
  const appMsgTypeFilter = input.appMsgType?.length ? new Set(input.appMsgType.map((x) => x.toLowerCase())) : null
  const startTimeMs = parseTimestampMs(input.startTime)
  const endTimeMs = parseTimestampMs(input.endTime)
  const includeRaw = Boolean(input.includeRaw)
  const resolveMediaPath = parseBoolean(input.resolveMediaPath === undefined ? undefined : String(input.resolveMediaPath), true)
  const resolveVoicePath = parseBoolean(input.resolveVoicePath === undefined ? undefined : String(input.resolveVoicePath), false)
  const adaptive = parseBoolean(input.adaptive === undefined ? undefined : String(input.adaptive), true)
  const maxScan = parseIntInRange(input.maxScan, 5000, 100, 20000)
  const fields = parseFields(input.fields?.join(',') || null)
  if (includeRaw) fields.add('raw')

  const includeField = (name: string): boolean => fields.has('all') || fields.has(name)
  const needKindForFilter = Boolean(messageKindFilter || appMsgTypeFilter)
  const needKindForOutput = [includeField('type'), includeField('metadata'), includeField('media')].some(Boolean)
  const shouldResolveMediaPath = includeField('media') && resolveMediaPath
  const shouldResolveVoicePath = includeField('media') && resolveVoicePath
  const includeChatRecordItems = includeField('chatrecord')

  let myWxid = ''
  let dbPath = ''
  let cachePath = ''
  if (shouldResolveVoicePath || shouldResolveMediaPath || includeField('file')) {
    const runtimeConfig = new ConfigService()
    myWxid = String(runtimeConfig.get('myWxid') || '')
    dbPath = String(runtimeConfig.get('dbPath') || '')
    cachePath = String(runtimeConfig.get('cachePath') || '')
    runtimeConfig.close()
  }

  const fetchBatchSize = 200
  const targetCount = offset + limit
  let scanOffset = 0
  let scanned = 0
  let reachedEnd = false
  const matched: any[] = []

  while (scanned < maxScan && matched.length < targetCount) {
    const part = await chatService.getMessages(sessionId, scanOffset, fetchBatchSize)
    if (!part.success) {
      throw new ApiQueryError(
        503,
        'DB_NOT_CONNECTED',
        part.error || 'Failed to read messages',
        'Please complete DB decrypt/setup in Settings and ensure sessionId is correct.'
      )
    }

    const chunk = part.messages || []
    if (chunk.length === 0) {
      reachedEnd = true
      break
    }

    scanned += chunk.length
    scanOffset += chunk.length

    for (const msg of chunk) {
      if (msgTypeFilter && !msgTypeFilter.includes(Number(msg.localType || 0))) continue

      if (needKindForFilter) {
        const kindInfo = detectMessageKind(msg as Record<string, any>)
        if (messageKindFilter && !messageKindFilter.has(kindInfo.messageKind)) continue
        if (appMsgTypeFilter) {
          const appMsgType = (kindInfo.appMsgType || '').toLowerCase()
          if (!appMsgType || !appMsgTypeFilter.has(appMsgType)) continue
        }
      }

      const tMs = normalizeTimestampMs(Number(msg.createTime || 0))
      if (startTimeMs && tMs < startTimeMs) continue
      if (endTimeMs && tMs > endTimeMs) continue

      if (keyword) {
        const parsed = String(msg.parsedContent || '').toLowerCase()
        const raw = String(msg.rawContent || '').toLowerCase()
        if (!parsed.includes(keyword) && !raw.includes(keyword)) continue
      }

      matched.push(msg)
    }

    if (!part.hasMore) {
      reachedEnd = true
      break
    }
  }

  if (sort === 'createTime_asc') {
    matched.sort((a, b) => Number(a.createTime || 0) - Number(b.createTime || 0))
  } else {
    matched.sort((a, b) => Number(b.createTime || 0) - Number(a.createTime || 0))
  }

  const page = matched.slice(offset, offset + limit)
  const hasMore = reachedEnd ? matched.length > offset + page.length : true

  const enrichOne = async (m: any): Promise<Record<string, any>> => {
    const base = m as Record<string, any>
    const kind = needKindForOutput ? detectMessageKind(base) : { messageKind: 'unknown', typeLabel: '未知类型', appMsgType: undefined }
    const createTimeMs = normalizeTimestampMs(Number(base.createTime || 0))
    const senderUsername = base.senderUsername || null

    const metadata = {
      localType: Number(base.localType || 0),
      messageKind: kind.messageKind,
      typeLabel: kind.typeLabel,
      appMsgType: kind.appMsgType || null,
      direction: Number(base.isSend) === 1 ? 'out' : 'in',
      isSystem: Number(base.localType || 0) === 10000 || kind.messageKind === 'app_pat',
      isMedia: ['image', 'voice', 'video', 'emoji'].includes(kind.messageKind),
      hasRawContent: Boolean(base.rawContent),
      hasParsedContent: Boolean(base.parsedContent),
      hasQuote: Boolean(base.quotedContent || base.quotedImageMd5 || base.quotedEmojiMd5),
      hasFile: Boolean(base.fileName || base.fileMd5),
      hasTransfer: Boolean(base.transferPayerUsername || base.transferReceiverUsername),
      hasChatRecord: Array.isArray(base.chatRecordList) && base.chatRecordList.length > 0,
      isLivePhoto: Boolean(base.isLivePhoto)
    }

    const media = {
      imageMd5: base.imageMd5 || null,
      imageDatName: base.imageDatName || null,
      imageCachePath: null as string | null,
      emojiMd5: base.emojiMd5 || null,
      emojiCdnUrl: base.emojiCdnUrl || null,
      emojiCachePath: null as string | null,
      videoMd5: base.videoMd5 || null,
      videoDuration: base.videoDuration || null,
      videoCachePath: null as string | null,
      voiceDuration: base.voiceDuration || null,
      voiceCachePath: null as string | null
    }

    if (shouldResolveMediaPath && (kind.messageKind === 'emoji' || kind.messageKind.startsWith('app_')) && (base.emojiMd5 || base.emojiCdnUrl)) {
      try {
        const emojiResult = await chatService.downloadEmoji(
          String(base.emojiCdnUrl || ''),
          base.emojiMd5,
          base.productId,
          Number(base.createTime || 0),
          base.emojiEncryptUrl,
          base.emojiAesKey
        )
        if (emojiResult.success && emojiResult.cachePath) {
          media.emojiCachePath = emojiResult.cachePath
        }
      } catch {
        // ignore
      }
    }

    if (shouldResolveMediaPath && kind.messageKind === 'image' && (base.imageMd5 || base.imageDatName)) {
      try {
        const resolved = await imageDecryptService.resolveCachedImage({
          sessionId,
          imageMd5: base.imageMd5,
          imageDatName: base.imageDatName
        })

        if (resolved.success && resolved.localPath) {
          media.imageCachePath = fileUrlToPathMaybe(resolved.localPath)
        } else {
          const decrypted = await imageDecryptService.decryptImage({
            sessionId,
            imageMd5: base.imageMd5,
            imageDatName: base.imageDatName,
            force: false
          })
          if (decrypted.success && decrypted.localPath) {
            media.imageCachePath = fileUrlToPathMaybe(decrypted.localPath)
          }
        }
      } catch {
        // ignore
      }
    }

    if (shouldResolveMediaPath && kind.messageKind === 'video' && base.videoMd5) {
      try {
        const videoInfo = videoService.getVideoInfo(String(base.videoMd5))
        if (videoInfo.exists && videoInfo.videoUrl) {
          media.videoCachePath = fileUrlToPathMaybe(videoInfo.videoUrl)
        }
      } catch {
        // ignore
      }
    }

    if (shouldResolveVoicePath && kind.messageKind === 'voice') {
      try {
        const voiceResult = await chatService.getVoiceData(
          sessionId,
          String(base.localId || ''),
          Number(base.createTime || 0)
        )
        if (voiceResult.success && voiceResult.data) {
          const baseCacheDir = cachePath || join(process.cwd(), 'cache')
          const voiceDir = join(baseCacheDir, 'HttpApiVoices', sanitizePathPart(sessionId))
          if (!existsSync(voiceDir)) {
            mkdirSync(voiceDir, { recursive: true })
          }
          const fileName = `${Number(base.createTime || 0)}_${Number(base.localId || 0)}.wav`
          const absPath = join(voiceDir, fileName)
          await writeFile(absPath, Buffer.from(voiceResult.data, 'base64'))
          media.voiceCachePath = absPath
        }
      } catch {
        // ignore
      }
    }

    const quote = metadata.hasQuote
      ? {
          content: base.quotedContent || null,
          sender: base.quotedSender || null,
          imageMd5: base.quotedImageMd5 || null,
          emojiMd5: base.quotedEmojiMd5 || null,
          emojiCdnUrl: base.quotedEmojiCdnUrl || null
        }
      : null

    const file = metadata.hasFile
      ? {
          name: base.fileName || null,
          size: base.fileSize || null,
          ext: base.fileExt || null,
          md5: base.fileMd5 || null,
          absolutePath: null as string | null,
          exists: false
        }
      : null

    if (shouldResolveMediaPath && file?.name && dbPath && myWxid) {
      try {
        const msgDate = createTimeMs ? new Date(createTimeMs) : new Date()
        const year = msgDate.getFullYear()
        const month = String(msgDate.getMonth() + 1).padStart(2, '0')
        const dateFolder = `${year}-${month}`
        const abs = join(dbPath, myWxid, 'msg', 'file', dateFolder, String(file.name))
        file.absolutePath = abs
        file.exists = existsSync(abs)
      } catch {
        // ignore
      }
    }

    const transfer = metadata.hasTransfer
      ? {
          payerUsername: base.transferPayerUsername || null,
          receiverUsername: base.transferReceiverUsername || null
        }
      : null

    const chatRecord = metadata.hasChatRecord
      ? {
          count: Array.isArray(base.chatRecordList) ? base.chatRecordList.length : 0,
          items: includeChatRecordItems ? (base.chatRecordList || []) : undefined
        }
      : null

    const out: Record<string, any> = {}

    if (includeField('base')) {
      out.localId = base.localId || 0
      out.serverId = base.serverId || 0
      out.localType = Number(base.localType || 0)
      out.createTime = Number(base.createTime || 0)
      out.sortSeq = Number(base.sortSeq || 0)
      out.isSend = base.isSend ?? null
      out.senderUsername = senderUsername
      out.parsedContent = base.parsedContent || ''
    }

    if (includeField('raw')) out.rawContent = base.rawContent || null
    if (includeField('type')) {
      out.messageKind = kind.messageKind
      out.typeLabel = kind.typeLabel
      out.appMsgType = kind.appMsgType || null
      out.direction = metadata.direction
    }
    if (includeField('time')) {
      out.createTimeMs = createTimeMs
      out.createTimeIso = createTimeMs ? new Date(createTimeMs).toISOString() : null
    }
    if (includeField('sender')) {
      out.sender = {
        username: senderUsername,
        isSelf: Number(base.isSend) === 1
      }
    }
    if (includeField('metadata')) out.metadata = metadata
    if (includeField('media')) out.media = media
    if (includeField('quote')) out.quote = quote
    if (includeField('file')) out.file = file
    if (includeField('transfer')) out.transfer = transfer
    if (includeField('chatrecord')) out.chatRecord = chatRecord

    return out
  }

  const enrichResults = await Promise.allSettled(page.map((m) => enrichOne(m)))
  const enrichedMessages = enrichResults
    .filter((r): r is PromiseFulfilledResult<Record<string, any>> => r.status === 'fulfilled')
    .map((r) => r.value)

  const normalizedMessages = adaptive
    ? enrichedMessages.map((m) => pruneEmpty(m)).filter(Boolean)
    : enrichedMessages

  const finalMessages = includeRaw
    ? normalizedMessages
    : normalizedMessages.map((m) => {
        const { rawContent, ...rest } = m as Record<string, any>
        return rest
      })

  const responsePayload: Record<string, any> = {
    sessionId,
    total: reachedEnd ? matched.length : null,
    offset,
    limit,
    hasMore,
    scanned,
    maxScan,
    sort,
    filters: {
      keyword,
      msgType: msgTypeFilter,
      messageKind: messageKindFilter ? Array.from(messageKindFilter) : null,
      appMsgType: appMsgTypeFilter ? Array.from(appMsgTypeFilter) : null,
      startTime: startTimeMs,
      endTime: endTimeMs,
      includeRaw,
      resolveMediaPath,
      resolveVoicePath,
      adaptive,
      fields: Array.from(fields)
    },
    messages: finalMessages
  }

  if (includeField('schema')) {
    responsePayload.messageTypeSchema = {
      messageKind: {
        text: '文本',
        image: '图片',
        voice: '语音',
        video: '视频',
        emoji: '表情',
        location: '位置',
        contact_card: '名片',
        system: '系统消息',
        quote: '引用消息',
        voip: '音视频通话',
        app_link: '链接',
        app_file: '文件',
        app_chat_record: '聊天记录',
        app_mini_program: '小程序',
        app_transfer: '转账',
        app_red_packet: '红包',
        app_announcement: '群公告',
        app_pat: '拍一拍',
        app_gift: '微信礼物',
        app_music: '音乐分享',
        app: '应用消息',
        unknown: '未知类型'
      },
      direction: {
        out: '我发送',
        in: '我接收'
      }
    }
  }

  return responsePayload
}

export async function queryContacts(input: QueryContactsInput) {
  const q = (input.q || '').trim().toLowerCase()
  const typeFilter = parseTypeFilter(input.type || null)
  const includeAvatar = input.includeAvatar !== false
  const sort = (input.sort || 'lastContactTime_desc').trim()
  const offset = parseIntInRange(input.offset, 0, 0, 100000)
  const limit = parseIntInRange(input.limit, 100, 1, 500)

  const contactsResult = await chatService.getContacts()
  if (!contactsResult.success) {
    throw new ApiQueryError(
      503,
      'DB_NOT_CONNECTED',
      contactsResult.error || 'Failed to read contacts',
      'Please complete DB decrypt/setup in Settings and ensure data is available.'
    )
  }

  let contacts = (contactsResult.contacts || []) as Array<Record<string, any>>

  if (typeFilter) {
    contacts = contacts.filter((item) => typeFilter.has((item.type || 'other') as ContactType))
  }

  if (q) {
    contacts = contacts.filter((item) => {
      const username = String(item.username || '').toLowerCase()
      const displayName = String(item.displayName || '').toLowerCase()
      const remark = String(item.remark || '').toLowerCase()
      const nickname = String(item.nickname || '').toLowerCase()
      return (
        username.includes(q) ||
        displayName.includes(q) ||
        remark.includes(q) ||
        nickname.includes(q)
      )
    })
  }

  if (sort === 'name_asc') {
    contacts.sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || ''), 'zh-CN'))
  } else if (sort === 'name_desc') {
    contacts.sort((a, b) => String(b.displayName || '').localeCompare(String(a.displayName || ''), 'zh-CN'))
  } else if (sort === 'lastContactTime_asc') {
    contacts.sort((a, b) => Number((a as any).lastContactTime || 0) - Number((b as any).lastContactTime || 0))
  } else {
    contacts.sort((a, b) => Number((b as any).lastContactTime || 0) - Number((a as any).lastContactTime || 0))
  }

  const total = contacts.length
  const paged = contacts.slice(offset, offset + limit)
  const hasMore = offset + paged.length < total

  const finalContacts = paged.map((item) => {
    if (includeAvatar) return item
    const { avatarUrl, ...rest } = item
    return rest
  })

  return {
    total,
    offset,
    limit,
    hasMore,
    sort,
    filters: {
      q,
      type: typeFilter ? Array.from(typeFilter) : null,
      includeAvatar
    },
    contacts: finalContacts
  }
}
