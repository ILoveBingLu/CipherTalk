import { useState, useEffect, useRef } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
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
  LayoutDashboard,
  ListTodo,
  Loader2,
  LoaderPinwheel,
  MessageCircle,
  RefreshCw,
  Send,
  Trash2,
  User,
  X,
  type LucideIcon
} from 'lucide-react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  TIME_RANGE_OPTIONS,
  type SessionQAHistoryMessage,
  type SessionQAProgressEvent,
  type SessionQAResult,
  type SummaryEvidenceRef,
  type SummaryResult,
  type SummaryStructuredAnalysis
} from '../types/ai'
import type { Message } from '../types/models'
import { usePlatformInfo } from '../hooks/usePlatformInfo'
import AIProviderLogo from '../components/ai/AIProviderLogo'
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

function getEvidenceSender(ref: SummaryEvidenceRef) {
  return ref.senderDisplayName || ref.senderUsername || '未知发送人'
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

function compareMessagesByTime(a: Message, b: Message) {
  if (a.sortSeq !== b.sortSeq) return a.sortSeq - b.sortSeq
  if (a.createTime !== b.createTime) return a.createTime - b.createTime
  return a.localId - b.localId
}

function upsertQAProgressEvent(
  events: SessionQAProgressEvent[] = [],
  event: SessionQAProgressEvent
) {
  const index = events.findIndex((item) => item.id === event.id)
  if (index < 0) {
    return [...events, event]
  }

  return events.map((item, itemIndex) => itemIndex === index ? event : item)
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
  const [qaMessages, setQaMessages] = useState<QAMessage[]>([])
  const [isAsking, setIsAsking] = useState(false)
  const [qaError, setQaError] = useState('')
  const [copiedEvidenceKey, setCopiedEvidenceKey] = useState('')
  const [evidenceContext, setEvidenceContext] = useState<EvidenceContextState | null>(null)
  const [error, setError] = useState<string>('')
  const [history, setHistory] = useState<SummaryResult[]>([])
  const thinkContentRef = useRef<HTMLDivElement>(null)
  const qaContentRef = useRef<HTMLDivElement>(null)
  const qaInputRef = useRef<HTMLTextAreaElement>(null)

  // 对话框状态
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null)
  const [showRenameDialog, setShowRenameDialog] = useState(false)
  const [renameTargetId, setRenameTargetId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')

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
    .slice(-8)
    .map((message) => ({
      role: message.role,
      content: stripSummaryContent(message.content)
    }))

  const renderMarkdown = (text: string) => {
    const html = marked.parse(text) as string
    return { __html: DOMPurify.sanitize(html) }
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
              <span>{getEvidenceSender(ref)}</span>
            </div>
            <div className="evidence-preview">{ref.previewText}</div>
          </div>
        ))}
      </div>
    )
  }

  const buildEvidenceCopyText = (ref: SummaryEvidenceRef) => [
    `时间：${formatEvidenceFullTime(ref.createTime)}`,
    `发送人：${getEvidenceSender(ref)}`,
    `内容：${ref.previewText}`,
    `消息游标：sessionId=${ref.sessionId}, localId=${ref.localId}, createTime=${ref.createTime}, sortSeq=${ref.sortSeq}`
  ].join('\n')

  const getContextMessageSender = (message: Message, fallbackRef?: SummaryEvidenceRef) => {
    if (message.isSend === 1) return '我'
    if (message.senderUsername) return message.senderUsername
    if (fallbackRef && isSameEvidenceMessage(message, fallbackRef)) return getEvidenceSender(fallbackRef)
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
      `证据：${formatEvidenceFullTime(ref.createTime)} ${getEvidenceSender(ref)}：${ref.previewText}`
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

  const renderQAEvidenceCards = (evidenceRefs?: SummaryEvidenceRef[]) => {
    const visibleEvidence = (evidenceRefs || []).slice(0, 8)

    if (visibleEvidence.length === 0) {
      return null
    }

    return (
      <section className="qa-evidence-cards" aria-label="回答证据">
        <div className="qa-evidence-heading">
          <span>回答证据</span>
          <span>{visibleEvidence.length} 条</span>
        </div>

        <div className="qa-evidence-card-list">
          {visibleEvidence.map((ref, index) => {
            const key = getEvidenceKey(ref)
            const isCopied = copiedEvidenceKey === key

            return (
              <article key={key} className="qa-evidence-card">
                <div className="qa-evidence-card-meta">
                  <span>#{index + 1}</span>
                  <span>{formatEvidenceTime(ref.createTime)}</span>
                  <span>{getEvidenceSender(ref)}</span>
                </div>
                <p className="qa-evidence-card-preview">{ref.previewText}</p>
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
      </section>
    )
  }

  const toggleQAThinkPanel = (messageId: string) => {
    setQaMessages(prev => prev.map(message => (
      message.id === messageId
        ? { ...message, showThink: !message.showThink }
        : message
    )))
  }

  const renderQAProgressStatusIcon = (event: SessionQAProgressEvent) => {
    if (event.status === 'running') {
      return <Loader2 size={13} className="spinner" />
    }

    if (event.status === 'failed') {
      return <AlertTriangle size={13} />
    }

    return <CheckCircle2 size={13} />
  }

  const getQAProgressStatusLabel = (status: SessionQAProgressEvent['status']) => {
    if (status === 'running') return '执行中'
    if (status === 'failed') return '失败'
    return '成功'
  }

  const getQAProgressTargetLabel = (event: SessionQAProgressEvent) => {
    if (event.toolName) {
      return `工具： ${event.toolName}`
    }
    return `阶段： ${event.title}`
  }

  const renderQAProgressEvents = (events?: SessionQAProgressEvent[]) => {
    if (!events || events.length === 0) {
      return null
    }

    return (
      <div className="qa-progress-list" aria-label="AI 工具执行轨迹">
        {events.map((event) => (
          <div key={event.id} className={`qa-progress-card ${event.stage} ${event.status}`}>
            <div className="qa-progress-icon">
              {renderQAProgressStatusIcon(event)}
            </div>
            <div className="qa-progress-content">
              <div className="qa-progress-title-row">
                <span className="qa-progress-title">
                  [{getQAProgressStatusLabel(event.status)}] {getQAProgressTargetLabel(event)}
                </span>
                {event.count !== undefined && (
                  <span className="qa-progress-count">{event.count}</span>
                )}
              </div>
              <p>{event.status === 'running' ? (event.detail || '执行中...') : (event.detail || '执行完成')}</p>
            </div>
            <ChevronRight size={16} className="qa-progress-chevron" aria-hidden="true" />
          </div>
        ))}
      </div>
    )
  }

  const renderQAThinkPanel = (message: QAMessage) => {
    if (!message.thinkContent) {
      return null
    }

    const expanded = message.showThink !== false

    return (
      <div className={`think-panel qa-think-panel ${!expanded ? 'collapsed' : ''} ${message.isThinking ? 'thinking' : ''}`}>
        <div className="think-header" onClick={() => toggleQAThinkPanel(message.id)}>
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
            <span>{getEvidenceSender(evidenceContext.ref)}</span>
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

                    return (
                      <article
                        key={getMessageKey(message)}
                        className={`qa-context-message ${isAnchor ? 'anchor' : ''}`}
                      >
                        <div className="qa-context-message-meta">
                          <span>{formatEvidenceTime(message.createTime)}</span>
                          <span>{getContextMessageSender(message, evidenceContext.ref)}</span>
                          {isAnchor && <strong>原消息</strong>}
                        </div>
                        <p>{getContextMessagePreview(message, evidenceContext.ref)}</p>
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

  // 生成摘要
  const handleGenerate = async () => {
    if (!sessionId) return

    setIsGenerating(true)
    setError('')
    setSummaryText('')
    setThinkText('')
    setIsThinking(false)
    setShowThink(true)
    setResult(null)

    try {
      // 检查 API 配置 - 使用新的配置服务
      const { getAiApiKey, getAiProvider, getAiModel, getAiSummaryDetail, getAiEnableThinking, getAiSystemPromptPreset, getAiCustomSystemPrompt } = await import('../services/config')

      const apiKey = await getAiApiKey()
      console.log('[AISummaryWindow] 当前 API Key:', apiKey ? '已配置' : '未配置', '长度:', apiKey?.length)

      if (!apiKey) {
        setError('请先在设置中配置 AI API 密钥')
        setIsGenerating(false)
        return
      }

      // 获取配置
      const provider = await getAiProvider()
      const model = await getAiModel()
      const detail = await getAiSummaryDetail()
      const enableThinking = await getAiEnableThinking()
      const systemPromptPreset = await getAiSystemPromptPreset()
      const customSystemPrompt = await getAiCustomSystemPrompt()

      console.log('[AISummaryWindow] 配置信息:', { provider, model, detail, enableThinking, systemPromptPreset })

      // 监听流式输出
      let internalThinkMode = false
      let chunkCount = 0

      const cleanup = window.electronAPI.ai.onSummaryChunk((chunk: string) => {
        try {
          chunkCount++
          if (chunkCount === 1) {
            console.log('[AISummaryWindow] 开始接收流式输出')
          }

          let content = chunk

          // 检测开始标签
          if (content.includes('<think>')) {
            const parts = content.split('<think>')
            // 如果有前置内容，先添加到摘要
            if (parts[0]) {
              setSummaryText(prev => prev + parts[0])
            }

            internalThinkMode = true
            setIsThinking(true)
            setShowThink(true)
            content = parts[1] // 取标签后的内容
          }

          // 检测结束标签
          if (content.includes('</think>')) {
            internalThinkMode = false
            setIsThinking(false)
            setShowThink(false) // 思考结束自动收起

            const parts = content.split('</think>')
            const thinkPart = parts[0]
            const summaryPart = parts[1] || ''

            setThinkText(prev => prev + thinkPart)
            setSummaryText(prev => prev + summaryPart)
            return
          }

          if (internalThinkMode) {
            setThinkText(prev => prev + content)
          } else {
            setSummaryText(prev => prev + content)
          }
        } catch (e) {
          console.error('[AISummaryWindow] 处理流式输出出错:', e)
        }
      })

      console.log('[AISummaryWindow] 开始调用 AI 生成摘要')

      // 调用 AI 服务生成摘要
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
          enableThinking: enableThinking !== false  // 默认启用
        }
      )

      console.log('[AISummaryWindow] AI 调用完成，接收到', chunkCount, '个数据块')
      console.log('[AISummaryWindow] 返回结果:', generateResult)

      cleanup()

      if (!generateResult.success) {
        console.error('[AISummaryWindow] 生成失败:', generateResult.error)
        setError('生成摘要失败: ' + generateResult.error)
        setIsGenerating(false)
        return
      }

      // 设置结果
      if (generateResult.result) {
        console.log('[AISummaryWindow] 生成成功:', generateResult.result)
        setDisplayedResult(generateResult.result)
        // 加载该结果对应的提供商信息
        await loadProviderInfo(generateResult.result.provider)
        // 重新加载历史记录
        await loadHistory(sessionId)
      } else {
        console.error('[AISummaryWindow] 生成结果为空')
        setError('生成摘要失败: 返回结果为空')
      }
      setIsGenerating(false)

    } catch (e) {
      console.error('[AISummaryWindow] 生成异常:', e)
      setError('生成摘要失败: ' + String(e))
      setIsGenerating(false)
    }
  }

  const handleAskQuestion = async () => {
    const question = qaInput.trim()
    if (!sessionId || !question || isAsking) return

    setQaInput('')
    setQaError('')
    setIsAsking(true)

    const historyForRequest = getQAHistory(qaMessages)
    const userMessage: QAMessage = {
      id: buildMessageId(),
      role: 'user',
      content: question,
      createdAt: Date.now()
    }
    const assistantId = buildMessageId()
    const assistantMessage: QAMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      isStreaming: true
    }

    setQaMessages(prev => [...prev, userMessage, assistantMessage])

    let cleanupChunk: (() => void) | undefined
    let cleanupProgress: (() => void) | undefined

    try {
      const { getAiApiKey, getAiProvider, getAiModel, getAiEnableThinking } = await import('../services/config')
      const apiKey = await getAiApiKey()

      if (!apiKey) {
        throw new Error('请先在设置中配置 AI API 密钥')
      }

      const provider = await getAiProvider()
      const model = await getAiModel()
      const enableThinking = await getAiEnableThinking()

      cleanupProgress = window.electronAPI.ai.onSessionQAProgress((event: SessionQAProgressEvent) => {
        setQaMessages(prev => prev.map(message => (
          message.id === assistantId
            ? { ...message, progressEvents: upsertQAProgressEvent(message.progressEvents, event) }
            : message
        )))
      })

      cleanupChunk = window.electronAPI.ai.onSessionQAChunk((chunk: string) => {
        setQaMessages(prev => prev.map(message => (
          message.id === assistantId
            ? appendQAChunkToMessage(message, chunk)
            : message
        )))
      })

      const response = await window.electronAPI.ai.askSessionQuestion({
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

      if (!response.success || !response.result) {
        throw new Error(response.error || '问答结果为空')
      }

      setQaMessages(prev => prev.map(message => (
        message.id === assistantId
          ? {
              ...message,
              content: stripSummaryContent(response.result!.answerText),
              createdAt: response.result!.createdAt,
              isStreaming: false,
              isThinking: false,
              showThink: false,
              result: response.result
            }
          : message
      )))
    } catch (e) {
      const message = String(e)
      setQaError(message)
      setQaMessages(prev => prev.map(item => (
        item.id === assistantId
          ? {
              ...item,
              content: '',
              isStreaming: false,
              error: message
            }
          : item
      )))
    } finally {
      cleanupChunk?.()
      cleanupProgress?.()
      setIsAsking(false)
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

  const renderAskPanel = () => (
    <div className="qa-panel">
      <div className="qa-thread" ref={qaContentRef}>
        {qaMessages.length === 0 ? (
          <div className="qa-empty">
            <MessageCircle size={28} />
            <p>问一个关于当前会话的问题</p>
          </div>
        ) : (
          qaMessages.map((message) => (
            <article key={message.id} className={`qa-message ${message.role}`}>
              <div className="qa-avatar">
                {renderQAAvatar(message)}
              </div>
              <div className="qa-message-body">
                {message.role === 'assistant' && renderQAProgressEvents(message.progressEvents)}
                {shouldRenderQABubble(message) && (
                  <div className="qa-bubble">
                    {message.role === 'assistant' ? (
                      <>
                        {message.error ? (
                          <div className="qa-error">{message.error}</div>
                        ) : (
                          <>
                            {renderQAThinkPanel(message)}
                            {message.content ? (
                              <div
                                className="qa-answer markdown-body"
                                dangerouslySetInnerHTML={renderMarkdown(message.content)}
                              />
                            ) : message.isStreaming && (!message.progressEvents || message.progressEvents.length === 0) ? (
                              <div className="qa-streaming-placeholder">
                                <Loader2 size={14} className="spinner" />
                                <span>正在检索上下文...</span>
                              </div>
                            ) : (
                              null
                            )}
                            {renderQAEvidenceCards(message.result?.evidenceRefs)}
                          </>
                        )}
                      </>
                    ) : (
                      <p>{message.content}</p>
                    )}
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
          placeholder="追问当前会话..."
          rows={2}
          disabled={isAsking}
          onChange={(event) => setQaInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              handleAskQuestion()
            }
          }}
        />
        <button
          className="qa-send-btn"
          type="button"
          onClick={handleAskQuestion}
          disabled={!qaInput.trim() || isAsking}
          data-tooltip="发送问题"
        >
          {isAsking ? <Loader2 size={16} className="spinner" /> : <Send size={16} />}
        </button>
      </div>

      {renderEvidenceContextPanel()}
    </div>
  )

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
          {isGenerating && (
            <div className="generating-status" data-tooltip="正在生成摘要...">
              <Loader2 className="spinner" size={16} />
            </div>
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

      <div className="content">
        {sessionId && !isGenerating && (
          <div className="workspace-mode-switch">
            <button
              type="button"
              className={`workspace-mode-btn ${workspaceMode === 'summary' ? 'active' : ''}`}
              onClick={() => setWorkspaceMode('summary')}
            >
              <LayoutDashboard size={15} />
              <span>摘要</span>
            </button>
            <button
              type="button"
              className={`workspace-mode-btn ${workspaceMode === 'ask' ? 'active' : ''}`}
              onClick={() => setWorkspaceMode('ask')}
            >
              <MessageCircle size={15} />
              <span>问 AI</span>
            </button>
          </div>
        )}

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

            {history.length > 0 && (
              <div className="history-section">
                <h3>历史记录</h3>
                <div className="history-list">
                  {history.map((item) => (
                    <div
                      key={item.id}
                      className="history-item"
                      onClick={() => {
                        setDisplayedResult(item)
                        loadProviderInfo(item.provider)
                      }}
                    >
                      <div className="history-header">
                        <span className="history-name">{item.customName || '自定义记录名'}</span>
                        <span className="history-date">
                          {new Date(item.createdAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}
                        </span>
                      </div>
                      <div className="history-range">{getTimeRangeDisplay(item.timeRangeDays)}</div>
                      <div className="history-info">
                        <span>{item.messageCount}条消息</span>
                        <span>¥{item.cost.toFixed(4)}</span>
                      </div>
                      <div className="history-actions">
                        <button
                          className="action-btn rename-btn"
                          onClick={(e) => handleRenameHistory(item.id!, item.customName || getDefaultSummaryName(item.timeRangeDays), e)}
                          data-tooltip="重命名"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
                          </svg>
                        </button>
                        <button
                          className="action-btn delete-btn"
                          onClick={(e) => handleDeleteHistory(item.id!, e)}
                          data-tooltip="删除"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {workspaceMode === 'summary' && isGenerating && (
          <div className="generating-panel">
            {/* 加载提示 - 在没有内容时显示 */}
            {!summaryText && !thinkText && (
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
    </div>
  )
}

export default AISummaryWindow
