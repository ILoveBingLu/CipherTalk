import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { cpus } from 'os'
import { dirname, join } from 'path'
import { ConfigService } from '../config'

export type EmbeddingModelProfileId =
  | 'qwen3-embedding-0.6b-onnx-q8'
  | 'bge-large-zh-v1.5-int8'
  | 'bge-large-zh-v1.5-fp32'
  | 'bge-m3'

export type EmbeddingDevice = 'cpu' | 'dml'

export type EmbeddingDeviceStatus = {
  currentDevice: EmbeddingDevice
  effectiveDevice: EmbeddingDevice
  gpuAvailable: boolean
  provider: 'CPU' | 'DirectML'
  info: string
}

export type EmbeddingModelStatus = {
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

export type EmbeddingDownloadProgress = {
  profileId: string
  displayName: string
  remoteHost?: string
  file?: string
  loaded?: number
  total?: number
  percent?: number
  status?: string
}

export type EmbeddingModelProfile = {
  id: EmbeddingModelProfileId
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
  dtype: 'q8' | 'fp32'
  pooling: 'mean' | 'last_token'
  queryInstruction?: string
  sizeLabel: string
  performanceTier: 'fast' | 'balanced' | 'quality' | 'heavy'
  performanceLabel: string
  enabled: boolean
}

const MODELSCOPE_HOST = 'https://www.modelscope.cn/'
const MODELSCOPE_PATH_TEMPLATE = 'models/{model}/resolve/master/'
const MODELSCOPE_REVISION = 'main'
const CPU_EMBEDDING_THREADS = Math.max(1, Math.min(2, Math.floor((cpus().length || 2) / 2)))

export const DEFAULT_EMBEDDING_MODEL_PROFILE: EmbeddingModelProfileId = 'bge-large-zh-v1.5-int8'

const EMBEDDING_MODEL_PROFILES: EmbeddingModelProfile[] = [
  {
    id: 'qwen3-embedding-0.6b-onnx-q8',
    displayName: 'Qwen3 Embedding 0.6B · 新一代',
    description: '1024/768/512/256 维多语言语义向量，支持 query instruction，作为新记忆检索体系主模型路线。',
    modelId: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    remoteHosts: [MODELSCOPE_HOST],
    remotePathTemplate: MODELSCOPE_PATH_TEMPLATE,
    revision: MODELSCOPE_REVISION,
    dim: 1024,
    baseDim: 1024,
    supportedDims: [1024, 768, 512, 256],
    maxTokens: 8192,
    maxTextChars: 2400,
    dtype: 'q8',
    pooling: 'last_token',
    queryInstruction: 'Given a chat history search query, retrieve relevant conversation messages that answer the query',
    sizeLabel: '约 614 MB',
    performanceTier: 'quality',
    performanceLabel: '高召回',
    enabled: true
  },
  {
    id: 'bge-large-zh-v1.5-int8',
    displayName: 'BGE Large 中文 · 推荐',
    description: '默认档位，1024 维中文语义向量，优先兼顾召回质量和本地 CPU 性能。',
    modelId: 'Xenova/bge-large-zh-v1.5',
    remoteHosts: [MODELSCOPE_HOST],
    remotePathTemplate: MODELSCOPE_PATH_TEMPLATE,
    revision: MODELSCOPE_REVISION,
    dim: 1024,
    baseDim: 1024,
    supportedDims: [1024],
    maxTokens: 512,
    maxTextChars: 480,
    dtype: 'q8',
    pooling: 'mean',
    sizeLabel: '约 330 MB',
    performanceTier: 'balanced',
    performanceLabel: '均衡',
    enabled: true
  },
  {
    id: 'bge-large-zh-v1.5-fp32',
    displayName: 'BGE Large 中文 · 高质量',
    description: '同模型 FP32 推理，精度更完整，下载和内存占用更高。',
    modelId: 'Xenova/bge-large-zh-v1.5',
    remoteHosts: [MODELSCOPE_HOST],
    remotePathTemplate: MODELSCOPE_PATH_TEMPLATE,
    revision: MODELSCOPE_REVISION,
    dim: 1024,
    baseDim: 1024,
    supportedDims: [1024],
    maxTokens: 512,
    maxTextChars: 480,
    dtype: 'fp32',
    pooling: 'mean',
    sizeLabel: '约 1.2 GB',
    performanceTier: 'heavy',
    performanceLabel: '高质量',
    enabled: true
  },
  {
    id: 'bge-m3',
    displayName: 'BGE-M3 · 多语言',
    description: '更强的多语言和长文本语义召回，资源占用更高。',
    modelId: 'Xenova/bge-m3',
    remoteHosts: [MODELSCOPE_HOST],
    remotePathTemplate: MODELSCOPE_PATH_TEMPLATE,
    revision: MODELSCOPE_REVISION,
    dim: 1024,
    baseDim: 1024,
    supportedDims: [1024],
    maxTokens: 8192,
    maxTextChars: 2400,
    dtype: 'q8',
    pooling: 'mean',
    sizeLabel: '约 600 MB',
    performanceTier: 'quality',
    performanceLabel: '长文本',
    enabled: true
  }
]

function safeProfileId(value: unknown): EmbeddingModelProfileId {
  const id = String(value || '').trim() as EmbeddingModelProfileId
  const profile = EMBEDDING_MODEL_PROFILES.find((item) => item.id === id && item.enabled)
  return profile?.id || DEFAULT_EMBEDDING_MODEL_PROFILE
}

function getProfileBase(profileId: string): EmbeddingModelProfile {
  return EMBEDDING_MODEL_PROFILES.find((profile) => profile.id === safeProfileId(profileId))!
}

function safeVectorDim(profile: EmbeddingModelProfile, value: unknown): number {
  const dim = Math.floor(Number(value) || 0)
  return profile.supportedDims.includes(dim) ? dim : profile.dim
}

function safeEmbeddingDevice(value: unknown): EmbeddingDevice {
  return String(value || '').trim() === 'dml' ? 'dml' : 'cpu'
}

function directorySize(dir: string): number {
  if (!existsSync(dir)) return 0

  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += directorySize(path)
    } else if (entry.isFile()) {
      total += statSync(path).size
    }
  }
  return total
}

