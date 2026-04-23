import { useState, useEffect } from 'react'
import { Calendar, Loader2, Sparkles } from 'lucide-react'
import './AnnualReportPage.scss'

type YearOption = number | 'all'

function AnnualReportPage() {
  const [availableYears, setAvailableYears] = useState<number[]>([])
  const [selectedYear, setSelectedYear] = useState<YearOption | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isGenerating, setIsGenerating] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    loadAvailableYears()
  }, [])

  const loadAvailableYears = async () => {
    setIsLoading(true)
    setLoadError(null)
    try {
      const result = await window.electronAPI.annualReport.getAvailableYears()
      if (result.success && result.data && result.data.length > 0) {
        setAvailableYears(result.data)
        setSelectedYear(result.data[0])
      } else if (!result.success) {
        setLoadError(result.error || '读取年度报告数据失败')
      }
    } catch (e) {
      console.error(e)
      setLoadError(String(e))
    } finally {
      setIsLoading(false)
    }
  }

  const handleGenerateReport = async () => {
    if (!selectedYear) return
    setIsGenerating(true)
    try {
      const yearParam = selectedYear === 'all' ? 0 : selectedYear
      await window.electronAPI.window.openAnnualReportWindow(yearParam)
    } catch (e) {
      console.error('生成报告失败:', e)
    } finally {
      setIsGenerating(false)
    }
  }

  if (isLoading) {
    return (
      <div className="annual-report-page">
        <Loader2 size={32} className="spin" style={{ color: 'var(--text-tertiary)' }} />
        <p style={{ color: 'var(--text-tertiary)', marginTop: 16 }}>正在加载年份数据...</p>
      </div>
    )
  }

  if (availableYears.length === 0) {
    return (
      <div className="annual-report-page">
        <Calendar size={64} style={{ color: 'var(--text-tertiary)', opacity: 0.5 }} />
        <h2 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-primary)', margin: '16px 0 8px' }}>暂无聊天记录</h2>
        <p style={{ color: 'var(--text-tertiary)', margin: 0 }}>
          {loadError || '当前账号未检测到可用于年度报告的聊天数据，请确认已完成解密并存在私聊消息记录'}
        </p>
      </div>
    )
  }

  const yearOptions: YearOption[] = availableYears.length > 0
    ? ['all', ...availableYears]
    : []

  const getYearLabel = (value: YearOption | null) => {
    if (!value) return ''
    return value === 'all' ? '全部时间' : `${value}`
  }

  return (
    <div className="annual-report-page">
      <Sparkles size={32} className="header-icon" />
      <h1 className="page-title">年度报告</h1>
      <p className="page-desc">选择年份，生成你的微信聊天年度回顾</p>

      <div className="year-grid">
        {yearOptions.map(year => (
          <div
            key={year}
            className={`year-card ${selectedYear === year ? 'selected' : ''}`}
            onClick={() => setSelectedYear(year)}
          >
            <span className="year-number">{year === 'all' ? '全部' : year}</span>
            <span className="year-label">{year === 'all' ? '时间' : '年'}</span>
          </div>
        ))}
      </div>

      <button
        className="generate-btn"
        onClick={handleGenerateReport}
        disabled={!selectedYear || isGenerating}
      >
        {isGenerating ? (
          <>
            <Loader2 size={20} className="spin" />
            <span>正在生成...</span>
          </>
        ) : (
          <>
            <Sparkles size={20} />
            <span>生成 {getYearLabel(selectedYear)} 年度报告</span>
          </>
        )}
      </button>
    </div>
  )
}

export default AnnualReportPage
