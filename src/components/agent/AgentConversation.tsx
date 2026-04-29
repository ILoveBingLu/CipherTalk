import { useMemo, useState } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { BookOpen, Bot, Brain, CalendarDays, Check, ChevronDown, CircleCheck, CircleDashed, CircleX, Copy, ListFilter, UserRound, Wrench } from 'lucide-react'
import type { AgentConversationEvent } from '../../stores/agentStore'
import type { AgentCommandSelection } from './CommandInput'

export type AgentChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  selection?: unknown
  agentName?: string
  error?: boolean
  events?: AgentConversationEvent[]
}

interface Props {
  messages: AgentChatMessage[]
  events: AgentConversationEvent[]
  answerText: string
  isRunning: boolean
  agentName?: string
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function renderJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2)
  } catch {
    return String(value)
  }
}

function isSelection(value: unknown): value is AgentCommandSelection {
  const selection = value as AgentCommandSelection
  return Boolean(selection && Array.isArray(selection.selectedSessions) && Array.isArray(selection.selectedContacts))
}

function getSelectionTokens(selection: unknown): string[] {
  if (!isSelection(selection)) return []
  return [
    ...selection.selectedSessions.map((item) => item.token),
    ...selection.selectedContacts.map((item) => item.token),
    ...(selection.selectedSkills || []).map((item) => item.token),
    selection.action?.token,
    selection.timeRange?.token,
    selection.selectedAgent?.token
  ].filter((token): token is string => Boolean(token))
}

function stripSelectionTokens(content: string, selection: unknown): string {
  let text = content
  getSelectionTokens(selection).forEach((token) => {
    text = text.replace(token, ' ')
  })
  return text.replace(/\s+/g, ' ').trim()
}

export default function AgentConversation({ messages, events, answerText, isRunning, agentName = 'Agent' }: Props) {
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const copyContent = async (id: string, content: string) => {
    if (!content.trim()) return
    try {
      await navigator.clipboard.writeText(content)
      setCopiedId(id)
      window.setTimeout(() => setCopiedId((current) => current === id ? null : current), 1400)
    } catch {
      setCopiedId(null)
    }
  }

  return (
    <div className="agent-conversation">
      {messages.length === 0 && !answerText && (
        <div className="agent-empty">
          <SparkIcon />
          <strong>开始一个 Agent 对话</strong>
          <span>在底部输入框用 # 选择会话或联系人，用 $ 加载技能，用 / 选择操作。</span>
        </div>
      )}

      {messages.map((message) => (
        <article key={message.id} className={`agent-message ${message.role} ${message.error ? 'error' : ''}`}>
          <div className="agent-message-avatar">
            {message.role === 'user' ? <UserRound size={18} /> : <Bot size={18} />}
          </div>
          <div className="agent-message-body">
            <header>
              <strong>{message.role === 'user' ? '你' : message.agentName || 'Agent'}</strong>
              <time>{formatTime(message.createdAt)}</time>
              {message.role === 'assistant' && message.content && (
                <button
                  type="button"
                  className="agent-message-copy"
                  onClick={() => copyContent(message.id, message.content)}
                  title={copiedId === message.id ? '已复制' : '复制输出'}
                >
                  {copiedId === message.id ? <Check size={14} /> : <Copy size={14} />}
                </button>
              )}
            </header>
            {message.role === 'assistant' && !message.error ? (
              <>
                <AgentRunSections events={message.events || []} />
                <AgentMarkdown content={message.content} />
              </>
            ) : (
              <UserMessageContent message={message} />
            )}
          </div>
        </article>
      ))}

      {(isRunning || answerText || events.length > 0) && (
        <article className="agent-message assistant live">
          <div className="agent-message-avatar"><Bot size={18} /></div>
          <div className="agent-message-body">
            <header>
              <strong>{agentName}</strong>
              {isRunning && <time>Thinking</time>}
              {answerText && (
                <button
                  type="button"
                  className="agent-message-copy"
                  onClick={() => copyContent('live-answer', answerText)}
                  title={copiedId === 'live-answer' ? '已复制' : '复制输出'}
                >
                  {copiedId === 'live-answer' ? <Check size={14} /> : <Copy size={14} />}
                </button>
              )}
            </header>
            <AgentRunSections events={events} />
            {answerText && <AgentMarkdown content={answerText} streaming />}
          </div>
        </article>
      )}

    </div>
  )
}

function SparkIcon() {
  return <span className="agent-empty-icon">✦</span>
}