function hasModelFiles(dir: string): boolean {
  if (!existsSync(dir)) return false

  let hasOnnx = false
  let hasTokenizer = false
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        visit(path)
        continue
      }

      if (entry.name.endsWith('.onnx')) hasOnnx = true
      if (entry.name === 'tokenizer.json' || entry.name === 'tokenizer_config.json') hasTokenizer = true
    }
  }

  visit(dir)
  return hasOnnx && hasTokenizer
}

function getElectronAppSafe(): any | null {
  try {
    const moduleName = 'electron'
    const requireFunc = eval('require') as NodeRequire
    const electronModule = requireFunc(moduleName)
    const electronApp = electronModule && typeof electronModule === 'object' ? electronModule.app : null
    return electronApp?.getPath ? electronApp : null
  } catch {
    return null
  }
}

function getEffectiveCachePathFromConfig(): string {
  const configService = new ConfigService()
  try {
    const configured = String(configService.get('cachePath' as any) || '').trim()
    if (configured) return configured
  } finally {
    configService.close()
  }

  const electronApp = getElectronAppSafe()
  if (electronApp?.getPath) {
    const documentsPath = electronApp.getPath('documents')
    if (process.env.VITE_DEV_SERVER_URL) {
      return join(documentsPath, 'CipherTalkData')
    }

    const installDir = dirname(electronApp.getPath('exe'))
    const isOnCDrive = /^[cC]:/i.test(installDir) || installDir.startsWith('\\\\')
    return isOnCDrive ? join(documentsPath, 'CipherTalkData') : join(installDir, 'CipherTalkData')
  }

  return join(process.cwd(), 'CipherTalkData')
}

function getDirectMLDllPath(): string | null {
  if (process.platform !== 'win32') return null

  try {
    const ortEntry = require.resolve('onnxruntime-node')
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    return join(dirname(ortEntry), '..', 'bin', 'napi-v6', 'win32', arch, 'DirectML.dll')
  } catch {
    return null
  }
}

function limitEmbeddingText(text: string, maxChars: number): string {
  const value = String(text || '')
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 480
  if (value.length <= limit) return value

  const headLength = Math.max(1, Math.floor(limit * 0.75))
  const tailLength = Math.max(1, limit - headLength)
  return `${value.slice(0, headLength)}\n${value.slice(-tailLength)}`
}

function applyEmbeddingInstruction(text: string, profile: EmbeddingModelProfile, inputType: EmbeddingInputType): string {
  const value = String(text || '')
  if (inputType !== 'query' || !profile.queryInstruction) return value
  return `Instruct: ${profile.queryInstruction}\nQuery: ${value}`
}

