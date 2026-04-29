import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, protocol, net, Tray, Menu, type BrowserWindowConstructorOptions, type WebContents } from 'electron'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { readFileSync, existsSync, mkdirSync } from 'fs'
import { Worker } from 'worker_threads'
import { autoUpdater, type ProgressInfo } from 'electron-updater'
import { DatabaseService } from './services/database'
import { appUpdateService } from './services/appUpdateService'

import { wechatDecryptService } from './services/decryptService'
import { ConfigService } from './services/config'
import { wxKeyService } from './services/wxKeyService'
import { wxKeyServiceMac } from './services/wxKeyServiceMac'
import { dbPathService } from './services/dbPathService'
import { wcdbService } from './services/wcdbService'
import { dataManagementService } from './services/dataManagementService'
import { imageDecryptService } from './services/imageDecryptService'
import { imageKeyService } from './services/imageKeyService'  // 内存扫描兜底方案
import { chatService } from './services/chatService'
import { analyticsService } from './services/analyticsService'
import { groupAnalyticsService } from './services/groupAnalyticsService'
import { annualReportService } from './services/annualReportService'
import { exportService, ExportOptions } from './services/exportService'
import { activationService } from './services/activationService'
import { LogService } from './services/logService'
import { videoService } from './services/videoService'

import { voiceTranscribeService } from './services/voiceTranscribeService'
import { voiceTranscribeServiceWhisper } from './services/voiceTranscribeServiceWhisper'
import { voiceTranscribeServiceOnline } from './services/voiceTranscribeServiceOnline'
import { systemAuthService } from './services/systemAuthService'
import { shortcutService } from './services/shortcutService'
import { httpApiService } from './services/httpApiService'
import { aiService } from './services/ai/aiService'
import { getBestCachePath, getRuntimePlatformInfo } from './services/platformService'
import { getMcpLaunchConfig as getMcpLaunchConfigForUi, getMcpProxyConfig } from './services/mcp/runtime'
import { mcpProxyService } from './services/mcp/proxyService'
import { skillManagerService } from './services/skillManagerService'
import { mcpClientService } from './services/mcpClientService'
import { snsService } from './services/snsService'
import { proxyService } from './services/ai/proxyService'
import { chatSearchIndexService } from './services/search/chatSearchIndexService'
import { localEmbeddingModelService } from './services/search/embeddingModelService'
import { embeddingRuntimeService } from './services/search/embeddingRuntimeService'
import { onlineEmbeddingService } from './services/search/onlineEmbeddingService'
import { memoryBuildService } from './services/memory/memoryBuildService'
import { createSessionQANativeToolExecutor } from './services/ai-agent/qa/orchestrator'
import { agentConfigStore } from './services/agent/config/agentConfigStore'
import { bootstrapAgentTools, refreshMcpTools, refreshSkillTools } from './services/agent/registry/bootstrap'
import { toolRegistry } from './services/agent/registry/toolRegistry'
import { createToolId } from './services/agent/registry/unifiedTool'
import { runAgent } from './services/agent/runner'
import { agentSessionStore, type AgentVectorRecallConfig } from './services/agent/session/agentSessionStore'
import { getElectronWorkerEnv } from './services/workerEnvironment'

type AppWithQuitFlag = typeof app & {
  isQuitting?: boolean
}

const appWithQuitFlag = app as AppWithQuitFlag

// 注册自定义协议为特权协议（必须在 app ready 之前）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-video',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  },
  {
    scheme: 'local-image',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true
    }
  }
])

// 配置自动更新
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.disableDifferentialDownload = true  // 禁用差分更新，统一使用全量安装包

// 单例服务
let dbService: DatabaseService | null = null

let configService: ConfigService | null = null
let logService: LogService | null = null

// 系统托盘实例
let tray: Tray | null = null
let isInstallingUpdate = false

// 聊天窗口实例
let chatWindow: BrowserWindow | null = null
// 朋友圈窗口实例
let momentsWindow: BrowserWindow | null = null
// 群聊分析窗口实例
let groupAnalyticsWindow: BrowserWindow | null = null
// 年度报告窗口实例
let annualReportWindow: BrowserWindow | null = null
// 协议窗口实例
let agreementWindow: BrowserWindow | null = null
// 购买窗口实例
let purchaseWindow: BrowserWindow | null = null
// AI 摘要窗口实例
let aiSummaryWindow: BrowserWindow | null = null
// 引导窗口实例
let welcomeWindow: BrowserWindow | null = null
// 聊天记录窗口实例
let chatHistoryWindow: BrowserWindow | null = null
const allowDevTools = !!process.env.VITE_DEV_SERVER_URL

type SessionVectorIndexWorkerMessage = {
  type?: 'progress' | 'completed' | 'error'
  sessionId?: string
  progress?: any
  state?: any
  error?: string
}

type SessionVectorIndexJob = {
  worker: Worker
  sender: WebContents
  cancelRequested: boolean
  aiPauseReleased: boolean
}

const sessionVectorIndexJobs = new Map<string, SessionVectorIndexJob>()

type SessionMemoryBuildWorkerMessage = {
  type?: 'progress' | 'completed' | 'error'
  sessionId?: string
  progress?: any
  state?: any
  error?: string
}

type SessionMemoryBuildJob = {
  worker: Worker
  sender: WebContents
  promise: Promise<any>
}

const sessionMemoryBuildJobs = new Map<string, SessionMemoryBuildJob>()
const agentRunControllers = new Map<string, AbortController>()
const SESSION_QA_NATIVE_TOOL_IDS = new Set([
  'native:read_summary_facts',
  'native:search_messages',
  'native:read_context',
  'native:read_latest',
  'native:read_by_time_range',
  'native:get_session_statistics',
  'native:get_keyword_statistics',
  'native:aggregate_messages',
  'native:resolve_participant'
])

function buildAgentUserMessage(message: string, selection?: any): string {
  const parts = [String(message || '').trim()]
  const selectedSessions = Array.isArray(selection?.selectedSessions) ? selection.selectedSessions : []
  const selectedContacts = Array.isArray(selection?.selectedContacts) ? selection.selectedContacts : []
  const selectedSkills = Array.isArray(selection?.selectedSkills) ? selection.selectedSkills : []
  const timeRange = selection?.timeRange
  if (selectedSessions.length || selectedContacts.length || selectedSkills.length || timeRange) {
    parts.push(`\nStructured context hints:\n${JSON.stringify({
      selectedSessions,
      selectedContacts,
      selectedSkills,
      timeRange: timeRange || null
    }, null, 2)}`)
  }
  return parts.filter(Boolean).join('\n')
}

function getAgentSessionQATarget(selection?: any): { id: string; name?: string; source: 'session' | 'contact' } | null {
  const selectedSessions = Array.isArray(selection?.selectedSessions) ? selection.selectedSessions : []
  const selectedContacts = Array.isArray(selection?.selectedContacts) ? selection.selectedContacts : []
  const firstSession = selectedSessions.find((item: any) => item?.id)
  if (firstSession?.id) {
    return {
      id: String(firstSession.id),
      name: firstSession.name ? String(firstSession.name) : undefined,
      source: 'session'
    }
  }

  const firstContact = selectedContacts.find((item: any) => item?.id)
  if (firstContact?.id) {
    return {
      id: String(firstContact.id),
      name: firstContact.name ? String(firstContact.name) : undefined,
      source: 'contact'
    }
  }

  return null
}

function hasAgentSessionQASelection(selection?: any): boolean {
  const selectedSessions = Array.isArray(selection?.selectedSessions) ? selection.selectedSessions : []
  const selectedContacts = Array.isArray(selection?.selectedContacts) ? selection.selectedContacts : []
  return selectedSessions.length > 0 || selectedContacts.length > 0
}

function withoutSessionQANativeTools(toolIds: string[] = []): string[] {
  return toolIds.filter((toolId) => !SESSION_QA_NATIVE_TOOL_IDS.has(toolId))
}

function toSkillToolId(skillId: unknown): string | null {
  const normalized = String(skillId || '').trim()
  if (!normalized) return null
  return normalized.startsWith('skill:') ? normalized : createToolId('skill', normalized)
}

function getAgentSkillToolIds(agent: { skillIds?: string[] }, selection?: any): string[] {
  const selectedSkills = Array.isArray(selection?.selectedSkills) ? selection.selectedSkills : []
  const ids = [
    ...(Array.isArray(agent.skillIds) ? agent.skillIds : []),
    ...selectedSkills.map((item: any) => item?.id || item?.name)
  ]
  return [...new Set(ids.map(toSkillToolId).filter((toolId): toolId is string => Boolean(toolId)))]
}

function mergeToolIds(baseToolIds: string[] = [], extraToolIds: string[] = []): string[] {
  if (extraToolIds.length === 0) return baseToolIds
  return [...new Set([...baseToolIds, ...extraToolIds])]
}

function filterAvailableAgentToolIds(toolIds: string[] = []): string[] {
  return [...new Set(toolIds)].filter((toolId) => Boolean(toolRegistry.get(toolId)?.isAvailable()))
}

function normalizeSkillName(value: unknown): string {
  return String(value || '').trim().replace(/^skill:/, '')
}

function sanitizeAgentSelection(selection?: any): any {
  if (!selection || typeof selection !== 'object') return selection
  const availableSkills = new Set(skillManagerService.listSkills().map((skill) => skill.name))
  const selectedSkills = Array.isArray(selection.selectedSkills)
    ? selection.selectedSkills.filter((item: any) => {
        const skillName = normalizeSkillName(item?.id || item?.name)
        return Boolean(skillName && availableSkills.has(skillName))
      })
    : selection.selectedSkills
  return {
    ...selection,
    selectedSkills
  }
}

type AgentRuntimeSettings = {
  memoryModelPresetId: string
  vectorRecallEnabled: boolean
  vectorEmbeddingMode: 'inherit' | 'local' | 'online'
  vectorEmbeddingProfileId: string
}

const DEFAULT_AGENT_RUNTIME_SETTINGS: AgentRuntimeSettings = {
  memoryModelPresetId: '',
  vectorRecallEnabled: true,
  vectorEmbeddingMode: 'inherit',
  vectorEmbeddingProfileId: 'bge-large-zh-v1.5-int8'
}

function getAgentRuntimeSettings(): AgentRuntimeSettings {
  const mode = String(configService?.get('agentVectorEmbeddingMode' as any) || '').trim()
  return {
    memoryModelPresetId: String(configService?.get('agentMemoryModelPresetId' as any) || '').trim(),
    vectorRecallEnabled: configService?.get('agentVectorRecallEnabled' as any) !== false,
    vectorEmbeddingMode: mode === 'local' || mode === 'online' ? mode : 'inherit',
    vectorEmbeddingProfileId: String(configService?.get('agentVectorEmbeddingProfileId' as any) || '').trim() || DEFAULT_AGENT_RUNTIME_SETTINGS.vectorEmbeddingProfileId
  }
}

function updateAgentRuntimeSettings(patch: Partial<AgentRuntimeSettings>): AgentRuntimeSettings {
  const current = getAgentRuntimeSettings()
  const next: AgentRuntimeSettings = {
    ...current,
    ...patch,
    memoryModelPresetId: String((patch.memoryModelPresetId ?? current.memoryModelPresetId) || '').trim(),
    vectorRecallEnabled: patch.vectorRecallEnabled === undefined ? current.vectorRecallEnabled : Boolean(patch.vectorRecallEnabled),
    vectorEmbeddingMode: patch.vectorEmbeddingMode === undefined
      ? current.vectorEmbeddingMode
      : patch.vectorEmbeddingMode === 'local' || patch.vectorEmbeddingMode === 'online'
        ? patch.vectorEmbeddingMode
        : 'inherit',
    vectorEmbeddingProfileId: String((patch.vectorEmbeddingProfileId ?? current.vectorEmbeddingProfileId) || '').trim() || DEFAULT_AGENT_RUNTIME_SETTINGS.vectorEmbeddingProfileId
  }
  configService?.set('agentMemoryModelPresetId' as any, next.memoryModelPresetId as any)
  configService?.set('agentVectorRecallEnabled' as any, next.vectorRecallEnabled as any)
  configService?.set('agentVectorEmbeddingMode' as any, next.vectorEmbeddingMode as any)
  configService?.set('agentVectorEmbeddingProfileId' as any, next.vectorEmbeddingProfileId as any)
  return next
}

function getAgentVectorRecallConfig(): AgentVectorRecallConfig {
  const settings = getAgentRuntimeSettings()
  return {
    enabled: settings.vectorRecallEnabled,
    mode: settings.vectorEmbeddingMode,
    localProfileId: settings.vectorEmbeddingProfileId
  }
}

function resolveAgentMemoryRuntime(agent: { isBuiltin?: boolean; provider?: string; model?: string; modelPresetId?: string }, fallback?: {
  provider: any
  providerName?: string
  model?: string
}) {
  const settings = getAgentRuntimeSettings()
  const presets = configService?.getAIConfigPresets() || []
  const configuredPreset = settings.memoryModelPresetId
    ? presets.find((preset) => preset.id === settings.memoryModelPresetId)
    : null
  const agentPreset = !configuredPreset && !agent.isBuiltin && agent.modelPresetId
    ? presets.find((preset) => preset.id === agent.modelPresetId)
    : null
  const preset = configuredPreset || agentPreset || null
  if (preset) {
    const baseURL = preset.baseURL?.trim()
    if (preset.provider !== 'custom' || isUsableCustomBaseURL(baseURL)) {
      return {
        provider: aiService.getConfiguredProvider(
          preset.provider,
          preset.apiKey,
          baseURL ? { baseURL } : undefined
        ),
        providerName: preset.provider,
        model: preset.model
      }
    }
  }
  if (fallback?.provider && fallback.model) return fallback

  const providerName = (!agent.isBuiltin && agent.provider) || configService?.getAICurrentProvider() || undefined
  const providerConfig = providerName ? configService?.getAIProviderConfig(providerName) : undefined
  const provider = aiService.getConfiguredProvider(providerName)
  return {
    provider,
    providerName: providerName || provider.name,
    model: String((!agent.isBuiltin && agent.model) || providerConfig?.model || provider.models[0] || '').trim()
  }
}

function isUsableCustomBaseURL(baseURL?: string): boolean {
  return /^https?:\/\//i.test(String(baseURL || '').trim())
}

function releaseSessionVectorIndexPause(job: SessionVectorIndexJob): void {
  if (job.aiPauseReleased) return
  job.aiPauseReleased = true
  dataManagementService.resumeFromAi()
}

function finishSessionVectorIndexJob(sessionId: string, job?: SessionVectorIndexJob): SessionVectorIndexJob | null {
  const currentJob = job || sessionVectorIndexJobs.get(sessionId)
  if (!currentJob) return null

  sessionVectorIndexJobs.delete(sessionId)
  releaseSessionVectorIndexPause(currentJob)
  return currentJob
}

function findElectronWorkerPath(fileName: string): string | null {
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, 'app.asar', 'dist-electron', fileName),
        join(process.resourcesPath, 'app.asar.unpacked', 'dist-electron', fileName),
        join(process.resourcesPath, 'dist-electron', fileName),
        join(__dirname, '..', fileName),
        join(__dirname, fileName)
      ]
    : [
        join(__dirname, '..', fileName),
        join(__dirname, fileName),
        join(app.getAppPath(), 'dist-electron', fileName)
      ]

  return candidates.find((candidate) => existsSync(candidate)) || null
}

async function getSessionVectorIndexStateForUi(sessionId: string) {
  const state = chatSearchIndexService.getSessionVectorIndexState(sessionId)
  return {
    ...state,
    isVectorRunning: state.isVectorRunning || sessionVectorIndexJobs.has(sessionId)
  }
}

function sendSessionVectorIndexProgress(sender: WebContents, progress: any) {
  if (!sender || sender.isDestroyed()) return
  sender.send('ai:sessionVectorIndexProgress', progress)
}

async function sendSessionVectorIndexFailure(sender: WebContents, sessionId: string, error: string) {
  try {
    const state = await getSessionVectorIndexStateForUi(sessionId)
    sendSessionVectorIndexProgress(sender, {
      sessionId,
      stage: 'vectorizing_messages',
      status: 'failed',
      processedCount: state.vectorizedCount || 0,
      totalCount: state.indexedCount || 0,
      message: error,
      vectorModel: state.vectorModel || ''
    })
  } catch {
    sendSessionVectorIndexProgress(sender, {
      sessionId,
      stage: 'vectorizing_messages',
      status: 'failed',
      processedCount: 0,
      totalCount: 0,
      message: error,
      vectorModel: ''
    })
  }
}

async function startSessionVectorIndexJob(sessionId: string, sender: WebContents) {
  const existing = sessionVectorIndexJobs.get(sessionId)
  if (existing) {
    existing.sender = sender
    return getSessionVectorIndexStateForUi(sessionId)
  }

  const workerPath = findElectronWorkerPath('sessionVectorIndexWorker.js')
  if (!workerPath) {
    throw new Error('未找到 sessionVectorIndexWorker.js')
  }

  const worker = new Worker(workerPath, {
    env: getElectronWorkerEnv(),
    workerData: { sessionId }
  })
  const job: SessionVectorIndexJob = {
    worker,
    sender,
    cancelRequested: false,
    aiPauseReleased: false
  }
  sessionVectorIndexJobs.set(sessionId, job)
  dataManagementService.pauseForAi()

  worker.on('message', (message: SessionVectorIndexWorkerMessage) => {
    const currentJob = sessionVectorIndexJobs.get(sessionId)
    const targetSender = currentJob?.sender || sender

    if (message?.type === 'progress' && message.progress) {
      sendSessionVectorIndexProgress(targetSender, message.progress)
      return
    }

    if (message?.type === 'completed') {
      finishSessionVectorIndexJob(sessionId, currentJob)
      void worker.terminate().catch(() => undefined)
      return
    }

    if (message?.type === 'error') {
      finishSessionVectorIndexJob(sessionId, currentJob)
      void sendSessionVectorIndexFailure(targetSender, sessionId, message.error || '向量化失败')
      void worker.terminate().catch(() => undefined)
    }
  })

  worker.on('error', (error) => {
    const currentJob = finishSessionVectorIndexJob(sessionId)
    void sendSessionVectorIndexFailure(currentJob?.sender || sender, sessionId, String(error))
  })

  worker.on('exit', (code) => {
    const currentJob = finishSessionVectorIndexJob(sessionId)
    if (!currentJob) return

    if (code !== 0 && !currentJob.cancelRequested) {
      void sendSessionVectorIndexFailure(currentJob.sender, sessionId, `向量化 Worker 异常退出，代码：${code}`)
    }
  })

  return getSessionVectorIndexStateForUi(sessionId)
}

async function getSessionMemoryBuildStateForUi(sessionId: string) {
  const state = memoryBuildService.getSessionState(sessionId)
  return {
    ...state,
    isRunning: state.isRunning || sessionMemoryBuildJobs.has(sessionId)
  }
}

function sendSessionMemoryBuildProgress(sender: WebContents, progress: any) {
  if (!sender || sender.isDestroyed()) return
  sender.send('ai:sessionMemoryBuildProgress', progress)
}

async function startSessionMemoryBuildJob(sessionId: string, sender: WebContents) {
  const existing = sessionMemoryBuildJobs.get(sessionId)
  if (existing) {
    existing.sender = sender
    return existing.promise
  }

  const workerPath = findElectronWorkerPath('sessionMemoryBuildWorker.js')
  if (!workerPath) {
    throw new Error('未找到 sessionMemoryBuildWorker.js')
  }

  const worker = new Worker(workerPath, {
    env: getElectronWorkerEnv(),
    workerData: { sessionId }
  })

  const promise = new Promise<any>((resolve, reject) => {
    worker.on('message', (message: SessionMemoryBuildWorkerMessage) => {
      const currentJob = sessionMemoryBuildJobs.get(sessionId)
      const targetSender = currentJob?.sender || sender

      if (message?.type === 'progress' && message.progress) {
        sendSessionMemoryBuildProgress(targetSender, message.progress)
        return
      }

      if (message?.type === 'completed') {
        sessionMemoryBuildJobs.delete(sessionId)
        void worker.terminate().catch(() => undefined)
        resolve(message.state)
        return
      }

      if (message?.type === 'error') {
        sessionMemoryBuildJobs.delete(sessionId)
        void worker.terminate().catch(() => undefined)
        reject(new Error(message.error || '会话记忆构建失败'))
      }
    })

    worker.on('error', (error) => {
      sessionMemoryBuildJobs.delete(sessionId)
      reject(error)
    })

    worker.on('exit', (code) => {
      const currentJob = sessionMemoryBuildJobs.get(sessionId)
      if (!currentJob) return
      sessionMemoryBuildJobs.delete(sessionId)
      if (code !== 0) {
        reject(new Error(`会话记忆构建 Worker 异常退出，代码：${code}`))
      }
    })
  })

  sessionMemoryBuildJobs.set(sessionId, {
    worker,
    sender,
    promise
  })

  return promise
}

