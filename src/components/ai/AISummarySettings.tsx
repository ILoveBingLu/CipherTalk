import { useState, useEffect, useRef } from 'react'
import { Eye, EyeOff, Sparkles, Check, ChevronDown, ChevronUp, Zap, Star, FileText, HelpCircle, X, Plus, Settings2 } from 'lucide-react'
import { getAIProviders, type AIProviderInfo } from '../../types/ai'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
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
  mcpEnabled: boolean
  setMcpEnabled: (val: boolean) => void
  mcpExposeMediaPaths: boolean
  setMcpExposeMediaPaths: (val: boolean) => void
  showMessage: (text: string, success: boolean) => void
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
  mcpEnabled,
  setMcpEnabled,
  mcpExposeMediaPaths,
  setMcpExposeMediaPaths,
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

  useEffect(() => {
    // 加载提供商列表和统计数据
    loadProviders()
    loadUsageStats()
    loadAllProviderConfigs()
    loadPresets()
  }, [])

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
      setProviderConfigs(configs)
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
    setNewPresetModel(preset.model)
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
        model: newPresetModel,
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
        setModel(preset.model)
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
      await setAiProviderConfig(provider, { apiKey, model, baseURL: baseURL || undefined })
      setProviderConfigs(prev => ({
        ...prev,
        [provider]: { apiKey, model, baseURL: baseURL || undefined }
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
      setModel(savedConfig.model)
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
            <img src={currentProvider.logo} alt={currentProvider.displayName} className="provider-logo-large" />
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

      <h3 className="section-title">MCP Server</h3>
      <div className="settings-form" style={{ marginTop: '8px' }}>
        <div className="form-group">
          <label className="toggle-label">
            <div className="toggle-header">
              <span className="toggle-title">启用内嵌 MCP Server</span>
              <span className="toggle-switch">
                <input
                  type="checkbox"
                  checked={mcpEnabled}
                  onChange={(e) => setMcpEnabled(e.target.checked)}
                />
                <span className="toggle-slider"></span>
              </span>
            </div>
          </label>
          <div className="toggle-description">
            <p>为 Claude Desktop、Codex、Cherry Studio 等 MCP 宿主暴露 CipherTalk 数据读取能力。</p>
          </div>
        </div>

        <div className="form-group">
          <label className="toggle-label">
            <div className="toggle-header">
              <span className="toggle-title">默认暴露媒体本地路径</span>
              <span className="toggle-switch">
                <input
                  type="checkbox"
                  checked={mcpExposeMediaPaths}
                  onChange={(e) => setMcpExposeMediaPaths(e.target.checked)}
                />
                <span className="toggle-slider"></span>
              </span>
            </div>
          </label>
          <div className="toggle-description">
            <p>控制 MCP `get_messages` 默认是否解析并返回图片、视频、文件等本地路径。</p>
          </div>
        </div>

        <div className="form-group">
          <label>启动命令</label>
          <input className="api-key-input" type="text" value="npm run build:mcp && node scripts/mcp-runner.js" readOnly />
          <div className="form-hint">
            首批工具：`health_check`、`get_status`、`list_sessions`、`get_messages`、`list_contacts`
          </div>
        </div>
      </div>

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
                          <img src={p.logo} alt={p.displayName} className="provider-logo" />
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
