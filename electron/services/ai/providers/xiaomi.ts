import { BaseAIProvider } from './base'

const XIAOMI_DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'
const XIAOMI_TOKEN_PLAN_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1'

function normalizeApiKey(apiKey: string): string {
  return String(apiKey || '').trim()
}

function isTokenPlanApiKey(apiKey: string): boolean {
  return normalizeApiKey(apiKey).startsWith('tp-')
}

/**
 * Xiaomi MiMo提供商元数据
 */
export const XiaomiMetadata = {
  id: 'xiaomi',
  name: 'xiaomi',
  displayName: 'Xiaomi MiMo',
  description: '小米大模型',
  models: [
    'mimo-v2.5-pro',
    'mimo-v2.5',
    'mimo-v2-pro',
    'mimo-v2-omni',
    'mimo-v2-tts',
    'mimo-v2-flash'
  ],
  pricing: '免费',
  pricingDetail: {
    input: 0.0,
    output: 0.0
  },
  website: 'https://api.xiaomimimo.com/',
  logo: './AI-logo/xiaomimimo.svg'
}

/**
 * Xiaomi MiMo提供商
 */
export class XiaomiProvider extends BaseAIProvider {
  name = XiaomiMetadata.name
  displayName = XiaomiMetadata.displayName
  models = XiaomiMetadata.models
  pricing = XiaomiMetadata.pricingDetail
  private readonly useTokenPlan: boolean

  constructor(apiKey: string) {
    const normalizedApiKey = normalizeApiKey(apiKey)
    const useTokenPlan = isTokenPlanApiKey(normalizedApiKey)

    super(
      normalizedApiKey,
      useTokenPlan ? XIAOMI_TOKEN_PLAN_BASE_URL : XIAOMI_DEFAULT_BASE_URL
    )

    this.useTokenPlan = useTokenPlan
  }

  protected getDefaultHeaders(): Record<string, string> | undefined {
    if (!this.useTokenPlan) return undefined

    return {
      'HTTP-Referer': 'https://openclaw.ai',
      'X-OpenRouter-Title': 'OpenClaw'
    }
  }
}
