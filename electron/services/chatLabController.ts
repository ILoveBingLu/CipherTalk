import { groupAnalyticsService } from './groupAnalyticsService'
import { querySessions } from './httpApiFacade'
import { chatService, type ChatLabSourceMessage, type ChatRecordItem as SourceChatRecordItem } from './chatService'
import { ConfigService } from './config'
import type {
  ChatLabHeader,
  ChatLabMember,
  ChatLabMessage,
  ChatLabMeta,
  ChatRecordItem as ChatLabChatRecord
} from './exportService'

type ChatLabSessionType = 'group' | 'private'

type SessionDetailInfo = {
  displayName: string
  avatarUrl?: string
}

type SelfInfo = {
  nickName: string
  avatarUrl?: string
}

export interface ChatLabSessionItem {
  id: string
  name: string
  platform: 'wechat'
  type: ChatLabSessionType
  memberCount?: number
  lastMessageAt?: number
}

export interface ChatLabSync {
  hasMore: boolean
  nextSince: number
  nextOffset: number
  watermark: number
}

export interface ChatLabPullPayload {
  chatlab: ChatLabHeader
  meta?: ChatLabMeta
  members?: ChatLabMember[]
  messages: ChatLabMessage[]
  sync: ChatLabSync
}

interface ChatLabSessionsResponse {
  sessions: ChatLabSessionItem[]
}

type ChatLabResolvedRoute =
  | { resource: 'sessions' }
  | { resource: 'messages'; sessionId: string }
  | { resource: 'unknown' }

type ChatLabMessageQuery = {
  since: number
  end?: number
  limit: number
  offset: number
}

type ChatLabSessionCacheEntry = {
  expiresAt: number
  payload: ChatLabSessionsResponse
}

type ChatLabSnapshotCacheEntry = {
  hash: string
  meta: ChatLabMeta
  members: ChatLabMember[]
}

type ParticipantInfo = {
  accountName: string
  avatar?: string
}

const CHATLAB_VERSION = '0.0.2'
const CHATLAB_GENERATOR = 'CipherTalk'
const SESSIONS_CACHE_TTL_MS = 4000

const MESSAGE_TYPE_MAP: Record<number, number> = {
  1: 0,
  3: 1,
  34: 2,
  43: 3,
  49: 7,
  47: 5,
  48: 8,
  42: 27,
  50: 23,
  10000: 80
}

export class ChatLabControllerError extends Error {
  statusCode: number
  code: string

  constructor(statusCode: number, code: string, message: string) {
    super(message)
    this.name = 'ChatLabControllerError'
    this.statusCode = statusCode
    this.code = code
  }

  toResponse() {
    return {
      error: {
        code: this.code,
        message: this.message
      }
    }
  }
}

class ChatLabController {
  private readonly sessionsCache = new Map<string, ChatLabSessionCacheEntry>()
  private readonly sessionSnapshotCache = new Map<string, ChatLabSnapshotCacheEntry>()

  resolveChatLabResource(pathname: string): ChatLabResolvedRoute {
    if (!pathname.startsWith('/chatlab')) {
      return { resource: 'unknown' }
    }

    const tail = pathname.replace(/^\/chatlab/i, '')
    const segments = tail
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean)

    if (segments.length === 0 || segments.every((segment) => this.isVersionPrefixSegment(segment))) {
      return { resource: 'sessions' }
    }

    const sessionsIndex = segments.lastIndexOf('sessions')
    if (sessionsIndex === -1) {
      return { resource: 'unknown' }
    }

    const resourceSegments = segments.slice(sessionsIndex)
    if (resourceSegments.length === 1) {
      return { resource: 'sessions' }
    }

    if (resourceSegments.length === 3 && resourceSegments[2] === 'messages') {
      return {
        resource: 'messages',
        sessionId: decodeURIComponent(resourceSegments[1])
      }
    }

