import { useState, useEffect, useRef } from 'react'
import { Eye, EyeOff, Sparkles, Check, ChevronDown, ChevronUp, Zap, Star, FileText, HelpCircle, X, Plus, Settings2, Download, Trash2, Database, CheckCircle, AlertCircle, RefreshCw, Layers, Cpu, Cloud, Save } from 'lucide-react'
import { getAIProviders, type AIProviderInfo, type EmbeddingDevice, type EmbeddingDeviceStatus, type EmbeddingMode, type EmbeddingModelDownloadProgress, type EmbeddingModelProfile, type EmbeddingModelStatus, type OnlineEmbeddingConfig, type OnlineEmbeddingProviderInfo } from '../../types/ai'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import AIProviderLogo from './AIProviderLogo'
import './AISummarySettings.scss'

interface CustomSelectProps {
  value: string | number
  onChange: (value: any) => void
  options: { value: string | number; label: string }[]
  placeholder?: string
  editable?: boolean
}

function CustomSelect({ value, onChange, options, placeholder = '请选择', editable = false }: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [inputValue, setInputValue] = useState(value)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setInputValue(value)
  }, [value])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value
    setInputValue(newVal)
    onChange(newVal)
    setIsOpen(true)
  }

  const handleOptionClick = (val: string | number) => {
    onChange(val)
    setInputValue(val)
    setIsOpen(false)
  }

  return (
    <div className={`custom-select-container ${isOpen ? 'open' : ''}`} ref={containerRef}>
      <div className="select-trigger" onClick={() => !editable && setIsOpen(!isOpen)}>
        {editable ? (
          <input
            type="text"
            className="select-input"
            value={inputValue}
            onChange={handleInputChange}
            onClick={() => setIsOpen(true)}
            placeholder={placeholder}
          />
        ) : (
          <span>{options.find(o => o.value === value?.toString())?.label || value || placeholder}</span>
        )}
        <div className="trigger-icon" onClick={(e) => {
          e.stopPropagation()
          setIsOpen(!isOpen)
        }}>
          {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </div>

      {isOpen && (
        <div className="select-options">
          {options.map(opt => (
            <div
              key={opt.value}
              className={`select-option ${value === opt.value ? 'selected' : ''}`}
              onClick={() => handleOptionClick(opt.value)}
            >
              <span className="option-label">{opt.label}</span>
              {value === opt.value && <Check size={14} className="check-icon" />}
            </div>
          ))}
          {editable && inputValue && !options.some(o => o.value === inputValue) && (
            <div className="select-option custom-value">
              <span className="option-label">使用自定义值: {inputValue}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Props 接口定义，接收父组件传递的状态和修改函数
interface AISummarySettingsProps {
  provider: string
  setProvider: (val: string) => void
  apiKey: string
  setApiKey: (val: string) => void
  model: string
  setModel: (val: string) => void
  defaultTimeRange: number
  setDefaultTimeRange: (val: number) => void
  summaryDetail: 'simple' | 'normal' | 'detailed'
  setSummaryDetail: (val: 'simple' | 'normal' | 'detailed') => void
  systemPromptPreset: 'default' | 'decision-focus' | 'action-focus' | 'risk-focus' | 'custom'
  setSystemPromptPreset: (val: 'default' | 'decision-focus' | 'action-focus' | 'risk-focus' | 'custom') => void
  customSystemPrompt: string
  setCustomSystemPrompt: (val: string) => void
  enableThinking: boolean
  setEnableThinking: (val: boolean) => void
  messageLimit: number
  setMessageLimit: (val: number) => void
  agentDecisionMaxTokens: number
  setAgentDecisionMaxTokens: (val: number) => void
  agentAnswerMaxTokens: number
  setAgentAnswerMaxTokens: (val: number) => void
  showMessage: (text: string, success: boolean) => void
}

const DEEPSEEK_LEGACY_MODEL_MAP: Record<string, string> = {
  'DeepSeek V3': 'deepseek-v4-flash',
  'DeepSeek R1 (推理)': 'deepseek-v4-flash',
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-flash'
}

const ONLINE_EMBEDDING_FALLBACK_DIMS = [2048, 1536, 1024, 768, 512, 256, 128, 64]

function normalizeProviderModel(providerId: string, modelName: string) {
  if (providerId !== 'deepseek') {
    return modelName
  }

  return DEEPSEEK_LEGACY_MODEL_MAP[modelName] || modelName
}

function formatBytes(bytes?: number): string {
  const value = Number(bytes || 0)
  if (value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = value
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function AISummarySettings({
  provider,
  setProvider,
  apiKey,
  setApiKey,
  model,
  setModel,
  defaultTimeRange,
  setDefaultTimeRange,
  summaryDetail,
  setSummaryDetail,
  systemPromptPreset,
  setSystemPromptPreset,
  customSystemPrompt,
  setCustomSystemPrompt,
  enableThinking,
  setEnableThinking,
  messageLimit,
  setMessageLimit,
  agentDecisionMaxTokens,
  setAgentDecisionMaxTokens,
  agentAnswerMaxTokens,
  setAgentAnswerMaxTokens,
  showMessage
}: AISummarySettingsProps) {
  const [showApiKey, setShowApiKey] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [usageStats, setUsageStats] = useState<any>(null)
  const [providers, setProviders] = useState<AIProviderInfo[]>([])
  const [providerConfigs, setProviderConfigs] = useState<{ [key: string]: { apiKey: string; model: string; baseURL?: string } }>({})
  const [baseURL, setBaseURL] = useState('')
  const [showOllamaHelp, setShowOllamaHelp] = useState(false)
  const [showCustomHelp, setShowCustomHelp] = useState(false)
  const [ollamaGuideContent, setOllamaGuideContent] = useState('')
  const [customGuideContent, setCustomGuideContent] = useState('')
  const [isLoadingGuide, setIsLoadingGuide] = useState(false)
  const [presets, setPresets] = useState<any[]>([])
  const [showSavePresetDialog, setShowSavePresetDialog] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [showPresetDrawer, setShowPresetDrawer] = useState(false)
  const [newPresetStep, setNewPresetStep] = useState<'provider' | 'config' | 'name'>('provider')
  const [newPresetProvider, setNewPresetProvider] = useState('')
  const [newPresetApiKey, setNewPresetApiKey] = useState('')
  const [newPresetModel, setNewPresetModel] = useState('')
  const [newPresetBaseURL, setNewPresetBaseURL] = useState('')
  const [currentPresetName, setCurrentPresetName] = useState('')
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null)
  const [embeddingProfiles, setEmbeddingProfiles] = useState<EmbeddingModelProfile[]>([])
  const [embeddingMode, setEmbeddingModeState] = useState<EmbeddingMode>('local')
  const [embeddingProfileId, setEmbeddingProfileId] = useState('bge-large-zh-v1.5-int8')
  const [embeddingDevice, setEmbeddingDevice] = useState<EmbeddingDevice>('cpu')
  const [embeddingDeviceStatus, setEmbeddingDeviceStatus] = useState<EmbeddingDeviceStatus | null>(null)
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingModelStatus | null>(null)
  const [embeddingProgress, setEmbeddingProgress] = useState<EmbeddingModelDownloadProgress | null>(null)
  const [isDownloadingEmbedding, setIsDownloadingEmbedding] = useState(false)
  const [isClearingEmbedding, setIsClearingEmbedding] = useState(false)
  const [onlineEmbeddingProviders, setOnlineEmbeddingProviders] = useState<OnlineEmbeddingProviderInfo[]>([])
  const [onlineEmbeddingConfigs, setOnlineEmbeddingConfigs] = useState<OnlineEmbeddingConfig[]>([])
  const [currentOnlineEmbeddingConfigId, setCurrentOnlineEmbeddingConfigId] = useState('')
  const [onlineEmbeddingName, setOnlineEmbeddingName] = useState('')
  const [onlineEmbeddingProviderId, setOnlineEmbeddingProviderId] = useState<'aliyun' | 'siliconflow' | 'volcengine'>('aliyun')
  const [onlineEmbeddingBaseURL, setOnlineEmbeddingBaseURL] = useState('')
  const [onlineEmbeddingApiKey, setOnlineEmbeddingApiKey] = useState('')
  const [onlineEmbeddingModel, setOnlineEmbeddingModel] = useState('')
  const [onlineEmbeddingDim, setOnlineEmbeddingDim] = useState(1024)
  const [showOnlineEmbeddingApiKey, setShowOnlineEmbeddingApiKey] = useState(false)
  const [isTestingOnlineEmbedding, setIsTestingOnlineEmbedding] = useState(false)
  const [isSavingOnlineEmbedding, setIsSavingOnlineEmbedding] = useState(false)
  const [isDeletingOnlineEmbedding, setIsDeletingOnlineEmbedding] = useState(false)

  useEffect(() => {
    // 加载提供商列表和统计数据
    loadProviders()
    loadUsageStats()
    loadAllProviderConfigs()
    loadPresets()
    loadEmbeddingModels()
    loadEmbeddingDeviceStatus()
    loadOnlineEmbeddingProviders()
    loadOnlineEmbeddingConfigs()
  }, [])

  useEffect(() => {
    if (!embeddingProfileId) return
    loadEmbeddingStatus(embeddingProfileId)
  }, [embeddingProfileId])

  useEffect(() => {
    const cleanup = window.electronAPI.ai.onEmbeddingModelDownloadProgress((progress) => {
      if (progress.profileId === embeddingProfileId) {
        setEmbeddingProgress(progress)
      }
    })
    return cleanup
  }, [embeddingProfileId])

  useEffect(() => {
    if (onlineEmbeddingProviders.length === 0) return
    const selected = onlineEmbeddingConfigs.find((item) => item.id === currentOnlineEmbeddingConfigId) || onlineEmbeddingConfigs[0] || null
    if (selected || !onlineEmbeddingModel) {
      applyOnlineEmbeddingConfig(selected, onlineEmbeddingProviders)
    }
  }, [onlineEmbeddingProviders.length])

  useEffect(() => {
    const normalizedModel = normalizeProviderModel(provider, model)
    if (normalizedModel !== model) {
      setModel(normalizedModel)
    }
  }, [provider, model, setModel])

  // 当 provider 改变时，加载对应的 baseURL
  useEffect(() => {
    const loadBaseURL = async () => {
      if (provider === 'ollama' || provider === 'custom') {
        const { getAiProviderConfig } = await import('../../services/config')
        const config = await getAiProviderConfig(provider)
        if (provider === 'ollama') {
          setBaseURL(config?.baseURL || 'http://localhost:11434/v1')
        } else if (provider === 'custom') {
          setBaseURL(config?.baseURL || '')
        }
      } else {
        setBaseURL('')
      }
    }
    loadBaseURL()
  }, [provider])

  // 当 baseURL 改变时，自动保存（仅针对 Ollama 和 Custom）
  useEffect(() => {
    const saveBaseURL = async () => {
      if ((provider === 'ollama' || provider === 'custom') && baseURL) {
        const { setAiProviderConfig } = await import('../../services/config')
        await setAiProviderConfig(provider, { apiKey, model, baseURL })
      }
    }
    // 延迟保存，避免初始化时触发
    const timer = setTimeout(saveBaseURL, 500)
    return () => clearTimeout(timer)
  }, [baseURL, provider, apiKey, model])

  const loadProviders = async () => {
    try {
      const providerList = await getAIProviders()
      setProviders(providerList)
    } catch (e) {
      console.error('加载提供商列表失败:', e)
    }
  }

  const loadAllProviderConfigs = async () => {
    try {
      const { getAllAiProviderConfigs } = await import('../../services/config')
      const configs = await getAllAiProviderConfigs()
      const normalizedConfigs = Object.fromEntries(
        Object.entries(configs).map(([providerId, config]) => [
          providerId,
          {
            ...config,
            model: normalizeProviderModel(providerId, config.model)
          }
        ])
      )
      setProviderConfigs(normalizedConfigs)
    } catch (e) {
      console.error('加载提供商配置失败:', e)
    }
  }

  const loadPresets = async () => {
    try {
      const { getAiConfigPresets } = await import('../../services/config')
      const presetList = await getAiConfigPresets()
      setPresets(presetList)
    } catch (e) {
      console.error('加载配置预设失败:', e)
    }
  }

  const loadEmbeddingModels = async () => {
    try {
      const result = await window.electronAPI.ai.getEmbeddingModelProfiles()
      if (result.success && result.result) {
        setEmbeddingProfiles(result.result)
        setEmbeddingProfileId(result.currentProfileId || 'bge-large-zh-v1.5-int8')
        if (result.embeddingMode) setEmbeddingModeState(result.embeddingMode)
      }
    } catch (e) {
      console.error('加载语义模型失败:', e)
    }
  }

  const loadEmbeddingStatus = async (profileId = embeddingProfileId) => {
    try {
      const result = await window.electronAPI.ai.getEmbeddingModelStatus(profileId)
      if (result.success && result.result) {
        setEmbeddingStatus(result.result)
      }
    } catch (e) {
      console.error('加载语义模型状态失败:', e)
    }
  }

  const loadEmbeddingDeviceStatus = async () => {
    try {
      const result = await window.electronAPI.ai.getEmbeddingDeviceStatus()
      if (result.success && result.result) {
        setEmbeddingDevice(result.result.currentDevice)
        setEmbeddingDeviceStatus(result.result)
        if (result.embeddingMode) setEmbeddingModeState(result.embeddingMode)
      }
    } catch (e) {
      console.error('加载语义向量计算模式失败:', e)
    }
  }

  const applyOnlineEmbeddingConfig = (config?: OnlineEmbeddingConfig | null, providers = onlineEmbeddingProviders) => {
    const provider = providers.find((item) => item.id === (config?.providerId || onlineEmbeddingProviderId)) || providers[0]
    const model = provider?.models.find((item) => item.id === config?.model) || provider?.models[0]
    setCurrentOnlineEmbeddingConfigId(config?.id || '')
    setOnlineEmbeddingProviderId((provider?.id || 'aliyun') as 'aliyun' | 'siliconflow' | 'volcengine')
    setOnlineEmbeddingBaseURL(config?.baseURL || provider?.defaultBaseURL || '')
    setOnlineEmbeddingModel(config?.model || model?.id || '')
    setOnlineEmbeddingDim(config?.dim || model?.defaultDim || 1024)
    setOnlineEmbeddingApiKey(config?.apiKey || '')
    setOnlineEmbeddingName(config?.name || (provider && model ? `${provider.displayName} ${model.id}` : ''))
  }

  const loadOnlineEmbeddingProviders = async () => {
    try {
      const result = await window.electronAPI.ai.getOnlineEmbeddingProviders()
      if (result.success && result.result) {
        setOnlineEmbeddingProviders(result.result)
        if (!onlineEmbeddingBaseURL && result.result[0]) {
          applyOnlineEmbeddingConfig(null, result.result)
        }
      }
    } catch (e) {
      console.error('加载在线向量厂商失败:', e)
    }
  }

  const loadOnlineEmbeddingConfigs = async () => {
    try {
      const result = await window.electronAPI.ai.listOnlineEmbeddingConfigs()
      if (result.success && result.result) {
        setOnlineEmbeddingConfigs(result.result)
        const selected = result.result.find((item) => item.id === result.currentConfigId) || result.result[0] || null
        applyOnlineEmbeddingConfig(selected)
      }
    } catch (e) {
      console.error('加载在线向量配置失败:', e)
    }
  }

  const handleEmbeddingModeChange = async (mode: EmbeddingMode) => {
    setEmbeddingModeState(mode)
    const result = await window.electronAPI.ai.setEmbeddingMode(mode)
    if (!result.success) {
      showMessage(result.error || '语义向量模式设置失败', false)
      await loadEmbeddingModels()
      return
    }
    setEmbeddingModeState(result.result || mode)
    showMessage(mode === 'online' ? '已切换到在线向量模式' : '已切换到本地向量模式', true)
  }

  const handleEmbeddingDeviceChange = async (device: EmbeddingDevice) => {
    if (embeddingMode !== 'local') {
      await handleEmbeddingModeChange('local')
    }
    setEmbeddingDevice(device)
    const result = await window.electronAPI.ai.setEmbeddingDevice(device)
    if (!result.success) {
      showMessage(result.error || '语义向量计算模式设置失败', false)
      await loadEmbeddingDeviceStatus()
      return
    }
    if (result.status) {
      setEmbeddingDeviceStatus(result.status)
      setEmbeddingDevice(result.status.currentDevice)
    } else {
      await loadEmbeddingDeviceStatus()
    }
    showMessage(device === 'dml' ? '已启用 DirectML GPU 实验模式' : '已切换到 CPU 计算模式', true)
  }

  const handleEmbeddingProfileChange = async (profileId: string | number) => {
    const nextProfileId = String(profileId)
    const profile = embeddingProfiles.find((item) => item.id === nextProfileId)
    if (profile && !profile.enabled) return

    setEmbeddingProfileId(nextProfileId)
    setEmbeddingProgress(null)
    const result = await window.electronAPI.ai.setEmbeddingModelProfile(nextProfileId)
    if (!result.success) {
      showMessage(result.error || '语义模型设置失败', false)
      return
    }
    await loadEmbeddingStatus(nextProfileId)
    showMessage('语义模型设置已保存', true)
  }

  const handleEmbeddingDimChange = async (dim: string | number) => {
    if (!embeddingProfile) return
    const nextDim = Number(dim)
    if (!Number.isInteger(nextDim) || !embeddingProfile.supportedDims.includes(nextDim)) return

    const result = await window.electronAPI.ai.setEmbeddingVectorDim(embeddingProfile.id, nextDim)
    if (!result.success || !result.result) {
      showMessage(result.error || '语义向量维度设置失败', false)
      return
    }

    setEmbeddingProfiles((profiles) => profiles.map((profile) => (
      profile.id === embeddingProfile.id ? { ...profile, dim: result.result || nextDim } : profile
    )))
    setEmbeddingStatus((status) => status && status.profileId === embeddingProfile.id
      ? { ...status, dim: result.result || nextDim, vectorModelId: result.vectorModelId || status.vectorModelId }
      : status)
    await loadEmbeddingStatus(embeddingProfile.id)
    showMessage(`语义向量维度已切换为 ${result.result || nextDim} 维，后续索引会按新维度重建`, true)
  }

  const handleDownloadEmbeddingModel = async () => {
    if (!embeddingProfileId || isDownloadingEmbedding) return
    setIsDownloadingEmbedding(true)
    setEmbeddingProgress(null)
    try {
      const result = await window.electronAPI.ai.downloadEmbeddingModel(embeddingProfileId)
      if (!result.success || !result.result) {
        throw new Error(result.error || '语义模型下载失败')
      }
      setEmbeddingStatus(result.result)
      setEmbeddingProgress(null)
      showMessage('语义模型下载完成', true)
    } catch (e) {
      showMessage(String(e), false)
    } finally {
      setIsDownloadingEmbedding(false)
    }
  }

  const handleClearEmbeddingModel = async () => {
    if (!embeddingProfileId || isClearingEmbedding) return
    setIsClearingEmbedding(true)
    try {
      const result = await window.electronAPI.ai.clearEmbeddingModel(embeddingProfileId)
      if (!result.success || !result.result) {
        throw new Error(result.error || '语义模型清理失败')
      }
      setEmbeddingStatus(result.result)
      setEmbeddingProgress(null)
      showMessage('语义模型已清理', true)
    } catch (e) {
      showMessage(String(e), false)
    } finally {
      setIsClearingEmbedding(false)
    }
  }

  const handleClearSemanticIndex = async () => {
    try {
      const result = await window.electronAPI.ai.clearSemanticVectorIndex(embeddingMode === 'local' ? embeddingProfileId : undefined)
      if (!result.success || !result.result) {
        throw new Error(result.error || '语义索引清理失败')
      }
      showMessage(`已清理 ${result.result.deletedCount} 条语义索引`, true)
    } catch (e) {
      showMessage(String(e), false)
    }
  }

  const buildOnlineEmbeddingPayload = () => ({
    id: currentOnlineEmbeddingConfigId || undefined,
    name: onlineEmbeddingName.trim(),
    providerId: onlineEmbeddingProviderId,
    baseURL: onlineEmbeddingBaseURL.trim(),
    apiKey: onlineEmbeddingApiKey.trim(),
    model: onlineEmbeddingModel.trim(),
    dim: onlineEmbeddingDim
  })

  const handleOnlineProviderChange = (providerId: string | number) => {
    const provider = onlineEmbeddingProviders.find((item) => item.id === String(providerId))
    if (!provider) return
    const model = provider.models[0]
    setCurrentOnlineEmbeddingConfigId('')
    setOnlineEmbeddingProviderId(provider.id)
    setOnlineEmbeddingBaseURL(provider.defaultBaseURL)
    setOnlineEmbeddingModel(model?.id || '')
    setOnlineEmbeddingDim(model?.defaultDim || 1024)
    setOnlineEmbeddingName(model ? `${provider.displayName} ${model.id}` : provider.displayName)
  }

  const handleOnlineModelChange = (modelId: string | number) => {
    const modelValue = String(modelId)
    const modelInfo = onlineEmbeddingProvider?.models.find((item) => item.id === modelValue)
    setOnlineEmbeddingModel(modelValue)
    if (modelInfo) {
      setOnlineEmbeddingDim(modelInfo.defaultDim)
      if (!onlineEmbeddingName.trim() || currentOnlineEmbeddingConfigId) {
        setOnlineEmbeddingName(`${onlineEmbeddingProvider?.displayName || ''} ${modelInfo.id}`.trim())
      }
    }
    setCurrentOnlineEmbeddingConfigId('')
  }

  const handleOnlineConfigSelect = async (configId: string | number) => {
    const nextConfigId = String(configId)
    const selected = onlineEmbeddingConfigs.find((item) => item.id === nextConfigId)
    if (!selected) return
    const result = await window.electronAPI.ai.setCurrentOnlineEmbeddingConfig(nextConfigId)
    if (!result.success || !result.result) {
      showMessage(result.error || '在线向量配置切换失败', false)
      return
    }
    applyOnlineEmbeddingConfig(result.result)
    showMessage('在线向量配置已切换', true)
  }

  const handleTestOnlineEmbeddingConfig = async () => {
    setIsTestingOnlineEmbedding(true)
    try {
      const result = await window.electronAPI.ai.testOnlineEmbeddingConfig(buildOnlineEmbeddingPayload())
      const test = result.result
      if (!result.success || !test?.success) {
        throw new Error(test?.error || result.error || '在线向量配置测试失败')
      }
      showMessage(`在线向量测试成功：${test.dim || onlineEmbeddingDim} 维`, true)
    } catch (e) {
      showMessage(String(e), false)
    } finally {
      setIsTestingOnlineEmbedding(false)
    }
  }

  const handleSaveOnlineEmbeddingConfig = async () => {
    setIsSavingOnlineEmbedding(true)
    try {
      const payload = buildOnlineEmbeddingPayload()
      if (!payload.name) {
        throw new Error('请输入在线向量配置名称')
      }
      const result = await window.electronAPI.ai.saveOnlineEmbeddingConfig(payload)
      if (!result.success || !result.result) {
        throw new Error(result.error || '在线向量配置保存失败')
      }
      const saved = result.result
      setOnlineEmbeddingConfigs((configs) => {
        const exists = configs.some((item) => item.id === saved.id)
        return exists ? configs.map((item) => item.id === saved.id ? saved : item) : [...configs, saved]
      })
      applyOnlineEmbeddingConfig(saved)
      await handleEmbeddingModeChange('online')
      showMessage('在线向量配置已保存并启用', true)
    } catch (e) {
      showMessage(String(e), false)
    } finally {
      setIsSavingOnlineEmbedding(false)
    }
  }

  const handleDeleteOnlineEmbeddingConfig = async () => {
    if (!currentOnlineEmbeddingConfigId || isDeletingOnlineEmbedding) return
    if (!confirm('确定要删除当前在线向量配置吗？已有语义索引不会自动删除。')) return
    setIsDeletingOnlineEmbedding(true)
    try {
      const result = await window.electronAPI.ai.deleteOnlineEmbeddingConfig(currentOnlineEmbeddingConfigId)
      if (!result.success || !result.result) {
        throw new Error(result.error || '在线向量配置删除失败')
      }
      setOnlineEmbeddingConfigs(result.result.configs)
      const selected = result.result.configs.find((item) => item.id === result.result?.currentConfigId) || result.result.configs[0] || null
      applyOnlineEmbeddingConfig(selected)
      showMessage('在线向量配置已删除', true)
    } catch (e) {
      showMessage(String(e), false)
    } finally {
      setIsDeletingOnlineEmbedding(false)
    }
  }

  const handleStartNewPreset = () => {
    setEditingPresetId(null)
    setNewPresetStep('provider')
    setNewPresetProvider('')
    setNewPresetApiKey('')
    setNewPresetModel('')
    setNewPresetBaseURL('')
    setPresetName('')
    setShowSavePresetDialog(true)
  }

  const handleEditPreset = (preset: any) => {
    setEditingPresetId(preset.id)
    setNewPresetProvider(preset.provider)
    setNewPresetApiKey(preset.apiKey)
    setNewPresetModel(normalizeProviderModel(preset.provider, preset.model))
    setNewPresetBaseURL(preset.baseURL || '')
    setPresetName(preset.name)
    setNewPresetStep('config')
    setShowPresetDrawer(false)
    setShowSavePresetDialog(true)
  }

  const handleSelectProvider = (providerId: string) => {
    setNewPresetProvider(providerId)
    const providerData = providers.find(p => p.id === providerId)
    if (providerData) {
      setNewPresetModel(providerData.models[0])
      if (providerId === 'ollama') {
        setNewPresetBaseURL('http://localhost:11434/v1')
      } else if (providerId === 'custom') {
        setNewPresetBaseURL('')
      } else {
        setNewPresetBaseURL('')
      }
    }
    setNewPresetStep('config')
  }

  const handleSavePreset = async () => {
    if (!presetName.trim()) {
      showMessage('请输入配置名称', false)
      return
    }

    try {
      const { saveAiConfigPreset, updateAiConfigPreset } = await import('../../services/config')

      const payload = {
        name: presetName.trim(),
        provider: newPresetProvider,
        apiKey: newPresetApiKey,
        model: normalizeProviderModel(newPresetProvider, newPresetModel),
        baseURL: newPresetBaseURL
      }

      if (editingPresetId) {
        await updateAiConfigPreset(editingPresetId, payload)
        showMessage('配置已更新', true)
      } else {
        await saveAiConfigPreset(payload)
        showMessage('配置已保存', true)
      }

      setPresetName('')
      setEditingPresetId(null)
      setShowSavePresetDialog(false)
      await loadPresets()
    } catch (e) {
      showMessage('保存失败: ' + String(e), false)
    }
  }

  const handleLoadPreset = async (presetId: string) => {
    try {
      const { loadAiConfigPreset } = await import('../../services/config')
      const preset = await loadAiConfigPreset(presetId)
      if (preset) {
        setProvider(preset.provider)
        setApiKey(preset.apiKey)
        setModel(normalizeProviderModel(preset.provider, preset.model))
        setBaseURL(preset.baseURL || '')
        setCurrentPresetName(preset.name)
        showMessage(`已加载配置: ${preset.name}`, true)
      }
    } catch (e) {
      showMessage('加载失败: ' + String(e), false)
    }
  }

  const handleDeletePreset = async (presetId: string) => {
    try {
      const { deleteAiConfigPreset } = await import('../../services/config')
      await deleteAiConfigPreset(presetId)
      showMessage('配置已删除', true)
      await loadPresets()
    } catch (e) {
      showMessage('删除失败: ' + String(e), false)
    }
  }

  const handleProviderChange = async (newProvider: string) => {
    // 先保存当前提供商的配置
    if (provider && (apiKey || model || baseURL)) {
      const { setAiProviderConfig } = await import('../../services/config')
      const normalizedModel = normalizeProviderModel(provider, model)
      await setAiProviderConfig(provider, { apiKey, model: normalizedModel, baseURL: baseURL || undefined })
      setProviderConfigs(prev => ({
        ...prev,
        [provider]: { apiKey, model: normalizedModel, baseURL: baseURL || undefined }
      }))
    }

    // 切换到新提供商
    setProvider(newProvider)

    // 加载新提供商的配置
    const newProviderData = providers.find(p => p.id === newProvider)
    const savedConfig = providerConfigs[newProvider]

    if (savedConfig) {
      // 使用已保存的配置
      setApiKey(savedConfig.apiKey)
      setModel(normalizeProviderModel(newProvider, savedConfig.model))
      setBaseURL(savedConfig.baseURL || '')
    } else if (newProviderData) {
      // 使用默认配置
      setApiKey('')
      setModel(newProviderData.models[0])
      // Ollama 和 Custom 的默认 baseURL
      if (newProvider === 'ollama') {
        setBaseURL('http://localhost:11434/v1')
      } else if (newProvider === 'custom') {
        setBaseURL('')
      } else {
        setBaseURL('')
      }
    }
  }

  const loadUsageStats = async () => {
    try {
      const result = await window.electronAPI.ai.getUsageStats()
      if (result.success) {
        setUsageStats(result.stats)
      }
    } catch (e) {
      console.error('加载使用统计失败:', e)
    }
  }

  const handleTestConnection = async () => {
    // Ollama 本地服务不需要 API 密钥
    if (provider !== 'ollama' && !apiKey) {
      showMessage('请先输入 API 密钥', false)
      return
    }

    // Custom 服务必须配置 baseURL
    if (provider === 'custom' && !baseURL) {
      showMessage('请先配置服务地址', false)
      return
    }

    setIsTesting(true)

    try {
      const result = await window.electronAPI.ai.testConnection(provider, apiKey)
      if (result.success) {
        showMessage('连接成功！', true)
      } else {
        // 使用后端返回的详细错误信息
        showMessage(result.error || '连接失败，请开启代理或检查网络', false)

        // 如果需要代理，额外提示
        if (result.needsProxy) {
          console.warn('[AI] 连接失败，可能需要代理。请检查：')
          console.warn('1. 系统代理是否已开启（Clash/V2Ray 等）')
          console.warn('2. API Key 是否正确')
          console.warn('3. 网络连接是否正常')
        }
      }
    } catch (e) {
      showMessage('连接失败，请开启代理或检查网络', false)
      console.error('[AI] 测试连接异常:', e)
    } finally {
      setIsTesting(false)
    }
  }

  // 加载使用指南
  const loadGuide = async (guideName: string) => {
    setIsLoadingGuide(true)
    try {
      const result = await window.electronAPI.ai.readGuide(guideName)
      if (result.success && result.content) {
        const html = await marked.parse(result.content)
        const sanitized = DOMPurify.sanitize(html)
        return sanitized
      } else {
        console.error('加载指南失败:', result.error)
        return '<p>加载指南失败</p>'
      }
    } catch (e) {
      console.error('加载指南异常:', e)
      return '<p>加载指南失败</p>'
    } finally {
      setIsLoadingGuide(false)
    }
  }

  // 打开 Ollama 帮助
  const handleOpenOllamaHelp = async () => {
    if (!ollamaGuideContent) {
      const content = await loadGuide('Ollama使用指南.md')
      setOllamaGuideContent(content)
    }
    setShowOllamaHelp(true)
  }

  // 打开自定义服务帮助
  const handleOpenCustomHelp = async () => {
    if (!customGuideContent) {
      const content = await loadGuide('自定义AI服务使用指南.md')
      setCustomGuideContent(content)
    }
    setShowCustomHelp(true)
  }

  const currentProvider = providers.find(p => p.id === provider) || providers[0]
  const modelOptions = currentProvider?.models.map(m => ({ value: m, label: m })) || []
  const embeddingProgressPercent = embeddingProgress?.percent
    ?? (embeddingProgress?.total ? Math.round(((embeddingProgress.loaded || 0) / embeddingProgress.total) * 100) : 0)
  const embeddingProfile = embeddingProfiles.find(item => item.id === embeddingProfileId)
  const embeddingDimOptions = (embeddingProfile?.supportedDims || [embeddingProfile?.dim || 1024])
    .map((dim) => ({ value: dim, label: `${dim} 维` }))
  const embeddingPerformanceClass = embeddingProfile?.performanceTier || embeddingStatus?.performanceTier || 'balanced'
  const embeddingPerformanceLabel = embeddingProfile?.performanceLabel || embeddingStatus?.performanceLabel || '均衡'
  const embeddingDeviceLabel = embeddingDeviceStatus
    ? `${embeddingDeviceStatus.provider}${embeddingDeviceStatus.effectiveDevice !== embeddingDeviceStatus.currentDevice ? ' 回退' : ''}`
    : (embeddingDevice === 'dml' ? 'DirectML' : 'CPU')
  const embeddingVolumeLabel = embeddingStatus?.exists
    ? formatBytes(embeddingStatus.sizeBytes)
    : (embeddingProfile?.sizeLabel || embeddingStatus?.sizeLabel || '未知')
  const onlineEmbeddingProvider = onlineEmbeddingProviders.find(item => item.id === onlineEmbeddingProviderId) || onlineEmbeddingProviders[0]
  const onlineEmbeddingModelInfo = onlineEmbeddingProvider?.models.find(item => item.id === onlineEmbeddingModel)
  const onlineEmbeddingModelOptions = onlineEmbeddingProvider?.models.map(item => ({ value: item.id, label: item.displayName || item.id })) || []
  const onlineEmbeddingProviderOptions = onlineEmbeddingProviders.map(item => ({ value: item.id, label: item.displayName }))
  const onlineEmbeddingConfigOptions = onlineEmbeddingConfigs.map(item => ({ value: item.id, label: item.name || `${item.providerId} · ${item.model}` }))
  const onlineEmbeddingDimOptions = (onlineEmbeddingModelInfo?.supportedDims?.length
    ? onlineEmbeddingModelInfo.supportedDims
    : ONLINE_EMBEDDING_FALLBACK_DIMS
  ).map((dim) => ({ value: dim, label: `${dim} 维` }))
  const onlineEmbeddingStatusText = currentOnlineEmbeddingConfigId
    ? `当前配置：${onlineEmbeddingConfigs.find(item => item.id === currentOnlineEmbeddingConfigId)?.name || onlineEmbeddingName || '未命名'}`
    : '尚未保存在线向量配置'
  const timeRangeOptions = [
    { value: 1, label: '最近 1 天' },
    { value: 3, label: '最近 3 天' },
    { value: 7, label: '最近 7 天' },
    { value: 30, label: '最近 30 天' },
    { value: 60, label: '最近 60 天' },
    { value: 90, label: '最近 90 天' },
    { value: 180, label: '最近 180 天' },
    { value: 365, label: '最近 1 年' },
    { value: 0, label: '全部消息' }
  ]
  const systemPromptPresetOptions = [
    { value: 'default', label: '通用平衡（默认）' },
    { value: 'decision-focus', label: '决策优先（重点提炼结论）' },
    { value: 'action-focus', label: '行动优先（重点提炼待办）' },
    { value: 'risk-focus', label: '风险优先（重点识别阻塞与风险）' },
    { value: 'custom', label: '自定义系统提示词' }
  ]

  return (
    <div className="tab-content ai-summary-settings">
      {/* 配置预设管理 */}
      <h3 className="section-title">
        AI 配置管理
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="manage-presets-btn" onClick={handleStartNewPreset}>
            <Plus size={14} />
            新增配置
          </button>
          <button className="manage-presets-btn" onClick={() => setShowPresetDrawer(true)}>
            <Settings2 size={14} />
            管理预设 {presets.length > 0 && `(${presets.length})`}
          </button>
        </div>
      </h3>

      {/* 当前配置信息卡片 */}
      <div className="current-config-card">
        <div className="config-provider-info">
          {currentProvider?.logo ? (
            <AIProviderLogo
              providerId={currentProvider.id}
              logo={currentProvider.logo}
              alt={currentProvider.displayName}
              className="provider-logo-large"
              size={40}
            />
          ) : (
            <div className="provider-logo-skeleton-large" />
          )}
          <div className="config-text-info">
            <div className="config-provider-name">{currentProvider?.displayName}</div>
            {currentPresetName && <div className="config-preset-name">预设：{currentPresetName}</div>}
          </div>
        </div>
      </div>

      <div className="settings-form">
        <div className="form-group">
          <label>API 密钥</label>

          <div className="input-with-actions">
            <input
              type={showApiKey ? 'text' : 'password'}
              placeholder={
                provider === 'ollama'
                  ? '本地服务无需密钥（可选）'
                  : provider === 'custom'
                    ? '请输入自定义服务的 API 密钥'
                    : `请输入 ${currentProvider?.displayName} API 密钥`
              }
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="api-key-input"
            />
            <button
              type="button"
              className="input-action-btn"
              onClick={() => setShowApiKey(!showApiKey)}
              title={showApiKey ? '隐藏' : '显示'}
            >
              {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
            <button
              type="button"
              className="input-action-btn primary"
              onClick={handleTestConnection}
              disabled={isTesting || (provider !== 'ollama' && !apiKey) || (provider === 'custom' && !baseURL)}
              title="测试连接"
            >
              {isTesting ? <Sparkles size={16} className="spin" /> : <Sparkles size={16} />}
            </button>
          </div>
        </div>

        {/* Ollama 专用：baseURL 配置 */}
        {provider === 'ollama' && (
          <div className="form-group">
            <label className="label-with-help">
              <span>服务地址</span>
              <button
                type="button"
                className="help-icon-btn"
                onClick={handleOpenOllamaHelp}
                title="查看 Ollama 使用指南"
              >
                <HelpCircle size={16} />
              </button>
            </label>
            <input
              type="text"
              placeholder="http://localhost:11434/v1"
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              className="api-key-input"
            />
            <div className="form-hint">
              Ollama 默认运行在 http://localhost:11434，如果修改了端口或使用远程服务，请在此配置
            </div>
          </div>
        )}

        {/* Custom 专用：baseURL 配置 */}
        {provider === 'custom' && (
          <div className="form-group">
            <label className="label-with-help">
              <span>服务地址 *</span>
              <button
                type="button"
                className="help-icon-btn"
                onClick={handleOpenCustomHelp}
                title="查看自定义服务使用指南"
              >
                <HelpCircle size={16} />
              </button>
            </label>
            <input
              type="text"
              placeholder="https://api.example.com/v1"
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              className="api-key-input"
              required
            />
            <div className="form-hint">
              请输入 OpenAI 兼容的 API 地址（需包含 /v1），例如：OneAPI、API2D、自建中转等
            </div>
          </div>
        )}

        <div className="form-row">
          <div className="form-group">
            <label>选择模型 (支持手动输入)</label>
            <CustomSelect
              value={model}
              onChange={setModel}
              options={modelOptions}
              placeholder="请选择或输入模型名称"
              editable={true}
            />
          </div>

          <div className="form-group">
            <label>默认分析范围</label>
            <CustomSelect
              value={defaultTimeRange}
              onChange={setDefaultTimeRange}
              options={timeRangeOptions}
            />
          </div>
        </div>

        {/* 思考模式开关 */}
        <div className="form-group">
          <label className="toggle-label">
            <div className="toggle-header">
              <span className="toggle-title">启用思考模式</span>
              <span className="toggle-switch">
                <input
                  type="checkbox"
                  checked={enableThinking}
                  onChange={(e) => setEnableThinking(e.target.checked)}
                />
                <span className="toggle-slider"></span>
              </span>
            </div>
          </label>
          <div className="toggle-description">
            <p>控制 AI 的推理深度（部分模型无法完全关闭推理功能，仍会显示思考过程）</p>
          </div>
        </div>

        {/* 消息条数限制 */}
        <div className="form-group">
          <label className="label-with-value">
            <span>摘要提取上限 (条)</span>
            <span className="value-display">{messageLimit} 条</span>
          </label>
          <div className="slider-container">
            <input
              type="range"
              min="1000"
              max="5000"
              step="100"
              value={messageLimit}
              onChange={(e) => setMessageLimit(Number(e.target.value))}
              className="range-input"
            />
          </div>
          <div className="form-hint">
            设置 AI 分析时获取的最大消息数量（1000-5000）。数量越多，分析越全面，但可能增加 Token 消耗。
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Agent 决策 Token 上限</label>
            <input
              type="number"
              min="512"
              max="32768"
              step="512"
              value={agentDecisionMaxTokens}
              onChange={(e) => setAgentDecisionMaxTokens(Math.max(512, Math.min(32768, Number(e.target.value) || 2048)))}
              className="api-key-input"
            />
            <div className="form-hint">
              控制每轮工具编排 JSON 的输出空间，默认 2048。一般不需要很高。
            </div>
          </div>

          <div className="form-group">
            <label>问答输出 Token 上限</label>
            <input
              type="number"
              min="512"
              max="65536"
              step="1024"
              value={agentAnswerMaxTokens}
              onChange={(e) => setAgentAnswerMaxTokens(Math.max(512, Math.min(65536, Number(e.target.value) || 8192)))}
              className="api-key-input"
            />
            <div className="form-hint">
              控制会话问答最终答案长度，默认 8192。长上下文模型可按需调高。
            </div>
          </div>
        </div>
      </div>

      <h3 className="section-title">语义检索</h3>
      <p className="section-desc">
        使用本地模型或在线 Embedding 服务生成真实语义向量，用于问 AI 检索聊天记录。在线模式会把待向量化文本发送到所选服务商。
      </p>

      <h4 className="subsection-title semantic-vector-subtitle">向量计算模式</h4>
      <div className="model-type-grid semantic-device-grid">
        <label className={`model-card ${embeddingMode === 'local' && embeddingDevice === 'cpu' ? 'active' : ''} ${isDownloadingEmbedding ? 'disabled' : ''}`}>
          <input
            type="radio"
            name="aiEmbeddingDevice"
            value="cpu"
            checked={embeddingMode === 'local' && embeddingDevice === 'cpu'}
            onChange={() => handleEmbeddingDeviceChange('cpu')}
            disabled={isDownloadingEmbedding}
          />
          <div className="model-icon"><Cpu size={24} /></div>
          <div className="model-info">
            <div className="model-header">
              <span className="model-name">CPU</span>
              <span className="model-size">稳定</span>
            </div>
            <span className="model-desc">默认模式，兼容性最好，适合后台稳定索引。</span>
          </div>
          {embeddingMode === 'local' && embeddingDevice === 'cpu' && <div className="model-check"><Check size={14} /></div>}
        </label>

        <label className={`model-card ${embeddingMode === 'local' && embeddingDevice === 'dml' ? 'active' : ''} ${isDownloadingEmbedding ? 'disabled' : ''}`}>
          <input
            type="radio"
            name="aiEmbeddingDevice"
            value="dml"
            checked={embeddingMode === 'local' && embeddingDevice === 'dml'}
            onChange={() => handleEmbeddingDeviceChange('dml')}
            disabled={isDownloadingEmbedding}
          />
          <div className="model-icon"><Zap size={24} /></div>
          <div className="model-info">
            <div className="model-header">
              <span className="model-name">GPU DirectML</span>
              <span className="model-size">实验</span>
            </div>
            <span className="model-desc">Windows GPU 加速，失败时自动回退 CPU。</span>
          </div>
          {embeddingMode === 'local' && embeddingDevice === 'dml' && <div className="model-check"><Check size={14} /></div>}
        </label>

        <label className={`model-card ${embeddingMode === 'online' ? 'active' : ''} ${isDownloadingEmbedding ? 'disabled' : ''}`}>
          <input
            type="radio"
            name="aiEmbeddingDevice"
            value="online"
            checked={embeddingMode === 'online'}
            onChange={() => handleEmbeddingModeChange('online')}
            disabled={isDownloadingEmbedding}
          />
          <div className="model-icon"><Cloud size={24} /></div>
          <div className="model-info">
            <div className="model-header">
              <span className="model-name">在线</span>
              <span className="model-size">多厂商</span>
            </div>
            <span className="model-desc">使用阿里云百炼、硅基流动或火山引擎在线向量服务。</span>
          </div>
          {embeddingMode === 'online' && <div className="model-check"><Check size={14} /></div>}
        </label>
      </div>

      {embeddingMode === 'local' && embeddingDeviceStatus && (
        <div className="semantic-device-status">
          <div className={`status-indicator ${embeddingDeviceStatus.effectiveDevice === 'dml' ? 'ready' : 'missing'}`}>
            {embeddingDeviceStatus.effectiveDevice === 'dml' ? <CheckCircle size={18} /> : <AlertCircle size={18} />}
            <span>当前计算: {embeddingDeviceStatus.provider}</span>
          </div>
          <p>{embeddingDeviceStatus.info}</p>
        </div>
      )}

      {embeddingMode === 'local' && (
        <>
          <h4 className="subsection-title semantic-vector-subtitle">语义模型版本</h4>
          <div className="model-type-grid semantic-model-grid">
            {embeddingProfiles.map(profile => (
              <label
                key={profile.id}
                className={`model-card ${embeddingProfileId === profile.id ? 'active' : ''} ${isDownloadingEmbedding || !profile.enabled ? 'disabled' : ''}`}
              >
                <input
                  type="radio"
                  name="aiEmbeddingModelProfile"
                  value={profile.id}
                  checked={embeddingProfileId === profile.id}
                  onChange={() => handleEmbeddingProfileChange(profile.id)}
                  disabled={isDownloadingEmbedding || !profile.enabled}
                />
                <div className="model-icon">
                  {profile.dtype === 'q8' ? <Zap size={24} /> : <Layers size={24} />}
                </div>
                <div className="model-info">
                  <div className="model-header">
                    <span className="model-name">{profile.displayName}</span>
                    <span className="model-size">{profile.sizeLabel}</span>
                  </div>
                  <div className="semantic-model-meta">
                    <span>{profile.dim} 维</span>
                    <span>{profile.dtype.toUpperCase()}</span>
                    <span>{profile.performanceLabel}</span>
                  </div>
                  <span className="model-desc">{profile.enabled ? profile.description : '即将支持'}</span>
                </div>
                {embeddingProfileId === profile.id && <div className="model-check"><Check size={14} /></div>}
              </label>
            ))}
          </div>

          {embeddingProfile && embeddingDimOptions.length > 1 && (
            <div className="form-group semantic-vector-dim">
              <label>向量维度</label>
              <CustomSelect
                value={embeddingProfile.dim}
                onChange={handleEmbeddingDimChange}
                options={embeddingDimOptions}
              />
              <div className="form-hint">
                低维度会减少索引体积和计算开销；切换后当前语义索引会在下次向量化时按新维度重建。
              </div>
            </div>
          )}
        </>
      )}

      {embeddingMode === 'online' && (
        <div className="semantic-online-config">
          <div className="semantic-online-header">
            <div>
              <h4 className="subsection-title semantic-vector-subtitle">在线向量配置</h4>
              <p>{onlineEmbeddingStatusText}</p>
            </div>
            {onlineEmbeddingConfigs.length > 0 && (
              <CustomSelect
                value={currentOnlineEmbeddingConfigId}
                onChange={handleOnlineConfigSelect}
                options={onlineEmbeddingConfigOptions}
                placeholder="选择已保存配置"
              />
            )}
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>配置名称</label>
              <input
                className="api-key-input"
                value={onlineEmbeddingName}
                onChange={(event) => setOnlineEmbeddingName(event.target.value)}
                placeholder="例如：百炼 text-embedding-v4"
              />
            </div>
            <div className="form-group">
              <label>厂商</label>
              <CustomSelect
                value={onlineEmbeddingProviderId}
                onChange={handleOnlineProviderChange}
                options={onlineEmbeddingProviderOptions}
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>模型</label>
              <CustomSelect
                value={onlineEmbeddingModel}
                onChange={handleOnlineModelChange}
                options={onlineEmbeddingModelOptions}
                editable={Boolean(onlineEmbeddingProvider?.allowCustomModel)}
                placeholder="输入模型名或端点 ID"
              />
            </div>
            <div className="form-group">
              <label>向量维度</label>
              <CustomSelect
                value={onlineEmbeddingDim}
                onChange={(value) => setOnlineEmbeddingDim(Number(value))}
                options={onlineEmbeddingDimOptions}
              />
            </div>
          </div>

          <div className="form-group">
            <label>服务地址</label>
            <input
              className="api-key-input"
              value={onlineEmbeddingBaseURL}
              onChange={(event) => {
                setOnlineEmbeddingBaseURL(event.target.value)
                setCurrentOnlineEmbeddingConfigId('')
              }}
              placeholder={onlineEmbeddingProvider?.defaultBaseURL || 'https://.../v1'}
            />
          </div>

          <div className="form-group">
            <label>API Key</label>
            <div className="input-with-actions">
              <input
                type={showOnlineEmbeddingApiKey ? 'text' : 'password'}
                className="api-key-input"
                value={onlineEmbeddingApiKey}
                onChange={(event) => {
                  setOnlineEmbeddingApiKey(event.target.value)
                  setCurrentOnlineEmbeddingConfigId('')
                }}
                placeholder={`请输入 ${onlineEmbeddingProvider?.displayName || '在线向量'} API Key`}
              />
              <button
                type="button"
                className="input-action-btn"
                onClick={() => setShowOnlineEmbeddingApiKey(!showOnlineEmbeddingApiKey)}
                title={showOnlineEmbeddingApiKey ? '隐藏密钥' : '显示密钥'}
              >
                {showOnlineEmbeddingApiKey ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            <div className="form-hint">
              保存配置前会调用一次 embeddings 接口确认模型和维度可用。
            </div>
          </div>

          <div className="btn-row semantic-vector-actions">
            <button
              className="btn btn-secondary"
              onClick={handleTestOnlineEmbeddingConfig}
              disabled={isTestingOnlineEmbedding || !onlineEmbeddingApiKey || !onlineEmbeddingModel || !onlineEmbeddingBaseURL}
            >
              {isTestingOnlineEmbedding ? <Sparkles size={16} className="spin" /> : <Sparkles size={16} />} 测试配置
            </button>
            <button
              className="btn btn-primary"
              onClick={handleSaveOnlineEmbeddingConfig}
              disabled={isSavingOnlineEmbedding || isTestingOnlineEmbedding}
            >
              <Save size={16} /> {isSavingOnlineEmbedding ? '保存中...' : '保存并启用'}
            </button>
            {currentOnlineEmbeddingConfigId && (
              <button
                className="btn btn-danger"
                onClick={handleDeleteOnlineEmbeddingConfig}
                disabled={isDeletingOnlineEmbedding}
              >
                <Trash2 size={16} /> 删除配置
              </button>
            )}
          </div>
        </div>
      )}

      <div className="semantic-vector-overview">
        <div className="semantic-vector-stat">
          <span className="stat-label">{embeddingMode === 'online' ? '当前厂商' : '模型体积'}</span>
          <strong>{embeddingMode === 'online' ? (onlineEmbeddingProvider?.displayName || '未配置') : embeddingVolumeLabel}</strong>
        </div>
        <div className="semantic-vector-stat">
          <span className="stat-label">{embeddingMode === 'online' ? '当前模型' : '当前设备'}</span>
          <strong>{embeddingMode === 'online' ? (onlineEmbeddingModel || '未配置') : embeddingDeviceLabel}</strong>
        </div>
        <div className={`semantic-vector-stat performance-${embeddingPerformanceClass}`}>
          <span className="stat-label">{embeddingMode === 'online' ? '向量维度' : '性能档位'}</span>
          <strong>{embeddingMode === 'online' ? `${onlineEmbeddingDim || 0} 维` : embeddingPerformanceLabel}</strong>
        </div>
      </div>

      {embeddingMode === 'local' && (
        <div className="stt-model-status semantic-vector-model-status">
        {embeddingStatus ? (
          <div className="model-info">
            <div className={`status-indicator ${embeddingStatus.exists ? 'ready' : 'missing'}`}>
              {embeddingStatus.exists ? (
                <>
                  <CheckCircle size={20} />
                  <span>语义模型已就绪</span>
                </>
              ) : (
                <>
                  <AlertCircle size={20} />
                  <span>语义模型未下载</span>
                </>
              )}
            </div>
            <p className="model-size">
              模型大小: {formatBytes(embeddingStatus.sizeBytes)}
              <span> · {embeddingStatus.dim || embeddingProfile?.dim || 1024} 维</span>
            </p>
            <p className="model-size">索引模型: {embeddingStatus.vectorModelId || embeddingProfile?.id}</p>
            <p className="model-path">模型目录: {embeddingStatus.modelDir}</p>
          </div>
        ) : (
          <p>正在检查模型状态...</p>
        )}
        </div>
      )}

      {embeddingMode === 'local' && isDownloadingEmbedding && (
        <div className="download-progress semantic-download-progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${Math.max(3, Math.min(100, embeddingProgressPercent))}%` }} />
          </div>
          <span className="progress-text">
            {embeddingProgress?.percent !== undefined
              ? `${embeddingProgress.percent.toFixed(1)}%`
              : (embeddingProgress?.remoteHost ? `连接 ${embeddingProgress.remoteHost}` : '准备中')}
          </span>
        </div>
      )}

      <div className="btn-row semantic-vector-actions">
        {embeddingMode === 'local' && !embeddingStatus?.exists && (
          <button
            className="btn btn-primary"
            onClick={handleDownloadEmbeddingModel}
            disabled={isDownloadingEmbedding || embeddingProfile?.enabled === false}
          >
            <Download size={16} /> {isDownloadingEmbedding ? '下载中...' : '下载模型'}
          </button>
        )}
        {embeddingMode === 'local' && embeddingStatus?.exists && (
          <button
            className="btn btn-danger"
            onClick={async () => {
              const modelSize = embeddingStatus.sizeLabel || embeddingProfile?.sizeLabel || '约 100 MB'
              if (confirm(`确定要清除语义向量模型吗？下次使用需要重新下载 (${modelSize})。`)) {
                await handleClearEmbeddingModel()
              }
            }}
            disabled={isClearingEmbedding}
          >
            <Trash2 size={16} /> 清除模型
          </button>
        )}
        {embeddingMode === 'local' && (
          <button
          className="btn btn-secondary"
          onClick={() => loadEmbeddingStatus(embeddingProfileId)}
          disabled={isDownloadingEmbedding}
        >
          <RefreshCw size={16} className={isDownloadingEmbedding ? 'spin' : ''} /> 刷新状态
        </button>
        )}
        <button
          className="btn btn-secondary"
          onClick={handleClearSemanticIndex}
        >
          <Database size={16} /> 清理语义索引
        </button>
      </div>

      {/* 3. 摘要偏好 */}
      <h3 className="section-title">摘要详细程度</h3>
      <div className="detail-options">
        <div
          className={`detail-card ${summaryDetail === 'simple' ? 'active' : ''}`}
          onClick={() => setSummaryDetail('simple')}
        >
          <div className="detail-icon"><Zap size={24} /></div>
          <div className="detail-content">
            <span className="detail-title">简洁</span>
            <span className="detail-desc">快速概览</span>
          </div>
        </div>

        <div
          className={`detail-card ${summaryDetail === 'normal' ? 'active' : ''}`}
          onClick={() => setSummaryDetail('normal')}
        >
          <div className="detail-icon"><Star size={24} /></div>
          <div className="detail-content">
            <span className="detail-title">标准</span>
            <span className="detail-desc">推荐使用</span>
          </div>
        </div>

        <div
          className={`detail-card ${summaryDetail === 'detailed' ? 'active' : ''}`}
          onClick={() => setSummaryDetail('detailed')}
        >
          <div className="detail-icon"><FileText size={24} /></div>
          <div className="detail-content">
            <span className="detail-title">详细</span>
            <span className="detail-desc">完整分析</span>
          </div>
        </div>
      </div>

      <h3 className="section-title">系统提示词风格</h3>
      <div className="settings-form" style={{ marginTop: '8px' }}>
        <div className="form-group">
          <label>提示词模板</label>
          <CustomSelect
            value={systemPromptPreset}
            onChange={setSystemPromptPreset}
            options={systemPromptPresetOptions}
          />
          <div className="form-hint">
            选择摘要的分析侧重。若选“自定义系统提示词”，将使用你编写的提示词作为额外系统指令。
          </div>
        </div>

        {systemPromptPreset === 'custom' && (
          <div className="form-group">
            <label>自定义系统提示词</label>
            <textarea
              className="custom-system-prompt-textarea"
              placeholder="例如：你是一名项目经理助手。请优先输出任务清单，按负责人和截止时间分组。"
              value={customSystemPrompt}
              onChange={(e) => setCustomSystemPrompt(e.target.value)}
              rows={8}
            />
            <div className="form-hint">
              建议描述：角色、输出结构、重点关注项、禁止项。留空则回退默认规则。
            </div>
          </div>
        )}
      </div>

      {/* 4. 使用统计 */}
      {usageStats && (
        <>
          <h3 className="section-title">使用统计</h3>
          <div className="usage-stats">
            <div className="stat-card">
              <div className="stat-label">总摘要次数</div>
              <div className="stat-value">{usageStats.totalCount || 0}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">总消耗 Tokens</div>
              <div className="stat-value">{(usageStats.totalTokens || 0).toLocaleString()}</div>
            </div>
          </div>
        </>
      )}

      <div className="info-box-simple">
        <p>💡 提示：API 密钥存储在本地，不会上传到任何服务器。摘要内容仅用于本地展示。</p>
      </div>

      {/* Ollama 使用指南弹窗 */}
      {showOllamaHelp && (
        <div className="ollama-help-modal" onClick={() => setShowOllamaHelp(false)}>
          <div className="ollama-help-content" onClick={(e) => e.stopPropagation()}>
            <div className="ollama-help-header">
              <h2>Ollama 本地 AI 使用指南</h2>
              <button className="close-btn" onClick={() => setShowOllamaHelp(false)}>
                <X size={20} />
              </button>
            </div>
            <div
              className="ollama-help-body markdown-content"
              dangerouslySetInnerHTML={{ __html: ollamaGuideContent || '<p>加载中...</p>' }}
            />
          </div>
        </div>
      )}

      {/* 自定义服务使用指南弹窗 */}
      {showCustomHelp && (
        <div className="ollama-help-modal" onClick={() => setShowCustomHelp(false)}>
          <div className="ollama-help-content" onClick={(e) => e.stopPropagation()}>
            <div className="ollama-help-header">
              <h2>自定义 AI 服务使用指南</h2>
              <button className="close-btn" onClick={() => setShowCustomHelp(false)}>
                <X size={20} />
              </button>
            </div>
            <div
              className="ollama-help-body markdown-content"
              dangerouslySetInnerHTML={{ __html: customGuideContent || '<p>加载中...</p>' }}
            />
          </div>
        </div>
      )}

      {/* 新增配置预设对话框 */}
      {showSavePresetDialog && (
        <div className="ollama-help-modal" onClick={() => setShowSavePresetDialog(false)}>
          <div className="ollama-help-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '500px' }}>
            <div className="ollama-help-header">
              <h2>新增配置预设</h2>
              <button className="close-btn" onClick={() => setShowSavePresetDialog(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="ollama-help-body">
              {/* 步骤 1: 选择提供商 */}
              {newPresetStep === 'provider' && (
                <>
                  <div className="form-hint" style={{ marginBottom: '12px' }}>选择 AI 服务商</div>
                  <div className="provider-selector-capsule" style={{ marginBottom: '16px' }}>
                    {providers.map(p => (
                      <div
                        key={p.id}
                        className={`provider-capsule ${newPresetProvider === p.id ? 'active' : ''}`}
                        onClick={() => handleSelectProvider(p.id)}
                      >
                        {p.logo ? (
                          <AIProviderLogo
                            providerId={p.id}
                            logo={p.logo}
                            alt={p.displayName}
                            className="provider-logo"
                            size={18}
                          />
                        ) : (
                          <div className="provider-logo-skeleton" />
                        )}
                        <span className="provider-name">{p.displayName}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* 步骤 2: 配置参数 */}
              {newPresetStep === 'config' && (
                <>
                  <div className="form-group">
                    <label>API 密钥</label>
                    <input
                      type="text"
                      placeholder={newPresetProvider === 'ollama' ? '本地服务无需密钥（可选）' : '请输入 API 密钥'}
                      value={newPresetApiKey}
                      onChange={(e) => setNewPresetApiKey(e.target.value)}
                      className="api-key-input"
                    />
                  </div>
                  {(newPresetProvider === 'ollama' || newPresetProvider === 'custom') && (
                    <div className="form-group">
                      <label>服务地址</label>
                      <input
                        type="text"
                        placeholder={newPresetProvider === 'ollama' ? 'http://localhost:11434/v1' : 'https://api.example.com/v1'}
                        value={newPresetBaseURL}
                        onChange={(e) => setNewPresetBaseURL(e.target.value)}
                        className="api-key-input"
                      />
                    </div>
                  )}
                  <div className="form-group">
                    <label>模型</label>
                    <CustomSelect
                      value={newPresetModel}
                      onChange={setNewPresetModel}
                      options={providers.find(p => p.id === newPresetProvider)?.models.map(m => ({ value: m, label: m })) || []}
                      editable={true}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' }}>
                    <button className="preset-btn" onClick={() => setNewPresetStep('provider')}>上一步</button>
                    <button className="preset-btn load" onClick={() => setNewPresetStep('name')}>下一步</button>
                  </div>
                </>
              )}

              {/* 步骤 3: 输入名称 */}
              {newPresetStep === 'name' && (
                <>
                  <div className="form-group">
                    <label>配置名称</label>
                    <input
                      type="text"
                      placeholder="例如：OneAPI GPT-4"
                      value={presetName}
                      onChange={(e) => setPresetName(e.target.value)}
                      className="api-key-input"
                      autoFocus
                    />
                  </div>
                  <div className="form-hint" style={{ marginBottom: '16px' }}>
                    {providers.find(p => p.id === newPresetProvider)?.displayName} · {newPresetModel}
                  </div>
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                    <button className="preset-btn" onClick={() => setNewPresetStep('config')}>上一步</button>
                    <button className="preset-btn load" onClick={handleSavePreset}>保存</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 配置预设抽屉 */}
      {showPresetDrawer && (
        <>
          <div className="drawer-overlay" onClick={() => setShowPresetDrawer(false)} />
          <div className="preset-drawer">
            <div className="drawer-header">
              <h2>配置预设管理</h2>
              <button className="close-btn" onClick={() => setShowPresetDrawer(false)}>
                <X size={20} />
              </button>
            </div>
            <div className="drawer-body">
              {presets.length === 0 ? (
                <div className="empty-state">
                  <p>暂无配置预设</p>
                  <p className="empty-hint">点击外部「新增配置」按钮创建预设</p>
                </div>
              ) : (
                <div className="presets-list">
                  {presets.map(preset => (
                    <div key={preset.id} className="preset-item">
                      <div className="preset-info">
                        <span className="preset-name">{preset.name}</span>
                        <span className="preset-detail">{preset.provider} · {preset.model}</span>
                      </div>
                      <div className="preset-actions">
                        <button onClick={() => { handleLoadPreset(preset.id); setShowPresetDrawer(false); }} className="preset-btn load">加载</button>
                        <button onClick={() => handleEditPreset(preset)} className="preset-btn edit">编辑</button>
                        <button onClick={() => handleDeletePreset(preset.id)} className="preset-btn delete">删除</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default AISummarySettings
