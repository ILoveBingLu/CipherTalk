import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { BookOpen, Bot, Brain, Check, Clock3, Edit3, FileText, History, MessageSquare, Plus, Search, Settings2, Trash2, X } from 'lucide-react'
import type { ChatSession, ContactInfo } from '../types/models'
import { useAgentStore } from '../stores/agentStore'
import CommandInput, { type AgentCommandSelection, type AgentMemoryStateView, type AgentSkillOption, type AgentTokenUsageView } from '../components/agent/CommandInput'
import AgentConversation, { type AgentChatMessage } from '../components/agent/AgentConversation'
import AgentConfigPanel from '../components/agent/AgentConfigPanel'
import './AgentPage.scss'

type AgentSession = {
  id: string
  title: string
  agentId?: string
  createdAt: number
  updatedAt: number
  messageCount?: number
  summaryCount?: number
  observationCount?: number
  latestMessage?: AgentChatMessage
  messages: AgentChatMessage[]
}

type AgentMemoryState = AgentMemoryStateView & {
  latestSummary?: {
    id: string
    content: string
    updatedAt: number
    coveredUntilSequence: number
    messageCount: number
  } | null
}

type AgentObservationView = {
  id: string
  sessionId?: string
  type: string
  title: string
  content: string
  tags?: string[]
  updatedAt?: number
}

type AgentSummaryView = {
  id: string
  sessionId: string
  content: string
  coveredUntilSequence: number
  messageCount: number
  updatedAt: number
}

type SummaryDialogState = {
  sessionId: string
  title: string
  loading: boolean
  items: AgentSummaryView[]
  error?: string
}

type MemoryDialogState = {
  sessionId: string
  title: string
  loading: boolean
  items: AgentObservationView[]
}

