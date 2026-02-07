import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Search, MessageSquare, AlertCircle, Loader2, RefreshCw, X, ChevronDown, Info, Calendar, Database, Hash, Image as ImageIcon, Play, Video, Copy, ZoomIn, CheckSquare, Check, Edit, Link, Sparkles, FileText, FileArchive, Users, Mic, CheckCircle, XCircle } from 'lucide-react'
import { useChatStore } from '../stores/chatStore'
import { useUpdateStatusStore } from '../stores/updateStatusStore'
import ChatBackground from '../components/ChatBackground'
import MessageContent from '../components/MessageContent'
import { getImageXorKey, getImageAesKey, getQuoteStyle } from '../services/config'
import { LRUCache } from '../utils/lruCache'
import type { ChatSession, Message } from '../types/models'
import { List, RowComponentProps } from 'react-window'
import './ChatPage.scss'

interface SessionRowData {
  sessions: ChatSession[]
  currentSessionId: string | null
  onSelect: (s: ChatSession) => void
  formatTime: (t: number) => string
}



interface ChatPageProps {
  // 保留接口以备将来扩展
}

interface SessionDetail {
  wxid: string
  displayName: string
  remark?: string
  nickName?: string
  alias?: string
  avatarUrl?: string
  messageCount: number
  firstMessageTime?: number
  latestMessageTime?: number
  messageTables: { dbName: string; tableName: string; count: number }[]
}

// 头像组件 - 支持骨架屏加载和懒加载
function SessionAvatar({ session, size = 48 }: { session: ChatSession; size?: number }) {
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [isVisible, setIsVisible] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const isGroup = session.username.includes('@chatroom')

  // 懒加载：使用 IntersectionObserver 检测头像是否进入可视区域
  useEffect(() => {
    if (!containerRef.current) return

    const element = containerRef.current

    // 如果没有 avatarUrl，不需要懒加载
    if (!session.avatarUrl) {
      setIsVisible(false)
      return
    }

    // 使用 IntersectionObserver 监听，不立即加载
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true)
            observer.disconnect()
          }
        })
      },
      {
        rootMargin: '50px', // 提前 50px 开始加载
        threshold: 0
      }
    )

    observer.observe(element)

    return () => {
      observer.disconnect()
    }
  }, [session.avatarUrl])

  // 当 avatarUrl 变化时重置加载状态（但保持 isVisible，避免闪烁）
  useEffect(() => {
    if (session.avatarUrl) {
      setImageLoaded(false)
      setImageError(false)
      // 不重置 isVisible，避免已经可见的头像重新隐藏
    }
  }, [session.avatarUrl])

  // 检查图片是否已经从缓存加载完成
  useEffect(() => {
    if (isVisible && session.avatarUrl && imgRef.current) {
      // 如果图片已经加载完成（可能是从缓存加载的）
      if (imgRef.current.complete && imgRef.current.naturalWidth > 0) {
        setImageLoaded(true)
        setImageError(false)
      }
    }
  }, [isVisible, session.avatarUrl])

  // 添加超时处理，避免一直显示骨架屏
  useEffect(() => {
    if (!isVisible || !session.avatarUrl || imageLoaded || imageError) return

    const timeoutId = setTimeout(() => {
      // 如果 5 秒后还没加载完成，检查图片状态
      if (imgRef.current) {
        if (imgRef.current.complete) {
          if (imgRef.current.naturalWidth > 0) {
            setImageLoaded(true)
          } else {
            setImageError(true)
          }
        }
      }
    }, 5000)

    return () => clearTimeout(timeoutId)
  }, [isVisible, session.avatarUrl, imageLoaded, imageError])

  const hasValidUrl = session.avatarUrl && !imageError
  const shouldLoadImage = hasValidUrl && isVisible

  return (
    <div
      ref={containerRef}
      className={`session-avatar ${isGroup ? 'group' : ''} ${shouldLoadImage && !imageLoaded && !imageError ? 'loading' : ''}`}
      style={{ width: size, height: size }}
    >
      {shouldLoadImage && !imageError ? (
        <>
          {!imageLoaded && (
            <div className="avatar-skeleton" />
          )}
          <img
            ref={imgRef}
            src={session.avatarUrl}
            alt=""
            className={imageLoaded ? 'loaded' : ''}
            style={{
              opacity: imageLoaded ? 1 : 0,
              transition: 'opacity 0.2s ease-in-out',
              position: imageLoaded ? 'relative' : 'absolute',
              zIndex: imageLoaded ? 1 : 0
            }}
            onLoad={() => {
              setImageLoaded(true)
              setImageError(false)
            }}
            onError={() => {
              setImageError(true)
              setImageLoaded(false)
            }}
            loading="lazy"
          />
        </>
      ) : (
        <div className="avatar-skeleton" />
      )}
    </div>
  )
}