type ImageViewerListItem = {
  imagePath: string
  liveVideoPath?: string
}

type ImageViewerOpenOptions = {
  sessionId?: string
  imageMd5?: string
  imageDatName?: string
}

type ReleaseAnnouncementPayload = {
  version: string
  releaseBody?: string
  releaseNotes?: string
  generatedAt?: string
}

function getReleaseAnnouncementPath(): string {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  return isDev
    ? join(__dirname, '../.tmp/release-announcement.json')
    : join(process.resourcesPath, 'release-announcement.json')
}

function syncPackagedReleaseAnnouncement() {
  if (!configService) return

  const announcementPath = getReleaseAnnouncementPath()
  if (!existsSync(announcementPath)) {
    return
  }

  try {
    const raw = readFileSync(announcementPath, 'utf8')
    const payload = JSON.parse(raw) as ReleaseAnnouncementPayload
    if (!payload || typeof payload !== 'object') return

    const version = String(payload.version || '').trim()
    if (!version || version !== app.getVersion()) return

    const releaseBody = String(payload.releaseBody || '').trim()
    const releaseNotes = String(payload.releaseNotes || '').trim()

    const storedVersion = configService.get('releaseAnnouncementVersion')
    const storedBody = configService.get('releaseAnnouncementBody')
    const storedNotes = configService.get('releaseAnnouncementNotes')

    if (
      storedVersion === version &&
      storedBody === releaseBody &&
      storedNotes === releaseNotes
    ) {
      return
    }

    configService.set('releaseAnnouncementVersion', version)
    configService.set('releaseAnnouncementBody', releaseBody)
    configService.set('releaseAnnouncementNotes', releaseNotes)
    logService?.info('ReleaseAnnouncement', '已同步本地版本公告', {
      version,
      hasBody: Boolean(releaseBody),
      hasNotes: Boolean(releaseNotes)
    })
  } catch (error) {
    logService?.warn('ReleaseAnnouncement', '同步本地版本公告失败', { error: String(error) })
  }
}

/**
 * 获取当前主题的 URL 查询参数
 * 用于子窗口加载时传递主题，防止闪烁
 */
function getThemeQueryParams(): string {
  if (!configService) return ''
  const theme = configService.get('theme') || 'cloud-dancer'
  const themeMode = configService.get('themeMode') || 'light'
  return `theme=${encodeURIComponent(theme)}&mode=${encodeURIComponent(themeMode)}`
}

/**
 * 获取当前应用图标路径
 */
function getAppIconPath(): string {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconName = configService?.get('appIcon') || 'default'

  if (process.platform === 'darwin') {
    if (iconName === 'xinnian') {
      return isDev
        ? join(__dirname, '../public/xinnian.icns')
        : join(process.resourcesPath, 'icon.icns')
    }

    return isDev
      ? join(__dirname, '../public/icon.icns')
      : join(process.resourcesPath, 'icon.icns')
  }

  if (iconName === 'xinnian') {
    return isDev
      ? join(__dirname, '../public/xinnian.ico')
      : join(process.resourcesPath, 'xinnian.ico')
  } else {
    return isDev
      ? join(__dirname, '../public/icon.ico')
      : join(process.resourcesPath, 'icon.ico')
  }
}

function loadNativeImageIfValid(iconPath: string, purpose: string): ReturnType<typeof nativeImage.createFromPath> | null {
  if (!existsSync(iconPath)) {
    console.warn(`[Icon] ${purpose} not found: ${iconPath}`)
    return null
  }

  try {
    const image = nativeImage.createFromPath(iconPath)
    if (image.isEmpty()) {
      console.warn(`[Icon] ${purpose} failed to load: ${iconPath}`)
      return null
    }
    return image
  } catch (error) {
    console.warn(`[Icon] ${purpose} failed to load: ${iconPath}`, error)
    return null
  }
}

function getWindowIconOptions(): Pick<BrowserWindowConstructorOptions, 'icon'> {
  // macOS uses the bundle/dock icon. Passing a missing or invalid .icns here can crash Electron.
  if (process.platform === 'darwin') {
    return {}
  }

  const image = loadNativeImageIfValid(getAppIconPath(), 'window icon')
  return image ? { icon: image } : {}
}

function getDockIconPath(): string {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconName = configService?.get('appIcon') || 'default'

  if (iconName === 'xinnian') {
    const devPaddedPath = join(__dirname, '../public/xinnian-dock.png')
    const devFallbackPath = join(__dirname, '../public/xinnian.png')
    return isDev
      ? (existsSync(devPaddedPath) ? devPaddedPath : devFallbackPath)
      : join(process.resourcesPath, 'icon.png')
  }

  const devPaddedPath = join(__dirname, '../public/icon-dock.png')
  const devFallbackPath = join(__dirname, '../public/logo.png')
  return isDev
    ? (existsSync(devPaddedPath) ? devPaddedPath : devFallbackPath)
    : join(process.resourcesPath, 'icon.png')
}

function getTrayIconPath(): string {
  if (process.platform === 'darwin') {
    const isDev = !!process.env.VITE_DEV_SERVER_URL
    const iconName = configService?.get('appIcon') || 'default'
    const devTrayPath = iconName === 'xinnian'
      ? join(__dirname, '../public/xinnian-tray.png')
      : join(__dirname, '../public/tray-mac.png')

    if (isDev && existsSync(devTrayPath)) {
      return devTrayPath
    }
  }

  return getAppIconPath()
}

function getTrayImage() {
  const iconPath = getTrayIconPath()
  const image = loadNativeImageIfValid(iconPath, 'tray icon')

  if (!image) {
    return nativeImage.createEmpty()
  }

  if (process.platform === 'darwin') {
    return image.resize({ height: 26 })
  }

  return image
}

/**
 * 创建系统托盘
 */
function createTray(): Tray | null {
  if (tray) return tray

  try {
    tray = new Tray(getTrayImage())
  } catch (error) {
    console.warn('[Icon] tray creation failed:', error)
    return null
  }

  if (process.platform === 'darwin') {
    tray.setIgnoreDoubleClickEvents(true)
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) {
            mainWindow.restore()
          }
          mainWindow.show()
          mainWindow.focus()
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        // 设置标志，允许真正退出
        appWithQuitFlag.isQuitting = true
        app.quit()
      }
    }
  ])

  tray.setToolTip('密语 CipherTalk')
  tray.setContextMenu(contextMenu)

  // 双击托盘图标显示窗口
  tray.on('double-click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      mainWindow.show()
      mainWindow.focus()
    }
  })

  return tray
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    ...getWindowIconOptions(),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      devTools: allowDevTools,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false  // 允许加载本地文件
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#1a1a1a',
      height: 40
    },
    show: false
  })

  // 初始化服务
  configService = new ConfigService()
  dbService = new DatabaseService()

  logService = new LogService(configService)
  syncPackagedReleaseAnnouncement()
  mcpProxyService.setLogger(logService)
  autoUpdater.logger = {
    info(message: string) {
      logService?.info('AppUpdate', message)
      appUpdateService.noteUpdaterMessage(String(message), 'info')
    },
    warn(message: string) {
      logService?.warn('AppUpdate', message)
      appUpdateService.noteUpdaterMessage(String(message), 'warn')
    },
    error(message: string) {
      logService?.error('AppUpdate', message)
      appUpdateService.noteUpdaterMessage(String(message), 'error')
    },
    debug(message: string) {
      logService?.debug('AppUpdate', message)
      appUpdateService.noteUpdaterMessage(String(message), 'info')
    }
  }

  // 记录应用启动日志
  logService.info('App', '应用启动', { version: app.getVersion() })

  // 初始化 Whisper GPU 组件目录
  const cachePath = configService.get('cachePath')
  if (cachePath) {
    voiceTranscribeServiceWhisper.setGPUComponentsDir(cachePath)
  }

  // 窗口准备好后显示
  win.once('ready-to-show', () => {
    win.show()
  })

  // 监听窗口关闭事件
  win.on('close', (event) => {
    const updateInfo = appUpdateService.getCachedUpdateInfo()
    if (updateInfo?.forceUpdate) {
      appWithQuitFlag.isQuitting = true
      return
    }

    if (isInstallingUpdate) {
      appWithQuitFlag.isQuitting = true
      return
    }

    // 如果是真正退出应用，不阻止
    if (appWithQuitFlag.isQuitting) {
      return
    }

    // 获取关闭行为配置
    const closeToTray = configService?.get('closeToTray')

    // 如果配置为关闭到托盘（默认为 true）
    if (closeToTray !== false) {
      event.preventDefault()
      win.hide()

      // 确保托盘已创建
      if (!tray) {
        createTray()
      }

      return
    }

    // 配置为直接退出时，需要显式退出应用。
    // 否则主窗口关闭后托盘仍然存在，进程不会真正结束。
    event.preventDefault()
    appWithQuitFlag.isQuitting = true
    app.quit()
  })

  // 开发环境加载 vite 服务器
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)

    // 开发环境下按 F12 或 Ctrl+Shift+I 打开开发者工具
    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
        } else {
          win.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'))
  }


  return win
}

/**
 * 创建独立的聊天窗口（仿微信风格）
 */
function createChatWindow() {
  // 如果已存在，聚焦到现有窗口
  if (chatWindow && !chatWindow.isDestroyed()) {
    if (chatWindow.isMinimized()) {
      chatWindow.restore()
    }
    chatWindow.focus()
    return chatWindow
  }

  const isDark = nativeTheme.shouldUseDarkColors

  chatWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    ...getWindowIconOptions(),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      devTools: allowDevTools,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false  // 允许加载本地文件
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#666666',
      height: 40
    },
    show: false,
    backgroundColor: isDark ? '#1A1A1A' : '#F0F0F0'
  })

  chatWindow.once('ready-to-show', () => {
    chatWindow?.show()
  })

  // 获取主题参数
  const themeParams = getThemeQueryParams()

  // 加载聊天页面
  if (process.env.VITE_DEV_SERVER_URL) {
    chatWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${themeParams}#/chat-window`)

    chatWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (chatWindow?.webContents.isDevToolsOpened()) {
          chatWindow.webContents.closeDevTools()
        } else {
          chatWindow?.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  } else {
    chatWindow.loadFile(join(__dirname, '../dist/index.html'), {
      hash: '/chat-window',
      query: { theme: configService?.get('theme') || 'cloud-dancer', mode: configService?.get('themeMode') || 'light' }
    })
  }

  chatWindow.on('closed', () => {
    chatWindow = null
  })

  return chatWindow
}

/**
 * 创建独立的群聊分析窗口
 */
function createGroupAnalyticsWindow() {
  // 如果已存在，聚焦到现有窗口
  if (groupAnalyticsWindow && !groupAnalyticsWindow.isDestroyed()) {
    if (groupAnalyticsWindow.isMinimized()) {
      groupAnalyticsWindow.restore()
    }
    groupAnalyticsWindow.focus()
    return groupAnalyticsWindow
  }

  const isDark = nativeTheme.shouldUseDarkColors

  groupAnalyticsWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    ...getWindowIconOptions(),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      devTools: allowDevTools,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false  // 允许加载本地文件
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#666666',
      height: 40
    },
    show: false,
    backgroundColor: isDark ? '#1A1A1A' : '#F0F0F0'
  })

  groupAnalyticsWindow.once('ready-to-show', () => {
    groupAnalyticsWindow?.show()
  })

  // 获取主题参数
  const themeParams = getThemeQueryParams()

  // 加载群聊分析页面
  if (process.env.VITE_DEV_SERVER_URL) {
    groupAnalyticsWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${themeParams}#/group-analytics-window`)

    groupAnalyticsWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (groupAnalyticsWindow?.webContents.isDevToolsOpened()) {
          groupAnalyticsWindow.webContents.closeDevTools()
        } else {
          groupAnalyticsWindow?.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  } else {
    groupAnalyticsWindow.loadFile(join(__dirname, '../dist/index.html'), {
      hash: '/group-analytics-window',
      query: { theme: configService?.get('theme') || 'cloud-dancer', mode: configService?.get('themeMode') || 'light' }
    })
  }

  groupAnalyticsWindow.on('closed', () => {
    groupAnalyticsWindow = null
  })

  return groupAnalyticsWindow
}

/**
 * 创建独立的朋友圈窗口
 */
function createMomentsWindow(filterUsername?: string) {
  // 如果已存在，聚焦到现有窗口并发送筛选
  if (momentsWindow && !momentsWindow.isDestroyed()) {
    if (momentsWindow.isMinimized()) {
      momentsWindow.restore()
    }
    momentsWindow.focus()
    if (filterUsername) {
      momentsWindow.webContents.send('moments:filterUser', filterUsername)
    }
    return momentsWindow
  }

  const isDark = nativeTheme.shouldUseDarkColors

  momentsWindow = new BrowserWindow({
    width: 1200, // Widened from default
    height: 800,
    minWidth: 900,
    minHeight: 600,
    ...getWindowIconOptions(),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      devTools: allowDevTools,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false  // 允许加载本地文件
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#666666',
      height: 40
    },
    show: false,
    backgroundColor: isDark ? '#1A1A1A' : '#F0F0F0'
  })

  momentsWindow.once('ready-to-show', () => {
    momentsWindow?.show()
  })

  // 获取主题参数
  const themeParams = getThemeQueryParams()

  // 加载朋友圈页面
  const filterParam = filterUsername ? `&filterUsername=${encodeURIComponent(filterUsername)}` : ''
  if (process.env.VITE_DEV_SERVER_URL) {
    momentsWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${themeParams}${filterParam}#/moments-window`)

    momentsWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (momentsWindow?.webContents.isDevToolsOpened()) {
          momentsWindow.webContents.closeDevTools()
        } else {
          momentsWindow?.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  } else {
    const query: Record<string, string> = { theme: configService?.get('theme') || 'cloud-dancer', mode: configService?.get('themeMode') || 'light' }
    if (filterUsername) query.filterUsername = filterUsername
    momentsWindow.loadFile(join(__dirname, '../dist/index.html'), {
      hash: '/moments-window',
      query
    })
  }

  momentsWindow.on('closed', () => {
    momentsWindow = null
  })

  return momentsWindow
}

/**
 * 创建独立的聊天记录窗口
 */
function createChatHistoryWindow(sessionId: string, messageId: number) {
  // 如果已存在，聚焦到现有窗口
  if (chatHistoryWindow && !chatHistoryWindow.isDestroyed()) {
    if (chatHistoryWindow.isMinimized()) {
      chatHistoryWindow.restore()
    }
    chatHistoryWindow.focus()

    // 导航到新记录
    const themeParams = getThemeQueryParams()
    if (process.env.VITE_DEV_SERVER_URL) {
      chatHistoryWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${themeParams}#/chat-history/${sessionId}/${messageId}`)
    } else {
      chatHistoryWindow.loadFile(join(__dirname, '../dist/index.html'), {
        hash: `/chat-history/${sessionId}/${messageId}`,
        query: { theme: configService?.get('theme') || 'cloud-dancer', mode: configService?.get('themeMode') || 'light' }
      })
    }
    return chatHistoryWindow
  }

  const isDark = nativeTheme.shouldUseDarkColors

  chatHistoryWindow = new BrowserWindow({
    width: 600,
    height: 800,
    minWidth: 400,
    minHeight: 500,
    ...getWindowIconOptions(),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      devTools: allowDevTools,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false  // 允许加载本地文件
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: isDark ? '#ffffff' : '#1a1a1a',
      height: 40
    },
    show: false,
    backgroundColor: isDark ? '#1A1A1A' : '#F0F0F0',
    autoHideMenuBar: true
  })

  chatHistoryWindow.once('ready-to-show', () => {
    chatHistoryWindow?.show()
  })

  const themeParams = getThemeQueryParams()
  if (process.env.VITE_DEV_SERVER_URL) {
    chatHistoryWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${themeParams}#/chat-history/${sessionId}/${messageId}`)

    chatHistoryWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        chatHistoryWindow?.webContents.openDevTools()
        event.preventDefault()
      }
    })
  } else {
    chatHistoryWindow.loadFile(join(__dirname, '../dist/index.html'), {
      hash: `/chat-history/${sessionId}/${messageId}`,
      query: { theme: configService?.get('theme') || 'cloud-dancer', mode: configService?.get('themeMode') || 'light' }
    })
  }

  chatHistoryWindow.on('closed', () => {
    chatHistoryWindow = null
  })

  return chatHistoryWindow
}

/**
 * 创建独立的年度报告窗口
 */
function createAnnualReportWindow(year: number) {
  // 如果已存在，关闭旧窗口
  if (annualReportWindow && !annualReportWindow.isDestroyed()) {
    annualReportWindow.close()
    annualReportWindow = null
  }

  const isDark = nativeTheme.shouldUseDarkColors

  annualReportWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    ...getWindowIconOptions(),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      devTools: allowDevTools,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false  // 允许加载本地文件
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: isDark ? '#FFFFFF' : '#333333',
      height: 40
    },
    show: false,
    backgroundColor: isDark ? '#1A1A1A' : '#F9F8F6'
  })

  annualReportWindow.once('ready-to-show', () => {
    annualReportWindow?.show()
  })

  // 获取主题参数
  const themeParams = getThemeQueryParams()

  // 加载年度报告页面，带年份参数
  if (process.env.VITE_DEV_SERVER_URL) {
    annualReportWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${themeParams}#/annual-report-window?year=${year}`)

    annualReportWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (annualReportWindow?.webContents.isDevToolsOpened()) {
          annualReportWindow.webContents.closeDevTools()
        } else {
          annualReportWindow?.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  } else {
    annualReportWindow.loadFile(join(__dirname, '../dist/index.html'), {
      hash: `/annual-report-window?year=${year}`,
      query: { theme: configService?.get('theme') || 'cloud-dancer', mode: configService?.get('themeMode') || 'light' }
    })
  }

  annualReportWindow.on('closed', () => {
    annualReportWindow = null
  })

  return annualReportWindow
}

/**
 * 创建用户协议窗口
 */
function createAgreementWindow() {
  // 如果已存在，聚焦
  if (agreementWindow && !agreementWindow.isDestroyed()) {
    agreementWindow.focus()
    return agreementWindow
  }

  const isDark = nativeTheme.shouldUseDarkColors

  agreementWindow = new BrowserWindow({
    width: 800,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    ...getWindowIconOptions(),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      devTools: allowDevTools,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false  // 允许加载本地文件
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: isDark ? '#FFFFFF' : '#333333',
      height: 40
    },
    show: false,
    backgroundColor: isDark ? '#1A1A1A' : '#FFFFFF'
  })

  agreementWindow.once('ready-to-show', () => {
    agreementWindow?.show()
  })

  // 获取主题参数
  const themeParams = getThemeQueryParams()

  if (process.env.VITE_DEV_SERVER_URL) {
    agreementWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${themeParams}#/agreement-window`)
  } else {
    agreementWindow.loadFile(join(__dirname, '../dist/index.html'), {
      hash: '/agreement-window',
      query: { theme: configService?.get('theme') || 'cloud-dancer', mode: configService?.get('themeMode') || 'light' }
    })
  }

  agreementWindow.on('closed', () => {
    agreementWindow = null
  })

  return agreementWindow
}

/**
 * 创建首次引导窗口（独立无边框透明窗口）
 */
function createWelcomeWindow(mode: 'default' | 'add-account' = 'default') {
  // 如果已存在，聚焦
  if (welcomeWindow && !welcomeWindow.isDestroyed()) {
    welcomeWindow.focus()
    return welcomeWindow
  }

  welcomeWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    ...getWindowIconOptions(),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      devTools: allowDevTools,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false  // 允许加载本地文件
    },
    show: false
  })

  welcomeWindow.once('ready-to-show', () => {
    welcomeWindow?.show()
  })

  const welcomeHash = mode === 'add-account' ? '/welcome-window?mode=add-account' : '/welcome-window'

  if (process.env.VITE_DEV_SERVER_URL) {
    welcomeWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#${welcomeHash}`)
  } else {
    welcomeWindow.loadFile(join(__dirname, '../dist/index.html'), { hash: welcomeHash })
  }

  welcomeWindow.on('closed', () => {
    welcomeWindow = null
  })

  return welcomeWindow
}

/**
 * 创建购买窗口
 */
function createPurchaseWindow() {
  // 如果已存在，聚焦
  if (purchaseWindow && !purchaseWindow.isDestroyed()) {
    purchaseWindow.focus()
    return purchaseWindow
  }

  purchaseWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    ...getWindowIconOptions(),
    webPreferences: {
      devTools: allowDevTools,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false  // 允许加载本地文件
    },
    title: '获取激活码 - 密语',
    show: false,
    backgroundColor: '#FFFFFF',
    autoHideMenuBar: true
  })

  purchaseWindow.once('ready-to-show', () => {
    purchaseWindow?.show()
  })

  // 加载购买页面
  purchaseWindow.loadURL('https://pay.ldxp.cn/shop/aiqiji')

  purchaseWindow.on('closed', () => {
    purchaseWindow = null
  })

  return purchaseWindow
}

