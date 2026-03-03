/**
 * AI 提供商信息
 */
export interface AIProviderInfo {
  id: string
  name: string
  displayName: string
  description: string
  models: string[]
  pricing: string
  pricingDetail: {
    input: number
    output: number
  }
  website?: string
  logo?: string  // logo 文件路径
}

/**
 * 获取所有 AI 提供商（从后端获取）
 */
export async function getAIProviders(): Promise<AIProviderInfo[]> {
  try {
    const providers = await window.electronAPI.ai.getProviders()
    return providers
  } catch (e) {
    console.error('获取 AI 提供商列表失败:', e)
    return []
  }
}

/**
 * 时间范围选项
 */
export interface TimeRangeOption {
  days: number
  label: string
}

export const TIME_RANGE_OPTIONS: TimeRangeOption[] = [
  { days: 1, label: '最近 1 天' },
  { days: 3, label: '最近 3 天' },
  { days: 7, label: '最近 7 天' },
  { days: 30, label: '最近 30 天' },
  { days: 60, label: '最近 60 天' },
  { days: 90, label: '最近 90 天' },
  { days: 180, label: '最近 180 天' },
  { days: 365, label: '最近 1 年' },
  { days: 0, label: '全部消息' }
]

/**
 * 摘要详细程度
 */
export type SummaryDetail = 'simple' | 'normal' | 'detailed'

export const SUMMARY_DETAIL_OPTIONS = [
  { value: 'simple' as SummaryDetail, label: '简洁' },
  { value: 'normal' as SummaryDetail, label: '标准' },
  { value: 'detailed' as SummaryDetail, label: '详细' }
]

/**
 * 摘要结果
 */
export interface SummaryResult {
  id?: number
  sessionId: string
  timeRangeStart: number
  timeRangeEnd: number
  timeRangeDays: number
  messageCount: number
  summaryText: string
  tokensUsed: number
  cost: number
  provider: string
  model: string
  createdAt: number
  customName?: string
}

/**
 * 使用统计
 */
export interface UsageStats {
  date: string
  provider: string
  model: string
  total_tokens: number
  total_cost: number
  request_count: number
}
