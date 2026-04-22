import { Clipdrop, DeepSeek, Doubao, Gemini, Kimi, Ollama, OpenAI, ProviderIcon, Qwen, SiliconCloud, XiaomiMiMo, XAI, Yuanbao, Zhipu } from '@lobehub/icons'

type AIProviderLogoProps = {
  providerId?: string
  logo?: string
  alt: string
  className?: string
  size?: number
}

const SUPPORTED_PROVIDER_IDS = new Set([
  'openai',
  'minimax',
  'gemini',
  'zhipu',
  'qwen',
  'deepseek',
  'doubao',
  'kimi',
  'ollama',
  'xai',
  'tencent'
])

function normalizeProviderId(providerId?: string) {
  if (!providerId) return ''
  if (providerId === 'siliconflow') return 'siliconcloud'
  if (providerId === 'xiaomi') return 'xiaomimimo'
  return providerId
}

export default function AIProviderLogo({ providerId, logo, alt, className, size = 24 }: AIProviderLogoProps) {
  const normalizedProviderId = normalizeProviderId(providerId)

  if (normalizedProviderId === 'custom') {
    return <Clipdrop size={size} className={className} />
  }

  if (normalizedProviderId === 'gemini') {
    return <Gemini size={size} className={className} />
  }

  if (normalizedProviderId === 'kimi') {
    return <Kimi size={size} className={className} />
  }

  if (normalizedProviderId === 'siliconcloud') {
    return <SiliconCloud size={size} className={className} />
  }

  if (normalizedProviderId === 'xiaomimimo') {
    return <XiaomiMiMo size={size} className={className} />
  }

  if (normalizedProviderId === 'tencent') {
    return <Yuanbao size={size} className={className} />
  }

  if (normalizedProviderId === 'openai') {
    return <OpenAI size={size} className={className} />
  }

  if (normalizedProviderId === 'qwen') {
    return <Qwen size={size} className={className} />
  }

  if (normalizedProviderId === 'zhipu') {
    return <Zhipu size={size} className={className} />
  }

  if (normalizedProviderId === 'deepseek') {
    return <DeepSeek size={size} className={className} />
  }

  if (normalizedProviderId === 'doubao') {
    return <Doubao size={size} className={className} />
  }

  if (normalizedProviderId === 'ollama') {
    return <Ollama size={size} className={className} />
  }

  if (normalizedProviderId === 'xai') {
    return <XAI size={size} className={className} />
  }

  if (normalizedProviderId && SUPPORTED_PROVIDER_IDS.has(normalizedProviderId)) {
    return <ProviderIcon provider={normalizedProviderId} type="color" size={size} className={className} />
  }

  if (logo) {
    return <img src={logo} alt={alt} className={className} />
  }

  return null
}