function getImageViewerQueryParams(
  imagePath: string,
  liveVideoPath?: string,
  options?: ImageViewerOpenOptions
): string {
  const themeParams = getThemeQueryParams()
  const imageParam = `imagePath=${encodeURIComponent(imagePath)}`
  const liveVideoParam = liveVideoPath ? `&liveVideoPath=${encodeURIComponent(liveVideoPath)}` : ''
  const sessionParam = options?.sessionId ? `&sessionId=${encodeURIComponent(options.sessionId)}` : ''
  const imageMd5Param = options?.imageMd5 ? `&imageMd5=${encodeURIComponent(options.imageMd5)}` : ''
  const imageDatNameParam = options?.imageDatName ? `&imageDatName=${encodeURIComponent(options.imageDatName)}` : ''
  return `${themeParams}&${imageParam}${liveVideoParam}${sessionParam}${imageMd5Param}${imageDatNameParam}`
}

/**
 * 创建独立的图片查看窗口
 */
function createImageViewerWindow(
  imagePath: string,
  liveVideoPath?: string,
  options?: ImageViewerOpenOptions
) {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 400,
    minHeight: 300,
    ...getWindowIconOptions(),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      devTools: allowDevTools,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false // 允许加载本地文件
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#ffffff',
      height: 40
    },
    show: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  const queryParams = getImageViewerQueryParams(imagePath, liveVideoPath, options)

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/image-viewer-window?${queryParams}`)

    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
        } else {
          win.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'), {
      hash: `/image-viewer-window?${queryParams}`
    })
  }

  return win
}

/**
 * 创建独立的视频播放窗口
 * 窗口大小会根据视频比例自动调整
 */
function createVideoPlayerWindow(videoPath: string, videoWidth?: number, videoHeight?: number) {
  // 获取屏幕尺寸
  const { screen } = require('electron')
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize

  // 计算窗口尺寸，只有标题栏 40px，控制栏悬浮
  let winWidth = 854
  let winHeight = 520
  const titleBarHeight = 40

  if (videoWidth && videoHeight && videoWidth > 0 && videoHeight > 0) {
    const aspectRatio = videoWidth / videoHeight

    const maxWidth = Math.floor(screenWidth * 0.85)
    const maxHeight = Math.floor(screenHeight * 0.85)

    if (aspectRatio >= 1) {
      // 横向视频
      winWidth = Math.min(videoWidth, maxWidth)
      winHeight = Math.floor(winWidth / aspectRatio) + titleBarHeight

      if (winHeight > maxHeight) {
        winHeight = maxHeight
        winWidth = Math.floor((winHeight - titleBarHeight) * aspectRatio)
      }
    } else {
      // 竖向视频
      const videoDisplayHeight = Math.min(videoHeight, maxHeight - titleBarHeight)
      winHeight = videoDisplayHeight + titleBarHeight
      winWidth = Math.floor(videoDisplayHeight * aspectRatio)

      if (winWidth < 300) {
        winWidth = 300
        winHeight = Math.floor(winWidth / aspectRatio) + titleBarHeight
      }
    }

    winWidth = Math.max(winWidth, 360)
    winHeight = Math.max(winHeight, 280)
  }

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: 360,
    minHeight: 280,
    ...getWindowIconOptions(),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      devTools: allowDevTools,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1a1a1a',
      symbolColor: '#ffffff',
      height: 40
    },
    show: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  const themeParams = getThemeQueryParams()
  const videoParam = `videoPath=${encodeURIComponent(videoPath)}`
  const queryParams = `${themeParams}&${videoParam}`

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/video-player-window?${queryParams}`)

    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
        } else {
          win.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'), {
      hash: `/video-player-window?${queryParams}`
    })
  }

  return win
}

/**
 * 创建内置浏览器窗口
 */
function createBrowserWindow(url: string, title?: string) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    ...getWindowIconOptions(),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      devTools: allowDevTools,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      webviewTag: true // 允许使用 <webview> 标签
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1a1a1a',
      symbolColor: '#ffffff',
      height: 40
    },
    show: false,
    backgroundColor: '#ffffff',
    title: title || '浏览器'
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  // 获取主题参数
  const themeParams = getThemeQueryParams()
  const urlParam = `url=${encodeURIComponent(url)}`
  const titleParam = title ? `&title=${encodeURIComponent(title)}` : ''
  const queryParams = `${themeParams}&${urlParam}${titleParam}`

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/browser-window?${queryParams}`)

    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
        } else {
          win.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  } else {
    // 生产环境，加载 browser-window 路由
    win.loadFile(join(__dirname, '../dist/index.html'), {
      hash: `/browser-window?${queryParams}`
    })
  }

  return win
}

/**
 * 创建 AI 摘要窗口
 */
function createAISummaryWindow(sessionId: string, sessionName: string) {
  // 如果已存在，关闭旧窗口
  if (aiSummaryWindow && !aiSummaryWindow.isDestroyed()) {
    aiSummaryWindow.close()
    aiSummaryWindow = null
  }

  const isDark = nativeTheme.shouldUseDarkColors

  aiSummaryWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    ...getWindowIconOptions(),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      devTools: allowDevTools,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false  // 允许加载本地文件
    },
    // 使用自定义标题栏但保留原生窗口控件
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: isDark ? '#2A2A2A' : '#F0F0F0',
      symbolColor: isDark ? '#FFFFFF' : '#000000',
      height: 40
    },
    show: false,
    backgroundColor: isDark ? '#1A1A1A' : '#FFFFFF',
    autoHideMenuBar: true
  })

  aiSummaryWindow.once('ready-to-show', () => {
    aiSummaryWindow?.show()
  })

  // 获取主题参数
  const themeParams = getThemeQueryParams()
  const sessionIdParam = `sessionId=${encodeURIComponent(sessionId)}`
  const sessionNameParam = `sessionName=${encodeURIComponent(sessionName)}`
  const queryParams = `${themeParams}&${sessionIdParam}&${sessionNameParam}`

  if (process.env.VITE_DEV_SERVER_URL) {
    aiSummaryWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${queryParams}#/ai-summary-window`)

    aiSummaryWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (aiSummaryWindow?.webContents.isDevToolsOpened()) {
          aiSummaryWindow.webContents.closeDevTools()
        } else {
          aiSummaryWindow?.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  } else {
    aiSummaryWindow.loadFile(join(__dirname, '../dist/index.html'), {
      search: queryParams,
      hash: '/ai-summary-window'
    })
  }

  aiSummaryWindow.on('closed', () => {
    aiSummaryWindow = null
  })

  return aiSummaryWindow
}

