/**
 * 消息格式化、去重、转换工具
 */
import type { McpCursor, McpMessageItem, McpMessageKind } from '../../../mcp/types'
import type { Message } from '../../../chatService'
import type { SummaryEvidenceRef } from '../../types/analysis'
import type { RetrievalExpandedEvidence } from '../../../retrieval/retrievalTypes'
import { MAX_MESSAGE_TEXT } from '../types'
import { compactText } from './text'
import { formatTime, toTimestampMs } from './time'

/**
 * 检测消息类型
 */
export function detectQaMessageKind(message: Pick<Message, 'localType' | 'rawContent' | 'parsedContent'>): McpMessageKind {
  const localType = Number(message.localType || 0)
  const raw = String(message.rawContent || message.parsedContent || '')
  const appTypeMatch = raw.match(/<type>(\d+)<\/type>/)
  const appMsgType = appTypeMatch?.[1]

  if (localType === 1) return 'text'
  if (localType === 3) return 'image'
  if (localType === 34) return 'voice'
  if (localType === 42) return 'contact_card'
  if (localType === 43) return 'video'
  if (localType === 47) return 'emoji'
  if (localType === 48) return 'location'
  if (localType === 50) return 'voip'
  if (localType === 10000 || localType === 10002) return 'system'
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

/**
 * 将业务 Message 转换为 MCP McpMessageItem
 */
export function messageToMcpItem(sessionId: string, message: Message, contactMap?: Map<string, string>): McpMessageItem {
  const direction = Number(message.isSend) === 1 ? 'out' : 'in'
  const senderUsername = message.senderUsername || ''
  const fallbackUsername = senderUsername || (sessionId.includes('@chatroom') ? '' : sessionId)
  const displayName = direction === 'out'
    ? '我'
    : contactMap?.get(fallbackUsername) || fallbackUsername || null

  return {
    messageId: Number(message.localId || message.serverId || 0),
    timestamp: Number(message.createTime || 0),
    timestampMs: toTimestampMs(Number(message.createTime || 0)),
    direction,
    kind: detectQaMessageKind(message),
    text: String(message.parsedContent || message.rawContent || ''),
    sender: {
      username: message.senderUsername ?? null,
      displayName,
      isSelf: direction === 'out'
    },
    cursor: {
      localId: Number(message.localId || 0),
      createTime: Number(message.createTime || 0),
      sortSeq: Number(message.sortSeq || 0)
    }
  }
}

/**
 * 将证据引用转换为 McpMessageItem
 */
export function evidenceRefToMcpItem(ref: SummaryEvidenceRef | RetrievalExpandedEvidence['ref'], contactMap?: Map<string, string>): McpMessageItem {
  const createTime = Number(ref.createTime || 0)
  const senderUsername = 'senderUsername' in ref ? ref.senderUsername : undefined
  const fallbackUsername = senderUsername || (!ref.sessionId.includes('@chatroom') ? ref.sessionId : '')
  const existingDisplayName = 'senderDisplayName' in ref ? ref.senderDisplayName : undefined
  const displayName = existingDisplayName || (fallbackUsername ? contactMap?.get(fallbackUsername) || fallbackUsername : null)
  const previewText = 'previewText' in ref ? ref.previewText : ('excerpt' in ref ? ref.excerpt : '')
  return {
    messageId: Number(ref.localId || 0),
    timestamp: createTime,
    timestampMs: toTimestampMs(createTime),
    direction: 'in',
    kind: 'text',
    text: String(previewText || ''),
    sender: {
      username: senderUsername || null,
      displayName,
      isSelf: false
    },
    cursor: {
      localId: Number(ref.localId || 0),
      createTime,
      sortSeq: Number(ref.sortSeq || 0)
    }
  }
}

/**
 * 获取发送者描述文字
 */
export function describeSender(message: McpMessageItem): string {
  if (message.sender.isSelf) return '我'
  return message.sender.displayName || message.sender.username || '对方'
}

/**
 * 格式化单条消息为文本行
 */
export function formatMessageLine(message: McpMessageItem): string {
  const text = compactText(message.text, MAX_MESSAGE_TEXT) || `[${message.kind}]`
  return `- ${formatTime(message.timestampMs)} | ${describeSender(message)} | ${text}`
}

/**
 * 构建证据引用对象
 */
export function toEvidenceRef(sessionId: string, message: McpMessageItem, preview?: string): SummaryEvidenceRef | null {
  if (!message.cursor) return null

  return {
    sessionId,
    localId: message.cursor.localId,
    createTime: message.cursor.createTime,
    sortSeq: message.cursor.sortSeq,
    senderUsername: message.sender.username || undefined,
    senderDisplayName: describeSender(message),
    previewText: compactText(preview || message.text, 180) || `[${message.kind}]`
  }
}

/**
 * 去重证据引用
 */
export function dedupeEvidenceRefs(items: SummaryEvidenceRef[]): SummaryEvidenceRef[] {
  const seen = new Set<string>()
  const result: SummaryEvidenceRef[] = []

  for (const item of items) {
    const key = `${item.localId}:${item.createTime}:${item.sortSeq}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
    if (result.length >= 8) break
  }

  return result
}

/**
 * 获取消息的 cursor 唯一键
 */
export function getMessageCursorKey(message: McpMessageItem): string {
  return `${message.cursor.localId}:${message.cursor.createTime}:${message.cursor.sortSeq}`
}

/**
 * 按 cursor 去重消息并排序
 */
export function dedupeMessagesByCursor(messages: McpMessageItem[]): McpMessageItem[] {
  const seen = new Set<string>()
  const result: McpMessageItem[] = []

  for (const message of messages) {
    const key = getMessageCursorKey(message)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(message)
  }

  return result.sort((a, b) => {
    if (a.cursor.sortSeq !== b.cursor.sortSeq) return a.cursor.sortSeq - b.cursor.sortSeq
    if (a.cursor.createTime !== b.cursor.createTime) return a.cursor.createTime - b.cursor.createTime
    return a.cursor.localId - b.cursor.localId
  })
}

/**
 * 格式化 cursor 为紧凑 JSON
 */
export function formatCursor(cursor: McpCursor): string {
  return `{"localId":${cursor.localId},"createTime":${cursor.createTime},"sortSeq":${cursor.sortSeq}}`
}

/**
 * 判断参与者是否匹配查询
 */
export function participantMatches(query: string, message: McpMessageItem): boolean {
  const normalized = query.toLowerCase()
  if (!normalized) return false
  return [
    message.sender.displayName || '',
    message.sender.username || '',
    message.sender.isSelf ? '我' : ''
  ].some((value) => {
    const candidate = value.toLowerCase()
    return Boolean(candidate) && (candidate.includes(normalized) || normalized.includes(candidate))
  })
}
