// 配置服务 - 封装 Electron Store
import { config } from './ipc'

// 配置键名
export const CONFIG_KEYS = {
  DECRYPT_KEY: 'decryptKey',
  DB_PATH: 'dbPath',
  MY_WXID: 'myWxid',
  THEME: 'theme',
  LAST_SESSION: 'lastSession',
  WINDOW_BOUNDS: 'windowBounds',
  IMAGE_XOR_KEY: 'imageXorKey',
  IMAGE_AES_KEY: 'imageAesKey',
  CACHE_PATH: 'cachePath',
  EXPORT_PATH: 'exportPath',
  AGREEMENT_VERSION: 'agreementVersion',
  STT_LANGUAGES: 'sttLanguages',
  STT_MODEL_TYPE: 'sttModelType',
  QUOTE_STYLE: 'quoteStyle',
  SKIP_INTEGRITY_CHECK: 'skipIntegrityCheck',
  EXPORT_DEFAULT_DATE_RANGE: 'exportDefaultDateRange',
  EXPORT_DEFAULT_AVATARS: 'exportDefaultAvatars',
  AUTO_UPDATE_DATABASE: 'autoUpdateDatabase',
  // 自动同步高级参数
  AUTO_UPDATE_CHECK_INTERVAL: 'autoUpdateCheckInterval',     // 检查间隔（秒）
  AUTO_UPDATE_MIN_INTERVAL: 'autoUpdateMinInterval',         // 最小更新间隔（毫秒）
  AUTO_UPDATE_DEBOUNCE_TIME: 'autoUpdateDebounceTime',       // 防抖时间（毫秒）
  HTTP_API_ENABLED: 'httpApiEnabled',
  HTTP_API_PORT: 'httpApiPort',
  HTTP_API_TOKEN: 'httpApiToken',
  MCP_ENABLED: 'mcpEnabled',
  MCP_EXPOSE_MEDIA_PATHS: 'mcpExposeMediaPaths',
  AUTH_ENABLED: 'authEnabled',
  AUTH_CREDENTIAL_ID: 'authCredentialId',
  AUTH_PASSWORD_HASH: 'authPasswordHash',
  AUTH_PASSWORD_SALT: 'authPasswordSalt',
  CLOSE_TO_TRAY: 'closeToTray'
} as const

// 当前协议版本 - 更新协议内容时递增此版本号
export const CURRENT_AGREEMENT_VERSION = 2

// ... existing code ...

// 获取是否自动更新数据库
export async function getAutoUpdateDatabase(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.AUTO_UPDATE_DATABASE)
  return value !== undefined ? (value as boolean) : true
}

// 设置是否自动更新数据库
export async function setAutoUpdateDatabase(enable: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.AUTO_UPDATE_DATABASE, enable)
}

// --- 自动同步高级参数 ---

// 获取检查间隔（秒），默认 60 秒
export async function getAutoUpdateCheckInterval(): Promise<number> {
  const value = await config.get(CONFIG_KEYS.AUTO_UPDATE_CHECK_INTERVAL)
  return (value as number) || 60
}

// 设置检查间隔（秒）
export async function setAutoUpdateCheckInterval(seconds: number): Promise<void> {
  await config.set(CONFIG_KEYS.AUTO_UPDATE_CHECK_INTERVAL, Math.max(10, Math.min(600, seconds)))
}

// 获取最小更新间隔（毫秒），默认 1000 毫秒
export async function getAutoUpdateMinInterval(): Promise<number> {
  const value = await config.get(CONFIG_KEYS.AUTO_UPDATE_MIN_INTERVAL)
  return (value as number) || 1000
}

// 设置最小更新间隔（毫秒）
export async function setAutoUpdateMinInterval(ms: number): Promise<void> {
  await config.set(CONFIG_KEYS.AUTO_UPDATE_MIN_INTERVAL, Math.max(500, Math.min(10000, ms)))
}

// 获取防抖时间（毫秒），默认 500 毫秒
export async function getAutoUpdateDebounceTime(): Promise<number> {
  const value = await config.get(CONFIG_KEYS.AUTO_UPDATE_DEBOUNCE_TIME)
  return (value as number) || 500
}