function tensorToVectors(output: any, expectedCount: number): Float32Array[] {
  const data = output?.data
  const dims = Array.isArray(output?.dims) ? output.dims.map((item: unknown) => Number(item)) : []
  if (!data || typeof data.length !== 'number' || dims.length === 0) {
    throw new Error('Embedding 模型输出为空')
  }

  const dim = Number(dims[dims.length - 1] || 0)
  const batch = dims.length >= 2 ? Number(dims[0] || expectedCount) : expectedCount
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error('Embedding 模型输出维度无效')
  }

  const vectors: Float32Array[] = []
  for (let index = 0; index < batch; index += 1) {
    const start = index * dim
    const end = start + dim
    if (end > data.length) break
    vectors.push(Float32Array.from(data.slice(start, end)))
  }

  if (vectors.length !== expectedCount) {
    throw new Error(`Embedding 输出数量不匹配：${vectors.length}/${expectedCount}`)
  }

  return vectors
}

function normalizeVector(vector: Float32Array): Float32Array {
  let norm = 0
  for (let index = 0; index < vector.length; index += 1) {
    norm += vector[index] * vector[index]
  }

  norm = Math.sqrt(norm) || 1
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] /= norm
  }
  return vector
}

function resizeVector(vector: Float32Array, targetDim: number): Float32Array {
  const dim = Math.floor(Number(targetDim) || 0)
  if (!Number.isInteger(dim) || dim <= 0 || dim === vector.length) return vector
  if (dim > vector.length) {
    throw new Error(`Embedding 输出维度不足：${vector.length}/${dim}`)
  }

  return normalizeVector(Float32Array.from(vector.slice(0, dim)))
}

export function hashEmbeddingContent(value: string): string {
  return createHash('sha256').update(value || '').digest('hex')
}

export function float32ArrayToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength))
}

function meanPoolNormalize(output: any, attentionMask: any, expectedCount: number): Float32Array[] {
  const hidden = output?.last_hidden_state || output?.token_embeddings || output?.logits
  const hiddenData = hidden?.data
  const hiddenDims = Array.isArray(hidden?.dims) ? hidden.dims.map((item: unknown) => Number(item)) : []
  const maskData = attentionMask?.data
  if (!hiddenData || hiddenDims.length !== 3 || !maskData) {
    throw new Error('Embedding 模型输出为空')
  }

  const [batchSize, seqLength, dim] = hiddenDims
  if (batchSize !== expectedCount || !Number.isInteger(seqLength) || !Number.isInteger(dim) || dim <= 0) {
    throw new Error(`Embedding 输出维度无效：${hiddenDims.join('x')}`)
  }

  const vectors: Float32Array[] = []
  for (let batch = 0; batch < batchSize; batch += 1) {
    const vector = new Float32Array(dim)
    let tokenCount = 0
    for (let token = 0; token < seqLength; token += 1) {
      const mask = Number(maskData[batch * seqLength + token] || 0)
      if (mask <= 0) continue
      tokenCount += mask
      const offset = (batch * seqLength + token) * dim
      for (let index = 0; index < dim; index += 1) {
        vector[index] += Number(hiddenData[offset + index]) * mask
      }
    }

    const divisor = tokenCount > 0 ? tokenCount : 1
    for (let index = 0; index < dim; index += 1) {
      vector[index] /= divisor
    }
    vectors.push(normalizeVector(vector))
  }

  return vectors
}

function lastTokenPoolNormalize(output: any, attentionMask: any, expectedCount: number): Float32Array[] {
  const hidden = output?.last_hidden_state || output?.token_embeddings || output?.logits
  const hiddenData = hidden?.data
  const hiddenDims = Array.isArray(hidden?.dims) ? hidden.dims.map((item: unknown) => Number(item)) : []
  const maskData = attentionMask?.data
  if (!hiddenData || hiddenDims.length !== 3 || !maskData) {
    throw new Error('Embedding 模型输出为空')
  }

  const [batchSize, seqLength, dim] = hiddenDims
  if (batchSize !== expectedCount || !Number.isInteger(seqLength) || !Number.isInteger(dim) || dim <= 0) {
    throw new Error(`Embedding 输出维度无效：${hiddenDims.join('x')}`)
  }

  const vectors: Float32Array[] = []
  for (let batch = 0; batch < batchSize; batch += 1) {
    let tokenIndex = seqLength - 1
    for (let index = seqLength - 1; index >= 0; index -= 1) {
      if (Number(maskData[batch * seqLength + index] || 0) > 0) {
        tokenIndex = index
        break
      }
    }

    const offset = (batch * seqLength + tokenIndex) * dim
    const vector = new Float32Array(dim)
    for (let index = 0; index < dim; index += 1) {
      vector[index] = Number(hiddenData[offset + index] || 0)
    }
    vectors.push(normalizeVector(vector))
  }

  return vectors
}

