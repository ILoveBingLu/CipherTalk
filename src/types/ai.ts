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

export interface SummaryEvidenceRef {
  sessionId: string
  localId: number
  createTime: number
  sortSeq: number
  senderUsername?: string
  senderDisplayName?: string
  previewText: string
}

export interface SummaryTopicFact {
  name: string
  importance: number
}

export interface SummaryDecisionFact {
  text: string
  confidence: number
  evidenceRefs: SummaryEvidenceRef[]
}

export interface SummaryTodoFact {
  owner?: string
  task: string
  deadline?: string
  status: 'open' | 'done' | 'unknown'
  confidence: number
  evidenceRefs: SummaryEvidenceRef[]
}

export interface SummaryRiskFact {
  text: string
  severity: 'low' | 'medium' | 'high'
  confidence: number
  evidenceRefs: SummaryEvidenceRef[]
}

export interface SummaryEventFact {
  text: string
  date?: string
  confidence: number
  evidenceRefs: SummaryEvidenceRef[]
}

export interface SummaryOpenQuestionFact {
  text: string
}

export interface SummaryStructuredAnalysis {
  overview: string
  topics: SummaryTopicFact[]
  decisions: SummaryDecisionFact[]
  todos: SummaryTodoFact[]
  risks: SummaryRiskFact[]
  events: SummaryEventFact[]
  openQuestions: SummaryOpenQuestionFact[]
}

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
  structuredAnalysis?: SummaryStructuredAnalysis
}

export interface SessionQAHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export type SessionQAConversationTitleStatus = 'pending' | 'generated' | 'fallback' | 'manual'

export interface SessionQAMessageRecord {
  id: number
  conversationId: number
  role: 'user' | 'assistant'
  content: string
  thinkContent?: string
  error?: string
  result?: SessionQAResult
  evidenceRefs?: SummaryEvidenceRef[]
  toolCalls?: SessionQAToolCall[]
  progressEvents?: SessionQAProgressEvent[]
  tokensUsed?: number
  cost?: number
  provider?: string
  model?: string
  requestId?: string
  createdAt: number
}

export interface SessionQAConversationSummary {
  id: number
  sessionId: string
  sessionName?: string
  title: string
  titleStatus: SessionQAConversationTitleStatus
  linkedSummaryId?: number
  provider?: string
  model?: string
  createdAt: number
  updatedAt: number
  lastMessageAt: number
  messageCount: number
  lastMessagePreview?: string
}

export interface SessionQAConversationDetail extends SessionQAConversationSummary {
  messages: SessionQAMessageRecord[]
}

export type SessionQARequestId = string

export interface SessionQAToolCall {
  toolName:
    | 'read_summary_facts'
    | 'read_latest'
    | 'read_by_time_range'
    | 'resolve_participant'
    | 'search_messages'
    | 'read_context'
    | 'aggregate_messages'
    | 'get_session_statistics'
    | 'get_keyword_statistics'
    | 'answer'
    | 'get_session_context'
    | 'prepare_vector_index'
  args: Record<string, unknown>
  summary: string
  status?: 'running' | 'completed' | 'failed' | 'cancelled'
  durationMs?: number
  evidenceCount?: number
}

export type SessionQAProgressStage = 'intent' | 'tool' | 'context' | 'answer' | 'thought'
export type SessionQAProgressStatus = 'running' | 'completed' | 'failed'
export type SessionQAProgressSource = 'summary' | 'chat' | 'search_index' | 'vector' | 'aggregate' | 'model'

export interface SessionQAProgressEvent {
  id: string
  stage: SessionQAProgressStage
  status: SessionQAProgressStatus
  title: string
  detail?: string
  toolName?: SessionQAToolCall['toolName']
  query?: string
  count?: number
  createdAt: number
  requestId?: SessionQARequestId
  source?: SessionQAProgressSource
  elapsedMs?: number
  diagnostics?: string[]
}

export type SessionQAJobEventKind = 'progress' | 'chunk' | 'final' | 'error' | 'cancelled'

export interface SessionQAJobEvent {
  requestId: SessionQARequestId
  seq: number
  kind: SessionQAJobEventKind
  createdAt: number
  progress?: SessionQAProgressEvent
  chunk?: string
  result?: SessionQAResult
  error?: string
}