// 设置防抖时间（毫秒）
export async function setAutoUpdateDebounceTime(ms: number): Promise<void> {
  await config.set(CONFIG_KEYS.AUTO_UPDATE_DEBOUNCE_TIME, Math.max(100, Math.min(5000, ms)))
}

// --- HTTP API 配置 ---

// 获取是否启用 HTTP API
export async function getHttpApiEnabled(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.HTTP_API_ENABLED)
  return value !== undefined ? (value as boolean) : false
}

// 设置是否启用 HTTP API
export async function setHttpApiEnabled(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.HTTP_API_ENABLED, enabled)
}

// 获取 HTTP API 端口
export async function getHttpApiPort(): Promise<number> {
  const value = await config.get(CONFIG_KEYS.HTTP_API_PORT)
  return (value as number) || 5031
}

// 设置 HTTP API 端口
export async function setHttpApiPort(port: number): Promise<void> {
  const safePort = Number.isFinite(port) ? Math.max(1, Math.min(65535, Math.floor(port))) : 5031
  await config.set(CONFIG_KEYS.HTTP_API_PORT, safePort)
}

// 获取 HTTP API 访问令牌
export async function getHttpApiToken(): Promise<string> {
  const value = await config.get(CONFIG_KEYS.HTTP_API_TOKEN)
  return (value as string) || ''
}

// 设置 HTTP API 访问令牌
export async function setHttpApiToken(token: string): Promise<void> {
  await config.set(CONFIG_KEYS.HTTP_API_TOKEN, token.trim())
}



// --- AI 摘要配置 ---

// 获取解密密钥
export async function getDecryptKey(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.DECRYPT_KEY)
  return value as string | null
}

// 设置解密密钥
export async function setDecryptKey(key: string): Promise<void> {
  await config.set(CONFIG_KEYS.DECRYPT_KEY, key)
}

// 获取数据库路径
export async function getDbPath(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.DB_PATH)
  return value as string | null
}

// 设置数据库路径
export async function setDbPath(path: string): Promise<void> {
  await config.set(CONFIG_KEYS.DB_PATH, path)
}

// 获取当前用户 wxid
export async function getMyWxid(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.MY_WXID)
  return value as string | null
}

// 设置当前用户 wxid
export async function setMyWxid(wxid: string): Promise<void> {
  await config.set(CONFIG_KEYS.MY_WXID, wxid)
}

// 获取主题
export async function getTheme(): Promise<'light' | 'dark'> {
  const value = await config.get(CONFIG_KEYS.THEME)
  return (value as 'light' | 'dark') || 'light'
}

// 设置主题
export async function setTheme(theme: 'light' | 'dark'): Promise<void> {
  await config.set(CONFIG_KEYS.THEME, theme)
}

// 获取上次打开的会话
export async function getLastSession(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.LAST_SESSION)
  return value as string | null
}

// 设置上次打开的会话
export async function setLastSession(sessionId: string): Promise<void> {
  await config.set(CONFIG_KEYS.LAST_SESSION, sessionId)
}


// 获取图片 XOR 密钥
export async function getImageXorKey(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.IMAGE_XOR_KEY)
  return value as string | null
}

// 设置图片 XOR 密钥
export async function setImageXorKey(key: string): Promise<void> {
  await config.set(CONFIG_KEYS.IMAGE_XOR_KEY, key)
}

// 获取图片 AES 密钥
export async function getImageAesKey(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.IMAGE_AES_KEY)
  return value as string | null
}

// 设置图片 AES 密钥
export async function setImageAesKey(key: string): Promise<void> {
  await config.set(CONFIG_KEYS.IMAGE_AES_KEY, key)
}

// 获取缓存路径
export async function getCachePath(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.CACHE_PATH)
  return value as string | null
}

// 设置缓存路径
export async function setCachePath(path: string): Promise<void> {
  await config.set(CONFIG_KEYS.CACHE_PATH, path)
}


// 获取导出路径
export async function getExportPath(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.EXPORT_PATH)
  return value as string | null
}

// 设置导出路径
export async function setExportPath(path: string): Promise<void> {
  await config.set(CONFIG_KEYS.EXPORT_PATH, path)
}


