import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Check, Clock3, Edit3, History, MessageSquare, Plus, Search, Settings2, Trash2, X } from 'lucide-react'
import type { ChatSession, ContactInfo } from '../types/models'
import { useAgentStore } from '../stores/agentStore'
import CommandInput, { type AgentCommandSelection, type AgentSkillOption, type AgentTokenUsageView } from '../components/agent/CommandInput'
import AgentConversation, { type AgentChatMessage } from '../components/agent/AgentConversation'
import AgentConfigPanel from '../components/agent/AgentConfigPanel'
import './AgentPage.scss'

type AgentSession = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: AgentChatMessage[]
}

const STORAGE_KEY = 'agent:chatSessions'

function createAgentSession(): AgentSession {
  const now = Date.now()
  return {
    id: `agent-session-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: '新的对话',
    createdAt: now,
    updatedAt: now,
    messages: []
  }
}

function loadAgentSessions(): AgentSession[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return [createAgentSession()]
    const sessions = parsed
      .filter((item) => item && typeof item.id === 'string')
      .map((item) => ({
        id: item.id,
        title: typeof item.title === 'string' ? item.title : '历史对话',
        createdAt: Number(item.createdAt) || Date.now(),
        updatedAt: Number(item.updatedAt) || Date.now(),
        messages: Array.isArray(item.messages) ? item.messages : []
      }))
      .slice(0, 40)
    return sessions.length ? sessions : [createAgentSession()]
  } catch {
    return [createAgentSession()]
  }
}

function saveAgentSessions(sessions: AgentSession[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(0, 40)))
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
    tools,
    selectedAgentId,
    isRunning,
    events,
    answerText,
    error,
    loadAgents,
    loadTools,
    selectAgent,
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
  const [agentSessions, setAgentSessions] = useState<AgentSession[]>(() => loadAgentSessions())
  const [activeSessionId, setActiveSessionId] = useState(() => agentSessions[0]?.id || '')
  const pendingSessionId = useRef<string | null>(null)
  const chatStageRef = useRef<HTMLElement | null>(null)
  const historyControlRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void loadAgents()
    void loadTools()
    void window.electronAPI.chat.getSessions(0, 300).then((result) => {
      if (result.success && result.sessions) setSessions(result.sessions)
    }).catch(() => undefined)
    void window.electronAPI.chat.getContacts().then((result) => {
      if (result.success && result.contacts) setContacts(result.contacts)
    }).catch(() => undefined)
    void window.electronAPI.skillManager.list().then(setSkills).catch(() => undefined)
  }, [loadAgents, loadTools])

  useEffect(() => {
    saveAgentSessions(agentSessions)
  }, [agentSessions])

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

  useEffect(() => {
    if (isRunning || !pendingSessionId.current) return
    if (!answerText && !error) return
    const sessionId = pendingSessionId.current
    pendingSessionId.current = null
    const content = answerText || error || ''
    setAgentSessions((prev) => prev.map((session) => {
      if (session.id !== sessionId) return session
      return {
        ...session,
        updatedAt: Date.now(),
        messages: [
          ...session.messages,
          {
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content,
            createdAt: Date.now(),
            agentName: activeAgentName,
            error: Boolean(error && !answerText),
            events
          }
        ]
      }
    }))
  }, [activeAgentName, answerText, error, events, isRunning])

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
        const latest = session.messages[session.messages.length - 1]?.content || ''
        return `${session.title} ${latest}`.toLowerCase().includes(query)
      })
      .slice(0, 5)
  }, [historyQuery, sortedAgentSessions])

  const createSession = () => {
    const next = createAgentSession()
    setAgentSessions((prev) => [next, ...prev])
    setActiveSessionId(next.id)
    setShowHistory(false)
  }

  const removeSession = (id: string) => {
    setAgentSessions((prev) => {
      const next = prev.filter((session) => session.id !== id)
      const safeNext = next.length ? next : [createAgentSession()]
      if (activeSessionId === id) setActiveSessionId(safeNext[0].id)
      return safeNext
    })
    if (editingSessionId === id) {
      setEditingSessionId(null)
      setEditingTitle('')
    }
  }

  const selectHistorySession = (id: string) => {
    setActiveSessionId(id)
    setShowHistory(false)
    setEditingSessionId(null)
  }

  const startEditSession = (session: AgentSession) => {
    setEditingSessionId(session.id)
    setEditingTitle(session.title)
  }

  const saveSessionTitle = (id: string) => {
    const title = editingTitle.trim()
    if (!title) return
    setAgentSessions((prev) => prev.map((session) => (
      session.id === id ? { ...session, title, updatedAt: Date.now() } : session
    )))
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

  const runCommand = async (message: string, selection: AgentCommandSelection) => {
    let sessionId = activeSession?.id
    if (!sessionId) {
      const next = createAgentSession()
      sessionId = next.id
      setAgentSessions((prev) => [next, ...prev])
      setActiveSessionId(next.id)
    }

    const userMessage: AgentChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: message,
      createdAt: Date.now(),
      selection,
      agentName: activeAgentName
    }
    pendingSessionId.current = sessionId
    setAgentSessions((prev) => prev.map((session) => {
      if (session.id !== sessionId) return session
      return {
        ...session,
        title: session.messages.length ? session.title : titleFromMessage(message),
        updatedAt: Date.now(),
        messages: [...session.messages, userMessage]
      }
    }))
    await execute(message, selection)
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
                      const latest = previewMessage(session.messages[session.messages.length - 1])
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
          <span><Clock3 size={15} />{activeSession?.messages.length || 0} 条消息</span>
        </section>

        <section className="agent-chat-stage" ref={chatStageRef}>
          <AgentConversation
            messages={activeSession?.messages || []}
            events={activeRunEvents}
            answerText={activeRunAnswerText}
            isRunning={activeRunIsRunning}
            agentName={activeAgentName}
          />
          {error && pendingSessionId.current === activeSession?.id && <div className="agent-inline-error">{error}</div>}
        </section>

        <CommandInput
          agents={agents}
          skills={skills}
          sessions={sessions}
          contacts={contacts}
          selectedAgentId={selectedAgentId}
          isRunning={isRunning}
          tokenUsage={activeTokenUsage}
          onSubmit={runCommand}
          onCancel={cancel}
          onAgentSelect={selectAgent}
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
    </div>
  )
}
