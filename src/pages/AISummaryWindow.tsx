import { useState, useEffect, useRef } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUp,
  Atom,
  Bot,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  Download,
  FileText,
  Image as ImageIcon,
  LayoutDashboard,
  ListTodo,
  Loader2,
  LoaderPinwheel,
  MessageCircle,
  Mic,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Smile,
  Trash2,
  User,
  Video,
  X,
  type LucideIcon
} from 'lucide-react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  TIME_RANGE_OPTIONS,
  type SessionQAConversationDetail,
  type SessionQAConversationSummary,
  type SessionQAHistoryMessage,
  type SessionQAJobEvent,
  type SessionQAMessageRecord,
  type SessionQAProgressEvent,
  type SessionQAResult,
  type SessionQATimelineItem,
  type SessionProfileMemoryState,
  type SummaryEvidenceRef,
  type SummaryResult,
  type SummaryStructuredAnalysis
} from '../types/ai'
import type { Message } from '../types/models'
import { usePlatformInfo } from '../hooks/usePlatformInfo'
import AIProviderLogo from '../components/ai/AIProviderLogo'
import MessageContent from '../components/MessageContent'
import './AISummaryWindow.scss'

type ResultTabId =
  | 'overview'
  | 'decisions'
  | 'todos'
  | 'risks'
  | 'events'
  | 'questions'
  | 'markdown'

type WorkspaceMode = 'summary' | 'ask'

interface QAMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  isStreaming?: boolean
  error?: string
  result?: SessionQAResult
  progressEvents?: SessionQAProgressEvent[]
  timelineEvents?: SessionQATimelineItem[]
  requestId?: string
  thinkContent?: string
  isThinking?: boolean
  showThink?: boolean
}

interface EvidenceContextState {
  ref: SummaryEvidenceRef
  messages: Message[]
  isLoading: boolean
  error?: string
}

const RESULT_TABS: Array<{ id: ResultTabId; label: string; icon: LucideIcon }> = [
  { id: 'overview', label: '概览', icon: LayoutDashboard },
  { id: 'decisions', label: '决策', icon: CheckCircle2 },
  { id: 'todos', label: '待办', icon: ListTodo },
  { id: 'risks', label: '风险', icon: AlertTriangle },
  { id: 'events', label: '事件', icon: CalendarDays },
  { id: 'questions', label: '问题', icon: CircleHelp },
  { id: 'markdown', label: 'Markdown 摘要', icon: FileText }
]

const STREAM_FLUSH_INTERVAL_MS = 80

function getDefaultResultTab(summary: SummaryResult | null): ResultTabId {
  return summary?.structuredAnalysis ? 'overview' : 'markdown'
}

function getAvailableResultTabs(summary: SummaryResult | null) {
  if (summary?.structuredAnalysis) {
    return RESULT_TABS
  }

  return RESULT_TABS.filter((tab) => tab.id === 'markdown')
}

function splitSummaryContent(content: string) {
  let thinkContent = ''
  let mainContent = content
  let hasThink = false

  if (content.includes('<think>') && content.includes('</think>')) {
    const parts = content.split('<think>')
    const pre = parts[0]
    const rest = parts[1] || ''
    const parts2 = rest.split('</think>')
    thinkContent = parts2[0] || ''
    mainContent = pre + (parts2[1] || '')
    hasThink = true
  }

  return {
    hasThink,
    thinkContent,
    mainContent: mainContent.trim()
  }
}

function getSummaryPlainText(content: string) {
  const { mainContent } = splitSummaryContent(content)
  const html = marked.parse(mainContent) as string
  const tempDiv = document.createElement('div')
  tempDiv.innerHTML = html
  return (tempDiv.textContent || tempDiv.innerText || '').trim()
}

function stripSummaryContent(content: string) {
  return splitSummaryContent(content).mainContent
}

function normalizeMarkdownTables(text: string) {
  return text
    .replace(/([：:])\n(\|[^\n]+\|\n\|[\s:|-]+\|)/g, '$1\n\n$2')
}

function formatConfidence(value?: number) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return ''
  }

  return `${Math.round(value * 100)}%`
}