export interface SessionQAStartResult {
  success: boolean
  requestId?: SessionQARequestId
  conversationId?: number
  error?: string
}

export interface SessionQACancelResult {
  success: boolean
  requestId?: SessionQARequestId
  error?: string
}

export interface SessionVectorIndexState {
  sessionId: string
  indexedCount: number
  vectorizedCount: number
  pendingCount: number
  isVectorComplete: boolean
  isVectorRunning: boolean
  vectorModel: string
  vectorModelName?: string
  vectorDim: number
  vectorIndexVersion: string
  vectorStoreName: string
  vectorModelDtype?: string
  vectorModelSizeLabel?: string
  vectorProviderAvailable?: boolean
  vectorProviderError?: string
}

export type SessionVectorIndexProgressStage =
  | 'preparing'
  | 'downloading_model'
  | 'indexing_messages'
  | 'vectorizing_messages'
  | 'completed'

export type SessionVectorIndexProgressStatus =
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface SessionVectorIndexProgressEvent {
  sessionId: string
  stage: SessionVectorIndexProgressStage
  status: SessionVectorIndexProgressStatus
  processedCount: number
  totalCount: number
  message: string
  vectorModel: string
  vectorModelName?: string
  vectorDim?: number
  vectorIndexVersion?: string
  vectorStoreName?: string
  vectorModelDtype?: string
  vectorModelSizeLabel?: string
}

export type SessionMemoryBuildProgressStage =
  | 'preparing'
  | 'indexing_messages'
  | 'building_messages'
  | 'building_blocks'
  | 'building_facts'
  | 'completed'

export type SessionMemoryBuildProgressStatus =
  | 'running'
  | 'completed'
  | 'failed'

export interface SessionMemoryBuildState {
  sessionId: string
  messageCount: number
  blockCount: number
  factCount: number
  totalCount: number
  processedCount: number
  isRunning: boolean
  updatedAt: number
  completedAt?: number
  lastError?: string
}

export interface SessionMemoryBuildProgressEvent {
  sessionId: string
  stage: SessionMemoryBuildProgressStage
  status: SessionMemoryBuildProgressStatus
  processedCount: number
  totalCount: number
  message: string
  messageCount: number
  blockCount: number
  factCount: number
}

export interface SessionProfileMemoryState {
  sessionId: string
  profileCount: number
  memoryId?: number
  memoryUid?: string
  updatedAt?: number
  isRunning: boolean
  lastError?: string
}

export interface SessionProfileMemoryBuildResult extends SessionProfileMemoryState {
  content: string
  provider: string
  model: string
  tokensUsed: number
  cost: number
}

export interface EmbeddingModelProfile {
  id: string
  displayName: string
  description: string
  modelId: string
  remoteHosts: string[]
  remotePathTemplate: string
  revision: string
  dim: number
  baseDim: number
  supportedDims: number[]
  maxTokens: number
  maxTextChars: number
  dtype: string
  pooling?: 'mean' | 'last_token'
  queryInstruction?: string
  sizeLabel: string
  performanceTier: 'fast' | 'balanced' | 'quality' | 'heavy' | string
  performanceLabel: string
  enabled: boolean
}

export interface EmbeddingModelStatus {
  profileId: string
  displayName: string
  modelId: string
  dim: number
  baseDim: number
  supportedDims: number[]
  vectorModelId: string
  performanceTier: string
  performanceLabel: string
  dtype: string
  sizeLabel: string
  enabled: boolean
  exists: boolean
  modelDir: string
  sizeBytes: number
}

export type EmbeddingDevice = 'cpu' | 'dml'

export interface EmbeddingDeviceStatus {
  currentDevice: EmbeddingDevice
  effectiveDevice: EmbeddingDevice
  gpuAvailable: boolean
  provider: 'CPU' | 'DirectML'
  info: string
}

export interface EmbeddingModelDownloadProgress {
  profileId: string
  displayName: string
  remoteHost?: string
  file?: string
  loaded?: number
  total?: number
  percent?: number
  status?: string
}

export interface SessionQAResult {
  sessionId: string
  question: string
  answerText: string
  evidenceRefs: SummaryEvidenceRef[]
  toolCalls: SessionQAToolCall[]
  tokensUsed: number
  cost: number
  provider: string
  model: string
  createdAt: number
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
