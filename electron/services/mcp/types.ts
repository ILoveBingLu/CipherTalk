export const MCP_TOOL_NAMES = [
  'health_check',
  'get_status',
  'list_sessions',
  'get_messages',
  'list_contacts',
  'search_messages',
  'get_session_context',
  'get_global_statistics',
  'get_contact_rankings',
  'get_activity_distribution'
] as const

export const MCP_CONTACT_KINDS = [
  'friend',
  'group',
  'official',
  'former_friend',
  'other'
] as const

export const MCP_MESSAGE_KINDS = [
  'text',
  'image',
  'voice',
  'contact_card',
  'video',
  'emoji',
  'location',
  'voip',
  'system',
  'quote',
  'app_music',
  'app_link',
  'app_file',
  'app_chat_record',
  'app_mini_program',
  'app_quote',
  'app_pat',
  'app_announcement',
  'app_gift',
  'app_transfer',
  'app_red_packet',
  'app',
  'unknown'
] as const

export type McpToolName = (typeof MCP_TOOL_NAMES)[number]
export type McpContactKind = (typeof MCP_CONTACT_KINDS)[number]
export type McpMessageKind = (typeof MCP_MESSAGE_KINDS)[number]
export type McpSearchMatchMode = 'substring' | 'exact'

export type McpLaunchMode = 'dev' | 'packaged'
export type McpLauncherMode = 'dev-runner' | 'packaged-launcher' | 'direct'
export type McpSessionKind = 'friend' | 'group' | 'official' | 'other'
export type McpMessageMatchField = 'text' | 'raw'
export type McpSessionContextMode = 'latest' | 'around'

export interface McpLaunchConfig {
  command: string
  args: string[]
  cwd: string
  mode: McpLaunchMode
}

export type McpErrorCode =
  | 'BAD_REQUEST'
  | 'DB_NOT_READY'
  | 'SESSION_NOT_FOUND'
  | 'INTERNAL_ERROR'

export interface McpErrorShape {
  code: McpErrorCode
  message: string
  hint?: string
}

export interface McpHealthPayload {
  ok: boolean
  service: string
  version: string
  warnings: string[]
}

export interface McpStatusPayload {
  runtime: {
    pid: number
    platform: NodeJS.Platform
    appMode: McpLaunchMode
    launcherMode: McpLauncherMode
  }
  config: {
    mcpEnabled: boolean
    mcpExposeMediaPaths: boolean
    dbReady: boolean
  }
  capabilities: {
    tools: McpToolName[]
  }
  warnings: string[]
}

export interface McpSessionRef {
  sessionId: string
  displayName: string
  kind: McpSessionKind
}

export interface McpSessionItem extends McpSessionRef {
  lastMessagePreview: string
  unreadCount: number
  lastTimestamp: number
  lastTimestampMs: number
}

export interface McpSessionsPayload {
  items: McpSessionItem[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

export interface McpContactItem {
  contactId: string
  displayName: string
  remark?: string
  nickname?: string
  kind: McpContactKind
  lastContactTimestamp: number
  lastContactTimestampMs: number
}

export interface McpContactsPayload {
  items: McpContactItem[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

export interface McpCursor {
  sortSeq: number
  createTime: number
  localId: number
}

export interface McpMessageMedia {
  type: string
  localPath?: string | null
  md5?: string | null
  durationSeconds?: number | null
  fileName?: string | null
  fileSize?: number | null
  exists?: boolean | null
  isLivePhoto?: boolean | null
}

export interface McpMessageItem {
  messageId: number
  timestamp: number
  timestampMs: number
  direction: 'in' | 'out'
  kind: McpMessageKind
  text: string
  sender: {
    username: string | null
    isSelf: boolean
  }
  cursor: McpCursor
  media?: McpMessageMedia
  raw?: string
}

export interface McpMessagesPayload {
  items: McpMessageItem[]
  offset: number
  limit: number
  hasMore: boolean
}

export interface McpSearchHit {
  session: McpSessionRef
  message: McpMessageItem
  excerpt: string
  matchedField: McpMessageMatchField
  score: number
}

export interface McpSearchMessagesPayload {
  hits: McpSearchHit[]
  limit: number
  sessionsScanned: number
  messagesScanned: number
  truncated: boolean
}

export interface McpTimeRange {
  startTime?: number
  startTimeMs?: number
  endTime?: number
  endTimeMs?: number
}

export interface McpGlobalStatisticsPayload {
  totalMessages: number
  textMessages: number
  imageMessages: number
  voiceMessages: number
  videoMessages: number
  emojiMessages: number
  otherMessages: number
  sentMessages: number
  receivedMessages: number
  firstMessageTime: number | null
  firstMessageTimeMs: number | null
  lastMessageTime: number | null
  lastMessageTimeMs: number | null
  activeDays: number
  messageTypeCounts: Record<number, number>
  timeRange: McpTimeRange
}

export interface McpContactRankingItem {
  contactId: string
  displayName: string
  avatarUrl?: string
  messageCount: number
  sentCount: number
  receivedCount: number
  lastMessageTime: number | null
  lastMessageTimeMs: number | null
}

export interface McpContactRankingsPayload {
  items: McpContactRankingItem[]
  limit: number
  timeRange: McpTimeRange
}

export interface McpActivityDistributionPayload {
  hourlyDistribution: Record<number, number>
  weekdayDistribution: Record<number, number>
  monthlyDistribution: Record<string, number>
  timeRange: McpTimeRange
}

export interface McpSessionContextPayload {
  session: McpSessionRef
  mode: McpSessionContextMode
  anchor?: McpMessageItem
  items: McpMessageItem[]
  hasMoreBefore: boolean
  hasMoreAfter: boolean
}
