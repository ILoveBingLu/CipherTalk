import {
  localEmbeddingModelService,
  type EmbeddingInputType as LocalEmbeddingInputType
} from './embeddingModelService'
import {
  onlineEmbeddingService
} from './onlineEmbeddingService'
import type { EmbeddingInputType, EmbeddingMode } from './onlineEmbeddingTypes'

export type RuntimeEmbeddingProfile = {
  id: string
  displayName: string
  dim: number
  dtype: string
  sizeLabel?: string
  performanceTier?: string
  performanceLabel?: string
  enabled?: boolean
  mode: EmbeddingMode
  providerName?: string
}

export class EmbeddingRuntimeService {
  getMode(): EmbeddingMode {
    return onlineEmbeddingService.getEmbeddingMode()
  }

  setMode(mode: string): EmbeddingMode {
    return onlineEmbeddingService.setEmbeddingMode(mode)
  }

  getCurrentProfile(): RuntimeEmbeddingProfile {
    if (this.getMode() === 'online') {
      return onlineEmbeddingService.getCurrentProfile()
    }

    const profile = localEmbeddingModelService.getProfile()
    return {
      id: profile.id,
      displayName: profile.displayName,
      dim: profile.dim,
      dtype: profile.dtype,
      sizeLabel: profile.sizeLabel,
      performanceTier: profile.performanceTier,
      performanceLabel: profile.performanceLabel,
      enabled: profile.enabled,
      mode: 'local',
      providerName: '本地'
    }
  }

  getCurrentVectorModelId(): string {
    return this.getMode() === 'online'
      ? onlineEmbeddingService.getVectorModelId()
      : localEmbeddingModelService.getVectorModelId(localEmbeddingModelService.getProfile().id)
  }

  getCurrentVectorDim(): number {
    return this.getMode() === 'online'
      ? onlineEmbeddingService.getCurrentVectorDim()
      : localEmbeddingModelService.getCurrentVectorDim(localEmbeddingModelService.getProfile().id)
  }

  getCurrentBatchSize(defaultBatchSize: number): number {
    if (this.getMode() !== 'online') return defaultBatchSize
    return Math.max(1, Math.min(defaultBatchSize, onlineEmbeddingService.getCurrentBatchSize()))
  }

  ensureReady(): void {
    if (this.getMode() === 'online') {
      onlineEmbeddingService.ensureReady()
    }
  }

  async embedTexts(
    texts: string[],
    options: { inputType?: EmbeddingInputType } = {}
  ): Promise<Float32Array[]> {
    if (this.getMode() === 'online') {
      return onlineEmbeddingService.embedTexts(texts, options)
    }
    return localEmbeddingModelService.embedTexts(texts, localEmbeddingModelService.getProfile().id, {
      inputType: (options.inputType || 'document') as LocalEmbeddingInputType
    })
  }

  async embedText(
    text: string,
    options: { inputType?: EmbeddingInputType } = {}
  ): Promise<Float32Array> {
    if (this.getMode() === 'online') {
      return onlineEmbeddingService.embedText(text, options)
    }
    return localEmbeddingModelService.embedText(text, localEmbeddingModelService.getProfile().id, {
      inputType: (options.inputType || 'query') as LocalEmbeddingInputType
    })
  }
}

export const embeddingRuntimeService = new EmbeddingRuntimeService()
