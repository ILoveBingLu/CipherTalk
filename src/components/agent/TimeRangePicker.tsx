const QUICK_RANGES = [
  { label: '今天', days: 0 },
  { label: '昨天', days: 1 },
  { label: '最近7天', days: 7 },
  { label: '本周', days: 7 },
  { label: '本月', days: 30 }
]

interface Props {
  onSelect: (range: { label: string; start: number; end: number }) => void
}

export default function TimeRangePicker({ onSelect }: Props) {
  const selectRange = (label: string, days: number) => {
    const end = Math.floor(Date.now() / 1000)
    const start = days === 0
      ? Math.floor(new Date().setHours(0, 0, 0, 0) / 1000)
      : end - days * 24 * 60 * 60
    onSelect({ label, start, end })
  }

  return (
    <div className="agent-trigger-menu">
      {QUICK_RANGES.map((item) => (
        <button key={item.label} onClick={() => selectRange(item.label, item.days)}>
          {item.label}
        </button>
      ))}
    </div>
  )
}