    return { resource: 'unknown' }
  }

  async getSessions(searchParams: URLSearchParams): Promise<ChatLabSessionsResponse> {
    const keyword = (searchParams.get('keyword') || '').trim()
    const limitValue = searchParams.get('limit')
    const limit = limitValue ? this.parseIntInRange(limitValue, 100, 1, 500) : null
    const cacheKey = `${keyword}::${limit ?? 'all'}`
    const now = Date.now()
    const cached = this.sessionsCache.get(cacheKey)

    if (cached && cached.expiresAt > now) {
      return cached.payload
    }

    const sessions = await this.loadSessions(keyword, limit)
    const payload = { sessions }

    this.sessionsCache.set(cacheKey, {
      expiresAt: now + SESSIONS_CACHE_TTL_MS,
      payload
    })

    return payload
  }

  async getMessages(sessionId: string, searchParams: URLSearchParams): Promise<ChatLabPullPayload> {
    const query = this.parseSinceEndLimitOffset(searchParams)
    const requestStartedAt = Math.floor(Date.now() / 1000)
    const snapshotWatermark = query.end ? Math.min(query.end, requestStartedAt) : requestStartedAt
    const sessionType: ChatLabSessionType = sessionId.includes('@chatroom') ? 'group' : 'private'
    const identity = await this.getRuntimeIdentity()

    const sourceResult = await chatService.getMessagesForChatLab(sessionId, {
      startTime: query.since > 0 ? query.since : undefined,
      endTime: query.end,
      watermark: snapshotWatermark,
      limit: query.limit,
      offset: query.offset
    })

    if (!sourceResult.success) {
      throw new ChatLabControllerError(503, 'DB_NOT_CONNECTED', sourceResult.error || 'Failed to read session messages')
    }

    const sessionDetailResult = await chatService.getSessionDetail(sessionId)
    if (!sessionDetailResult.success || !sessionDetailResult.detail) {
      throw new ChatLabControllerError(404, 'SESSION_NOT_FOUND', sessionDetailResult.error || 'Session not found')
    }

    const sessionDetail = sessionDetailResult.detail
    const previousSnapshot = this.sessionSnapshotCache.get(sessionId)
    const members = await this.buildChatLabMembers(
      sessionId,
      sessionType,
      sourceResult.messages || [],
      identity.ownerId,
      identity.cleanedOwnerId,
      identity.selfInfo,
      sessionDetail,
      query.since > 0 ? previousSnapshot?.members : undefined
    )

    const messages = await this.buildChatLabMessages(
      sessionId,
      sessionType,
      sourceResult.messages || [],
      identity.ownerId,
      identity.cleanedOwnerId,
      sessionDetail.displayName,
      members,
      identity.selfInfo
    )

    const meta = this.buildChatLabMeta(
      sessionId,
      sessionDetail.displayName,
      sessionType,
      identity.ownerId,
      sessionDetail.avatarUrl
    )
    const snapshot = this.buildSnapshotEntry(meta, Array.from(members.values()))
    const includeMetaAndMembers = query.since <= 0 || !previousSnapshot || previousSnapshot.hash !== snapshot.hash

    if (query.since <= 0 || includeMetaAndMembers) {
      this.sessionSnapshotCache.set(sessionId, snapshot)
    }

    return {
      chatlab: {
        version: CHATLAB_VERSION,
        exportedAt: requestStartedAt,
        generator: CHATLAB_GENERATOR
      },
      ...(includeMetaAndMembers ? { meta: snapshot.meta } : {}),
      ...(includeMetaAndMembers ? { members: snapshot.members } : {}),
      messages,
      sync: this.buildSyncBlock(query.since, query.offset, messages.length, Boolean(sourceResult.hasMore), snapshotWatermark)
    }
  }

  private async loadSessions(keyword: string, limit: number | null): Promise<ChatLabSessionItem[]> {
    if (limit !== null) {
      const result = await querySessions({
        q: keyword,
        offset: 0,
        limit
      })
      return this.buildChatLabSessions(result.sessions || [])
    }

    const sessions: any[] = []
    let offset = 0
    const pageSize = 500

    while (true) {
      const result = await querySessions({
        q: keyword,
        offset,
        limit: pageSize
      })

      sessions.push(...(result.sessions || []))
      if (!result.hasMore) {
        break
      }

      offset += result.sessions?.length || 0
      if (!result.sessions?.length) {
        break
      }
    }

    return this.buildChatLabSessions(sessions)
  }

  private async buildChatLabSessions(baseSessions: any[]): Promise<ChatLabSessionItem[]> {
    const hasGroups = baseSessions.some((session) => session.sessionType === 'group')
    const groupInfoMap = hasGroups ? await this.loadGroupInfoMap() : new Map<string, { memberCount: number }>()

    return baseSessions.map((session) => {
      const sessionType: ChatLabSessionType = session.sessionType === 'group' ? 'group' : 'private'
      const groupInfo = groupInfoMap.get(session.username)

      return {
        id: session.username,
        name: session.displayName || session.username,
        platform: 'wechat',
        type: sessionType,
        memberCount: sessionType === 'group' ? groupInfo?.memberCount : 2,
        lastMessageAt: this.toUnixSeconds(session.lastTimestamp || session.sortTimestamp || 0)
      }
    })
  }

  private async loadGroupInfoMap(): Promise<Map<string, { memberCount: number }>> {
    const result = await groupAnalyticsService.getGroupChats()
    const map = new Map<string, { memberCount: number }>()

    if (!result.success || !result.data) {
      return map
    }

    for (const group of result.data) {
      map.set(group.username, {
        memberCount: Number(group.memberCount || 0)
      })
    }

    return map
  }

  private parseSinceEndLimitOffset(searchParams: URLSearchParams): ChatLabMessageQuery {
    const format = (searchParams.get('format') || '').trim().toLowerCase()
    if (format !== 'chatlab') {
      throw new ChatLabControllerError(400, 'BAD_REQUEST', 'Query parameter format=chatlab is required')
    }

    const sinceValue = searchParams.get('since')
    const endValue = searchParams.get('end')
    const limitValue = searchParams.get('limit')
    const offsetValue = searchParams.get('offset')

    const since = sinceValue ? this.parseIntInRange(sinceValue, 0, 0, Number.MAX_SAFE_INTEGER) : 0
    const parsedEnd = endValue ? this.parseIntInRange(endValue, 0, 0, Number.MAX_SAFE_INTEGER) : undefined
    const end = parsedEnd && parsedEnd > 0 ? parsedEnd : undefined
    const limit = limitValue ? this.parseIntInRange(limitValue, 100, 1, 500) : 100
    const offset = offsetValue ? this.parseIntInRange(offsetValue, 0, 0, 1000000) : 0

    if (end && since > 0 && end < since) {
      throw new ChatLabControllerError(400, 'BAD_REQUEST', 'Query parameter end must be greater than or equal to since')
    }

    return { since, end, limit, offset }
  }

  private buildChatLabMeta(
    sessionId: string,
    sessionName: string,
    sessionType: ChatLabSessionType,
    ownerId: string,
    sessionAvatar?: string
  ): ChatLabMeta {
    return this.normalizeMeta({
      name: sessionName || sessionId,
      platform: 'wechat',
      type: sessionType,
      ...(sessionType === 'group' ? { groupId: sessionId } : {}),
      ...(sessionType === 'group' && sessionAvatar ? { groupAvatar: sessionAvatar } : {}),
      ...(ownerId ? { ownerId } : {})
    })
  }

  private async buildChatLabMembers(
    sessionId: string,
    sessionType: ChatLabSessionType,
    messages: ChatLabSourceMessage[],
    ownerId: string,
    cleanedOwnerId: string,
    selfInfo: SelfInfo,
    sessionDetail: SessionDetailInfo,
    cachedMembers?: ChatLabMember[]
  ): Promise<Map<string, ChatLabMember>> {
    const members = new Map<string, ChatLabMember>()
    const participantCache = new Map<string, ParticipantInfo>()
    const cachedMemberMap = this.buildMemberMap(cachedMembers)

    if (sessionType === 'group') {
      const groupMembersResult = await groupAnalyticsService.getGroupMembers(sessionId)
      if (groupMembersResult.success && groupMembersResult.data && groupMembersResult.data.length > 0) {
        for (const member of groupMembersResult.data) {
          this.mergeMember(members, {
            platformId: member.username,
            accountName: member.displayName || member.username,
            avatar: member.avatarUrl
          })
        }
        this.overlayKnownMemberDetails(members, cachedMemberMap)
      } else if (cachedMemberMap.size > 0) {
        this.cloneMembersInto(members, cachedMemberMap)
      }
    } else {
      if (ownerId) {
        this.mergeMember(members, {
          platformId: ownerId,
          accountName: selfInfo.nickName || ownerId,
          avatar: selfInfo.avatarUrl
        })
      }

      this.mergeMember(members, {
        platformId: sessionId,
        accountName: sessionDetail.displayName || sessionId,
        avatar: sessionDetail.avatarUrl
      })
      this.overlayKnownMemberDetails(members, cachedMemberMap)
    }

    for (const message of messages) {
      const groupNickname = sessionType === 'group' ? this.extractGroupNickname(message.rawContent) : undefined
      const sender = this.resolveSenderId(message, sessionId, ownerId, cleanedOwnerId)
      const participant = await this.resolveParticipantInfo(sender, ownerId, selfInfo, participantCache)
      this.mergeMember(members, {
        platformId: sender,
        accountName: participant.accountName,
        avatar: participant.avatar,
        groupNickname
      })
    }

    return members
  }

  private async buildChatLabMessages(
    sessionId: string,
    sessionType: ChatLabSessionType,
    sourceMessages: ChatLabSourceMessage[],
    ownerId: string,
    cleanedOwnerId: string,
    sessionName: string,
    members: Map<string, ChatLabMember>,
    selfInfo: SelfInfo
  ): Promise<ChatLabMessage[]> {
    const messages: ChatLabMessage[] = []
    const participantCache = new Map<string, ParticipantInfo>()

    for (const source of sourceMessages) {
      const sender = this.resolveSenderId(source, sessionId, ownerId, cleanedOwnerId)
      const groupNickname = sessionType === 'group' ? this.extractGroupNickname(source.rawContent) : undefined
      const knownMember = members.get(sender)
      const participant = knownMember
        ? { accountName: knownMember.accountName, avatar: knownMember.avatar }
        : await this.resolveParticipantInfo(sender, ownerId, selfInfo, participantCache)

      this.mergeMember(members, {
        platformId: sender,
        accountName: participant.accountName,
        avatar: participant.avatar,
        groupNickname
      })

      const chatRecords = this.buildChatRecords(source.chatRecordList, source.createTime)
      messages.push({
        sender,
        accountName: participant.accountName || sessionName || sender,
        ...(groupNickname ? { groupNickname } : {}),
        timestamp: this.toUnixSeconds(source.createTime),
        type: this.convertMessageType(source.localType, source.rawContent),
        content: source.parsedContent?.trim() ? source.parsedContent : null,
        ...(this.getPlatformMessageId(source) ? { platformMessageId: this.getPlatformMessageId(source) } : {}),
        ...(this.extractReplyToMessageId(source.rawContent) ? { replyToMessageId: this.extractReplyToMessageId(source.rawContent)! } : {}),
        ...(chatRecords ? { chatRecords } : {})
      })
    }

    return messages
  }

  private buildChatRecords(chatRecordList?: SourceChatRecordItem[], fallbackCreateTime?: number): ChatLabChatRecord[] | undefined {
    if (!chatRecordList?.length) {
      return undefined
    }

    const fallbackTimestamp = this.toUnixSeconds(fallbackCreateTime || 0)
    const chatRecords = chatRecordList.map((record) => {
      let recordType = 0
      let content = record.datadesc || record.datatitle || ''

      switch (record.datatype) {
        case 1:
          recordType = 0
          break
        case 3:
          recordType = 1
          content = '[图片]'
          break
        case 8:
        case 49:
          recordType = 4
          content = record.datatitle ? `[文件] ${record.datatitle}` : '[文件]'
          break
        case 34:
          recordType = 2
          content = '[语音消息]'
          break
        case 43:
          recordType = 3
          content = '[视频]'
          break
        case 47:
          recordType = 5
          content = '[动画表情]'
          break
        default:
          recordType = 0
          content = record.datadesc || record.datatitle || '[消息]'
      }

      return {
        sender: record.sourcename || 'unknown',
        accountName: record.sourcename || 'unknown',
        timestamp: this.parseChatRecordTimestamp(record.sourcetime, fallbackTimestamp),
        type: recordType,
        content,
        ...(record.sourceheadurl ? { avatar: record.sourceheadurl } : {})
      }
    })

    return chatRecords.length > 0 ? chatRecords : undefined
  }

  private buildSyncBlock(
    since: number,
    offset: number,
    returnedCount: number,
    hasMore: boolean,
    watermark: number
  ): ChatLabSync {
    return {
      hasMore,
      nextSince: hasMore ? since : watermark,
      nextOffset: hasMore ? offset + returnedCount : 0,
      watermark
    }
  }

  private async resolveParticipantInfo(
    username: string,
    ownerId: string,
    selfInfo: SelfInfo,
    cache: Map<string, ParticipantInfo>
  ): Promise<ParticipantInfo> {
    const cached = cache.get(username)
    if (cached) {
      return cached
    }

    if (username && ownerId && username === ownerId) {
      const result = {
        accountName: selfInfo.nickName || ownerId,
        avatar: selfInfo.avatarUrl
      }
      cache.set(username, result)
      return result
    }

    const avatarInfo = await chatService.getContactAvatar(username)
    if (avatarInfo) {
      const result = {
        accountName: avatarInfo.displayName || username || '未知成员',
        avatar: avatarInfo.avatarUrl
      }
      cache.set(username, result)
      return result
    }

    const contact = await chatService.getContact(username)
    if (contact) {
      const result = {
        accountName: contact.remark || contact.nickName || contact.alias || username
      }
      cache.set(username, result)
      return result
    }

    const result = {
      accountName: username || '未知成员'
    }
    cache.set(username, result)
    return result
  }

  private resolveSenderId(
    message: ChatLabSourceMessage,
    sessionId: string,
    ownerId: string,
    cleanedOwnerId: string
  ): string {
    const sender = message.senderUsername || ''
    if (message.isSend === 1) return ownerId || sender || sessionId
    if (ownerId && sender === ownerId) return ownerId
    if (cleanedOwnerId && sender === cleanedOwnerId) return ownerId || cleanedOwnerId
    return sender || sessionId
  }

  private getPlatformMessageId(message: ChatLabSourceMessage): string | undefined {
    if (message.serverId) return String(message.serverId)
    if (message.localId) return String(message.localId)
    return undefined
  }

  private extractReplyToMessageId(content: string): string | undefined {
    if (!content || !content.includes('<type>57</type>')) {
      return undefined
    }

    const svridMatch = /<svrid>(\d+)<\/svrid>/i.exec(content)
    return svridMatch?.[1]
  }

  private convertMessageType(localType: number, content: string): number {
    const xmlTypeMatch = /<type>(\d+)<\/type>/i.exec(content)
    const xmlType = xmlTypeMatch ? Number.parseInt(xmlTypeMatch[1], 10) : null

    if (localType === 49 || xmlType) {
      switch (xmlType) {
        case 6:
          return 4
        case 19:
          return 7
        case 33:
        case 36:
          return 24
        case 57:
          return 25
        case 2000:
          return 99
        case 5:
        case 49:
          return 7
        default:
          if (xmlType) return 7
      }
    }

    return MESSAGE_TYPE_MAP[localType] ?? 99
  }

  private extractGroupNickname(content: string): string | undefined {
    const msgSourceMatch = /<msgsource>[\s\S]*?<\/msgsource>/i.exec(content)
    if (!msgSourceMatch) {
      return undefined
    }

    const displayNameMatch = /<displayname>([^<]+)<\/displayname>/i.exec(msgSourceMatch[0])
    return displayNameMatch?.[1]
  }

  private mergeMember(target: Map<string, ChatLabMember>, member: ChatLabMember) {
    if (!member.platformId) return

    const normalized = this.normalizeMember(member)
    const existing = target.get(normalized.platformId)
    if (!existing) {
      target.set(normalized.platformId, normalized)
      return
    }

    target.set(normalized.platformId, {
      ...existing,
      accountName: existing.accountName && existing.accountName !== existing.platformId
        ? existing.accountName
        : (normalized.accountName || existing.accountName),
      groupNickname: existing.groupNickname || normalized.groupNickname,
      avatar: existing.avatar || normalized.avatar,
      ...(existing.roles?.length || normalized.roles?.length
        ? { roles: existing.roles?.length ? existing.roles : normalized.roles }
        : {})
    })
  }

  private buildMemberMap(members?: ChatLabMember[]): Map<string, ChatLabMember> {
    const map = new Map<string, ChatLabMember>()
    for (const member of members || []) {
      if (member.platformId) {
        map.set(member.platformId, this.normalizeMember(member))
      }
    }
    return map
  }

  private cloneMembersInto(target: Map<string, ChatLabMember>, source: Map<string, ChatLabMember>) {
    for (const member of source.values()) {
      this.mergeMember(target, member)
    }
  }

  private overlayKnownMemberDetails(target: Map<string, ChatLabMember>, cachedMembers: Map<string, ChatLabMember>) {
    for (const [platformId, cachedMember] of cachedMembers.entries()) {
      if (target.has(platformId)) {
        this.mergeMember(target, cachedMember)
      }
    }
  }

  private buildSnapshotEntry(meta: ChatLabMeta, members: ChatLabMember[]): ChatLabSnapshotCacheEntry {
    const normalizedMeta = this.normalizeMeta(meta)
    const normalizedMembers = members
      .map((member) => this.normalizeMember(member))
      .sort((a, b) => a.platformId.localeCompare(b.platformId))
    const hash = JSON.stringify({
      meta: normalizedMeta,
      members: normalizedMembers
    })

    return {
      hash,
      meta: normalizedMeta,
      members: normalizedMembers
    }
  }

  private normalizeMeta(meta: ChatLabMeta): ChatLabMeta {
    return {
      name: meta.name || '',
      platform: meta.platform || 'wechat',
      type: meta.type === 'group' ? 'group' : 'private',
      ...(meta.groupId ? { groupId: meta.groupId } : {}),
      ...(meta.groupAvatar ? { groupAvatar: meta.groupAvatar } : {}),
      ...(meta.ownerId ? { ownerId: meta.ownerId } : {})
    }
  }

  private normalizeMember(member: ChatLabMember): ChatLabMember {
    return {
      platformId: member.platformId,
      accountName: member.accountName || member.platformId,
      ...(member.groupNickname ? { groupNickname: member.groupNickname } : {}),
      ...(member.avatar ? { avatar: member.avatar } : {}),
      ...(member.roles?.length ? { roles: member.roles } : {})
    }
  }

  private parseChatRecordTimestamp(value: string | undefined, fallbackTimestamp: number): number {
    if (!value) {
      return fallbackTimestamp
    }

    try {
      const timeParts = value.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
      if (!timeParts) {
        return fallbackTimestamp
      }

      const date = new Date(
        Number.parseInt(timeParts[1], 10),
        Number.parseInt(timeParts[2], 10) - 1,
        Number.parseInt(timeParts[3], 10),
        Number.parseInt(timeParts[4], 10),
        Number.parseInt(timeParts[5], 10),
        Number.parseInt(timeParts[6], 10)
      )
      const timestamp = Math.floor(date.getTime() / 1000)
      return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallbackTimestamp
    } catch {
      return fallbackTimestamp
    }
  }

  private async getRuntimeIdentity(): Promise<{
    ownerId: string
    cleanedOwnerId: string
    selfInfo: SelfInfo
  }> {
    const configService = new ConfigService()
    const ownerId = String(configService.get('myWxid') || '').trim()
    configService.close()

    const cleanedOwnerId = this.cleanAccountDirName(ownerId)
    const selfInfoResult = await chatService.getMyUserInfo()
    const selfInfo = selfInfoResult.success && selfInfoResult.userInfo
      ? {
          nickName: selfInfoResult.userInfo.nickName || selfInfoResult.userInfo.alias || ownerId || '我',
          avatarUrl: selfInfoResult.userInfo.avatarUrl || undefined
        }
      : {
          nickName: ownerId || '我',
          avatarUrl: undefined
        }

    return {
      ownerId: ownerId || cleanedOwnerId,
      cleanedOwnerId,
      selfInfo
    }
  }

  private cleanAccountDirName(dirName: string): string {
    const trimmed = dirName.trim()
    if (!trimmed) return trimmed

    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[a-zA-Z0-9]+)/i)
      if (match) return match[1]
      return trimmed
    }

    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
    if (suffixMatch) return suffixMatch[1]

    return trimmed
  }

  private isVersionPrefixSegment(segment: string): boolean {
    return segment === 'api' || segment === 'openapi' || /^v\d+$/i.test(segment)
  }

  private parseIntInRange(value: string, defaultValue: number, min: number, max: number): number {
    const parsed = Number.parseInt(value, 10)
    if (!Number.isFinite(parsed)) return defaultValue
    return Math.max(min, Math.min(max, parsed))
  }

  private toUnixSeconds(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0
    return value >= 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value)
  }
}

export const chatLabController = new ChatLabController()
