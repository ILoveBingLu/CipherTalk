import { Bot } from 'lucide-react'
import type { AgentDefinitionView } from '../../stores/agentStore'

interface Props {
  agents: AgentDefinitionView[]
  selectedAgentId: string | null
  onSelect: (id: string) => void
}

export default function AgentSelector({ agents, selectedAgentId, onSelect }: Props) {
  return (
    <div className="agent-selector">
      {agents.map((agent) => (
        <button
          key={agent.id}
          className={`agent-selector-item ${agent.id === selectedAgentId ? 'active' : ''}`}
          onClick={() => onSelect(agent.id)}
        >
          <Bot size={16} />
          <span>
            <strong>{agent.name}</strong>
            <small>{agent.description || (agent.isBuiltin ? '内置 Agent' : '自定义 Agent')}</small>
          </span>
        </button>
      ))}
    </div>
  )
}