// 会话列表行组件（使用 memo 优化性能）
const SessionRow = (props: RowComponentProps<SessionRowData>) => {
  const { index, style, sessions, currentSessionId, onSelect, formatTime } = props
  const session = sessions[index]

  return (
    <div
      style={style}
      className={`session-item ${currentSessionId === session.username ? 'active' : ''}`}
      onClick={() => onSelect(session)}
    >
      <SessionAvatar session={session} size={48} />
      <div className="session-info">
        <div className="session-top">
          <span className="session-name">{session.displayName || session.username}</span>
          <span className="session-time">{formatTime(session.lastTimestamp || session.sortTimestamp)}</span>
        </div>
        <div className="session-bottom">
          <span className="session-summary">
            {(() => {
              const summary = session.summary || '暂无消息'
              const firstLine = summary.split('\n')[0]
              const hasMoreLines = summary.includes('\n')
              return (
                <>
                  <MessageContent content={firstLine} disableLinks={true} />
                  {hasMoreLines && <span>...</span>}
                </>
              )
            })()}
          </span>
          {session.unreadCount > 0 && (
            <span className="unread-badge">
              {session.unreadCount > 99 ? '99+' : session.unreadCount}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function ChatPage(_props: ChatPageProps) {
  const [quoteStyle, setQuoteStyle] = useState<'default' | 'wechat'>('default')

  useEffect(() => {
    getQuoteStyle().then(setQuoteStyle).catch(console.error)
  }, [])

  const {
    isConnected,
    isConnecting,
    connectionError,
    sessions,
    filteredSessions,
    currentSessionId,
    isLoadingSessions,
    messages,
    isLoadingMessages,
    isLoadingMore,
    hasMoreMessages,
    searchKeyword,
    setConnected,
    setConnecting,
    setConnectionError,
    setSessions,
    setFilteredSessions,
    setCurrentSession,
    setLoadingSessions,
    setMessages,
    appendMessages,
    setLoadingMessages,
    setLoadingMore,
    setHasMoreMessages,
    setSearchKeyword,
    incrementSyncVersion
  } = useChatStore()

  const messageListRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<Message[]>([])
  const currentSessionIdRef = useRef<string | null>(null)
  const lastUpdateTimeRef = useRef<number>(0)
  const updateTimerRef = useRef<NodeJS.Timeout | null>(null)
  const updateStatusTimerRef = useRef<NodeJS.Timeout | null>(null)
  const isUserOperatingRef = useRef<boolean>(false) // 标记用户是否正在操作
  const [currentOffset, setCurrentOffset] = useState(0)

  // 更新状态管理
  const setIsUpdating = useUpdateStatusStore(state => state.setIsUpdating)
  const isUpdating = useUpdateStatusStore(state => state.isUpdating)
  const [myAvatarUrl, setMyAvatarUrl] = useState<string | undefined>(undefined)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(260)
  const [isResizing, setIsResizing] = useState(false)
  const [showDetailPanel, setShowDetailPanel] = useState(false)
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null)
  const [isLoadingDetail, setIsLoadingDetail] = useState(false)
  const [hasImageKey, setHasImageKey] = useState<boolean | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    message: Message
    session: ChatSession
    handlers?: {
      reTranscribe?: () => void
      editStt?: () => void
    }
  } | null>(null)

  const [isMenuClosing, setIsMenuClosing] = useState(false)

  const closeContextMenu = useCallback(() => {
    setIsMenuClosing(true)
  }, [])
  const [selectedMessages, setSelectedMessages] = useState<Set<number>>(new Set())
  const [showEnlargeView, setShowEnlargeView] = useState<{ message: Message; content: string } | null>(null)
  const [copyToast, setCopyToast] = useState(false)
  const [showMessageInfo, setShowMessageInfo] = useState<Message | null>(null) // 消息信息弹窗
  const [showDatePicker, setShowDatePicker] = useState(false) // 日期选择器弹窗
  const [selectedDate, setSelectedDate] = useState<string>('') // 选中的日期 (YYYY-MM-DD)
  const [viewDate, setViewDate] = useState(new Date()) // 日历当前显示的月份
  const [availableDates, setAvailableDates] = useState<Set<string>>(new Set()) // 当前月份有消息的日期
  const [isLoadingDates, setIsLoadingDates] = useState(false) // 加载日期状态
  const [isJumpingToDate, setIsJumpingToDate] = useState(false) // 正在跳转
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; left: number } | null>(null)
  const datePickerRef = useRef<HTMLDivElement>(null) // 日期选择器容器引用
  const dateButtonRef = useRef<HTMLButtonElement>(null) // 日期按钮引用
  
  // 批量语音转文字相关状态
  const [isBatchTranscribing, setIsBatchTranscribing] = useState(false)
  const [batchTranscribeProgress, setBatchTranscribeProgress] = useState({ current: 0, total: 0 })
  const [showBatchConfirm, setShowBatchConfirm] = useState(false)
  const [batchVoiceCount, setBatchVoiceCount] = useState(0) // 保存查询到的语音消息数量
  const [batchVoiceMessages, setBatchVoiceMessages] = useState<Message[] | null>(null) // 当前会话所有语音消息（用于按日期筛选）
  const [batchVoiceDates, setBatchVoiceDates] = useState<string[]>([]) // 有语音的日期列表 YYYY-MM-DD，仅展示可选项
  const [batchSelectedDates, setBatchSelectedDates] = useState<Set<string>>(new Set()) // 用户选中的要转写的日期
  const [showBatchProgress, setShowBatchProgress] = useState(false) // 显示进度对话框
  const [showBatchResult, setShowBatchResult] = useState(false) // 显示结果对话框
  const [batchResult, setBatchResult] = useState({ success: 0, fail: 0 }) // 转写结果

  // 检查图片密钥配置（XOR 和 AES 都需要配置）
  useEffect(() => {
    Promise.all([getImageXorKey(), getImageAesKey()]).then(([xorKey, aesKey]) => {
      setHasImageKey(Boolean(xorKey) && Boolean(aesKey))
    })
  }, [])

  // 加载当前用户头像
  const loadMyAvatar = useCallback(async () => {
    try {
      const result = await window.electronAPI.chat.getMyAvatarUrl()
      if (result.success && result.avatarUrl) {
        setMyAvatarUrl(result.avatarUrl)
      }
    } catch (e) {
      console.error('加载用户头像失败:', e)
    }
  }, [])

  // 加载会话详情
  const loadSessionDetail = useCallback(async (sessionId: string) => {
    setIsLoadingDetail(true)
    try {
      const result = await window.electronAPI.chat.getSessionDetail(sessionId)
      if (result.success && result.detail) {
        setSessionDetail(result.detail)
      }
    } catch (e) {
      console.error('加载会话详情失败:', e)
    } finally {
      setIsLoadingDetail(false)
    }
  }, [])

  // 切换详情面板
  const toggleDetailPanel = useCallback(() => {
    if (!showDetailPanel && currentSessionId) {
      loadSessionDetail(currentSessionId)
    }
    setShowDetailPanel(!showDetailPanel)
  }, [showDetailPanel, currentSessionId, loadSessionDetail])

  // 连接数据库
  const connect = useCallback(async () => {
    setConnecting(true)
    setConnectionError(null)
    try {
      const result = await window.electronAPI.chat.connect()
      if (result.success) {
        setConnected(true)
        await loadSessions()
        await loadMyAvatar()
      } else {
        setConnectionError(result.error || '连接失败')
      }
    } catch (e) {
      setConnectionError(String(e))
    } finally {
      setConnecting(false)
    }
  }, [loadMyAvatar])

  // 加载会话列表
  const loadSessions = async () => {
    setLoadingSessions(true)
    try {
      const result = await window.electronAPI.chat.getSessions()
      if (result.success && result.sessions) {
        // 智能合并更新，避免闪烁
        setSessions((prevSessions: ChatSession[]) => {
          // 如果是首次加载，直接设置
          if (prevSessions.length === 0) {
            return result.sessions!
          }

          // 创建新会话的 Map，用于快速查找
          const newSessionsMap = new Map(
            result.sessions!.map(s => [s.username, s])
          )

          // 创建旧会话的 Map
          const oldSessionsMap = new Map(
            prevSessions.map(s => [s.username, s])
          )

          // 合并：保留顺序，只更新变化的字段
          const merged = result.sessions!.map(newSession => {
            const oldSession = oldSessionsMap.get(newSession.username)

            // 如果是新会话，直接返回
            if (!oldSession) {
              return newSession
            }

            // 检查是否有实质性变化
            const hasChanges =
              oldSession.summary !== newSession.summary ||
              oldSession.lastTimestamp !== newSession.lastTimestamp ||
              oldSession.unreadCount !== newSession.unreadCount ||
              oldSession.displayName !== newSession.displayName ||
              oldSession.avatarUrl !== newSession.avatarUrl

            // 如果有变化，返回新数据；否则保留旧对象引用（避免重新渲染）
            return hasChanges ? newSession : oldSession
          })

          return merged
        })
      }
    } catch (e) {
      console.error('加载会话失败:', e)
    } finally {
      setLoadingSessions(false)
    }
  }

  // 刷新会话列表
  const handleRefresh = async () => {
    await loadSessions()
  }

  // 刷新当前会话消息（清空缓存后重新加载）
  const [isRefreshingMessages, setIsRefreshingMessages] = useState(false)
  const handleRefreshMessages = async () => {
    if (!currentSessionId || isRefreshingMessages) return
    setIsRefreshingMessages(true)
    setIsUpdating(true) // 显示更新指示器
    try {
      // 清空后端缓存
      await window.electronAPI.chat.refreshCache()
      // 重新加载会话列表，以确保联系人信息被重新加载
      await loadSessions()
      // 重新加载消息
      setCurrentOffset(0)
      await loadMessages(currentSessionId, 0)
    } catch (e) {
      console.error('刷新消息失败:', e)
    } finally {
      setIsRefreshingMessages(false)
      setIsUpdating(false) // 隐藏更新指示器
    }
  }

  // 加载消息
  const loadMessages = async (sessionId: string, offset = 0) => {
    const listEl = messageListRef.current

    if (offset === 0) {
      setLoadingMessages(true)
      setMessages([])
      // 标记用户正在操作（首次加载）
      isUserOperatingRef.current = true
    } else {
      setLoadingMore(true)
    }

    // 记录加载前的第一条消息元素
    const firstMsgEl = listEl?.querySelector('.message-wrapper') as HTMLElement | null

    try {
      // 确保连接已建立（如果未连接，先连接）
      if (!isConnected) {
        console.log('[ChatPage] 加载消息前检查连接状态，未连接，先连接...')
        const connectResult = await window.electronAPI.chat.connect()
        if (!connectResult.success) {
          setConnectionError(connectResult.error || '连接失败')
          return
        }
        setConnected(true)
      }

      const result = await window.electronAPI.chat.getMessages(sessionId, offset, 50)
      if (result.success && result.messages) {
        if (offset === 0) {
          setMessages(result.messages)
          // 首次加载滚动到底部 (瞬间)
          requestAnimationFrame(() => {
            scrollToBottom(false)
          })
        } else {
          appendMessages(result.messages, true)
          // 加载更多后保持位置：让之前的第一条消息保持在原来的视觉位置
          if (firstMsgEl && listEl) {
            requestAnimationFrame(() => {
              listEl.scrollTop = firstMsgEl.offsetTop - 80
            })
          }
        }
        setHasMoreMessages(result.hasMore ?? false)
        setCurrentOffset(offset + result.messages.length)
      }
    } catch (e) {
      console.error('加载消息失败:', e)
    } finally {
      setLoadingMessages(false)
      setLoadingMore(false)
      // 加载完成后，延迟重置用户操作标记（给一点缓冲时间）
      if (offset === 0) {
        setTimeout(() => {
          isUserOperatingRef.current = false
        }, 2000) // 2秒后允许自动更新
      }
    }
  }

  // 监听增量消息推送
  useEffect(() => {
    // 告知后端当前会话
    window.electronAPI.chat.setCurrentSession(currentSessionId)

    const cleanup = window.electronAPI.chat.onNewMessages((data: { sessionId: string; messages: Message[] }) => {
      if (data.sessionId === currentSessionId && data.messages && data.messages.length > 0) {
        setMessages((prev: Message[]) => {
          // 使用 sortSeq 去重
          const newMsgs = data.messages.filter((nm: Message) =>
            !prev.some((pm: Message) => pm.sortSeq === nm.sortSeq)
          )
          if (newMsgs.length === 0) return prev

          return [...prev, ...newMsgs]
        })

        // 平滑滚动到底部
        requestAnimationFrame(() => scrollToBottom(true))
      }
    })

    return () => {
      cleanup()
    }
  }, [currentSessionId])

  // 组件卸载时取消当前会话
  useEffect(() => {
    return () => {
      window.electronAPI.chat.setCurrentSession(null)
    }
  }, [])

  // 选择会话
  const handleSelectSession = (session: ChatSession) => {
    if (session.username === currentSessionId) {
      // 如果是当前会话，重新加载消息（用于刷新）
      setCurrentOffset(0)
      loadMessages(session.username, 0)
      return
    }
    setCurrentSession(session.username)
    setCurrentOffset(0)
    loadMessages(session.username, 0)
    // 重置详情面板
    setSessionDetail(null)
    if (showDetailPanel) {
      loadSessionDetail(session.username)
    }
  }

  // 搜索过滤
  const handleSearch = (keyword: string) => {
    setSearchKeyword(keyword)
    if (!keyword.trim()) {
      setFilteredSessions(sessions)
      return
    }
    const lower = keyword.toLowerCase()
    const filtered = sessions.filter(s =>
      s.displayName?.toLowerCase().includes(lower) ||
      s.username.toLowerCase().includes(lower) ||
      s.summary.toLowerCase().includes(lower)
    )
    setFilteredSessions(filtered)
  }

  // 关闭搜索框
  const handleCloseSearch = () => {
    setSearchKeyword('')
    setFilteredSessions(sessions)
  }

  // 滚动加载更多 + 显示/隐藏回到底部按钮
  const handleScroll = useCallback(() => {
    if (!messageListRef.current) return

    const { scrollTop, clientHeight, scrollHeight } = messageListRef.current

    // 显示回到底部按钮：距离底部超过 300px
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight
    setShowScrollToBottom(distanceFromBottom > 300)

    // 预加载：当滚动到顶部 30% 区域时开始加载
    if (!isLoadingMore && hasMoreMessages && currentSessionId) {
      const threshold = clientHeight * 0.3
      if (scrollTop < threshold) {
        loadMessages(currentSessionId, currentOffset)
      }
    }
  }, [isLoadingMore, hasMoreMessages, currentSessionId, currentOffset])

  // 滚动到底部
  const scrollToBottom = useCallback((smooth: boolean | React.MouseEvent = true) => {
    if (messageListRef.current) {
      // 如果传入的是事件对象，默认为 smooth
      const isSmooth = typeof smooth === 'boolean' ? smooth : true;

      if (isSmooth) {
        messageListRef.current.scrollTo({
          top: messageListRef.current.scrollHeight,
          behavior: 'smooth'
        })
      } else {
        messageListRef.current.scrollTop = messageListRef.current.scrollHeight
      }
    }
  }, [])

  // 日期跳转处理
  const handleJumpToDate = useCallback(async () => {
    if (!selectedDate || !currentSessionId || isJumpingToDate) return

    setIsJumpingToDate(true)
    setShowDatePicker(false)

    try {
      // 将选中的日期转换为 Unix 时间戳（秒）
      const targetDate = new Date(selectedDate)
      targetDate.setHours(0, 0, 0, 0)
      const targetTimestamp = Math.floor(targetDate.getTime() / 1000)

      const result = await window.electronAPI.chat.getMessagesByDate(currentSessionId, targetTimestamp, 50)

      if (result.success && result.messages && result.messages.length > 0) {
        // 清空当前消息并加载新消息
        setMessages(result.messages)
        setHasMoreMessages(true) // 假设还有更多历史消息
        setCurrentOffset(result.messages.length)

        // 滚动到顶部显示目标日期的消息
        requestAnimationFrame(() => {
          if (messageListRef.current) {
            messageListRef.current.scrollTop = 0
          }
        })
      } else {
        // 没有找到消息，可能日期太新
        console.log('未找到该日期或之后的消息')
      }
    } catch (e) {
      console.error('跳转到日期失败:', e)
    } finally {
      setIsJumpingToDate(false)
    }
  }, [selectedDate, currentSessionId, isJumpingToDate, setMessages, setHasMoreMessages])

  // 批量语音转文字
  const handleBatchTranscribe = useCallback(async () => {
    if (!currentSessionId) {
      alert('未选择会话')
      return
    }
    
    const session = sessions.find(s => s.username === currentSessionId)
    
    if (!session) {
      alert('未找到当前会话')
      return
    }
    
    if (isBatchTranscribing) {
      return
    }

    // 从数据库获取该会话的所有语音消息
    const result = await window.electronAPI.chat.getAllVoiceMessages(currentSessionId)
    
    if (!result.success || !result.messages) {
      alert(`获取语音消息失败: ${result.error || '未知错误'}`)
      return
    }

    const voiceMessages = result.messages
    
    if (voiceMessages.length === 0) {
      alert('当前会话没有语音消息')
      return
    }

    // 统计有语音的日期（仅这些日期可选）
    const dateSet = new Set<string>()
    voiceMessages.forEach(m => dateSet.add(new Date(m.createTime * 1000).toISOString().slice(0, 10)))
    const sortedDates = Array.from(dateSet).sort((a, b) => b.localeCompare(a)) // 最近的排上面

    setBatchVoiceMessages(voiceMessages)
    setBatchVoiceCount(voiceMessages.length)
    setBatchVoiceDates(sortedDates)
    setBatchSelectedDates(new Set(sortedDates)) // 默认全选
    setShowBatchConfirm(true)
  }, [sessions, currentSessionId, isBatchTranscribing])

  // 确认批量转写（仅转写选中日期内的语音）
  const confirmBatchTranscribe = useCallback(async () => {
    if (!currentSessionId) return

    const selected = batchSelectedDates
    if (selected.size === 0) {
      alert('请至少选择一个日期')
      return
    }

    const messages = batchVoiceMessages
    if (!messages || messages.length === 0) {
      setShowBatchConfirm(false)
      return
    }

    const voiceMessages = messages.filter(m =>
      selected.has(new Date(m.createTime * 1000).toISOString().slice(0, 10))
    )
    if (voiceMessages.length === 0) {
      alert('所选日期下没有语音消息')
      return
    }

    setShowBatchConfirm(false)
    setBatchVoiceMessages(null)
    setBatchVoiceDates([])
    setBatchSelectedDates(new Set())

    const session = sessions.find(s => s.username === currentSessionId)
    if (!session) return
    
    setIsBatchTranscribing(true)
    setShowBatchProgress(true) // 显示进度对话框
    setBatchTranscribeProgress({ current: 0, total: voiceMessages.length })

    // 检查 STT 模式和模型
    const sttMode = await window.electronAPI.config.get('sttMode') || 'cpu'
    
    let modelExists = false
    if (sttMode === 'gpu') {
      const whisperModelType = (await window.electronAPI.config.get('whisperModelType') as string) || 'small'
      const modelStatus = await window.electronAPI.sttWhisper.checkModel(whisperModelType)
      modelExists = modelStatus.exists
      
      if (!modelExists) {
        alert(`Whisper ${whisperModelType} 模型未下载，请先在设置中下载模型`)
        setIsBatchTranscribing(false)
        setShowBatchProgress(false)
        return
      }
    } else {
      const modelStatus = await window.electronAPI.stt.getModelStatus()
      modelExists = !!(modelStatus.success && modelStatus.exists)
      
      if (!modelExists) {
        alert('SenseVoice 模型未下载，请先在设置中下载模型')
        setIsBatchTranscribing(false)
        setShowBatchProgress(false)
        return
      }
    }

    // 并发批量转写
    let successCount = 0
    let failCount = 0
    let completedCount = 0
    
    // 并发数量限制（避免同时处理太多导致内存溢出）
    const concurrency = 5
    
    // 转写单条语音的函数
    const transcribeOne = async (msg: any) => {
      try {
        // 检查是否已有缓存
        const cached = await window.electronAPI.stt.getCachedTranscript(session.username, msg.createTime)
        
        if (cached && cached.success && cached.transcript) {
          return { success: true, cached: true }
        }

        // 获取语音数据
        const result = await window.electronAPI.chat.getVoiceData(
          session.username,
          String(msg.localId),
          msg.createTime
        )

        if (!result.success || !result.data) {
          return { success: false }
        }

        // 转写
        const transcribeResult = await window.electronAPI.stt.transcribe(
          result.data,
          session.username,
          msg.createTime,
          false
        )

        return { success: transcribeResult.success }
      } catch (e) {
        return { success: false }
      }
    }

    // 使用 Promise.all 分批并发处理
    for (let i = 0; i < voiceMessages.length; i += concurrency) {
      const batch = voiceMessages.slice(i, i + concurrency)
      
      const results = await Promise.all(
        batch.map(msg => transcribeOne(msg))
      )

      // 统计结果
      results.forEach(result => {
        if (result.success) {
          successCount++
        } else {
          failCount++
        }
        completedCount++
        setBatchTranscribeProgress({ current: completedCount, total: voiceMessages.length })
      })
    }

    setIsBatchTranscribing(false)
    setShowBatchProgress(false) // 隐藏进度对话框
    
    // 显示结果对话框
    setBatchResult({ success: successCount, fail: failCount })
    setShowBatchResult(true)
  }, [sessions, currentSessionId, batchSelectedDates, batchVoiceMessages])

  // 批量转写：按日期的消息数量
  const batchCountByDate = useMemo(() => {
    const map = new Map<string, number>()
    if (!batchVoiceMessages) return map
    batchVoiceMessages.forEach(m => {
      const d = new Date(m.createTime * 1000).toISOString().slice(0, 10)
      map.set(d, (map.get(d) || 0) + 1)
    })
    return map
  }, [batchVoiceMessages])

  // 批量转写：选中日期对应的语音条数
  const batchSelectedMessageCount = useMemo(() => {
    if (!batchVoiceMessages) return 0
    return batchVoiceMessages.filter(m =>
      batchSelectedDates.has(new Date(m.createTime * 1000).toISOString().slice(0, 10))
    ).length
  }, [batchVoiceMessages, batchSelectedDates])

  const toggleBatchDate = useCallback((date: string) => {
    setBatchSelectedDates(prev => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }, [])
  const selectAllBatchDates = useCallback(() => setBatchSelectedDates(new Set(batchVoiceDates)), [batchVoiceDates])
  const clearAllBatchDates = useCallback(() => setBatchSelectedDates(new Set()), [])

  const formatBatchDateLabel = useCallback((dateStr: string) => {
    const [y, m, d] = dateStr.split('-').map(Number)
    return `${y}年${m}月${d}日`
  }, [])

  // 加载当前月份有消息的日期
  useEffect(() => {
    if (!showDatePicker || !currentSessionId) return

    const fetchDates = async () => {
      setIsLoadingDates(true)
      try {
        const year = viewDate.getFullYear()
        const month = viewDate.getMonth() + 1
        // 同时加载上个月和下个月的日期，防止切换时闪烁（这里简单处理只加载当月）
        const result = await window.electronAPI.chat.getDatesWithMessages(currentSessionId, year, month)
        if (result.success && result.dates) {
          setAvailableDates(new Set(result.dates))
        } else {
          setAvailableDates(new Set())
        }
      } catch (e) {
        console.error('加载有消息的日期失败:', e)
      } finally {
        setIsLoadingDates(false)
      }
    }

    fetchDates()
  }, [viewDate, currentSessionId, showDatePicker])

  // 点击外部关闭日期选择器
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      // 检查是否点击在日期选择器包装器或下拉框内部
      const isClickInsideWrapper = datePickerRef.current?.contains(target)
      const isClickInsideDropdown = (target as Element).closest?.('.date-picker-dropdown')

      if (!isClickInsideWrapper && !isClickInsideDropdown) {
        setShowDatePicker(false)
      }
    }

    if (showDatePicker) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showDatePicker])

  // 拖动调节侧边栏宽度
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)

    const startX = e.clientX
    const startWidth = sidebarWidth

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX
      const newWidth = Math.min(Math.max(startWidth + delta, 200), 400)
      setSidebarWidth(newWidth)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [sidebarWidth])

  // 同步 messages 和 currentSessionId 到 ref，供自动更新使用
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId
  }, [currentSessionId])

  // 初始化连接
  useEffect(() => {
    if (!isConnected && !isConnecting) {
      connect()
    }
  }, [])

  // 监听会话更新事件（来自后台自动同步）
  useEffect(() => {
    if (!isConnected) return

    // 监听会话列表更新
    const removeSessionsListener = window.electronAPI.chat.onSessionsUpdated?.(async (newSessions) => {
      // 更新增量更新时间戳
      lastIncrementalUpdateTime = Date.now()

      // 智能合并更新会话列表，避免闪烁
      setSessions((prevSessions: ChatSession[]) => {
        // 如果之前没有会话，直接设置
        if (prevSessions.length === 0) {
          return newSessions
        }

        // 创建旧会话的 Map
        const oldSessionsMap = new Map(
          prevSessions.map(s => [s.username, s])
        )

        // 合并：保留顺序，只更新变化的字段
        const merged = newSessions.map(newSession => {
          const oldSession = oldSessionsMap.get(newSession.username)

          // 如果是新会话，直接返回
          if (!oldSession) {
            return newSession
          }

          // 检查是否有实质性变化
          const hasChanges =
            oldSession.summary !== newSession.summary ||
            oldSession.lastTimestamp !== newSession.lastTimestamp ||
            oldSession.unreadCount !== newSession.unreadCount ||
            oldSession.displayName !== newSession.displayName ||
            oldSession.avatarUrl !== newSession.avatarUrl

          // 如果有变化，返回新数据；否则保留旧对象引用（避免重新渲染）
          return hasChanges ? newSession : oldSession
        })

        return merged
      })

      const currentId = currentSessionIdRef.current
      // 如果当前没有打开会话，只需要更新列表（App.tsx 已处理）
      if (!currentId) return

      // 2. 检查当前会话是否有新消息
      const currentSession = newSessions.find(s => s.username === currentId)
      if (!currentSession) return // 当前会话可能被删除了？

      // 简单判断：如果当前会话的 lastTimestamp 变了，或者有新消息
      // 这里我们采取积极策略：只要有更新事件，就尝试拉取最新消息
      // 因为增量获取开销很小

      try {
        const currentMessages = messagesRef.current
        const listEl = messageListRef.current

        // 记录滚动位置
        let isNearBottom = false
        if (listEl) {
          const { scrollTop, scrollHeight, clientHeight } = listEl
          const distanceFromBottom = scrollHeight - scrollTop - clientHeight
          isNearBottom = distanceFromBottom < 300
        }

        // 获取最新 50 条消息（增量获取开销小）
        const messagesResult = await window.electronAPI.chat.getMessages(currentId, 0, 50)

        if (messagesResult.success && messagesResult.messages) {
          const fetchedMessages = messagesResult.messages
          if (fetchedMessages.length === 0) return

          // 如果之前没消息，直接设置并返回
          if (currentMessages.length === 0) {
            setMessages(fetchedMessages)
            setHasMoreMessages(messagesResult.hasMore ?? false)
            return
          }

          // 使用多维 Key (localId + createTime) 进行去重，找出真正的“新”消息
          const existingKeys = new Set(currentMessages.map(m => `${m.serverId}-${m.localId}-${m.createTime}-${m.sortSeq}`))
          const uniqueNewMessages = fetchedMessages.filter(msg =>
            !existingKeys.has(`${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`)
          )

          if (uniqueNewMessages.length > 0) {
            // 按 createTime 升序排序，确保追加顺序正确
            uniqueNewMessages.sort((a, b) => a.createTime - b.createTime || a.localId - b.localId)

            console.log(`[ChatPage] 自动增长发现 ${uniqueNewMessages.length} 条新消息`)
            appendMessages(uniqueNewMessages, false)

            // 滚动处理：如果用户在底部附近，则自动平滑滚动
            if (isNearBottom) {
              requestAnimationFrame(() => {
                scrollToBottom(true)
              })
            }
            // 每次成功发现新消息或活跃会话更新，都增加全局同步计数，触发图片无感检查
            incrementSyncVersion()
          }
        }
      } catch (e) {
        console.error('[ChatPage] 自动刷新消息失败:', e)
      }
    })

    return () => {
      removeSessionsListener?.()
    }
  }, [isConnected, currentSessionId, appendMessages, setMessages, setHasMoreMessages])

  // 点击外部或右键其他地方关闭右键菜单
  useEffect(() => {
    const handleClick = () => {
      if (contextMenu) {
        closeContextMenu()
      }
    }

    const handleContextMenu = () => {
      // 右键其他地方时，先关闭当前菜单
      // 新菜单会在 onContextMenu 处理函数中打开
      if (contextMenu) {
        closeContextMenu()
      }
    }

    if (contextMenu) {
      // 延迟添加事件监听，避免立即触发
      const timer = setTimeout(() => {
        document.addEventListener('click', handleClick)
        document.addEventListener('contextmenu', handleContextMenu)
      }, 0)

      return () => {
        clearTimeout(timer)
        document.removeEventListener('click', handleClick)
        document.removeEventListener('contextmenu', handleContextMenu)
      }
    }
  }, [contextMenu])

  // 格式化会话时间（相对时间）- 与原项目一致
  const formatSessionTime = (timestamp: number): string => {
    if (!timestamp) return ''

    const now = Date.now()
    const msgTime = timestamp * 1000
    const diff = now - msgTime

    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)

    if (minutes < 1) return '刚刚'
    if (minutes < 60) return `${minutes}分钟前`
    if (hours < 24) return `${hours}小时前`

    // 超过24小时显示日期
    const date = new Date(msgTime)
    const nowDate = new Date()

    if (date.getFullYear() === nowDate.getFullYear()) {
      return `${date.getMonth() + 1}/${date.getDate()}`
    }

    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
  }

  // 获取当前会话信息
  const currentSession = sessions.find(s => s.username === currentSessionId)

  // 判断是否为群聊
  const isGroupChat = (username: string) => username.includes('@chatroom')

  // 渲染日期分隔
  const shouldShowDateDivider = (msg: Message, prevMsg?: Message): boolean => {
    if (!prevMsg) return true
    const date = new Date(msg.createTime * 1000).toDateString()
    const prevDate = new Date(prevMsg.createTime * 1000).toDateString()
    return date !== prevDate
  }

  const formatDateDivider = (timestamp: number): string => {
    const date = new Date(timestamp * 1000)
    const now = new Date()
    const isToday = date.toDateString() === now.toDateString()

    if (isToday) return '今天'

    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    if (date.toDateString() === yesterday.toDateString()) return '昨天'

    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  }

  return (
    <div className={`chat-page standalone ${isResizing ? 'resizing' : ''}`}>
      {/* 左侧会话列表 */}
      <div
        className="session-sidebar"
        ref={sidebarRef}
        style={{ width: sidebarWidth, minWidth: sidebarWidth, maxWidth: sidebarWidth }}
      >
        <div className="session-header">
          <div className="search-row">
            <div className="search-box expanded">
              <Search size={14} />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="搜索"
                value={searchKeyword}
                onChange={(e) => handleSearch(e.target.value)}
              />
              {searchKeyword && (
                <button className="close-search" onClick={handleCloseSearch}>
                  <X size={12} />
                </button>
              )}
            </div>
            <button
              className="icon-btn refresh-btn"
              onClick={handleRefresh}
              disabled={isLoadingSessions}
              title="刷新会话列表"
            >
              <RefreshCw size={16} className={isLoadingSessions || isUpdating ? 'spin' : ''} />
            </button>
          </div>
        </div>

        {connectionError && (
          <div className="connection-error">
            <AlertCircle size={16} />
            <span>{connectionError}</span>
            <button onClick={connect}>重试</button>
          </div>
        )}

        {isLoadingSessions ? (
          <div className="loading-sessions">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="skeleton-item">
                <div className="skeleton-avatar" />
                <div className="skeleton-content">
                  <div className="skeleton-line" />
                  <div className="skeleton-line" />
                </div>
              </div>
            ))}
          </div>
        ) : filteredSessions.length > 0 ? (
          <div className="session-list" style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
            {/* @ts-ignore - 类型定义不匹配但不影响运行 */}
            <List
              style={{ height: '100%', width: '100%' }}
              rowCount={filteredSessions.length}
              rowHeight={72}
              rowProps={{
                sessions: filteredSessions,
                currentSessionId,
                onSelect: handleSelectSession,
                formatTime: formatSessionTime
              }}
              rowComponent={SessionRow}
            />
          </div>

        ) : (
          <div className="empty-sessions">
            <MessageSquare />
            <p>暂无会话</p>
            <p className="hint">请先在数据管理页面解密数据库</p>
          </div>
        )}
      </div>

      {/* 拖动调节条 */}
      <div className="resize-handle" onMouseDown={handleResizeStart} />

      {/* 右侧消息区域 */}
      <div className="message-area">
        {currentSession ? (
          <>
            <div className="message-header">
              <SessionAvatar session={currentSession} size={40} />
              <div className="header-info">
                <h3>{currentSession.displayName || currentSession.username}</h3>
                {isGroupChat(currentSession.username) && (
                  <div className="header-subtitle">群聊</div>
                )}
              </div>
              <div className="header-actions">
                <button
                  className="icon-btn refresh-messages-btn"
                  onClick={handleRefreshMessages}
                  disabled={isRefreshingMessages || isLoadingMessages}
                  title="刷新消息"
                >
                  <RefreshCw size={18} className={isRefreshingMessages || isUpdating ? 'spin' : ''} />
                </button>
                <button
                  className="icon-btn ai-summary-btn"
                  onClick={() => {
                    window.electronAPI.window.openAISummaryWindow(
                      currentSession.username,
                      currentSession.displayName || currentSession.username
                    )
                  }}
                  title="AI 摘要"
                >
                  <Sparkles size={18} />
                </button>
                <div className="date-picker-wrapper" ref={datePickerRef}>
                  <button
                    ref={dateButtonRef}
                    className={`icon-btn date-jump-btn ${showDatePicker ? 'active' : ''}`}
                    onClick={() => {
                      if (!showDatePicker && dateButtonRef.current) {
                        const rect = dateButtonRef.current.getBoundingClientRect()
                        // 下拉框右边缘与按钮右边缘对齐
                        const dropdownWidth = 320 // 增加宽度以容纳日历
                        let left = rect.right - dropdownWidth
                        // 确保不会超出屏幕左边
                        if (left < 10) left = 10
                        setDropdownPosition({
                          top: rect.bottom + 8,
                          left
                        })
                        // 重置视图到当前选中日期或今天
                        setViewDate(selectedDate ? new Date(selectedDate) : new Date())
                      }
                      setShowDatePicker(!showDatePicker)
                    }}
                    title="跳转到日期"
                  >
                    <Calendar size={18} />
                  </button>
                  {showDatePicker && dropdownPosition && createPortal(
                    <div
                      className="date-picker-dropdown"
                      style={{
                        top: dropdownPosition.top,
                        left: dropdownPosition.left,
                        position: 'fixed',
                        zIndex: 99999
                      }}
                      ref={(node) => {
                        // 简单的点击外部检测需要这个 ref，但我们已经在 useEffect 中处理了关闭逻辑
                        // 这里主要是为了确保它能被检测到
                        if (node) {
                          // 将这个 node 关联到 ref，以便 handleClickOutside 可以检查
                          // 由于 ref 是针对 div 的，我们可以给 dropdown 一个单独的 ref 或者不使用 ref
                          // 只要 handleClickOutside 逻辑能工作即可
                        }
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      {/* 日历头部：月份切换 */}
                      <div className="calendar-header">
                        <button
                          className="calendar-nav-btn"
                          onClick={() => {
                            const newDate = new Date(viewDate)
                            newDate.setMonth(newDate.getMonth() - 1)
                            setViewDate(newDate)
                          }}
                        >
                          <ChevronDown size={16} style={{ transform: 'rotate(90deg)' }} />
                        </button>
                        <span className="current-month">
                          {viewDate.getFullYear()}年 {viewDate.getMonth() + 1}月
                        </span>
                        <button
                          className="calendar-nav-btn nav-next"
                          onClick={() => {
                            const newDate = new Date(viewDate)
                            newDate.setMonth(newDate.getMonth() + 1)
                            // 不允许查看未来月份（如果本月是未来）
                            const now = new Date()
                            if (newDate.getFullYear() > now.getFullYear() ||
                              (newDate.getFullYear() === now.getFullYear() && newDate.getMonth() > now.getMonth())) {
                              return
                            }
                            setViewDate(newDate)
                          }}
                          disabled={
                            viewDate.getFullYear() === new Date().getFullYear() &&
                            viewDate.getMonth() === new Date().getMonth()
                          }
                        >
                          <ChevronDown size={16} style={{ transform: 'rotate(-90deg)' }} />
                        </button>
                      </div>

                      {/* 星期表头 */}
                      <div className="calendar-weekdays">
                        {['日', '一', '二', '三', '四', '五', '六'].map(d => (
                          <div key={d} className="weekday">{d}</div>
                        ))}
                      </div>

                      {/* 日期网格 */}
                      <div className="calendar-grid">
                        {(() => {
                          const year = viewDate.getFullYear()
                          const month = viewDate.getMonth()

                          // 当月第一天
                          const firstDay = new Date(year, month, 1)
                          // 当月最后一天
                          const lastDay = new Date(year, month + 1, 0)

                          const daysInMonth = lastDay.getDate()
                          const startDayOfWeek = firstDay.getDay() // 0-6

                          const days = []
                          // 填充上个月的空位
                          for (let i = 0; i < startDayOfWeek; i++) {
                            days.push(<div key={`empty-${i}`} className="calendar-day empty"></div>)
                          }

                          // 填充当月日期
                          const today = new Date()
                          for (let i = 1; i <= daysInMonth; i++) {
                            const currentDate = new Date(year, month, i)
                            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`
                            const isSelected = selectedDate === dateStr
                            const isToday = today.toDateString() === currentDate.toDateString()
                            const isFuture = currentDate > today
                            const hasMessage = availableDates.has(dateStr)

                            // 禁用条件：是未来日期，或者（不是未来日期且没有消息）
                            // 但如果在加载中，暂时不禁用非未来的日期，或者显示加载状态
                            const isDisabled = isFuture || (!isFuture && !hasMessage)

                            days.push(
                              <button
                                key={i}
                                className={`calendar-day ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''} ${isDisabled ? 'disabled' : ''}`}
                                onClick={() => {
                                  if (isDisabled) return
                                  setSelectedDate(dateStr)
                                }}
                                disabled={isDisabled}
                                title={isFuture ? '未来时间' : (!hasMessage ? '无消息' : undefined)}
                              >
                                {i}
                              </button>
                            )
                          }
                          return days
                        })()}
                        {isLoadingDates && (
                          <div className="calendar-loading-overlay">
                            <Loader2 size={24} className="spin" />
                          </div>
                        )}
                      </div>

                      <div className="calendar-footer">
                        <button
                          className="date-jump-today"
                          onClick={() => {
                            const now = new Date()
                            const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
                            setSelectedDate(dateStr)
                            setViewDate(now)
                          }}
                        >
                          回到今天
                        </button>
                        <button
                          className="date-jump-confirm"
                          onClick={handleJumpToDate}
                          disabled={!selectedDate || isJumpingToDate}
                        >
                          {isJumpingToDate ? (
                            <><Loader2 size={14} className="spin" /> 跳转中...</>
                          ) : (
                            '跳转'
                          )}
                        </button>
                      </div>
                    </div>,
                    document.body
                  )}
                </div>
                <button
                  className="icon-btn batch-transcribe-btn"
                  style={{ position: 'relative', zIndex: 10 }}
                  onClick={handleBatchTranscribe}
                  disabled={isBatchTranscribing || !currentSessionId}
                  title={isBatchTranscribing ? `批量转写中 (${batchTranscribeProgress.current}/${batchTranscribeProgress.total})` : '批量语音转文字'}
                >
                  {isBatchTranscribing ? (
                    <Loader2 size={18} className="spin" />
                  ) : (
                    <Mic size={18} />
                  )}
                </button>
                <button
                  className={`icon-btn detail-btn ${showDetailPanel ? 'active' : ''}`}
                  onClick={toggleDetailPanel}
                  title="会话详情"
                >
                  <Info size={18} />
                </button>
              </div>
            </div>

            <div className="message-content-wrapper">
              {isLoadingMessages ? (
                <div className="loading-messages">
                  <Loader2 size={24} />
                  <span>加载消息中...</span>
                </div>
              ) : (
                <div
                  className="message-list"
                  ref={messageListRef}
                  onScroll={handleScroll}
                >
                  <ChatBackground />
                  {hasMoreMessages && (
                    <div className={`load-more-trigger ${isLoadingMore ? 'loading' : ''}`}>
                      {isLoadingMore ? (
                        <>
                          <Loader2 size={14} />
                          <span>加载更多...</span>
                        </>
                      ) : (
                        <span>向上滚动加载更多</span>
                      )}
                    </div>
                  )}

                  {messages.map((msg, index) => {
                    const prevMsg = index > 0 ? messages[index - 1] : undefined
                    const showDateDivider = shouldShowDateDivider(msg, prevMsg)

                    // 显示时间：第一条消息，或者与上一条消息间隔超过5分钟
                    const showTime = !prevMsg || (msg.createTime - prevMsg.createTime > 300)
                    const isSent = msg.isSend === 1
                    const isPatAppMsg = (() => {
                      const content = msg.rawContent || msg.parsedContent || ''
                      if (!content) return false
                      return /<appmsg[\s\S]*?>[\s\S]*?<type>\s*62\s*<\/type>/i.test(content) || /<patinfo[\s\S]*?>/i.test(content)
                    })()
                    const isSystem = msg.localType === 10000 || isPatAppMsg

                    // 系统消息居中显示
                    const wrapperClass = isSystem ? 'system' : (isSent ? 'sent' : 'received')

                    return (
                      <div key={msg.localId} className={`message-wrapper ${wrapperClass}`}>
                        {showDateDivider && (
                          <div className="date-divider">
                            <span>{formatDateDivider(msg.createTime)}</span>
                          </div>
                        )}
                        <MessageBubble
                          message={msg}
                          session={currentSession}
                          showTime={!showDateDivider && showTime}
                          myAvatarUrl={myAvatarUrl}
                          isGroupChat={isGroupChat(currentSession.username)}
                          hasImageKey={hasImageKey === true}
                          quoteStyle={quoteStyle}
                          onContextMenu={(e, message, handlers) => {
                            // 系统消息、图片、视频不显示右键菜单
                            const isSystem = message.localType === 10000
                            const isImage = message.localType === 3
                            const isVideo = message.localType === 43

                            // 系统消息、图片、视频不显示右键菜单（表情包可以）
                            if (isSystem || isImage || isVideo) {
                              return
                            }

                            e.preventDefault()
                            e.stopPropagation()

                            // 计算菜单位置，确保不超出屏幕
                            const menuWidth = 160
                            const menuHeight = 120
                            let x = e.clientX
                            let y = e.clientY

                            if (x + menuWidth > window.innerWidth) {
                              x = window.innerWidth - menuWidth - 10
                            }
                            if (y + menuHeight > window.innerHeight) {
                              y = window.innerHeight - menuHeight - 10
                            }

                            // 直接设置新菜单，React 会自动处理状态更新
                            setContextMenu({
                              x,
                              y,
                              message,
                              session: currentSession,
                              handlers
                            })
                          }}
                          isSelected={selectedMessages.has(msg.localId)}
                        />
                      </div>
                    )
                  })}

                  {/* 回到底部按钮 */}
                  <div className={`scroll-to-bottom ${showScrollToBottom ? 'show' : ''}`} onClick={scrollToBottom}>
                    <ChevronDown size={16} />
                    <span>回到底部</span>
                  </div>
                </div>
              )}

              {/* 会话详情面板 */}
              {showDetailPanel && (
                <div className="detail-panel">
                  <div className="detail-header">
                    <h4>会话详情</h4>
                    <button className="close-btn" onClick={() => setShowDetailPanel(false)}>
                      <X size={16} />
                    </button>
                  </div>
                  {isLoadingDetail ? (
                    <div className="detail-loading">
                      <Loader2 size={20} className="spin" />
                      <span>加载中...</span>
                    </div>
                  ) : sessionDetail ? (
                    <div className="detail-content">
                      <div className="detail-section">
                        <div className="detail-item">
                          <Hash size={14} />
                          <span className="label">微信ID</span>
                          <span className="value">{sessionDetail.wxid}</span>
                        </div>
                        {sessionDetail.remark && (
                          <div className="detail-item">
                            <span className="label">备注</span>
                            <span className="value">{sessionDetail.remark}</span>
                          </div>
                        )}
                        {sessionDetail.nickName && (
                          <div className="detail-item">
                            <span className="label">昵称</span>
                            <span className="value">{sessionDetail.nickName}</span>
                          </div>
                        )}
                        {sessionDetail.alias && (
                          <div className="detail-item">
                            <span className="label">微信号</span>
                            <span className="value">{sessionDetail.alias}</span>
                          </div>
                        )}
                      </div>

                      <div className="detail-section">
                        <div className="section-title">
                          <MessageSquare size={14} />
                          <span>消息统计</span>
                        </div>
                        <div className="detail-item">
                          <span className="label">消息总数</span>
                          <span className="value highlight">{sessionDetail.messageCount.toLocaleString()}</span>
                        </div>
                        {sessionDetail.firstMessageTime && (
                          <div className="detail-item">
                            <Calendar size={14} />
                            <span className="label">首条消息</span>
                            <span className="value">{new Date(sessionDetail.firstMessageTime * 1000).toLocaleDateString('zh-CN')}</span>
                          </div>
                        )}
                        {sessionDetail.latestMessageTime && (
                          <div className="detail-item">
                            <Calendar size={14} />
                            <span className="label">最新消息</span>
                            <span className="value">{new Date(sessionDetail.latestMessageTime * 1000).toLocaleDateString('zh-CN')}</span>
                          </div>
                        )}
                      </div>

                      {sessionDetail.messageTables.length > 0 && (
                        <div className="detail-section">
                          <div className="section-title">
                            <Database size={14} />
                            <span>数据库分布</span>
                          </div>
                          <div className="table-list">
                            {sessionDetail.messageTables.map((t, i) => (
                              <div key={i} className="table-item">
                                <span className="db-name">{t.dbName}</span>
                                <span className="table-count">{t.count.toLocaleString()} 条</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="detail-empty">暂无详情</div>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="message-header empty-header">
              <div className="header-info">
                <h3>聊天</h3>
              </div>
            </div>
            <div className="message-content-wrapper">
              <div className="message-list">
                <ChatBackground />
                <div className="empty-chat">
                  <MessageSquare />
                  <p>选择一个会话开始查看聊天记录</p>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* 右键菜单 */}
      {contextMenu && createPortal(
        <div
          className="context-menu-overlay"
          onClick={() => closeContextMenu()}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            // 右键菜单外部时关闭菜单
            closeContextMenu()
          }}
        >
          <div
            className={`context-menu ${isMenuClosing ? 'closing' : ''}`}
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
            onAnimationEnd={() => {
              if (isMenuClosing) {
                setContextMenu(null)
                setIsMenuClosing(false)
              }
            }}
          >
            {contextMenu.message.localType !== 34 && (
              <>
                <div
                  className="context-menu-item"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(contextMenu.message.parsedContent || '')
                      closeContextMenu()
                      setCopyToast(true)
                      setTimeout(() => setCopyToast(false), 2000)
                    } catch (e) {
                      console.error('复制失败:', e)
                      closeContextMenu()
                    }
                  }}
                >
                  <Copy size={16} />
                  <span>复制</span>
                </div>
                <div
                  className="context-menu-item"
                  onClick={() => {
                    setShowEnlargeView({
                      message: contextMenu.message,
                      content: contextMenu.message.parsedContent || ''
                    })
                    closeContextMenu()
                  }}
                >
                  <ZoomIn size={16} />
                  <span>放大阅读</span>
                </div>
              </>
            )}
            <div
              className="context-menu-item"
              onClick={() => {
                setSelectedMessages(prev => {
                  const newSet = new Set(prev)
                  if (newSet.has(contextMenu.message.localId)) {
                    newSet.delete(contextMenu.message.localId)
                  } else {
                    newSet.add(contextMenu.message.localId)
                  }
                  return newSet
                })
                closeContextMenu()
              }}
            >
              <CheckSquare size={16} />
              <span>多选</span>
            </div>

            {/* 语音消息：重新转文字 */}
            {contextMenu.handlers?.reTranscribe && (
              <div
                className="context-menu-item"
                onClick={() => {
                  contextMenu.handlers!.reTranscribe!()
                  closeContextMenu()
                }}
              >
                <RefreshCw size={16} />
                <span>重新转文字</span>
              </div>
            )}

            {/* 语音消息：修改识别文字 */}
            {contextMenu.handlers?.editStt && (
              <div
                className="context-menu-item"
                onClick={() => {
                  contextMenu.handlers!.editStt!()
                  closeContextMenu()
                }}
              >
                <Edit size={16} />
                <span>修改识别文字</span>
              </div>
            )}

            {/* 查看消息信息 */}
            <div
              className="context-menu-item"
              onClick={() => {
                setShowMessageInfo(contextMenu.message)
                closeContextMenu()
              }}
            >
              <Info size={16} />
              <span>查看消息信息</span>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 消息信息弹窗 */}
      {showMessageInfo && createPortal(
        <div className="message-info-overlay" onClick={() => setShowMessageInfo(null)}>
          <div className="message-info-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="header-title">
                <Info size={18} />
                <h3>消息详细信息</h3>
              </div>
              <button className="close-btn" onClick={() => setShowMessageInfo(null)}>
                <X size={18} />
              </button>
            </div>
            <div className="modal-body">
              <div className="info-section">
                <h4>基础字段</h4>
                <div className="info-grid">
                  <div className="info-item">
                    <span className="label">Local ID</span>
                    <span className="value select-text">{showMessageInfo.localId}</span>
                  </div>
                  <div className="info-item">
                    <span className="label">Server ID</span>
                    <span className="value select-text">{showMessageInfo.serverId}</span>
                  </div>
                  <div className="info-item">
                    <span className="label">Local Type</span>
                    <span className="value select-text">{showMessageInfo.localType}</span>
                  </div>
                  <div className="info-item">
                    <span className="label">发送者</span>
                    <span className="value select-text">{showMessageInfo.senderUsername}</span>
                  </div>
                  <div className="info-item">
                    <span className="label">创建时间</span>
                    <span className="value select-text">{new Date(showMessageInfo.createTime * 1000).toLocaleString()} ({showMessageInfo.createTime})</span>
                  </div>
                  <div className="info-item">
                    <span className="label">发送状态</span>
                    <span className="value select-text">{showMessageInfo.isSend === 1 ? '发送' : '接收'}</span>
                  </div>
                </div>
              </div>

              {(showMessageInfo.emojiMd5 || showMessageInfo.emojiCdnUrl) && (
                <div className="info-section">
                  <h4>表情包信息</h4>
                  <div className="info-list">
                    {showMessageInfo.emojiMd5 && (
                      <div className="info-item block">
                        <span className="label">MD5</span>
                        <span className="value select-text code">{showMessageInfo.emojiMd5}</span>
                      </div>
                    )}
                    {showMessageInfo.emojiCdnUrl && (
                      <div className="info-item block">
                        <span className="label">CDN URL</span>
                        <span className="value select-text code break-all">{showMessageInfo.emojiCdnUrl}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {showMessageInfo.rawContent && (
                <div className="info-section">
                  <h4>原始消息内容 (XML/Raw)</h4>
                  <div className="raw-content-container">
                    <pre className="select-text">{showMessageInfo.rawContent}</pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 放大阅读弹窗 */}
      {showEnlargeView && createPortal(
        <div className="enlarge-view-overlay" onClick={() => setShowEnlargeView(null)}>
          <div className="enlarge-view-content" onClick={(e) => e.stopPropagation()}>
            <div className="enlarge-view-header">
              <h3>放大阅读</h3>
              <button className="close-btn" onClick={() => setShowEnlargeView(null)}>
                <X size={16} />
              </button>
            </div>
            <div className="enlarge-view-body">
              <MessageContent content={showEnlargeView.content} />
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 复制成功提示 */}
      {copyToast && createPortal(
        <div className="copy-toast">
          <Check size={16} />
          <span>已复制</span>
        </div>,
        document.body
      )}

      {/* 批量转写确认对话框 */}
      {showBatchConfirm && createPortal(
        <div className="modal-overlay" onClick={() => setShowBatchConfirm(false)}>
          <div className="modal-content batch-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <Mic size={20} />
              <h3>批量语音转文字</h3>
            </div>
            <div className="modal-body">
              <p>选择要转写的日期（仅显示有语音的日期），然后开始转写。</p>
              {batchVoiceDates.length > 0 && (
                <div className="batch-dates-list-wrap">
                  <div className="batch-dates-actions">
                    <button type="button" className="batch-dates-btn" onClick={selectAllBatchDates}>全选</button>
                    <button type="button" className="batch-dates-btn" onClick={clearAllBatchDates}>取消全选</button>
                  </div>
                  <ul className="batch-dates-list">
                    {batchVoiceDates.map(dateStr => {
                      const count = batchCountByDate.get(dateStr) ?? 0
                      const checked = batchSelectedDates.has(dateStr)
                      return (
                        <li key={dateStr}>
                          <label className="batch-date-row">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleBatchDate(dateStr)}
                            />
                            <span className="batch-date-label">{formatBatchDateLabel(dateStr)}</span>
                            <span className="batch-date-count">{count} 条语音</span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
              <div className="batch-info">
                <div className="info-item">
                  <span className="label">已选:</span>
                  <span className="value">{batchSelectedDates.size} 天有语音，共 {batchSelectedMessageCount} 条语音</span>
                </div>
                <div className="info-item">
                  <span className="label">预计耗时:</span>
                  <span className="value">约 {Math.ceil(batchSelectedMessageCount * 2 / 60)} 分钟</span>
                </div>
              </div>
              <div className="batch-warning">
                <AlertCircle size={16} />
                <span>批量转写可能需要较长时间，转写过程中可以继续使用其他功能。已转写过的语音会自动跳过。</span>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowBatchConfirm(false)}>
                取消
              </button>
              <button className="btn-primary batch-transcribe-btn" onClick={confirmBatchTranscribe}>
                <Mic size={16} />
                开始转写
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 批量转写进度对话框 */}
      {showBatchProgress && createPortal(
        <div className="modal-overlay">
          <div className="modal-content batch-progress-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <Loader2 size={20} className="spin" />
              <h3>正在转写...</h3>
            </div>
            <div className="modal-body">
              <div className="progress-info">
                <div className="progress-text">
                  <span>已完成 {batchTranscribeProgress.current} / {batchTranscribeProgress.total} 条</span>
                  <span className="progress-percent">
                    {batchTranscribeProgress.total > 0 
                      ? Math.round((batchTranscribeProgress.current / batchTranscribeProgress.total) * 100) 
                      : 0}%
                  </span>
                </div>
                <div className="progress-bar">
                  <div 
                    className="progress-fill" 
                    style={{ 
                      width: `${batchTranscribeProgress.total > 0 
                        ? (batchTranscribeProgress.current / batchTranscribeProgress.total) * 100 
                        : 0}%` 
                    }}
                  />
                </div>
              </div>
              <div className="batch-tip">
                <span>转写过程中可以继续使用其他功能</span>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 批量转写结果对话框 */}
      {showBatchResult && createPortal(
        <div className="modal-overlay" onClick={() => setShowBatchResult(false)}>
          <div className="modal-content batch-result-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <CheckCircle size={20} />
              <h3>转写完成</h3>
            </div>
            <div className="modal-body">
              <div className="result-summary">
                <div className="result-item success">
                  <CheckCircle size={18} />
                  <span className="label">成功:</span>
                  <span className="value">{batchResult.success} 条</span>
                </div>
                {batchResult.fail > 0 && (
                  <div className="result-item fail">
                    <XCircle size={18} />
                    <span className="label">失败:</span>
                    <span className="value">{batchResult.fail} 条</span>
                  </div>
                )}
              </div>
              {batchResult.fail > 0 && (
                <div className="result-tip">
                  <AlertCircle size={16} />
                  <span>部分语音转写失败，可能是语音文件损坏或网络问题</span>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn-primary" onClick={() => setShowBatchResult(false)}>
                确定
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

// 全局语音播放管理器：同一时间只能播放一条语音
const globalVoiceManager = {
  currentAudio: null as HTMLAudioElement | null,
  currentStopCallback: null as (() => void) | null,
  play(audio: HTMLAudioElement, onStop: () => void) {
    // 停止当前正在播放的语音
    if (this.currentAudio && this.currentAudio !== audio) {
      this.currentAudio.pause()
      this.currentAudio.currentTime = 0
      this.currentStopCallback?.()
    }
    this.currentAudio = audio
    this.currentStopCallback = onStop
  },
  stop(audio: HTMLAudioElement) {
    if (this.currentAudio === audio) {
      this.currentAudio = null
      this.currentStopCallback = null
    }
  },
}

// 前端表情包缓存 (LRU 限制)
const emojiDataUrlCache = new LRUCache<string, string>(200)
// 前端图片缓存 (LRU 限制)
const imageDataUrlCache = new LRUCache<string, string>(50)

// 图片解密队列管理
const imageDecryptQueue: Array<() => Promise<void>> = []
let isProcessingQueue = false
const MAX_CONCURRENT_DECRYPTS = 3

async function processDecryptQueue() {
  if (isProcessingQueue) return
  isProcessingQueue = true

  try {
    while (imageDecryptQueue.length > 0) {
      const batch = imageDecryptQueue.splice(0, MAX_CONCURRENT_DECRYPTS)
      await Promise.all(batch.map(fn => fn().catch(() => { })))
    }
  } finally {
    isProcessingQueue = false
  }
}

function enqueueDecrypt(fn: () => Promise<void>) {
  imageDecryptQueue.push(fn)
  void processDecryptQueue()
}

// 视频信息缓存（带时间戳）
const videoInfoCache = new Map<string, {
  videoUrl?: string
  coverUrl?: string
  thumbUrl?: string
  exists: boolean
  cachedAt: number  // 缓存时间戳
}>()

// 最后一次增量更新时间戳
let lastIncrementalUpdateTime = 0

// 消息气泡组件
function MessageBubble({ message, session, showTime, myAvatarUrl, isGroupChat, hasImageKey, onContextMenu, isSelected, quoteStyle = 'default' }: {
  message: Message;
  session: ChatSession;
  showTime?: boolean;
  myAvatarUrl?: string;
  isGroupChat?: boolean;
  hasImageKey?: boolean;
  onContextMenu?: (e: React.MouseEvent, message: Message, handlers?: any) => void;
  isSelected?: boolean;
  quoteStyle?: 'default' | 'wechat';
}) {
  const syncVersion = useChatStore(state => state.syncVersion)
  const lastSyncVersionRef = useRef(syncVersion)

  const isPatAppMsg = (() => {
    const content = message.rawContent || message.parsedContent || ''
    if (!content) return false
    // WeChat “拍一拍”通常是 appmsg.type=62，并携带 patinfo
    return /<appmsg[\s\S]*?>[\s\S]*?<type>\s*62\s*<\/type>/i.test(content) || /<patinfo[\s\S]*?>/i.test(content)
  })()

  const isSystem = message.localType === 10000 || isPatAppMsg
  const isEmoji = message.localType === 47
  const isImage = message.localType === 3
  const isVideo = message.localType === 43
  const isVoice = message.localType === 34
  const isSent = message.isSend === 1
  const [senderAvatarUrl, setSenderAvatarUrl] = useState<string | undefined>(undefined)
  const [senderName, setSenderName] = useState<string | undefined>(undefined)
  const [transferPayerName, setTransferPayerName] = useState<string | undefined>(undefined)
  const [transferReceiverName, setTransferReceiverName] = useState<string | undefined>(undefined)
  const [emojiError, setEmojiError] = useState(false)
  const [emojiLoading, setEmojiLoading] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [imageLoading, setImageLoading] = useState(false)

  // 语音相关状态
  const [voiceLoading, setVoiceLoading] = useState(false)
  const [voicePlaying, setVoicePlaying] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [voiceDataUrl, setVoiceDataUrl] = useState<string | null>(null)
  const voiceRef = useRef<HTMLAudioElement>(null)

  // 语音转文字 (STT) 状态
  const [sttTranscript, setSttTranscript] = useState<string | null>(null)
  const [sttLoading, setSttLoading] = useState(false)
  const [sttError, setSttError] = useState<string | null>(null)
  const [isEditingStt, setIsEditingStt] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [imageHasUpdate, setImageHasUpdate] = useState(false)
  const [imageClicked, setImageClicked] = useState(false)
  const imageUpdateCheckedRef = useRef<string | null>(null)
  const imageClickTimerRef = useRef<number | null>(null)
  const [isVisible, setIsVisible] = useState(false)
  const imageContainerRef = useRef<HTMLDivElement>(null)

  // 视频相关状态
  const [videoInfo, setVideoInfo] = useState<{ videoUrl?: string; coverUrl?: string; thumbUrl?: string; exists: boolean } | null>(null)
  const [videoLoading, setVideoLoading] = useState(false)
  const videoContainerRef = useRef<HTMLDivElement>(null)

  // 从缓存获取表情包 data URL
  const cacheKey = message.emojiMd5 || message.emojiCdnUrl || ''
  const [emojiLocalPath, setEmojiLocalPath] = useState<string | undefined>(
    () => emojiDataUrlCache.get(cacheKey)
  )

  // 图片缓存
  const imageCacheKey = message.imageMd5 || message.imageDatName || `local:${message.localId}`
  const [imageLocalPath, setImageLocalPath] = useState<string | undefined>(
    () => imageDataUrlCache.get(imageCacheKey)
  )

  // 引用图片缓存
  const quotedImageCacheKey = message.quotedImageMd5 || ''
  const [quotedImageLocalPath, setQuotedImageLocalPath] = useState<string | undefined>(
    () => quotedImageCacheKey ? imageDataUrlCache.get(quotedImageCacheKey) : undefined
  )

  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp * 1000)
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }) + ' ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  // 获取头像首字母
  const getAvatarLetter = (name: string): string => {
    if (!name) return '?'
    const chars = [...name]
    return chars[0] || '?'
  }

  // 下载表情包
  const downloadEmoji = () => {
    if (emojiLoading) return

    // 没有 cdnUrl 也没有 md5，无法获取
    if (!message.emojiCdnUrl && !message.emojiMd5) {
      return
    }

    // 先检查缓存
    const cached = emojiDataUrlCache.get(cacheKey)
    if (cached) {
      setEmojiLocalPath(cached)
      setEmojiError(false)
      return
    }

    setEmojiLoading(true)
    setEmojiError(false)

    // 如果有 cdnUrl，优先下载；否则仅通过 md5 查找本地缓存
    const cdnUrl = message.emojiCdnUrl || ''
    window.electronAPI.chat.downloadEmoji(cdnUrl, message.emojiMd5, message.productId, message.createTime).then((result: { success: boolean; localPath?: string; error?: string }) => {
      if (result.success && result.localPath) {
        emojiDataUrlCache.set(cacheKey, result.localPath)
        setEmojiLocalPath(result.localPath)
      } else {
        console.error('[ChatPage] 表情包下载失败:', result.error)
        setEmojiError(true)
      }
    }).catch((e) => {
      console.error('[ChatPage] 表情包下载异常:', e)
      setEmojiError(true)
    }).finally(() => {
      setEmojiLoading(false)
    })
  }

  // 请求图片解密
  const requestImageDecrypt = useCallback(async (forceUpdate = false) => {
    if (!isImage || imageLoading) return
    setImageLoading(true)
    setImageError(false)

    try {
      if (message.imageMd5 || message.imageDatName) {
        const result = await window.electronAPI.image.decrypt({
          sessionId: session.username,
          imageMd5: message.imageMd5 || undefined,
          imageDatName: message.imageDatName,
          force: forceUpdate
        })

        // 先检查错误情况
        if (!result.success) {

          setImageError(true)
          return
        }

        // 成功情况
        if (result.localPath) {
          imageDataUrlCache.set(imageCacheKey, result.localPath)
          setImageLocalPath(result.localPath)
          // 如果返回的是缩略图，标记有更新可用
          setImageHasUpdate(Boolean((result as { isThumb?: boolean }).isThumb))

          return
        }
      }
      setImageError(true)
    } catch {
      setImageError(true)
    } finally {
      setImageLoading(false)
    }
  }, [isImage, imageLoading, message.imageMd5, message.imageDatName, session.username, imageCacheKey])

  // 点击图片解密
  const handleImageClick = useCallback(() => {
    if (imageClickTimerRef.current) {
      window.clearTimeout(imageClickTimerRef.current)
    }
    setImageClicked(true)
    imageClickTimerRef.current = window.setTimeout(() => {
      setImageClicked(false)
    }, 800)
    void requestImageDecrypt()
  }, [requestImageDecrypt])

  // 清理定时器
  useEffect(() => {
    return () => {
      if (imageClickTimerRef.current) {
        window.clearTimeout(imageClickTimerRef.current)
      }
    }
  }, [])

  // 使用 IntersectionObserver 检测图片是否进入可视区域（懒加载）
  useEffect(() => {
    if (!isImage || !imageContainerRef.current) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true)
            observer.disconnect()
          }
        })
      },
      {
        rootMargin: '200px 0px', // 提前 200px 开始加载
        threshold: 0
      }
    )

    observer.observe(imageContainerRef.current)

    return () => observer.disconnect()
  }, [isImage])

  // 视频懒加载
  useEffect(() => {
    if (!isVideo || !videoContainerRef.current) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true)
            observer.disconnect()
          }
        })
      },
      {
        rootMargin: '200px 0px',
        threshold: 0
      }
    )

    observer.observe(videoContainerRef.current)

    return () => observer.disconnect()
  }, [isVideo])

  // 加载视频信息
  useEffect(() => {
    if (!isVideo || !isVisible || videoInfo || videoLoading) return
    if (!message.videoMd5) return

    // 先检查缓存
    const cached = videoInfoCache.get(message.videoMd5)
    if (cached) {
      // 智能缓存失效：如果视频不存在，且缓存时间早于最后一次增量更新，则重新获取
      const shouldRefetch = !cached.exists && cached.cachedAt < lastIncrementalUpdateTime

      if (!shouldRefetch) {
        setVideoInfo(cached)
        return
      }

      // 需要重新获取，清除旧缓存
      videoInfoCache.delete(message.videoMd5)
    }

    setVideoLoading(true)
    window.electronAPI.video.getVideoInfo(message.videoMd5).then((result) => {
      if (result && result.success) {
        const info = {
          exists: result.exists,
          videoUrl: result.videoUrl,
          coverUrl: result.coverUrl,
          thumbUrl: result.thumbUrl,
          cachedAt: Date.now()  // 记录缓存时间
        }
        videoInfoCache.set(message.videoMd5!, info)
        setVideoInfo(info)
      } else {
        const info = { exists: false, cachedAt: Date.now() }
        videoInfoCache.set(message.videoMd5!, info)
        setVideoInfo(info)
      }
    }).catch(() => {
      const info = { exists: false, cachedAt: Date.now() }
      videoInfoCache.set(message.videoMd5!, info)
      setVideoInfo(info)
    }).finally(() => {
      setVideoLoading(false)
    })
  }, [isVideo, isVisible, videoInfo, videoLoading, message.videoMd5])

  // 播放视频 - 打开独立窗口
  const handlePlayVideo = useCallback(async () => {
    if (!videoInfo?.videoUrl) return

    // 直接打开独立视频播放窗口
    try {
      await window.electronAPI.window.openVideoPlayerWindow(videoInfo.videoUrl)
    } catch {
      // 忽略错误
    }
  }, [videoInfo?.videoUrl])

  // 语音播放处理
  const handlePlayVoice = useCallback(async () => {
    if (voiceLoading) return

    // 如果已经有数据，直接播放/暂停
    if (voiceDataUrl && voiceRef.current) {
      if (voicePlaying) {
        voiceRef.current.pause()
        setVoicePlaying(false)
        globalVoiceManager.stop(voiceRef.current)
      } else {
        voiceRef.current.currentTime = 0
        // 停止其他正在播放的语音，确保同一时间只播放一条
        globalVoiceManager.play(voiceRef.current, () => {
          voiceRef.current?.pause()
          setVoicePlaying(false)
        })
        voiceRef.current.play()
        setVoicePlaying(true)
      }
      return
    }

    // 加载语音数据
    setVoiceLoading(true)
    setVoiceError(null)
    try {
      const result = await window.electronAPI.chat.getVoiceData(session.username, String(message.localId), message.createTime)
      if (result.success && result.data) {
        const dataUrl = `data:audio/wav;base64,${result.data}`
        setVoiceDataUrl(dataUrl)
        // 等待状态更新后播放
        requestAnimationFrame(() => {
          if (voiceRef.current) {
            // 停止其他正在播放的语音
            globalVoiceManager.play(voiceRef.current, () => {
              voiceRef.current?.pause()
              setVoicePlaying(false)
            })
            voiceRef.current.play()
            setVoicePlaying(true)
          }
        })
      } else {
        setVoiceError(result.error || '加载失败')
      }
    } catch (e) {
      setVoiceError(String(e))
    } finally {
      setVoiceLoading(false)
    }
  }, [voiceLoading, voiceDataUrl, voicePlaying, session.username, message.localId])

  // 语音播放结束
  const handleVoiceEnded = useCallback(() => {
    setVoicePlaying(false)
    if (voiceRef.current) globalVoiceManager.stop(voiceRef.current)
  }, [])

  // 语音转文字处理
  const handleTranscribeVoice = useCallback(async (e?: React.MouseEvent, force = false) => {
    e?.stopPropagation() // 阻止触发播放

    if (sttLoading || (sttTranscript && !force)) return // 已转写或正在转写

    console.log('[STT] 开始转写...')
    setSttLoading(true)
    setSttError(null)

    try {
      // 检查 STT 模式
      const sttMode = await window.electronAPI.config.get('sttMode') || 'cpu'
      console.log('[STT] 当前模式:', sttMode)

      // 根据模式检查对应的模型
      let modelExists = false
      let modelName = ''
      
      if (sttMode === 'gpu') {
        // 检查 Whisper 模型
        const whisperModelType = (await window.electronAPI.config.get('whisperModelType') as string) || 'small'
        console.log('[ChatPage] 读取到的 Whisper 模型类型:', whisperModelType)
        
        const modelStatus = await window.electronAPI.sttWhisper.checkModel(whisperModelType)
        modelExists = modelStatus.exists
        modelName = `Whisper ${whisperModelType}`
        
        if (!modelExists) {
          if (window.confirm(`Whisper ${whisperModelType} 模型未下载，是否立即下载？\n下载完成后将自动开始转写。`)) {
            setSttLoading(true)
            setSttTranscript('准备下载模型...')

            const removeProgress = window.electronAPI.sttWhisper.onDownloadProgress((p) => {
              const pct = p.percent || 0
              setSttTranscript(`正在下载模型... ${pct.toFixed(1)}%`)
            })

            try {
              const dlResult = await window.electronAPI.sttWhisper.downloadModel(whisperModelType)
              removeProgress()

              if (dlResult.success) {
                setSttTranscript('模型下载完成，正在初始化引擎...')
                await new Promise(r => setTimeout(r, 2000))
                setSttLoading(false)
                await handleTranscribeVoice(undefined, true)
                return
              } else {
                setSttError(dlResult.error || '模型下载失败')
                setSttTranscript(null)
              }
            } catch (e) {
              removeProgress()
              setSttError(`模型下载出错: ${e}`)
              setSttTranscript(null)
            }
          }
          setSttLoading(false)
          return
        }
      } else {
        // 检查 SenseVoice 模型
        const modelStatus = await window.electronAPI.stt.getModelStatus()
        modelExists = !!(modelStatus.success && modelStatus.exists)
        modelName = 'SenseVoice'
        
        if (!modelExists) {
          if (window.confirm('语音识别模型未下载，是否立即下载？(约245MB)\n下载完成后将自动开始转写。')) {
            setSttLoading(true)
            setSttTranscript('准备下载模型...')

            const removeProgress = window.electronAPI.stt.onDownloadProgress((p) => {
              const pct = p.percent || 0
              setSttTranscript(`正在下载模型... ${pct.toFixed(1)}%`)
            })

            try {
              const dlResult = await window.electronAPI.stt.downloadModel()
              removeProgress()

              if (dlResult.success) {
                setSttTranscript('模型下载完成，正在初始化引擎...')
                await new Promise(r => setTimeout(r, 2000))
                setSttLoading(false)
                await handleTranscribeVoice(undefined, true)
                return
              } else {
                setSttError(dlResult.error || '模型下载失败')
                setSttTranscript(null)
              }
            } catch (e) {
              removeProgress()
              setSttError(`模型下载出错: ${e}`)
              setSttTranscript(null)
            }
          }
          setSttLoading(false)
          return
        }
      }

      console.log('[STT] 模型已就绪:', modelName)

      // 如果没有语音数据，先获取
      let wavBase64 = voiceDataUrl?.replace('data:audio/wav;base64,', '')

      if (!wavBase64) {
        console.log('[STT] 获取语音数据...')
        const result = await window.electronAPI.chat.getVoiceData(
          session.username,
          String(message.localId),
          message.createTime
        )
        console.log('[STT] 语音数据:', { success: result.success, dataLength: result.data?.length })
        if (!result.success || !result.data) {
          setSttError(result.error || '获取语音数据失败')
          setSttLoading(false)
          return
        }
        wavBase64 = result.data
        // 同时缓存语音数据
        setVoiceDataUrl(`data:audio/wav;base64,${wavBase64}`)
      }

      // 监听实时结果（仅 CPU 模式支持）
      let removeListener: (() => void) | undefined
      if (sttMode === 'cpu') {
        removeListener = window.electronAPI.stt.onPartialResult((text) => {
          setSttTranscript(text)
        })
      }

      // 开始转写 - 传递 sessionId 和 createTime 用于缓存
      const result = await window.electronAPI.stt.transcribe(wavBase64, session.username, message.createTime, force)

      removeListener?.()

      if (result.success && result.transcript) {
        setSttTranscript(result.transcript)
      } else {
        setSttError(result.error || '转写失败')
      }
    } catch (e) {
      console.error('[STT] 转写异常:', e)
      setSttError(String(e))
    } finally {
      setSttLoading(false)
    }
  }, [sttLoading, sttTranscript, voiceDataUrl, session.username, message.localId, message.createTime])

  // 群聊中获取发送者信息
  const [isLoadingSender, setIsLoadingSender] = useState(false)

  useEffect(() => {
    if (isGroupChat && !isSent && message.senderUsername) {
      setIsLoadingSender(true)
      window.electronAPI.chat.getContactAvatar(message.senderUsername).then((result: { avatarUrl?: string; displayName?: string } | null) => {
        if (result) {
          setSenderAvatarUrl(result.avatarUrl)
          setSenderName(result.displayName)
        }
        setIsLoadingSender(false)
      }).catch(() => {
        setIsLoadingSender(false)
      })
    }
  }, [isGroupChat, isSent, message.senderUsername])

  // 解析转账消息的付款方和收款方显示名称
  useEffect(() => {
    if (!message.transferPayerUsername || !message.transferReceiverUsername) return
    if (message.localType !== 49 && message.localType !== 8589934592049) return
    window.electronAPI.chat.resolveTransferDisplayNames(
      session.username,
      message.transferPayerUsername,
      message.transferReceiverUsername
    ).then((result: { payerName: string; receiverName: string }) => {
      setTransferPayerName(result.payerName)
      setTransferReceiverName(result.receiverName)
    }).catch(() => {})
  }, [message.transferPayerUsername, message.transferReceiverUsername, session.username])

  // 自动下载表情包
  useEffect(() => {
    if (emojiLocalPath) return
    // 有 cdnUrl 或 md5 都可以尝试获取
    if (isEmoji && (message.emojiCdnUrl || message.emojiMd5) && !emojiLoading && !emojiError) {
      downloadEmoji()
    }
  }, [isEmoji, message.emojiCdnUrl, message.emojiMd5, message.productId, emojiLocalPath, emojiLoading, emojiError])

  // 自动尝试从缓存解析图片，如果没有缓存则自动解密（仅在可见时触发，5秒超时）
  useEffect(() => {
    if (!isImage) return
    if (!message.imageMd5 && !message.imageDatName) return
    if (!isVisible) return  // 只有可见时才加载

    // 如果是新一轮全局同步且之前没成功，允许重试
    const isNewSync = syncVersion > lastSyncVersionRef.current
    if (imageUpdateCheckedRef.current === imageCacheKey && !isNewSync) return

    if (imageLocalPath && !isNewSync) return  // 如果已经有本地路径且不是强制同步，不需要再解析
    if (imageLoading) return  // 已经在加载中

    lastSyncVersionRef.current = syncVersion
    imageUpdateCheckedRef.current = imageCacheKey

    let cancelled = false
    let timeoutId: number | null = null

    const doDecrypt = async () => {
      // 设置 5 秒超时
      const timeoutPromise = new Promise<{ timeout: true }>((resolve) => {
        timeoutId = window.setTimeout(() => resolve({ timeout: true }), 5000)
      })

      const decryptPromise = (async () => {
        // 先尝试从缓存获取
        try {
          const result = await window.electronAPI.image.resolveCache({
            sessionId: session.username,
            imageMd5: message.imageMd5 || undefined,
            imageDatName: message.imageDatName
          })
          if (cancelled) return { cancelled: true }
          if (result.success && result.localPath) {
            return { success: true, localPath: result.localPath, hasUpdate: result.hasUpdate }
          }
        } catch {
          // 继续尝试解密
        }

        if (cancelled) return { cancelled: true }

        // 缓存中没有，自动尝试解密
        try {
          const decryptResult = await window.electronAPI.image.decrypt({
            sessionId: session.username,
            imageMd5: message.imageMd5 || undefined,
            imageDatName: message.imageDatName,
            force: false
          })
          if (cancelled) return { cancelled: true }
          if (decryptResult.success && decryptResult.localPath) {
            return { success: true, localPath: decryptResult.localPath }
          }
        } catch {
          // 解密失败
        }
        return { failed: true }
      })()

      setImageLoading(true)
      const result = await Promise.race([decryptPromise, timeoutPromise])

      if (timeoutId) {
        window.clearTimeout(timeoutId)
        timeoutId = null
      }

      if (cancelled) return

      if ('timeout' in result) {
        // 超时，显示手动解密按钮
        setImageError(true)
        setImageLoading(false)
        return
      }

      if ('cancelled' in result) return

      if ('success' in result && result.localPath) {
        imageDataUrlCache.set(imageCacheKey, result.localPath)
        setImageLocalPath(result.localPath)
        setImageError(false)
        if ('hasUpdate' in result) {
          setImageHasUpdate(Boolean(result.hasUpdate))
        }
      } else {
        setImageError(true)
      }
      setImageLoading(false)
    }

    // 使用队列控制并发
    enqueueDecrypt(doDecrypt)

    return () => {
      cancelled = true
      if (timeoutId) window.clearTimeout(timeoutId)
    }
  }, [isImage, message.imageMd5, message.imageDatName, isVisible, imageCacheKey, imageLocalPath, session.username, syncVersion])

  // 自动检查转写缓存
  useEffect(() => {
    if (!isVoice || sttTranscript || sttLoading) return

    window.electronAPI.stt.getCachedTranscript(session.username, message.createTime).then((result) => {
      if (result.success && result.transcript) {
        setSttTranscript(result.transcript)
      }
    }).catch(() => {
    })
  }, [isVoice, session.username, message.createTime, sttTranscript, sttLoading])






  // 监听图片更新事件
  useEffect(() => {
    if (!isImage) return
    const unsubscribe = window.electronAPI.image.onUpdateAvailable((payload) => {
      const matchesCacheKey =
        payload.cacheKey === message.imageMd5 ||
        payload.cacheKey === message.imageDatName ||
        (payload.imageMd5 && payload.imageMd5 === message.imageMd5) ||
        (payload.imageDatName && payload.imageDatName === message.imageDatName)
      if (matchesCacheKey) {
        setImageHasUpdate(true)
      }
    })
    return () => {
      unsubscribe?.()
    }
  }, [isImage, message.imageDatName, message.imageMd5])

  // 监听缓存解析事件
  useEffect(() => {
    if (!isImage) return
    const unsubscribe = window.electronAPI.image.onCacheResolved((payload) => {
      const matchesCacheKey =
        payload.cacheKey === message.imageMd5 ||
        payload.cacheKey === message.imageDatName ||
        (payload.imageMd5 && payload.imageMd5 === message.imageMd5) ||
        (payload.imageDatName && payload.imageDatName === message.imageDatName)
      if (matchesCacheKey) {
        imageDataUrlCache.set(imageCacheKey, payload.localPath)
        setImageLocalPath(payload.localPath)
        setImageError(false)
      }
    })
    return () => {
      unsubscribe?.()
    }
  }, [isImage, imageCacheKey, message.imageDatName, message.imageMd5])

  // 引用图片自动解密
  useEffect(() => {
    if (!message.quotedImageMd5) return
    if (quotedImageLocalPath) return

    const doDecrypt = async () => {
      try {
        // 先尝试从缓存获取
        const cached = await window.electronAPI.image.resolveCache({
          sessionId: session.username,
          imageMd5: message.quotedImageMd5
        })
        if (cached.success && cached.localPath) {
          imageDataUrlCache.set(message.quotedImageMd5!, cached.localPath)
          setQuotedImageLocalPath(cached.localPath)
          return
        }

        // 自动解密
        const result = await window.electronAPI.image.decrypt({
          sessionId: session.username,
          imageMd5: message.quotedImageMd5,
          force: false
        })
        if (result.success && result.localPath) {
          imageDataUrlCache.set(message.quotedImageMd5!, result.localPath)
          setQuotedImageLocalPath(result.localPath)
        }
      } catch { }
    }

    enqueueDecrypt(doDecrypt)
  }, [message.quotedImageMd5, quotedImageLocalPath, session.username])

  if (isSystem) {
    // 系统类消息：包含“拍一拍”等 appmsg(type=62)
    let systemText = message.parsedContent || '[系统消息]'
    if (isPatAppMsg) {
      try {
        const content = message.rawContent || message.parsedContent || ''
        const xmlContent = content.includes('<msg>') ? content.substring(content.indexOf('<msg>')) : content
        const parser = new DOMParser()
        const doc = parser.parseFromString(xmlContent, 'text/xml')
        systemText = (doc.querySelector('title')?.textContent || systemText || '[拍一拍]').trim()
      } catch {
        // ignore
      }
    }
    return (
      <div className="message-bubble system">
        <div className="bubble-content"><MessageContent content={systemText} /></div>
      </div>
    )
  }

  const bubbleClass = isSent ? 'sent' : 'received'

  // 头像逻辑：
  // - 自己发的：使用 myAvatarUrl
  // - 群聊中对方发的：使用发送者头像
  // - 私聊中对方发的：使用会话头像
  const avatarUrl = isSent
    ? myAvatarUrl
    : (isGroupChat ? senderAvatarUrl : session.avatarUrl)
  const avatarLetter = isSent
    ? '我'
    : getAvatarLetter(isGroupChat ? (senderName || '?') : (session.displayName || session.username))

  // 是否有引用消息
  const hasQuote = message.quotedContent && message.quotedContent.length > 0

  // 渲染消息内容
  const renderContent = () => {
    // 带引用的消息 (经典模式)
    if (hasQuote && quoteStyle === 'default') {
      return (
        <div className="bubble-content">
          <div className="quoted-message">
            <div className="quoted-message-content">
              <div className="quoted-text-container">
                {message.quotedSender && <span className="quoted-sender">{message.quotedSender}</span>}
                <span className="quoted-text">{message.quotedContent}</span>
              </div>
              {quotedImageLocalPath && (
                <div className="quoted-image-container">
                  <img
                    src={quotedImageLocalPath}
                    alt="引用图片"
                    className="quoted-image-thumb"
                    onClick={(e) => {
                      e.stopPropagation()
                      window.electronAPI.window.openImageViewerWindow(quotedImageLocalPath)
                    }}
                  />
                </div>
              )}
            </div>
          </div>
          <div className="message-text"><MessageContent content={message.parsedContent} /></div>
        </div>
      )
    }

    // 图片消息
    if (isImage) {
      // 没有配置密钥时显示提示（优先级最高）
      if (hasImageKey === false) {
        return (
          <div className="image-no-key" ref={imageContainerRef}>
            <ImageIcon size={24} />
            <span>请配置图片解密密钥</span>
          </div>
        )
      }

      // 已有缓存图片，直接显示
      if (imageLocalPath) {
        return (
          <>
            <div className="image-message-wrapper" ref={imageContainerRef}>
              <img
                src={imageLocalPath}
                alt="图片"
                className="image-message"
                onClick={() => {
                  void requestImageDecrypt(true)
                  if (imageLocalPath) {
                    window.electronAPI.window.openImageViewerWindow(imageLocalPath)
                  }
                }}
                onLoad={() => setImageError(false)}
                onError={() => setImageError(true)}
              />
              {imageLoading && (
                <div className="image-loading-overlay">
                  <Loader2 size={20} className="spin" />
                </div>
              )}
            </div>

          </>
        )
      }

      // 未进入可视区域时显示占位符
      if (!isVisible) {
        return (
          <div className="image-placeholder" ref={imageContainerRef}>
            <ImageIcon size={24} />
          </div>
        )
      }

      if (imageLoading) {
        return (
          <div className="image-loading" ref={imageContainerRef}>
            <Loader2 size={20} className="spin" />
          </div>
        )
      }

      // 解密失败或未解密
      return (
        <button
          className={`image-unavailable ${imageClicked ? 'clicked' : ''}`}
          onClick={handleImageClick}
          disabled={imageLoading}
          type="button"
          ref={imageContainerRef as unknown as React.RefObject<HTMLButtonElement>}
        >
          <ImageIcon size={24} />
          <span>图片未解密</span>
          <span className="image-action">{imageClicked ? '已点击…' : '点击解密'}</span>
        </button>
      )
    }

    // 视频消息
    if (isVideo) {
      // 未进入可视区域时显示占位符
      if (!isVisible) {
        return (
          <div className="video-placeholder" ref={videoContainerRef}>
            <Video size={24} />
          </div>
        )
      }

      // 加载中
      if (videoLoading) {
        return (
          <div className="video-loading" ref={videoContainerRef}>
            <Loader2 size={20} className="spin" />
          </div>
        )
      }

      // 视频不存在
      if (!videoInfo?.exists || !videoInfo.videoUrl) {
        return (
          <button
            className="video-unavailable"
            ref={videoContainerRef as unknown as React.RefObject<HTMLButtonElement>}
            onClick={() => {
              // 清除缓存并重新加载
              if (message.videoMd5) {
                videoInfoCache.delete(message.videoMd5)
              }
              setVideoInfo(null)
              setVideoLoading(false)
            }}
            type="button"
          >
            <Video size={24} />
            <span>视频不可用</span>
            <span className="video-action">点击重试</span>
          </button>
        )
      }

      // 默认显示缩略图，点击打开独立播放窗口
      const thumbSrc = videoInfo.thumbUrl || videoInfo.coverUrl
      return (
        <div className="video-thumb-wrapper" ref={videoContainerRef} onClick={handlePlayVideo}>
          {thumbSrc ? (
            <img src={thumbSrc} alt="视频缩略图" className="video-thumb" />
          ) : (
            <div className="video-thumb-placeholder">
              <Video size={32} />
            </div>
          )}
          <div className="video-play-button">
            <Play size={32} fill="white" />
          </div>
        </div>
      )
    }

    // 语音消息
    if (isVoice) {
      const duration = message.voiceDuration || 0
      const displayDuration = duration > 0 ? `${Math.round(duration)}"` : ''
      // 根据时长计算宽度（最小60px，最大200px，每秒增加约10px）
      const minWidth = 60
      const maxWidth = 200
      const width = Math.min(maxWidth, Math.max(minWidth, minWidth + duration * 10))

      // 语音图标组件
      const VoiceIcon = () => {
        if (voiceLoading) {
          return <Loader2 size={18} className="spin" />
        }
        if (voiceError) {
          return <AlertCircle size={18} className="voice-error-icon" />
        }
        if (voicePlaying) {
          return (
            <div className={`voice-waves ${isSent ? 'sent' : ''}`}>
              <span></span>
              <span></span>
              <span></span>
            </div>
          )
        }
        return (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        )
      }

      return (
        <div className="voice-bubble-container">
          <div
            className="bubble-content voice-bubble"
            style={{ minWidth: `${width}px` }}
            onClick={handlePlayVoice}
          >
            <div
              className={`voice-message ${voicePlaying ? 'playing' : ''} ${voiceError ? 'error' : ''} ${isSent ? 'sent' : ''}`}
            >
              {isSent ? (
                <>
                  <span className="voice-duration">{displayDuration}</span>
                  <div className="voice-icon"><VoiceIcon /></div>
                </>
              ) : (
                <>
                  <div className="voice-icon"><VoiceIcon /></div>
                  <span className="voice-duration">{displayDuration}</span>
                </>
              )}
              {voiceDataUrl && (
                <audio
                  ref={voiceRef}
                  src={voiceDataUrl}
                  onEnded={handleVoiceEnded}
                  onError={() => setVoiceError('播放失败')}
                />
              )}
            </div>
          </div>

          {/* 转文字按钮或转写结果 */}
          {sttTranscript ? (
            isEditingStt ? (
              <div className="stt-edit-container" onClick={e => e.stopPropagation()}>
                <textarea
                  className="stt-edit-textarea"
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  autoFocus
                  onContextMenu={e => e.stopPropagation()}
                />
                <div className="stt-edit-actions">
                  <button
                    className="stt-edit-btn cancel"
                    onClick={(e) => {
                      e.stopPropagation()
                      setIsEditingStt(false)
                    }}
                  >
                    取消
                  </button>
                  <button
                    className="stt-edit-btn save"
                    onClick={async (e) => {
                      e.stopPropagation()
                      if (editContent.trim() !== sttTranscript) {
                        setSttTranscript(editContent)
                        try {
                          await window.electronAPI.stt.updateTranscript(session.username, message.createTime, editContent)
                        } catch (err) {
                          console.error('更新转写缓存失败:', err)
                        }
                      }
                      setIsEditingStt(false)
                    }}
                  >
                    保存
                  </button>
                </div>
              </div>
            ) : (
              <div className="stt-transcript" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>{sttTranscript}</span>
                {sttLoading && <Loader2 size={12} className="spin" style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />}
              </div>
            )
          ) : (
            <button
              className={`stt-button ${sttLoading ? 'loading' : ''} ${sttError ? 'error' : ''}`}
              onClick={handleTranscribeVoice}
              disabled={sttLoading}
              title={sttError || '点击转文字'}
            >
              {sttLoading ? (
                <Loader2 size={12} className="spin" />
              ) : sttError ? (
                <AlertCircle size={12} />
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 7V4h16v3" />
                  <path d="M9 20h6" />
                  <path d="M12 4v16" />
                </svg>
              )}
              <span>{sttLoading ? '转写中' : sttError ? '重试' : '转文字'}</span>
            </button>
          )}
          {sttError && (
            <div className="stt-error-msg" style={{ fontSize: '11px', color: '#ff4d4f', marginTop: '4px', marginLeft: '4px' }}>
              {sttError}
            </div>
          )}
        </div>
      )
    }

    // 表情包消息
    if (isEmoji) {
      // 没有 cdnUrl 也没有 md5，或加载失败，显示占位符
      const cannotFetch = !message.emojiCdnUrl && !message.emojiMd5
      if (cannotFetch || emojiError) {
        return (
          <div className="emoji-unavailable">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <path d="M8 15s1.5 2 4 2 4-2 4-2" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
            </svg>
            <span>表情包未缓存</span>
          </div>
        )
      }

      // 显示加载中
      if (emojiLoading || !emojiLocalPath) {
        return (
          <div className="emoji-loading">
            <Loader2 size={20} className="spin" />
          </div>
        )
      }

      // 显示表情图片
      return (
        <img
          src={emojiLocalPath}
          alt="表情"
          className="emoji-image"
          onError={() => setEmojiError(true)}
        />
      )
    }

    // 链接消息 (AppMessage)
    const isAppMsg = message.rawContent?.includes('<appmsg') || (message.parsedContent && message.parsedContent.includes('<appmsg'))

    if (isAppMsg) {
      let title = '链接'
      let desc = ''
      let url = ''
      let thumbUrl = ''
      let appMsgType = ''
      let isPat = false
      let textAnnouncement = ''

      try {
        const content = message.rawContent || message.parsedContent || ''
        // 简单清理 XML 前缀（如 wxid:）
        const xmlContent = content.substring(content.indexOf('<msg>'))

        const parser = new DOMParser()
        const doc = parser.parseFromString(xmlContent, 'text/xml')

        title = doc.querySelector('title')?.textContent || '链接'
        desc = doc.querySelector('des')?.textContent || ''
        url = doc.querySelector('url')?.textContent || ''
        appMsgType = doc.querySelector('appmsg > type')?.textContent || doc.querySelector('type')?.textContent || ''
        isPat = appMsgType === '62' || Boolean(doc.querySelector('patinfo'))
        textAnnouncement = doc.querySelector('textannouncement')?.textContent || ''
        // 尝试获取缩略图 (这里只是简单的解析，实际上可能需要解密或者下载)
        // 暂时只显示占位符，或者如果 url 是图片则显示
      } catch (e) {
        console.error('解析 AppMsg 失败:', e)
      }

      // 拍一拍 (appmsg type=62)：这是系统类消息，不按链接卡片渲染
      if (isPat) {
        const text = (title || '').trim() || '[拍一拍]'
        return (
          <div className="bubble-content">
            <MessageContent content={text} />
          </div>
        )
      }

      // 群公告消息 (type=87)
      if (appMsgType === '87') {
        const announcementText = textAnnouncement || desc || '群公告'
        return (
          <div className="announcement-message">
            <div className="announcement-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 17H2a3 3 0 0 0 3-3V9a7 7 0 0 1 14 0v5a3 3 0 0 0 3 3zm-8.27 4a2 2 0 0 1-3.46 0" />
              </svg>
            </div>
            <div className="announcement-content">
              <div className="announcement-label">群公告</div>
              <div className="announcement-text">{announcementText}</div>
            </div>
          </div>
        )
      }

      // 聊天记录 (type=19)
      if (appMsgType === '19') {
        const recordList = message.chatRecordList || []
        const displayTitle = title || '群聊的聊天记录'
        const metaText =
          recordList.length > 0
            ? `共 ${recordList.length} 条聊天记录`
            : desc || '聊天记录'

        const previewItems = recordList.slice(0, 4)

        return (
          <div
            className="link-message chat-record-message"
            onClick={(e) => {
              e.stopPropagation()
              window.electronAPI.window.openChatHistoryWindow(session.username, message.localId)
            }}
            title="点击查看详细聊天记录"
          >
            <div className="link-header">
              <div className="link-title" title={displayTitle}>
                {displayTitle}
              </div>
            </div>
            <div className="link-body">
              <div className="chat-record-preview">
                {previewItems.length > 0 ? (
                  <>
                    <div className="chat-record-meta-line" title={metaText}>
                      {metaText}
                    </div>
                    <div className="chat-record-list">
                      {previewItems.map((item, i) => (
                        <div key={i} className="chat-record-item">
                          <span className="source-name">
                            {item.sourcename ? `${item.sourcename}: ` : ''}
                          </span>
                          {item.datadesc || item.datatitle || '[媒体消息]'}
                        </div>
                      ))}
                      {recordList.length > previewItems.length && (
                        <div className="chat-record-more">还有 {recordList.length - previewItems.length} 条…</div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="chat-record-desc">
                    {desc || '点击打开查看完整聊天记录'}
                  </div>
                )}
              </div>
              <div className="chat-record-icon">
                <MessageSquare size={18} />
              </div>
            </div>
          </div>
        )
      }

      // 文件消息 (type=6)：渲染为文件卡片
      if (appMsgType === '6') {
        // 优先使用从接口获取的文件信息，否则从 XML 解析
        const fileName = message.fileName || title || '文件'
        const fileSize = message.fileSize
        const fileExt = message.fileExt || fileName.split('.').pop()?.toLowerCase() || ''
        const fileMd5 = message.fileMd5

        // 格式化文件大小
        const formatFileSize = (bytes: number | undefined): string => {
          if (!bytes) return ''
          if (bytes < 1024) return `${bytes} B`
          if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
          if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
          return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
        }

        // 根据扩展名选择图标
        const getFileIcon = (ext: string) => {
          const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2']
          if (archiveExts.includes(ext)) {
            return <FileArchive size={28} />
          }
          return <FileText size={28} />
        }

        // 点击文件消息，定位到文件所在文件夹并选中文件
        const handleFileClick = async () => {
          try {
            // 获取用户设置的微信原始存储目录（不是解密缓存目录）
            const wechatDir = await window.electronAPI.config.get('dbPath') as string
            if (!wechatDir) {
              console.error('未设置微信存储目录')
              return
            }

            // 获取当前用户信息
            const userInfo = await window.electronAPI.chat.getMyUserInfo()
            if (!userInfo.success || !userInfo.userInfo) {
              console.error('无法获取用户信息')
              return
            }

            const wxid = userInfo.userInfo.wxid

            // 文件存储在 {微信存储目录}\{账号文件夹}\msg\file\{年-月}\ 目录下
            // 根据消息创建时间计算日期目录
            const msgDate = new Date(message.createTime * 1000)
            const year = msgDate.getFullYear()
            const month = String(msgDate.getMonth() + 1).padStart(2, '0')
            const dateFolder = `${year}-${month}`

            // 构建完整文件路径（包括文件名）
            const filePath = `${wechatDir}\\${wxid}\\msg\\file\\${dateFolder}\\${fileName}`

            // 使用 showItemInFolder 在文件管理器中定位并选中文件
            try {
              await window.electronAPI.shell.showItemInFolder(filePath)
            } catch (err) {
              // 如果文件不存在或路径错误，尝试只打开文件夹
              console.warn('无法定位到具体文件，尝试打开文件夹:', err)
              const fileDir = `${wechatDir}\\${wxid}\\msg\\file\\${dateFolder}`
              const result = await window.electronAPI.shell.openPath(fileDir)

              // 如果还是失败，打开上级目录
              if (result) {
                console.warn('无法打开月份文件夹，尝试打开上级目录')
                const parentDir = `${wechatDir}\\${wxid}\\msg\\file`
                await window.electronAPI.shell.openPath(parentDir)
              }
            }
          } catch (error) {
            console.error('打开文件夹失败:', error)
          }
        }

        return (
          <div
            className="file-message"
            onClick={handleFileClick}
            style={{ cursor: 'pointer' }}
            title="点击定位到文件所在文件夹"
          >
            <div className="file-icon">
              {getFileIcon(fileExt)}
            </div>
            <div className="file-info">
              <div className="file-name" title={fileName}>{fileName}</div>
              <div className="file-meta">
                {fileSize ? formatFileSize(fileSize) : ''}
              </div>
            </div>
          </div>
        )
      }

      // 转账消息 (type=2000)：渲染为转账卡片
      if (appMsgType === '2000') {
        try {
          const content = message.rawContent || message.parsedContent || ''
          const xmlStr = content.includes('<msg>') ? content.substring(content.indexOf('<msg>')) : content
          const parser = new DOMParser()
          const transferDoc = parser.parseFromString(xmlStr, 'text/xml')

          const feedesc = transferDoc.querySelector('feedesc')?.textContent || ''
          const payMemo = transferDoc.querySelector('pay_memo')?.textContent || ''
          const paysubtype = transferDoc.querySelector('paysubtype')?.textContent || '1'

          // paysubtype: 1=待收款, 3=已收款
          const isReceived = paysubtype === '3'

          // 构建 "A 转账给 B" 描述
          const transferDesc = transferPayerName && transferReceiverName
            ? `${transferPayerName} 转账给 ${transferReceiverName}`
            : ''

          return (
            <div className={`transfer-message ${isReceived ? 'received' : ''}`}>
              <div className="transfer-icon">
                {isReceived ? (
                  <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                    <circle cx="20" cy="20" r="18" stroke="white" strokeWidth="2" />
                    <path d="M12 20l6 6 10-12" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                    <circle cx="20" cy="20" r="18" stroke="white" strokeWidth="2" />
                    <path d="M12 20h16M20 12l8 8-8 8" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
              <div className="transfer-info">
                {transferDesc && <div className="transfer-desc">{transferDesc}</div>}
                <div className="transfer-amount">{feedesc}</div>
                {payMemo && <div className="transfer-memo">{payMemo}</div>}
                <div className="transfer-label">{isReceived ? '已收款' : '微信转账'}</div>
              </div>
            </div>
          )
        } catch (e) {
          return (
            <div className="bubble-content">
              <MessageContent content={message.parsedContent} />
            </div>
          )
        }
      }

      if (url) {
        return (
          <div
            className="link-message"
            onClick={(e) => {
              e.stopPropagation()
              // 使用自定义的浏览器窗口打开链接
              window.electronAPI.window.openBrowserWindow(url, title)
            }}
          >
            <div className="link-header">
              <span className="link-title">{title}</span>
            </div>
            <div className="link-body">
              <div className="link-desc">{desc}</div>
              <div className="link-thumb-placeholder">
                <Link size={24} />
              </div>
            </div>
          </div>
        )
      }
    }

    // 调试非文本类型的未适配消息
    if (message.localType !== 1) {
      console.log('[ChatPage] 未适配的消息:', message)
    }
    // 普通消息
    return <div className="bubble-content"><MessageContent content={message.parsedContent} /></div>
  }

  return (
    <>
      {showTime && (
        <div className="time-divider">
          <span>{formatTime(message.createTime)}</span>
        </div>
      )}
      <div
        className={`message-bubble ${bubbleClass} ${isEmoji && message.emojiCdnUrl && !emojiError ? 'emoji' : ''} ${isImage ? 'image' : ''} ${isVideo ? 'video' : ''} ${isVoice ? 'voice' : ''} ${isSelected ? 'selected' : ''}`}
        onContextMenu={(e) => {
          if (onContextMenu) {
            onContextMenu(e, message, {
              reTranscribe: isVoice ? () => handleTranscribeVoice(undefined, true) : undefined,
              editStt: (isVoice && sttTranscript) ? () => {
                setEditContent(sttTranscript)
                setIsEditingStt(true)
              } : undefined
            })
          }
        }}
      >
        <div className="bubble-avatar">
          {isLoadingSender && isGroupChat && !isSent ? (
            <div className="avatar-skeleton-wrapper">
              <span className="avatar-skeleton" />
            </div>
          ) : avatarUrl ? (
            <img src={avatarUrl} alt="" />
          ) : (
            <span className="avatar-letter">{avatarLetter}</span>
          )}
        </div>
        <div className="bubble-body">
          {/* 群聊中显示发送者名称 */}
          {isGroupChat && !isSent && (
            <div className="sender-name">
              {isLoadingSender ? (
                <span className="sender-skeleton" />
              ) : (
                senderName || '群成员'
              )}
            </div>
          )}
          {renderContent()}

          {/* 引用消息 - 移至下方，单行显示 */}
          {hasQuote && quoteStyle === 'wechat' && (
            <div className="bubble-quote">
              <div className="quote-content">
                <span className="quote-text">
                  {(() => {
                    // 尝试获取引用发送者：优先使用字段值，否则尝试从 xml 解析
                    let sender = message.quotedSender
                    if (!sender && message.rawContent) {
                      const match = message.rawContent.match(/<displayname>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/displayname>/)
                      if (match) sender = match[1]
                    }

                    return sender ? <span className="quote-sender">{sender}: </span> : null
                  })()}
                  {message.quotedContent}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

export default ChatPage