function normalizeAgentMessage(item: any): AgentChatMessage {
  return {
    id: String(item?.id || `message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    role: item?.role === 'assistant' ? 'assistant' : 'user',
    content: String(item?.content || ''),
    createdAt: Number(item?.createdAt) || Date.now(),
    selection: item?.selection,
    agentName: item?.agentName,
    error: Boolean(item?.error),
    events: Array.isArray(item?.events) ? item.events : [],
    sequence: Number(item?.sequence) || undefined
  }
}

function normalizeAgentSession(item: any, current?: AgentSession): AgentSession {
  return {
    id: String(item?.id || current?.id || ''),
    title: String(item?.title || current?.title || '新的对话'),
    agentId: item?.agentId || current?.agentId,
    createdAt: Number(item?.createdAt) || current?.createdAt || Date.now(),
    updatedAt: Number(item?.updatedAt) || current?.updatedAt || Date.now(),
    messageCount: Number(item?.messageCount ?? current?.messageCount ?? 0),
    summaryCount: Number(item?.summaryCount ?? current?.summaryCount ?? 0),
    observationCount: Number(item?.observationCount ?? current?.observationCount ?? 0),
    latestMessage: item?.latestMessage ? normalizeAgentMessage(item.latestMessage) : current?.latestMessage,
    messages: Array.isArray(item?.messages)
      ? item.messages.map(normalizeAgentMessage)
      : current?.messages || []
  }
}

function normalizeMemoryState(item: any): AgentMemoryState {
  return {
    summaryCount: Number(item?.summaryCount || 0),
    observationCount: Number(item?.observationCount || 0),
    summarizedMessages: Number(item?.summarizedMessages || 0),
    recentMessages: Number(item?.recentMessages || 0),
    estimatedContextTokens: Number(item?.estimatedContextTokens || 0),
    latestSummary: item?.latestSummary || null
  }
}

function renderMarkdown(content: string) {
  return { __html: DOMPurify.sanitize(marked.parse(content || '') as string) }
}

function formatSessionTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function titleFromMessage(message: string): string {
  return message
    .replace(/(?:#|@|\$|!|\/|t:)\[[^\]]+\]/g, '')
    .replace(/[#@!/$]([^\s]+)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 22) || '新的对话'
}

function previewMessage(message?: AgentChatMessage): string {
  if (!message?.content) return '开始新的 Agent 对话'
  return message.content
    .replace(/(?:#|@|\$|!|\/|t:)\[[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || '开始新的 Agent 对话'
}

function getDoneTokenUsage(events: AgentChatMessage['events'] = []): AgentTokenUsageView | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const usage = events[index]?.tokenUsage
    if (events[index]?.type === 'done' && usage) return usage
  }
  return null
}

function buildTokenStats(messages: AgentChatMessage[], liveEvents: AgentChatMessage['events'] = []): AgentTokenUsageView {
  const total = messages.reduce<AgentTokenUsageView>((sum, message) => {
    if (message.role !== 'assistant') return sum
    const usage = getDoneTokenUsage(message.events)
    if (!usage) return sum
    return {
      promptTokens: sum.promptTokens + usage.promptTokens,
      completionTokens: sum.completionTokens + usage.completionTokens,
      totalTokens: sum.totalTokens + usage.totalTokens
    }
  }, { promptTokens: 0, completionTokens: 0, totalTokens: 0 })

  const liveUsage = getDoneTokenUsage(liveEvents)
  if (!liveUsage) return total
  return {
    promptTokens: total.promptTokens + liveUsage.promptTokens,
    completionTokens: total.completionTokens + liveUsage.completionTokens,
    totalTokens: total.totalTokens + liveUsage.totalTokens
  }
}

export default function AgentPage() {
  const {
    agents,
    workflows,
    tools,
    selectedAgentId,
    selectedWorkflowId,
    isRunning,
    events,
    answerText,
    error,
    loadAgents,
    loadWorkflows,
    loadTools,
    selectAgent,
    selectWorkflow,
    execute,
    cancel
  } = useAgentStore()
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [contacts, setContacts] = useState<ContactInfo[]>([])
  const [skills, setSkills] = useState<AgentSkillOption[]>([])
  const [showConfig, setShowConfig] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState('')
  const [memoryStates, setMemoryStates] = useState<Record<string, AgentMemoryState>>({})
  const [summaryDialog, setSummaryDialog] = useState<SummaryDialogState | null>(null)
  const [memoryDialog, setMemoryDialog] = useState<MemoryDialogState | null>(null)
  const [commandError, setCommandError] = useState('')
  const [editingSummaryId, setEditingSummaryId] = useState<string | null>(null)
  const [summaryDraft, setSummaryDraft] = useState('')
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null)
  const [memoryDraft, setMemoryDraft] = useState({ title: '', content: '' })
  const [compressingSessionId, setCompressingSessionId] = useState<string | null>(null)
  const [myAvatarUrl, setMyAvatarUrl] = useState('')
  const [editDraft, setEditDraft] = useState<{ content: string; selection: AgentCommandSelection; sequence?: number } | null>(null)
  const pendingSessionId = useRef<string | null>(null)
  const chatStageRef = useRef<HTMLElement | null>(null)
  const historyControlRef = useRef<HTMLDivElement | null>(null)

  const loadMemoryState = useCallback(async (sessionId: string) => {
    if (!sessionId) return null
    const state = normalizeMemoryState(await window.electronAPI.agent.getSessionMemoryState(sessionId))
    setMemoryStates((prev) => ({ ...prev, [sessionId]: state }))
    return state
  }, [])

  const loadSessionDetail = useCallback(async (sessionId: string) => {
    const detail = await window.electronAPI.agent.getSession(sessionId)
    if (!detail) return null
    const normalized = normalizeAgentSession(detail)
    setAgentSessions((prev) => {
      const exists = prev.some((session) => session.id === normalized.id)
      const next = exists
        ? prev.map((session) => session.id === normalized.id ? normalizeAgentSession(normalized, session) : session)
        : [normalized, ...prev]
      return next.sort((a, b) => b.updatedAt - a.updatedAt)
    })
    setActiveSessionId(normalized.id)
    void loadMemoryState(normalized.id)
    return normalized
  }, [loadMemoryState])

  const refreshAgentSessions = useCallback(async (targetSessionId?: string) => {
    let list = await window.electronAPI.agent.listSessions({ limit: 40 })
    if (!Array.isArray(list) || list.length === 0) {
      const created = await window.electronAPI.agent.createSession({ agentId: selectedAgentId || undefined })
      list = created ? [created] : []
    }
    const normalizedList = list.map((item: any) => normalizeAgentSession(item))
    setAgentSessions((prev) => normalizedList.map((session) => (
      normalizeAgentSession(session, prev.find((current) => current.id === session.id))
    )))
    const nextActiveId = targetSessionId || activeSessionId || normalizedList[0]?.id || ''
    if (nextActiveId) {
      await loadSessionDetail(nextActiveId)
    }
  }, [activeSessionId, loadSessionDetail, selectedAgentId])

  useEffect(() => {
    void loadAgents()
    void loadWorkflows()
    void loadTools()
    void refreshAgentSessions()
    void window.electronAPI.chat.getSessions(0, 300).then((result) => {
      if (result.success && result.sessions) setSessions(result.sessions)
    }).catch(() => undefined)
    void window.electronAPI.chat.getContacts().then((result) => {
      if (result.success && result.contacts) setContacts(result.contacts)
    }).catch(() => undefined)
    void window.electronAPI.chat.getMyAvatarUrl().then((result) => {
      if (result?.success && result.avatarUrl) setMyAvatarUrl(result.avatarUrl)
    }).catch(() => undefined)
    void window.electronAPI.skillManager.list().then(setSkills).catch(() => undefined)
  }, [loadAgents, loadTools, loadWorkflows, refreshAgentSessions])

  useEffect(() => {
    if (!activeSessionId && agentSessions[0]) setActiveSessionId(agentSessions[0].id)
  }, [activeSessionId, agentSessions])

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) || null,
    [agents, selectedAgentId]
  )
  const activeAgentName = selectedAgent?.name ||
    agents.find((agent) => agent.id === 'builtin-general-agent')?.name ||
    agents.find((agent) => agent.isBuiltin)?.name ||
    'Agent'
  const selectedWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedWorkflowId) || null,
    [selectedWorkflowId, workflows]
  )
  const activeWorkflowName = selectedWorkflow?.name || ''

  useEffect(() => {
    if (isRunning || !pendingSessionId.current) return
    const hasDoneEvent = events.some((event) => event.type === 'done')
    if (!answerText && !error && !hasDoneEvent) return
    const sessionId = pendingSessionId.current
    pendingSessionId.current = null
    void loadSessionDetail(sessionId).then(() => refreshAgentSessions(sessionId))
  }, [answerText, error, events, isRunning, loadSessionDetail, refreshAgentSessions])

  useEffect(() => {
    if (!showHistory) return

    const closeHistory = (event: PointerEvent) => {
      if (historyControlRef.current?.contains(event.target as Node)) return
      setShowHistory(false)
      setEditingSessionId(null)
      setEditingTitle('')
    }

    document.addEventListener('pointerdown', closeHistory)
    return () => document.removeEventListener('pointerdown', closeHistory)
  }, [showHistory])

  const activeSession = useMemo(
    () => agentSessions.find((session) => session.id === activeSessionId) || agentSessions[0],
    [activeSessionId, agentSessions]
  )

  useEffect(() => {
    const stage = chatStageRef.current
    if (!stage) return
    requestAnimationFrame(() => {
      stage.scrollTop = stage.scrollHeight
    })
  }, [activeSessionId, activeSession?.messages.length, answerText, events.length, error, isRunning])

  const sortedAgentSessions = useMemo(
    () => [...agentSessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [agentSessions]
  )

  const visibleHistorySessions = useMemo(() => {
    const query = historyQuery.trim().toLowerCase()
    return sortedAgentSessions
      .filter((session) => {
        if (!query) return true
        const latest = session.latestMessage?.content || session.messages[session.messages.length - 1]?.content || ''
        return `${session.title} ${latest}`.toLowerCase().includes(query)
      })
      .slice(0, 5)
  }, [historyQuery, sortedAgentSessions])

  const createSession = async () => {
    const next = await window.electronAPI.agent.createSession({ agentId: selectedAgentId || undefined })
    if (!next?.id) return
    const normalized = normalizeAgentSession(next)
    setAgentSessions((prev) => [normalized, ...prev.filter((session) => session.id !== normalized.id)])
    setActiveSessionId(normalized.id)
    setShowHistory(false)
    await loadSessionDetail(normalized.id)
  }

  const removeSession = async (id: string) => {
    await window.electronAPI.agent.deleteSession(id)
    const next = agentSessions.filter((session) => session.id !== id)
    if (next.length === 0) {
      const created = await window.electronAPI.agent.createSession({ agentId: selectedAgentId || undefined })
      if (created?.id) {
        const normalized = normalizeAgentSession(created)
        setAgentSessions([normalized])
        setActiveSessionId(normalized.id)
        await loadSessionDetail(normalized.id)
      }
    } else {
      setAgentSessions(next)
      if (activeSessionId === id) {
        setActiveSessionId(next[0].id)
        await loadSessionDetail(next[0].id)
      }
    }
    if (editingSessionId === id) {
      setEditingSessionId(null)
      setEditingTitle('')
    }
  }

  const selectHistorySession = async (id: string) => {
    setActiveSessionId(id)
    setShowHistory(false)
    setEditingSessionId(null)
    await loadSessionDetail(id)
  }

  const startEditSession = (session: AgentSession) => {
    setEditingSessionId(session.id)
    setEditingTitle(session.title)
  }

  const saveSessionTitle = async (id: string) => {
    const title = editingTitle.trim()
    if (!title) return
    const updated = await window.electronAPI.agent.updateSession(id, { title })
    if (updated) {
      setAgentSessions((prev) => prev.map((session) => (
        session.id === id ? normalizeAgentSession(updated, session) : session
      )))
    }
    setEditingSessionId(null)
    setEditingTitle('')
  }

  const activeRunEvents = pendingSessionId.current === activeSession?.id ? events : []
  const activeRunAnswerText = pendingSessionId.current === activeSession?.id ? answerText : ''
  const activeRunIsRunning = isRunning && pendingSessionId.current === activeSession?.id
  const activeTokenUsage = useMemo(
    () => buildTokenStats(activeSession?.messages || [], activeRunEvents),
    [activeRunEvents, activeSession?.messages]
  )
  const activeMemoryState = activeSession?.id ? memoryStates[activeSession.id] : null

  const refreshSessionMemoryState = async (sessionId: string) => {
    const state = await loadMemoryState(sessionId)
    const detail = await window.electronAPI.agent.getSession(sessionId)
    if (detail) {
      setAgentSessions((prev) => prev.map((session) => (
        session.id === sessionId ? normalizeAgentSession(detail, session) : session
      )))
    }
    return state
  }

  const openSummaryDialog = async (session?: AgentSession) => {
    if (!session) return
    setShowHistory(false)
    setShowConfig(false)
    setMemoryDialog(null)
    setEditingSummaryId(null)
    setSummaryDraft('')
    setSummaryDialog({
      sessionId: session.id,
      title: session.title,
      loading: true,
      items: []
    })
    try {
      const items = await window.electronAPI.agent.listSessionSummaries(session.id)
      await refreshSessionMemoryState(session.id).catch(() => undefined)
      setSummaryDialog({
        sessionId: session.id,
        title: session.title,
        loading: false,
        items: Array.isArray(items) ? items : []
      })
    } catch (error) {
      setSummaryDialog({
        sessionId: session.id,
        title: session.title,
        loading: false,
        items: [],
        error: `读取上下文摘要失败：${error instanceof Error ? error.message : String(error)}`
      })
    }
  }

  const saveSummary = async (item: AgentSummaryView) => {
    const content = summaryDraft.trim()
    if (!content) return
    const updated = await window.electronAPI.agent.updateSessionSummary(item.id, content)
    if (!updated) return
    setSummaryDialog((current) => current ? {
      ...current,
      items: current.items.map((summary) => summary.id === item.id ? { ...summary, ...updated } : summary)
    } : current)
    setEditingSummaryId(null)
    setSummaryDraft('')
  }

  const deleteSummary = async (item: AgentSummaryView) => {
    const result = await window.electronAPI.agent.deleteSessionSummary(item.id)
    if (!result.success) return
    setSummaryDialog((current) => current ? {
      ...current,
      items: current.items.filter((summary) => summary.id !== item.id)
    } : current)
    const state = result.memoryState ? normalizeMemoryState(result.memoryState) : await loadMemoryState(item.sessionId)
    if (state) setMemoryStates((prev) => ({ ...prev, [item.sessionId]: state }))
    setAgentSessions((prev) => prev.map((session) => (
      session.id === item.sessionId ? { ...session, summaryCount: Math.max(0, (session.summaryCount || 1) - 1) } : session
    )))
  }

  const compressActiveSession = async (session?: AgentSession) => {
    if (!session || compressingSessionId) return
    setCompressingSessionId(session.id)
    try {
      const result = await window.electronAPI.agent.compressSessionContext({
        sessionId: session.id,
        agentId: selectedAgentId || session.agentId
      })
      if (result.memoryState) {
        setMemoryStates((prev) => ({ ...prev, [session.id]: normalizeMemoryState(result.memoryState) }))
      } else {
        await loadMemoryState(session.id).catch(() => undefined)
      }
      const detail = await window.electronAPI.agent.getSession(session.id)
      if (detail) {
        const normalized = normalizeAgentSession(detail)
        setAgentSessions((prev) => prev.map((item) => item.id === session.id ? normalizeAgentSession(normalized, item) : item))
      }
      if (summaryDialog?.sessionId === session.id) {
        const items = await window.electronAPI.agent.listSessionSummaries(session.id)
        setSummaryDialog((current) => current && current.sessionId === session.id ? {
          ...current,
          loading: false,
          items: Array.isArray(items) ? items : [],
          error: result.success ? undefined : result.error
        } : current)
      }
    } catch (error) {
      if (summaryDialog?.sessionId === session.id) {
        setSummaryDialog((current) => current && current.sessionId === session.id ? {
          ...current,
          loading: false,
          error: `手动压缩失败：${error instanceof Error ? error.message : String(error)}`
        } : current)
      }
    } finally {
      setCompressingSessionId(null)
    }
  }

  const openMemoryDialog = async (session?: AgentSession) => {
    if (!session) return
    setShowHistory(false)
    setShowConfig(false)
    setSummaryDialog(null)
    setEditingMemoryId(null)
    setMemoryDraft({ title: '', content: '' })
    setMemoryDialog({
      sessionId: session.id,
      title: session.title,
      loading: true,
      items: []
    })
    try {
      const items = await window.electronAPI.agent.listSessionObservations(session.id)
      await refreshSessionMemoryState(session.id).catch(() => undefined)
      setMemoryDialog({
        sessionId: session.id,
        title: session.title,
        loading: false,
        items: Array.isArray(items) ? items : []
      })
    } catch {
      setMemoryDialog({
        sessionId: session.id,
        title: session.title,
        loading: false,
        items: []
      })
    }
  }

  const saveMemory = async (item: AgentObservationView) => {
    const title = memoryDraft.title.trim()
    const content = memoryDraft.content.trim()
    if (!title || !content) return
    const updated = await window.electronAPI.agent.updateSessionObservation(item.id, { title, content })
    if (!updated) return
    setMemoryDialog((current) => current ? {
      ...current,
      items: current.items.map((memory) => memory.id === item.id ? { ...memory, ...updated } : memory)
    } : current)
    setEditingMemoryId(null)
    setMemoryDraft({ title: '', content: '' })
  }

  const deleteMemory = async (item: AgentObservationView) => {
    const result = await window.electronAPI.agent.deleteSessionObservation(item.id)
    if (!result.success) return
    setMemoryDialog((current) => current ? {
      ...current,
      items: current.items.filter((memory) => memory.id !== item.id)
    } : current)
    const sessionId = item.sessionId || memoryDialog?.sessionId
    if (!sessionId) return
    const state = result.memoryState ? normalizeMemoryState(result.memoryState) : await loadMemoryState(sessionId)
    if (state) setMemoryStates((prev) => ({ ...prev, [sessionId]: state }))
    setAgentSessions((prev) => prev.map((session) => (
      session.id === sessionId ? { ...session, observationCount: Math.max(0, (session.observationCount || 1) - 1) } : session
    )))
  }

  const handleEditMessage = (msg: AgentChatMessage) => {
    setEditDraft({
      content: msg.content,
      selection: (msg.selection as AgentCommandSelection) || {} as AgentCommandSelection,
      sequence: msg.sequence
    })
  }

  const runCommand = async (message: string, selection: AgentCommandSelection) => {
    setCommandError('')
    const editingSequence = editDraft?.sequence
    setEditDraft(null)
    let sessionId = activeSession?.id
    if (!sessionId) {
      const next = await window.electronAPI.agent.createSession({ agentId: selectedAgentId || undefined })
      if (!next?.id) return
      const normalized = normalizeAgentSession(next)
      sessionId = normalized.id
      setAgentSessions((prev) => [normalized, ...prev])
      setActiveSessionId(normalized.id)
    }

    if (editingSequence != null) {
      await window.electronAPI.agent.truncateSessionMessages(sessionId, editingSequence)
      setAgentSessions((prev) => prev.map((session) => {
        if (session.id !== sessionId) return session
        const kept = session.messages.filter((msg) => !msg.sequence || msg.sequence < editingSequence)
        return {
          ...session,
          messages: kept,
          messageCount: kept.length,
          updatedAt: Date.now()
        }
      }))
    }

    const userMessage: AgentChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: message,
      createdAt: Date.now(),
      selection,
      agentName: activeWorkflowName ? `${activeAgentName} / ${activeWorkflowName}` : activeAgentName
    }
    pendingSessionId.current = sessionId
    setAgentSessions((prev) => prev.map((session) => {
      if (session.id !== sessionId) return session
      const nextTitle = session.messages.length || session.messageCount ? session.title : titleFromMessage(message)
      return {
        ...session,
        title: nextTitle,
        messageCount: (session.messageCount || session.messages.length || 0) + 1,
        latestMessage: userMessage,
        observationCount: session.observationCount || 0,
        updatedAt: Date.now(),
        messages: [...session.messages, userMessage]
      }
    }))
    const result = await execute(message, selection, sessionId)
    if (!result.success) {
      pendingSessionId.current = null
      setCommandError(result.error || 'Agent 执行失败')
      await loadSessionDetail(sessionId)
    }
  }

  return (
    <div className="agent-workbench">
      <main className="agent-chat-shell">
        <header className="agent-chat-header">
          <div>
            <h1><Bot size={27} />Agent</h1>
            <p>通过输入框选择会话、联系人、操作和 Agent，结果会保存在当前历史会话中。</p>
          </div>
          <div className="agent-chat-actions">
            <button type="button" onClick={createSession}>
              <Plus size={16} />新会话
            </button>
            <div className="agent-history-control" ref={historyControlRef}>
              <button
                type="button"
                className={showHistory ? 'active' : ''}
                onClick={() => {
                  setShowHistory((open) => !open)
                  setShowConfig(false)
                }}
              >
                <History size={16} />历史会话
              </button>
              {showHistory && (
                <div className="agent-history-popover">
                  <label className="agent-history-search">
                    <Search size={15} />
                    <input
                      value={historyQuery}
                      onChange={(event) => setHistoryQuery(event.target.value)}
                      placeholder="搜索会话"
                      autoFocus
                    />
                  </label>

                  <div className="agent-history-list">
                    {visibleHistorySessions.length === 0 && (
                      <div className="agent-history-empty">没有匹配的历史会话</div>
                    )}
                    {visibleHistorySessions.map((session) => {
                      const latest = previewMessage(session.latestMessage || session.messages[session.messages.length - 1])
                      const editing = editingSessionId === session.id
                      return (
                        <div key={session.id} className={`agent-history-item ${session.id === activeSessionId ? 'active' : ''}`}>
                          {editing ? (
                            <div className="agent-history-edit">
                              <input
                                value={editingTitle}
                                onChange={(event) => setEditingTitle(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') saveSessionTitle(session.id)
                                  if (event.key === 'Escape') {
                                    setEditingSessionId(null)
                                    setEditingTitle('')
                                  }
                                }}
                                onClick={(event) => event.stopPropagation()}
                                autoFocus
                              />
                              <button type="button" onClick={() => saveSessionTitle(session.id)} title="保存">
                                <Check size={14} />
                              </button>
                              <button type="button" onClick={() => { setEditingSessionId(null); setEditingTitle('') }} title="取消">
                                <X size={14} />
                              </button>
                            </div>
                          ) : (
                            <>
                              <button type="button" className="agent-history-select" onClick={() => selectHistorySession(session.id)}>
                                <MessageSquare size={16} />
                                <span>
                                  <strong>{session.title}</strong>
                                  <small>{latest}</small>
                                </span>
                                <time>{formatSessionTime(session.updatedAt)}</time>
                              </button>
                              <div className="agent-history-actions">
                                <button type="button" onClick={() => startEditSession(session)} title="编辑">
                                  <Edit3 size={14} />
                                </button>
                                <button type="button" onClick={() => removeSession(session.id)} title="删除">
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
            <button
              type="button"
              className={summaryDialog ? 'active' : ''}
              onClick={() => openSummaryDialog(activeSession)}
              disabled={!activeSession}
            >
              <FileText size={16} />上下文摘要
            </button>
            <button
              type="button"
              className={memoryDialog ? 'active' : ''}
              onClick={() => openMemoryDialog(activeSession)}
              disabled={!activeSession}
            >
              <BookOpen size={16} />长期记忆
            </button>
            <div className="agent-manager-control">
              <button
                type="button"
                className={showConfig ? 'active' : ''}
                onClick={() => {
                  setShowConfig((open) => !open)
                  setShowHistory(false)
                }}
              >
                <Settings2 size={16} />Agent 管理
              </button>
            </div>
          </div>
        </header>

        <section className="agent-context-strip">
          <span><Bot size={15} />{activeAgentName}</span>
          {activeWorkflowName && <span><FileText size={15} />{activeWorkflowName}</span>}
          <span><Clock3 size={15} />{activeSession?.messages.length || 0} 条消息</span>
          <span><Brain size={15} />滚动摘要 {activeMemoryState?.summaryCount || activeSession?.summaryCount || 0}</span>
          <span><BookOpen size={15} />记忆 {activeMemoryState?.observationCount || activeSession?.observationCount || 0}</span>
        </section>

        <section className="agent-chat-stage" ref={chatStageRef}>
          <AgentConversation
            messages={activeSession?.messages || []}
            events={activeRunEvents}
            answerText={activeRunAnswerText}
            isRunning={activeRunIsRunning}
            agentName={activeAgentName}
            userAvatarUrl={myAvatarUrl}
            onEditMessage={handleEditMessage}
          />
          {commandError && <div className="agent-inline-error">{commandError}</div>}
          {error && pendingSessionId.current === activeSession?.id && <div className="agent-inline-error">{error}</div>}
        </section>

        <CommandInput
          agents={agents}
          workflows={workflows}
          skills={skills}
          sessions={sessions}
          contacts={contacts}
          selectedAgentId={selectedAgentId}
          selectedWorkflowId={selectedWorkflowId}
          isRunning={isRunning}
          tokenUsage={activeTokenUsage}
          memoryState={activeMemoryState || {
            summaryCount: activeSession?.summaryCount || 0,
            observationCount: activeSession?.observationCount || 0,
            summarizedMessages: 0,
            recentMessages: activeSession?.messages.length || 0,
            estimatedContextTokens: 0
          }}
          isCompressing={compressingSessionId === activeSession?.id}
          editDraft={editDraft}
          onSubmit={runCommand}
          onCancel={cancel}
          onAgentSelect={selectAgent}
          onWorkflowSelect={selectWorkflow}
          onCompress={() => compressActiveSession(activeSession)}
        />
      </main>

      {showConfig && (
        <div className="agent-manager-dialog-backdrop" onPointerDown={() => setShowConfig(false)}>
          <section className="agent-manager-dialog" role="dialog" aria-modal="true" onPointerDown={(event) => event.stopPropagation()}>
            <header className="agent-manager-dialog-header">
              <div>
                <h2>Agent 管理</h2>
                <span>管理内置 Agent 与自定义 Agent 的配置</span>
              </div>
              <button type="button" onClick={() => setShowConfig(false)} aria-label="关闭 Agent 管理">
                <X size={16} />
              </button>
            </header>
            <AgentConfigPanel
              agents={agents}
              selectedAgentId={selectedAgentId}
              tools={tools}
              onSelectAgent={selectAgent}
              onSaved={async () => { await loadAgents(); await loadTools() }}
            />
          </section>
        </div>
      )}

      {summaryDialog && (
        <div className="agent-manager-dialog-backdrop" onPointerDown={() => setSummaryDialog(null)}>
          <section className="agent-summary-dialog" role="dialog" aria-modal="true" onPointerDown={(event) => event.stopPropagation()}>
            <header className="agent-manager-dialog-header">
              <div>
                <h2>上下文摘要</h2>
                <span>{summaryDialog.title}</span>
              </div>
              <button type="button" onClick={() => setSummaryDialog(null)} aria-label="关闭上下文摘要">
                <X size={16} />
              </button>
            </header>
            <div className="agent-summary-dialog-body">
              {summaryDialog.loading ? (
                <div className="agent-summary-empty">正在读取上下文摘要...</div>
              ) : summaryDialog.error ? (
                <div className="agent-summary-empty">{summaryDialog.error}</div>
              ) : summaryDialog.items.length === 0 ? (
                <div className="agent-summary-empty">当前会话还没有生成上下文摘要。</div>
              ) : (
                <div className="agent-memory-list">
                  {summaryDialog.items.map((item) => (
                    <article key={item.id} className="agent-memory-item">
                      <header>
                        <span>滚动摘要</span>
                        <strong>覆盖 {item.messageCount} 条消息</strong>
                        <div className="agent-memory-actions">
                          {editingSummaryId === item.id ? (
                            <>
                              <button type="button" onClick={() => saveSummary(item)} title="保存">
                                <Check size={14} />
                              </button>
                              <button type="button" onClick={() => { setEditingSummaryId(null); setSummaryDraft('') }} title="取消">
                                <X size={14} />
                              </button>
                            </>
                          ) : (
                            <>
                              <button type="button" onClick={() => { setEditingSummaryId(item.id); setSummaryDraft(item.content) }} title="编辑">
                                <Edit3 size={14} />
                              </button>
                              <button type="button" onClick={() => deleteSummary(item)} title="删除">
                                <Trash2 size={14} />
                              </button>
                            </>
                          )}
                        </div>
                      </header>
                      {editingSummaryId === item.id ? (
                        <textarea
                          className="agent-memory-editor"
                          value={summaryDraft}
                          onChange={(event) => setSummaryDraft(event.target.value)}
                          autoFocus
                        />
                      ) : (
                        <div
                          className="agent-memory-markdown agent-markdown"
                          dangerouslySetInnerHTML={renderMarkdown(item.content)}
                        />
                      )}
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {memoryDialog && (
        <div className="agent-manager-dialog-backdrop" onPointerDown={() => setMemoryDialog(null)}>
          <section className="agent-summary-dialog" role="dialog" aria-modal="true" onPointerDown={(event) => event.stopPropagation()}>
            <header className="agent-manager-dialog-header">
              <div>
                <h2>长期记忆</h2>
                <span>{memoryDialog.title}</span>
              </div>
              <button type="button" onClick={() => setMemoryDialog(null)} aria-label="关闭长期记忆">
                <X size={16} />
              </button>
            </header>
            <div className="agent-summary-dialog-body">
              {memoryDialog.loading ? (
                <div className="agent-summary-empty">正在读取长期记忆...</div>
              ) : memoryDialog.items.length === 0 ? (
                <div className="agent-summary-empty">当前会话还没有长期记忆。</div>
              ) : (
                <div className="agent-memory-list">
                  {memoryDialog.items.map((item) => (
                    <article key={item.id} className="agent-memory-item">
                      <header>
                        <span>{item.type}</span>
                        <strong>{item.title}</strong>
                        <div className="agent-memory-actions">
                          {editingMemoryId === item.id ? (
                            <>
                              <button type="button" onClick={() => saveMemory(item)} title="保存">
                                <Check size={14} />
                              </button>
                              <button type="button" onClick={() => { setEditingMemoryId(null); setMemoryDraft({ title: '', content: '' }) }} title="取消">
                                <X size={14} />
                              </button>
                            </>
                          ) : (
                            <>
                              <button type="button" onClick={() => { setEditingMemoryId(item.id); setMemoryDraft({ title: item.title, content: item.content }) }} title="编辑">
                                <Edit3 size={14} />
                              </button>
                              <button type="button" onClick={() => deleteMemory(item)} title="删除">
                                <Trash2 size={14} />
                              </button>
                            </>
                          )}
                        </div>
                      </header>
                      {editingMemoryId === item.id ? (
                        <div className="agent-memory-edit-form">
                          <input
                            value={memoryDraft.title}
                            onChange={(event) => setMemoryDraft((current) => ({ ...current, title: event.target.value }))}
                            placeholder="记忆标题"
                          />
                          <textarea
                            value={memoryDraft.content}
                            onChange={(event) => setMemoryDraft((current) => ({ ...current, content: event.target.value }))}
                            placeholder="Markdown 记忆内容"
                          />
                        </div>
                      ) : (
                        <div
                          className="agent-memory-markdown agent-markdown"
                          dangerouslySetInnerHTML={renderMarkdown(item.content)}
                        />
                      )}
                      {item.tags && item.tags.length > 0 && (
                        <div className="agent-memory-tags">
                          {item.tags.map((tag) => <span key={tag}>{tag}</span>)}
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
