import { z } from 'zod'
import {
  MCP_CONTACT_KINDS,
  MCP_MESSAGE_KINDS,
  type McpContactItem,
  type McpContactsPayload,
  type McpMessageItem,
  type McpMessagesPayload,
  type McpMomentItem,
  type McpMomentsTimelinePayload,
  type McpResolveSessionPayload,
  type McpResolvedSessionCandidate,
  type McpSearchHit,
  type McpSearchMessagesPayload,
  type McpSessionContextPayload,
  type McpSessionsPayload,
  type McpToolName
} from './types'

const MCP_SESSION_KINDS = ['friend', 'group', 'official', 'other'] as const
const MCP_CONTEXT_MODES = ['latest', 'around'] as const
const MCP_MATCH_FIELDS = ['text', 'raw'] as const
const MCP_RESOLVE_NEXT_ACTIONS = ['get_messages', 'get_session_context', 'search_messages', 'list_contacts', 'list_sessions'] as const
const PREVIEW_LIMIT = 3
const PREVIEW_TEXT_LIMIT = 120

const cursorSchema = z.object({
  sortSeq: z.number(),
  createTime: z.number(),
  localId: z.number()
}).passthrough()

const messageMediaSchema = z.object({
  type: z.string(),
  localPath: z.string().nullable().optional(),
  md5: z.string().nullable().optional(),
  durationSeconds: z.number().nullable().optional(),
  fileName: z.string().nullable().optional(),
  fileSize: z.number().nullable().optional(),
  exists: z.boolean().nullable().optional(),
  isLivePhoto: z.boolean().nullable().optional()
}).passthrough()

const messageItemSchema = z.object({
  messageId: z.number(),
  timestamp: z.number(),
  timestampMs: z.number(),
  direction: z.enum(['in', 'out']),
  kind: z.enum(MCP_MESSAGE_KINDS),
  text: z.string(),
  sender: z.object({
    username: z.string().nullable(),
    isSelf: z.boolean()
  }).passthrough(),
  cursor: cursorSchema,
  media: messageMediaSchema.optional(),
  raw: z.string().optional()
}).passthrough()

const sessionRefSchema = z.object({
  sessionId: z.string(),
  displayName: z.string(),
  kind: z.enum(MCP_SESSION_KINDS)
}).passthrough()

const sessionItemSchema = sessionRefSchema.extend({
  lastMessagePreview: z.string(),
  unreadCount: z.number(),
  lastTimestamp: z.number(),
  lastTimestampMs: z.number()
}).passthrough()

const resolvedCandidateSchema = sessionRefSchema.extend({
  score: z.number(),
  confidence: z.enum(['high', 'medium', 'low']),
  aliases: z.array(z.string()),
  evidence: z.array(z.string())
}).passthrough()

const contactItemSchema = z.object({
  contactId: z.string(),
  sessionId: z.string().optional(),
  hasSession: z.boolean().optional(),
  displayName: z.string(),
  remark: z.string().optional(),
  nickname: z.string().optional(),
  kind: z.enum(MCP_CONTACT_KINDS),
  lastContactTimestamp: z.number(),
  lastContactTimestampMs: z.number()
}).passthrough()

const momentLivePhotoSchema = z.object({
  url: z.string(),
  thumb: z.string(),
  md5: z.string().optional(),
  token: z.string().optional(),
  key: z.string().optional(),
  encIdx: z.string().optional()
}).passthrough()

const momentMediaSchema = z.object({
  url: z.string(),
  thumb: z.string(),
  md5: z.string().optional(),
  token: z.string().optional(),
  key: z.string().optional(),
  thumbKey: z.string().optional(),
  encIdx: z.string().optional(),
  livePhoto: momentLivePhotoSchema.optional(),
  width: z.number().optional(),
  height: z.number().optional()
}).passthrough()

const momentShareInfoSchema = z.object({
  title: z.string(),
  description: z.string(),
  contentUrl: z.string(),
  thumbUrl: z.string(),
  thumbKey: z.string().optional(),
  thumbToken: z.string().optional(),
  appName: z.string().optional(),
  type: z.number().optional()
}).passthrough()

const momentCommentEmojiSchema = z.object({
  url: z.string(),
  md5: z.string(),
  width: z.number(),
  height: z.number(),
  encryptUrl: z.string().optional(),
  aesKey: z.string().optional()
}).passthrough()

const momentCommentImageSchema = z.object({
  url: z.string(),
  token: z.string().optional(),
  key: z.string().optional(),
  encIdx: z.string().optional(),
  thumbUrl: z.string().optional(),
  thumbUrlToken: z.string().optional(),
  thumbKey: z.string().optional(),
  thumbEncIdx: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  heightPercentage: z.number().optional(),
  fileSize: z.number().optional(),
  minArea: z.number().optional(),
  mediaId: z.string().optional(),
  md5: z.string().optional()
}).passthrough()