export type EmbeddingInputType = 'query' | 'document'

export class LocalEmbeddingModelService {
  private pipelines = new Map<string, Promise<{ tokenizer: any; model: any }>>()
  private downloadTasks = new Map<string, Promise<EmbeddingModelStatus>>()
  private dmlFailureReason: string | null = null

  listProfiles(): EmbeddingModelProfile[] {
    return EMBEDDING_MODEL_PROFILES.map((profile) => this.withConfiguredDim(profile))
  }

  getProfile(profileId?: string): EmbeddingModelProfile {
    const id = safeProfileId(profileId || this.getCurrentProfileId())
    return this.withConfiguredDim(getProfileBase(id))
  }

  private withConfiguredDim(profile: EmbeddingModelProfile): EmbeddingModelProfile {
    const configService = new ConfigService()
    try {
      const configured = configService.get('aiEmbeddingVectorDims' as any) as Record<string, unknown> | undefined
      const dim = safeVectorDim(profile, configured?.[profile.id])
      return { ...profile, dim }
    } catch {
      return { ...profile, dim: profile.dim }
    } finally {
      configService.close()
    }
  }

  getVectorModelId(profileId?: string): string {
    const profile = this.getProfile(profileId)
    return profile.dim === profile.baseDim ? profile.id : `${profile.id}@${profile.dim}d`
  }

  getCurrentVectorDim(profileId?: string): number {
    return this.getProfile(profileId).dim
  }

