import type { AgentToolView } from '../../stores/agentStore'

interface Props {
  tools: AgentToolView[]
  selectedToolIds: string[]
  disabled?: boolean
  onChange: (toolIds: string[]) => void
}

export default function ToolListPanel({ tools, selectedToolIds, disabled = false, onChange }: Props) {
  const grouped = tools.reduce<Record<string, AgentToolView[]>>((acc, tool) => {
    const key = `${tool.source}:${tool.sourceLabel}`
    acc[key] = acc[key] || []
    acc[key].push(tool)
    return acc
  }, {})

  const toggle = (id: string) => {
    if (disabled) return
    onChange(selectedToolIds.includes(id)
      ? selectedToolIds.filter((item) => item !== id)
      : [...selectedToolIds, id])
  }

  return (
    <div className="agent-tool-list">
      {Object.entries(grouped).map(([group, items]) => (
        <section key={group}>
          <h4>{group}</h4>
          {items.map((tool) => (
            <label key={tool.id} className={!tool.available ? 'unavailable' : ''}>
              <input
                type="checkbox"
                disabled={disabled}
                checked={selectedToolIds.includes(tool.id)}
                onChange={() => toggle(tool.id)}
              />
              <span>
                <strong>{tool.name}</strong>
                <small>{tool.description}</small>
              </span>
            </label>
          ))}
        </section>
      ))}
    </div>
  )
}