// 获取 STT 支持语言
export async function getSttLanguages(): Promise<string[]> {
  const value = await config.get(CONFIG_KEYS.STT_LANGUAGES)
  return (value as string[]) || []
}

// 设置 STT 支持语言
export async function setSttLanguages(languages: string[]): Promise<void> {
  await config.set(CONFIG_KEYS.STT_LANGUAGES, languages)
}

// 获取 STT 模型类型
export async function getSttModelType(): Promise<'int8' | 'float32'> {
  const value = await config.get(CONFIG_KEYS.STT_MODEL_TYPE)
  return (value as 'int8' | 'float32') || 'int8'
}

// 设置 STT 模型类型
export async function setSttModelType(type: 'int8' | 'float32'): Promise<void> {
  await config.set(CONFIG_KEYS.STT_MODEL_TYPE, type)
}


// 获取用户同意的协议版本
export async function getAgreementVersion(): Promise<number> {
  const value = await config.get(CONFIG_KEYS.AGREEMENT_VERSION)
  return (value as number) || 0
}

// 设置用户同意的协议版本
export async function setAgreementVersion(version: number): Promise<void> {
  await config.set(CONFIG_KEYS.AGREEMENT_VERSION, version)
}

// 检查是否需要显示协议（版本不匹配时需要重新同意）
export async function needShowAgreement(): Promise<boolean> {
  const agreedVersion = await getAgreementVersion()
  return agreedVersion < CURRENT_AGREEMENT_VERSION
}

// 标记用户已同意当前版本协议
export async function acceptCurrentAgreement(): Promise<void> {
  await setAgreementVersion(CURRENT_AGREEMENT_VERSION)
}

// 获取引用样式
export async function getQuoteStyle(): Promise<'default' | 'wechat'> {
  const value = await config.get(CONFIG_KEYS.QUOTE_STYLE)
  return (value as 'default' | 'wechat') || 'default'
}

// 设置引用样式
export async function setQuoteStyle(style: 'default' | 'wechat'): Promise<void> {
  await config.set(CONFIG_KEYS.QUOTE_STYLE, style)
}

// 获取是否跳过完整性检查
export async function getSkipIntegrityCheck(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.SKIP_INTEGRITY_CHECK)
  return (value as boolean) || false
}

// 设置是否跳过完整性检查
export async function setSkipIntegrityCheck(skip: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.SKIP_INTEGRITY_CHECK, skip)
}

// 获取导出默认日期范围（天数，0表示不限制）
export async function getExportDefaultDateRange(): Promise<number> {
  const value = await config.get(CONFIG_KEYS.EXPORT_DEFAULT_DATE_RANGE)
  return (value as number) || 0
}

// 设置导出默认日期范围（天数，0表示不限制）
export async function setExportDefaultDateRange(days: number): Promise<void> {
  await config.set(CONFIG_KEYS.EXPORT_DEFAULT_DATE_RANGE, days)
}

// 获取导出默认是否包含头像
export async function getExportDefaultAvatars(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.EXPORT_DEFAULT_AVATARS)
  return value !== undefined ? (value as boolean) : true
}

// 设置导出默认是否包含头像
export async function setExportDefaultAvatars(exportAvatars: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.EXPORT_DEFAULT_AVATARS, exportAvatars)
}


// --- 安全认证配置 ---

// 获取是否启用 Windows Hello 认证
export async function getAuthEnabled(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.AUTH_ENABLED)
  return (value as boolean) || false
}

// 设置是否启用 Windows Hello 认证
export async function setAuthEnabled(enable: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.AUTH_ENABLED, enable)
}

// 获取认证凭证 ID
export async function getAuthCredentialId(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.AUTH_CREDENTIAL_ID)
  return (value as string) || null
}

// 设置认证凭证 ID
export async function setAuthCredentialId(id: string | null): Promise<void> {
  await config.set(CONFIG_KEYS.AUTH_CREDENTIAL_ID, id)
}

// 获取密码哈希
export async function getAuthPasswordHash(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.AUTH_PASSWORD_HASH)
  return (value as string) || null
}

// 设置密码哈希
export async function setAuthPasswordHash(hash: string | null): Promise<void> {
  await config.set(CONFIG_KEYS.AUTH_PASSWORD_HASH, hash)
}

