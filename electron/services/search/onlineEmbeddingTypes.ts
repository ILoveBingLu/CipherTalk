export type EmbeddingMode = 'local' | 'online'
export type OnlineEmbeddingProviderId = 'aliyun' | 'siliconflow' | 'volcengine'
export type EmbeddingInputType = 'query' | 'document'

export interface OnlineEmbeddingModelInfo {
  id: string
  displayName: string
  supportedDims: number[]
  defaultDim: number
  maxBatchSize: number
  maxTokens: number
  supportsDimensions: boolean
  allowCustomDim?: boolean
}

export interface OnlineEmbeddingProviderInfo {
  id: OnlineEmbeddingProviderId
  displayName: string
  description: string
  defaultBaseURL: string
  website?: string
  models: OnlineEmbeddingModelInfo[]
  allowCustomModel?: boolean
}

export interface OnlineEmbeddingConfig {
  id: string
  name: string
  providerId: OnlineEmbeddingProviderId
  baseURL: string
  apiKey: string
  model: string
  dim: number
  createdAt: number
  updatedAt: number
}

export type OnlineEmbeddingConfigInput = Partial<OnlineEmbeddingConfig> & {
  providerId: string
  baseURL: string
  apiKey: string
  model: string
  dim: number
}

export interface OnlineEmbeddingTestResult {
  success: boolean
  vectorModelId?: string
  dim?: number
  model?: string
  usageTokens?: number
  error?: string
}