const momentCommentSchema = z.object({
  id: z.string(),
  nickname: z.string(),
  content: z.string(),
  refCommentId: z.string(),
  refNickname: z.string().optional(),
  emojis: z.array(momentCommentEmojiSchema).optional(),
  images: z.array(momentCommentImageSchema).optional()
}).passthrough()

const momentItemSchema = z.object({
  id: z.string(),
  username: z.string(),
  nickname: z.string(),
  avatarUrl: z.string().optional(),
  createTime: z.number(),
  createTimeMs: z.number(),
  contentDesc: z.string(),
  type: z.number().optional(),
  media: z.array(momentMediaSchema),
  shareInfo: momentShareInfoSchema.optional(),
  likes: z.array(z.string()),
  comments: z.array(momentCommentSchema),
  rawXml: z.string().optional()
}).passthrough()

const searchHitSchema = z.object({
  session: sessionRefSchema,
  message: messageItemSchema,
  excerpt: z.string(),
  matchedField: z.enum(MCP_MATCH_FIELDS),
  score: z.number()
}).passthrough()

const searchSessionSummarySchema = z.object({
  session: sessionRefSchema,
  hitCount: z.number(),
  topScore: z.number(),
  sampleExcerpts: z.array(z.string())
}).passthrough()

export const toolOutputSchemas = {
  list_contacts: z.object({
    items: z.array(contactItemSchema),
    total: z.number(),
    offset: z.number(),
    limit: z.number(),
    hasMore: z.boolean()
  }).passthrough(),
  list_sessions: z.object({
    items: z.array(sessionItemSchema),
    total: z.number(),
    offset: z.number(),
    limit: z.number(),
    hasMore: z.boolean()
  }).passthrough(),
  resolve_session: z.object({
    query: z.string(),
    resolved: z.boolean(),
    exact: z.boolean(),
    recommended: resolvedCandidateSchema.optional(),
    candidates: z.array(resolvedCandidateSchema),
    suggestedNextAction: z.enum(MCP_RESOLVE_NEXT_ACTIONS),
    message: z.string()
  }).passthrough(),
  get_messages: z.object({
    items: z.array(messageItemSchema),
    offset: z.number(),
    limit: z.number(),
    hasMore: z.boolean()
  }).passthrough(),
  search_messages: z.object({
    hits: z.array(searchHitSchema),
    limit: z.number(),
    sessionsScanned: z.number(),
    messagesScanned: z.number(),
    truncated: z.boolean(),
    sessionSummaries: z.array(searchSessionSummarySchema).optional()
  }).passthrough(),
  get_session_context: z.object({
    session: sessionRefSchema,
    mode: z.enum(MCP_CONTEXT_MODES),
    anchor: messageItemSchema.optional(),
    items: z.array(messageItemSchema),
    hasMoreBefore: z.boolean(),
    hasMoreAfter: z.boolean()
  }).passthrough(),
  get_moments_timeline: z.object({
    items: z.array(momentItemSchema),
    offset: z.number(),
    limit: z.number(),
    hasMore: z.boolean()
  }).passthrough()
} satisfies Partial<Record<McpToolName, z.ZodTypeAny>>

function compactText(value: string, fallback: string): string {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) {
    return fallback
  }

  if (normalized.length <= PREVIEW_TEXT_LIMIT) {
    return normalized
  }

  return `${normalized.slice(0, PREVIEW_TEXT_LIMIT - 1)}…`
}

function formatDateTime(timestampMs: number): string {
  if (!timestampMs) return 'unknown time'

  const date = new Date(timestampMs)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}

function previewLines(lines: string[]): string {
  return lines.length > 0 ? `\n${lines.join('\n')}` : ''
}

function formatMessageText(item: McpMessageItem): string {
  return compactText(item.text, item.media ? `kind=${item.kind}` : '无文本正文，仅媒体/系统消息')
}

function formatMomentText(item: McpMomentItem): string {
  if (item.contentDesc) {
    return compactText(item.contentDesc, `type=${item.type ?? 1}`)
  }

  if (item.shareInfo?.title) {
    return compactText(item.shareInfo.title, `type=${item.type ?? 1}`)
  }

  return item.media.length > 0 ? '无文本正文，仅图片/视频内容' : `type=${item.type ?? 1}`
}

function describeSender(item: McpMessageItem): string {
  if (item.sender.isSelf) return 'self'
  return item.sender.displayName || item.sender.username || 'unknown'
}

function buildContactsPreview(payload: McpContactsPayload): string {
  const summary = payload.total !== payload.items.length
    ? `Loaded ${payload.items.length} of ${payload.total} contacts.`
    : `Loaded ${payload.items.length} contacts.`
  const lines = payload.items.slice(0, PREVIEW_LIMIT).map((item, index) =>
    `${index + 1}. ${compactText(item.displayName || item.contactId, item.contactId)} | remark=${compactText(item.remark || '-', '-')} | contactId=${item.contactId} | hasSession=${item.hasSession ? 'yes' : 'no'}`
  )
  return `${summary}${previewLines(lines)}`
}