// 注册 IPC 处理器
function registerIpcHandlers() {
  // 配置相关
  ipcMain.handle('config:get', async (_, key: string) => {
    return configService?.get(key as any)
  })

  ipcMain.handle('config:set', async (_, key: string, value: any) => {
    return configService?.set(key as any, value)
  })

  // TLD 缓存相关
  ipcMain.handle('config:getTldCache', async () => {
    return configService?.getTldCache()
  })

  ipcMain.handle('config:setTldCache', async (_, tlds: string[]) => {
    return configService?.setTldCache(tlds)
  })

  ipcMain.handle('accounts:list', async () => {
    return configService?.listAccounts() || []
  })

  ipcMain.handle('accounts:getActive', async () => {
    return configService?.getActiveAccount() || null
  })

  ipcMain.handle('accounts:setActive', async (_, accountId: string) => {
    return configService?.setActiveAccount(accountId) || null
  })

  ipcMain.handle('accounts:save', async (_, profile: any) => {
    return configService?.saveAccount(profile) || null
  })

  ipcMain.handle('accounts:update', async (_, accountId: string, patch: any) => {
    return configService?.updateAccount(accountId, patch) || null
  })

  ipcMain.handle('accounts:delete', async (_, accountId: string, deleteLocalData = false) => {
    if (!configService) {
      return { success: false, error: '配置服务未初始化' }
    }

    const deleted = configService.listAccounts().find((item) => item.id === accountId) || null
    if (!deleted) {
      return { success: false, error: '账号不存在' }
    }

    if (deleteLocalData) {
      const cacheService = new (await import('./services/cacheService')).CacheService(configService)
      const clearResult = await cacheService.clearAccountDatabases(deleted)
      if (!clearResult.success) {
        return { success: false, error: clearResult.error || '删除账号本地数据失败' }
      }
    }

    const result = configService.deleteAccount(accountId)
    return { success: true, deleted: result.deleted, nextActiveAccountId: result.nextActiveAccountId }
  })

  // ── Skill Manager ──
  ipcMain.handle('skillManager:list', async () => {
    return skillManagerService.listSkills()
  })
  ipcMain.handle('skillManager:readContent', async (_, skillName: string) => {
    return skillManagerService.readSkillContent(skillName)
  })
  ipcMain.handle('skillManager:updateContent', async (_, skillName: string, content: string) => {
    const result = skillManagerService.updateSkillContent(skillName, content)
    if (result.success) refreshSkillTools()
    return result
  })
  ipcMain.handle('skillManager:exportZip', async (_, skillName: string) => {
    return skillManagerService.exportSkillZip(skillName)
  })
  ipcMain.handle('skillManager:importZip', async (_, zipPath: string) => {
    const result = skillManagerService.importSkillZip(zipPath)
    if (result.success) refreshSkillTools()
    return result
  })
  ipcMain.handle('skillManager:delete', async (_, skillName: string) => {
    const result = skillManagerService.deleteSkill(skillName)
    if (result.success) refreshSkillTools()
    return result
  })
  ipcMain.handle('skillManager:create', async (_, skillName: string, content: string) => {
    const result = skillManagerService.createSkill(skillName, content)
    if (result.success) refreshSkillTools()
    return result
  })

  // ── MCP Client ──
  ipcMain.handle('mcpClient:listConfigs', async () => {
    return mcpClientService.listClientConfigs()
  })
  ipcMain.handle('mcpClient:saveConfig', async (_, name: string, config: any, overwrite?: boolean) => {
    return mcpClientService.saveClientConfig(name, config, Boolean(overwrite))
  })
  ipcMain.handle('mcpClient:deleteConfig', async (_, name: string) => {
    const result = mcpClientService.deleteClientConfig(name)
    await refreshMcpTools(name)
    return result
  })
  ipcMain.handle('mcpClient:connect', async (_, name: string) => {
    const result = await mcpClientService.connectToServer(name)
    if (result.success) await refreshMcpTools(name)
    return result
  })
  ipcMain.handle('mcpClient:disconnect', async (_, name: string) => {
    const result = await mcpClientService.disconnectFromServer(name)
    await refreshMcpTools(name)
    return result
  })
  ipcMain.handle('mcpClient:listTools', async (_, name: string) => {
    return mcpClientService.listToolsFromServer(name)
  })
  ipcMain.handle('mcpClient:callTool', async (_, name: string, toolName: string, args: any) => {
    return mcpClientService.callTool(name, toolName, args)
  })
  ipcMain.handle('mcpClient:listStatuses', async () => {
    return mcpClientService.listAllServerStatuses()
  })

  // ── Agent System ──
  ipcMain.handle('agent:list', async (_, options?: { isBuiltin?: boolean; search?: string }) => {
    return agentConfigStore.list(options)
  })
  ipcMain.handle('agent:get', async (_, id: string) => {
    return agentConfigStore.get(id)
  })
  ipcMain.handle('agent:create', async (_, input: any) => {
    return agentConfigStore.create(input)
  })
  ipcMain.handle('agent:update', async (_, id: string, patch: any) => {
    return agentConfigStore.update(id, patch)
  })
  ipcMain.handle('agent:delete', async (_, id: string) => {
    agentConfigStore.delete(id)
    return { success: true }
  })
  ipcMain.handle('agent:listTools', async () => {
    await bootstrapAgentTools()
    return toolRegistry.listMetadata()
  })
  ipcMain.handle('agent:getRuntimeSettings', async () => {
    return getAgentRuntimeSettings()
  })
  ipcMain.handle('agent:updateRuntimeSettings', async (_, patch: Partial<AgentRuntimeSettings>) => {
    return updateAgentRuntimeSettings(patch || {})
  })
  ipcMain.handle('agent:listSessions', async (_, options?: { search?: string; limit?: number }) => {
    return agentSessionStore.listSessions(options)
  })
  ipcMain.handle('agent:getSession', async (_, id: string) => {
    return agentSessionStore.getSession(String(id || '').trim())
  })
  ipcMain.handle('agent:createSession', async (_, input?: { title?: string; agentId?: string }) => {
    return agentSessionStore.createSession(input || {})
  })
  ipcMain.handle('agent:updateSession', async (_, id: string, patch: { title?: string; agentId?: string | null }) => {
    return agentSessionStore.updateSession(String(id || '').trim(), patch || {})
  })
  ipcMain.handle('agent:deleteSession', async (_, id: string) => {
    return { success: agentSessionStore.deleteSession(String(id || '').trim()) }
  })
  ipcMain.handle('agent:getSessionMemoryState', async (_, id: string) => {
    return agentSessionStore.getMemoryState(String(id || '').trim())
  })
  ipcMain.handle('agent:listSessionSummaries', async (_, id: string) => {
    return agentSessionStore.listSummaries(String(id || '').trim())
  })
  ipcMain.handle('agent:updateSessionSummary', async (_, id: string, content: string) => {
    return agentSessionStore.updateSummary(String(id || '').trim(), content)
  })
  ipcMain.handle('agent:deleteSessionSummary', async (_, id: string) => {
    const result = agentSessionStore.deleteSummary(String(id || '').trim())
    return {
      ...result,
      memoryState: result.sessionId ? agentSessionStore.getMemoryState(result.sessionId) : undefined
    }
  })
  ipcMain.handle('agent:clearSessionSummaries', async (_, id: string) => {
    const deletedCount = agentSessionStore.clearSessionSummaries(String(id || '').trim())
    return {
      success: true,
      deletedCount,
      result: agentSessionStore.getMemoryState(String(id || '').trim())
    }
  })
  ipcMain.handle('agent:compressSessionContext', async (_, input: { sessionId?: string; agentId?: string }) => {
    const sessionId = String(input?.sessionId || '').trim()
    if (!sessionId) return { success: false, error: 'sessionId is required' }
    const session = agentSessionStore.getSession(sessionId)
    if (!session) return { success: false, error: `Agent session not found: ${sessionId}` }
    const agent = agentConfigStore.get(input?.agentId || session.agentId || 'builtin-general-agent')
      || agentConfigStore.list({ isBuiltin: true })[0]
      || agentConfigStore.list()[0]
    if (!agent) return { success: false, error: 'Agent not found' }
    const runtime = resolveAgentMemoryRuntime(agent)
    const summary = await agentSessionStore.compressSessionContext({
      sessionId,
      agent,
      provider: runtime.provider,
      model: runtime.model
    })
    return {
      success: Boolean(summary),
      summary,
      memoryState: agentSessionStore.getMemoryState(sessionId),
      error: summary ? undefined : '当前会话消息太少，暂时不需要压缩'
    }
  })
  ipcMain.handle('agent:listSessionObservations', async (_, id: string) => {
    const session = agentSessionStore.getSession(String(id || '').trim())
    return agentSessionStore.listObservations({
      sessionId: String(id || '').trim(),
      agentId: session?.agentId,
      limit: 200
    })
  })
  ipcMain.handle('agent:updateSessionObservation', async (_, id: string, patch: { title?: string; content?: string; type?: any; tags?: string[] }) => {
    return agentSessionStore.updateObservation(String(id || '').trim(), patch || {})
  })
  ipcMain.handle('agent:deleteSessionObservation', async (_, id: string) => {
    const result = agentSessionStore.deleteObservation(String(id || '').trim())
    return {
      ...result,
      memoryState: result.sessionId ? agentSessionStore.getMemoryState(result.sessionId) : undefined
    }
  })
  ipcMain.handle('agent:clearSessionObservations', async (_, id: string) => {
    const deletedCount = agentSessionStore.clearSessionObservations(String(id || '').trim())
    return {
      success: true,
      deletedCount,
      result: agentSessionStore.getMemoryState(String(id || '').trim())
    }
  })
  ipcMain.handle('agent:execute', async (event, request: {
    requestId?: string
    agentId: string
    sessionId?: string
    message: string
    selection?: any
    provider?: string
    apiKey?: string
    model?: string
  }) => {
    await bootstrapAgentTools()
    const requestId = request.requestId || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const agent = agentConfigStore.get(request.agentId)
    if (!agent) return { success: false, requestId, error: `Agent not found: ${request.agentId}` }
    const selection = sanitizeAgentSelection(request.selection)
    const sessionQATarget = getAgentSessionQATarget(selection)
    if (hasAgentSessionQASelection(selection) && !sessionQATarget) {
      return {
        success: false,
        requestId,
        error: '会话参数无效，请重新用 # 从补全列表选择会话、群聊或联系人。'
      }
    }

    try {
      const currentProviderName = configService?.getAICurrentProvider()
      const currentProviderConfig = currentProviderName
        ? configService?.getAIProviderConfig(currentProviderName)
        : undefined
      const agentModel = !agent.isBuiltin && agent.model ? String(agent.model).trim() : undefined
      const aiConfigPresets = configService?.getAIConfigPresets() || []
      const matchedPreset = !agent.isBuiltin && agent.modelPresetId
        ? aiConfigPresets.find((preset) => preset.id === agent.modelPresetId)
        : undefined
      const agentProviderName = !agent.isBuiltin
        ? matchedPreset?.provider || agent.provider || undefined
        : undefined
      const providerName = request.provider || agentProviderName
      const matchedPresetBaseURL = matchedPreset?.baseURL?.trim()
      if (providerName === 'custom' && matchedPreset && !isUsableCustomBaseURL(matchedPresetBaseURL)) {
        return {
          success: false,
          requestId,
          error: `Agent 模型预设「${matchedPreset.name || matchedPreset.model}」的服务地址无效，请以 http:// 或 https:// 开头。`
        }
      }
      const provider = aiService.getConfiguredProvider(
        providerName,
        request.apiKey || matchedPreset?.apiKey,
        matchedPresetBaseURL ? { baseURL: matchedPresetBaseURL } : undefined
      )
      const effectiveProviderName = providerName || currentProviderName || provider.name
      const configuredModel = effectiveProviderName
        ? (effectiveProviderName === currentProviderName ? currentProviderConfig : configService?.getAIProviderConfig(effectiveProviderName))?.model
        : undefined
      const controller = new AbortController()
      agentRunControllers.set(requestId, controller)
      const runModel = String(request.model || matchedPreset?.model || agentModel || configuredModel || provider.models[0] || '').trim()
      const baseToolIds = sessionQATarget ? agent.toolIds : withoutSessionQANativeTools(agent.toolIds)
      const selectedSkillToolIds = getAgentSkillToolIds(agent, selection)
      const runtimeToolIds = filterAvailableAgentToolIds(mergeToolIds(baseToolIds, selectedSkillToolIds))
      const runConfig = {
        ...agent,
        provider: providerName || provider.name,
        model: runModel,
        toolIds: runtimeToolIds,
        mcpServerIds: agent.mcpServerIds.filter((serverName) => mcpClientService.hasClientConfig(serverName)),
        skillIds: agent.skillIds.filter((skillId) => Boolean(skillManagerService.readSkillContent(normalizeSkillName(skillId)).success))
      }
      const memoryRuntime = resolveAgentMemoryRuntime(agent, {
        provider,
        providerName: providerName || provider.name,
        model: runModel
      })
      const vectorRecall = getAgentVectorRecallConfig()
      const agentSession = agentSessionStore.ensureSession(request.sessionId, {
        agentId: agent.id,
        firstMessage: request.message
      })
      agentSessionStore.updateSession(agentSession.id, { agentId: agent.id })
      const memoryContext = await agentSessionStore.prepareRunContext({
        sessionId: agentSession.id,
        agent: runConfig,
        provider: memoryRuntime.provider,
        model: memoryRuntime.model,
        userMessage: request.message,
        vectorRecall
      })
      agentSessionStore.appendMessage({
        sessionId: agentSession.id,
        role: 'user',
        content: request.message,
        selection,
        agentName: agent.name
      })
      const userMessage = buildAgentUserMessage(request.message, selection)
      let nativeSessionQAToolExecutor: undefined | ((toolName: string, args: Record<string, unknown>) => Promise<any>)
      if (sessionQATarget?.id) {
        const executor = await createSessionQANativeToolExecutor({
          sessionId: sessionQATarget.id,
          sessionName: sessionQATarget.name,
          question: request.message,
          provider,
          model: runConfig.model,
          enableThinking: false,
          onChunk: () => undefined,
          onProgress: () => undefined,
          signal: controller.signal
        })
        nativeSessionQAToolExecutor = async (toolName, args) => {
          const result = await executor(toolName, args)
          return {
            ok: result.ok,
            content: result.summary,
            data: result,
            error: result.error
          }
        }
      }
      const channel = `agent:execute:event:${requestId}`

      void (async () => {
        const storedEvents: any[] = []
        let answerText = ''
        let errorText = ''
        let doneReason = ''
        let doneEvent: any = null
        try {
          for await (const item of runAgent(runConfig, userMessage, {
            provider,
            selection,
            systemContext: memoryContext.systemContext,
            historyMessages: memoryContext.historyMessages,
            nativeSessionQAToolExecutor
          }, controller.signal)) {
            storedEvents.push(item)
            if (item.type === 'text' && item.content) answerText += item.content
            if (item.type === 'error' && item.message) errorText = item.message
            if (item.type === 'done') doneReason = item.reason
            if (item.type === 'done') {
              doneEvent = item
              continue
            }
            if (!event.sender.isDestroyed()) event.sender.send(channel, item)
          }
        } catch (error) {
          errorText = error instanceof Error ? error.message : String(error)
          storedEvents.push({ type: 'error', message: errorText })
          if (!event.sender.isDestroyed()) {
            event.sender.send(channel, { type: 'error', message: errorText })
          }
          doneEvent = {
            type: 'done',
            reason: 'error',
            tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            turn: 0
          }
        } finally {
          if (doneReason !== 'aborted' && (answerText.trim() || errorText.trim() || storedEvents.length > 0)) {
            try {
              const assistantMessage = agentSessionStore.appendMessage({
                sessionId: agentSession.id,
                role: 'assistant',
                content: answerText || errorText,
                agentName: agent.name,
                error: Boolean(errorText && !answerText),
                events: storedEvents as any
              })
              if (answerText.trim()) {
                await agentSessionStore.extractObservationsFromRun({
                  sessionId: agentSession.id,
                  agent: runConfig,
                  provider: memoryRuntime.provider,
                  model: memoryRuntime.model,
                  userMessage: request.message,
                  assistantText: answerText,
                  events: storedEvents as any,
                  sourceMessageId: assistantMessage.id,
                  vectorRecall
                })
              }
            } catch (storeError) {
              console.warn('[Agent] 保存 Agent 回复失败:', storeError)
            }
          }
          if (doneEvent && !event.sender.isDestroyed()) {
            event.sender.send(channel, doneEvent)
          }
          agentRunControllers.delete(requestId)
        }
      })()

      return { success: true, requestId, sessionId: agentSession.id }
    } catch (error) {
      agentRunControllers.delete(requestId)
      return { success: false, requestId, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('agent:cancel', async (_, requestId: string) => {
    const controller = agentRunControllers.get(requestId)
    if (!controller) return { success: false, error: `Agent run not found: ${requestId}` }
    controller.abort()
    agentRunControllers.delete(requestId)
    return { success: true }
  })

  // HTTP API 管理
  ipcMain.handle('httpApi:getStatus', async () => {
    return { success: true, status: httpApiService.getUiStatus() }
  })

  ipcMain.handle('httpApi:applySettings', async (_, payload: { enabled: boolean; port: number; token: string; listenMode: 'localhost' | 'lan' }) => {
    try {
      const enabled = Boolean(payload?.enabled)
      const portRaw = Number(payload?.port)
      const port = Number.isFinite(portRaw) ? Math.max(1, Math.min(65535, Math.floor(portRaw))) : 5031
      const token = (payload?.token || '').trim()
      const listenMode = payload?.listenMode === 'lan' ? 'lan' : 'localhost'

      if (listenMode === 'lan' && !token) {
        return { success: false, error: '局域网模式必须先配置访问密钥' }
      }

      configService?.set('httpApiEnabled', enabled)
      configService?.set('httpApiPort', port)
      configService?.set('httpApiToken', token)
      configService?.set('httpApiListenMode', listenMode)

      httpApiService.applySettings({ enabled, port, token, listenMode })
      const restartResult = await httpApiService.restart()
      if (!restartResult.success) {
        return { success: false, error: restartResult.error || 'HTTP API 重启失败' }
      }

      return { success: true, status: httpApiService.getUiStatus() }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('httpApi:restart', async () => {
    const result = await httpApiService.restart()
    if (!result.success) {
      return { success: false, error: result.error || 'HTTP API 重启失败' }
    }
    return { success: true, status: httpApiService.getUiStatus() }
  })

  // 数据库相关
  ipcMain.handle('db:open', async (_, dbPath: string) => {
    return dbService?.open(dbPath)
  })

  ipcMain.handle('db:query', async (_, sql: string, params?: any[]) => {
    return dbService?.query(sql, params)
  })

  ipcMain.handle('db:close', async () => {
    return dbService?.close()
  })

  // 解密相关
  ipcMain.handle('decrypt:database', async (_, sourcePath: string, key: string, outputPath: string) => {
    return wechatDecryptService.decryptDatabase(sourcePath, outputPath, key)
  })

  ipcMain.handle('decrypt:image', async (_, imagePath: string) => {
    return null
  })

  // ... (其他 IPC)

  // 监听增量消息推送
  chatService.on('new-messages', (data) => {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('chat:new-messages', data)
      }
    })
  })

  // 文件对话框
  ipcMain.handle('dialog:openFile', async (_, options) => {
    const { dialog } = await import('electron')
    return dialog.showOpenDialog(options)
  })

  ipcMain.handle('dialog:saveFile', async (_, options) => {
    const { dialog } = await import('electron')
    return dialog.showSaveDialog(options)
  })

  // 文件操作
  ipcMain.handle('file:delete', async (_, filePath: string) => {
    try {
      const fs = await import('fs')
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
        return { success: true }
      } else {
        return { success: false, error: '文件不存在' }
      }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('file:copy', async (_, sourcePath: string, destPath: string) => {
    try {
      const fs = await import('fs')
      if (!fs.existsSync(sourcePath)) {
        return { success: false, error: '源文件不存在' }
      }
      fs.copyFileSync(sourcePath, destPath)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('file:writeBase64', async (_, filePath: string, base64Data: string) => {
    try {
      const fs = await import('fs')
      fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'))
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('shell:openPath', async (_, path: string) => {
    const { shell } = await import('electron')
    return shell.openPath(path)
  })

  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    const { shell } = await import('electron')
    return shell.openExternal(url)
  })

  ipcMain.handle('shell:showItemInFolder', async (_, fullPath: string) => {
    const { shell } = await import('electron')
    return shell.showItemInFolder(fullPath)
  })

  ipcMain.handle('app:getDownloadsPath', async () => {
    return app.getPath('downloads')
  })

  ipcMain.handle('app:getVersion', async () => {
    return app.getVersion()
  })

  ipcMain.handle('app:getPlatformInfo', async () => {
    return getRuntimePlatformInfo()
  })

  ipcMain.handle('app:getMcpLaunchConfig', async () => {
    return getMcpLaunchConfigForUi()
  })

  ipcMain.on('app:getMcpLaunchConfig:request', (event, payload: { requestId?: string } | undefined) => {
    const requestId = payload?.requestId
    if (!requestId) return
    event.sender.send(`app:getMcpLaunchConfig:response:${requestId}`, getMcpLaunchConfigForUi())
  })

  ipcMain.handle('app:checkForUpdates', async () => {
    return appUpdateService.checkForUpdates()
  })

  ipcMain.handle('app:getUpdateState', async () => {
    return appUpdateService.getCachedUpdateInfo()
  })

  ipcMain.handle('app:getUpdateSourceInfo', async () => {
    return {
      primaryUpdateSource: 'github' as const,
      githubRepository: appUpdateService.getGithubRepository(),
      policySources: ['github', 'custom'] as const,
      policyPrecedence: 'github' as const,
      forceUpdatePolicyFallbackUrl: appUpdateService.getForceUpdatePolicyFallbackUrl()
    }
  })

  ipcMain.handle('app:setAppIcon', async (_, iconName: string) => {
    try {
      const iconPath = process.platform === 'darwin' ? getDockIconPath() : getAppIconPath()

      if (existsSync(iconPath)) {
        const image = nativeImage.createFromPath(iconPath)

        if (process.platform === 'darwin') {
          if (!image.isEmpty()) {
            app.dock?.setIcon(image)
          }
        } else {
          BrowserWindow.getAllWindows().forEach(win => {
            win.setIcon(image)
          })
        }

        // 尝试更新桌面快捷方式图标 (不阻塞主线程)
        shortcutService.updateDesktopShortcutIcon(iconPath).catch(err => {
          console.error('更新快捷方式失败:', err)
        })

        if (tray) {
          tray.setImage(getTrayImage())
        }

        return { success: true }
      }
      return { success: false, error: 'Icon not found' }
    } catch (e) {
      console.error('设置图标失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('app:downloadAndInstall', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)

    if (isInstallingUpdate) {
      logService?.warn('AppUpdate', '下载更新请求被忽略，当前已有下载任务进行中', {
        targetVersion: appUpdateService.getCachedUpdateInfo()?.version
      })
      return
    }

    isInstallingUpdate = true
    const cachedUpdateInfo = appUpdateService.getCachedUpdateInfo()
    const targetVersion = cachedUpdateInfo?.version

    appUpdateService.updateDiagnostics({
      phase: 'downloading',
      targetVersion,
      lastError: undefined,
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: undefined,
      lastEvent: targetVersion ? `开始下载更新 ${targetVersion}` : '开始下载更新'
    })
    logService?.info('AppUpdate', '开始下载更新', { targetVersion, differentialEnabled: !autoUpdater.disableDifferentialDownload })

    const onDownloadProgress = (progress: ProgressInfo) => {
      const payload = {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond
      }
      BrowserWindow.getAllWindows().forEach(currentWindow => {
        currentWindow.webContents.send('app:downloadProgress', payload)
      })
      appUpdateService.updateDiagnostics({
        phase: 'downloading',
        progressPercent: progress.percent,
        downloadedBytes: progress.transferred,
        totalBytes: progress.total,
        lastEvent: `下载中 ${progress.percent.toFixed(1)}%`
      })
    }

    const onUpdateDownloaded = () => {
      appUpdateService.updateDiagnostics({
        phase: 'downloaded',
        progressPercent: 100,
        lastEvent: '更新包下载完成，准备安装'
      })
      logService?.info('AppUpdate', '更新包下载完成，准备安装', {
        targetVersion,
        fallbackToFull: appUpdateService.getCachedUpdateInfo()?.diagnostics?.fallbackToFull || false
      })
      appWithQuitFlag.isQuitting = true
      appUpdateService.updateDiagnostics({
        phase: 'installing',
        lastEvent: '开始调用安装器'
      })
      autoUpdater.quitAndInstall(false, true)
    }

    const onUpdaterError = (error: Error) => {
      isInstallingUpdate = false
      appUpdateService.updateDiagnostics({
        phase: 'failed',
        lastError: String(error),
        lastEvent: '下载或安装更新失败'
      })
      logService?.error('AppUpdate', '下载或安装更新失败', {
        targetVersion,
        error: String(error),
        fallbackToFull: appUpdateService.getCachedUpdateInfo()?.diagnostics?.fallbackToFull || false
      })
    }

    autoUpdater.on('download-progress', onDownloadProgress)
    autoUpdater.once('update-downloaded', onUpdateDownloaded)
    autoUpdater.once('error', onUpdaterError)

    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      isInstallingUpdate = false
      onUpdaterError(error as Error)
      throw error
    } finally {
      autoUpdater.removeListener('download-progress', onDownloadProgress)
      autoUpdater.removeListener('update-downloaded', onUpdateDownloaded)
      autoUpdater.removeListener('error', onUpdaterError)
    }
  })

  // 窗口控制
  ipcMain.on('window:splashReady', () => {
    splashReady = true
  })

  // 查询启动时是否已经成功连接数据库（一次性查询，查询后重置）  // 注册获取启动时数据库连接状态的处理器
  ipcMain.handle('app:getStartupDbConnected', () => {
    const connected = startupDbConnected
    // 重置标志，防止后续重复查询
    startupDbConnected = false
    return connected
  })

  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.on('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win?.isMaximized()) {
      win.unmaximize()
    } else {
      win?.maximize()
    }
  })

  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  // 打开图片查看窗口
  ipcMain.handle(
    'window:openImageViewerWindow',
    (
      _,
      imagePath: string,
      liveVideoPath?: string,
      imageList?: ImageViewerListItem[],
      options?: ImageViewerOpenOptions
    ) => {
      const win = createImageViewerWindow(imagePath, liveVideoPath, options)
      if (imageList && imageList.length > 1) {
        const currentIndex = imageList.findIndex(item => item.imagePath === imagePath)
        win.webContents.once('did-finish-load', () => {
          if (!win.isDestroyed()) {
            win.webContents.send('imageViewer:setImageList', {
              imageList,
              currentIndex: currentIndex >= 0 ? currentIndex : 0
            })
          }
        })
      }
    }
  )

  // 打开视频播放窗口
  ipcMain.handle('window:openVideoPlayerWindow', (_, videoPath: string, videoWidth?: number, videoHeight?: number) => {
    createVideoPlayerWindow(videoPath, videoWidth, videoHeight)
  })

  // 根据视频尺寸调整窗口大小
  ipcMain.handle('window:resizeToFitVideo', (event, videoWidth: number, videoHeight: number) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || !videoWidth || !videoHeight) return

    const { screen } = require('electron')
    const primaryDisplay = screen.getPrimaryDisplay()
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize

    // 只有标题栏 40px，控制栏悬浮在视频上
    const titleBarHeight = 40
    const aspectRatio = videoWidth / videoHeight

    const maxWidth = Math.floor(screenWidth * 0.85)
    const maxHeight = Math.floor(screenHeight * 0.85)

    let winWidth: number
    let winHeight: number

    if (aspectRatio >= 1) {
      // 横向视频 - 以宽度为基准
      winWidth = Math.min(videoWidth, maxWidth)
      winHeight = Math.floor(winWidth / aspectRatio) + titleBarHeight

      if (winHeight > maxHeight) {
        winHeight = maxHeight
        winWidth = Math.floor((winHeight - titleBarHeight) * aspectRatio)
      }
    } else {
      // 竖向视频 - 以高度为基准
      const videoDisplayHeight = Math.min(videoHeight, maxHeight - titleBarHeight)
      winHeight = videoDisplayHeight + titleBarHeight
      winWidth = Math.floor(videoDisplayHeight * aspectRatio)

      // 确保宽度不会太窄
      if (winWidth < 300) {
        winWidth = 300
        winHeight = Math.floor(winWidth / aspectRatio) + titleBarHeight
      }
    }

    // 调整窗口大小并居中
    win.setSize(winWidth, winHeight)
    win.center()
  })



  // 打开内置浏览器窗口
  ipcMain.handle('window:openBrowserWindow', (_, url: string, title?: string) => {
    createBrowserWindow(url, title)
  })

  // 打开 AI 摘要窗口
  ipcMain.handle('window:openAISummaryWindow', (_, sessionId: string, sessionName: string) => {
    createAISummaryWindow(sessionId, sessionName)
    return true
  })

  // 打开聊天记录窗口
  ipcMain.handle('window:openChatHistoryWindow', (_, sessionId: string, messageId: number) => {
    createChatHistoryWindow(sessionId, messageId)
    return true
  })

  // 获取单条消息
  ipcMain.handle('chat:getMessage', async (_, sessionId: string, localId: number) => {
    return chatService.getMessageByLocalId(sessionId, localId)
  })

  // 更新窗口控件主题色
  ipcMain.on('window:setTitleBarOverlay', (event, options: { symbolColor: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      try {
        win.setTitleBarOverlay({
          color: '#00000000',
          symbolColor: options.symbolColor,
          height: 40
        })
      } catch (e) {
        // 忽略错误 - 某些窗口（如启动屏）没有启用 titleBarOverlay
      }
    }
  })

  ipcMain.handle('systemAuth:getStatus', async () => {
    return systemAuthService.getStatus()
  })

  ipcMain.handle('systemAuth:verify', async (_, reason?: string) => {
    return systemAuthService.verify(reason)
  })

  // 密钥获取相关
  ipcMain.handle('wxkey:isWeChatRunning', async () => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.isWeChatRunning()
    }
    return wxKeyService.isWeChatRunning()
  })

  ipcMain.handle('wxkey:getWeChatPid', async () => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.getWeChatPid()
    }
    return wxKeyService.getWeChatPid()
  })

  ipcMain.handle('wxkey:killWeChat', async () => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.killWeChat()
    }
    return wxKeyService.killWeChat()
  })

  ipcMain.handle('wxkey:launchWeChat', async (_, customWechatPath?: string) => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.launchWeChat(customWechatPath)
    }
    return wxKeyService.launchWeChat(customWechatPath)
  })

  ipcMain.handle('wxkey:waitForWindow', async (_, maxWaitSeconds?: number) => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.waitForWeChatWindow(maxWaitSeconds)
    }
    return wxKeyService.waitForWeChatWindow(maxWaitSeconds)
  })

  ipcMain.handle('wxkey:startGetKey', async (event, customWechatPath?: string, dbPath?: string) => {
    logService?.info('WxKey', '开始获取微信密钥', { customWechatPath })
    if (process.platform === 'darwin') {
      try {
        const isRunning = wxKeyServiceMac.isWeChatRunning()
        if (isRunning) {
          event.sender.send('wxkey:status', { status: '检测到微信正在运行，正在关闭微信...', level: 0 })
          wxKeyServiceMac.killWeChat()

          const exited = await wxKeyServiceMac.waitForWeChatExit(20)
          if (!exited) {
            return { success: false, error: '未能自动关闭微信，请先手动退出微信后重试' }
          }

          event.sender.send('wxkey:status', { status: '微信已关闭，正在重新启动微信...', level: 0 })
          const relaunched = await wxKeyServiceMac.launchWeChat(customWechatPath)
          if (!relaunched) {
            return { success: false, error: '微信关闭后自动重启失败' }
          }

          event.sender.send('wxkey:status', { status: '微信已重新启动，等待主进程就绪...', level: 0 })
          const ready = await wxKeyServiceMac.waitForWeChatWindow(20)
          if (!ready) {
            return { success: false, error: '微信已重新启动，但未检测到可用主进程，请确认微信已完成启动并显示主窗口' }
          }
        } else {
          event.sender.send('wxkey:status', { status: '未检测到微信主进程，正在尝试启动微信...', level: 0 })

          const launched = await wxKeyServiceMac.launchWeChat(customWechatPath)
          if (!launched) {
            return { success: false, error: '未找到微信主进程，且自动启动微信失败' }
          }

          event.sender.send('wxkey:status', { status: '微信已启动，等待主进程就绪...', level: 0 })
          const ready = await wxKeyServiceMac.waitForWeChatWindow(20)
          if (!ready) {
            return { success: false, error: '微信已启动，但未检测到可用主进程，请确认微信已完成启动并显示主窗口' }
          }
        }

        const result = await wxKeyServiceMac.autoGetDbKey(180_000, (status, level) => {
          event.sender.send('wxkey:status', { status, level })
        })

        if (!result.success) {
          logService?.warn('WxKey', 'macOS 数据库密钥获取失败', { error: result.error })
          return result
        }

        if (result.key && dbPath) {
          event.sender.send('wxkey:status', { status: '已获取候选密钥，正在验证数据库...', level: 0 })

          const wxidCandidates: string[] = []
          const pushWxid = (value?: string | null) => {
            const wxid = String(value || '').trim()
            if (!wxid || wxidCandidates.includes(wxid)) return
            wxidCandidates.push(wxid)
          }

          let currentAccount = wxKeyServiceMac.detectCurrentAccount(dbPath, 10)
          if (!currentAccount) {
            currentAccount = wxKeyServiceMac.detectCurrentAccount(dbPath, 60)
          }
          pushWxid(currentAccount?.wxid)

          try {
            const scannedWxids = dbPathService.scanWxids(dbPath)
            for (const wxid of scannedWxids) {
              pushWxid(wxid)
            }
          } catch {
            // ignore
          }

          let validatedWxid = ''
          let lastError = ''
          for (const wxid of wxidCandidates) {
            event.sender.send('wxkey:status', { status: `正在验证账号目录: ${wxid}`, level: 0 })
            const testResult = await wcdbService.testConnection(dbPath, result.key, wxid)
            if (testResult.success) {
              validatedWxid = wxid
              break
            }
            lastError = testResult.error || ''
          }

          if (!validatedWxid) {
            logService?.warn('WxKey', 'macOS 候选密钥未通过数据库验证', {
              dbPath,
              candidateCount: wxidCandidates.length
            })
            return {
              success: false,
              error: lastError || '已捕获到候选密钥，但未通过数据库验证。请在微信完成登录后进入任意聊天，让数据库访问真正触发，再重试。'
            }
          }

          logService?.info('WxKey', 'macOS 候选密钥已通过数据库验证', { dbPath, wxid: validatedWxid })
          return {
            ...result,
            validatedWxid
          }
        }

        logService?.info('WxKey', 'macOS 数据库密钥获取成功', { keyLength: result.key?.length || 0 })
        return result
      } catch (e) {
        wxKeyServiceMac.dispose()
        logService?.error('WxKey', 'macOS 获取密钥异常', { error: String(e) })
        return { success: false, error: String(e) }
      }
    }

    try {
      // 初始化 DLL
      const initSuccess = await wxKeyService.initialize()
      if (!initSuccess) {
        logService?.error('WxKey', 'DLL 初始化失败')
        return { success: false, error: 'DLL 初始化失败' }
      }

      // 检查微信是否已运行，如果运行则先关闭
      if (wxKeyService.isWeChatRunning()) {
        logService?.info('WxKey', '检测到微信正在运行，准备关闭')
        event.sender.send('wxkey:status', { status: '检测到微信正在运行，准备关闭...', level: 1 })
        wxKeyService.killWeChat()
        await new Promise(resolve => setTimeout(resolve, 2000))
      }

      // 发送状态：准备启动微信
      event.sender.send('wxkey:status', { status: '正在安装 Hook...', level: 1 })

      // 获取微信路径
      const wechatPath = customWechatPath || wxKeyService.getWeChatPath()
      if (!wechatPath) {
        logService?.error('WxKey', '未找到微信安装路径')
        return { success: false, error: '未找到微信安装路径', needManualPath: true }
      }

      logService?.info('WxKey', '找到微信路径', { wechatPath })
      event.sender.send('wxkey:status', { status: 'Hook 安装成功，正在启动微信...', level: 1 })

      // 启动微信
      const launchSuccess = await wxKeyService.launchWeChat(customWechatPath)
      if (!launchSuccess) {
        logService?.error('WxKey', '启动微信失败')
        return { success: false, error: '启动微信失败' }
      }

      // 等待微信进程出现
      event.sender.send('wxkey:status', { status: '等待微信进程启动...', level: 1 })
      const windowAppeared = await wxKeyService.waitForWeChatWindow(15)
      if (!windowAppeared) {
        logService?.error('WxKey', '微信进程启动超时')
        return { success: false, error: '微信进程启动超时' }
      }

      // 获取微信 PID
      const pid = wxKeyService.getWeChatPid()
      if (!pid) {
        logService?.error('WxKey', '未找到微信进程')
        return { success: false, error: '未找到微信进程' }
      }

      logService?.info('WxKey', '找到微信进程', { pid })
      event.sender.send('wxkey:status', { status: '正在注入 Hook...', level: 1 })

      // 创建 Promise 等待密钥
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          wxKeyService.dispose()
          logService?.error('WxKey', '获取密钥超时')
          resolve({ success: false, error: '获取密钥超时' })
        }, 60000)

        const success = wxKeyService.installHook(
          pid,
          (key) => {
            clearTimeout(timeout)
            wxKeyService.dispose()
            logService?.info('WxKey', '密钥获取成功', { keyLength: key.length })
            resolve({ success: true, key })
          },
          (status, level) => {
            // 发送状态到渲染进程
            event.sender.send('wxkey:status', { status, level })
          }
        )

        if (!success) {
          clearTimeout(timeout)
          const error = wxKeyService.getLastError()
          wxKeyService.dispose()
          logService?.error('WxKey', 'Hook 安装失败', { error })
          resolve({ success: false, error: `Hook 安装失败: ${error}` })
        }
      })
    } catch (e) {
      wxKeyService.dispose()
      logService?.error('WxKey', '获取密钥异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('wxkey:cancel', async () => {
    if (process.platform === 'darwin') {
      wxKeyServiceMac.dispose()
      return true
    }
    wxKeyService.dispose()
    return true
  })

  ipcMain.handle('wxkey:detectCurrentAccount', async (_, dbPath?: string, maxTimeDiffMinutes?: number) => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.detectCurrentAccount(dbPath, maxTimeDiffMinutes)
    }
    return wxKeyService.detectCurrentAccount(dbPath, maxTimeDiffMinutes)
  })

  // 数据库路径相关
  ipcMain.handle('dbpath:autoDetect', async () => {
    return dbPathService.autoDetect()
  })

  ipcMain.handle('dbpath:scanWxids', async (_, rootPath: string) => {
    return dbPathService.scanWxids(rootPath)
  })

  ipcMain.handle('dbpath:getDefault', async () => {
    return dbPathService.getDefaultPath()
  })

  // 获取最佳缓存目录
  ipcMain.handle('dbpath:getBestCachePath', async () => {
    const result = getBestCachePath()
    logService?.info('CachePath', '返回平台默认缓存目录', result)
    return result
  })

  // WCDB 数据库相关
  ipcMain.handle('wcdb:testConnection', async (_, dbPath: string, hexKey: string, wxid: string, isAutoConnect = false) => {
    const logPrefix = isAutoConnect ? '自动连接' : '手动测试'
    logService?.info('WCDB', `${logPrefix}数据库连接`, { dbPath, wxid, isAutoConnect })
    const result = await wcdbService.testConnection(dbPath, hexKey, wxid)
    if (result.success) {
      logService?.info('WCDB', `${logPrefix}数据库连接成功`, { sessionCount: result.sessionCount })
    } else {
      // 自动连接失败使用WARN级别，手动测试失败使用ERROR级别
      const logLevel = isAutoConnect ? 'warn' : 'error'
      const errorInfo = {
        error: result.error || '未知错误',
        dbPath,
        wxid,
        keyLength: hexKey ? hexKey.length : 0,
        isAutoConnect
      }

      if (logLevel === 'warn') {
        logService?.warn('WCDB', `${logPrefix}数据库连接失败`, errorInfo)
      } else {
        logService?.error('WCDB', `${logPrefix}数据库连接失败`, errorInfo)
      }
    }
    return result
  })

  ipcMain.handle('wcdb:resolveValidWxid', async (_, dbPath: string, hexKey: string) => {
    try {
      const wxids = dbPathService.scanWxids(dbPath)
      if (wxids.length === 0) {
        return { success: false, error: '未检测到账号目录' }
      }

      for (const wxid of wxids) {
        const result = await wcdbService.testConnection(dbPath, hexKey, wxid)
        if (result.success) {
          return { success: true, wxid }
        }
      }

      return { success: false, error: '未找到可通过当前密钥验证的账号目录' }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('wcdb:open', async (_, dbPath: string, hexKey: string, wxid: string) => {
    return wcdbService.open(dbPath, hexKey, wxid)
  })

  ipcMain.handle('wcdb:close', async () => {
    wcdbService.close()
    return true
  })

  // 数据库解密
  ipcMain.handle('wcdb:decryptDatabase', async (event, dbPath: string, hexKey: string, wxid: string) => {
    logService?.info('Decrypt', '开始解密数据库', { dbPath, wxid })

    try {
      // 使用已有的 dataManagementService 来解密
      const result = await dataManagementService.decryptAll()

      if (result.success) {
        logService?.info('Decrypt', '解密完成', {
          successCount: result.successCount,
          failCount: result.failCount
        })

        return {
          success: true,
          totalFiles: (result.successCount || 0) + (result.failCount || 0),
          successCount: result.successCount,
          failCount: result.failCount
        }
      } else {
        logService?.error('Decrypt', '解密失败', { error: result.error })
        return { success: false, error: result.error }
      }
    } catch (e) {
      logService?.error('Decrypt', '解密异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  // 数据管理相关
  ipcMain.handle('dataManagement:scanDatabases', async () => {
    return dataManagementService.scanDatabases()
  })

  ipcMain.handle('dataManagement:decryptAll', async () => {
    return dataManagementService.decryptAll()
  })

  ipcMain.handle('dataManagement:decryptSingleDatabase', async (_, filePath: string) => {
    return dataManagementService.decryptSingleDatabase(filePath)
  })

  ipcMain.handle('dataManagement:incrementalUpdate', async () => {
    return dataManagementService.incrementalUpdate()
  })

  ipcMain.handle('dataManagement:getCurrentCachePath', async () => {
    return dataManagementService.getCurrentCachePath()
  })

  ipcMain.handle('dataManagement:getDefaultCachePath', async () => {
    return dataManagementService.getDefaultCachePath()
  })

  ipcMain.handle('dataManagement:migrateCache', async (_, newCachePath: string) => {
    return dataManagementService.migrateCache(newCachePath)
  })

  ipcMain.handle('dataManagement:scanImages', async (_, dirPath: string) => {
    return dataManagementService.scanImages(dirPath)
  })

  ipcMain.handle('dataManagement:decryptImages', async (_, dirPath: string) => {
    return dataManagementService.decryptImages(dirPath)
  })

  ipcMain.handle('dataManagement:getImageDirectories', async () => {
    return dataManagementService.getImageDirectories()
  })

  ipcMain.handle('dataManagement:decryptSingleImage', async (_, filePath: string) => {
    return dataManagementService.decryptSingleImage(filePath)
  })

  ipcMain.handle('dataManagement:checkForUpdates', async () => {
    return dataManagementService.checkForUpdates()
  })

  ipcMain.handle('dataManagement:enableAutoUpdate', async (_, intervalSeconds?: number) => {
    dataManagementService.enableAutoUpdate(intervalSeconds)
    return { success: true }
  })

  ipcMain.handle('dataManagement:disableAutoUpdate', async () => {
    dataManagementService.disableAutoUpdate()
    return { success: true }
  })

  ipcMain.handle('dataManagement:autoIncrementalUpdate', async (_, silent?: boolean) => {
    return dataManagementService.autoIncrementalUpdate(silent)
  })

  // 监听更新可用事件
  dataManagementService.onUpdateAvailable((hasUpdate) => {
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('dataManagement:updateAvailable', hasUpdate)
    })
  })

  // 图片解密相关
  ipcMain.handle('imageDecrypt:batchDetectXorKey', async (_, dirPath: string) => {
    try {
      const key = await imageDecryptService.batchDetectXorKey(dirPath)
      return { success: true, key }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('imageDecrypt:decryptImage', async (_, inputPath: string, outputPath: string, xorKey: number, aesKey?: string) => {
    try {
      logService?.info('ImageDecrypt', '开始解密图片', { inputPath, outputPath })
      await imageDecryptService.decryptToFile(inputPath, outputPath, xorKey, aesKey)
      logService?.info('ImageDecrypt', '图片解密成功', { outputPath })
      return { success: true }
    } catch (e) {
      logService?.error('ImageDecrypt', '图片解密失败', { inputPath, error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  // 新的图片解密 API（来自 WeFlow）
  ipcMain.handle('image:decrypt', async (_, payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; force?: boolean }) => {
    const result = await imageDecryptService.decryptImage(payload)
    if (!result.success) {
      logService?.error('ImageDecrypt', '图片解密失败', { payload, error: result.error })
    }
    return result
  })

  ipcMain.handle('image:resolveCache', async (_, payload: { sessionId?: string; imageMd5?: string; imageDatName?: string }) => {
    const result = await imageDecryptService.resolveCachedImage(payload)
    if (!result.success) {
      logService?.warn('ImageDecrypt', '图片缓存解析失败', { payload, error: result.error })
    }
    return result
  })

  ipcMain.handle('image:countThumbnails', async () => {
    return imageDecryptService.countThumbnails()
  })

  ipcMain.handle('image:deleteThumbnails', async () => {
    return imageDecryptService.deleteThumbnails()
  })

  // 视频相关
  ipcMain.handle('video:getVideoInfo', async (_, videoMd5: string, rawContent?: string) => {
    try {
      const result = videoService.getVideoInfo(videoMd5, rawContent)
      return { success: true, ...result }
    } catch (e) {
      return { success: false, error: String(e), exists: false }
    }
  })

  ipcMain.handle('video:readFile', async (_, videoPath: string) => {
    try {
      if (!existsSync(videoPath)) {
        return { success: false, error: '视频文件不存在' }
      }
      const buffer = readFileSync(videoPath)
      const base64 = buffer.toString('base64')
      return { success: true, data: `data:video/mp4;base64,${base64}` }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('video:parseVideoMd5', async (_, content: string) => {
    try {
      const md5 = videoService.parseVideoMd5(content)
      return { success: true, md5 }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 视频号相关
  ipcMain.handle('video:parseChannelVideo', async (_, content: string) => {
    try {
      const videoInfo = videoService.parseChannelVideoFromXml(content)
      return { success: true, videoInfo }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('video:downloadChannelVideo', async (event, videoInfo: any, key?: string) => {
    try {
      const result = await videoService.downloadChannelVideo(
        videoInfo,
        key,
        (progress) => {
          // 发送进度更新到渲染进程
          event.sender.send('video:downloadProgress', {
            objectId: videoInfo.objectId,
            ...progress
          })
        }
      )
      return result
    } catch (e: any) {
      return { success: false, error: e.message || String(e) }
    }
  })

  // 图片密钥获取（通过 DLL 从缓存目录获取 code，用前端 wxid 计算密钥）
  ipcMain.handle('imageKey:getImageKeys', async (event, userDir: string) => {
    logService?.info('ImageKey', '开始获取图片密钥（DLL 本地扫描模式）', { userDir })
    if (process.platform === 'darwin') {
      try {
        const kvcommResult = await wxKeyServiceMac.autoGetImageKey(
          userDir,
          (message) => event.sender.send('imageKey:progress', message)
        )

        if (kvcommResult.success) {
          logService?.info('ImageKey', 'macOS kvcomm 图片密钥获取成功', {
            xorKey: kvcommResult.xorKey,
            aesKey: kvcommResult.aesKey
          })
          return kvcommResult
        }

        logService?.warn('ImageKey', 'macOS kvcomm 方案失败，切换内存扫描', { error: kvcommResult.error })
        event.sender.send('imageKey:progress', 'kvcomm 方案失败，正在尝试内存扫描...')

        const scanResult = await wxKeyServiceMac.autoGetImageKeyByMemoryScan(
          userDir,
          (message) => event.sender.send('imageKey:progress', message)
        )

        if (scanResult.success) {
          logService?.info('ImageKey', 'macOS 内存扫描图片密钥获取成功', {
            xorKey: scanResult.xorKey,
            aesKey: scanResult.aesKey
          })
        } else {
          logService?.error('ImageKey', 'macOS 图片密钥获取失败', { error: scanResult.error })
        }

        return scanResult
      } catch (e) {
        logService?.error('ImageKey', 'macOS 图片密钥获取异常', { error: String(e) })
        return { success: false, error: String(e) }
      }
    }

    try {
      // ========== 方案一：DLL 本地扫描（优先） ==========
      const dllResult = await (async () => {
        const initSuccess = await wxKeyService.initialize()
        if (!initSuccess) {
          logService?.warn('ImageKey', 'DLL 初始化失败，将尝试内存扫描兜底')
          return null
        }

        event.sender.send('imageKey:progress', '正在从缓存目录扫描图片密钥...')

        const result = wxKeyService.getImageKey()
        if (!result.success || !result.json) {
          logService?.warn('ImageKey', 'DLL GetImageKey 失败，将尝试内存扫描兜底', { error: result.error })
          return null
        }

        let parsed: any
        try {
          parsed = JSON.parse(result.json)
        } catch {
          logService?.warn('ImageKey', '解析 DLL 返回数据失败，将尝试内存扫描兜底')
          return null
        }

        const accounts: any[] = parsed.accounts ?? []
        if (!accounts.length || !accounts[0]?.keys?.length) {
          logService?.warn('ImageKey', 'DLL 未返回有效密钥码，将尝试内存扫描兜底')
          return null
        }

        const codes: number[] = accounts[0].keys.map((k: any) => k.code)
        logService?.info('ImageKey', `DLL 提取到 ${codes.length} 个密钥码`, {
          codes,
          dllFoundWxids: accounts.map((a: any) => a.wxid)
        })

        // 从 userDir 提取前端已配置好的正确 wxid
        let targetWxid = ''
        if (userDir) {
          const dirName = userDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
          if (dirName.startsWith('wxid_')) {
            targetWxid = dirName
          }
        }

        if (!targetWxid) {
          targetWxid = accounts[0].wxid
          logService?.warn('ImageKey', '无法从 userDir 提取 wxid，使用 DLL 发现的', { targetWxid })
        }

        // CleanWxid: 截断到第二个下划线
        const cleanWxid = (wxid: string): string => {
          const first = wxid.indexOf('_')
          if (first === -1) return wxid
          const second = wxid.indexOf('_', first + 1)
          if (second === -1) return wxid
          return wxid.substring(0, second)
        }
        const cleanedWxid = cleanWxid(targetWxid)

        const crypto = require('crypto')
        const code = codes[0]
        const xorKey = code & 0xFF
        const dataToHash = code.toString() + cleanedWxid
        const md5Full = crypto.createHash('md5').update(dataToHash).digest('hex')
        const aesKey = md5Full.substring(0, 16)

        event.sender.send('imageKey:progress', `密钥获取成功 (wxid: ${targetWxid}, code: ${code})`)
        logService?.info('ImageKey', '图片密钥获取成功（DLL 模式）', { wxid: targetWxid, code, xorKey, aesKey })

        return { success: true as const, xorKey, aesKey }
      })()

      if (dllResult) return dllResult

      // ========== 方案二：内存扫描兜底 ==========
      logService?.info('ImageKey', '切换到内存扫描兜底方案', { userDir })
      event.sender.send('imageKey:progress', 'DLL 方式失败，正在尝试内存扫描方式...')

      const wechatPid = wxKeyService.getWeChatPid()
      if (!wechatPid) {
        return { success: false, error: '获取图片密钥失败：DLL 扫描失败且未检测到微信进程（内存扫描需要微信正在运行）' }
      }

      logService?.info('ImageKey', '检测到微信进程，开始内存扫描', { pid: wechatPid })

      const memResult = await imageKeyService.getImageKeys(
        userDir,
        wechatPid,
        (msg) => event.sender.send('imageKey:progress', msg)
      )

      if (memResult.success) {
        logService?.info('ImageKey', '图片密钥获取成功（内存扫描兜底）', {
          xorKey: memResult.xorKey,
          aesKey: memResult.aesKey
        })
      } else {
        logService?.error('ImageKey', '内存扫描兜底也失败', { error: memResult.error })
      }

      return memResult
    } catch (e) {
      logService?.error('ImageKey', '图片密钥获取异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  // 聊天相关
  ipcMain.handle('chat:connect', async () => {
    logService?.info('Chat', '尝试连接聊天服务')
    const result = await chatService.connect()
    if (result.success) {
      logService?.info('Chat', '聊天服务连接成功')
    } else {
      // 聊天连接失败可能是数据库未准备好，使用WARN级别
      logService?.warn('Chat', '聊天服务连接失败', { error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getSessions', async (_, offset?: number, limit?: number) => {
    const result = await chatService.getSessions(offset, limit)
    if (!result.success) {
      // 获取会话失败可能是数据库未连接，使用WARN级别
      logService?.warn('Chat', '获取会话列表失败', { error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getContacts', async () => {
    const result = await chatService.getContacts()
    if (!result.success) {
      logService?.warn('Chat', '获取通讯录失败', { error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getMessages', async (_, sessionId: string, offset?: number, limit?: number) => {
    const result = await chatService.getMessages(sessionId, offset, limit)
    if (!result.success) {
      // 获取消息失败可能是数据库未连接，使用WARN级别
      logService?.warn('Chat', '获取消息失败', { sessionId, error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getMessagesBefore', async (
    _,
    sessionId: string,
    cursorSortSeq: number,
    limit?: number,
    cursorCreateTime?: number,
    cursorLocalId?: number
  ) => {
    const result = await chatService.getMessagesBefore(sessionId, cursorSortSeq, limit, cursorCreateTime, cursorLocalId)
    if (!result.success) {
      logService?.warn('Chat', '按游标获取更早消息失败', {
        sessionId,
        cursorSortSeq,
        cursorCreateTime,
        cursorLocalId,
        error: result.error
      })
    }
    return result
  })

  ipcMain.handle('chat:getMessagesAfter', async (
    _,
    sessionId: string,
    cursorSortSeq: number,
    limit?: number,
    cursorCreateTime?: number,
    cursorLocalId?: number
  ) => {
    const result = await chatService.getMessagesAfter(sessionId, cursorSortSeq, limit, cursorCreateTime, cursorLocalId)
    if (!result.success) {
      logService?.warn('Chat', '按游标获取更新消息失败', {
        sessionId,
        cursorSortSeq,
        cursorCreateTime,
        cursorLocalId,
        error: result.error
      })
    }
    return result
  })

  ipcMain.handle('chat:getAllVoiceMessages', async (_, sessionId: string) => {
    const result = await chatService.getAllVoiceMessages(sessionId)

    // 确保 messages 是数组
    if (result.success && result.messages) {
      // 简化消息对象，只保留必要字段
      const simplifiedMessages = result.messages.map(msg => ({
        localId: msg.localId,
        serverId: msg.serverId,
        localType: msg.localType,
        createTime: msg.createTime,
        sortSeq: msg.sortSeq,
        isSend: msg.isSend,
        senderUsername: msg.senderUsername,
        parsedContent: msg.parsedContent || '',
        rawContent: msg.rawContent || '',
        voiceDuration: msg.voiceDuration
      }))

      return {
        success: true,
        messages: simplifiedMessages
      }
    }

    if (!result.success) {
      logService?.warn('Chat', '获取所有语音消息失败', { sessionId, error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getAllImageMessages', async (_, sessionId: string) => {
    return chatService.getAllImageMessages(sessionId)
  })

  ipcMain.handle('chat:getContact', async (_, username: string) => {
    return chatService.getContact(username)
  })

  ipcMain.handle('chat:getContactAvatar', async (_, username: string) => {
    return chatService.getContactAvatar(username)
  })

  ipcMain.handle('chat:resolveTransferDisplayNames', async (_, chatroomId: string, payerUsername: string, receiverUsername: string) => {
    return chatService.resolveTransferDisplayNames(chatroomId, payerUsername, receiverUsername)
  })

  ipcMain.handle('chat:getMyAvatarUrl', async () => {
    const result = chatService.getMyAvatarUrl()
    // 首页会调用这个接口，失败是正常的，不记录错误日志
    return result
  })

  ipcMain.handle('chat:getMyUserInfo', async () => {
    const result = chatService.getMyUserInfo()
    // 首页会调用这个接口，失败是正常的，不记录错误日志
    return result
  })

  ipcMain.handle('chat:downloadEmoji', async (_, cdnUrl: string, md5?: string, productId?: string, createTime?: number, encryptUrl?: string, aesKey?: string) => {
    const result = await chatService.downloadEmoji(cdnUrl, md5, productId, createTime, encryptUrl, aesKey)
    if (!result.success) {
      logService?.warn('Chat', '下载表情失败', { cdnUrl, error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:resolveEmojiPath', async (_, md5?: string, cdnUrl?: string, productId?: string, createTime?: number, encryptUrl?: string, aesKey?: string) => {
    const result = await chatService.downloadEmoji(cdnUrl || '', md5, productId, createTime, encryptUrl, aesKey)
    if (!result.success) {
      logService?.warn('Chat', '解析表情缓存路径失败', { md5, cdnUrl, error: result.error })
      return result
    }
    return {
      success: true,
      cachePath: result.cachePath,
      localPath: result.localPath
    }
  })

  ipcMain.handle('chat:close', async () => {
    logService?.info('Chat', '关闭聊天服务')
    chatService.close()
    return true
  })

  ipcMain.handle('chat:refreshCache', async () => {
    logService?.info('Chat', '刷新消息缓存')
    chatService.refreshMessageDbCache()
    return true
  })

  ipcMain.handle('chat:setCurrentSession', async (_, sessionId: string | null) => {
    chatService.setCurrentSession(sessionId)
    return true
  })

  ipcMain.handle('chat:getSessionDetail', async (_, sessionId: string) => {
    const result = await chatService.getSessionDetail(sessionId)
    if (!result.success) {
      // 获取会话详情失败可能是数据库未连接，使用WARN级别
      logService?.warn('Chat', '获取会话详情失败', { sessionId, error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getVoiceData', async (_, sessionId: string, msgId: string, createTime?: number) => {
    const result = await chatService.getVoiceData(sessionId, msgId, createTime)
    if (!result.success) {
      logService?.warn('Chat', '获取语音数据失败', { sessionId, msgId, createTime, error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getMessagesByDate', async (_, sessionId: string, targetTimestamp: number, limit?: number) => {
    const result = await chatService.getMessagesByDate(sessionId, targetTimestamp, limit)
    if (!result.success) {
      logService?.warn('Chat', '按日期获取消息失败', { sessionId, targetTimestamp, error: result.error })
    }
    return result
  })

  ipcMain.handle('chat:getDatesWithMessages', async (_, sessionId: string, year: number, month: number) => {
    const result = await chatService.getDatesWithMessages(sessionId, year, month)
    if (!result.success) {
      logService?.warn('Chat', '获取有消息日期失败', { sessionId, year, month, error: result.error })
    }
    return result
  })

  // 朋友圈相关
  ipcMain.handle('sns:getTimeline', async (_, limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number) => {
    try {
      const result = await snsService.getTimeline(limit, offset, usernames, keyword, startTime, endTime)

      if (!result.success) {
        // 如果是 WCDB 未初始化错误，返回更友好的提示
        if (result.error?.includes('未初始化')) {
          logService?.warn('SNS', '朋友圈功能需要先连接数据库')
          return {
            success: false,
            error: '请先在首页配置并连接数据库后再使用朋友圈功能'
          }
        }
        logService?.warn('SNS', '获取朋友圈时间线失败', { error: result.error })
      }
      return result
    } catch (e: any) {
      logService?.error('SNS', '获取朋友圈时间线异常', { error: e.message })
      return { success: false, error: `加载失败: ${e.message}` }
    }
  })

  ipcMain.handle('sns:proxyImage', async (_, params: { url: string; key?: string | number }) => {
    const result = await snsService.proxyImage(params.url, params.key)
    if (!result.success) {
      logService?.warn('SNS', '代理朋友圈图片失败', { url: params.url, error: result.error })
    }
    return result
  })

  ipcMain.handle('sns:downloadEmoji', async (_, params: { url: string; encryptUrl?: string; aesKey?: string }) => {
    return snsService.downloadSnsEmoji(params.url, params.encryptUrl, params.aesKey)
  })

  ipcMain.handle('sns:downloadImage', async (_, params: { url: string; key?: string | number }) => {
    const { dialog } = await import('electron')

    try {
      const result = await snsService.downloadImage(params.url, params.key)

      if (!result.success) {
        return { success: false, error: result.error }
      }

      // 弹出保存对话框
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: '保存图片',
        defaultPath: `sns_image_${Date.now()}.jpg`,
        filters: [
          { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      })

      if (canceled || !filePath) {
        return { success: false, error: '用户已取消' }
      }

      // 保存文件
      const fs = await import('fs/promises')
      await fs.writeFile(filePath, result.data!)

      return { success: true }
    } catch (e: any) {
      logService?.error('SNS', '下载朋友圈图片失败', { error: e.message })
      return { success: false, error: e.message }
    }
  })

  // 朋友圈导出写入文件
  ipcMain.handle('sns:writeExportFile', async (_, filePath: string, content: string) => {
    try {
      const fs = await import('fs/promises')
      const path = await import('path')
      // 确保目录存在
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, content, 'utf-8')
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  // 将朋友圈媒体保存到导出目录
  ipcMain.handle('sns:saveMediaToDir', async (_, params: { url: string; key?: string | number; outputDir: string; index: number; md5?: string; isAvatar?: boolean; username?: string; isEmoji?: boolean; encryptUrl?: string; aesKey?: string }) => {
    try {
      const fs = await import('fs/promises')
      const path = await import('path')
      const crypto = await import('crypto')

      // 确保导出目录和 media 子目录存在
      const mediaDir = path.join(params.outputDir, 'media')
      await fs.mkdir(mediaDir, { recursive: true })

      // 生成基于内容的唯一文件名
      let baseName: string
      if (params.isAvatar && params.username) {
        // 头像：用 avatar_username
        baseName = `avatar_${params.username.replace(/[^a-zA-Z0-9_]/g, '_')}`
      } else if (params.isEmoji) {
        // 表情包：用 MD5（或者 encryptUrl/url 的 hash）加上 emoji 前缀
        const hashTarget = params.md5 || params.encryptUrl || params.url
        baseName = `emoji_${params.md5 || crypto.createHash('md5').update(hashTarget).digest('hex')}`
      } else if (params.md5) {
        // 有 MD5 直接使用
        baseName = params.md5
      } else {
        // 没有 MD5，用 URL 的 hash
        baseName = crypto.createHash('md5').update(params.url).digest('hex')
      }

      // 如果是表情包，走单独的下载接口
      if (params.isEmoji) {
        const result = await snsService.downloadSnsEmoji(params.url, params.encryptUrl, params.aesKey)
        if (!result.success || !result.localPath) {
          return { success: false, error: result.error || '表情包下载失败' }
        }

        const ext = path.extname(result.localPath) || '.gif'
        const fileName = `${baseName}${ext}`
        const filePath = path.join(mediaDir, fileName)

        // 如果文件已存在则跳过
        try {
          await fs.access(filePath)
          return { success: true, fileName }
        } catch { }

        await fs.copyFile(result.localPath, filePath)
        return { success: true, fileName }
      }

      // 默认走下载并解密媒体，传入 md5 提高缓存命中率
      const result = await snsService.downloadImage(params.url, params.key, params.md5)

      if (!result.success) {
        return { success: false, error: result.error || '下载失败' }
      }

      // 根据 contentType 确定文件后缀
      let ext = '.jpg'
      if (result.contentType?.includes('png')) ext = '.png'
      else if (result.contentType?.includes('gif')) ext = '.gif'
      else if (result.contentType?.includes('webp')) ext = '.webp'
      else if (result.contentType?.includes('video')) ext = '.mp4'

      const fileName = `${baseName}${ext}`
      const filePath = path.join(mediaDir, fileName)

      // 如果文件已存在则跳过（避免重复下载）
      try {
        await fs.access(filePath)
        return { success: true, fileName }
      } catch {
        // 文件不存在，继续下载
      }

      if (result.data) {
        // 有二进制数据，直接写入
        await fs.writeFile(filePath, result.data)
      } else if (result.cachePath) {
        // 没有 data 但有缓存路径（视频已缓存的情况），复制缓存文件
        await fs.copyFile(result.cachePath, filePath)
      } else {
        return { success: false, error: '无可用数据' }
      }

      return { success: true, fileName }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  // 导出相关
  ipcMain.handle('export:exportSessions', async (event, sessionIds: string[], outputDir: string, options: ExportOptions) => {
    return exportService.exportSessions(sessionIds, outputDir, options, (progress) => {
      event.sender.send('export:progress', progress)
    })
  })

  ipcMain.handle('export:exportSession', async (event, sessionId: string, outputPath: string, options: ExportOptions) => {
    return exportService.exportSessionToChatLab(sessionId, outputPath, options, (progress) => {
      event.sender.send('export:progress', progress)
    })
  })

  ipcMain.handle('export:exportContacts', async (event, outputDir: string, options: any) => {
    return exportService.exportContacts(outputDir, options, (progress) => {
      event.sender.send('export:progress', progress)
    })
  })

  // 数据分析相关
  ipcMain.handle('analytics:getOverallStatistics', async () => {
    return analyticsService.getOverallStatistics()
  })

  ipcMain.handle('analytics:getContactRankings', async (_, limit?: number) => {
    return analyticsService.getContactRankings(limit)
  })

  ipcMain.handle('analytics:getTimeDistribution', async () => {
    return analyticsService.getTimeDistribution()
  })

  // 群聊分析相关
  ipcMain.handle('groupAnalytics:getGroupChats', async () => {
    return groupAnalyticsService.getGroupChats()
  })

  ipcMain.handle('groupAnalytics:getGroupMembers', async (_, chatroomId: string) => {
    return groupAnalyticsService.getGroupMembers(chatroomId)
  })

  ipcMain.handle('groupAnalytics:getGroupMessageRanking', async (_, chatroomId: string, limit?: number, startTime?: number, endTime?: number) => {
    return groupAnalyticsService.getGroupMessageRanking(chatroomId, limit, startTime, endTime)
  })

  ipcMain.handle('groupAnalytics:getGroupActiveHours', async (_, chatroomId: string, startTime?: number, endTime?: number) => {
    return groupAnalyticsService.getGroupActiveHours(chatroomId, startTime, endTime)
  })

  ipcMain.handle('groupAnalytics:getGroupMediaStats', async (_, chatroomId: string, startTime?: number, endTime?: number) => {
    return groupAnalyticsService.getGroupMediaStats(chatroomId, startTime, endTime)
  })

  // 打开独立聊天窗口
  ipcMain.handle('window:openChatWindow', async () => {
    createChatWindow()
    return true
  })

  // 打开朋友圈窗口
  ipcMain.handle('window:openMomentsWindow', async (_event, filterUsername?: string) => {
    createMomentsWindow(filterUsername)
    return true
  })

  // 打开群聊分析窗口
  ipcMain.handle('window:openGroupAnalyticsWindow', async () => {
    createGroupAnalyticsWindow()
    return true
  })

  // 打开年度报告窗口
  ipcMain.handle('window:openAnnualReportWindow', async (_, year: number) => {
    createAnnualReportWindow(year)
    return true
  })

  // 打开协议窗口
  ipcMain.handle('window:openAgreementWindow', async () => {
    createAgreementWindow()
    return true
  })

  // 打开购买窗口
  ipcMain.handle('window:openPurchaseWindow', async () => {
    createPurchaseWindow()
    return true
  })

  // 打开引导窗口
  ipcMain.handle('window:openWelcomeWindow', async (_, mode?: 'default' | 'add-account') => {
    createWelcomeWindow(mode || 'default')
    return true
  })

  // 完成引导（关闭引导窗口，显示主窗口）
  ipcMain.handle('window:completeWelcome', async () => {
    if (welcomeWindow && !welcomeWindow.isDestroyed()) {
      welcomeWindow.close()
    }

    // 如果主窗口还不存在，创建它
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createWindow()
    } else {
      // 如果主窗口已存在，显示并聚焦
      mainWindow.show()
      mainWindow.focus()
    }

    return true
  })

  // 年度报告相关
  ipcMain.handle('annualReport:getAvailableYears', async () => {
    return annualReportService.getAvailableYears()
  })

  ipcMain.handle('annualReport:generateReport', async (_, year: number) => {
    return annualReportService.generateReport(year)
  })

  // 检查聊天窗口是否打开
  ipcMain.handle('window:isChatWindowOpen', async () => {
    return chatWindow !== null && !chatWindow.isDestroyed()
  })

  // 关闭聊天窗口
  ipcMain.handle('window:closeChatWindow', async () => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.close()
      chatWindow = null
    }
    return true
  })

  // 调整窗口大小以适应内容
  ipcMain.handle('window:resizeContent', async (event, width: number, height: number) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      // 获取当前屏幕的工作区大小
      const { screen } = require('electron')
      // 获取窗口所在的屏幕
      const currentScreen = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      const workArea = currentScreen.workAreaSize

      // 限制窗口大小不超过屏幕的 85%
      const maxWidth = Math.floor(workArea.width * 0.85)
      const maxHeight = Math.floor(workArea.height * 0.85)

      let targetWidth = width
      let targetHeight = height

      // 保持宽高比进行缩放
      if (targetWidth > maxWidth || targetHeight > maxHeight) {
        const ratio = Math.min(maxWidth / targetWidth, maxHeight / targetHeight)
        targetWidth = Math.floor(targetWidth * ratio)
        targetHeight = Math.floor(targetHeight * ratio)
      }

      // 确保最小尺寸
      const finalWidth = Math.max(targetWidth, 400)
      const finalHeight = Math.max(targetHeight, 300)

      win.setSize(finalWidth, finalHeight)
      win.center() // 居中显示
    }
    return true
  })

  // 接收渲染进程的拖动指令
  ipcMain.on('window:move', (event, { x, y }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) {
      const bounds = win.getBounds()
      win.setBounds({
        x: bounds.x + x,
        y: bounds.y + y,
        width: bounds.width,
        height: bounds.height
      })
    }
  })

  // 激活相关
  ipcMain.handle('activation:getDeviceId', async () => {
    return activationService.getDeviceId()
  })

  ipcMain.handle('activation:verifyCode', async (_, code: string) => {
    return activationService.verifyCode(code)
  })

  ipcMain.handle('activation:activate', async (_, code: string) => {
    return activationService.activate(code)
  })

  ipcMain.handle('activation:checkStatus', async () => {
    return activationService.checkActivation()
  })

  ipcMain.handle('activation:getTypeDisplayName', async (_, type: string | null) => {
    return activationService.getTypeDisplayName(type)
  })

  ipcMain.handle('activation:clearCache', async () => {
    activationService.clearCache()
    return true
  })

  // 缓存管理
  ipcMain.handle('cache:clearImages', async () => {
    logService?.info('Cache', '开始清除图片缓存')
    try {
      const cacheService = new (await import('./services/cacheService')).CacheService(configService!)
      const result = await cacheService.clearImages()
      if (result.success) {
        logService?.info('Cache', '图片缓存清除成功')
      } else {
        logService?.error('Cache', '图片缓存清除失败', { error: result.error })
      }
      return result
    } catch (e) {
      logService?.error('Cache', '图片缓存清除异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('cache:clearEmojis', async () => {
    logService?.info('Cache', '开始清除表情包缓存')
    try {
      const cacheService = new (await import('./services/cacheService')).CacheService(configService!)
      const result = await cacheService.clearEmojis()
      if (result.success) {
        logService?.info('Cache', '表情包缓存清除成功')
      } else {
        logService?.error('Cache', '表情包缓存清除失败', { error: result.error })
      }
      return result
    } catch (e) {
      logService?.error('Cache', '表情包缓存清除异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('cache:clearDatabases', async () => {
    logService?.info('Cache', '开始清除数据库缓存')
    try {
      const cacheService = new (await import('./services/cacheService')).CacheService(configService!)
      const result = await cacheService.clearDatabases()
      if (result.success) {
        logService?.info('Cache', '数据库缓存清除成功')
      } else {
        logService?.error('Cache', '数据库缓存清除失败', { error: result.error })
      }
      return result
    } catch (e) {
      logService?.error('Cache', '数据库缓存清除异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('cache:clearAll', async () => {
    logService?.info('Cache', '开始清除所有缓存')
    try {
      const cacheService = new (await import('./services/cacheService')).CacheService(configService!)
      const result = await cacheService.clearAll()
      if (result.success) {
        logService?.info('Cache', '所有缓存清除成功')
      } else {
        logService?.error('Cache', '所有缓存清除失败', { error: result.error })
      }
      return result
    } catch (e) {
      logService?.error('Cache', '所有缓存清除异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('cache:clearConfig', async () => {
    logService?.info('Cache', '开始清除配置')
    try {
      const cacheService = new (await import('./services/cacheService')).CacheService(configService!)
      const result = await cacheService.clearConfig()
      if (result.success) {
        logService?.info('Cache', '配置清除成功')
      } else {
        logService?.error('Cache', '配置清除失败', { error: result.error })
      }
      return result
    } catch (e) {
      logService?.error('Cache', '配置清除异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('cache:clearCurrentAccount', async (_, deleteLocalData = false) => {
    logService?.info('Cache', '开始清除当前账号配置', { deleteLocalData })
    try {
      const cacheService = new (await import('./services/cacheService')).CacheService(configService!)
      return await cacheService.clearCurrentAccount(deleteLocalData)
    } catch (e) {
      logService?.error('Cache', '清除当前账号配置异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('cache:clearAllAccountConfigs', async () => {
    logService?.info('Cache', '开始清空全部账号配置')
    try {
      const cacheService = new (await import('./services/cacheService')).CacheService(configService!)
      return await cacheService.clearAllAccountConfigs()
    } catch (e) {
      logService?.error('Cache', '清空全部账号配置异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('cache:getCacheSize', async () => {
    try {
      const cacheService = new (await import('./services/cacheService')).CacheService(configService!)
      return await cacheService.getCacheSize()
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 日志管理
  ipcMain.handle('log:getLogFiles', async () => {
    try {
      return { success: true, files: logService?.getLogFiles() || [] }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('log:readLogFile', async (_, filename: string) => {
    try {
      const content = logService?.readLogFile(filename)
      return { success: true, content }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('log:clearLogs', async () => {
    try {
      return logService?.clearLogs() || { success: false, error: '日志服务未初始化' }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('log:getLogSize', async () => {
    try {
      const size = logService?.getLogSize() || 0
      return { success: true, size }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('log:getLogDirectory', async () => {
    try {
      const directory = logService?.getLogDirectory() || ''
      return { success: true, directory }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('log:setLogLevel', async (_, level: string) => {
    try {
      if (!logService) {
        return { success: false, error: '日志服务未初始化' }
      }

      let logLevel: number
      switch (level.toUpperCase()) {
        case 'DEBUG':
          logLevel = 0
          break
        case 'INFO':
          logLevel = 1
          break
        case 'WARN':
          logLevel = 2
          break
        case 'ERROR':
          logLevel = 3
          break
        default:
          return { success: false, error: '无效的日志级别' }
      }

      logService.setLogLevel(logLevel)
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('log:getLogLevel', async () => {
    try {
      if (!logService) {
        return { success: false, error: '日志服务未初始化' }
      }

      const level = logService.getLogLevel()
      const levelNames = ['DEBUG', 'INFO', 'WARN', 'ERROR']
      return { success: true, level: levelNames[level] }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // ========== 语音转文字 (STT) ==========

  // 获取模型状态
  ipcMain.handle('stt:getModelStatus', async () => {
    try {
      return await voiceTranscribeService.getModelStatus()
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 下载模型
  ipcMain.handle('stt:downloadModel', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      return await voiceTranscribeService.downloadModel((progress) => {
        win?.webContents.send('stt:downloadProgress', progress)
      })
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 转写音频
  ipcMain.handle('stt:transcribe', async (event, wavBase64: string, sessionId: string, createTime: number, force?: boolean) => {
    try {
      // 先查缓存
      if (!force) {
        const cached = voiceTranscribeService.getCachedTranscript(sessionId, createTime)
        if (cached) {
          return { success: true, transcript: cached, cached: true }
        }
      }

      const wavData = Buffer.from(wavBase64, 'base64')
      const win = BrowserWindow.fromWebContents(event.sender)

      // 检查用户设置的 STT 模式
      const sttMode = await configService?.get('sttMode') || 'cpu'
      console.log('[Main] 读取到的 STT 模式配置:', sttMode)
      console.log('[Main] configService 是否存在:', !!configService)

      // 调试：打印所有配置
      if (configService) {
        const allConfig = {
          sttMode: await configService.get('sttMode'),
          whisperModelType: await configService.get('whisperModelType')
        }
        console.log('[Main] 当前所有 STT 配置:', allConfig)
      }

      let result: { success: boolean; transcript?: string; error?: string }

      if (sttMode === 'gpu') {
        // 使用 Whisper GPU 加速
        console.log('[Main] 使用 Whisper GPU 模式')
        const whisperModelType = await configService?.get('whisperModelType') || 'small'

        result = await voiceTranscribeServiceWhisper.transcribeWavBuffer(
          wavData,
          whisperModelType as any,
          'auto' // 自动识别语言
        )
      } else if (sttMode === 'online') {
        console.log('[Main] 使用在线 STT 模式')
        result = await voiceTranscribeServiceOnline.transcribeWavBuffer(wavData, (text) => {
          win?.webContents.send('stt:partialResult', text)
        })
      } else {
        // 使用 SenseVoice CPU 模式
        console.log('[Main] 使用 SenseVoice CPU 模式')
        result = await voiceTranscribeService.transcribeWavBuffer(wavData, (text) => {
          win?.webContents.send('stt:partialResult', text)
        })
      }

      // 转写成功，保存缓存
      if (result.success && result.transcript) {
        voiceTranscribeService.saveTranscriptCache(sessionId, createTime, result.transcript)
      }

      return result
    } catch (e) {
      console.error('[Main] stt:transcribe 异常:', e)
      return { success: false, error: String(e) }
    }
  })

  // 获取缓存的转写结果
  ipcMain.handle('stt:getCachedTranscript', async (_, sessionId: string, createTime: number) => {
    try {
      const transcript = voiceTranscribeService.getCachedTranscript(sessionId, createTime)
      return { success: true, transcript }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 更新转写缓存
  ipcMain.handle('stt:updateTranscript', async (_, sessionId: string, createTime: number, transcript: string) => {
    try {
      voiceTranscribeService.saveTranscriptCache(sessionId, createTime, transcript)
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('stt-online:test-config', async (_, overrides?: {
    provider?: 'openai-compatible' | 'aliyun-qwen-asr' | 'custom'
    apiKey?: string
    baseURL?: string
    model?: string
    language?: string
    timeoutMs?: number
  }) => {
    try {
      return await voiceTranscribeServiceOnline.testConfig(overrides)
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // ========== Whisper GPU 加速 ==========

  // 清除模型
  ipcMain.handle('stt:clearModel', async () => {
    return await voiceTranscribeService.clearModel()
  })

  // ========== Whisper GPU 加速 (新方案) ==========

  // 检测 GPU
  ipcMain.handle('stt-whisper:detect-gpu', async () => {
    try {
      return await voiceTranscribeServiceWhisper.detectGPU()
    } catch (e) {
      return { available: false, provider: 'CPU', info: String(e) }
    }
  })

  // 检查模型状态
  ipcMain.handle('stt-whisper:check-model', async (_, modelType: string) => {
    try {
      return await voiceTranscribeServiceWhisper.getModelStatus(modelType as any)
    } catch (e) {
      return { exists: false, error: String(e) }
    }
  })

  // 下载模型
  ipcMain.handle('stt-whisper:download-model', async (event, modelType: string) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      return await voiceTranscribeServiceWhisper.downloadModel(
        modelType as any,
        (progress) => {
          win?.webContents.send('stt-whisper:download-progress', progress)
        }
      )
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 清除模型
  ipcMain.handle('stt-whisper:clear-model', async (_, modelType: string) => {
    try {
      return await voiceTranscribeServiceWhisper.clearModel(modelType as any)
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 语音识别
  ipcMain.handle('stt-whisper:transcribe', async (_, wavData: Buffer, options: {
    modelType?: string
    language?: string
  }) => {
    try {
      return await voiceTranscribeServiceWhisper.transcribeWavBuffer(
        wavData,
        (options.modelType || 'small') as any,
        options.language || 'auto'
      )
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 下载 GPU 组件
  ipcMain.handle('stt-whisper:download-gpu-components', async (event) => {
    try {
      if (!configService) {
        return { success: false, error: '配置服务未初始化' }
      }

      const cachePath = configService.get('cachePath')
      if (!cachePath) {
        return { success: false, error: '请先设置缓存目录' }
      }

      const win = BrowserWindow.fromWebContents(event.sender)
      const gpuDir = join(cachePath, 'whisper-gpu')

      // 确保目录存在
      if (!existsSync(gpuDir)) {
        mkdirSync(gpuDir, { recursive: true })
      }

      const zipUrl = 'https://miyuapp.aiqji.com/whisper.zip'
      const zipPath = join(gpuDir, 'whisper.zip')
      const tempPath = zipPath + '.tmp'

      console.log('[Whisper GPU] 开始下载:', zipUrl)
      console.log('[Whisper GPU] 保存到:', zipPath)

      const fs = require('fs')
      const https = require('https')

      // 格式化速度
      const formatSpeed = (bytesPerSecond: number): string => {
        if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`
        if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`
        return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`
      }

      // 格式化大小
      const formatSize = (bytes: number): string => {
        if (bytes < 1024) return `${bytes} B`
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
        return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
      }

      // 检查是否有未完成的下载
      let downloadedBytes = 0
      if (existsSync(tempPath)) {
        const stats = fs.statSync(tempPath)
        downloadedBytes = stats.size
        console.log('[Whisper GPU] 发现未完成的下载，已下载:', formatSize(downloadedBytes))
      }

      // 分块下载函数（更可靠）
      const downloadInChunks = async (): Promise<void> => {
        // 先获取文件总大小
        const getFileSize = (): Promise<number> => {
          return new Promise((resolve, reject) => {
            https.get(zipUrl, { method: 'HEAD' }, (res: any) => {
              if (res.statusCode === 200) {
                const size = parseInt(res.headers['content-length'] || '0')
                resolve(size)
              } else {
                reject(new Error(`获取文件大小失败: ${res.statusCode}`))
              }
            }).on('error', reject)
          })
        }

        const totalBytes = await getFileSize()
        console.log('[Whisper GPU] 文件总大小:', formatSize(totalBytes))

        // 如果已经下载完成
        if (downloadedBytes >= totalBytes) {
          console.log('[Whisper GPU] 文件已下载完成')
          if (existsSync(tempPath)) {
            fs.renameSync(tempPath, zipPath)
          }
          return
        }

        // 分块大小：10MB
        const chunkSize = 10 * 1024 * 1024
        let currentBytes = downloadedBytes

        // 打开文件流（追加模式）
        const fileStream = fs.createWriteStream(tempPath, { flags: 'a' })

        let lastProgressTime = Date.now()
        let lastCurrentBytes = currentBytes

        while (currentBytes < totalBytes) {
          const start = currentBytes
          const end = Math.min(currentBytes + chunkSize - 1, totalBytes - 1)

          console.log(`[Whisper GPU] 下载块: ${formatSize(start)} - ${formatSize(end)}`)

          // 下载单个块（带重试）
          const downloadChunk = async (retries = 5): Promise<void> => {
            for (let attempt = 1; attempt <= retries; attempt++) {
              try {
                await new Promise<void>((resolve, reject) => {
                  const options = {
                    headers: {
                      'Range': `bytes=${start}-${end}`
                    }
                  }

                  const request = https.get(zipUrl, options, (res: any) => {
                    if (res.statusCode !== 206 && res.statusCode !== 200) {
                      reject(new Error(`HTTP ${res.statusCode}`))
                      return
                    }

                    let chunkBytes = 0

                    res.on('data', (chunk: Buffer) => {
                      fileStream.write(chunk)
                      chunkBytes += chunk.length
                      currentBytes += chunk.length

                      // 更新进度（每500ms）
                      const now = Date.now()
                      if (now - lastProgressTime > 500) {
                        const percent = (currentBytes / totalBytes) * 100
                        const speed = (currentBytes - lastCurrentBytes) / ((now - lastProgressTime) / 1000)

                        win?.webContents.send('stt-whisper:gpu-download-progress', {
                          currentFile: `下载中 (${formatSpeed(speed)}) - ${formatSize(currentBytes)}/${formatSize(totalBytes)}`,
                          fileProgress: percent,
                          overallProgress: percent * 0.9, // 留10%给解压
                          completedFiles: 0,
                          totalFiles: 1
                        })

                        lastProgressTime = now
                        lastCurrentBytes = currentBytes
                      }
                    })

                    res.on('end', () => {
                      console.log(`[Whisper GPU] 块下载完成: ${formatSize(chunkBytes)}`)
                      resolve()
                    })

                    res.on('error', reject)
                  })

                  request.on('error', reject)
                  request.setTimeout(30000, () => {
                    request.destroy()
                    reject(new Error('请求超时'))
                  })
                })

                // 下载成功，跳出重试循环
                break
              } catch (error) {
                console.error(`[Whisper GPU] 块下载失败 (尝试 ${attempt}/${retries}):`, error)

                // 回退到块开始位置
                currentBytes = start

                if (attempt < retries) {
                  const waitTime = Math.min(attempt * 1000, 5000) // 最多等5秒
                  console.log(`[Whisper GPU] ${waitTime / 1000} 秒后重试...`)
                  await new Promise(r => setTimeout(r, waitTime))
                } else {
                  fileStream.close()
                  throw new Error(`块下载失败: ${error}`)
                }
              }
            }
          }

          await downloadChunk()
        }

        // 关闭文件流
        await new Promise<void>((resolve, reject) => {
          fileStream.end(() => {
            console.log('[Whisper GPU] 文件流已关闭')
            resolve()
          })
          fileStream.on('error', reject)
        })

        // 重命名临时文件
        if (existsSync(tempPath)) {
          fs.renameSync(tempPath, zipPath)
          console.log('[Whisper GPU] 下载完成')
        }
      }

      // 执行下载
      await downloadInChunks()

      console.log('[Whisper GPU] 下载完成，开始解压...')

      // 解压 ZIP 文件
      const AdmZip = require('adm-zip')
      const zip = new AdmZip(zipPath)
      const zipEntries = zip.getEntries()

      // 遍历所有文件，直接解压到 gpuDir（跳过文件夹结构）
      for (const entry of zipEntries) {
        if (!entry.isDirectory) {
          // 获取文件名（不包含路径）
          const fileName = entry.entryName.split('/').pop() || entry.entryName.split('\\').pop()
          if (fileName) {
            const targetPath = join(gpuDir, fileName)
            console.log('[Whisper GPU] 解压文件:', fileName)
            fs.writeFileSync(targetPath, entry.getData())
          }
        }
      }

      console.log('[Whisper GPU] 解压完成')

      // 删除 ZIP 文件
      fs.unlinkSync(zipPath)

      // 发送完成进度
      win?.webContents.send('stt-whisper:gpu-download-progress', {
        currentFile: '完成',
        fileProgress: 100,
        overallProgress: 100,
        completedFiles: 1,
        totalFiles: 1
      })

      // 重新设置 GPU 组件目录
      voiceTranscribeServiceWhisper.setGPUComponentsDir(cachePath)

      console.log('[Whisper GPU] GPU 组件安装完成')
      return { success: true }
    } catch (e) {
      console.error('[Whisper GPU] 下载失败:', e)
      return { success: false, error: String(e) }
    }
  })

  // 检查 GPU 组件状态
  ipcMain.handle('stt-whisper:check-gpu-components', async () => {
    try {
      if (!configService) {
        return { installed: false, reason: '配置服务未初始化' }
      }

      const cachePath = configService.get('cachePath')
      if (!cachePath) {
        return { installed: false, reason: '未设置缓存目录' }
      }

      const gpuDir = join(cachePath, 'whisper-gpu')
      const requiredFiles = [
        'whisper-cli.exe',
        'whisper.dll',
        'ggml.dll',
        'ggml-base.dll',
        'ggml-cpu.dll',
        'ggml-cuda.dll',
        'SDL2.dll',
        'cudart64_12.dll',
        'cublas64_12.dll',
        'cublasLt64_12.dll'
      ]

      const missingFiles = requiredFiles.filter(f => !existsSync(join(gpuDir, f)))

      return {
        installed: missingFiles.length === 0,
        missingFiles,
        gpuDir
      }
    } catch (e) {
      return { installed: false, error: String(e) }
    }
  })

  // AI 摘要相关
  ipcMain.handle('ai:getProviders', async () => {
    try {
      return aiService.getAllProviders()
    } catch (e) {
      console.error('[AI] 获取提供商列表失败:', e)
      return []
    }
  })

  // 代理相关
  ipcMain.handle('ai:getProxyStatus', async () => {
    try {
      const proxyUrl = await proxyService.getSystemProxy()
      return {
        success: true,
        hasProxy: !!proxyUrl,
        proxyUrl: proxyUrl || null
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:refreshProxy', async () => {
    try {
      proxyService.clearCache()
      const proxyUrl = await proxyService.getSystemProxy()
      return {
        success: true,
        hasProxy: !!proxyUrl,
        proxyUrl: proxyUrl || null,
        message: proxyUrl ? `已刷新代理: ${proxyUrl}` : '未检测到代理，使用直连'
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:testProxy', async (_, proxyUrl: string, testUrl?: string) => {
    try {
      const success = await proxyService.testProxy(proxyUrl, testUrl)
      return {
        success,
        message: success ? '代理连接正常' : '代理连接失败'
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:testConnection', async (_, provider: string, apiKey: string) => {
    try {
      return await aiService.testConnection(provider, apiKey)
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:estimateCost', async (_, messageCount: number, provider: string) => {
    try {
      // 简单估算：每条消息约50个字符，约33 tokens
      const estimatedTokens = messageCount * 33
      const cost = aiService.estimateCost(estimatedTokens, provider)
      return { success: true, tokens: estimatedTokens, cost }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:getUsageStats', async (_, startDate?: string, endDate?: string) => {
    try {
      const stats = aiService.getUsageStats(startDate, endDate)
      return { success: true, stats }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:getSummaryHistory', async (_, sessionId: string, limit?: number) => {
    try {
      const history = aiService.getSummaryHistory(sessionId, limit)
      return { success: true, history }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:listSessionQAConversations', async (_, sessionId: string, limit?: number) => {
    try {
      return { success: true, conversations: aiService.listSessionQAConversations(sessionId, limit) }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:getSessionQAConversation', async (_, conversationId: number) => {
    try {
      const conversation = aiService.getSessionQAConversation(conversationId)
      return conversation
        ? { success: true, conversation }
        : { success: false, error: '问答会话不存在或已删除' }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:createSessionQAConversation', async (_, options: {
    sessionId: string
    sessionName?: string
    linkedSummaryId?: number
  }) => {
    try {
      return { success: true, conversation: aiService.createSessionQAConversation(options) }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:renameSessionQAConversation', async (_, conversationId: number, title: string) => {
    try {
      const success = aiService.renameSessionQAConversation(conversationId, title)
      return { success }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:deleteSessionQAConversation', async (_, conversationId: number) => {
    try {
      const success = aiService.deleteSessionQAConversation(conversationId)
      return { success }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:deleteSummary', async (_, id: number) => {
    try {
      const success = aiService.deleteSummary(id)
      return { success }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:renameSummary', async (_, id: number, customName: string) => {
    try {
      const success = aiService.renameSummary(id, customName)
      return { success }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:cleanExpiredCache', async () => {
    try {
      aiService.cleanExpiredCache()
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 读取 AI 服务使用指南
  ipcMain.handle('ai:readGuide', async (_, guideName: string) => {
    try {
      const guidePath = join(__dirname, '../electron/services/ai', guideName)
      if (!existsSync(guidePath)) {
        return { success: false, error: '指南文件不存在' }
      }
      const content = readFileSync(guidePath, 'utf-8')
      return { success: true, content }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:generateSummary', async (event, sessionId: string, timeRange: number, options: {
    provider: string
    apiKey: string
    model: string
    detail: 'simple' | 'normal' | 'detailed'
    systemPromptPreset?: 'default' | 'decision-focus' | 'action-focus' | 'risk-focus' | 'custom'
    customSystemPrompt?: string
    customRequirement?: string
    sessionName?: string
    enableThinking?: boolean
  }) => {
    try {

      // 初始化服务
      aiService.init()

      // 计算时间范围
      const endTime = Math.floor(Date.now() / 1000)
      const startTime = timeRange > 0 ? endTime - (timeRange * 24 * 60 * 60) : undefined

      // 获取指定时间范围内的消息，超出上限时优先保留范围内最新消息。
      const messageLimit = configService?.get('aiMessageLimit') || 3000
      const messagesResult = await chatService.getMessagesByTimeRangeForSummary(sessionId, {
        startTime,
        endTime,
        limit: messageLimit
      })
      if (!messagesResult.success || !messagesResult.messages) {
        return { success: false, error: '获取消息失败' }
      }

      const summaryMessages = messagesResult.messages
      if (summaryMessages.length === 0) {
        return { success: false, error: '该时间范围内没有消息' }
      }

      const actualTimeRangeStart = startTime ?? summaryMessages[0].createTime
      const inputMessageScopeNote = messagesResult.hasMore
        ? `当前时间范围内消息较多，本次仅分析其中最新 ${summaryMessages.length} 条消息。请明确基于这批最新消息归纳重点，避免误判为已覆盖完整时间范围。`
        : undefined

      // 获取消息中所有发送者的联系人信息
      const contacts = new Map()
      const senderSet = new Set<string>()

      // 添加会话对象
      senderSet.add(sessionId)

      // 添加所有消息发送者
      summaryMessages.forEach((msg: any) => {
        if (msg.senderUsername) {
          senderSet.add(msg.senderUsername)
        }
      })

      // 添加自己
      const myWxid = configService?.get('myWxid')
      if (myWxid) {
        senderSet.add(myWxid)
      }

      // 批量获取联系人信息
      for (const username of Array.from(senderSet)) {
        // 如果是自己，优先尝试获取详细用户信息
        if (username === myWxid) {
          const selfInfo = await chatService.getMyUserInfo()
          if (selfInfo.success && selfInfo.userInfo) {
            contacts.set(username, {
              username: selfInfo.userInfo.wxid,
              remark: '',
              nickName: selfInfo.userInfo.nickName,
              alias: selfInfo.userInfo.alias
            })
            continue // 已获取到，跳过后续常规查找
          }
        }

        // 常规查找
        const contact = await chatService.getContact(username)
        if (contact) {
          contacts.set(username, contact)
        }
      }

      // 生成摘要（流式输出）
      const result = await aiService.generateSummary(
        summaryMessages,
        contacts,
        {
          sessionId,
          timeRangeDays: timeRange,
          timeRangeStart: actualTimeRangeStart,
          timeRangeEnd: endTime,
          inputMessageScopeNote,
          provider: options.provider,
          apiKey: options.apiKey,
          model: options.model,
          detail: options.detail,
          systemPromptPreset: options.systemPromptPreset,
          customSystemPrompt: options.customSystemPrompt,
          customRequirement: options.customRequirement,
          sessionName: options.sessionName,
          enableThinking: options.enableThinking
        },
        (chunk: string) => {
          // 发送流式数据到渲染进程
          event.sender.send('ai:summaryChunk', chunk)
        }
      )

      if (process.env.NODE_ENV === 'development') {
        console.log('[AI] 摘要生成完成，结果:', {
          sessionId: result.sessionId,
          messageCount: result.messageCount,
          hasMore: Boolean(messagesResult.hasMore),
          summaryLength: result.summaryText?.length || 0
        })
      }

      return { success: true, result }
    } catch (e) {
      console.error('[AI] 生成摘要失败:', e)
      logService?.error('AI', '生成摘要失败', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:askSessionQuestion', async (event, options: {
    sessionId: string
    sessionName?: string
    question: string
    summaryText?: string
    structuredAnalysis?: any
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
    provider: string
    apiKey: string
    model: string
    enableThinking?: boolean
  }) => {
    try {

      aiService.init()

      const result = await aiService.answerSessionQuestion(
        {
          sessionId: options.sessionId,
          sessionName: options.sessionName,
          question: options.question,
          summaryText: options.summaryText,
          structuredAnalysis: options.structuredAnalysis,
          history: options.history,
          provider: options.provider,
          apiKey: options.apiKey,
          model: options.model,
          enableThinking: options.enableThinking
        },
        (chunk: string) => {
          event.sender.send('ai:sessionQaChunk', chunk)
        },
        (progress) => {
          event.sender.send('ai:sessionQaProgress', progress)
        }
      )

      return { success: true, result }
    } catch (e) {
      console.error('[AI] 单会话问答失败:', e)
      logService?.error('AI', '单会话问答失败', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:startSessionQuestion', async (event, options: {
    requestId?: string
    conversationId?: number
    sessionId: string
    sessionName?: string
    question: string
    summaryText?: string
    structuredAnalysis?: any
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
    provider: string
    apiKey: string
    model: string
    enableThinking?: boolean
  }) => {
    try {
      const { sessionQAJobService } = await import('./services/ai/sessionQAJobService')
      return sessionQAJobService.start(options, event.sender)
    } catch (e) {
      console.error('[AI] 启动单会话问答任务失败:', e)
      logService?.error('AI', '启动单会话问答任务失败', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:cancelSessionQuestion', async (_, requestId: string) => {
    try {
      const { sessionQAJobService } = await import('./services/ai/sessionQAJobService')
      return await sessionQAJobService.cancel(requestId)
    } catch (e) {
      console.error('[AI] 取消单会话问答任务失败:', e)
      logService?.error('AI', '取消单会话问答任务失败', { error: String(e) })
      return { success: false, requestId, error: String(e) }
    }
  })

  ipcMain.handle('ai:getSessionVectorIndexState', async (_, sessionId: string) => {
    try {
      return {
        success: true,
        result: await getSessionVectorIndexStateForUi(sessionId)
      }
    } catch (e) {
      console.error('[AI] 获取会话向量索引状态失败:', e)
      logService?.error('AI', '获取会话向量索引状态失败', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:prepareSessionVectorIndex', async (event, options: { sessionId: string }) => {
    try {
      const result = await startSessionVectorIndexJob(options.sessionId, event.sender)
      return { success: true, result }
    } catch (e) {
      console.error('[AI] 准备会话向量索引失败:', e)
      logService?.error('AI', '准备会话向量索引失败', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:cancelSessionVectorIndex', async (_, sessionId: string) => {
    try {
      const job = sessionVectorIndexJobs.get(sessionId)
      if (job) {
        job.cancelRequested = true
        job.worker.postMessage({ type: 'cancel' })
        return {
          success: true,
          result: await getSessionVectorIndexStateForUi(sessionId)
        }
      }
      return {
        success: true,
        result: chatSearchIndexService.cancelSessionVectorIndex(sessionId)
      }
    } catch (e) {
      console.error('[AI] 取消会话向量索引失败:', e)
      logService?.error('AI', '取消会话向量索引失败', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:getSessionMemoryBuildState', async (_, sessionId: string) => {
    try {
      return {
        success: true,
        result: await getSessionMemoryBuildStateForUi(sessionId)
      }
    } catch (e) {
      console.error('[AI] 获取会话记忆构建状态失败:', e)
      logService?.error('AI', '获取会话记忆构建状态失败', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:prepareSessionMemory', async (event, options: { sessionId: string }) => {
    try {
      const sessionId = String(options?.sessionId || '').trim()
      if (!sessionId) {
        return { success: false, error: 'sessionId 不能为空' }
      }

      const result = await startSessionMemoryBuildJob(sessionId, event.sender)
      return { success: true, result }
    } catch (e) {
      console.error('[AI] 构建会话记忆失败:', e)
      logService?.error('AI', '构建会话记忆失败', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:getSessionProfileMemoryState', async (_, sessionId: string) => {
    try {
      aiService.init()
      return {
        success: true,
        result: aiService.getSessionProfileMemoryState(String(sessionId || '').trim())
      }
    } catch (e) {
      console.error('[AI] 获取会话画像记忆状态失败:', e)
      logService?.error('AI', '获取会话画像记忆状态失败', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:buildSessionProfileMemory', async (_, options: {
    sessionId: string
    sessionName?: string
    provider: string
    apiKey: string
    model: string
  }) => {
    try {
      aiService.init()
      const result = await aiService.buildSessionProfileMemory({
        sessionId: options.sessionId,
        sessionName: options.sessionName,
        provider: options.provider,
        apiKey: options.apiKey,
        model: options.model
      })
      return { success: true, result }
    } catch (e) {
      console.error('[AI] 构建会话画像记忆失败:', e)
      logService?.error('AI', '构建会话画像记忆失败', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:getEmbeddingModelProfiles', async () => {
    try {
      return {
        success: true,
        result: localEmbeddingModelService.listProfiles(),
        currentProfileId: localEmbeddingModelService.getCurrentProfileId(),
        embeddingMode: embeddingRuntimeService.getMode()
      }
    } catch (e) {
      console.error('[AI] 获取语义模型列表失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:setEmbeddingMode', async (_, mode: string) => {
    try {
      const result = embeddingRuntimeService.setMode(mode)
      return { success: true, result }
    } catch (e) {
      console.error('[AI] 设置语义向量模式失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:setEmbeddingModelProfile', async (_, profileId: string) => {
    try {
      const result = localEmbeddingModelService.setCurrentProfileId(profileId)
      return { success: true, result }
    } catch (e) {
      console.error('[AI] 设置语义模型失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:setEmbeddingVectorDim', async (_, profileId: string, dim: number) => {
    try {
      const result = localEmbeddingModelService.setVectorDim(profileId, dim)
      return {
        success: true,
        result,
        vectorModelId: localEmbeddingModelService.getVectorModelId(profileId)
      }
    } catch (e) {
      console.error('[AI] 设置语义向量维度失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:getEmbeddingDeviceStatus', async () => {
    try {
      return {
        success: true,
        result: localEmbeddingModelService.getDeviceStatus(),
        embeddingMode: embeddingRuntimeService.getMode()
      }
    } catch (e) {
      console.error('[AI] 获取语义向量计算模式失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:setEmbeddingDevice', async (_, device: string) => {
    try {
      const result = localEmbeddingModelService.setCurrentDevice(device)
      return {
        success: true,
        result,
        status: localEmbeddingModelService.getDeviceStatus()
      }
    } catch (e) {
      console.error('[AI] 设置语义向量计算模式失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:getEmbeddingModelStatus', async (_, profileId?: string) => {
    try {
      return {
        success: true,
        result: await localEmbeddingModelService.getModelStatus(profileId)
      }
    } catch (e) {
      console.error('[AI] 获取语义模型状态失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:downloadEmbeddingModel', async (event, profileId?: string) => {
    try {
      const result = await localEmbeddingModelService.downloadModel(profileId, (progress) => {
        event.sender.send('ai:embeddingModelDownloadProgress', progress)
      })
      return { success: true, result }
    } catch (e) {
      console.error('[AI] 下载语义模型失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:clearEmbeddingModel', async (_, profileId?: string) => {
    try {
      return {
        success: true,
        result: await localEmbeddingModelService.clearModel(profileId)
      }
    } catch (e) {
      console.error('[AI] 清理语义模型失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:getOnlineEmbeddingProviders', async () => {
    try {
      return {
        success: true,
        result: onlineEmbeddingService.listProviders()
      }
    } catch (e) {
      console.error('[AI] 获取在线向量厂商失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:listOnlineEmbeddingConfigs', async () => {
    try {
      return {
        success: true,
        result: onlineEmbeddingService.listConfigs(),
        currentConfigId: onlineEmbeddingService.getCurrentConfigId()
      }
    } catch (e) {
      console.error('[AI] 获取在线向量配置失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:saveOnlineEmbeddingConfig', async (_, payload: any) => {
    try {
      return {
        success: true,
        result: await onlineEmbeddingService.saveConfig(payload)
      }
    } catch (e) {
      console.error('[AI] 保存在线向量配置失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:deleteOnlineEmbeddingConfig', async (_, configId: string) => {
    try {
      return {
        success: true,
        result: onlineEmbeddingService.deleteConfig(configId)
      }
    } catch (e) {
      console.error('[AI] 删除在线向量配置失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:setCurrentOnlineEmbeddingConfig', async (_, configId: string) => {
    try {
      const result = onlineEmbeddingService.setCurrentConfig(configId)
      if (!result) {
        return { success: false, error: '在线向量配置不存在' }
      }
      return { success: true, result }
    } catch (e) {
      console.error('[AI] 切换在线向量配置失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:testOnlineEmbeddingConfig', async (_, payload: any) => {
    try {
      return {
        success: true,
        result: await onlineEmbeddingService.testConfig(payload)
      }
    } catch (e) {
      console.error('[AI] 测试在线向量配置失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:clearSemanticVectorIndex', async (_, vectorModel?: string) => {
    try {
      return {
        success: true,
        result: chatSearchIndexService.clearSemanticVectorIndex(vectorModel)
      }
    } catch (e) {
      console.error('[AI] 清理语义向量索引失败:', e)
      return { success: false, error: String(e) }
    }
  })
}

// 主窗口引用
let mainWindow: BrowserWindow | null = null
// 启动屏窗口引用
let splashWindow: BrowserWindow | null = null
// 启动屏就绪状态
let splashReady = false
// 启动时是否已成功连接数据库（用于通知主窗口跳过重复连接）
let startupDbConnected = false

/**
 * 创建启动屏窗口
 */
function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 420,
    height: 320,
    ...getWindowIconOptions(),
    frame: false,
    transparent: true, // 启用透明，让 CSS 圆角生效
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true, // 不显示在任务栏
    hasShadow: false, // Windows 上透明窗口需要禁用阴影
    show: true, // 直接显示窗口
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      devTools: allowDevTools,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false  // 允许加载本地文件
    },
    backgroundColor: '#00000000' // 完全透明的背景色
  })

  splash.center()

  // 加载启动屏页面
  const splashUrl = process.env.VITE_DEV_SERVER_URL
    ? `${process.env.VITE_DEV_SERVER_URL}#/splash`
    : null

  // 监听页面加载完成
  splash.webContents.on('did-finish-load', () => {
    // 启动屏页面加载完成
  })

  splash.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    // 启动屏页面加载失败
  })

  // 加载页面（服务器已在 checkAndConnectOnStartup 中确保就绪）
  if (process.env.VITE_DEV_SERVER_URL) {
    splash.loadURL(splashUrl!).then(() => {
      // 启动屏页面加载成功
    }).catch(err => {
      // loadURL 错误
    })
  } else {
    splash.loadFile(join(__dirname, '../dist/index.html'), {
      hash: '/splash'
    }).catch(err => {
      // loadFile 错误
    })
  }

  return splash
}

/**
 * 优雅地关闭启动屏（带动画效果）
 */
async function closeSplashWindow(): Promise<void> {
  if (!splashWindow || splashWindow.isDestroyed()) {
    splashWindow = null
    return
  }

  // 通知渲染进程播放淡出动画
  splashWindow.webContents.send('splash:fadeOut')

  // 等待动画完成（300ms）
  await new Promise(resolve => setTimeout(resolve, 350))

  // 关闭窗口
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close()
    splashWindow = null
  }
}

/**
 * 检查是否需要显示启动屏并连接数据库
 */
async function checkAndConnectOnStartup(): Promise<boolean> {
  // 初始化配置服务（如果还没初始化）
  if (!configService) {
    configService = new ConfigService()
  }

  // 检查配置是否完整
  const wxid = configService?.get('myWxid')
  const dbPath = configService?.get('dbPath')
  const decryptKey = configService?.get('decryptKey')

  // 如果配置不完整，打开引导窗口而不是主窗口
  if (!wxid || !dbPath || !decryptKey) {
    // 创建引导窗口
    createWelcomeWindow()
    return false
  }

  // 开发环境下：等待 Vite 服务器就绪后再显示启动屏
  if (process.env.VITE_DEV_SERVER_URL) {
    const serverUrl = process.env.VITE_DEV_SERVER_URL

    // 等待服务器就绪（最多等待 15 秒）
    const waitForServer = async (url: string, maxWait = 15000, interval = 300): Promise<boolean> => {
      const start = Date.now()
      while (Date.now() - start < maxWait) {
        try {
          const response = await net.fetch(url)
          if (response.ok) {
            return true
          }
        } catch (e) {
          // 服务器还没就绪，继续等待
        }
        await new Promise(resolve => setTimeout(resolve, interval))
      }
      return false
    }

    const serverReady = await waitForServer(serverUrl)
    if (!serverReady) {
      // 服务器未就绪，跳过启动屏，直接连接数据库
      try {
        const result = await chatService.connect()
        startupDbConnected = result.success
        return result.success
      } catch (e) {
        return false
      }
    }
    // 服务器已就绪，继续显示启动屏（走下面的通用逻辑）
  }

  // 生产环境：配置完整，显示启动屏
  splashWindow = createSplashWindow()
  splashReady = false

  // 创建连接 Promise，等待启动屏加载完成后再执行
  return new Promise<boolean>(async (resolve) => {
    // 等待启动屏加载完成（通过 IPC 通知）
    const checkReady = setInterval(() => {
      if (splashReady) {
        clearInterval(checkReady)
        // 启动屏已加载完成，开始连接数据库
        chatService.connect().then(async (result) => {
          // 优雅地关闭启动屏（带动画）
          await closeSplashWindow()
          // 记录启动时连接状态
          startupDbConnected = result.success
          resolve(result.success)
        }).catch(async (e) => {
          console.error('启动时连接数据库失败:', e)
          // 优雅地关闭启动屏
          await closeSplashWindow()
          resolve(false)
        })
      }
    }, 100)

    // 超时保护：30秒后强制关闭启动屏（开发环境可能需要更长时间）
    setTimeout(async () => {
      clearInterval(checkReady)
      if (splashWindow && !splashWindow.isDestroyed()) {
        await closeSplashWindow()
      }
      if (!splashReady) {
        resolve(false)
      }
    }, 30000)
  })
}

// 启动时自动检测更新
function checkForUpdatesOnStartup() {
  // 开发环境不检测更新
  if (process.env.VITE_DEV_SERVER_URL) return

  // 延迟3秒检测，等待窗口完全加载
  setTimeout(async () => {
    try {
      const result = await appUpdateService.checkForUpdates()
      logService?.info('AppUpdate', '启动时检查更新完成', {
        hasUpdate: result.hasUpdate,
        currentVersion: result.currentVersion,
        version: result.version,
        diagnostics: result.diagnostics
      })
      if (result.hasUpdate && mainWindow) {
        mainWindow.webContents.send('app:updateAvailable', result)
      }
    } catch (error) {
      logService?.error('AppUpdate', '启动时检查更新失败', { error: String(error) })
      console.error('启动时检查更新失败:', error)
    }
  }, 3000)
}

// 忽略证书错误（用于朋友圈图片/视频下载）
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  // 只对微信域名忽略证书错误
  if (url.includes('weixin.qq.com') || url.includes('wechat.com')) {
    event.preventDefault()
    callback(true)
  } else {
    callback(false)
  }
})

app.whenReady().then(async () => {
  if (!configService) {
    configService = new ConfigService()
  }

  if (process.platform === 'darwin') {
    const dockIconPath = getDockIconPath()
    if (existsSync(dockIconPath)) {
      const dockIcon = nativeImage.createFromPath(dockIconPath)
      if (!dockIcon.isEmpty()) {
        app.dock?.setIcon(dockIcon)
      }
    }
  }

  if (!configService.get('mcpProxyToken')) {
    configService.set('mcpProxyToken', randomBytes(24).toString('hex'))
  }

  // 注册自定义协议用于加载本地视频
  protocol.handle('local-video', (request) => {
    // 移除协议前缀并解码
    let filePath = decodeURIComponent(request.url.replace('local-video://', ''))
    // Windows 路径处理：确保使用正斜杠
    filePath = filePath.replace(/\\/g, '/')
    console.log('[Protocol] 加载视频:', filePath)
    return net.fetch(`file:///${filePath}`)
  })

  registerIpcHandlers()

  // 监听增量更新事件
  chatService.on('sessions-update-available', (sessions) => {
    // 广播给所有窗口
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('chat:sessions-updated', sessions)
      }
    })
  })

  // 启动自动同步（5秒检查一次 session.db 变化）
  chatService.startAutoSync(5000)

  // 配置后台自动增量解密（5分钟检查一次源文件变化）
  // 配合 chatService.startAutoSync 使用：
  // 1. dataManagementService 发现源文件变化 -> 执行增量解密 -> 更新 session.db
  // 2. chatService 发现 session.db 变化 -> 广播事件 -> 前端刷新
  dataManagementService.onUpdateAvailable((hasUpdate) => {
    // 广播给渲染进程，让前端知晓正在同步
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('dataManagement:updateAvailable', hasUpdate)
      }
    })

    if (hasUpdate) {
      dataManagementService.autoIncrementalUpdate(true).then(result => {
        if (result.success && result.updated) {
          // 增量解密完成后，重新连接数据库并启动自动同步
          chatService.connect().then(connectResult => {
            if (connectResult.success) {
              // 重新启动自动同步
              chatService.startAutoSync(5000)
              // 立即检查一次更新
              chatService.checkUpdates(true)
            }
          })
        }
      }).catch(e => {
        // console.error('[AutoUpdate] 自动增量更新失败:', e)
      })
    }
  })
  // 启动时立即检查一次增量更新
  dataManagementService.checkForUpdates().then(result => {
    if (result.hasUpdate) {
      //console.log('[AutoUpdate] 启动时检测到源文件更新，开始自动增量解密...')
      dataManagementService.autoIncrementalUpdate(true).then(res => {
        if (res.success && res.updated) {
          chatService.connect().then(connectResult => {
            if (connectResult.success) {
              chatService.startAutoSync(5000)
              chatService.checkUpdates(true)
            }
          })
        }
      }).catch(console.error)
    }
  })

  // 启动源文件监听（60秒轮询一次作为兜底，主要靠文件系统监听）
  dataManagementService.enableAutoUpdate(60)

  // 检查是否需要显示启动屏并连接数据库
  const shouldShowSplash = await checkAndConnectOnStartup()

  // 启动本地 HTTP API（默认 127.0.0.1:5031）
  const httpApiEnabled = configService?.get('httpApiEnabled') ?? false
  const httpApiPort = configService?.get('httpApiPort') || 5031
  const httpApiToken = (configService?.get('httpApiToken') || '').toString()
  const configuredHttpApiListenMode = configService?.get('httpApiListenMode') === 'lan' ? 'lan' : 'localhost'
  const httpApiListenMode = configuredHttpApiListenMode === 'lan' && !httpApiToken ? 'localhost' : configuredHttpApiListenMode
  httpApiService.applySettings({
    enabled: Boolean(httpApiEnabled),
    port: Number(httpApiPort) || 5031,
    token: httpApiToken,
    listenMode: httpApiListenMode
  })
  const httpApiStartResult = await httpApiService.start()
  if (!httpApiStartResult.success) {
    console.error('[HttpApi] 启动失败:', httpApiStartResult.error)
  }

  const mcpProxyConfig = getMcpProxyConfig(configService)
  mcpProxyService.applySettings({
    host: mcpProxyConfig.host,
    port: mcpProxyConfig.port,
    token: mcpProxyConfig.token
  })
  const mcpProxyStartResult = await mcpProxyService.start()
  if (!mcpProxyStartResult.success) {
    console.error('[McpProxy] 启动失败:', mcpProxyStartResult.error)
    logService?.error('McpProxy', '内部 MCP 代理启动失败', { error: mcpProxyStartResult.error })
  }
  mcpClientService.restoreSavedConnections().catch((e) => {
    console.error('[McpClient] 自动恢复连接失败:', e)
  })

  // 只有在配置完整时才创建主窗口
  // 如果配置不完整，checkAndConnectOnStartup 会创建引导窗口
  if (shouldShowSplash !== false || configService?.get('myWxid')) {
    // 创建主窗口（但不立即显示）
    mainWindow = createWindow()
    
    // 创建系统托盘
    createTray()
  }

  // 如果显示了启动屏，主窗口会在启动屏关闭后自动显示（通过 ready-to-show 事件）
  // 如果没有显示启动屏，主窗口会正常显示（通过 ready-to-show 事件）

  // 启动时检测更新
  checkForUpdatesOnStartup()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
      createTray()
    }
  })
})

app.on('window-all-closed', () => {
  // macOS 上保持应用运行
  if (process.platform !== 'darwin') {
    // 如果托盘存在，不退出应用
    if (!tray) {
      app.quit()
    }
  }
})

app.on('before-quit', () => {
  // 设置退出标志
  appWithQuitFlag.isQuitting = true
  
  httpApiService.stop().catch((e) => {
    console.error('[HttpApi] 停止失败:', e)
  })
  mcpProxyService.stop().catch((e) => {
    console.error('[McpProxy] 停止失败:', e)
  })
  mcpClientService.disconnectAll(false).catch((e) => {
    console.error('[McpClient] 停止失败:', e)
  })
  // 关闭配置数据库连接
  configService?.close()
  
  // 销毁托盘
  if (tray) {
    tray.destroy()
    tray = null
  }
})