function AgentRunSections({ events }: { events: AgentConversationEvent[] }) {
  const thoughtEvents = events.filter((event) => event.type === 'thought' && (event.content || event.message))
  const toolRuns = useMemo(() => buildToolRuns(events), [events])
  const errorEvents = events.filter((event) => event.type === 'error')

  if (thoughtEvents.length === 0 && toolRuns.length === 0 && errorEvents.length === 0) {
    return null
  }

  return (
    <div className="agent-run-sections">
      {thoughtEvents.length > 0 && (
        <details className="agent-run-panel thought">
          <summary>
            <span><Brain size={15} />思考过程</span>
            <small>{thoughtEvents.length} 段</small>
            <ChevronDown size={14} />
          </summary>
          <div className="agent-run-panel-content">
            {thoughtEvents.map((event, index) => (
              <p key={event.id}>{event.content || event.message || `思考片段 ${index + 1}`}</p>
            ))}
          </div>
        </details>
      )}

      {toolRuns.length > 0 && (
        <details className="agent-run-panel tools">
          <summary>
            <span><Wrench size={15} />工具调用</span>
            <small>{formatToolSummary(toolRuns)}</small>
            <ChevronDown size={14} />
          </summary>
          <div className="agent-tool-run-list">
            {toolRuns.map((run) => (
              <details key={run.id} className={`agent-tool-run ${run.status}`}>
                <summary className="agent-tool-run-header">
                  {run.status === 'ok' ? <CircleCheck size={15} /> : run.status === 'failed' ? <CircleX size={15} /> : <CircleDashed size={15} />}
                  <strong>{run.name}</strong>
                  <span>{run.status === 'running' ? '运行中' : run.status === 'ok' ? '完成' : '失败'}</span>
                  <ChevronDown size={14} />
                </summary>
                <div className="agent-tool-run-grid">
                  <label>
                    <span>参数</span>
                    <pre>{renderJson(run.args)}</pre>
                  </label>
                  {run.result && (
                    <label>
                      <span>结果</span>
                      <pre>{run.result.content || run.result.error || '无返回内容'}</pre>
                    </label>
                  )}
                </div>
              </details>
            ))}
          </div>
        </details>
      )}

      {errorEvents.map((event) => (
        <div key={event.id} className="agent-event error">{event.message || event.content}</div>
      ))}

    </div>
  )
}

function UserMessageContent({ message }: { message: AgentChatMessage }) {
  const selection = isSelection(message.selection) ? message.selection : null
  const text = stripSelectionTokens(message.content, message.selection)

  if (!selection) return <p>{message.content}</p>

  return (
    <div className="agent-user-content">
      <SelectionTokenList selection={selection} />
      {text && <p>{text}</p>}
    </div>
  )
}

function SelectionTokenList({ selection }: { selection: AgentCommandSelection }) {
  const hasTokens = selection.selectedSessions.length > 0 ||
    selection.selectedContacts.length > 0 ||
    (selection.selectedSkills || []).length > 0 ||
    Boolean(selection.action) ||
    Boolean(selection.timeRange) ||
    Boolean(selection.selectedAgent)

  if (!hasTokens) return null

  return (
    <div className="agent-message-token-list">
      {selection.selectedSessions.map((item) => (
        <MessageToken key={`session:${item.id}`} item={item} kind="session" />
      ))}
      {selection.selectedContacts.map((item) => (
        <MessageToken key={`contact:${item.id}`} item={item} kind="contact" />
      ))}
      {(selection.selectedSkills || []).map((item) => (
        <MessageToken key={`skill:${item.id}`} item={item} kind="skill" />
      ))}
      {selection.action && (
        <MessageToken item={{ id: selection.action.id, name: selection.action.label, token: selection.action.token }} kind="tool" />
      )}
      {selection.timeRange && (
        <MessageToken item={{ id: selection.timeRange.label, name: selection.timeRange.label, token: selection.timeRange.token }} kind="time" />
      )}
      {selection.selectedAgent && (
        <MessageToken item={selection.selectedAgent} kind="agent" />
      )}
    </div>
  )
}

function MessageToken({
  item,
  kind
}: {
  item: { id: string; name: string; token?: string; avatarUrl?: string }
  kind: 'session' | 'contact' | 'tool' | 'time' | 'agent' | 'skill'
}) {
  const initials = item.name.trim().slice(0, 1).toUpperCase()
  const marker = item.token?.startsWith('t:') ? 't:' : item.token?.slice(0, 1)

  return (
    <span className={`agent-message-token ${kind}`}>
      {kind === 'session' || kind === 'contact' ? (
        item.avatarUrl ? <img src={item.avatarUrl} alt="" /> : <span className="agent-message-token-avatar">{initials || '#'}</span>
      ) : kind === 'tool' ? (
        <ListFilter size={13} />
      ) : kind === 'skill' ? (
        <BookOpen size={13} />
      ) : kind === 'agent' ? (
        <Bot size={13} />
      ) : (
        <CalendarDays size={13} />
      )}
      {marker && <span className="agent-message-token-marker">{marker}</span>}
      <span className="agent-message-token-name">{item.name}</span>
    </span>
  )
}

type ToolRun = {
  id: string
  name: string
  args?: Record<string, unknown>
  result?: { ok: boolean; content: string; error?: string }
  status: 'running' | 'ok' | 'failed'
}

function buildToolRuns(events: AgentConversationEvent[]): ToolRun[] {
  const runs = new Map<string, ToolRun>()

  events.forEach((event) => {
    if (event.type !== 'tool_call' && event.type !== 'tool_result') return
    const id = event.toolCallId || event.id
    const previous = runs.get(id)

    if (event.type === 'tool_call') {
      runs.set(id, {
        id,
        name: event.name || event.toolId || '工具',
        args: event.args,
        result: previous?.result,
        status: previous?.status || 'running'
      })
      return
    }

    const ok = Boolean(event.result?.ok)
    runs.set(id, {
      id,
      name: previous?.name || event.name || event.toolId || '工具',
      args: previous?.args || event.args,
      result: event.result,
      status: ok ? 'ok' : 'failed'
    })
  })

  return Array.from(runs.values())
}

function formatToolSummary(runs: ToolRun[]): string {
  const running = runs.filter((run) => run.status === 'running').length
  const failed = runs.filter((run) => run.status === 'failed').length
  if (running) return `${runs.length} 个，${running} 个运行中`
  if (failed) return `${runs.length} 个，${failed} 个失败`
  return `${runs.length} 个`
}

function AgentMarkdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const html = useMemo(() => {
    const parsed = marked.parse(content || '') as string
    return DOMPurify.sanitize(parsed)
  }, [content])

  return (
    <div
      className={`agent-markdown ${streaming ? 'streaming' : ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