function buildSessionsPreview(payload: McpSessionsPayload): string {
  const summary = payload.total !== payload.items.length
    ? `Loaded ${payload.items.length} of ${payload.total} sessions.`
    : `Loaded ${payload.items.length} sessions.`
  const lines = payload.items.slice(0, PREVIEW_LIMIT).map((item, index) =>
    `${index + 1}. ${compactText(item.displayName || item.sessionId, item.sessionId)} | sessionId=${item.sessionId} | last=${compactText(item.lastMessagePreview, '暂无消息预览')}`
  )
  return `${summary}${previewLines(lines)}`
}

function buildResolvedCandidateLine(candidate: McpResolvedSessionCandidate, index: number): string {
  const evidence = compactText(candidate.evidence.join('; '), 'no evidence')
  return `${index + 1}. ${compactText(candidate.displayName || candidate.sessionId, candidate.sessionId)} | sessionId=${candidate.sessionId} | confidence=${candidate.confidence} | ${evidence}`
}

function buildResolveSessionPreview(payload: McpResolveSessionPayload): string {
  const summary = payload.resolved && payload.recommended
    ? `Resolved "${payload.query}" to ${payload.recommended.displayName}.`
    : `Found ${payload.candidates.length} candidates for "${payload.query}".`
  const lines = payload.candidates.slice(0, PREVIEW_LIMIT).map((candidate, index) => buildResolvedCandidateLine(candidate, index))
  return `${summary}${previewLines(lines)}`
}

function buildMessagesPreview(payload: McpMessagesPayload): string {
  const summary = `Loaded ${payload.items.length} messages.`
  const lines = payload.items.slice(0, PREVIEW_LIMIT).map((item, index) =>
    `${index + 1}. ${formatDateTime(item.timestampMs)} | ${item.direction} | ${describeSender(item)}: ${formatMessageText(item)}`
  )
  return `${summary}${previewLines(lines)}`
}

function buildSessionContextPreview(payload: McpSessionContextPayload): string {
  const summary = `Loaded ${payload.items.length} context messages for ${payload.session.displayName} (${payload.mode}).`
  const lines = payload.items.slice(0, PREVIEW_LIMIT).map((item, index) =>
    `${index + 1}. ${formatDateTime(item.timestampMs)} | ${item.direction} | ${describeSender(item)}: ${formatMessageText(item)}`
  )
  return `${summary}${previewLines(lines)}`
}

function buildSearchHitLine(hit: McpSearchHit, index: number): string {
  const excerpt = compactText(hit.excerpt || hit.message.text, hit.message.media ? `kind=${hit.message.kind}` : '无文本正文，仅媒体/系统消息')
  return `${index + 1}. ${compactText(hit.session.displayName || hit.session.sessionId, hit.session.sessionId)} | ${formatDateTime(hit.message.timestampMs)} | ${hit.matchedField}: ${excerpt}`
}

function buildSearchPreview(payload: McpSearchMessagesPayload): string {
  const summary = `Loaded ${payload.hits.length} message hits.`
  const lines = payload.hits.slice(0, PREVIEW_LIMIT).map((hit, index) => buildSearchHitLine(hit, index))
  return `${summary}${previewLines(lines)}`
}

function buildMomentsPreview(payload: McpMomentsTimelinePayload): string {
  const summary = `Loaded ${payload.items.length} moments posts.`
  const lines = payload.items.slice(0, PREVIEW_LIMIT).map((item, index) =>
    `${index + 1}. ${formatDateTime(item.createTimeMs)} | ${compactText(item.nickname || item.username, item.username)}(${item.username}) | ${formatMomentText(item)} | likes=${item.likes.length} comments=${item.comments.length}`
  )
  return `${summary}${previewLines(lines)}`
}

export function buildToolResultText(toolName: McpToolName, payload: unknown): string {
  switch (toolName) {
    case 'list_contacts':
      return buildContactsPreview(payload as McpContactsPayload)
    case 'list_sessions':
      return buildSessionsPreview(payload as McpSessionsPayload)
    case 'resolve_session':
      return buildResolveSessionPreview(payload as McpResolveSessionPayload)
    case 'get_messages':
      return buildMessagesPreview(payload as McpMessagesPayload)
    case 'search_messages':
      return buildSearchPreview(payload as McpSearchMessagesPayload)
    case 'get_session_context':
      return buildSessionContextPreview(payload as McpSessionContextPayload)
    case 'get_moments_timeline':
      return buildMomentsPreview(payload as McpMomentsTimelinePayload)
    default:
      return `Loaded ${toolName}.`
  }
}
