import OpenAI from 'openai'
import { createHash } from 'crypto'
import { ConfigService } from '../config'
import { proxyService } from '../ai/proxyService'
import type {
  EmbeddingInputType,
  EmbeddingMode,
  OnlineEmbeddingConfig,
  OnlineEmbeddingConfigInput,
  OnlineEmbeddingModelInfo,
  OnlineEmbeddingProviderInfo,
  OnlineEmbeddingTestResult
} from './onlineEmbeddingTypes'
import {
  getOnlineEmbeddingModel,
  getOnlineEmbeddingProvider,
  listOnlineEmbeddingProviders,
  ONLINE_EMBEDDING_COMMON_DIMS
} from './onlineEmbeddingRegistry'

function normalizeVector(vector: Float32Array): Float32Array {
  let norm = 0
  for (let index = 0; index < vector.length; index += 1) norm += vector[index] * vector[index]
  norm = Math.sqrt(norm) || 1
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm
  return vector
}

function sanitizeVectorModelPart(value: string): string {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._/@:-]+/g, '_')
    .slice(0, 120)
}

function hashShort(value: string): string {
  return createHash('sha1').update(value || '').digest('hex').slice(0, 8)
}

function nowId(): string {
  return `emb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getErrorStatus(error: unknown): number {
  if (typeof error === 'object' && error) {
    const record = error as Record<string, unknown>
    return Number(record.status || record.statusCode || record.code || 0)
  }
  return 0
}

function normalizeErrorMessage(error: unknown): string {
  const status = getErrorStatus(error)
  const message = error instanceof Error ? error.message : String(error || '在线向量请求失败')
  return status ? `${status}: ${message}` : message
}

function limitEmbeddingText(text: string, maxChars: number): string {
  const value = String(text || '')
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 4000
  if (value.length <= limit) return value
  const head = Math.max(1, Math.floor(limit * 0.75))
  return `${value.slice(0, head)}\n${value.slice(-(limit - head))}`
}

export class OnlineEmbeddingService {
  listProviders(): OnlineEmbeddingProviderInfo[] {
    return listOnlineEmbeddingProviders()
  }

  getProvider(providerId?: string): OnlineEmbeddingProviderInfo {
    return getOnlineEmbeddingProvider(providerId)
  }

  getModelInfo(providerId: string, modelId: string): OnlineEmbeddingModelInfo | null {
    return getOnlineEmbeddingModel(providerId, modelId)
  }

  getEmbeddingMode(): EmbeddingMode {
    const config = new ConfigService()
    try {
      return config.get('aiEmbeddingMode' as any) === 'online' ? 'online' : 'local'
    } finally {
      config.close()
    }
  }

  setEmbeddingMode(mode: string): EmbeddingMode {
    const nextMode: EmbeddingMode = mode === 'online' ? 'online' : 'local'
    const config = new ConfigService()
    try {
      config.set('aiEmbeddingMode' as any, nextMode as any)
      return nextMode
    } finally {
      config.close()
    }
  }

  listConfigs(): OnlineEmbeddingConfig[] {
    const config = new ConfigService()
    try {
      const value = config.get('aiOnlineEmbeddingConfigs' as any) as OnlineEmbeddingConfig[] | undefined
      return Array.isArray(value) ? value.map((item) => this.normalizeStoredConfig(item)).filter(Boolean) as OnlineEmbeddingConfig[] : []
    } finally {
      config.close()
    }
  }

  getCurrentConfigId(): string {
    const config = new ConfigService()
    try {
      return String(config.get('aiCurrentOnlineEmbeddingConfigId' as any) || '')
    } finally {
      config.close()
    }
  }

  getCurrentConfig(): OnlineEmbeddingConfig | null {
    const configs = this.listConfigs()
    const currentId = this.getCurrentConfigId()
    return configs.find((config) => config.id === currentId) || configs[0] || null
  }

  setCurrentConfig(configId: string): OnlineEmbeddingConfig | null {
    const configs = this.listConfigs()
    const selected = configs.find((config) => config.id === configId) || null
    if (!selected) return null

    const config = new ConfigService()
    try {
      config.set('aiCurrentOnlineEmbeddingConfigId' as any, selected.id as any)
      return selected
    } finally {
      config.close()
    }
  }

  async saveConfig(input: OnlineEmbeddingConfigInput): Promise<OnlineEmbeddingConfig> {
    const normalized = this.normalizeInputConfig(input)
    const test = await this.testConfig(normalized)
    if (!test.success) {
      throw new Error(test.error || '在线向量配置测试失败')
    }

    const configs = this.listConfigs()
    const now = Date.now()
    const existing = normalized.id ? configs.find((item) => item.id === normalized.id) : null
    const next: OnlineEmbeddingConfig = {
      ...normalized,
      id: existing?.id || normalized.id || nowId(),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    }
    const merged = existing
      ? configs.map((item) => item.id === next.id ? next : item)
      : [...configs, next]

    const config = new ConfigService()
    try {
      config.set('aiOnlineEmbeddingConfigs' as any, merged as any)
      config.set('aiCurrentOnlineEmbeddingConfigId' as any, next.id as any)
      return next
    } finally {
      config.close()
    }
  }

  deleteConfig(configId: string): { deleted: boolean; currentConfigId: string; configs: OnlineEmbeddingConfig[] } {
    const configs = this.listConfigs()
    const nextConfigs = configs.filter((config) => config.id !== configId)
    const currentId = this.getCurrentConfigId()
    const nextCurrentId = currentId === configId ? (nextConfigs[0]?.id || '') : currentId

    const config = new ConfigService()
    try {
      config.set('aiOnlineEmbeddingConfigs' as any, nextConfigs as any)
      config.set('aiCurrentOnlineEmbeddingConfigId' as any, nextCurrentId as any)
      return {
        deleted: nextConfigs.length !== configs.length,
        currentConfigId: nextCurrentId,
        configs: nextConfigs
      }
    } finally {
      config.close()
    }
  }

  async testConfig(input: OnlineEmbeddingConfigInput): Promise<OnlineEmbeddingTestResult> {
    try {
      const normalized = this.normalizeInputConfig(input)
      const vectors = await this.embedTextsWithConfig(normalized, ['在线向量测试'], { inputType: 'document' })
      const dim = vectors[0]?.length || 0
      return {
        success: dim === normalized.dim,
        vectorModelId: this.getVectorModelId(normalized),
        dim,
        model: normalized.model,
        error: dim === normalized.dim ? undefined : `返回向量维度 ${dim} 与配置维度 ${normalized.dim} 不一致`
      }
    } catch (error) {
      return {
        success: false,
        error: normalizeErrorMessage(error)
      }
    }
  }

  getVectorModelId(config = this.getCurrentConfig()): string {
    if (!config) return 'online:unconfigured@0d'
    const modelPart = sanitizeVectorModelPart(config.model)
    const basePart = config.providerId === 'volcengine' ? `:${hashShort(config.baseURL)}` : ''
    return `online:${config.providerId}:${modelPart}${basePart}@${config.dim}d`
  }

  getCurrentVectorDim(): number {
    return this.getCurrentConfig()?.dim || 0
  }

  getCurrentBatchSize(): number {
    const config = this.getCurrentConfig()
    if (!config) return 1
    return Math.max(1, Math.min(10, this.getModelInfo(config.providerId, config.model)?.maxBatchSize || 10))
  }

  getCurrentProfile() {
    const config = this.getCurrentConfig()
    const provider = this.getProvider(config?.providerId)
    const model = config ? this.getModelInfo(config.providerId, config.model) : null
    return {
      id: this.getVectorModelId(config),
      displayName: config ? `${provider.displayName} · ${config.model}` : '在线向量未配置',
      dim: config?.dim || 0,
      dtype: 'online',
      sizeLabel: config ? '在线服务' : '未配置',
      performanceTier: 'quality',
      performanceLabel: model?.displayName || provider.displayName,
      enabled: Boolean(config?.apiKey && config.model && config.dim > 0),
      mode: 'online' as const,
      providerName: provider.displayName
    }
  }

  ensureReady(): void {
    const config = this.getCurrentConfig()
    if (!config) {
      throw new Error('未配置在线语义向量服务')
    }
    this.validateConfigShape(config)
  }

  async embedTexts(
    texts: string[],
    options: { inputType?: EmbeddingInputType } = {}
  ): Promise<Float32Array[]> {
    const config = this.getCurrentConfig()
    if (!config) throw new Error('未配置在线语义向量服务')
    return this.embedTextsWithConfig(config, texts, options)
  }

  async embedText(
    text: string,
    options: { inputType?: EmbeddingInputType } = {}
  ): Promise<Float32Array> {
    const [vector] = await this.embedTexts([text], { inputType: options.inputType || 'query' })
    return vector
  }

  buildDefaultConfig(providerId?: string): OnlineEmbeddingConfigInput {
    const provider = this.getProvider(providerId)
    const model = provider.models[0]
    return {
      name: `${provider.displayName} ${model.id}`,
      providerId: provider.id,
      baseURL: provider.defaultBaseURL,
      apiKey: '',
      model: model.id,
      dim: model.defaultDim
    }
  }

  private normalizeStoredConfig(raw: Partial<OnlineEmbeddingConfig> | null | undefined): OnlineEmbeddingConfig | null {
    if (!raw) return null
    try {
      const normalized = this.normalizeInputConfig(raw as OnlineEmbeddingConfigInput)
      return {
        ...normalized,
        id: String(raw.id || nowId()),
        createdAt: Number(raw.createdAt || Date.now()),
        updatedAt: Number(raw.updatedAt || raw.createdAt || Date.now())
      }
    } catch {
      return null
    }
  }

  private normalizeInputConfig(input: OnlineEmbeddingConfigInput): OnlineEmbeddingConfig {
    const provider = this.getProvider(input.providerId)
    const modelId = String(input.model || '').trim()
    const model = this.getModelInfo(provider.id, modelId)
    const dim = Math.floor(Number(input.dim) || 0)
    const baseURL = String(input.baseURL || provider.defaultBaseURL || '').trim().replace(/\/+$/, '')
    const now = Date.now()
    const normalized: OnlineEmbeddingConfig = {
      id: String(input.id || ''),
      name: String(input.name || `${provider.displayName} ${modelId}`).trim(),
      providerId: provider.id,
      baseURL,
      apiKey: String(input.apiKey || '').trim(),
      model: modelId,
      dim,
      createdAt: Number(input.createdAt || now),
      updatedAt: Number(input.updatedAt || now)
    }
    this.validateConfigShape(normalized, model)
    return normalized
  }

  private validateConfigShape(config: OnlineEmbeddingConfig, model = this.getModelInfo(config.providerId, config.model)): void {
    if (!config.baseURL) throw new Error('在线向量服务地址不能为空')
    if (!config.apiKey) throw new Error('在线向量 API Key 不能为空')
    if (!config.model) throw new Error('在线向量模型不能为空')
    if (!Number.isInteger(config.dim) || config.dim <= 0) throw new Error('在线向量维度无效')

    const provider = this.getProvider(config.providerId)
    if (!model && !provider.allowCustomModel) {
      throw new Error(`模型 ${config.model} 未在 ${provider.displayName} 白名单中`)
    }
    if (model && !model.allowCustomDim && !model.supportedDims.includes(config.dim)) {
      throw new Error(`模型 ${config.model} 不支持 ${config.dim} 维`)
    }
    if (!model && !ONLINE_EMBEDDING_COMMON_DIMS.includes(config.dim)) {
      throw new Error(`自定义模型维度必须为 ${ONLINE_EMBEDDING_COMMON_DIMS.join(' / ')} 之一`)
    }
  }

  private async embedTextsWithConfig(
    config: OnlineEmbeddingConfig,
    texts: string[],
    options: { inputType?: EmbeddingInputType } = {}
  ): Promise<Float32Array[]> {
    this.validateConfigShape(config)
    if (texts.length === 0) return []

    const model = this.getModelInfo(config.providerId, config.model)
    const batchSize = Math.max(1, Math.min(model?.maxBatchSize || 10, texts.length))
    const maxChars = model?.maxTokens ? Math.max(1000, model.maxTokens * 2) : 8000
    const vectors: Float32Array[] = []

    for (let index = 0; index < texts.length; index += batchSize) {
      const batch = texts.slice(index, index + batchSize)
      const cleaned = batch.map((text) => limitEmbeddingText(String(text || ''), maxChars))
      const batchVectors = await this.requestEmbeddings(config, cleaned)
      vectors.push(...batchVectors)
    }

    return vectors
  }

  private async requestEmbeddings(config: OnlineEmbeddingConfig, texts: string[]): Promise<Float32Array[]> {
    const model = this.getModelInfo(config.providerId, config.model)
    const body: Record<string, unknown> = {
      model: config.model,
      input: texts,
      encoding_format: 'float'
    }
    if (model?.supportsDimensions) {
      body.dimensions = config.dim
    }

    const run = async () => {
      const proxyAgent = await proxyService.createProxyAgent(config.baseURL)
      const client = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        timeout: 60000,
        httpAgent: proxyAgent
      } as any)
      return client.embeddings.create(body as any)
    }

    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await run()
        const data = Array.isArray(response.data) ? [...response.data] : []
        const sorted = data.sort((a: any, b: any) => Number(a.index || 0) - Number(b.index || 0))
        if (sorted.length !== texts.length) {
          throw new Error(`在线向量返回数量不匹配：${sorted.length}/${texts.length}`)
        }
        return sorted.map((item: any, index) => {
          const vector = Array.isArray(item.embedding) ? Float32Array.from(item.embedding.map(Number)) : new Float32Array()
          if (vector.length !== config.dim) {
            throw new Error(`第 ${index + 1} 条返回向量维度 ${vector.length} 与配置维度 ${config.dim} 不一致`)
          }
          return normalizeVector(vector)
        })
      } catch (error) {
        lastError = error
        const status = getErrorStatus(error)
        if (status === 401 || status === 403 || (status >= 400 && status < 500 && status !== 429)) {
          break
        }
        if (attempt < 2) {
          await sleep(500 * Math.pow(2, attempt))
          continue
        }
      }
    }

    throw new Error(normalizeErrorMessage(lastError))
  }
}

export const onlineEmbeddingService = new OnlineEmbeddingService()