// 获取密码盐值
export async function getAuthPasswordSalt(): Promise<string | null> {
  const value = await config.get(CONFIG_KEYS.AUTH_PASSWORD_SALT)
  return (value as string) || null
}

// 设置密码盐值
export async function setAuthPasswordSalt(salt: string | null): Promise<void> {
  await config.set(CONFIG_KEYS.AUTH_PASSWORD_SALT, salt)
}


// --- AI 摘要配置 ---

// 获取当前选中的 AI 提供商
export async function getAiProvider(): Promise<string> {
  const value = await config.get('aiCurrentProvider')
  return (value as string) || 'zhipu'
}

// 设置当前选中的 AI 提供商
export async function setAiProvider(provider: string): Promise<void> {
  await config.set('aiCurrentProvider', provider)
}

// 获取指定提供商的配置
export async function getAiProviderConfig(providerId: string): Promise<{ apiKey: string; model: string; baseURL?: string } | null> {
  const configs = await config.get('aiProviderConfigs')
  const allConfigs = (configs as any) || {}
  const providerConfig = allConfigs[providerId]
  if (!providerConfig) return null

  // 兼容旧字段 baseUrl
  if (!providerConfig.baseURL && providerConfig.baseUrl) {
    providerConfig.baseURL = providerConfig.baseUrl
  }

  return providerConfig
}

// 设置指定提供商的配置
export async function setAiProviderConfig(providerId: string, providerConfig: { apiKey: string; model: string; baseURL?: string }): Promise<void> {
  const configs = await config.get('aiProviderConfigs')
  const allConfigs = (configs as any) || {}
  allConfigs[providerId] = providerConfig
  await config.set('aiProviderConfigs', allConfigs)
}

// 获取所有提供商的配置
export async function getAllAiProviderConfigs(): Promise<{ [providerId: string]: { apiKey: string; model: string; baseURL?: string } }> {
  const value = await config.get('aiProviderConfigs')
  return (value as any) || {}
}

// 获取当前提供商的 API Key（兼容旧代码）
export async function getAiApiKey(): Promise<string> {
  const currentProvider = await getAiProvider()
  const config = await getAiProviderConfig(currentProvider)
  return config?.apiKey || ''
}

// 设置当前提供商的 API Key（兼容旧代码）
export async function setAiApiKey(key: string): Promise<void> {
  const currentProvider = await getAiProvider()
  const existingConfig = await getAiProviderConfig(currentProvider)
  await setAiProviderConfig(currentProvider, {
    apiKey: key,
    model: existingConfig?.model || '',
    baseURL: existingConfig?.baseURL
  })
}

// 获取当前提供商的模型（兼容旧代码）
export async function getAiModel(): Promise<string> {
  const currentProvider = await getAiProvider()
  const config = await getAiProviderConfig(currentProvider)
  return config?.model || ''
}

// 设置当前提供商的模型（兼容旧代码）
export async function setAiModel(model: string): Promise<void> {
  const currentProvider = await getAiProvider()
  const existingConfig = await getAiProviderConfig(currentProvider)
  await setAiProviderConfig(currentProvider, {
    apiKey: existingConfig?.apiKey || '',
    model: model,
    baseURL: existingConfig?.baseURL
  })
}

// 获取 AI 默认时间范围
export async function getAiDefaultTimeRange(): Promise<number> {
  const value = await config.get('aiDefaultTimeRange')
  return (value as number) || 7
}

// 设置 AI 默认时间范围
export async function setAiDefaultTimeRange(days: number): Promise<void> {
  await config.set('aiDefaultTimeRange', days)
}

// 获取 AI 摘要详细程度
export async function getAiSummaryDetail(): Promise<'simple' | 'normal' | 'detailed'> {
  const value = await config.get('aiSummaryDetail')
  return (value as 'simple' | 'normal' | 'detailed') || 'normal'
}

// 设置 AI 摘要详细程度
export async function setAiSummaryDetail(detail: 'simple' | 'normal' | 'detailed'): Promise<void> {
  await config.set('aiSummaryDetail', detail)
}