  setVectorDim(profileId: string, dim: number): number {
    const profile = getProfileBase(profileId)
    const nextDim = safeVectorDim(profile, dim)
    const configService = new ConfigService()
    try {
      const stored = configService.get('aiEmbeddingVectorDims' as any) as Record<string, unknown> | undefined
      const next = {
        ...(stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}),
        [profile.id]: nextDim
      }
      configService.set('aiEmbeddingVectorDims' as any, next as any)
      return nextDim
    } finally {
      configService.close()
    }
  }

  getCurrentProfileId(): EmbeddingModelProfileId {
    const configService = new ConfigService()
    try {
      return safeProfileId(configService.get('aiEmbeddingModelProfile' as any))
    } finally {
      configService.close()
    }
  }

  setCurrentProfileId(profileId: string): EmbeddingModelProfileId {
    const id = safeProfileId(profileId)
    const configService = new ConfigService()
    try {
      configService.set('aiEmbeddingModelProfile' as any, id)
      return id
    } finally {
      configService.close()
    }
  }

  getCurrentDevice(): EmbeddingDevice {
    const configService = new ConfigService()
    try {
      return safeEmbeddingDevice(configService.get('aiEmbeddingDevice' as any))
    } finally {
      configService.close()
    }
  }

  setCurrentDevice(device: string): EmbeddingDevice {
    const nextDevice = safeEmbeddingDevice(device)
    const configService = new ConfigService()
    try {
      configService.set('aiEmbeddingDevice' as any, nextDevice)
      this.dmlFailureReason = null
      this.clearPipelines()
      return nextDevice
    } finally {
      configService.close()
    }
  }

  getDeviceStatus(): EmbeddingDeviceStatus {
    const currentDevice = this.getCurrentDevice()
    const directMLDll = getDirectMLDllPath()
    const directMLAvailable = process.platform === 'win32' && !!directMLDll && existsSync(directMLDll)

    if (currentDevice === 'dml' && this.dmlFailureReason) {
      return {
        currentDevice,
        effectiveDevice: 'cpu',
        gpuAvailable: directMLAvailable,
        provider: 'CPU',
        info: `DirectML 本次运行失败，已自动回退 CPU：${this.dmlFailureReason}`
      }
    }

    if (currentDevice === 'dml' && directMLAvailable) {
      return {
        currentDevice,
        effectiveDevice: 'dml',
        gpuAvailable: true,
        provider: 'DirectML',
        info: 'DirectML 组件已就绪，将优先使用 GPU；推理失败时自动回退 CPU'
      }
    }

    if (currentDevice === 'dml') {
      return {
        currentDevice,
        effectiveDevice: 'cpu',
        gpuAvailable: false,
        provider: 'CPU',
        info: process.platform === 'win32'
          ? '缺少 DirectML 组件，将使用 CPU'
          : '当前系统不支持 DirectML，将使用 CPU'
      }
    }

    return {
      currentDevice,
      effectiveDevice: 'cpu',
      gpuAvailable: directMLAvailable,
      provider: 'CPU',
      info: directMLAvailable ? '当前使用 CPU，可切换到 DirectML GPU 实验模式' : '当前使用 CPU'
    }
  }

  getModelsRoot(): string {
    return join(getEffectiveCachePathFromConfig(), 'models', 'embeddings')
  }

  getProfileDir(profileId?: string): string {
    return join(this.getModelsRoot(), this.getProfile(profileId).id)
  }

  async getModelStatus(profileId?: string): Promise<EmbeddingModelStatus> {
    const profile = this.getProfile(profileId)
    const modelDir = this.getProfileDir(profile.id)
    const exists = hasModelFiles(modelDir)
    return {
      profileId: profile.id,
      displayName: profile.displayName,
      modelId: profile.modelId,
      dim: profile.dim,
      baseDim: profile.baseDim,
      supportedDims: profile.supportedDims,
      vectorModelId: this.getVectorModelId(profile.id),
      performanceTier: profile.performanceTier,
      performanceLabel: profile.performanceLabel,
      dtype: profile.dtype,
      sizeLabel: profile.sizeLabel,
      enabled: profile.enabled,
      exists,
      modelDir,
      sizeBytes: directorySize(modelDir)
    }
  }

  async downloadModel(
    profileId?: string,
    onProgress?: (progress: EmbeddingDownloadProgress) => void
  ): Promise<EmbeddingModelStatus> {
    const profile = this.getProfile(profileId)
    const existing = this.downloadTasks.get(profile.id)
    if (existing) return existing

    const task = (async () => {
      mkdirSync(this.getProfileDir(profile.id), { recursive: true })
      await this.downloadPipelineWithFallback(profile, onProgress)
      return this.getModelStatus(profile.id)
    })()

    this.downloadTasks.set(profile.id, task)
    try {
      return await task
    } finally {
      this.downloadTasks.delete(profile.id)
    }
  }

  async clearModel(profileId?: string): Promise<EmbeddingModelStatus> {
    const profile = this.getProfile(profileId)
    this.clearPipelines(profile.id)
    rmSync(this.getProfileDir(profile.id), { recursive: true, force: true })
    return this.getModelStatus(profile.id)
  }

  async ensureModelReady(profileId?: string): Promise<EmbeddingModelStatus> {
    const status = await this.getModelStatus(profileId)
    if (!status.exists) {
      throw new Error(`本地语义模型未下载：${status.displayName}`)
    }
    return status
  }

  async embedTexts(
    texts: string[],
    profileId?: string,
    options: { inputType?: EmbeddingInputType } = {}
  ): Promise<Float32Array[]> {
    const profile = this.getProfile(profileId)
    const inputType = options.inputType || 'document'
    const cleaned = texts.map((text) => {
      const limited = limitEmbeddingText(String(text || ''), profile.maxTextChars)
      return applyEmbeddingInstruction(limited, profile, inputType)
    })
    await this.ensureModelReady(profile.id)
    const deviceStatus = this.getDeviceStatus()

    if (deviceStatus.effectiveDevice === 'dml') {
      try {
        return await this.runEmbedding(profile, cleaned, 'dml')
      } catch (error) {
        console.warn('[Embedding] DirectML 推理失败，回退 CPU:', error)
        this.dmlFailureReason = String(error instanceof Error ? error.message : error)
        this.clearPipelines(profile.id, 'dml')
      }
    }

    return this.runEmbedding(profile, cleaned, 'cpu')
  }

  async embedText(
    text: string,
    profileId?: string,
    options: { inputType?: EmbeddingInputType } = {}
  ): Promise<Float32Array> {
    const [vector] = await this.embedTexts([text], profileId, { inputType: options.inputType || 'query' })
    return vector
  }

  private async runEmbedding(
    profile: EmbeddingModelProfile,
    texts: string[],
    device: EmbeddingDevice
  ): Promise<Float32Array[]> {
    const runtime = await this.getPipeline(profile, true, device)
    const modelInputs = runtime.tokenizer(texts, {
      padding: true,
      truncation: true,
      max_length: profile.maxTokens
    })
    const output = await runtime.model(modelInputs)
    const vectors = profile.pooling === 'last_token'
      ? lastTokenPoolNormalize(output, modelInputs.attention_mask, texts.length)
      : meanPoolNormalize(output, modelInputs.attention_mask, texts.length)
    return vectors.map((vector) => resizeVector(vector, profile.dim))
  }

  private async getPipeline(
    profile: EmbeddingModelProfile,
    localOnly: boolean,
    device: EmbeddingDevice = 'cpu',
    remoteHost?: string,
    progressCallback?: (event: any) => void
  ): Promise<{ tokenizer: any; model: any }> {
    const key = `${profile.id}:${device}:${localOnly ? 'local' : remoteHost || 'remote'}`
    const existing = this.pipelines.get(key)
    if (existing) return existing

    const promise = (async () => {
      const transformers = await import('@huggingface/transformers')
      transformers.env.allowLocalModels = true
      transformers.env.allowRemoteModels = !localOnly
      transformers.env.cacheDir = this.getProfileDir(profile.id)
      if (device === 'cpu') {
        const wasm = (transformers.env.backends?.onnx as any)?.wasm
        if (wasm && typeof wasm === 'object') {
          wasm.numThreads = CPU_EMBEDDING_THREADS
        }
      }
      if (remoteHost) {
        transformers.env.remoteHost = remoteHost
        transformers.env.remotePathTemplate = profile.remotePathTemplate
      }

      const commonOptions = {
        cache_dir: this.getProfileDir(profile.id),
        local_files_only: localOnly,
        revision: profile.revision,
        progress_callback: progressCallback
      }
      const tokenizer = await transformers.AutoTokenizer.from_pretrained(profile.modelId, commonOptions as any)
      const model = await transformers.AutoModel.from_pretrained(profile.modelId, {
        ...commonOptions,
        device,
        dtype: profile.dtype,
        session_options: device === 'cpu'
          ? {
            executionMode: 'sequential',
            interOpNumThreads: 1,
            intraOpNumThreads: CPU_EMBEDDING_THREADS
          }
          : undefined
      } as any)
      return { tokenizer, model }
    })()

    this.pipelines.set(key, promise)
    try {
      return await promise
    } catch (error) {
      this.pipelines.delete(key)
      throw error
    }
  }

  private clearPipelines(profileId?: string, device?: EmbeddingDevice): void {
    for (const key of Array.from(this.pipelines.keys())) {
      const matchesProfile = !profileId || key.startsWith(`${profileId}:`)
      const matchesDevice = !device || key.includes(`:${device}:`)
      if (matchesProfile && matchesDevice) {
        this.pipelines.delete(key)
      }
    }
  }

  private async downloadPipelineWithFallback(
    profile: EmbeddingModelProfile,
    onProgress?: (progress: EmbeddingDownloadProgress) => void
  ): Promise<void> {
    const errors: string[] = []

    for (const remoteHost of profile.remoteHosts) {
      try {
        onProgress?.({
          profileId: profile.id,
          displayName: profile.displayName,
          remoteHost,
          status: 'initiate'
        })

        await this.getPipeline(profile, false, 'cpu', remoteHost, (event) => {
          const loaded = Number(event?.loaded || 0)
          const total = Number(event?.total || 0)
          onProgress?.({
            profileId: profile.id,
            displayName: profile.displayName,
            remoteHost,
            file: String(event?.file || event?.name || ''),
            loaded: Number.isFinite(loaded) && loaded > 0 ? loaded : undefined,
            total: Number.isFinite(total) && total > 0 ? total : undefined,
            percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : undefined,
            status: String(event?.status || '')
          })
        })
        return
      } catch (error) {
        errors.push(`${remoteHost}: ${String(error)}`)
      }
    }

    throw new Error(`语义模型下载失败。已尝试模型源：${profile.remoteHosts.join('、')}。请检查网络/代理或稍后重试。${errors.length ? ` 原始错误：${errors.join(' | ')}` : ''}`)
  }
}

export const localEmbeddingModelService = new LocalEmbeddingModelService()
