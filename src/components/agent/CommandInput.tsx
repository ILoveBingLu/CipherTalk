import { BookOpen, Bot, CalendarDays, Hash, ListFilter, Send, Square, UserRound, UserRoundCog, Wrench, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { ChatSession, ContactInfo } from '../../types/models'
import type { AgentDefinitionView } from '../../stores/agentStore'

export type AgentActionPreset = {
  id: string
  label: string
  prompt: string
}

export type AgentSkillOption = {
  name: string
  version: string
  description: string
  builtin: boolean
}

export type AgentCommandSelection = {
  selectedSessions: TokenizedSelectionItem[]
  selectedContacts: TokenizedSelectionItem[]
  selectedSkills: TokenizedSkill[]
  timeRange: TokenizedTimeRange | null
  action: TokenizedActionPreset | null
  selectedAgent: TokenizedAgent | null
  options: {
    includeSummary: boolean
    includeEvidence: boolean
  }
}

type TokenizedSelectionItem = { id: string; name: string; token: string; avatarUrl?: string }
type TokenizedActionPreset = AgentActionPreset & { token: string }
type TokenizedTimeRange = { label: string; start: number; end: number; token: string }
type TokenizedAgent = { id: string; name: string; token: string }
type TokenizedSkill = { id: string; name: string; description?: string; token: string }

export type AgentTokenUsageView = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

type SuggestionKind = 'session' | 'contact' | 'action' | 'agent' | 'time' | 'skill'

type SuggestionItem = {
  id: string
  kind: SuggestionKind
  label: string
  detail: string
  iconLabel: string
  value: unknown
}

interface Props {
  agents: AgentDefinitionView[]
  skills: AgentSkillOption[]
  sessions: ChatSession[]
  contacts: ContactInfo[]
  selectedAgentId: string | null
  isRunning: boolean
  tokenUsage?: AgentTokenUsageView
  onSubmit: (message: string, selection: AgentCommandSelection) => void
  onCancel: () => void
  onAgentSelect: (id: string) => void
}

export const ACTION_PRESETS: AgentActionPreset[] = [
  { id: 'summary', label: '总结会话', prompt: '请总结选中对象在指定时间范围内的讨论，提炼主题、结论和待办。' },
  { id: 'analysis', label: '分析洞察', prompt: '请分析选中对象的讨论趋势、核心分歧、关键参与者和潜在风险。' },
  { id: 'tasks', label: '提取任务', prompt: '请从选中聊天记录中提取任务、负责人、截止时间和当前状态。' },
  { id: 'report', label: '生成报告', prompt: '请生成一份结构化报告，包含背景、发现、证据和建议。' },
  { id: 'qa', label: '智能问答', prompt: '请基于选中上下文回答我的问题，证据不足时明确说明。' }
]

const TIME_PRESETS = [
  { label: '今天', days: 0 },
  { label: '最近3天', days: 3 },
  { label: '最近7天', days: 7 },
  { label: '本周', days: 7 },
  { label: '本月', days: 30 }
]

function createRange(label: string, days: number): { label: string; start: number; end: number } {
  const end = Math.floor(Date.now() / 1000)
  const start = days === 0 ? Math.floor(new Date().setHours(0, 0, 0, 0) / 1000) : end - days * 24 * 60 * 60
  return { label, start, end }
}

function getDisplayName(session: ChatSession): string {
  return session.displayName || session.username
}

function getContactName(contact: ContactInfo): string {
  return contact.displayName || contact.username
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function getTrigger(text: string, cursor: number): { trigger: string; query: string; start: number } | null {
  const beforeCursor = text.slice(0, cursor)
  const timeMatch = beforeCursor.match(/(^|\s)(t:)([^\s#@/!$]*)$/)
  if (timeMatch) {
    return {
      trigger: timeMatch[2],
      query: timeMatch[3] || '',
      start: beforeCursor.length - timeMatch[2].length - (timeMatch[3]?.length || 0)
    }
  }
  const match = beforeCursor.match(/(^|\s)([#@/!$])([^\s#@/!$]*)$/)
  if (!match) return null
  return {
    trigger: match[2],
    query: match[3] || '',
    start: beforeCursor.length - match[2].length - (match[3]?.length || 0)
  }
}

function removeTriggerText(text: string, start: number, cursor: number): { text: string; cursor: number } {
  const prefix = text.slice(0, start)
  const suffix = text.slice(cursor).replace(/^\s+/, '')
  const spacer = prefix && suffix && !prefix.endsWith(' ') ? ' ' : ''
  const next = `${prefix}${spacer}${suffix}`
  return { text: next, cursor: `${prefix}${spacer}`.length }
}

function createCommandToken(prefix: string, label: string): string {
  return `${prefix}[${label.replace(/\]/g, '］')}]`
}

function formatTokenCount(value: number): string {
  return value.toLocaleString('zh-CN')
}

export default function CommandInput({
  agents,
  skills,
  sessions,
  contacts,
  selectedAgentId,
  isRunning,
  tokenUsage,
  onSubmit,
  onCancel,
  onAgentSelect
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [message, setMessage] = useState('')
  const [cursor, setCursor] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const [selectedSessions, setSelectedSessions] = useState<TokenizedSelectionItem[]>([])
  const [selectedContacts, setSelectedContacts] = useState<TokenizedSelectionItem[]>([])
  const [selectedSkills, setSelectedSkills] = useState<TokenizedSkill[]>([])
  const [timeRange, setTimeRange] = useState<TokenizedTimeRange | null>(null)
  const [action, setAction] = useState<TokenizedActionPreset | null>(null)
  const [selectedAgentChip, setSelectedAgentChip] = useState<TokenizedAgent | null>(null)
  const [options] = useState({ includeSummary: true, includeEvidence: true })

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ||
      agents.find((agent) => agent.id === 'builtin-general-agent') ||
      agents.find((agent) => agent.isBuiltin) ||
      null,
    [agents, selectedAgentId]
  )

  const trigger = useMemo(() => getTrigger(message, cursor), [cursor, message])

  const suggestions = useMemo<SuggestionItem[]>(() => {
    if (!trigger) return []
    const query = normalize(trigger.query)
    const matches = (label: string) => !query || normalize(label).includes(query)

    if (trigger.trigger === '#') {
      const sessionItems = sessions
        .map((session) => ({
          id: `session:${session.username}`,
          kind: 'session' as const,
          label: getDisplayName(session),
          detail: session.type === 2 ? '群聊 / 会话' : '会话',
          iconLabel: '#',
          value: { id: session.username, name: getDisplayName(session), avatarUrl: session.avatarUrl }
        }))
        .filter((item) => matches(item.label))
        .slice(0, 6)
      const contactItems = contacts
        .map((contact) => ({
          id: `contact:${contact.username}`,
          kind: 'contact' as const,
          label: getContactName(contact),
          detail: contact.type === 'group' ? '群聊联系人' : '联系人',
          iconLabel: '#',
          value: { id: contact.username, name: getContactName(contact), avatarUrl: contact.avatarUrl }
        }))
        .filter((item) => matches(item.label))
        .slice(0, 4)
      return [...sessionItems, ...contactItems].slice(0, 8)
    }

    if (trigger.trigger === '@') {
      return contacts
        .map((contact) => ({
          id: `contact:${contact.username}`,
          kind: 'contact' as const,
          label: getContactName(contact),
          detail: contact.type === 'group' ? '群聊联系人' : '联系人',
          iconLabel: '@',
          value: { id: contact.username, name: getContactName(contact), avatarUrl: contact.avatarUrl }
        }))
        .filter((item) => matches(item.label))
        .slice(0, 8)
    }

    if (trigger.trigger === '/') {
      return ACTION_PRESETS
        .filter((item) => matches(item.label))
        .map((item) => ({
          id: `action:${item.id}`,
          kind: 'action' as const,
          label: item.label,
          detail: item.prompt,
          iconLabel: '/',
          value: item
        }))
        .slice(0, 8)
    }

    if (trigger.trigger === '!') {
      return agents
        .filter((agent) => matches(agent.name))
        .map((agent) => ({
          id: `agent:${agent.id}`,
          kind: 'agent' as const,
          label: agent.name,
          detail: agent.description || (agent.isBuiltin ? '内置 Agent' : '自定义 Agent'),
          iconLabel: '!',
          value: agent
        }))
        .slice(0, 8)
    }

    if (trigger.trigger === '$') {
      return skills
        .map((skill) => ({
          id: `skill:${skill.name}`,
          kind: 'skill' as const,
          label: skill.name,
          detail: skill.description || (skill.builtin ? '内置 Skill' : '自定义 Skill'),
          iconLabel: '$',
          value: skill
        }))
        .filter((item) => matches(item.label) || matches(item.detail))
        .slice(0, 8)
    }

    if (trigger.trigger !== 't:') return []

    return TIME_PRESETS
      .filter((item) => matches(item.label))
      .map((item) => {
        const range = createRange(item.label, item.days)
        return {
          id: `time:${item.label}`,
          kind: 'time' as const,
          label: item.label,
          detail: '时间范围',
          iconLabel: 't',
          value: range
        }
      })
      .slice(0, 8)
  }, [agents, contacts, sessions, skills, trigger])

  const applySuggestion = (item: SuggestionItem) => {
    if (!trigger) return
    const prefix = item.kind === 'contact' ? (trigger.trigger === '#' ? '#' : '@') : item.kind === 'action' ? '/' : item.kind === 'agent' ? '!' : item.kind === 'skill' ? '$' : item.kind === 'time' ? 't:' : '#'
    const token = createCommandToken(prefix, item.label)
    const next = removeTriggerText(message, trigger.start, cursor)
    setMessage(next.text)
    setCursor(next.cursor)
    setActiveIndex(0)
    window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(next.cursor, next.cursor)
    })

    if (item.kind === 'session') {
      const value = item.value as { id: string; name: string; avatarUrl?: string }
      setSelectedSessions((prev) => (
        prev.some((session) => session.id === value.id)
          ? prev.map((session) => session.id === value.id ? { ...session, token } : session)
          : [...prev, { ...value, token }]
      ))
    } else if (item.kind === 'contact') {
      const value = item.value as { id: string; name: string; avatarUrl?: string }
      setSelectedContacts((prev) => (
        prev.some((contact) => contact.id === value.id)
          ? prev.map((contact) => contact.id === value.id ? { ...contact, token } : contact)
          : [...prev, { ...value, token }]
      ))
    } else if (item.kind === 'action') {
      setAction({ ...(item.value as AgentActionPreset), token })
    } else if (item.kind === 'agent') {
      const agent = item.value as AgentDefinitionView
      setSelectedAgentChip({ id: agent.id, name: agent.name, token })
      onAgentSelect(agent.id)
    } else if (item.kind === 'skill') {
      const skill = item.value as AgentSkillOption
      const nextSkill = { id: skill.name, name: skill.name, description: skill.description, token }
      setSelectedSkills((prev) => (
        prev.some((current) => current.id === nextSkill.id)
          ? prev.map((current) => current.id === nextSkill.id ? nextSkill : current)
          : [...prev, nextSkill]
      ))
    } else if (item.kind === 'time') {
      setTimeRange({ ...(item.value as { label: string; start: number; end: number }), token })
    }
  }

  const insertShortcut = (value: string) => {
    const textarea = inputRef.current
    const caret = textarea?.selectionStart ?? message.length
    const prefix = message.slice(0, caret)
    const suffix = message.slice(caret)
    const spacer = prefix && !prefix.endsWith(' ') ? ' ' : ''
    const next = `${prefix}${spacer}${value}${suffix}`
    const nextCursor = `${prefix}${spacer}${value}`.length
    setMessage(next)
    setCursor(nextCursor)
    window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  const buildSelection = (): AgentCommandSelection => ({
    selectedSessions,
    selectedContacts,
    selectedSkills,
    timeRange,
    action,
    selectedAgent: selectedAgentChip,
    options
  })

  const parameterTokens = [
    ...selectedSessions.map((item) => item.token),
    ...selectedContacts.map((item) => item.token),
    ...selectedSkills.map((item) => item.token),
    action?.token,
    timeRange?.token,
    selectedAgentChip?.token
  ].filter(Boolean)

  const submit = () => {
    const finalMessage = [parameterTokens.join(' '), message.trim() || action?.prompt || ''].filter(Boolean).join(' ').trim()
    if (!finalMessage || isRunning) return
    onSubmit(finalMessage, buildSelection())
    setMessage('')
    setCursor(0)
    setAction(null)
    setTimeRange(null)
    setSelectedAgentChip(null)
    setSelectedSessions([])
    setSelectedContacts([])
    setSelectedSkills([])
  }

  return (
    <div className="agent-command-card">
      {suggestions.length > 0 && (
        <div className="agent-suggest-menu">
          <div className="agent-suggest-hint">上下键选择，Tab 补全</div>
          {suggestions.map((item, index) => (
            <button
              type="button"
              key={item.id}
              className={index === activeIndex ? 'active' : ''}
              onMouseDown={(event) => {
                event.preventDefault()
                applySuggestion(item)
              }}
            >
              <span>{item.iconLabel}</span>
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </button>
          ))}
        </div>
      )}

      <div className="agent-command-shortcuts">
        <button type="button" onClick={() => insertShortcut('#')}><Hash size={15} />会话/群聊</button>
        <button type="button" onClick={() => insertShortcut('@')}><UserRound size={15} />联系人</button>
        <button type="button" onClick={() => insertShortcut('/')}><ListFilter size={15} />操作</button>
        <button type="button" onClick={() => insertShortcut('$')}><BookOpen size={15} />技能</button>
        <button type="button" onClick={() => insertShortcut('!')}><UserRoundCog size={15} />Agent</button>
        <button type="button" onClick={() => insertShortcut('t:')}><CalendarDays size={15} />时间</button>
      </div>

      <div className="agent-command-row">
        <div className="agent-command-editor" onClick={() => inputRef.current?.focus()}>
          {(selectedSessions.length > 0 || selectedContacts.length > 0 || selectedSkills.length > 0 || action || timeRange || selectedAgentChip) && (
            <div className="agent-token-list">
              {selectedSessions.map((item) => (
                <TokenChip key={item.id} item={item} kind="session" onRemove={() => setSelectedSessions((prev) => prev.filter((session) => session.id !== item.id))} />
              ))}
              {selectedContacts.map((item) => (
                <TokenChip key={item.id} item={item} kind="contact" onRemove={() => setSelectedContacts((prev) => prev.filter((contact) => contact.id !== item.id))} />
              ))}
              {selectedSkills.map((item) => (
                <TokenChip key={item.id} item={item} kind="skill" onRemove={() => setSelectedSkills((prev) => prev.filter((skill) => skill.id !== item.id))} />
              ))}
              {action && (
                <TokenChip item={{ id: action.id, name: action.label, token: action.token }} kind="tool" onRemove={() => setAction(null)} />
              )}
              {timeRange && (
                <TokenChip item={{ id: timeRange.label, name: timeRange.label, token: timeRange.token }} kind="time" onRemove={() => setTimeRange(null)} />
              )}
              {selectedAgentChip && (
                <TokenChip item={selectedAgentChip} kind="agent" onRemove={() => setSelectedAgentChip(null)} />
              )}
            </div>
          )}
          <div className="agent-command-input-line">
            <textarea
              ref={inputRef}
              value={message}
              rows={2}
              onChange={(event) => {
                setMessage(event.target.value)
                setCursor(event.target.selectionStart)
                setActiveIndex(0)
              }}
              onClick={(event) => setCursor(event.currentTarget.selectionStart)}
              onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)}
              onKeyDown={(event) => {
                if (suggestions.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                  event.preventDefault()
                  setActiveIndex((prev) => {
                    const offset = event.key === 'ArrowDown' ? 1 : -1
                    return (prev + offset + suggestions.length) % suggestions.length
                  })
                  return
                }
                if (suggestions.length > 0 && (event.key === 'Tab' || event.key === 'Enter') && !event.ctrlKey && !event.metaKey) {
                  event.preventDefault()
                  applySuggestion(suggestions[activeIndex] || suggestions[0])
                  return
                }
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault()
                  submit()
                }
              }}
              placeholder="# 选择会话 / $ 加载技能 / 输入问题"
            />
            <button className="agent-send-button" type="button" onClick={isRunning ? onCancel : submit}>
              {isRunning ? <Square size={18} /> : <Send size={19} />}
            </button>
          </div>
        </div>
      </div>

      <div className="agent-command-status">
        <span className="agent-command-status-main">
          <span><Bot size={14} />{selectedAgent?.name || '未选择 Agent'}</span>
          {tokenUsage && tokenUsage.totalTokens > 0 && (
            <span className="agent-command-token-stats">
              输入 {formatTokenCount(tokenUsage.promptTokens)}
              <i />
              输出 {formatTokenCount(tokenUsage.completionTokens)}
              <i />
              总计 {formatTokenCount(tokenUsage.totalTokens)}
            </span>
          )}
        </span>
        <span>Ctrl + Enter 发送</span>
      </div>
    </div>
  )
}

function TokenChip({
  item,
  kind,
  onRemove
}: {
  item: { id: string; name: string; token?: string; avatarUrl?: string }
  kind: 'session' | 'contact' | 'tool' | 'time' | 'agent' | 'skill'
  onRemove: () => void
}) {
  const initials = item.name.trim().slice(0, 1).toUpperCase()
  const marker = item.token?.startsWith('t:') ? 't:' : item.token?.slice(0, 1)
  return (
    <span className={`agent-token-chip ${kind}`}>
      {kind === 'session' || kind === 'contact' ? (
        item.avatarUrl ? <img src={item.avatarUrl} alt="" /> : <span className="agent-token-avatar">{initials || '#'}</span>
      ) : kind === 'tool' ? (
        <Wrench size={14} />
      ) : kind === 'skill' ? (
        <BookOpen size={14} />
      ) : kind === 'time' ? (
        <CalendarDays size={14} />
      ) : (
        <Bot size={14} />
      )}
      {marker && <span className="agent-token-marker">{marker}</span>}
      <span className="agent-token-name">{item.name}</span>
      <button type="button" onClick={(event) => { event.stopPropagation(); onRemove() }} title="移除参数">
        <X size={12} />
      </button>
    </span>
  )
}