// 获取系统提示词模板
export async function getAiSystemPromptPreset(): Promise<'default' | 'decision-focus' | 'action-focus' | 'risk-focus' | 'custom'> {
  const value = await config.get('aiSystemPromptPreset')
  return (value as 'default' | 'decision-focus' | 'action-focus' | 'risk-focus' | 'custom') || 'default'
}

// 设置系统提示词模板
export async function setAiSystemPromptPreset(preset: 'default' | 'decision-focus' | 'action-focus' | 'risk-focus' | 'custom'): Promise<void> {
  await config.set('aiSystemPromptPreset', preset)
}

// 获取自定义系统提示词
export async function getAiCustomSystemPrompt(): Promise<string> {
  const value = await config.get('aiCustomSystemPrompt')
  return (value as string) || ''
}

// 设置自定义系统提示词
export async function setAiCustomSystemPrompt(prompt: string): Promise<void> {
  await config.set('aiCustomSystemPrompt', prompt || '')
}

// 获取是否启用思考模式
export async function getAiEnableThinking(): Promise<boolean> {
  const value = await config.get('aiEnableThinking')
  return value !== undefined ? (value as boolean) : true
}

// 设置是否启用思考模式
export async function setAiEnableThinking(enable: boolean): Promise<void> {
  await config.set('aiEnableThinking', enable)
}

// 获取摘要提取消息条数限制
export async function getAiMessageLimit(): Promise<number> {
  const value = await config.get('aiMessageLimit')
  return (value as number) || 3000
}

// 设置摘要提取消息条数限制
export async function setAiMessageLimit(limit: number): Promise<void> {
  await config.set('aiMessageLimit', limit)
}

// --- MCP 配置 ---

export async function getMcpEnabled(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.MCP_ENABLED)
  return value !== undefined ? (value as boolean) : false
}

export async function setMcpEnabled(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.MCP_ENABLED, enabled)
}

export async function getMcpExposeMediaPaths(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.MCP_EXPOSE_MEDIA_PATHS)
  return value !== undefined ? (value as boolean) : true
}

export async function setMcpExposeMediaPaths(enabled: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.MCP_EXPOSE_MEDIA_PATHS, enabled)
}

// --- AI 配置预设 ---

export interface AiConfigPreset {
  id: string
  name: string
  provider: string
  apiKey: string
  model: string
  baseURL?: string
}

// 获取所有配置预设
export async function getAiConfigPresets(): Promise<AiConfigPreset[]> {
  const value = await config.get('aiConfigPresets')
  return (value as AiConfigPreset[]) || []
}

// 保存配置预设
export async function saveAiConfigPreset(preset: Omit<AiConfigPreset, 'id'>): Promise<string> {
  const presets = await getAiConfigPresets()
  const id = `preset-${Date.now()}`
  const newPreset = { ...preset, id }
  presets.push(newPreset)
  await config.set('aiConfigPresets', presets)
  return id
}

// 删除配置预设
export async function deleteAiConfigPreset(id: string): Promise<void> {
  const presets = await getAiConfigPresets()
  const filtered = presets.filter(p => p.id !== id)
  await config.set('aiConfigPresets', filtered)
}

// 更新配置预设
export async function updateAiConfigPreset(id: string, preset: Partial<Omit<AiConfigPreset, 'id'>>): Promise<void> {
  const presets = await getAiConfigPresets()
  const index = presets.findIndex(p => p.id === id)
  if (index !== -1) {
    presets[index] = { ...presets[index], ...preset }
    await config.set('aiConfigPresets', presets)
  }
}

// 加载配置预设（应用到当前配置）
export async function loadAiConfigPreset(id: string): Promise<AiConfigPreset | null> {
  const presets = await getAiConfigPresets()
  return presets.find(p => p.id === id) || null
}

// --- 窗口关闭行为配置 ---

// 获取关闭按钮行为（true: 最小化到托盘, false: 退出应用）
export async function getCloseToTray(): Promise<boolean> {
  const value = await config.get(CONFIG_KEYS.CLOSE_TO_TRAY)
  return value !== undefined ? (value as boolean) : true
}

// 设置关闭按钮行为
export async function setCloseToTray(closeToTray: boolean): Promise<void> {
  await config.set(CONFIG_KEYS.CLOSE_TO_TRAY, closeToTray)
}