function formatEvidenceTime(createTime: number) {
  return new Date(createTime * 1000).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function formatEvidenceFullTime(createTime: number) {
  return new Date(createTime * 1000).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function formatCreatedAt(createdAt: number) {
  return new Date(createdAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function getTodoStatusLabel(status: 'open' | 'done' | 'unknown') {
  switch (status) {
    case 'done':
      return '已完成'
    case 'open':
      return '待跟进'
    default:
      return '状态未知'
  }
}

function getRiskSeverityLabel(severity: 'low' | 'medium' | 'high') {
  switch (severity) {
    case 'high':
      return '高风险'
    case 'medium':
      return '中风险'
    default:
      return '低风险'
  }
}

const senderDisplayNameCache = new Map<string, string>()

function isTechnicalSenderName(value?: string | null) {
  const text = String(value || '').trim()
  return !text || /^wxid_/i.test(text)
}

function getReadableSenderName(input: {
  isSelf?: boolean
  senderUsername?: string | null
  senderDisplayName?: string | null
  sessionName?: string
  isGroup?: boolean
}) {
  if (input.isSelf) return '我'

  const cached = input.senderUsername ? senderDisplayNameCache.get(input.senderUsername) : ''
  if (cached && !isTechnicalSenderName(cached)) return cached

  if (input.senderDisplayName && !isTechnicalSenderName(input.senderDisplayName)) {
    return input.senderDisplayName
  }

  if (input.senderUsername && !isTechnicalSenderName(input.senderUsername)) {
    return input.senderUsername
  }

  if (!input.isGroup && input.sessionName) {
    return input.sessionName
  }

  return '未知发送人'
}

function getEvidenceSender(ref: SummaryEvidenceRef, message?: Message, sessionName?: string, sessionId?: string) {
  const isSelf = message?.isSend === 1 || ref.senderDisplayName === '我'
  const senderUsername = message?.senderUsername || ref.senderUsername || ''
  const effectiveSessionId = sessionId || ref.sessionId
  return getReadableSenderName({
    isSelf,
    senderUsername,
    senderDisplayName: ref.senderDisplayName,
    sessionName,
    isGroup: effectiveSessionId.includes('@chatroom')
  })
}

function getAvatarLetter(name: string) {
  const chars = [...(name || '?')]
  return chars[0] || '?'
}

function getEvidenceKey(ref: SummaryEvidenceRef) {
  return `${ref.sessionId}:${ref.localId}:${ref.createTime}:${ref.sortSeq}`
}

function getMessageKey(message: Message) {
  return `${message.localId}:${message.createTime}:${message.sortSeq}`
}

function isSameEvidenceMessage(message: Message, ref: SummaryEvidenceRef) {
  return message.localId === ref.localId
    && message.createTime === ref.createTime
    && message.sortSeq === ref.sortSeq
}

function EvidenceSenderName({
  refItem,
  message,
  sessionId,
  sessionName
}: {
  refItem: SummaryEvidenceRef
  message?: Message
  sessionId: string
  sessionName?: string
}) {
  const isSelf = message?.isSend === 1 || refItem.senderDisplayName === '我'
  const senderUsername = message?.senderUsername || refItem.senderUsername || ''
  const isGroup = sessionId.includes('@chatroom')
  const [displayName, setDisplayName] = useState(() => getReadableSenderName({
    isSelf,
    senderUsername,
    senderDisplayName: refItem.senderDisplayName,
    sessionName,
    isGroup
  }))

  useEffect(() => {
    let cancelled = false
    setDisplayName(getReadableSenderName({
      isSelf,
      senderUsername,
      senderDisplayName: refItem.senderDisplayName,
      sessionName,
      isGroup
    }))

    if (isSelf || !senderUsername) return

    const cached = senderDisplayNameCache.get(senderUsername)
    if (cached && !isTechnicalSenderName(cached)) {
      setDisplayName(cached)
      return
    }

    window.electronAPI.chat.getContactAvatar(senderUsername).then((result) => {
      if (cancelled) return
      const resolvedName = result?.displayName || ''
      if (resolvedName) senderDisplayNameCache.set(senderUsername, resolvedName)
      setDisplayName(getReadableSenderName({
        isSelf,
        senderUsername,
        senderDisplayName: resolvedName || refItem.senderDisplayName,
        sessionName,
        isGroup
      }))
    }).catch(() => {})

    return () => {
      cancelled = true
    }
  }, [isGroup, isSelf, refItem.senderDisplayName, senderUsername, sessionName])

  return (
    <span className="qa-sender-name" title={senderUsername && displayName !== senderUsername ? senderUsername : undefined}>
      {displayName}
    </span>
  )
}

function compareMessagesByTime(a: Message, b: Message) {
  if (a.sortSeq !== b.sortSeq) return a.sortSeq - b.sortSeq
  if (a.createTime !== b.createTime) return a.createTime - b.createTime
  return a.localId - b.localId
}

function buildEvidenceRefFromMessage(sessionId: string, message: Message, fallbackRef?: SummaryEvidenceRef): SummaryEvidenceRef {
  return {
    sessionId,
    localId: message.localId,
    createTime: message.createTime,
    sortSeq: message.sortSeq,
    senderUsername: message.senderUsername || undefined,
    senderDisplayName: message.isSend === 1 ? '我' : undefined,
    previewText: message.parsedContent || fallbackRef?.previewText || ''
  }
}

function EvidenceAvatar({
  refItem,
  message,
  sessionId,
  sessionName,
  sessionAvatarUrl,
  myAvatarUrl
}: {
  refItem: SummaryEvidenceRef
  message?: Message
  sessionId: string
  sessionName: string
  sessionAvatarUrl: string
  myAvatarUrl: string
}) {
  const [contactAvatar, setContactAvatar] = useState('')
  const [contactName, setContactName] = useState('')
  const isSelf = message?.isSend === 1 || refItem.senderDisplayName === '我'
  const senderUsername = message?.senderUsername || refItem.senderUsername || ''
  const isGroup = sessionId.includes('@chatroom')
  const shouldLookupContact = !isSelf && Boolean(senderUsername) && (isGroup || senderUsername !== sessionId)

  useEffect(() => {
    let cancelled = false
    setContactAvatar('')
    setContactName('')

    if (!shouldLookupContact || !senderUsername) return

    window.electronAPI.chat.getContactAvatar(senderUsername).then((result) => {
      if (cancelled) return
      setContactAvatar(result?.avatarUrl || '')
      setContactName(result?.displayName || '')
      if (result?.displayName) senderDisplayNameCache.set(senderUsername, result.displayName)
    }).catch(() => {})

    return () => {
      cancelled = true
    }
  }, [senderUsername, shouldLookupContact])

  const displayName = isSelf
    ? '我'
    : getReadableSenderName({
        senderUsername,
        senderDisplayName: contactName || refItem.senderDisplayName,
        sessionName,
        isGroup
      })
  const avatarSrc = isSelf ? myAvatarUrl : (contactAvatar || (!isGroup ? sessionAvatarUrl : ''))

  return (
    <div className="qa-evidence-avatar" title={displayName}>
      {avatarSrc ? (
        <img src={avatarSrc} alt="" referrerPolicy="no-referrer" />
      ) : (
        <span>{getAvatarLetter(displayName)}</span>
      )}
    </div>
  )
}

function EvidenceMediaPreview({
  refItem,
  message,
  compact = false
}: {
  refItem: SummaryEvidenceRef
  message?: Message
  compact?: boolean
}) {
  const [src, setSrc] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const isImage = Boolean(message?.imageMd5 || message?.imageDatName)
  const isEmoji = Boolean(message?.emojiMd5 || message?.emojiCdnUrl)

  useEffect(() => {
    let cancelled = false
    setSrc('')
    setError(false)

    if (!message || (!isImage && !isEmoji)) return

    setLoading(true)

    const load = async () => {
      if (isEmoji) {
        const result = await window.electronAPI.chat.downloadEmoji(
          message.emojiCdnUrl || '',
          message.emojiMd5,
          message.productId,
          message.createTime,
          message.emojiEncryptUrl,
          message.emojiAesKey
        )
        if (!cancelled) {
          if (result.success && result.localPath) setSrc(result.localPath)
          else setError(true)
        }
        return
      }

      const cached = await window.electronAPI.image.resolveCache({
        sessionId: refItem.sessionId,
        imageMd5: message.imageMd5,
        imageDatName: message.imageDatName
      })
      if (!cancelled && cached.success && cached.localPath) {
        setSrc(cached.localPath)
        return
      }

      const result = await window.electronAPI.image.decrypt({
        sessionId: refItem.sessionId,
        imageMd5: message.imageMd5,
        imageDatName: message.imageDatName,
        force: false
      })
      if (!cancelled) {
        if (result.success && result.localPath) setSrc(result.localPath)
        else setError(true)
      }
    }

    load().catch(() => {
      if (!cancelled) setError(true)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [
    isEmoji,
    isImage,
    message?.createTime,
    message?.emojiAesKey,
    message?.emojiCdnUrl,
    message?.emojiEncryptUrl,
    message?.emojiMd5,
    message?.imageDatName,
    message?.imageMd5,
    message?.productId,
    refItem.sessionId
  ])

  if (!message) return null

  if (isImage || isEmoji) {
    const label = isEmoji ? '表情包' : '图片'
    if (loading) {
      return (
        <div className={`qa-evidence-media loading ${compact ? 'compact' : ''}`}>
          <Loader2 size={15} className="spinner" />
          <span>正在加载{label}</span>
        </div>
      )
    }

    if (src) {
      return (
        <button
          type="button"
          className={`qa-evidence-media image ${isEmoji ? 'emoji' : ''} ${compact ? 'compact' : ''}`}
          onClick={() => window.electronAPI.window.openImageViewerWindow(src)}
          aria-label={`查看${label}`}
        >
          <img
            src={src}
            alt={label}
            onError={() => {
              setSrc('')
              setError(true)
            }}
          />
        </button>
      )
    }

    if (error) {
      return (
        <div className={`qa-evidence-media unavailable ${compact ? 'compact' : ''}`}>
          {isEmoji ? <Smile size={15} /> : <ImageIcon size={15} />}
          <span>{label}不可用</span>
        </div>
      )
    }

    return null
  }

  if (message.videoMd5) {
    return (
      <div className={`qa-evidence-media pill ${compact ? 'compact' : ''}`}>
        <Video size={15} />
        <span>{message.videoDuration ? `视频 ${message.videoDuration} 秒` : '视频'}</span>
      </div>
    )
  }

  if (message.voiceDuration) {
    return (
      <div className={`qa-evidence-media pill ${compact ? 'compact' : ''}`}>
        <Mic size={15} />
        <span>语音 {Math.round(message.voiceDuration)} 秒</span>
      </div>
    )
  }

  if (message.fileName) {
    return (
      <div className={`qa-evidence-media pill ${compact ? 'compact' : ''}`}>
        <FileText size={15} />
        <span>{message.fileName}</span>
      </div>
    )
  }

  if (message.chatRecordList?.length) {
    return (
      <div className={`qa-evidence-media pill ${compact ? 'compact' : ''}`}>
        <MessageCircle size={15} />
        <span>聊天记录 {message.chatRecordList.length} 条</span>
      </div>
    )
  }

  return null
}

function upsertQAProgressEvent(
  events: SessionQAProgressEvent[] = [],
  event: SessionQAProgressEvent
) {
  const index = events.findIndex((item) => item.id === event.id)
  if (index < 0) {
    return [...events, event]
  }

  return events.map((item, itemIndex) => itemIndex === index
    ? { ...event, createdAt: item.createdAt || event.createdAt }
    : item
  )
}

function upsertQATimelineItems(
  events: SessionQATimelineItem[] = [],
  incoming: SessionQATimelineItem[] = []
) {
  if (incoming.length === 0) return events

  const byId = new Map(events.map((item) => [item.id, item]))
  incoming.forEach((item) => {
    const existing = byId.get(item.id)
    byId.set(item.id, existing
      ? { ...item, order: existing.order, createdAt: existing.createdAt || item.createdAt }
      : item)
  })

  return Array.from(byId.values()).sort((a, b) =>
    a.order - b.order
    || a.createdAt - b.createdAt
    || a.id.localeCompare(b.id)
  )
}

function createLocalQATimelineProgress(requestId: string, createdAt: number): {
  progress: SessionQAProgressEvent
  timelineItem: SessionQATimelineItem
} {
  const progress: SessionQAProgressEvent = {
    id: 'job-start',
    stage: 'intent',
    status: 'running',
    title: '准备问答任务',
    displayName: '准备问答任务',
    nodeName: '准备问答任务',
    detail: '正在提交问题并创建问答任务',
    source: 'model',
    requestId,
    createdAt
  }

  return {
    progress,
    timelineItem: {
      type: 'progress',
      id: `progress:${progress.id}`,
      order: 0,
      createdAt,
      requestId,
      channel: 'answer',
      event: progress
    }
  }
}

function appendQAChunkToMessage(message: QAMessage, chunk: string): QAMessage {
  let remaining = chunk
  let next: QAMessage = { ...message }

  while (remaining.length > 0) {
    if (next.isThinking) {
      const closeIndex = remaining.indexOf('</think>')
      if (closeIndex < 0) {
        next = {
          ...next,
          thinkContent: `${next.thinkContent || ''}${remaining}`
        }
        break
      }

      const thinkPart = remaining.slice(0, closeIndex)
      next = {
        ...next,
        thinkContent: `${next.thinkContent || ''}${thinkPart}`,
        isThinking: false,
        showThink: false
      }
      remaining = remaining.slice(closeIndex + '</think>'.length)
      continue
    }

    const openIndex = remaining.indexOf('<think>')
    if (openIndex < 0) {
      next = {
        ...next,
        content: `${next.content}${remaining}`,
        showThink: next.thinkContent ? false : next.showThink
      }
      break
    }

    const answerPart = remaining.slice(0, openIndex)
    next = {
      ...next,
      content: `${next.content}${answerPart}`,
      isThinking: true,
      showThink: true
    }
    remaining = remaining.slice(openIndex + '<think>'.length)
  }

  return next
}

function mapStoredQAMessage(record: SessionQAMessageRecord): QAMessage {
  const result = record.result
    ? {
        ...record.result,
        evidenceRefs: record.evidenceRefs || record.result.evidenceRefs,
        toolCalls: record.toolCalls || record.result.toolCalls
      }
    : undefined

  return {
    id: `stored-${record.id}`,
    role: record.role,
    content: record.content,
    createdAt: record.createdAt,
    error: record.error,
    result,
    thinkContent: record.thinkContent,
    isThinking: false,
    showThink: false,
    progressEvents: record.progressEvents,
    timelineEvents: record.timelineEvents,
    requestId: record.requestId
  }
}

function AISummaryWindow() {
  const { isMac } = usePlatformInfo()
  const [sessionId, setSessionId] = useState<string>('')
  const [sessionName, setSessionName] = useState<string>('')
  const [avatarUrl, setAvatarUrl] = useState<string>('')
  const [myAvatarUrl, setMyAvatarUrl] = useState<string>('')
  const [aiProviderInfo, setAiProviderInfo] = useState<{ id: string; logo: string; displayName: string } | null>(null)
  const [resultProviderInfo, setResultProviderInfo] = useState<{ id: string; logo: string; displayName: string } | null>(null)
  const [timeRangeDays, setTimeRangeDays] = useState<number>(7)
  const [customDays, setCustomDays] = useState<string>('')
  const [customRequirement, setCustomRequirement] = useState<string>('')
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('summary')
  const [isGenerating, setIsGenerating] = useState(false)
  const [summaryText, setSummaryText] = useState('')
  const [thinkText, setThinkText] = useState('')
  const [isThinking, setIsThinking] = useState(false)
  const [showThink, setShowThink] = useState(true)
  const [result, setResult] = useState<SummaryResult | null>(null)
  const [activeResultTab, setActiveResultTab] = useState<ResultTabId>('markdown')
  const [qaInput, setQaInput] = useState('')
  const [qaConversations, setQaConversations] = useState<SessionQAConversationSummary[]>([])
  const [activeQAConversationId, setActiveQAConversationId] = useState<number | null>(null)
  const [isLoadingQAConversations, setIsLoadingQAConversations] = useState(false)
  const [isLoadingQAConversation, setIsLoadingQAConversation] = useState(false)
  const [qaMessages, setQaMessages] = useState<QAMessage[]>([])
  const [isAsking, setIsAsking] = useState(false)
  const [activeQARequestId, setActiveQARequestId] = useState<string | null>(null)
  const [expandedQAProgressIds, setExpandedQAProgressIds] = useState<Set<string>>(() => new Set())
  const [collapsedQAThinkIds, setCollapsedQAThinkIds] = useState<Set<string>>(() => new Set())
  const [expandedQAEvidenceIds, setExpandedQAEvidenceIds] = useState<Set<string>>(() => new Set())
  const [qaError, setQaError] = useState('')
  const [profileMemoryState, setProfileMemoryState] = useState<SessionProfileMemoryState | null>(null)
  const [isBuildingProfileMemory, setIsBuildingProfileMemory] = useState(false)
  const [profileMemoryMessage, setProfileMemoryMessage] = useState('')
  const [copiedEvidenceKey, setCopiedEvidenceKey] = useState('')
  const [evidenceContext, setEvidenceContext] = useState<EvidenceContextState | null>(null)
  const [evidenceMessageMap, setEvidenceMessageMap] = useState<Record<string, Message>>({})
  const [error, setError] = useState<string>('')
  const [history, setHistory] = useState<SummaryResult[]>([])
  const thinkContentRef = useRef<HTMLDivElement>(null)
  const qaContentRef = useRef<HTMLDivElement>(null)
  const qaInputRef = useRef<HTMLTextAreaElement>(null)
  const activeQARequestIdRef = useRef<string | null>(null)
  const qaRequestMessageMapRef = useRef<Map<string, string>>(new Map())
  const evidenceMessageLoadingRef = useRef<Set<string>>(new Set())
  const qaChunkBufferRef = useRef<Map<string, string>>(new Map())
  const qaChunkFlushTimerRef = useRef<number | null>(null)
  const summaryStreamBufferRef = useRef({ summary: '', think: '' })
  const summaryStreamFlushTimerRef = useRef<number | null>(null)
  const activeSummaryRequestIdRef = useRef<string | null>(null)
  const [summaryProgressEvents, setSummaryProgressEvents] = useState<SessionQAProgressEvent[]>([])

  // 对话框状态
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null)
  const [showRenameDialog, setShowRenameDialog] = useState(false)
  const [renameTargetId, setRenameTargetId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [showDeleteQADialog, setShowDeleteQADialog] = useState(false)
  const [deleteQATargetId, setDeleteQATargetId] = useState<number | null>(null)
  const [showRenameQADialog, setShowRenameQADialog] = useState(false)
  const [renameQATargetId, setRenameQATargetId] = useState<number | null>(null)
  const [renameQAValue, setRenameQAValue] = useState('')

  const getTimeRangeDisplay = (days: number) => days === 0 ? '全部消息' : `${days}天`
  const getDefaultSummaryName = (days: number) => days === 0 ? '全部消息摘要' : `${days}天摘要`
  const buildMessageId = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`

  const setDisplayedResult = (summary: SummaryResult) => {
    setResult(summary)
    setActiveResultTab(getDefaultResultTab(summary))
    setShowThink(true)
  }

  const resetResultView = () => {
    setResult(null)
    setActiveResultTab('markdown')
    setSummaryText('')
    setThinkText('')
    setShowThink(true)
  }

  const getQAHistory = (messages: QAMessage[]): SessionQAHistoryMessage[] => messages
    .filter((message) => !message.isStreaming && !message.error && message.content.trim())
    .map((message) => ({
      role: message.role,
      content: stripSummaryContent(message.content)
    }))

  const renderMarkdown = (text: string) => {
    const html = marked.parse(normalizeMarkdownTables(text)) as string
    return { __html: DOMPurify.sanitize(html) }
  }

  const renderQAThoughtMarkdown = (text: string) => {
    const normalizedText = text.replace(/([^\n])\s+(#{1,6}\s+)/g, '$1\n\n$2')
    return renderMarkdown(normalizedText)
  }

  const flushQAChunkBuffer = () => {
    if (qaChunkFlushTimerRef.current !== null) {
      window.clearTimeout(qaChunkFlushTimerRef.current)
      qaChunkFlushTimerRef.current = null
    }

    if (qaChunkBufferRef.current.size === 0) return
    const chunks = new Map(qaChunkBufferRef.current)
    qaChunkBufferRef.current.clear()

    setQaMessages(prev => prev.map(message => {
      const chunk = chunks.get(message.id)
      return chunk ? appendQAChunkToMessage(message, chunk) : message
    }))
  }

  const scheduleQAChunkFlush = () => {
    if (qaChunkFlushTimerRef.current !== null) return
    qaChunkFlushTimerRef.current = window.setTimeout(() => {
      qaChunkFlushTimerRef.current = null
      flushQAChunkBuffer()
    }, STREAM_FLUSH_INTERVAL_MS)
  }

  const flushSummaryStreamBuffer = () => {
    if (summaryStreamFlushTimerRef.current !== null) {
      window.clearTimeout(summaryStreamFlushTimerRef.current)
      summaryStreamFlushTimerRef.current = null
    }

    const pending = summaryStreamBufferRef.current
    if (!pending.summary && !pending.think) return
    summaryStreamBufferRef.current = { summary: '', think: '' }
    if (pending.summary) setSummaryText(prev => prev + pending.summary)
    if (pending.think) setThinkText(prev => prev + pending.think)
  }

  const scheduleSummaryStreamFlush = () => {
    if (summaryStreamFlushTimerRef.current !== null) return
    summaryStreamFlushTimerRef.current = window.setTimeout(() => {
      summaryStreamFlushTimerRef.current = null
      flushSummaryStreamBuffer()
    }, STREAM_FLUSH_INTERVAL_MS)
  }

  const appendSummaryStreamText = (type: 'summary' | 'think', value: string) => {
    if (!value) return
    summaryStreamBufferRef.current = {
      ...summaryStreamBufferRef.current,
      [type]: `${summaryStreamBufferRef.current[type]}${value}`
    }
    scheduleSummaryStreamFlush()
  }

  const renderQAAvatar = (message: QAMessage) => {
    if (message.role === 'user') {
      return myAvatarUrl ? (
        <img src={myAvatarUrl} alt="" className="qa-avatar-img" />
      ) : (
        <User size={15} />
      )
    }

    return aiProviderInfo ? (
      <AIProviderLogo
        providerId={aiProviderInfo.id}
        logo={aiProviderInfo.logo}
        alt={aiProviderInfo.displayName}
        className="qa-ai-provider-logo"
        size={20}
      />
    ) : (
      <Bot size={15} />
    )
  }

  const renderEvidenceList = (evidenceRefs: SummaryEvidenceRef[]) => {
    const visibleEvidence = evidenceRefs.slice(0, 3)

    if (visibleEvidence.length === 0) {
      return null
    }

    return (
      <div className="evidence-list">
        {visibleEvidence.map((ref) => (
          <div
            key={`${ref.localId}-${ref.createTime}-${ref.sortSeq}`}
            className="evidence-item"
          >
            <div className="evidence-meta">
              <span>{formatEvidenceTime(ref.createTime)}</span>
              <EvidenceSenderName
                refItem={ref}
                sessionId={ref.sessionId || sessionId}
                sessionName={sessionName}
              />
            </div>
            <div className="evidence-preview">{ref.previewText}</div>
          </div>
        ))}
      </div>
    )
  }

  const buildEvidenceCopyText = (ref: SummaryEvidenceRef) => [
    `时间：${formatEvidenceFullTime(ref.createTime)}`,
    `发送人：${getEvidenceSender(ref, evidenceMessageMap[getEvidenceKey(ref)], sessionName, ref.sessionId || sessionId)}`,
    `内容：${ref.previewText}`,
    `消息游标：sessionId=${ref.sessionId}, localId=${ref.localId}, createTime=${ref.createTime}, sortSeq=${ref.sortSeq}`
  ].join('\n')

  const getContextMessageSender = (message: Message, fallbackRef?: SummaryEvidenceRef) => {
    if (message.isSend === 1) return '我'
    if (fallbackRef && isSameEvidenceMessage(message, fallbackRef)) {
      return getEvidenceSender(fallbackRef, message, sessionName, fallbackRef.sessionId || sessionId)
    }
    if (message.senderUsername) {
      return getReadableSenderName({
        senderUsername: message.senderUsername,
        sessionName,
        isGroup: (fallbackRef?.sessionId || sessionId).includes('@chatroom')
      })
    }
    return sessionName || '未知发送人'
  }

  const getContextMessagePreview = (message: Message, fallbackRef?: SummaryEvidenceRef) => {
    const text = (message.parsedContent || message.quotedContent || '').trim()
    if (text) return text
    if (message.fileName) return `[文件] ${message.fileName}`
    if (message.chatRecordList?.length) return `[聊天记录] ${message.chatRecordList.length} 条`
    if (message.voiceDuration) return `[语音] ${message.voiceDuration} 秒`
    if (message.videoMd5) return '[视频]'
    if (message.imageMd5 || message.imageDatName) return '[图片]'
    if (message.emojiMd5 || message.emojiCdnUrl) return '[表情]'
    if (fallbackRef && isSameEvidenceMessage(message, fallbackRef)) return fallbackRef.previewText
    return '[无法预览的消息]'
  }

  const handleCopyEvidence = async (ref: SummaryEvidenceRef) => {
    try {
      await navigator.clipboard.writeText(buildEvidenceCopyText(ref))
      const key = getEvidenceKey(ref)
      setCopiedEvidenceKey(key)
      window.setTimeout(() => {
        setCopiedEvidenceKey(current => current === key ? '' : current)
      }, 1600)
    } catch (e) {
      console.error('复制证据失败:', e)
    }
  }

  const handleAskAboutEvidence = (ref: SummaryEvidenceRef) => {
    setQaInput([
      '为什么这条消息能支持你的结论？请结合上下文解释。',
      '',
      `证据：${formatEvidenceFullTime(ref.createTime)} ${getEvidenceSender(ref, evidenceMessageMap[getEvidenceKey(ref)], sessionName, ref.sessionId || sessionId)}：${ref.previewText}`
    ].join('\n'))

    window.setTimeout(() => {
      qaInputRef.current?.focus()
    }, 0)
  }

  const handleOpenEvidenceContext = async (ref: SummaryEvidenceRef) => {
    setEvidenceContext({
      ref,
      messages: [],
      isLoading: true
    })

    try {
      const [anchorResult, beforeResult, afterResult] = await Promise.all([
        window.electronAPI.chat.getMessage(ref.sessionId, ref.localId),
        window.electronAPI.chat.getMessagesBefore(ref.sessionId, ref.sortSeq, 10, ref.createTime, ref.localId),
        window.electronAPI.chat.getMessagesAfter(ref.sessionId, ref.sortSeq, 10, ref.createTime, ref.localId)
      ])

      if (!anchorResult.success || !anchorResult.message) {
        throw new Error(anchorResult.error || '未能读取证据原消息')
      }

      setEvidenceMessageMap((prev) => ({
        ...prev,
        [getEvidenceKey(ref)]: anchorResult.message!
      }))

      const contextMessages = [
        ...(beforeResult.success ? beforeResult.messages || [] : []),
        anchorResult.message,
        ...(afterResult.success ? afterResult.messages || [] : [])
      ]
      const dedupedMessages = Array.from(
        new Map(contextMessages.map(message => [getMessageKey(message), message])).values()
      ).sort(compareMessagesByTime)

      setEvidenceContext({
        ref,
        messages: dedupedMessages,
        isLoading: false,
        error: beforeResult.success && afterResult.success
          ? undefined
          : '部分上下文读取失败，已展示可读取的消息'
      })
    } catch (e) {
      setEvidenceContext({
        ref,
        messages: [],
        isLoading: false,
        error: String(e)
      })
    }
  }

  const toggleQAEvidenceList = (messageId: string) => {
    setExpandedQAEvidenceIds(prev => {
      const next = new Set(prev)
      if (next.has(messageId)) {
        next.delete(messageId)
      } else {
        next.add(messageId)
      }
      return next
    })
  }

  const renderQAEvidenceCards = (messageId: string, evidenceRefs?: SummaryEvidenceRef[]) => {
    const visibleEvidence = (evidenceRefs || []).slice(0, 8)

    if (visibleEvidence.length === 0) {
      return null
    }

    const isExpanded = expandedQAEvidenceIds.has(messageId)

    return (
      <section className={`qa-evidence-cards ${isExpanded ? 'expanded' : 'collapsed'}`} aria-label="回答证据">
        <button
          type="button"
          className="qa-evidence-heading"
          onClick={() => toggleQAEvidenceList(messageId)}
          aria-expanded={isExpanded}
        >
          <ChevronRight size={15} className="qa-evidence-toggle" aria-hidden="true" />
          <span>回答证据</span>
          <span className="qa-evidence-count">{visibleEvidence.length} 条</span>
        </button>

        {isExpanded && (
          <div className="qa-evidence-card-list">
            {visibleEvidence.map((ref, index) => {
              const key = getEvidenceKey(ref)
              const isCopied = copiedEvidenceKey === key
              const evidenceMessage = evidenceMessageMap[key]

              return (
                <article key={key} className="qa-evidence-card">
                  <EvidenceAvatar
                    refItem={ref}
                    message={evidenceMessage}
                    sessionId={ref.sessionId || sessionId}
                    sessionName={sessionName}
                    sessionAvatarUrl={avatarUrl}
                    myAvatarUrl={myAvatarUrl}
                  />
                  <div className="qa-evidence-card-body">
                    <div className="qa-evidence-card-meta">
                      <span>#{index + 1}</span>
                      <span>{formatEvidenceTime(ref.createTime)}</span>
                      <EvidenceSenderName
                        refItem={ref}
                        message={evidenceMessage}
                        sessionId={ref.sessionId || sessionId}
                        sessionName={sessionName}
                      />
                    </div>
                    <div className="qa-evidence-card-preview">
                      <MessageContent content={ref.previewText} disableLinks />
                    </div>
                    <EvidenceMediaPreview refItem={ref} message={evidenceMessage} />
                  </div>
                  <div className="qa-evidence-actions">
                    <button type="button" onClick={() => handleOpenEvidenceContext(ref)}>
                      <MessageCircle size={13} />
                      查看上下文
                    </button>
                    <button type="button" onClick={() => handleCopyEvidence(ref)}>
                      <Copy size={13} />
                      {isCopied ? '已复制' : '复制证据'}
                    </button>
                    <button type="button" onClick={() => handleAskAboutEvidence(ref)}>
                      <CircleHelp size={13} />
                      追问
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>
    )
  }

  const toggleQAThinkPanel = (panelId: string) => {
    setCollapsedQAThinkIds(prev => {
      const next = new Set(prev)
      if (next.has(panelId)) {
        next.delete(panelId)
      } else {
        next.add(panelId)
      }
      return next
    })
  }

  const isQAThinkPanelExpanded = (panelId: string) => {
    return !collapsedQAThinkIds.has(panelId)
  }

  const toggleQAProgressEvent = (eventId: string) => {
    setExpandedQAProgressIds(prev => {
      const next = new Set(prev)
      if (next.has(eventId)) {
        next.delete(eventId)
      } else {
        next.add(eventId)
      }
      return next
    })
  }

  const getQAProgressTargetLabel = (event: SessionQAProgressEvent) => {
    return event.nodeName || event.displayName || event.title
  }

  const getQAProgressDetailLines = (event: SessionQAProgressEvent) => {
    const stageLabels: Record<string, string> = {
      intent: '识别意图',
      tool: '运行工具',
      context: '整理依据',
      answer: '生成回答',
      thought: '模型响应',
      preprocess: '预处理'
    }
    const sourceLabels: Record<string, string> = {
      summary: '摘要事实',
      chat: '原始消息',
      search_index: '检索索引',
      vector: '语义向量',
      aggregate: '聚合统计',
      model: '模型推理',
      system: '系统'
    }
    const lines = [
      ...(event.detail
        ? event.detail.split('\n').map((line) => line.trim()).filter(Boolean)
        : [event.status === 'running' ? '执行中...' : '执行完成'])
    ]

    if (event.diagnostics?.length) lines.push(...event.diagnostics)
    if (event.stage) lines.push(`阶段：${stageLabels[event.stage]}`)
    if (event.source) lines.push(`数据来源：${sourceLabels[event.source]}`)
    if (event.query) lines.push(`查询：${event.query}`)
    if (event.count !== undefined) lines.push(`数量：${event.count}`)
    if (event.elapsedMs !== undefined) lines.push(`耗时：${(event.elapsedMs / 1000).toFixed(1)} 秒`)

    return lines.filter(Boolean)
  }

  const renderQAProgressCard = (event: SessionQAProgressEvent, expansionKey: string) => {
    const isExpanded = expandedQAProgressIds.has(expansionKey)
    const detailLines = isExpanded ? getQAProgressDetailLines(event) : []

    return (
      <div
        key={expansionKey}
        className={`qa-progress-card ${event.stage} ${event.status} ${isExpanded ? 'expanded' : ''}`}
        aria-busy={event.status === 'running'}
      >
        <span className="qa-progress-dot" aria-hidden="true" />

        <div className="qa-progress-node">
          <button
            type="button"
            className="qa-progress-summary"
            onClick={() => toggleQAProgressEvent(expansionKey)}
            aria-expanded={isExpanded}
          >
            <span className="qa-progress-title">
              {getQAProgressTargetLabel(event)}
            </span>
            {event.status === 'running' && (
              <span className="qa-progress-running">
                <Loader2 size={13} className="spinner" />
                正在调用
              </span>
            )}
          </button>

          {isExpanded && (
            <div className="qa-progress-details">
              {detailLines.map((line, index) => (
                <p key={`${expansionKey}-${index}`}>{line}</p>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  const renderQAProgressTimeline = (timelineId: string, events: SessionQAProgressEvent[]) => {
    if (events.length === 0) {
      return null
    }

    return (
      <section key={timelineId} className="qa-progress-timeline" aria-label="AI 执行轨迹">
        <div className="qa-progress-axis">
          {events.map((event, index) => renderQAProgressCard(event, `${timelineId}:${event.id}:${index}`))}
        </div>
      </section>
    )
  }

  const renderQAThinkPanel = (message: QAMessage) => {
    if (!message.thinkContent) {
      return null
    }

    const panelId = `${message.id}:legacy-think`
    const expanded = isQAThinkPanelExpanded(panelId)

    return (
      <div className={`think-panel qa-think-panel ${!expanded ? 'collapsed' : ''} ${message.isThinking ? 'thinking' : ''}`}>
        <div className="think-header" onClick={() => toggleQAThinkPanel(panelId)}>
          <div className="think-title">
            {message.isThinking ? (
              <Loader2 size={14} className="think-icon animate-spin" />
            ) : (
              <Atom size={14} className="think-icon" />
            )}
            <span>{message.isThinking ? '深度思考中...' : '深度思考'}</span>
          </div>
          <ChevronDown
            size={16}
            className={`toggle-icon ${expanded ? 'expanded' : ''}`}
          />
        </div>
        <div
          className="think-content markdown-body"
          dangerouslySetInnerHTML={renderMarkdown(message.thinkContent)}
        />
      </div>
    )
  }

  const renderQATimeline = (message: QAMessage) => {
    type LegacyQATimelineItem =
      | { type: 'progress'; id: string; events: SessionQAProgressEvent[] }
      | { type: 'thought'; event: SessionQAProgressEvent }
      | { type: 'answer'; content: string }

    type TimelineRenderItem =
      | { type: 'progress'; id: string; events: SessionQAProgressEvent[] }
      | { type: 'text'; item: SessionQATimelineItem & { type: 'text' } }
      | { type: 'think'; id: string; items: SessionQATimelineItem[] }

    const renderAnswerTextItem = (item: SessionQATimelineItem & { type: 'text' }) => {
      if (!item.content) return null
      return (
        <div key={item.id} className="qa-bubble">
          <div
            className="qa-answer markdown-body"
            dangerouslySetInnerHTML={renderMarkdown(item.content)}
          />
        </div>
      )
    }

    const renderTimelineThinkGroup = (group: Extract<TimelineRenderItem, { type: 'think' }>) => {
      const expanded = isQAThinkPanelExpanded(group.id)
      const lastTimelineItem = message.timelineEvents?.[message.timelineEvents.length - 1]
      const isThinkingGroup = message.isThinking && group.items.some((item) => item.id === lastTimelineItem?.id)

      return (
        <div
          key={group.id}
          className={`think-panel qa-think-panel qa-timeline-think-panel ${!expanded ? 'collapsed' : ''} ${isThinkingGroup ? 'thinking' : ''}`}
        >
          <div className="think-header" onClick={() => toggleQAThinkPanel(group.id)}>
            <div className="think-title">
              {isThinkingGroup ? (
                <Loader2 size={14} className="think-icon animate-spin" />
              ) : (
                <Atom size={14} className="think-icon" />
              )}
              <span>{isThinkingGroup ? '深度思考中...' : '深度思考'}</span>
            </div>
            <ChevronDown
              size={16}
              className={`toggle-icon ${expanded ? 'expanded' : ''}`}
            />
          </div>
          <div className="think-content">
            {group.items.map((item) => {
              if (item.type === 'progress') {
                return renderQAProgressTimeline(`${group.id}-${item.id}`, [item.event])
              }

              return (
                <div
                  key={item.id}
                  className="qa-think-text markdown-body"
                  dangerouslySetInnerHTML={renderMarkdown(item.content)}
                />
              )
            })}
          </div>
        </div>
      )
    }

    const timelineEvents = [...(message.timelineEvents || [])]
      .sort((a, b) =>
        a.order - b.order
        || a.createdAt - b.createdAt
        || a.id.localeCompare(b.id)
      )

    if (timelineEvents.length > 0) {
      const renderItems: TimelineRenderItem[] = []
      let pendingProgressEvents: SessionQAProgressEvent[] = []
      let pendingThinkItems: SessionQATimelineItem[] = []

      const flushProgressEvents = () => {
        if (pendingProgressEvents.length === 0) return
        const firstEventId = pendingProgressEvents[0]?.id || String(renderItems.length)
        renderItems.push({
          type: 'progress',
          id: `${message.id}-progress-${firstEventId}-${renderItems.length}`,
          events: pendingProgressEvents
        })
        pendingProgressEvents = []
      }

      const flushThinkItems = () => {
        if (pendingThinkItems.length === 0) return
        renderItems.push({
          type: 'think',
          id: `${message.id}-think-${pendingThinkItems[0]?.id || renderItems.length}`,
          items: pendingThinkItems
        })
        pendingThinkItems = []
      }

      timelineEvents.forEach((item) => {
        if (item.channel === 'think') {
          flushProgressEvents()
          pendingThinkItems.push(item)
          return
        }

        flushThinkItems()
        if (item.type === 'progress') {
          pendingProgressEvents.push(item.event)
          return
        }

        flushProgressEvents()
        renderItems.push({ type: 'text', item })
      })
      flushThinkItems()
      flushProgressEvents()

      const hasEvidence = (message.result?.evidenceRefs?.length || 0) > 0
      const hasRenderableItems = renderItems.length > 0 || message.error || hasEvidence

      if (!hasRenderableItems && message.isStreaming) {
        return (
          <div className="qa-streaming-placeholder">
            <Loader2 size={14} className="spinner" />
          </div>
        )
      }

      if (!hasRenderableItems) return null

      return (
        <div className="qa-timeline">
          {renderItems.map((item) => {
            if (item.type === 'progress') {
              return renderQAProgressTimeline(item.id, item.events)
            }

            if (item.type === 'think') {
              return renderTimelineThinkGroup(item)
            }

            return renderAnswerTextItem(item.item)
          })}
          {message.error && (
            <div className="qa-bubble">
              <div className="qa-error">{message.error}</div>
            </div>
          )}
          {hasEvidence && (
            <div className="qa-bubble qa-evidence-bubble">
              {renderQAEvidenceCards(message.id, message.result?.evidenceRefs)}
            </div>
          )}
        </div>
      )
    }

    const progressItems = [...(message.progressEvents || [])]
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))

    const timelineItems: LegacyQATimelineItem[] = []
    let pendingProgressEvents: SessionQAProgressEvent[] = []

    const flushProgressEvents = () => {
      if (pendingProgressEvents.length === 0) return
      const firstEventId = pendingProgressEvents[0]?.id || String(timelineItems.length)
      timelineItems.push({
        type: 'progress',
        id: `${message.id}-progress-${firstEventId}`,
        events: pendingProgressEvents
      })
      pendingProgressEvents = []
    }

    progressItems.forEach((event) => {
      if (event.stage === 'thought') {
        flushProgressEvents()
        timelineItems.push({ type: 'thought', event })
      } else {
        pendingProgressEvents.push(event)
      }
    })
    flushProgressEvents()

    const hasAnswerBody = Boolean(
      message.error ||
      (message.timelineEvents?.length || 0) > 0 ||
      message.thinkContent ||
      message.content ||
      (message.result?.evidenceRefs?.length || 0) > 0
    )

    if (hasAnswerBody) {
      timelineItems.push({ type: 'answer', content: message.content })
    }

    if (timelineItems.length === 0 && message.isStreaming) {
      return (
        <div className="qa-streaming-placeholder">
          <Loader2 size={14} className="spinner" />
        </div>
      )
    }

    if (timelineItems.length === 0) {
      return null
    }

    return (
      <div className="qa-timeline">
        {timelineItems.map((item) => {
          if (item.type === 'progress') {
            return renderQAProgressTimeline(item.id, item.events)
          }

          if (item.type === 'thought') {
            const thoughtText = item.event.title || item.event.detail || ''
            return (
              <div
                key={item.event.id}
                className="qa-thought-bubble markdown-body"
                dangerouslySetInnerHTML={renderQAThoughtMarkdown(thoughtText)}
              />
            )
          }

          return (
            <div key="answer" className="qa-bubble">
              {message.error ? (
                <div className="qa-error">{message.error}</div>
              ) : (
                <>
                  {renderQAThinkPanel(message)}
                  {item.content && (
                    <div
                      className="qa-answer markdown-body"
                      dangerouslySetInnerHTML={renderMarkdown(item.content)}
                    />
                  )}
                  {renderQAEvidenceCards(message.id, message.result?.evidenceRefs)}
                </>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  const renderEvidenceContextPanel = () => {
    if (!evidenceContext) {
      return null
    }

    return (
      <div className="qa-context-overlay" role="dialog" aria-modal="true" aria-label="证据上下文" onClick={() => setEvidenceContext(null)}>
        <section className="qa-context-panel" onClick={(event) => event.stopPropagation()}>
          <header className="qa-context-header">
            <div>
              <p className="qa-context-kicker">证据上下文</p>
              <h3>原消息前后 10 条</h3>
            </div>
            <button type="button" className="qa-context-close" onClick={() => setEvidenceContext(null)} aria-label="关闭上下文">
              <X size={16} />
            </button>
          </header>

          <div className="qa-context-anchor">
            <span>{formatEvidenceFullTime(evidenceContext.ref.createTime)}</span>
            <EvidenceSenderName
              refItem={evidenceContext.ref}
              message={evidenceMessageMap[getEvidenceKey(evidenceContext.ref)]}
              sessionId={evidenceContext.ref.sessionId || sessionId}
              sessionName={sessionName}
            />
            <span>localId {evidenceContext.ref.localId}</span>
          </div>

          <div className="qa-context-body">
            {evidenceContext.isLoading ? (
              <div className="qa-context-status">
                <Loader2 size={16} className="spinner" />
                <span>正在读取上下文...</span>
              </div>
            ) : evidenceContext.messages.length === 0 ? (
              <div className="qa-context-status error">
                {evidenceContext.error || '没有读取到上下文消息'}
              </div>
            ) : (
              <>
                {evidenceContext.error && (
                  <div className="qa-context-inline-warning">{evidenceContext.error}</div>
                )}
                <div className="qa-context-message-list">
                  {evidenceContext.messages.map((message) => {
                    const isAnchor = isSameEvidenceMessage(message, evidenceContext.ref)
                    const contextRef = isAnchor
                      ? evidenceContext.ref
                      : {
                          ...buildEvidenceRefFromMessage(evidenceContext.ref.sessionId, message, evidenceContext.ref),
                          senderDisplayName: getContextMessageSender(message, evidenceContext.ref),
                          previewText: getContextMessagePreview(message, evidenceContext.ref)
                        }

                    return (
                      <article
                        key={getMessageKey(message)}
                        className={`qa-context-message ${isAnchor ? 'anchor' : ''}`}
                      >
                        <EvidenceAvatar
                          refItem={contextRef}
                          message={message}
                          sessionId={evidenceContext.ref.sessionId || sessionId}
                          sessionName={sessionName}
                          sessionAvatarUrl={avatarUrl}
                          myAvatarUrl={myAvatarUrl}
                        />
                        <div className="qa-context-message-content">
                          <div className="qa-context-message-meta">
                            <span>{formatEvidenceTime(message.createTime)}</span>
                            <EvidenceSenderName
                              refItem={contextRef}
                              message={message}
                              sessionId={evidenceContext.ref.sessionId || sessionId}
                              sessionName={sessionName}
                            />
                            {isAnchor && <strong>原消息</strong>}
                          </div>
                          <p>
                            <MessageContent content={getContextMessagePreview(message, evidenceContext.ref)} disableLinks />
                          </p>
                          <EvidenceMediaPreview refItem={contextRef} message={message} compact />
                        </div>
                      </article>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    )
  }

  const renderEmptyState = (title: string, description: string) => (
    <div className="empty-state">
      <p className="empty-title">{title}</p>
      <p className="empty-description">{description}</p>
    </div>
  )

  const renderMarkdownResult = () => {
    if (!result) return null

    const { hasThink, thinkContent, mainContent } = splitSummaryContent(result.summaryText || '')

    return (
      <div className="summary-content">
        {hasThink && (
          <div className={`think-panel ${!showThink ? 'collapsed' : ''}`}>
            <div className="think-header" onClick={() => setShowThink(!showThink)}>
              <div className="think-title">
                <Atom size={14} className="think-icon" />
                <span>深度思考</span>
              </div>
              <ChevronDown
                size={16}
                className={`toggle-icon ${showThink ? 'expanded' : ''}`}
              />
            </div>
            <div
              className="think-content markdown-body"
              dangerouslySetInnerHTML={renderMarkdown(thinkContent)}
            />
          </div>
        )}

        <div
          className="markdown-body"
          dangerouslySetInnerHTML={renderMarkdown(mainContent)}
        />

        {resultProviderInfo && (
          <div className="ai-disclaimer">
            <hr className="divider" />
            <div className="disclaimer-content">
              {resultProviderInfo.logo && (
                <div className="ai-provider-badge-small">
                  <AIProviderLogo
                    providerId={resultProviderInfo.id}
                    logo={resultProviderInfo.logo}
                    alt={resultProviderInfo.displayName}
                    size={20}
                  />
                </div>
              )}
              <span className="disclaimer-text">
                内容由 {resultProviderInfo.displayName} 生成，请仔细甄别！
              </span>
            </div>
          </div>
        )}
      </div>
    )
  }

  const renderOverviewTab = (analysis: SummaryStructuredAnalysis) => {
    const sortedTopics = [...analysis.topics].sort((a, b) => b.importance - a.importance)
    const stats = [
      { label: '决策', value: analysis.decisions.length },
      { label: '待办', value: analysis.todos.length },
      { label: '风险', value: analysis.risks.length },
      { label: '事件', value: analysis.events.length },
      { label: '问题', value: analysis.openQuestions.length }
    ]

    return (
      <div className="structured-panel overview-panel">
        <section className="panel-card overview-card">
          <span className="panel-kicker">结构化概览</span>
          <h2>本次分析的核心结论</h2>
          <p className="overview-text">
            {analysis.overview || '这条摘要还没有提炼出明确概览，可切换到其他标签查看结构化条目。'}
          </p>
        </section>

        <section className="panel-card">
          <div className="section-header">
            <div>
              <h3>分析元信息</h3>
              <p>本次摘要对应的基础上下文</p>
            </div>
          </div>
          <div className="meta-grid">
            <div className="meta-card">
              <span className="meta-label">时间范围</span>
              <span className="meta-value">{getTimeRangeDisplay(result!.timeRangeDays)}</span>
            </div>
            <div className="meta-card">
              <span className="meta-label">消息数量</span>
              <span className="meta-value">{result!.messageCount} 条</span>
            </div>
            <div className="meta-card">
              <span className="meta-label">生成时间</span>
              <span className="meta-value">{formatCreatedAt(result!.createdAt)}</span>
            </div>
            <div className="meta-card">
              <span className="meta-label">模型提供商</span>
              <span className="meta-value">{resultProviderInfo?.displayName || result!.provider}</span>
            </div>
            <div className="meta-card">
              <span className="meta-label">模型</span>
              <span className="meta-value meta-mono">{result!.model}</span>
            </div>
          </div>
        </section>

        <section className="panel-card">
          <div className="section-header">
            <div>
              <h3>结构化统计</h3>
              <p>当前结果中沉淀出的重点条目</p>
            </div>
          </div>
          <div className="stats-grid">
            {stats.map((item) => (
              <div key={item.label} className="stat-card">
                <span className="stat-value">{item.value}</span>
                <span className="stat-label">{item.label}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel-card">
          <div className="section-header">
            <div>
              <h3>核心主题</h3>
              <p>按重要度排序的会话主题</p>
            </div>
          </div>

          {sortedTopics.length > 0 ? (
            <div className="topic-list">
              {sortedTopics.map((topic) => (
                <div key={topic.name} className="topic-card">
                  <span className="topic-name">{topic.name}</span>
                  <span className="topic-importance">
                    重要度 {formatConfidence(topic.importance)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            renderEmptyState('暂无核心主题', '当前结构化结果还没有提炼出稳定主题。')
          )}
        </section>
      </div>
    )
  }

  const renderDecisionsTab = (analysis: SummaryStructuredAnalysis) => {
    if (analysis.decisions.length === 0) {
      return renderEmptyState('暂无决策', '当前时间范围内没有识别出明确的拍板或结论。')
    }

    return (
      <div className="fact-list">
        {analysis.decisions.map((item, index) => (
          <article key={`${item.text}-${index}`} className="fact-card">
            <div className="fact-card-header">
              <span className="fact-index">决策 {index + 1}</span>
              <span className="fact-badge confidence">可信度 {formatConfidence(item.confidence)}</span>
            </div>
            <p className="fact-main-text">{item.text}</p>
            {renderEvidenceList(item.evidenceRefs)}
          </article>
        ))}
      </div>
    )
  }

  const renderTodosTab = (analysis: SummaryStructuredAnalysis) => {
    if (analysis.todos.length === 0) {
      return renderEmptyState('暂无待办', '当前时间范围内没有识别出需要后续跟进的事项。')
    }

    return (
      <div className="fact-list">
        {analysis.todos.map((item, index) => (
          <article key={`${item.task}-${item.owner || 'unknown'}-${index}`} className="fact-card">
            <div className="fact-card-header">
              <span className="fact-index">待办 {index + 1}</span>
              <div className="fact-badge-group">
                <span className={`fact-badge status ${item.status}`}>{getTodoStatusLabel(item.status)}</span>
                <span className="fact-badge confidence">可信度 {formatConfidence(item.confidence)}</span>
              </div>
            </div>
            <p className="fact-main-text">{item.task}</p>
            <div className="fact-meta-row">
              {item.owner && <span className="fact-meta-pill">负责人 {item.owner}</span>}
              {item.deadline && <span className="fact-meta-pill">截止 {item.deadline}</span>}
            </div>
            {renderEvidenceList(item.evidenceRefs)}
          </article>
        ))}
      </div>
    )
  }

  const renderRisksTab = (analysis: SummaryStructuredAnalysis) => {
    if (analysis.risks.length === 0) {
      return renderEmptyState('暂无风险', '当前时间范围内没有识别出明确风险或阻塞。')
    }

    return (
      <div className="fact-list">
        {analysis.risks.map((item, index) => (
          <article key={`${item.text}-${index}`} className="fact-card">
            <div className="fact-card-header">
              <span className="fact-index">风险 {index + 1}</span>
              <div className="fact-badge-group">
                <span className={`fact-badge severity ${item.severity}`}>{getRiskSeverityLabel(item.severity)}</span>
                <span className="fact-badge confidence">可信度 {formatConfidence(item.confidence)}</span>
              </div>
            </div>
            <p className="fact-main-text">{item.text}</p>
            {renderEvidenceList(item.evidenceRefs)}
          </article>
        ))}
      </div>
    )
  }

  const renderEventsTab = (analysis: SummaryStructuredAnalysis) => {
    if (analysis.events.length === 0) {
      return renderEmptyState('暂无事件', '当前时间范围内没有识别出关键事件。')
    }

    return (
      <div className="fact-list">
        {analysis.events.map((item, index) => (
          <article key={`${item.text}-${item.date || 'nodate'}-${index}`} className="fact-card">
            <div className="fact-card-header">
              <span className="fact-index">事件 {index + 1}</span>
              <div className="fact-badge-group">
                {item.date && <span className="fact-badge subtle">{item.date}</span>}
                <span className="fact-badge confidence">可信度 {formatConfidence(item.confidence)}</span>
              </div>
            </div>
            <p className="fact-main-text">{item.text}</p>
            {renderEvidenceList(item.evidenceRefs)}
          </article>
        ))}
      </div>
    )
  }

  const renderQuestionsTab = (analysis: SummaryStructuredAnalysis) => {
    if (analysis.openQuestions.length === 0) {
      return renderEmptyState('暂无开放问题', '当前时间范围内没有遗留待确认的问题。')
    }

    return (
      <div className="question-list">
        {analysis.openQuestions.map((item, index) => (
          <article key={`${item.text}-${index}`} className="question-card">
            <span className="fact-index">问题 {index + 1}</span>
            <p className="fact-main-text">{item.text}</p>
          </article>
        ))}
      </div>
    )
  }

  const renderStructuredTabContent = (analysis: SummaryStructuredAnalysis) => {
    switch (resolvedActiveResultTab) {
      case 'overview':
        return renderOverviewTab(analysis)
      case 'decisions':
        return renderDecisionsTab(analysis)
      case 'todos':
        return renderTodosTab(analysis)
      case 'risks':
        return renderRisksTab(analysis)
      case 'events':
        return renderEventsTab(analysis)
      case 'questions':
        return renderQuestionsTab(analysis)
      default:
        return renderMarkdownResult()
    }
  }

  // 思考内容自动滚动
  useEffect(() => {
    if (thinkContentRef.current) {
      thinkContentRef.current.scrollTop = thinkContentRef.current.scrollHeight
    }
  }, [thinkText])

  useEffect(() => {
    if (qaContentRef.current) {
      qaContentRef.current.scrollTop = qaContentRef.current.scrollHeight
    }
  }, [qaMessages])

  useEffect(() => () => {
    if (summaryStreamFlushTimerRef.current !== null) {
      window.clearTimeout(summaryStreamFlushTimerRef.current)
      summaryStreamFlushTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    const cleanup = window.electronAPI.ai.onSessionQAEvent((event: SessionQAJobEvent) => {
      const assistantId = qaRequestMessageMapRef.current.get(event.requestId)
      if (!assistantId) return

      if (event.kind === 'progress' && event.progress) {
        setQaMessages(prev => prev.map(message => (
          message.id === assistantId
            ? {
                ...message,
                progressEvents: upsertQAProgressEvent(message.progressEvents, event.progress!),
                timelineEvents: upsertQATimelineItems(message.timelineEvents, event.timelineItems || [])
              }
            : message
        )))
        return
      }

      if (event.kind === 'chunk' && event.chunk) {
        const isThinkBoundaryChunk = event.chunk.includes('<think>') || event.chunk.includes('</think>')
        if (event.timelineItems?.length) {
          setQaMessages(prev => prev.map(message => (
            message.id === assistantId
              ? {
                  ...appendQAChunkToMessage(message, event.chunk!),
                  timelineEvents: upsertQATimelineItems(message.timelineEvents, event.timelineItems)
                }
              : message
          )))
          return
        }

        if (isThinkBoundaryChunk) {
          setQaMessages(prev => prev.map(message => (
            message.id === assistantId
              ? appendQAChunkToMessage(message, event.chunk!)
              : message
          )))
          return
        }

        const previous = qaChunkBufferRef.current.get(assistantId) || ''
        qaChunkBufferRef.current.set(assistantId, `${previous}${event.chunk}`)
        scheduleQAChunkFlush()
        return
      }

      if (event.kind === 'final' && event.result) {
        flushQAChunkBuffer()
        qaRequestMessageMapRef.current.delete(event.requestId)
        if (activeQARequestIdRef.current === event.requestId) {
          activeQARequestIdRef.current = null
          setActiveQARequestId(null)
          setIsAsking(false)
        }
        setQaMessages(prev => prev.map(message => (
          message.id === assistantId
            ? {
                ...message,
                timelineEvents: upsertQATimelineItems(message.timelineEvents, event.timelineItems || []),
                content: stripSummaryContent(event.result!.answerText),
                createdAt: event.result!.createdAt,
                isStreaming: false,
                isThinking: false,
                showThink: false,
                result: event.result
              }
            : message
        )))
        return
      }

      if (event.kind === 'error' || event.kind === 'cancelled') {
        flushQAChunkBuffer()
        qaRequestMessageMapRef.current.delete(event.requestId)
        if (activeQARequestIdRef.current === event.requestId) {
          activeQARequestIdRef.current = null
          setActiveQARequestId(null)
          setIsAsking(false)
        }
        const messageText = event.kind === 'cancelled' ? '已取消回答。' : (event.error || '问答失败')
        if (event.kind === 'error') setQaError(messageText)
        setQaMessages(prev => prev.map(message => (
          message.id === assistantId
            ? {
                ...message,
                timelineEvents: upsertQATimelineItems(message.timelineEvents, event.timelineItems || []),
                content: message.content || (event.kind === 'cancelled' ? messageText : ''),
                isStreaming: false,
                isThinking: false,
                showThink: false,
                error: event.kind === 'error' ? messageText : undefined
              }
            : message
        )))
      }
    })

    return () => {
      if (qaChunkFlushTimerRef.current !== null) {
        window.clearTimeout(qaChunkFlushTimerRef.current)
        qaChunkFlushTimerRef.current = null
      }
      qaChunkBufferRef.current.clear()
      cleanup()
    }
  }, [])

  useEffect(() => {
    const cleanup = window.electronAPI.ai.onSessionQAConversationUpdated((conversation: SessionQAConversationDetail) => {
      if (!conversation || conversation.sessionId !== sessionId) return
      upsertQAConversation(conversation)
      if (conversation.id === activeQAConversationId && !isAsking && qaMessages.length === 0) {
        setQaMessages(conversation.messages.map(mapStoredQAMessage))
      }
    })

    return cleanup
  }, [activeQAConversationId, isAsking, qaMessages.length, sessionId])

  // 从 URL 参数获取 sessionId
  useEffect(() => {
    // 从 query 参数获取（不是 hash 参数）
    const params = new URLSearchParams(window.location.search)
    const sid = params.get('sessionId')
    const name = params.get('sessionName')

    console.log('[AISummaryWindow] URL params:', { sid, name, search: window.location.search, hash: window.location.hash })

    if (sid) {
      setSessionId(sid)
      setSessionName(decodeURIComponent(name || sid))

      // 获取会话头像
      loadContactAvatar(sid)

      // 加载历史记录
      loadHistory(sid)
      loadQAConversations(sid)
      loadProfileMemoryState(sid)
    } else {
      setError('未能获取会话信息，请重新打开窗口')
    }

    // 加载默认时间范围
    window.electronAPI.config.get('aiDefaultTimeRange').then((days: any) => {
      if (days) setTimeRangeDays(days as number)
    })

    // 加载当前 AI 提供商的 logo
    loadAiProviderLogo()

    // 加载自己的微信头像，用于问 AI 的用户消息气泡
    loadMyAvatarUrl()
  }, [])

  useEffect(() => {
    const refsToLoad = qaMessages
      .filter((message) => expandedQAEvidenceIds.has(message.id))
      .flatMap((message) => message.result?.evidenceRefs || [])
      .slice(0, 32)

    refsToLoad.forEach((ref) => {
      const key = getEvidenceKey(ref)
      if (evidenceMessageMap[key] || evidenceMessageLoadingRef.current.has(key)) return

      evidenceMessageLoadingRef.current.add(key)
      window.electronAPI.chat.getMessage(ref.sessionId, ref.localId).then((result) => {
        if (result.success && result.message) {
          setEvidenceMessageMap((prev) => ({
            ...prev,
            [key]: result.message!
          }))
        }
      }).catch(() => {}).finally(() => {
        evidenceMessageLoadingRef.current.delete(key)
      })
    })
  }, [evidenceMessageMap, expandedQAEvidenceIds, qaMessages])

  // 加载联系人头像
  const loadContactAvatar = async (sid: string) => {
    try {
      const result = await window.electronAPI.chat.getContactAvatar(sid)
      if (result && result.avatarUrl) {
        setAvatarUrl(result.avatarUrl)
      }
    } catch (e) {
      console.error('加载头像失败:', e)
    }
  }

  const loadMyAvatarUrl = async () => {
    try {
      const result = await window.electronAPI.chat.getMyAvatarUrl()
      if (result?.success && result.avatarUrl) {
        setMyAvatarUrl(result.avatarUrl)
      }
    } catch (e) {
      console.error('加载自己的头像失败:', e)
    }
  }

  // 加载 AI 提供商 logo
  const loadAiProviderLogo = async () => {
    try {
      const { getAiProvider } = await import('../services/config')
      const { getAIProviders } = await import('../types/ai')

      const currentProvider = await getAiProvider()
      const providers = await getAIProviders()
      const providerInfo = providers.find(p => p.id === currentProvider)

      if (providerInfo) {
        setAiProviderInfo({
          id: providerInfo.id,
          logo: providerInfo.logo || '',
          displayName: providerInfo.displayName
        })
      }
    } catch (e) {
      console.error('加载 AI 提供商 logo 失败:', e)
    }
  }

  // 根据提供商 ID 加载提供商信息
  const loadProviderInfo = async (providerId: string) => {
    try {
      const { getAIProviders } = await import('../types/ai')
      const providers = await getAIProviders()
      const providerInfo = providers.find(p => p.id === providerId)

      if (providerInfo) {
        setResultProviderInfo({
          id: providerInfo.id,
          logo: providerInfo.logo || '',
          displayName: providerInfo.displayName
        })
      }
    } catch (e) {
      console.error('加载提供商信息失败:', e)
    }
  }

  // 加载历史记录
  const loadHistory = async (sid: string) => {
    try {
      const result = await window.electronAPI.ai.getSummaryHistory(sid, 10)
      if (result.success && result.history) {
        console.log('[AISummaryWindow] 历史记录:', result.history)
        setHistory(result.history)
      }
    } catch (e) {
      console.error('加载历史记录失败:', e)
    }
  }

  const loadProfileMemoryState = async (sid: string) => {
    try {
      const result = await window.electronAPI.ai.getSessionProfileMemoryState(sid)
      if (result.success && result.result) {
        setProfileMemoryState(result.result)
      }
    } catch (e) {
      console.error('加载画像记忆状态失败:', e)
    }
  }

  const upsertQAConversation = (conversation: SessionQAConversationSummary) => {
    setQaConversations(prev => {
      const next = [
        conversation,
        ...prev.filter(item => item.id !== conversation.id)
      ]
      return next.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
    })
  }

  const loadQAConversation = async (conversationId: number) => {
    setIsLoadingQAConversation(true)
    setQaError('')
    try {
      const result = await window.electronAPI.ai.getSessionQAConversation(conversationId)
      if (!result.success || !result.conversation) {
        throw new Error(result.error || '读取问答会话失败')
      }

      setActiveQAConversationId(result.conversation.id)
      setQaMessages(result.conversation.messages.map(mapStoredQAMessage))
      upsertQAConversation(result.conversation)
      setExpandedQAEvidenceIds(new Set())
      setExpandedQAProgressIds(new Set())
    } catch (e) {
      setQaError(String(e))
    } finally {
      setIsLoadingQAConversation(false)
    }
  }

  const loadQAConversations = async (sid: string, selectLatest = true) => {
    setIsLoadingQAConversations(true)
    try {
      const result = await window.electronAPI.ai.listSessionQAConversations(sid, 50)
      if (result.success && result.conversations) {
        setQaConversations(result.conversations)
        if (selectLatest) {
          if (result.conversations.length > 0) {
            await loadQAConversation(result.conversations[0].id)
          } else {
            setActiveQAConversationId(null)
            setQaMessages([])
          }
        }
      }
    } catch (e) {
      setQaError(String(e))
    } finally {
      setIsLoadingQAConversations(false)
    }
  }

  const createQAConversation = async () => {
    if (!sessionId) return null
    const result = await window.electronAPI.ai.createSessionQAConversation({
      sessionId,
      sessionName
    })
    if (!result.success || !result.conversation) {
      throw new Error(result.error || '创建问答会话失败')
    }
    upsertQAConversation(result.conversation)
    setActiveQAConversationId(result.conversation.id)
    setQaMessages([])
    setExpandedQAEvidenceIds(new Set())
    setExpandedQAProgressIds(new Set())
    window.setTimeout(() => qaInputRef.current?.focus(), 0)
    return result.conversation
  }

  const ensureActiveQAConversation = async () => {
    if (activeQAConversationId) return activeQAConversationId
    const conversation = await createQAConversation()
    return conversation?.id || null
  }

  const handleNewQAConversation = async () => {
    try {
      setQaError('')
      await createQAConversation()
    } catch (e) {
      setQaError(String(e))
    }
  }

  const handleRenameQAConversation = (conversation: SessionQAConversationSummary, event?: { stopPropagation: () => void }) => {
    event?.stopPropagation()
    setRenameQATargetId(conversation.id)
    setRenameQAValue(conversation.title)
    setShowRenameQADialog(true)
  }

  const confirmRenameQAConversation = async () => {
    if (!renameQATargetId || !renameQAValue.trim()) return
    try {
      const result = await window.electronAPI.ai.renameSessionQAConversation(renameQATargetId, renameQAValue.trim())
      if (!result.success) throw new Error(result.error || '重命名失败')
      await loadQAConversations(sessionId, false)
      setShowRenameQADialog(false)
      setRenameQATargetId(null)
      setRenameQAValue('')
    } catch (e) {
      setQaError(String(e))
    }
  }

  const handleDeleteQAConversation = (conversationId: number, event?: { stopPropagation: () => void }) => {
    event?.stopPropagation()
    setDeleteQATargetId(conversationId)
    setShowDeleteQADialog(true)
  }

  const confirmDeleteQAConversation = async () => {
    if (!deleteQATargetId) return
    try {
      const result = await window.electronAPI.ai.deleteSessionQAConversation(deleteQATargetId)
      if (!result.success) throw new Error(result.error || '删除失败')
      const remaining = qaConversations.filter(item => item.id !== deleteQATargetId)
      setQaConversations(remaining)
      if (activeQAConversationId === deleteQATargetId) {
        if (remaining.length > 0) {
          await loadQAConversation(remaining[0].id)
        } else {
          setActiveQAConversationId(null)
          setQaMessages([])
        }
      }
      setShowDeleteQADialog(false)
      setDeleteQATargetId(null)
    } catch (e) {
      setQaError(String(e))
    }
  }

  // 生成摘要
  const handleGenerate = async () => {
    if (!sessionId) return

    setIsGenerating(true)
    setError('')
    setSummaryText('')
    setThinkText('')
    summaryStreamBufferRef.current = { summary: '', think: '' }
    if (summaryStreamFlushTimerRef.current !== null) {
      window.clearTimeout(summaryStreamFlushTimerRef.current)
      summaryStreamFlushTimerRef.current = null
    }
    setIsThinking(false)
    setShowThink(true)
    setResult(null)
    setSummaryProgressEvents([])

    try {
      const { getAiApiKey, getAiProvider, getAiModel, getAiSummaryDetail, getAiEnableThinking, getAiSystemPromptPreset, getAiCustomSystemPrompt } = await import('../services/config')

      const apiKey = await getAiApiKey()
      if (!apiKey) {
        setError('请先在设置中配置 AI API 密钥')
        setIsGenerating(false)
        return
      }

      const provider = await getAiProvider()
      const model = await getAiModel()
      const detail = await getAiSummaryDetail()
      const enableThinking = await getAiEnableThinking()
      const systemPromptPreset = await getAiSystemPromptPreset()
      const customSystemPrompt = await getAiCustomSystemPrompt()

      // 监听流式 chunk（兼容旧 channel）
      let internalThinkMode = false
      const cleanupChunk = window.electronAPI.ai.onSummaryChunk((chunk: string) => {
        try {
          let content = chunk

          if (content.includes('<think')) {
            const parts = content.split('<think')
            if (parts[0]) appendSummaryStreamText('summary', parts[0])
            internalThinkMode = true
            setIsThinking(true)
            setShowThink(true)
            content = parts[1]
          }

          if (content.includes('</think')) {
            internalThinkMode = false
            setIsThinking(false)
            setShowThink(false)
            const parts = content.split('</think')
            appendSummaryStreamText('think', parts[0])
            appendSummaryStreamText('summary', parts[1] || '')
            return
          }

          if (internalThinkMode) {
            appendSummaryStreamText('think', content)
          } else {
            appendSummaryStreamText('summary', content)
          }
        } catch (e) {
          console.error('[AISummaryWindow] 处理流式输出出错:', e)
        }
      })

      // 监听摘要事件（新 channel）
      const cleanupEvent = window.electronAPI.ai.onSummaryEvent((event: any) => {
        if (event.kind === 'progress' && event.progress) {
          setSummaryProgressEvents(prev => {
            const idx = prev.findIndex(p => p.id === event.progress.id)
            if (idx >= 0) {
              const updated = [...prev]
              updated[idx] = { ...updated[idx], ...event.progress }
              return updated
            }
            return [...prev, event.progress]
          })
        }
        if (event.kind === 'final' && event.result) {
          flushSummaryStreamBuffer()
          cleanupChunk()
          cleanupEvent()
          activeSummaryRequestIdRef.current = null
          setDisplayedResult(event.result)
          loadProviderInfo(event.result.provider)
          loadHistory(sessionId)
          setIsGenerating(false)
          setSummaryProgressEvents([])
        }
        if (event.kind === 'error') {
          flushSummaryStreamBuffer()
          cleanupChunk()
          cleanupEvent()
          activeSummaryRequestIdRef.current = null
          setError('生成摘要失败: ' + (event.error || '未知错误'))
          setIsGenerating(false)
          setSummaryProgressEvents([])
        }
      })

      // 调用 Workflow（非阻塞，返回 requestId）
      const generateResult = await window.electronAPI.ai.generateSummary(
        sessionId,
        timeRangeDays,
        {
          provider: provider || 'zhipu',
          apiKey: apiKey as string,
          model: model || 'glm-4.5-flash',
          detail: detail || 'normal',
          systemPromptPreset,
          customSystemPrompt,
          customRequirement: customRequirement,
          sessionName: sessionName,
          enableThinking: enableThinking !== false
        }
      )

      if (!generateResult.success) {
        cleanupChunk()
        cleanupEvent()
        setError('生成摘要失败: ' + generateResult.error)
        setIsGenerating(false)
        return
      }

      activeSummaryRequestIdRef.current = generateResult.requestId || null
    } catch (e) {
      flushSummaryStreamBuffer()
      console.error('[AISummaryWindow] 生成异常:', e)
      setError('生成摘要失败: ' + String(e))
      setIsGenerating(false)
    }
  }

  const handleBuildProfileMemory = async () => {
    if (!sessionId || isBuildingProfileMemory) return

    setIsBuildingProfileMemory(true)
    setProfileMemoryMessage('')
    setError('')
    setQaError('')

    try {
      const { getAiApiKey, getAiProvider, getAiModel } = await import('../services/config')
      const provider = await getAiProvider()
      const apiKey = await getAiApiKey()
      const model = await getAiModel()

      if (!apiKey && provider !== 'ollama') {
        throw new Error('请先在设置中配置 AI API 密钥')
      }

      const response = await window.electronAPI.ai.buildSessionProfileMemory({
        sessionId,
        sessionName,
        provider: provider || 'zhipu',
        apiKey: apiKey || '',
        model: model || 'glm-4.5-flash'
      })

      if (!response.success || !response.result) {
        throw new Error(response.error || '生成画像失败')
      }

      setProfileMemoryState(response.result)
      setProfileMemoryMessage(`画像已更新：${new Date(response.result.updatedAt || Date.now()).toLocaleString('zh-CN')}`)
    } catch (e) {
      const message = String(e)
      setProfileMemoryMessage(message)
      setProfileMemoryState(prev => prev ? { ...prev, isRunning: false, lastError: message } : prev)
      if (workspaceMode === 'ask') {
        setQaError(`画像生成失败：${message}`)
      } else {
        setError(`画像生成失败：${message}`)
      }
    } finally {
      setIsBuildingProfileMemory(false)
    }
  }

  const runAskQuestion = async (question: string) => {
    if (!sessionId || !question || isAsking) return

    setQaInput('')
    setQaError('')
    setIsAsking(true)

    const historyForRequest = getQAHistory(qaMessages)
    let conversationId: number | null = null
    try {
      conversationId = await ensureActiveQAConversation()
    } catch (e) {
      setQaError(String(e))
      setIsAsking(false)
      return
    }
    if (!conversationId) {
      setQaError('创建问答会话失败')
      setIsAsking(false)
      return
    }
    const requestId = `qa-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const userMessage: QAMessage = {
      id: buildMessageId(),
      role: 'user',
      content: question,
      createdAt: Date.now()
    }
    const assistantId = buildMessageId()
    const assistantCreatedAt = Date.now()
    const initialTimeline = createLocalQATimelineProgress(requestId, assistantCreatedAt)
    const assistantMessage: QAMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: assistantCreatedAt,
      isStreaming: true,
      requestId,
      progressEvents: [initialTimeline.progress],
      timelineEvents: [initialTimeline.timelineItem]
    }

    qaRequestMessageMapRef.current.set(requestId, assistantId)
    activeQARequestIdRef.current = requestId
    setActiveQARequestId(requestId)
    setQaMessages(prev => [...prev, userMessage, assistantMessage])

    try {
      const { getAiApiKey, getAiProvider, getAiModel, getAiEnableThinking } = await import('../services/config')
      const apiKey = await getAiApiKey()

      if (!apiKey) {
        throw new Error('请先在设置中配置 AI API 密钥')
      }

      const provider = await getAiProvider()
      const model = await getAiModel()
      const enableThinking = await getAiEnableThinking()

      const response = await window.electronAPI.ai.startSessionQuestion({
        requestId,
        conversationId,
        sessionId,
        sessionName,
        question,
        summaryText: result?.summaryText,
        structuredAnalysis: result?.structuredAnalysis,
        history: historyForRequest,
        provider: provider || 'zhipu',
        apiKey: apiKey as string,
        model: model || 'glm-4.5-flash',
        enableThinking: enableThinking !== false
      })

      if (!response.success || !response.requestId) {
        throw new Error(response.error || '问答任务启动失败')
      }
      if (response.conversationId && response.conversationId !== activeQAConversationId) {
        setActiveQAConversationId(response.conversationId)
      }
    } catch (e) {
      const message = String(e)
      const failedAt = Date.now()
      const failedProgress: SessionQAProgressEvent = {
        id: 'job-start',
        stage: 'intent',
        status: 'failed',
        title: '问答任务未启动',
        displayName: '问答任务未启动',
        nodeName: '问答任务未启动',
        detail: message,
        source: 'model',
        requestId,
        createdAt: failedAt
      }
      const failedTimelineItem: SessionQATimelineItem = {
        type: 'progress',
        id: `progress:${failedProgress.id}`,
        order: 0,
        createdAt: failedAt,
        requestId,
        channel: 'answer',
        event: failedProgress
      }
      setQaError(message)
      qaRequestMessageMapRef.current.delete(requestId)
      if (activeQARequestIdRef.current === requestId) {
        activeQARequestIdRef.current = null
        setActiveQARequestId(null)
      }
      setQaMessages(prev => prev.map(item => (
        item.id === assistantId
          ? {
              ...item,
              content: '',
              progressEvents: upsertQAProgressEvent(item.progressEvents, failedProgress),
              timelineEvents: upsertQATimelineItems(item.timelineEvents, [failedTimelineItem]),
              isStreaming: false,
              error: message
            }
          : item
      )))
      setIsAsking(false)
    }
  }

  const handleAskQuestion = async () => {
    const question = qaInput.trim()
    if (!sessionId || !question || isAsking) return

    setQaError('')
    await runAskQuestion(question)
  }

  const handleCancelAsk = async () => {
    const requestId = activeQARequestIdRef.current || activeQARequestId
    if (!requestId) return
    try {
      await window.electronAPI.ai.cancelSessionQuestion(requestId)
    } catch (e) {
      setQaError(String(e))
    }
  }

  // 删除历史记录
  const handleDeleteHistory = (id: number, e: React.MouseEvent) => {
    e.stopPropagation()
    console.log('[AISummaryWindow] 删除记录:', id)
    setDeleteTargetId(id)
    setShowDeleteDialog(true)
  }

  // 确认删除
  const confirmDelete = async () => {
    if (!deleteTargetId) return

    console.log('[AISummaryWindow] 确认删除:', deleteTargetId)

    try {
      const deleteResult = await window.electronAPI.ai.deleteSummary(deleteTargetId)
      if (deleteResult.success) {
        console.log('[AISummaryWindow] 删除成功')
        // 重新加载历史记录
        await loadHistory(sessionId)
        // 如果删除的是当前显示的记录，清空显示
        if (result && result.id === deleteTargetId) {
          resetResultView()
        }
        setShowDeleteDialog(false)
        setDeleteTargetId(null)
      } else {
        alert('删除失败: ' + deleteResult.error)
      }
    } catch (e) {
      console.error('删除失败:', e)
      alert('删除失败: ' + String(e))
    }
  }

  // 重命名历史记录
  const handleRenameHistory = (id: number, currentName: string, e: React.MouseEvent) => {
    e.stopPropagation()
    console.log('[AISummaryWindow] 重命名记录:', id, currentName)
    setRenameTargetId(id)
    setRenameValue(currentName)
    setShowRenameDialog(true)
  }

  // 确认重命名
  const confirmRename = async () => {
    if (!renameTargetId || !renameValue.trim()) return

    console.log('[AISummaryWindow] 确认重命名:', renameTargetId, renameValue)

    try {
      const renameResult = await (window.electronAPI.ai as any).renameSummary(renameTargetId, renameValue.trim())
      if (renameResult.success) {
        console.log('[AISummaryWindow] 重命名成功')
        // 重新加载历史记录
        await loadHistory(sessionId)
        // 如果重命名的是当前显示的记录，更新显示
        if (result && result.id === renameTargetId) {
          setResult({ ...result, customName: renameValue.trim() } as SummaryResult)
        }
        setShowRenameDialog(false)
        setRenameTargetId(null)
        setRenameValue('')
      } else {
        alert('重命名失败: ' + renameResult.error)
      }
    } catch (e) {
      console.error('重命名失败:', e)
      alert('重命名失败: ' + String(e))
    }
  }

  // 返回历史记录列表
  const handleBackToHistory = () => {
    resetResultView()
  }

  const shouldRenderQABubble = (message: QAMessage) => {
    if (message.role === 'user') return true
    return Boolean(
      message.error ||
      message.thinkContent ||
      message.content ||
      (message.result?.evidenceRefs?.length || 0) > 0 ||
      (message.isStreaming && (!message.progressEvents || message.progressEvents.length === 0))
    )
  }

  const renderSummaryHistorySidebar = () => (
    <section className="sidebar-record-section">
      <div className="sidebar-record-header">
        <span>摘要记录</span>
        <span className="sidebar-record-count">{history.length}</span>
      </div>

      <div className="sidebar-record-list">
        {history.length === 0 ? (
          <div className="sidebar-empty-state">暂无摘要记录</div>
        ) : (
          history.map((item) => {
            const title = item.customName || getDefaultSummaryName(item.timeRangeDays)
            const isActive = result?.id === item.id

            return (
              <div
                key={item.id}
                className={`sidebar-record-item summary-record ${isActive ? 'active' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => {
                  setDisplayedResult(item)
                  loadProviderInfo(item.provider)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    setDisplayedResult(item)
                    loadProviderInfo(item.provider)
                  }
                }}
              >
                <span className="sidebar-record-title">{title}</span>
                <span className="sidebar-record-preview">{getTimeRangeDisplay(item.timeRangeDays)}</span>
                <span className="sidebar-record-meta">
                  <span>{formatCreatedAt(item.createdAt)}</span>
                  <span>{item.messageCount} 条</span>
                </span>
                <span className="sidebar-record-actions">
                  <button
                    type="button"
                    className="sidebar-record-action"
                    onClick={(event) => handleRenameHistory(item.id!, title, event)}
                    data-tooltip="重命名"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    className="sidebar-record-action danger"
                    onClick={(event) => handleDeleteHistory(item.id!, event)}
                    data-tooltip="删除"
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </div>
            )
          })
        )}
      </div>
    </section>
  )

  const renderQAConversationSidebar = () => (
    <section className="sidebar-record-section">
      <div className="sidebar-record-header">
        <span>问 AI 会话</span>
        <button
          type="button"
          className="sidebar-record-new"
          onClick={handleNewQAConversation}
          disabled={isAsking}
          data-tooltip="新建会话"
        >
          <Plus size={15} />
        </button>
      </div>

      <div className="sidebar-record-list">
        {isLoadingQAConversations ? (
          <div className="sidebar-empty-state loading">
            <Loader2 size={14} className="spinner" />
            <span>加载中...</span>
          </div>
        ) : qaConversations.length === 0 ? (
          <div className="sidebar-empty-state">暂无历史会话</div>
        ) : (
          qaConversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              className={`sidebar-record-item qa-record ${activeQAConversationId === conversation.id ? 'active' : ''}`}
              onClick={() => loadQAConversation(conversation.id)}
              disabled={isAsking && activeQAConversationId !== conversation.id}
            >
              <span className="sidebar-record-title">{conversation.title}</span>
              <span className="sidebar-record-preview">
                {conversation.lastMessagePreview || '新对话'}
              </span>
              <span className="sidebar-record-meta">
                <span>{formatCreatedAt(conversation.lastMessageAt || conversation.updatedAt)}</span>
                <span>{conversation.messageCount} 条</span>
              </span>
              <span className="sidebar-record-actions">
                <span
                  role="button"
                  tabIndex={0}
                  className="sidebar-record-action"
                  onClick={(event) => handleRenameQAConversation(conversation, event)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') handleRenameQAConversation(conversation, event)
                  }}
                  data-tooltip="重命名"
                >
                  <Pencil size={12} />
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  className="sidebar-record-action danger"
                  onClick={(event) => handleDeleteQAConversation(conversation.id, event)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') handleDeleteQAConversation(conversation.id, event)
                  }}
                  data-tooltip="删除"
                >
                  <Trash2 size={12} />
                </span>
              </span>
            </button>
          ))
        )}
      </div>
    </section>
  )

  const renderSidebarContent = () => (
    <>
      <div className="sidebar-mode-tabs" role="tablist" aria-label="AI 工作模式">
        <button
          type="button"
          className={`sidebar-mode-tab ${workspaceMode === 'summary' ? 'active' : ''}`}
          onClick={() => setWorkspaceMode('summary')}
        >
          <LayoutDashboard size={15} />
          <span>智能摘要</span>
        </button>
        <button
          type="button"
          className={`sidebar-mode-tab ${workspaceMode === 'ask' ? 'active' : ''}`}
          onClick={() => {
            if (isGenerating) return
            setWorkspaceMode('ask')
            setTimeout(() => qaInputRef.current?.focus(), 0)
          }}
          disabled={isGenerating}
        >
          <MessageCircle size={15} />
          <span>对话问答</span>
        </button>
      </div>

      {workspaceMode === 'summary'
        ? renderSummaryHistorySidebar()
        : renderQAConversationSidebar()}
    </>
  )

  const renderAskPanel = () => (
    <div className="qa-panel">
      <div className="qa-thread" ref={qaContentRef}>
        {isLoadingQAConversation ? (
          <div className="qa-empty">
            <Loader2 size={24} className="spinner" />
            <p>正在加载问答会话...</p>
          </div>
        ) : qaMessages.length === 0 ? (
          <div className="qa-empty">
            <MessageCircle size={28} />
            <p>{activeQAConversationId ? '这个问答会话还没有消息' : '新建会话，或直接问一个关于当前聊天的问题'}</p>
          </div>
        ) : (
          qaMessages.map((message) => (
            <article key={message.id} className={`qa-message ${message.role}`}>
              <div className="qa-avatar">
                {renderQAAvatar(message)}
              </div>
              <div className="qa-message-body">
                {message.role === 'assistant' ? (
                  renderQATimeline(message)
                ) : shouldRenderQABubble(message) && (
                  <div className="qa-bubble">
                    <p>{message.content}</p>
                  </div>
                )}
              </div>
            </article>
          ))
        )}
      </div>

      {qaError && <div className="qa-error-banner">{qaError}</div>}

      <div className="qa-composer">
        <textarea
          ref={qaInputRef}
          value={qaInput}
          placeholder="给 AI 发送消息..."
          rows={1}
          onChange={(event) => setQaInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              if (qaInput.trim() && !isAsking) {
                handleAskQuestion()
              }
            }
          }}
        />
        <button
          className="qa-send-btn"
          type="button"
          onClick={isAsking ? handleCancelAsk : handleAskQuestion}
          disabled={!isAsking && !qaInput.trim()}
          aria-label={isAsking ? '取消回答' : '发送消息'}
          data-tooltip={isAsking ? '取消回答' : '发送消息'}
        >
          {isAsking ? <X size={16} strokeWidth={2.5} /> : <ArrowUp size={18} strokeWidth={2.6} />}
        </button>
      </div>

      {renderEvidenceContextPanel()}
    </div>
  )

  useEffect(() => {
    if (qaInputRef.current) {
      qaInputRef.current.style.height = 'auto'
      if (qaInput) {
        qaInputRef.current.style.height = `${Math.min(qaInputRef.current.scrollHeight, 200)}px`
      }
    }
  }, [qaInput])

  const availableResultTabs = getAvailableResultTabs(result)
  const resolvedActiveResultTab = availableResultTabs.some((tab) => tab.id === activeResultTab)
    ? activeResultTab
    : getDefaultResultTab(result)
  const canUseMarkdownActions = Boolean(result) && (!result?.structuredAnalysis || resolvedActiveResultTab === 'markdown')

  return (
    <div className={`ai-summary-window ${isMac ? 'is-mac' : 'is-win'}`}>
      {/* 自定义标题栏 */}
      <div className="title-bar">
        {isMac && <div className="title-bar-leading-spacer" aria-hidden="true" />}

        <div className="title-bar-center">
          <div className="title-content">
            {avatarUrl && (
              <img src={avatarUrl} alt="" className="session-avatar" />
            )}
            {aiProviderInfo && (
              <>
                <span className="multiply-symbol">×</span>
                <div className="ai-provider-badge">
                  <AIProviderLogo
                    providerId={aiProviderInfo.id}
                    logo={aiProviderInfo.logo}
                    alt={aiProviderInfo.displayName}
                    className="ai-provider-logo"
                    size={24}
                  />
                </div>
              </>
            )}
            <span className="session-name">{sessionName}</span>
          </div>

          {result && (
            <span className="message-count">{result.messageCount}条</span>
          )}
        </div>

        <div className="title-actions">
          <button
            className="title-btn"
            onClick={handleBuildProfileMemory}
            disabled={!sessionId || isGenerating || isAsking || isBuildingProfileMemory}
            data-tooltip={isBuildingProfileMemory
              ? '正在生成数字分身画像'
              : profileMemoryState?.profileCount
                ? '更新数字分身画像'
                : '生成数字分身画像'}
          >
            {isBuildingProfileMemory ? <Loader2 className="spinner" size={14} /> : <User size={14} />}
          </button>
          {profileMemoryMessage && !isBuildingProfileMemory && (
            <div
              className={`profile-memory-status ${profileMemoryState?.lastError ? 'error' : 'success'}`}
              data-tooltip={profileMemoryMessage}
            >
              {profileMemoryState?.lastError ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
            </div>
          )}
          {isGenerating && (
            <div className="generating-status" data-tooltip="正在生成摘要...">
              <Loader2 className="spinner" size={16} />
            </div>
          )}
          {isAsking && (
            <button className="title-btn" onClick={handleCancelAsk} data-tooltip="取消回答">
              <X size={14} />
            </button>
          )}
          {isAsking && (
            <div className="generating-status" data-tooltip="正在回答...">
              <Loader2 className="spinner" size={16} />
            </div>
          )}

          {workspaceMode === 'summary' && result && !isGenerating && (
            <>
              <button className="title-btn" onClick={handleBackToHistory} data-tooltip="返回记录列表">
                <ArrowLeft size={14} />
              </button>
              {canUseMarkdownActions && (
                <>
                  <button
                    className="title-btn"
                    onClick={() => {
                      if (result.summaryText) {
                        navigator.clipboard.writeText(getSummaryPlainText(result.summaryText))
                      }
                    }}
                    data-tooltip="复制摘要"
                  >
                    <Copy size={14} />
                  </button>
                  <button
                    className="title-btn"
                    onClick={async () => {
                      if (!result.summaryText) return
                      try {
                        const fileName = `AI摘要_${sessionName}_${new Date().toLocaleDateString()}.txt`
                        const blob = new Blob([result.summaryText], { type: 'text/plain' })
                        const url = URL.createObjectURL(blob)
                        const a = document.createElement('a')
                        a.href = url
                        a.download = fileName
                        a.click()
                        URL.revokeObjectURL(url)
                      } catch (e) {
                        console.error('导出失败:', e)
                      }
                    }}
                    data-tooltip="导出文本"
                  >
                    <Download size={14} />
                  </button>
                </>
              )}
              <button className="title-btn" onClick={resetResultView} data-tooltip="重新生成">
                <RefreshCw size={14} />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="app-layout">
        <aside className="sidebar">
          {renderSidebarContent()}
        </aside>

        <main className="main-content">
          <div className="workspace-container">
            <div className="content">

        {workspaceMode === 'ask' && !isGenerating && renderAskPanel()}

        {workspaceMode === 'summary' && !result && !isGenerating && (
          <div className="setup-panel">
            <div className="time-range-section">
              <h3>选择时间范围</h3>
              <div className="time-range-grid">
                {TIME_RANGE_OPTIONS.map(option => (
                  <label
                    key={option.days}
                    className={`time-range-card ${timeRangeDays === option.days ? 'active' : ''}`}
                  >
                    <input
                      type="radio"
                      name="timeRange"
                      value={option.days}
                      checked={timeRangeDays === option.days}
                      onChange={() => {
                        setTimeRangeDays(option.days)
                        setCustomDays('')
                      }}
                    />
                    <span className="range-label">{option.label}</span>
                  </label>
                ))}
              </div>

              <div className="custom-days-input">
                <label>自定义天数：</label>
                <input
                  type="number"
                  min="1"
                  placeholder="输入天数"
                  value={customDays}
                  onChange={(e) => {
                    const value = e.target.value
                    setCustomDays(value)
                    if (value && parseInt(value) > 0) {
                      setTimeRangeDays(parseInt(value))
                    }
                  }}
                />
              </div>

              <h3>自定义要求（可选）</h3>
              <textarea
                className="custom-requirement"
                placeholder="例如：重点关注工作相关的讨论、提取所有待办事项、总结技术问题..."
                value={customRequirement}
                onChange={(e) => setCustomRequirement(e.target.value)}
                rows={3}
              />

              {error && (
                <div className="error-message">{error}</div>
              )}

              <button
                className="generate-button"
                onClick={handleGenerate}
                disabled={!sessionId}
              >
                <Send size={16} />
                <span>开始生成摘要</span>
              </button>
            </div>

          </div>
        )}

        {workspaceMode === 'summary' && isGenerating && (
          <div className="generating-panel">
            {/* 进度可视化 */}
            {summaryProgressEvents.length > 0 && (
              <section className="summary-progress-section">
                <div className="summary-progress-header">
                  <Loader2 size={16} className="animate-spin" />
                  <span>正在生成摘要</span>
                </div>
                <div className="qa-progress-timeline">
                  <div className="qa-progress-axis">
                    {summaryProgressEvents.map((event, index) => renderQAProgressCard(event, `summary-progress:${event.id}:${index}`))}
                  </div>
                </div>
              </section>
            )}
            {summaryProgressEvents.length === 0 && !summaryText && !thinkText && (
              <div className="loading-hint">
                <Loader2 className="loading-spinner" size={32} />
                <p className="loading-text">正在准备数据...</p>
                <p className="loading-subtext">正在从数据库读取消息并构建提示词</p>
              </div>
            )}

            <div className="summary-preview">
              {/* 思考过程 - 生成时显示 */}
              {thinkText && (
                <div className={`think-panel ${!showThink ? 'collapsed' : ''} ${isThinking ? 'thinking' : ''}`}>
                  <div className="think-header" onClick={() => setShowThink(!showThink)}>
                    <div className="think-title">
                      {isThinking ? (
                        <LoaderPinwheel
                          size={14}
                          className="think-icon animate-spin"
                        />
                      ) : (
                        <Atom
                          size={14}
                          className="think-icon"
                        />
                      )}
                      <span>{isThinking ? '深度思考中...' : '深度思考'}</span>
                    </div>
                    <ChevronDown
                      size={16}
                      className={`toggle-icon ${showThink ? 'expanded' : ''}`}
                    />
                  </div>
                  <div
                    className="think-content markdown-body"
                    ref={thinkContentRef}
                    dangerouslySetInnerHTML={renderMarkdown(thinkText)}
                  />
                </div>
              )}

              <div
                className="summary-text-content markdown-body"
                dangerouslySetInnerHTML={renderMarkdown(summaryText)}
              />
            </div>
          </div>
        )}

        {workspaceMode === 'summary' && result && !isGenerating && (
          <div className="result-panel">
            <div className="result-tabs" role="tablist" aria-label="摘要结果视图">
              {availableResultTabs.map((tab) => {
                const Icon = tab.icon
                return (
                  <button
                    key={tab.id}
                    type="button"
                    className={`result-tab-btn ${resolvedActiveResultTab === tab.id ? 'active' : ''}`}
                    onClick={() => setActiveResultTab(tab.id)}
                  >
                    <Icon size={15} />
                    <span>{tab.label}</span>
                  </button>
                )
              })}
            </div>

            {!result.structuredAnalysis && (
              <div className="result-note">
                该记录暂无结构化分析，当前仅展示 Markdown 摘要。
              </div>
            )}

            <div className="result-content">
              {result.structuredAnalysis
                ? renderStructuredTabContent(result.structuredAnalysis)
                : renderMarkdownResult()}
            </div>
          </div>
        )}
      </div>
          </div>
        </main>
      </div>

      {/* 删除确认对话框 */}
      {showDeleteDialog && (
        <div className="dialog-overlay" onClick={() => setShowDeleteDialog(false)}>
          <div className="dialog-box" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header">
              <h3>确认删除</h3>
            </div>
            <div className="dialog-content">
              <p>确定要删除这条摘要记录吗？此操作无法撤销。</p>
            </div>
            <div className="dialog-actions">
              <button className="dialog-btn cancel-btn" onClick={() => setShowDeleteDialog(false)}>
                取消
              </button>
              <button className="dialog-btn confirm-btn delete" onClick={confirmDelete}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 重命名对话框 */}
      {showRenameDialog && (
        <div className="dialog-overlay" onClick={() => setShowRenameDialog(false)}>
          <div className="dialog-box" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header">
              <h3>重命名摘要</h3>
            </div>
            <div className="dialog-content">
              <input
                type="text"
                className="rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder="请输入新名称"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    confirmRename()
                  } else if (e.key === 'Escape') {
                    setShowRenameDialog(false)
                  }
                }}
              />
            </div>
            <div className="dialog-actions">
              <button className="dialog-btn cancel-btn" onClick={() => setShowRenameDialog(false)}>
                取消
              </button>
              <button className="dialog-btn confirm-btn" onClick={confirmRename}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteQADialog && (
        <div className="dialog-overlay" onClick={() => setShowDeleteQADialog(false)}>
          <div className="dialog-box" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header">
              <h3>确认删除</h3>
            </div>
            <div className="dialog-content">
              <p>确定要删除这个问 AI 会话吗？此操作无法撤销。</p>
            </div>
            <div className="dialog-actions">
              <button className="dialog-btn cancel-btn" onClick={() => setShowDeleteQADialog(false)}>
                取消
              </button>
              <button className="dialog-btn confirm-btn delete" onClick={confirmDeleteQAConversation}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {showRenameQADialog && (
        <div className="dialog-overlay" onClick={() => setShowRenameQADialog(false)}>
          <div className="dialog-box" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header">
              <h3>重命名问 AI 会话</h3>
            </div>
            <div className="dialog-content">
              <input
                type="text"
                className="rename-input"
                value={renameQAValue}
                onChange={(e) => setRenameQAValue(e.target.value)}
                placeholder="请输入新标题"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    confirmRenameQAConversation()
                  } else if (e.key === 'Escape') {
                    setShowRenameQADialog(false)
                  }
                }}
              />
            </div>
            <div className="dialog-actions">
              <button className="dialog-btn cancel-btn" onClick={() => setShowRenameQADialog(false)}>
                取消
              </button>
              <button className="dialog-btn confirm-btn" onClick={confirmRenameQAConversation}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default AISummaryWindow
