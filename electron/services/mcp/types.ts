export const MCP_TOOL_NAMES = [
  'health_check',
  'get_status',
  'get_moments_timeline',
  'resolve_session',
  'export_chat',
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
export type McpStreamEventType = 'meta' | 'progress' | 'partial' | 'complete' | 'error'
export type McpStreamProgressStage =
  | 'resolving_input'
  | 'searching_contacts'
  | 'searching_sessions'
  | 'resolving_candidates'
  | 'validating_export_request'
  | 'preparing_export'
  | 'scanning_messages'
  | 'exporting'
  | 'writing'
  | 'streaming_hits'
  | 'completed'
  | 'failed'

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
  | 'APP_NOT_RUNNING'
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

export interface McpMomentLivePhoto {
  url: string
  thumb: string
  md5?: string
  token?: string
  key?: string
  encIdx?: string
}

export interface McpMomentMedia {
  url: string
  thumb: string
  md5?: string
  token?: string
  key?: string
  thumbKey?: string
  encIdx?: string
  livePhoto?: McpMomentLivePhoto
  width?: number
  height?: number
}

export interface McpMomentShareInfo {
  title: string
  description: string
  contentUrl: string
  thumbUrl: string
  thumbKey?: string
  thumbToken?: string
  appName?: string
  type?: number
}

export interface McpMomentCommentEmoji {
  url: string
  md5: string
  width: number
  height: number
  encryptUrl?: string
  aesKey?: string
}

export interface McpMomentCommentImage {
  url: string
  token?: string
  key?: string
  encIdx?: string
  thumbUrl?: string
  thumbUrlToken?: string
  thumbKey?: string
  thumbEncIdx?: string
  width?: number
  height?: number
  heightPercentage?: number
  fileSize?: number
  minArea?: number
  mediaId?: string
  md5?: string
}

export interface McpMomentComment {
  id: string
  nickname: string
  content: string
  refCommentId: string
  refNickname?: string
  emojis?: McpMomentCommentEmoji[]
  images?: McpMomentCommentImage[]
}

export interface McpMomentItem {
  id: string
  username: string
  nickname: string
  avatarUrl?: string
  createTime: number
  createTimeMs: number
  contentDesc: string
  type?: number
  media: McpMomentMedia[]
  shareInfo?: McpMomentShareInfo
  likes: string[]
  comments: McpMomentComment[]
  rawXml?: string
}

export interface McpMomentsTimelinePayload {
  items: McpMomentItem[]
  offset: number
  limit: number
  hasMore: boolean
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

export interface McpResolvedSessionCandidate extends McpSessionRef {
  score: number
  confidence: 'high' | 'medium' | 'low'
  aliases: string[]
  evidence: string[]
}

export interface McpResolveSessionPayload {
  query: string
  resolved: boolean
  exact: boolean
  recommended?: McpResolvedSessionCandidate
  candidates: McpResolvedSessionCandidate[]
  suggestedNextAction: 'get_messages' | 'get_session_context' | 'search_messages' | 'list_contacts' | 'list_sessions'
  message: string
}

export type McpExportFormat = 'chatlab' | 'chatlab-jsonl' | 'json' | 'excel' | 'html'

export interface McpExportMediaOptions {
  exportAvatars: boolean
  exportImages: boolean
  exportVideos: boolean
  exportEmojis: boolean
  exportVoices: boolean
}

export type McpExportMissingField =
  | 'session'
  | 'dateRange'
  | 'format'
  | 'mediaOptions'
  | 'outputDir'

export interface McpExportDateRange {
  start: number
  end: number
}

export interface McpExportChatPayload {
  canExport: boolean
  validateOnly: boolean
  missingFields: McpExportMissingField[]
  nextQuestion?: string
  followUpQuestions?: Array<{
    field: McpExportMissingField
    question: string
  }>
  resolvedSession?: McpResolvedSessionCandidate
  candidates?: McpResolvedSessionCandidate[]
  outputDir?: string
  outputPath?: string
  format?: McpExportFormat
  dateRange?: McpExportDateRange
  mediaOptions?: McpExportMediaOptions
  success?: boolean
  successCount?: number
  failCount?: number
  error?: string
  message: string
}

export interface McpContactItem {
  contactId: string
  sessionId?: string
  hasSession?: boolean
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
    displayName?: string | null
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
  source?: 'index' | 'scan'
  indexStatus?: {
    ready: boolean
    indexedSessions: number
    indexedMessages: number
    error?: string
  }
  sessionSummaries?: Array<{
    session: McpSessionRef
    hitCount: number
    topScore: number
    sampleExcerpts: string[]
  }>
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

export interface McpStreamMetaPayload {
  toolName: McpToolName
  requestId?: string
  startedAt: number
}

export interface McpStreamProgressPayload {
  stage: McpStreamProgressStage
  message?: string
  sessionsScanned?: number
  messagesScanned?: number
  candidates?: Array<Pick<McpSessionRef, 'sessionId' | 'displayName' | 'kind'>>
  candidateCount?: number
  truncated?: boolean
}

export interface McpStreamPartialPayloadMap {
  resolve_session: Partial<McpResolveSessionPayload>
  export_chat: Partial<McpExportChatPayload>
  list_sessions: Partial<McpSessionsPayload>
  list_contacts: Partial<McpContactsPayload>
  get_messages: Partial<McpMessagesPayload>
  search_messages: Partial<McpSearchMessagesPayload>
  get_session_context: Partial<McpSessionContextPayload>
}

export type McpStreamPartialPayload =
  | McpStreamPartialPayloadMap['export_chat']
  | McpStreamPartialPayloadMap['list_sessions']
  | McpStreamPartialPayloadMap['list_contacts']
  | McpStreamPartialPayloadMap['get_messages']
  | McpStreamPartialPayloadMap['search_messages']
  | McpStreamPartialPayloadMap['get_session_context']

export interface McpStreamMetaEvent {
  event: 'meta'
  data: McpStreamMetaPayload
}

export interface McpStreamProgressEvent {
  event: 'progress'
  data: McpStreamProgressPayload
}

export interface McpStreamPartialEvent {
  event: 'partial'
  data: {
    toolName: McpToolName
    chunkIndex: number
    payload: McpStreamPartialPayload
  }
}

export interface McpStreamCompleteEvent {
  event: 'complete'
  data: {
    toolName: McpToolName
    summary: string
    payload: unknown
    completedAt: number
  }
}

export interface McpStreamErrorEvent {
  event: 'error'
  data: McpErrorShape & {
    toolName: McpToolName
    failedAt: number
  }
}

export type McpStreamEvent =
  | McpStreamMetaEvent
  | McpStreamProgressEvent
  | McpStreamPartialEvent
  | McpStreamCompleteEvent
  | McpStreamErrorEvent
