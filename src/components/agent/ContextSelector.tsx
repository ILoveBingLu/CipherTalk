import { useMemo, useState } from 'react'
import type { ChatSession, ContactInfo } from '../../types/models'

interface Props {
  type: 'session' | 'contact'
  sessions?: ChatSession[]
  contacts?: ContactInfo[]
  onSelect: (item: { id: string; name: string }) => void
}

export default function ContextSelector({ type, sessions = [], contacts = [], onSelect }: Props) {
  const [query, setQuery] = useState('')
  const items = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (type === 'session') {
      return sessions
        .map((session) => ({ id: session.username, name: session.displayName || session.username }))
        .filter((item) => !normalized || item.name.toLowerCase().includes(normalized))
        .slice(0, 8)
    }
    return contacts
      .map((contact) => ({ id: contact.username, name: contact.displayName || contact.username }))
      .filter((item) => !normalized || item.name.toLowerCase().includes(normalized))
      .slice(0, 8)
  }, [contacts, query, sessions, type])

  return (
    <div className="agent-trigger-menu">
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={type === 'session' ? '搜索会话' : '搜索联系人'}
        autoFocus
      />
      {items.map((item) => (
        <button key={item.id} onClick={() => onSelect(item)}>
          {item.name}
        </button>
      ))}
    </div>
  )
}
