import { useState, useEffect } from 'react'
import { useSearchParams, useLocation } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import { useThemeStore, themes } from '../stores/themeStore'
import { useActivationStore } from '../stores/activationStore'
import { dialog } from '../services/ipc'
import * as configService from '../services/config'
import AISummarySettings from '../components/ai/AISummarySettings'
import {
  Eye, EyeOff, Key, FolderSearch, FolderOpen, Search,
  RotateCcw, Trash2, Save, Plug, X, Check, Sun, Moon,
  Palette, Database, ImageIcon, Download, HardDrive, Info, RefreshCw, Shield, Clock, CheckCircle, AlertCircle, FileText, Mic,
  Zap, Layers, User, Sparkles, Github, Fingerprint, Lock, ShieldCheck, Minus, Plus, Smile
} from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import './SettingsPage.scss'

type SettingsTab = 'appearance' | 'database' | 'stt' | 'ai' | 'data' | 'security' | 'activation' | 'about'

const tabs: { id: SettingsTab; label: string; icon: React.ElementType }[] = [
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'database', label: '数据解密', icon: Database },
  { id: 'security', label: '安全设置', icon: Lock },
  { id: 'stt', label: '语音转文字', icon: Mic },
  { id: 'ai', label: 'AI 摘要', icon: Sparkles },
  { id: 'data', label: '数据管理', icon: HardDrive },
  // { id: 'activation', label: '激活', icon: Shield },
  { id: 'about', label: '关于', icon: Info }
]

const sttLanguageOptions = [
  { value: 'zh', label: '中文', enLabel: 'Chinese' },
  { value: 'en', label: '英语', enLabel: 'English' },
  { value: 'ja', label: '日语', enLabel: 'Japanese' },
  { value: 'ko', label: '韩语', enLabel: 'Korean' },
  { value: 'yue', label: '粤语', enLabel: 'Cantonese' }
]

const sttModelTypeOptions = [
  { value: 'int8', label: 'int8 量化版', size: '235 MB', desc: '推荐，体积小、速度快' },
  { value: 'float32', label: 'float32 完整版', size: '920 MB', desc: '更高精度，体积较大' }
]

function SettingsPage() {
  const [searchParams] = useSearchParams()
  const { setDbConnected, setLoading } = useAppStore()
  const { currentTheme, themeMode, setTheme, setThemeMode, appIcon, setAppIcon } = useThemeStore()
  const { status: activationStatus, checkStatus: checkActivationStatus } = useActivationStore()

  const { isAuthEnabled, enableAuth, disableAuth, setupPassword, authMethod } = useAuthStore()
  const [passwordInput, setPasswordInput] = useState('')
  const [showPasswordInput, setShowPasswordInput] = useState(false)

  // 安全设置确认弹窗状态
  const [securityConfirm, setSecurityConfirm] = useState<{
    show: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  }>({ show: false, title: '', message: '', onConfirm: () => { } })



  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    const tab = searchParams.get('tab')
    if (tab && tabs.some(t => t.id === tab)) {
      return tab as SettingsTab
    }
    return 'appearance'
  })

  // 切换到激活 tab 时自动刷新状态
  useEffect(() => {
    if (activeTab === 'activation') {
      checkActivationStatus()
    }
  }, [activeTab])

  const [decryptKey, setDecryptKey] = useState('')
  const [dbPath, setDbPath] = useState('')
  const [wxid, setWxid] = useState('')
  const [wxidOptions, setWxidOptions] = useState<string[]>([])
  const [showWxidDropdown, setShowWxidDropdown] = useState(false)
  const [isScanningWxid, setIsScanningWxid] = useState(false)
  const [cachePath, setCachePath] = useState('')
  const [imageXorKey, setImageXorKey] = useState('')
  const [imageAesKey, setImageAesKey] = useState('')
  const [exportPath, setExportPath] = useState('')
  const [defaultExportPath, setDefaultExportPath] = useState('')

  const [isLoading, setIsLoadingState] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [isGettingKey, setIsGettingKey] = useState(false)
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [appVersion, setAppVersion] = useState('')
  const [updateInfo, setUpdateInfo] = useState<{ hasUpdate: boolean; version?: string; releaseNotes?: string } | null>(null)
  const [keyStatus, setKeyStatus] = useState('')
  const [message, setMessage] = useState<{ text: string; success: boolean } | null>(null)
  const [showDecryptKey, setShowDecryptKey] = useState(false)
  const [showXorKey, setShowXorKey] = useState(false)
  const [showAesKey, setShowAesKey] = useState(false)
  const [showClearDialog, setShowClearDialog] = useState<{
    type: 'images' | 'emojis' | 'databases' | 'all' | 'config'
    title: string
    message: string
  } | null>(null)
  const [cacheSize, setCacheSize] = useState<{
    images: number
    emojis: number
    databases: number
    logs: number
    total: number
  } | null>(null)
  const [isLoadingCacheSize, setIsLoadingCacheSize] = useState(false)
  const [sttLanguages, setSttLanguagesState] = useState<string[]>([])
  const [sttModelType, setSttModelType] = useState<'int8' | 'float32'>('int8')
  const [quoteStyle, setQuoteStyle] = useState<'default' | 'wechat'>('default')
  const [skipIntegrityCheck, setSkipIntegrityCheck] = useState(false)
  const [exportDefaultDateRange, setExportDefaultDateRange] = useState<number>(0)
  const [exportDefaultAvatars, setExportDefaultAvatars] = useState<boolean>(true)
  const [autoUpdateDatabase, setAutoUpdateDatabase] = useState(true)
  // 自动同步高级参数
  const [autoUpdateCheckInterval, setAutoUpdateCheckInterval] = useState(60) // 检查间隔（秒）
  const [autoUpdateMinInterval, setAutoUpdateMinInterval] = useState(1000)   // 最小更新间隔（毫秒）
  const [autoUpdateDebounceTime, setAutoUpdateDebounceTime] = useState(500)  // 防抖时间（毫秒）

  // AI 相关配置状态
  const [aiProvider, setAiProviderState] = useState('zhipu')
  const [aiApiKey, setAiApiKeyState] = useState('')
  const [aiModel, setAiModelState] = useState('')
  const [aiDefaultTimeRange, setAiDefaultTimeRangeState] = useState<number>(7)
  const [aiSummaryDetail, setAiSummaryDetailState] = useState<'simple' | 'normal' | 'detailed'>('normal')
  const [aiEnableThinking, setAiEnableThinkingState] = useState<boolean>(true)
  const [aiMessageLimit, setAiMessageLimitState] = useState<number>(3000)

  // 日志相关状态
  const [logFiles, setLogFiles] = useState<Array<{ name: string; size: number; mtime: Date }>>([])
  const [selectedLogFile, setSelectedLogFile] = useState<string>('')
  const [logContent, setLogContent] = useState<string>('')
  const [isLoadingLogs, setIsLoadingLogs] = useState(false)
  const [isLoadingLogContent, setIsLoadingLogContent] = useState(false)
  const [logSize, setLogSize] = useState<number>(0)
  const [currentLogLevel, setCurrentLogLevel] = useState<string>('WARN')

  useEffect(() => {
    loadConfig()
    loadDefaultExportPath()
    loadAppVersion()
    loadCacheSize()
    loadLogFiles()
  }, [])

  const loadConfig = async () => {
    try {
      const savedKey = await configService.getDecryptKey()
      const savedPath = await configService.getDbPath()
      const savedWxid = await configService.getMyWxid()
      const savedCachePath = await configService.getCachePath()
      const savedXorKey = await configService.getImageXorKey()
      const savedAesKey = await configService.getImageAesKey()
      const savedExportPath = await configService.getExportPath()
      const savedSttLanguages = await configService.getSttLanguages()
      const savedSttModelType = await configService.getSttModelType()
      const savedSkipIntegrityCheck = await configService.getSkipIntegrityCheck()
      const savedAutoUpdateDatabase = await configService.getAutoUpdateDatabase()

      if (savedKey) setDecryptKey(savedKey)
      if (savedPath) setDbPath(savedPath)
      if (savedWxid) setWxid(savedWxid)
      if (savedCachePath) setCachePath(savedCachePath)
      if (savedXorKey) setImageXorKey(savedXorKey)
      if (savedAesKey) setImageAesKey(savedAesKey)
      if (savedExportPath) setExportPath(savedExportPath)
      if (savedSttLanguages && savedSttLanguages.length > 0) {
        setSttLanguagesState(savedSttLanguages)
      } else {
        setSttLanguagesState(['zh'])
      }
      setSttModelType(savedSttModelType)
      setSkipIntegrityCheck(savedSkipIntegrityCheck)
      setAutoUpdateDatabase(savedAutoUpdateDatabase)

      // 加载自动同步高级参数
      const savedCheckInterval = await configService.getAutoUpdateCheckInterval()
      const savedMinInterval = await configService.getAutoUpdateMinInterval()
      const savedDebounceTime = await configService.getAutoUpdateDebounceTime()
      setAutoUpdateCheckInterval(savedCheckInterval)
      setAutoUpdateMinInterval(savedMinInterval)
      setAutoUpdateDebounceTime(savedDebounceTime)

      const savedQuoteStyle = await configService.getQuoteStyle()
      setQuoteStyle(savedQuoteStyle)

      const savedExportDefaultDateRange = await configService.getExportDefaultDateRange()
      setExportDefaultDateRange(savedExportDefaultDateRange)

      const savedExportDefaultAvatars = await configService.getExportDefaultAvatars()
      setExportDefaultAvatars(savedExportDefaultAvatars)

      // 加载 AI 配置
      const savedAiProvider = await configService.getAiProvider()
      const savedAiApiKey = await configService.getAiApiKey()
      const savedAiModel = await configService.getAiModel()
      const savedAiDefaultTimeRange = await configService.getAiDefaultTimeRange()
      const savedAiSummaryDetail = await configService.getAiSummaryDetail()
      const savedAiEnableThinking = await configService.getAiEnableThinking()
      const savedAiMessageLimit = await configService.getAiMessageLimit()

      setAiProviderState(savedAiProvider)
      setAiApiKeyState(savedAiApiKey)
      setAiModelState(savedAiModel)
      setAiDefaultTimeRangeState(savedAiDefaultTimeRange)
      setAiSummaryDetailState(savedAiSummaryDetail)
      setAiEnableThinkingState(savedAiEnableThinking)
      setAiMessageLimitState(savedAiMessageLimit)
    } catch (e) {
      console.error('加载配置失败:', e)
    }
  }

  const loadDefaultExportPath = async () => {
    try {
      const downloadsPath = await window.electronAPI.app.getDownloadsPath()
      setDefaultExportPath(downloadsPath)
    } catch (e) {
      console.error('获取默认导出路径失败:', e)
    }
  }

  const loadAppVersion = async () => {
    try {
      const version = await window.electronAPI.app.getVersion()
      setAppVersion(version)
    } catch (e) {
      console.error('获取版本号失败:', e)
    }
  }

  const loadCacheSize = async () => {
    setIsLoadingCacheSize(true)
    try {
      const result = await window.electronAPI.cache.getCacheSize()
      if (result.success && result.size) {
        setCacheSize(result.size)
      }
    } catch (e) {
      console.error('获取缓存大小失败:', e)
    } finally {
      setIsLoadingCacheSize(false)
    }
  }

  const loadLogFiles = async () => {
    setIsLoadingLogs(true)
    try {
      const [filesResult, sizeResult, levelResult] = await Promise.all([
        window.electronAPI.log.getLogFiles(),
        window.electronAPI.log.getLogSize(),
        window.electronAPI.log.getLogLevel()
      ])

      if (filesResult.success && filesResult.files) {
        setLogFiles(filesResult.files)
      }

      if (sizeResult.success && sizeResult.size !== undefined) {
        setLogSize(sizeResult.size)
      }

      if (levelResult.success && levelResult.level) {
        setCurrentLogLevel(levelResult.level)
      }
    } catch (e) {
      console.error('获取日志文件失败:', e)
    } finally {
      setIsLoadingLogs(false)
    }
  }

  const loadLogContent = async (filename: string) => {
    if (!filename) return

    setIsLoadingLogContent(true)
    try {
      const result = await window.electronAPI.log.readLogFile(filename)
      if (result.success && result.content) {
        setLogContent(result.content)
      } else {
        setLogContent('无法读取日志文件')
      }
    } catch (e) {
      console.error('读取日志文件失败:', e)
      setLogContent('读取日志文件失败')
    } finally {
      setIsLoadingLogContent(false)
    }
  }

  const handleClearLogs = async () => {
    try {
      const result = await window.electronAPI.log.clearLogs()
      if (result.success) {
        showMessage('日志清除成功', true)
        setLogFiles([])
        setLogContent('')
        setSelectedLogFile('')
        setLogSize(0)
        await loadCacheSize() // 重新加载缓存大小
      } else {
        showMessage(result.error || '日志清除失败', false)
      }
    } catch (e) {
      showMessage(`日志清除失败: ${e}`, false)
    }
  }

  const handleLogFileSelect = (filename: string) => {
    setSelectedLogFile(filename)
    loadLogContent(filename)
  }

  const handleOpenLogDirectory = async () => {
    try {
      const result = await window.electronAPI.log.getLogDirectory()
      if (result.success && result.directory) {
        await window.electronAPI.shell.openPath(result.directory)
      }
    } catch (e) {
      showMessage('打开日志目录失败', false)
    }
  }

  const handleLogLevelChange = async (level: string) => {
    try {
      const result = await window.electronAPI.log.setLogLevel(level)
      if (result.success) {
        setCurrentLogLevel(level)
        showMessage(`日志级别已设置为 ${level}`, true)
      } else {
        showMessage(result.error || '设置日志级别失败', false)
      }
    } catch (e) {
      showMessage('设置日志级别失败', false)
    }
  }

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }

  // 监听下载进度
  useEffect(() => {
    const removeListener = window.electronAPI.app.onDownloadProgress?.((progress: number) => {
      setDownloadProgress(progress)
    })
    return () => removeListener?.()
  }, [])

  const handleCheckUpdate = async () => {
    setIsCheckingUpdate(true)
    setUpdateInfo(null)
    try {
      const result = await window.electronAPI.app.checkForUpdates()
      if (result.hasUpdate) {
        setUpdateInfo(result)
        showMessage(`发现新版本 ${result.version}`, true)
      } else {
        showMessage('当前已是最新版本', true)
      }
    } catch (e) {
      showMessage(`检查更新失败: ${e}`, false)
    } finally {
      setIsCheckingUpdate(false)
    }
  }

  const showMessage = (text: string, success: boolean) => {
    setMessage({ text, success })
    setTimeout(() => setMessage(null), 3000)
  }

  const handleClearImages = () => {
    setShowClearDialog({
      type: 'images',
      title: '清除图片',
      message: '此操作将删除所有解密后的图片文件，清除后无法恢复。确定要继续吗？'
    })
  }

  const handleClearAllCache = () => {
    setShowClearDialog({
      type: 'all',
      title: '清除所有',
      message: '此操作将删除所有缓存数据（包括解密后的图片、表情包、数据库文件），清除后无法恢复。确定要继续吗？'
    })
  }

  const handleClearEmojis = () => {
    setShowClearDialog({
      type: 'emojis',
      title: '清除表情包',
      message: '此操作将删除所有解密后的表情包缓存文件，清除后无法恢复。确定要继续吗？'
    })
  }

  const handleClearDatabases = () => {
    setShowClearDialog({
      type: 'databases',
      title: '清除数据库',
      message: '此操作将删除所有解密后的数据库缓存文件，清除后需要重新解密数据库才能使用聊天记录。确定要继续吗？'
    })
  }

  const handleClearConfig = () => {
    setShowClearDialog({
      type: 'config',
      title: '清除配置',
      message: '此操作将删除所有保存的配置信息（包括密钥、路径等），清除后无法恢复。确定要继续吗？'
    })
  }

  const confirmClear = async () => {
    if (!showClearDialog) return

    try {
      let result
      switch (showClearDialog.type) {
        case 'images':
          result = await window.electronAPI.cache.clearImages()
          break
        case 'emojis':
          result = await window.electronAPI.cache.clearEmojis()
          break
        case 'databases':
          result = await window.electronAPI.cache.clearDatabases()
          break
        case 'all':
          result = await window.electronAPI.cache.clearAll()
          break
        case 'config':
          result = await window.electronAPI.cache.clearConfig()
          break
      }

      if (result.success) {
        showMessage(`${showClearDialog.title}成功`, true)
        if (showClearDialog.type === 'config') {
          await loadConfig()
        } else {
          await loadCacheSize()
        }
      } else {
        showMessage(result.error || `${showClearDialog.title}失败`, false)
      }
    } catch (e) {
      showMessage(`${showClearDialog.title}失败: ${e}`, false)
    } finally {
      setShowClearDialog(null)
    }
  }

  const handleUpdateNow = async () => {
    setIsDownloading(true)
    setDownloadProgress(0)
    try {
      showMessage('正在下载更新...', true)
      await window.electronAPI.app.downloadAndInstall()
    } catch (e) {
      showMessage(`更新失败: ${e}`, false)
      setIsDownloading(false)
    }
  }

  const handleGetKey = async () => {
    if (isGettingKey) return
    setIsGettingKey(true)
    setKeyStatus('正在检查微信进程...')

    try {
      const isRunning = await window.electronAPI.wxKey.isWeChatRunning()
      if (isRunning) {
        const shouldKill = window.confirm('检测到微信正在运行，需要重启微信才能获取密钥。\n是否关闭当前微信？')
        if (!shouldKill) {
          setKeyStatus('已取消')
          setIsGettingKey(false)
          return
        }
        setKeyStatus('正在关闭微信...')
        await window.electronAPI.wxKey.killWeChat()
        await new Promise(resolve => setTimeout(resolve, 2000))
      }

      setKeyStatus('正在启动微信...')
      const launched = await window.electronAPI.wxKey.launchWeChat()
      if (!launched) {
        showMessage('微信启动失败，请检查安装路径', false)
        setKeyStatus('')
        setIsGettingKey(false)
        return
      }

      setKeyStatus('等待微信窗口加载...')
      const windowReady = await window.electronAPI.wxKey.waitForWindow(15)
      if (!windowReady) {
        showMessage('等待微信窗口超时', false)
        setKeyStatus('')
        setIsGettingKey(false)
        return
      }

      const removeListener = window.electronAPI.wxKey.onStatus(({ status }) => {
        setKeyStatus(status)
      })

      setKeyStatus('Hook 已安装，请登录微信...')
      const result = await window.electronAPI.wxKey.startGetKey()
      removeListener()

      if (result.success && result.key) {
        setDecryptKey(result.key)
        await configService.setDecryptKey(result.key)

        // 自动检测当前登录的微信账号
        setKeyStatus('正在检测当前登录账号...')

        // 先尝试较短的时间范围（刚登录的情况）
        let accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 10) // 10分钟

        // 如果没找到，尝试更长的时间范围
        if (!accountInfo) {
          accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 60) // 1小时
        }

        if (accountInfo) {
          setWxid(accountInfo.wxid)
          await configService.setMyWxid(accountInfo.wxid)
          showMessage(`密钥获取成功！已自动绑定账号: ${accountInfo.wxid}`, true)
        } else {
          showMessage('密钥获取成功，已自动保存！（未能自动检测账号，请手动输入 wxid）', true)
        }
        setKeyStatus('')
      } else {
        showMessage(result.error || '获取密钥失败', false)
        setKeyStatus('')
      }
    } catch (e) {
      showMessage(`获取密钥失败: ${e}`, false)
      setKeyStatus('')
    } finally {
      setIsGettingKey(false)
    }
  }

  const handleCancelGetKey = async () => {
    await window.electronAPI.wxKey.cancel()
    setIsGettingKey(false)
    setKeyStatus('')
  }

  const handleOpenWelcomeWindow = async () => {
    try {
      await window.electronAPI.window.openWelcomeWindow()
    } catch (e) {
      showMessage('打开引导窗口失败', false)
    }
  }

  const handleSelectDbPath = async () => {
    try {
      const result = await dialog.openFile({ title: '选择微信数据库根目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        setDbPath(result.filePaths[0])
        showMessage('已选择数据库目录', true)
      }
    } catch (e) {
      showMessage('选择目录失败', false)
    }
  }

  const handleSelectCachePath = async () => {
    try {
      const result = await dialog.openFile({ title: '选择缓存目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        setCachePath(result.filePaths[0])
        showMessage('已选择缓存目录', true)
      }
    } catch (e) {
      showMessage('选择目录失败', false)
    }
  }

  const handleSelectExportPath = async () => {
    try {
      const result = await dialog.openFile({ title: '选择导出目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        setExportPath(result.filePaths[0])
        await configService.setExportPath(result.filePaths[0])
        showMessage('已设置导出目录', true)
      }
    } catch (e) {
      showMessage('选择目录失败', false)
    }
  }

  const handleResetExportPath = async () => {
    try {
      const downloadsPath = await window.electronAPI.app.getDownloadsPath()
      setExportPath(downloadsPath)
      await configService.setExportPath(downloadsPath)
      showMessage('已恢复为下载目录', true)
    } catch (e) {
      showMessage('恢复默认失败', false)
    }
  }

  // 扫描 wxid
  const handleScanWxid = async () => {
    if (!dbPath) {
      showMessage('请先配置数据库路径', false)
      return
    }
    if (isScanningWxid) return

    setIsScanningWxid(true)
    try {
      const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
      if (wxids.length === 0) {
        showMessage('未检测到账号目录（需包含 db_storage 文件夹）', false)
        setWxidOptions([])
      } else if (wxids.length === 1) {
        // 只有一个账号，直接设置
        setWxid(wxids[0])
        await configService.setMyWxid(wxids[0])
        showMessage(`已检测到账号：${wxids[0]}`, true)
        setWxidOptions([])
        setShowWxidDropdown(false)
      } else {
        // 多个账号，显示选择下拉框
        setWxidOptions(wxids)
        setShowWxidDropdown(true)
        showMessage(`检测到 ${wxids.length} 个账号，请选择`, true)
      }
    } catch (e) {
      showMessage(`扫描失败: ${e}`, false)
    } finally {
      setIsScanningWxid(false)
    }
  }

  // 选择 wxid
  const handleSelectWxid = async (selectedWxid: string) => {
    setWxid(selectedWxid)
    await configService.setMyWxid(selectedWxid)
    setShowWxidDropdown(false)
    showMessage(`已选择账号：${selectedWxid}`, true)
  }

  const handleTestConnection = async () => {
    if (!dbPath) { showMessage('请先选择数据库目录', false); return }
    if (!decryptKey) { showMessage('请先输入解密密钥', false); return }
    if (decryptKey.length !== 64) { showMessage('密钥长度必须为64个字符', false); return }
    if (!wxid) { showMessage('请先输入或扫描 wxid', false); return }

    setIsTesting(true)
    try {
      const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid)
      if (result.success) {
        showMessage('连接测试成功！数据库可正常访问', true)
      } else {
        showMessage(result.error || '连接测试失败', false)
      }
    } catch (e) {
      showMessage(`连接测试失败: ${e}`, false)
    } finally {
      setIsTesting(false)
    }
  }

  const handleSaveConfig = async () => {
    setIsLoadingState(true)
    setLoading(true, '正在保存配置...')

    try {
      // 保存数据库相关配置
      if (decryptKey) await configService.setDecryptKey(decryptKey)
      if (dbPath) await configService.setDbPath(dbPath)
      if (wxid) await configService.setMyWxid(wxid)
      await configService.setCachePath(cachePath)

      // 保存图片密钥（包括空值）
      await configService.setImageXorKey(imageXorKey)
      await configService.setImageAesKey(imageAesKey)

      // 保存导出路径
      if (exportPath) await configService.setExportPath(exportPath)

      // 保存完整性检查设置
      await configService.setSkipIntegrityCheck(skipIntegrityCheck)
      // 保存自动更新设置
      await configService.setAutoUpdateDatabase(autoUpdateDatabase)
      // 保存自动同步高级参数
      await configService.setAutoUpdateCheckInterval(autoUpdateCheckInterval)
      await configService.setAutoUpdateMinInterval(autoUpdateMinInterval)
      await configService.setAutoUpdateDebounceTime(autoUpdateDebounceTime)

      // 保存引用样式
      await configService.setQuoteStyle(quoteStyle)

      // 保存导出默认设置
      await configService.setExportDefaultDateRange(exportDefaultDateRange)
      await configService.setExportDefaultAvatars(exportDefaultAvatars)

      // 保存 AI 配置
      await configService.setAiProvider(aiProvider)
      await configService.setAiApiKey(aiApiKey)
      await configService.setAiModel(aiModel)
      await configService.setAiDefaultTimeRange(aiDefaultTimeRange)
      await configService.setAiSummaryDetail(aiSummaryDetail)
      await configService.setAiEnableThinking(aiEnableThinking)
      await configService.setAiMessageLimit(aiMessageLimit)

      // 如果数据库配置完整，尝试设置已连接状态（不进行耗时测试，仅标记）
      if (decryptKey && dbPath && wxid && decryptKey.length === 64) {
        setDbConnected(true, dbPath)
      }

      showMessage('配置保存成功', true)
    } catch (e) {
      showMessage(`保存配置失败: ${e}`, false)
    } finally {
      setIsLoadingState(false)
      setLoading(false)
    }
  }

  const renderAppearanceTab = () => (
    <div className="tab-content">
      <div className="theme-mode-toggle">
        <button className={`mode-btn ${themeMode === 'light' ? 'active' : ''}`} onClick={() => setThemeMode('light')}>
          <Sun size={16} /> 浅色
        </button>
        <button className={`mode-btn ${themeMode === 'dark' ? 'active' : ''}`} onClick={() => setThemeMode('dark')}>
          <Moon size={16} /> 深色
        </button>
      </div>
      <div className="theme-grid">
        {themes.map((theme) => (
          <div key={theme.id} className={`theme-card ${currentTheme === theme.id ? 'active' : ''}`} onClick={() => setTheme(theme.id)}>
            <div className="theme-preview" style={{ background: themeMode === 'dark' ? 'linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%)' : `linear-gradient(135deg, ${theme.bgColor} 0%, ${theme.bgColor}dd 100%)` }}>
              <div className="theme-accent" style={{ background: theme.primaryColor }} />
            </div>
            <div className="theme-info">
              <span className="theme-name">{theme.name}</span>
              <span className="theme-desc">{theme.description}</span>
            </div>
            {currentTheme === theme.id && <div className="theme-check"><Check size={14} /></div>}
          </div>
        ))}
      </div>

      <h3 className="section-title" style={{ marginTop: '2rem' }}>应用图标</h3>
      <div className="quote-style-options">
        <label className={`radio-label ${appIcon === 'default' ? 'active' : ''}`} style={{ width: 'auto', minWidth: '180px' }}>
          <input
            type="radio"
            name="appIcon"
            value="default"
            checked={appIcon === 'default' || !appIcon}
            onChange={() => setAppIcon('default')}
          />
          <div className="radio-content">
            <span className="radio-title">默认图标</span>
            <div className="style-preview" style={{ justifyContent: 'center', padding: '10px' }}>
              <img src="./logo.png" alt="默认" style={{ width: '48px', height: '48px' }} />
            </div>
          </div>
        </label>

        <label className={`radio-label ${appIcon === 'xinnian' ? 'active' : ''}`} style={{ width: 'auto', minWidth: '180px' }}>
          <input
            type="radio"
            name="appIcon"
            value="xinnian"
            checked={appIcon === 'xinnian'}
            onChange={() => setAppIcon('xinnian')}
          />
          <div className="radio-content">
            <span className="radio-title">新年图标</span>
            <div className="style-preview" style={{ justifyContent: 'center', padding: '10px' }}>
              <img src="./xinnian.png" alt="新年" style={{ width: '48px', height: '48px' }} />
            </div>
          </div>
        </label>
      </div>

      <h3 className="section-title" style={{ marginTop: '2rem' }}>引用消息样式</h3>
      <div className="quote-style-options">
        <label className={`radio-label ${quoteStyle === 'default' ? 'active' : ''}`}>
          <input
            type="radio"
            name="quoteStyle"
            value="default"
            checked={quoteStyle === 'default'}
            onChange={() => setQuoteStyle('default')}
          />
          <div className="radio-content">
            <span className="radio-title">经典样式</span>
            <div className="style-preview">
              <div className="preview-bubble default">
                <div className="preview-quote">
                  张三: 那天去爬山的照片...
                </div>
                <div className="preview-text">
                  拍得真不错！
                </div>
              </div>
              <img src="./logo.png" className="preview-avatar" alt="我" />
            </div>
          </div>
        </label>

        <label className={`radio-label ${quoteStyle === 'wechat' ? 'active' : ''}`}>
          <input
            type="radio"
            name="quoteStyle"
            value="wechat"
            checked={quoteStyle === 'wechat'}
            onChange={() => setQuoteStyle('wechat')}
          />
          <div className="radio-content">
            <span className="radio-title">新版样式</span>
            <div className="style-preview">
              <div className="preview-group">
                <div className="preview-bubble wechat">
                  拍得真不错！
                </div>
                <div className="preview-quote-bubble">
                  张三: 那天去爬山的照片...
                </div>
              </div>
              <img src="./logo.png" className="preview-avatar" alt="我" />
            </div>
          </div>
        </label>
      </div>
    </div>
  )

  const renderDatabaseTab = () => (
    <div className="tab-content">
      {/* 引导窗口按钮 */}
      <div className="form-group">
        <button className="btn btn-secondary" onClick={handleOpenWelcomeWindow}>
          <Zap size={16} /> 打开配置引导窗口
        </button>
        <span className="form-hint">使用引导窗口一步步完成配置</span>
      </div>

      {/* 数据库解密部分 */}
      <h3 className="section-title">数据库解密与同步</h3>

      <div className="form-group">
        <div className="toggle-setting">
          <div className="toggle-header">
            <label className="toggle-label">
              <span className="toggle-title">开启数据库自动增量同步</span>
              <div className="toggle-switch">
                <input
                  type="checkbox"
                  checked={autoUpdateDatabase}
                  onChange={(e) => setAutoUpdateDatabase(e.target.checked)}
                />
                <span className="toggle-slider" />
              </div>
            </label>
          </div>
          <div className="toggle-description">
            <p>当检测到微信数据库文件变化时（如收到新消息），自动将新数据同步到密语。</p>
          </div>
        </div>
      </div>

      {/* 自动同步高级参数 - 仅在开启自动同步时显示 */}
      {autoUpdateDatabase && (
        <div className="form-group advanced-sync-settings">
          <label>自动同步高级参数</label>
          <span className="form-hint">调整以下参数可以减少同步时的界面抖动（需要保存配置后重启应用生效）</span>

          <div className="advanced-params-grid">
            <div className="param-item">
              <label>检查间隔</label>
              <div className="number-control">
                <button
                  className="control-btn minus"
                  onClick={() => setAutoUpdateCheckInterval(Math.max(10, autoUpdateCheckInterval - 10))}
                  disabled={autoUpdateCheckInterval <= 10}
                >
                  <Minus size={14} />
                </button>
                <div className="value-display">
                  <input
                    type="text"
                    value={autoUpdateCheckInterval}
                    readOnly
                  />
                  <span className="unit">秒</span>
                </div>
                <button
                  className="control-btn plus"
                  onClick={() => setAutoUpdateCheckInterval(Math.min(600, autoUpdateCheckInterval + 10))}
                  disabled={autoUpdateCheckInterval >= 600}
                >
                  <Plus size={14} />
                </button>
              </div>
              <span className="param-hint">定时检查数据库更新的间隔（10-600秒）</span>
            </div>

            <div className="param-item">
              <label>最小更新间隔</label>
              <div className="number-control">
                <button
                  className="control-btn minus"
                  onClick={() => setAutoUpdateMinInterval(Math.max(500, autoUpdateMinInterval - 100))}
                  disabled={autoUpdateMinInterval <= 500}
                >
                  <Minus size={14} />
                </button>
                <div className="value-display">
                  <input
                    type="text"
                    value={autoUpdateMinInterval}
                    readOnly
                  />
                  <span className="unit">毫秒</span>
                </div>
                <button
                  className="control-btn plus"
                  onClick={() => setAutoUpdateMinInterval(Math.min(10000, autoUpdateMinInterval + 100))}
                  disabled={autoUpdateMinInterval >= 10000}
                >
                  <Plus size={14} />
                </button>
              </div>
              <span className="param-hint">两次更新之间的最小间隔（500-10000毫秒）</span>
            </div>

            <div className="param-item">
              <label>防抖时间</label>
              <div className="number-control">
                <button
                  className="control-btn minus"
                  onClick={() => setAutoUpdateDebounceTime(Math.max(100, autoUpdateDebounceTime - 100))}
                  disabled={autoUpdateDebounceTime <= 100}
                >
                  <Minus size={14} />
                </button>
                <div className="value-display">
                  <input
                    type="text"
                    value={autoUpdateDebounceTime}
                    readOnly
                  />
                  <span className="unit">毫秒</span>
                </div>
                <button
                  className="control-btn plus"
                  onClick={() => setAutoUpdateDebounceTime(Math.min(5000, autoUpdateDebounceTime + 100))}
                  disabled={autoUpdateDebounceTime >= 5000}
                >
                  <Plus size={14} />
                </button>
              </div>
              <span className="param-hint">文件变化后等待稳定的时间（100-5000毫秒）</span>
            </div>
          </div>

          <div className="preset-buttons">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setAutoUpdateCheckInterval(30)
                setAutoUpdateMinInterval(500)
                setAutoUpdateDebounceTime(200)
              }}
            >
              快速响应
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setAutoUpdateCheckInterval(60)
                setAutoUpdateMinInterval(1000)
                setAutoUpdateDebounceTime(500)
              }}
            >
              平衡（推荐）
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setAutoUpdateCheckInterval(120)
                setAutoUpdateMinInterval(3000)
                setAutoUpdateDebounceTime(1000)
              }}
            >
              稳定优先
            </button>
          </div>
        </div>
      )}

      <div className="form-group">
        <label>解密密钥</label>
        <span className="form-hint">64位十六进制密钥</span>
        <div className="input-with-toggle">
          <input type={showDecryptKey ? 'text' : 'password'} placeholder="例如: a1b2c3d4e5f6..." value={decryptKey} onChange={(e) => setDecryptKey(e.target.value)} />
          <button type="button" className="toggle-visibility" onClick={() => setShowDecryptKey(!showDecryptKey)}>
            {showDecryptKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        {keyStatus && <span className="key-status">{keyStatus}</span>}
        <div className="btn-row">
          <button className="btn btn-primary" onClick={handleGetKey} disabled={isGettingKey}>
            <Key size={16} /> {isGettingKey ? '获取中...' : '自动获取密钥'}
          </button>
          {isGettingKey && <button className="btn btn-secondary" onClick={handleCancelGetKey}><X size={16} /> 取消</button>}
        </div>
      </div>

      <div className="form-group">
        <label>数据库根目录</label>
        <span className="form-hint">xwechat_files 目录</span>
        <input type="text" placeholder="例如: C:\Users\xxx\Documents\xwechat_files" value={dbPath} onChange={(e) => setDbPath(e.target.value)} />
        <button className="btn btn-primary" onClick={handleSelectDbPath}><FolderOpen size={16} /> 浏览选择</button>
      </div>

      <div className="form-group">
        <label>账号 wxid</label>
        <span className="form-hint">微信账号标识（只包含 db_storage 子目录的文件夹会被识别）</span>
        <input
          type="text"
          placeholder="例如: wxid_xxxxxx"
          value={wxid}
          onChange={(e) => setWxid(e.target.value)}
        />
        <div className="btn-row">
          <button className="btn btn-secondary" onClick={handleScanWxid} disabled={isScanningWxid}>
            <Search size={16} /> {isScanningWxid ? '扫描中...' : '扫描 wxid'}
          </button>
        </div>

        {/* 多账号选择列表 */}
        {showWxidDropdown && wxidOptions.length > 1 && (
          <>
            <div className="wxid-backdrop" onClick={() => setShowWxidDropdown(false)} />
            <div className="wxid-select-list">
              <div className="wxid-select-header">
                <span>检测到 {wxidOptions.length} 个账号，请选择：</span>
              </div>
              {wxidOptions.map((opt) => (
                <div
                  key={opt}
                  className={`wxid-select-item ${opt === wxid ? 'active' : ''}`}
                  onClick={() => handleSelectWxid(opt)}
                >
                  {opt}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="form-group">
        <label>缓存目录 <span className="optional">(可选)</span></label>
        <span className="form-hint">留空使用默认目录，尽可能不选择C盘</span>
        <input type="text" placeholder="留空使用默认目录" value={cachePath} onChange={(e) => setCachePath(e.target.value)} />
        <div className="btn-row">
          <button className="btn btn-secondary" onClick={handleSelectCachePath}><FolderOpen size={16} /> 浏览选择</button>
          <button className="btn btn-secondary" onClick={() => setCachePath('')}><RotateCcw size={16} /> 恢复默认</button>
        </div>
      </div>

      <div className="form-group">
        <div className="toggle-setting">
          <div className="toggle-header">
            <label className="toggle-label">
              <span className="toggle-title">跳过数据库完整性检查</span>
              <span className="toggle-switch">
                <input
                  type="checkbox"
                  checked={skipIntegrityCheck}
                  onChange={(e) => setSkipIntegrityCheck(e.target.checked)}
                />
                <span className="toggle-slider"></span>
              </span>
            </label>
          </div>
          <div className="toggle-description">
            <p>启用后将跳过更新时的数据库完整性验证，可以加快更新速度并减少界面卡顿。</p>
            <p className="toggle-warning">
              <AlertCircle size={14} />
              注意：关闭完整性检查可能会错过损坏的数据库文件。
            </p>
          </div>
        </div>
      </div>

      {/* 图片解密部分 */}
      <h3 className="section-title" style={{ marginTop: '2rem' }}>图片解密</h3>
      <p className="section-desc">您只负责获取密钥，其他的交给密语-CipherTalk</p>

      <div className="form-group">
        <label>XOR 密钥</label>
        <span className="form-hint">2位十六进制，如 0x53</span>
        <div className="input-with-toggle">
          <input type={showXorKey ? 'text' : 'password'} placeholder="例如: 0x12" value={imageXorKey} onChange={(e) => setImageXorKey(e.target.value)} />
          <button type="button" className="toggle-visibility" onClick={() => setShowXorKey(!showXorKey)}>
            {showXorKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>

      <div className="form-group">
        <label>AES 密钥</label>
        <span className="form-hint">至少16个字符（V4版本图片需要）</span>
        <div className="input-with-toggle">
          <input type={showAesKey ? 'text' : 'password'} placeholder="例如: b123456789012345..." value={imageAesKey} onChange={(e) => setImageAesKey(e.target.value)} />
          <button type="button" className="toggle-visibility" onClick={() => setShowAesKey(!showAesKey)}>
            {showAesKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>

      {imageKeyStatus && <p className="key-status">{imageKeyStatus}</p>}

      <button className="btn btn-primary" onClick={handleGetImageKey} disabled={isGettingImageKey}>
        <ImageIcon size={16} /> {isGettingImageKey ? '获取中...' : '自动获取图片密钥'}
      </button>
    </div>
  )

  const [isGettingImageKey, setIsGettingImageKey] = useState(false)
  const [imageKeyStatus, setImageKeyStatus] = useState('')

  const handleGetImageKey = async () => {
    if (isGettingImageKey) return
    if (!dbPath) {
      showMessage('请先配置数据库路径', false)
      return
    }
    if (!wxid) {
      showMessage('请先配置 wxid', false)
      return
    }

    setIsGettingImageKey(true)
    setImageKeyStatus('正在检查微信进程...')

    try {
      const isRunning = await window.electronAPI.wxKey.isWeChatRunning()
      if (!isRunning) {
        showMessage('请先启动微信并登录', false)
        setImageKeyStatus('')
        setIsGettingImageKey(false)
        return
      }

      // 构建用户目录路径
      const userDir = `${dbPath}\\${wxid}`

      const removeListener = window.electronAPI.imageKey.onProgress((msg) => {
        setImageKeyStatus(msg)
      })

      const result = await window.electronAPI.imageKey.getImageKeys(userDir)
      removeListener()

      if (result.success) {
        if (result.xorKey !== undefined) {
          const xorKeyHex = `0x${result.xorKey.toString(16).padStart(2, '0')}`
          setImageXorKey(xorKeyHex)
          await configService.setImageXorKey(xorKeyHex)
        }
        if (result.aesKey) {
          setImageAesKey(result.aesKey)
          await configService.setImageAesKey(result.aesKey)
        }
        showMessage('图片密钥获取成功！', true)
        setImageKeyStatus('')
      } else {
        showMessage(result.error || '获取图片密钥失败', false)
        setImageKeyStatus('')
      }
    } catch (e) {
      showMessage(`获取图片密钥失败: ${e}`, false)
      setImageKeyStatus('')
    } finally {
      setIsGettingImageKey(false)
    }
  }

  // ========== 语音转文字 (STT) 相关状态 ==========
  const [sttModelStatus, setSttModelStatus] = useState<{ exists: boolean; sizeBytes?: number } | null>(null)
  const [isLoadingSttStatus, setIsLoadingSttStatus] = useState(false)
  const [isDownloadingSttModel, setIsDownloadingSttModel] = useState(false)
  const [sttDownloadProgress, setSttDownloadProgress] = useState(0)

  // ========== Whisper GPU 加速相关状态 ==========
  const [whisperGpuInfo, setWhisperGpuInfo] = useState<{ available: boolean; provider: string; info: string } | null>(null)
  const [whisperModelType, setWhisperModelType] = useState<'tiny' | 'base' | 'small' | 'medium' | 'large-v3' | 'large-v3-turbo' | 'large-v3-turbo-q5' | 'large-v3-turbo-q8'>('small')
  const [whisperModelStatus, setWhisperModelStatus] = useState<{ exists: boolean; modelPath?: string; sizeBytes?: number } | null>(null)
  const [isLoadingWhisperStatus, setIsLoadingWhisperStatus] = useState(false)
  const [isDownloadingWhisperModel, setIsDownloadingWhisperModel] = useState(false)
  const [whisperDownloadProgress, setWhisperDownloadProgress] = useState(0)
  const [useWhisperGpu, setUseWhisperGpu] = useState(false)
  
  // GPU 组件状态
  const [gpuComponentsStatus, setGpuComponentsStatus] = useState<{ installed: boolean; missingFiles?: string[]; gpuDir?: string } | null>(null)
  const [isDownloadingGpuComponents, setIsDownloadingGpuComponents] = useState(false)
  const [gpuDownloadProgress, setGpuDownloadProgress] = useState({ overallProgress: 0, currentFile: '' })
  
  // ========== STT 模式切换 ==========
  const [sttMode, setSttMode] = useState<'cpu' | 'gpu'>('cpu')

  // 加载 STT 模型状态
  useEffect(() => {
    if (activeTab === 'stt') {
      loadSttModelStatus()
      loadWhisperStatus()
      loadSttMode()
      checkGpuComponents()
    }
  }, [activeTab])
  
  const loadSttMode = async () => {
    const savedMode = await window.electronAPI.config.get('sttMode') as 'cpu' | 'gpu' | undefined
    setSttMode(savedMode || 'cpu')
  }
  
  const handleSttModeChange = async (mode: 'cpu' | 'gpu') => {
    setSttMode(mode)
    await window.electronAPI.config.set('sttMode', mode)
    showMessage(mode === 'cpu' ? '已切换到 CPU 模式 (SenseVoice)' : '已切换到 GPU 模式 (Whisper)', true)
  }

  // 监听 STT 下载进度
  useEffect(() => {
    const removeListener = window.electronAPI.stt.onDownloadProgress((progress) => {
      setSttDownloadProgress(progress.percent || 0)
    })
    return () => removeListener()
  }, [])

  const loadSttModelStatus = async () => {
    setIsLoadingSttStatus(true)
    try {
      const result = await window.electronAPI.stt.getModelStatus()
      if (result.success) {
        setSttModelStatus({
          exists: result.exists || false,
          sizeBytes: result.sizeBytes
        })
      }
    } catch (e) {
      console.error('获取 STT 模型状态失败:', e)
    } finally {
      setIsLoadingSttStatus(false)
    }
  }

  const handleDownloadSttModel = async () => {
    if (isDownloadingSttModel) return
    setIsDownloadingSttModel(true)
    setSttDownloadProgress(0)

    try {
      showMessage('正在下载语音识别模型...', true)
      const result = await window.electronAPI.stt.downloadModel()
      if (result.success) {
        showMessage('语音识别模型下载完成！', true)
        await loadSttModelStatus()
      } else {
        showMessage(result.error || '模型下载失败', false)
      }
    } catch (e) {
      showMessage(`模型下载失败: ${e}`, false)
    } finally {
      setIsDownloadingSttModel(false)
    }
  }

  const handleSttLanguageToggle = async (lang: string) => {
    if (sttLanguages.includes(lang) && sttLanguages.length === 1) {
      showMessage('必须至少选择一种语言', false)
      return
    }

    const newLangs = sttLanguages.includes(lang)
      ? sttLanguages.filter(l => l !== lang)
      : [...sttLanguages, lang]
    setSttLanguagesState(newLangs)
    await configService.setSttLanguages(newLangs)
  }

  const handleSttModelTypeChange = async (type: 'int8' | 'float32') => {
    if (type === sttModelType) return

    // 如果已下载模型，切换类型需要重新下载
    if (sttModelStatus?.exists) {
      const confirmSwitch = confirm(
        `切换模型类型需要重新下载模型。\n\n` +
        `当前: ${sttModelTypeOptions.find(o => o.value === sttModelType)?.label}\n` +
        `切换到: ${sttModelTypeOptions.find(o => o.value === type)?.label} (${sttModelTypeOptions.find(o => o.value === type)?.size})\n\n` +
        `确定要切换吗？`
      )
      if (!confirmSwitch) return

      // 清除当前模型
      try {
        await window.electronAPI.stt.clearModel()
      } catch (e) {
        console.error('清除模型失败:', e)
      }
    }

    setSttModelType(type)
    await configService.setSttModelType(type)
    await loadSttModelStatus()
    showMessage(`模型类型已切换为 ${sttModelTypeOptions.find(o => o.value === type)?.label}`, true)
  }

  // ========== Whisper GPU 相关函数 ==========
  const loadWhisperStatus = async () => {
    setIsLoadingWhisperStatus(true)
    try {
      // 加载保存的模型类型
      const savedModelType = await window.electronAPI.config.get('whisperModelType') as 'tiny' | 'base' | 'small' | 'medium' | 'large-v3' | 'large-v3-turbo' | 'large-v3-turbo-q5' | 'large-v3-turbo-q8' | undefined
      const modelType = savedModelType || 'small'
      setWhisperModelType(modelType)

      const gpuInfo = await window.electronAPI.sttWhisper.detectGPU()
      setWhisperGpuInfo(gpuInfo)

      const modelStatus = await window.electronAPI.sttWhisper.checkModel(modelType)
      setWhisperModelStatus(modelStatus)

      const savedUseWhisper = await window.electronAPI.config.get('useWhisperGpu') as boolean | undefined
      setUseWhisperGpu(savedUseWhisper || false)
    } catch (e) {
      console.error('加载 Whisper 状态失败:', e)
    } finally {
      setIsLoadingWhisperStatus(false)
    }
  }

  const handleDownloadWhisperModel = async () => {
    if (isDownloadingWhisperModel) return
    setIsDownloadingWhisperModel(true)
    setWhisperDownloadProgress(0)

    const unsubscribe = window.electronAPI.sttWhisper.onDownloadProgress((progress) => {
      if (progress.percent) {
        setWhisperDownloadProgress(progress.percent)
      }
    })

    try {
      const result = await window.electronAPI.sttWhisper.downloadModel(whisperModelType)
      if (result.success) {
        showMessage('Whisper 模型下载完成！', true)
        await loadWhisperStatus()
      } else {
        showMessage(result.error || 'Whisper 模型下载失败', false)
      }
    } catch (e) {
      showMessage(`Whisper 模型下载失败: ${e}`, false)
    } finally {
      unsubscribe()
      setIsDownloadingWhisperModel(false)
    }
  }

  const handleWhisperModelTypeChange = async (type: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3' | 'large-v3-turbo' | 'large-v3-turbo-q5' | 'large-v3-turbo-q8') => {
    console.log('[SettingsPage] 切换 Whisper 模型类型:', type)
    setWhisperModelType(type)
    await window.electronAPI.config.set('whisperModelType', type)
    console.log('[SettingsPage] Whisper 模型类型已保存')
    await loadWhisperStatus()
  }

  // ========== GPU 组件管理 ==========
  const checkGpuComponents = async () => {
    try {
      const status = await window.electronAPI.sttWhisper.checkGPUComponents()
      setGpuComponentsStatus(status)
    } catch (e) {
      console.error('检查 GPU 组件失败:', e)
    }
  }

  const handleDownloadGpuComponents = async () => {
    if (isDownloadingGpuComponents) return
    
    // 检查是否设置了缓存目录
    if (!cachePath) {
      showMessage('请先设置缓存目录', false)
      return
    }

    if (!confirm('下载 GPU 组件约 645 MB，确定要下载吗？\n下载后将自动安装到缓存目录。')) {
      return
    }

    setIsDownloadingGpuComponents(true)
    setGpuDownloadProgress({ overallProgress: 0, currentFile: '' })

    const unsubscribe = window.electronAPI.sttWhisper.onGPUDownloadProgress((progress) => {
      setGpuDownloadProgress({
        overallProgress: progress.overallProgress,
        currentFile: progress.currentFile
      })
    })

    try {
      const result = await window.electronAPI.sttWhisper.downloadGPUComponents()
      if (result.success) {
        showMessage('GPU 组件下载完成！', true)
        await checkGpuComponents()
        await loadWhisperStatus()
      } else {
        showMessage(result.error || 'GPU 组件下载失败', false)
      }
    } catch (e) {
      showMessage(`GPU 组件下载失败: ${e}`, false)
    } finally {
      unsubscribe()
      setIsDownloadingGpuComponents(false)
    }
  }

  const handleToggleWhisperGpu = async (enabled: boolean) => {
    setUseWhisperGpu(enabled)
    await window.electronAPI.config.set('useWhisperGpu', enabled)
    showMessage(enabled ? 'Whisper GPU 加速已启用' : 'Whisper GPU 加速已禁用', true)
  }

  const renderSttTab = () => (
    <div className="tab-content">
      {/* STT 模式切换器 */}
      <div className="theme-mode-toggle" style={{ marginBottom: '2rem' }}>
        <button 
          className={`mode-btn ${sttMode === 'cpu' ? 'active' : ''}`} 
          onClick={() => handleSttModeChange('cpu')}
        >
          <Layers size={16} /> CPU 模式
        </button>
        <button 
          className={`mode-btn ${sttMode === 'gpu' ? 'active' : ''}`} 
          onClick={() => handleSttModeChange('gpu')}
        >
          <Zap size={16} /> GPU 模式
        </button>
      </div>

      {/* CPU 模式 - SenseVoice */}
      {sttMode === 'cpu' && (
        <>
          <h3 className="section-title">语音识别模型 (SenseVoice)</h3>
          <p className="section-desc">
            使用 SenseVoice 模型进行本地离线语音转文字，支持中文、英语、日语、韩语、粤语。
            选择合适的模型版本后下载，仅需下载一次。
          </p>

          <h4 className="subsection-title" style={{ marginTop: '1rem', marginBottom: '0.5rem', fontSize: '0.95rem', fontWeight: 500 }}>模型版本</h4>
          <div className="model-type-grid">
            {sttModelTypeOptions.map(opt => (
              <label
                key={opt.value}
                className={`model-card ${sttModelType === opt.value ? 'active' : ''} ${isDownloadingSttModel ? 'disabled' : ''}`}
              >
                <input
                  type="radio"
                  name="sttModelType"
                  value={opt.value}
                  checked={sttModelType === opt.value}
                  onChange={() => handleSttModelTypeChange(opt.value as 'int8' | 'float32')}
                  disabled={isDownloadingSttModel}
                />
                <div className="model-icon">
                  {opt.value === 'int8' ? <Zap size={24} /> : <Layers size={24} />}
                </div>
                <div className="model-info">
                  <div className="model-header">
                    <span className="model-name">{opt.label}</span>
                    <span className="model-size">{opt.size}</span>
                  </div>
                  <span className="model-desc">{opt.desc}</span>
                </div>
                {sttModelType === opt.value && <div className="model-check"><Check size={14} /></div>}
              </label>
            ))}
          </div>

          <div className="stt-model-status">
            {isLoadingSttStatus ? (
              <p>正在检查模型状态...</p>
            ) : sttModelStatus ? (
              <div className="model-info">
                <div className={`status-indicator ${sttModelStatus.exists ? 'ready' : 'missing'}`}>
                  {sttModelStatus.exists ? (
                    <>
                      <CheckCircle size={20} />
                      <span>模型已就绪</span>
                    </>
                  ) : (
                    <>
                      <AlertCircle size={20} />
                      <span>模型未下载</span>
                    </>
                  )}
                </div>
                {sttModelStatus.exists && sttModelStatus.sizeBytes && (
                  <p className="model-size">模型大小: {formatFileSize(sttModelStatus.sizeBytes)}</p>
                )}
              </div>
            ) : (
              <p>无法获取模型状态</p>
            )}
          </div>

          {isDownloadingSttModel && (
            <div className="download-progress">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${sttDownloadProgress}%` }} />
              </div>
              <span className="progress-text">{sttDownloadProgress.toFixed(1)}%</span>
            </div>
          )}

          <h3 className="section-title" style={{ marginTop: '2rem' }}>支持语言</h3>
          <p className="section-desc">选择需要识别的语言，支持多选。若选择多种语言，模型将自动检测。</p>
          <div className="language-grid">
            {sttLanguageOptions.map(opt => (
              <label
                key={opt.value}
                className={`language-card ${sttLanguages.includes(opt.value) ? 'active' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={sttLanguages.includes(opt.value)}
                  onChange={() => handleSttLanguageToggle(opt.value)}
                  disabled={sttLanguages.includes(opt.value) && sttLanguages.length === 1}
                />
                <div className="lang-info">
                  <span className="lang-name">{opt.label}</span>
                  <span className="lang-en">{opt.enLabel}</span>
                </div>
                {sttLanguages.includes(opt.value) && <div className="lang-check"><Check size={14} /></div>}
              </label>
            ))}
          </div>

          <div className="btn-row" style={{ marginTop: '1rem' }}>
            {!sttModelStatus?.exists && (
              <button
                className="btn btn-primary"
                onClick={handleDownloadSttModel}
                disabled={isDownloadingSttModel}
              >
                <Download size={16} /> {isDownloadingSttModel ? '下载中...' : '下载模型'}
              </button>
            )}
            {sttModelStatus?.exists && (
              <button
                className="btn btn-danger"
                onClick={async () => {
                  const currentModelSize = sttModelTypeOptions.find(o => o.value === sttModelType)?.size || '235 MB'
                  if (confirm(`确定要清除语音识别模型吗？下次使用需要重新下载 (${currentModelSize})。`)) {
                    try {
                      const result = await window.electronAPI.stt.clearModel()
                      if (result.success) {
                        showMessage('模型清除成功', true)
                        await loadSttModelStatus()
                      } else {
                        showMessage(result.error || '模型清除失败', false)
                      }
                    } catch (e) {
                      showMessage(`模型清除失败: ${e}`, false)
                    }
                  }
                }}
              >
                <Trash2 size={16} /> 清除模型
              </button>
            )}
            <button
              className="btn btn-secondary"
              onClick={loadSttModelStatus}
              disabled={isLoadingSttStatus}
            >
              <RefreshCw size={16} className={isLoadingSttStatus ? 'spin' : ''} /> 刷新状态
            </button>
          </div>
        </>
      )}

      {/* GPU 模式 - Whisper */}
      {sttMode === 'gpu' && (
        <>
          <h3 className="section-title">语音识别模型 (Whisper GPU)</h3>
          <p className="section-desc">
            使用 Whisper.cpp 进行 GPU 加速的语音识别，性能提升 10-15 倍。支持 NVIDIA GPU (CUDA)。
          </p>

          {/* GPU 状态卡片 */}
          <div className="gpu-status-card" style={{ 
            padding: '1rem', 
            background: 'var(--bg-secondary)', 
            borderRadius: '12px',
            marginBottom: '1.5rem',
            border: '1px solid var(--border-color)'
          }}>
            {isLoadingWhisperStatus ? (
              <p style={{ margin: 0, color: 'var(--text-secondary)' }}>正在检测 GPU...</p>
            ) : whisperGpuInfo ? (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  {whisperGpuInfo.available ? (
                    <CheckCircle size={20} style={{ color: 'var(--success-color)' }} />
                  ) : (
                    <AlertCircle size={20} style={{ color: 'var(--warning-color)' }} />
                  )}
                  <strong style={{ fontSize: '15px' }}>{whisperGpuInfo.provider}</strong>
                </div>
                <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                  {whisperGpuInfo.info}
                </p>
              </div>
            ) : (
              <p style={{ margin: 0, color: 'var(--text-secondary)' }}>无法检测 GPU 状态</p>
            )}
          </div>

          {/* GPU 组件状态 */}
          <div className="gpu-components-card" style={{ 
            padding: '1.25rem', 
            background: 'var(--bg-secondary)', 
            borderRadius: '12px',
            marginBottom: '1.5rem',
            border: '1px solid var(--border-color)',
            transition: 'all 0.3s ease'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <div style={{ 
                  width: '32px', 
                  height: '32px', 
                  borderRadius: '8px', 
                  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}>
                  <Download size={18} color="white" />
                </div>
                <strong style={{ fontSize: '15px' }}>GPU 加速组件</strong>
              </div>
              {gpuComponentsStatus?.installed ? (
                <span style={{ 
                  fontSize: '13px', 
                  color: 'var(--success-color)', 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '0.25rem',
                  padding: '0.25rem 0.75rem',
                  background: 'var(--success-bg)',
                  borderRadius: '12px',
                  fontWeight: 500
                }}>
                  <CheckCircle size={16} /> 已安装
                </span>
              ) : (
                <span style={{ 
                  fontSize: '13px', 
                  color: 'var(--warning-color)', 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '0.25rem',
                  padding: '0.25rem 0.75rem',
                  background: 'var(--warning-bg)',
                  borderRadius: '12px',
                  fontWeight: 500
                }}>
                  <AlertCircle size={16} /> 未安装
                </span>
              )}
            </div>
            
            {gpuComponentsStatus?.installed ? (
              <div style={{ 
                padding: '0.75rem', 
                background: 'var(--bg-tertiary)', 
                borderRadius: '8px',
                fontSize: '13px',
                color: 'var(--text-secondary)',
                wordBreak: 'break-all'
              }}>
                <div style={{ marginBottom: '0.25rem', color: 'var(--text-primary)', fontWeight: 500 }}>
                  安装位置
                </div>
                {gpuComponentsStatus.gpuDir}
              </div>
            ) : (
              <>
                <div style={{ 
                  padding: '0.75rem', 
                  background: 'var(--bg-tertiary)', 
                  borderRadius: '8px',
                  marginBottom: '1rem'
                }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <AlertCircle size={16} style={{ marginTop: '2px', flexShrink: 0, color: 'var(--primary-color)' }} />
                    <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                      GPU 加速需要下载约 <strong style={{ color: 'var(--text-primary)' }}>645 MB</strong> 的 CUDA 组件，将安装到缓存目录。
                      <br />
                      下载支持断点续传，可随时暂停和恢复。
                    </div>
                  </div>
                </div>
                {isDownloadingGpuComponents ? (
                  <div>
                    <div style={{ 
                      marginBottom: '0.75rem', 
                      fontSize: '13px', 
                      color: 'var(--text-primary)',
                      fontWeight: 500,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem'
                    }}>
                      <div className="spinner" style={{ 
                        width: '14px', 
                        height: '14px', 
                        border: '2px solid var(--border-color)',
                        borderTopColor: 'var(--primary-color)',
                        borderRadius: '50%',
                        animation: 'spin 0.8s linear infinite'
                      }} />
                      {gpuDownloadProgress.currentFile}
                    </div>
                    <div style={{ 
                      background: 'var(--bg-tertiary)', 
                      borderRadius: '8px', 
                      overflow: 'hidden',
                      height: '8px',
                      position: 'relative'
                    }}>
                      <div style={{ 
                        width: `${gpuDownloadProgress.overallProgress}%`,
                        height: '100%',
                        background: 'linear-gradient(90deg, #667eea 0%, #764ba2 100%)',
                        transition: 'width 0.3s ease',
                        position: 'relative',
                        overflow: 'hidden'
                      }}>
                        <div style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          right: 0,
                          bottom: 0,
                          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent)',
                          animation: 'shimmer 1.5s infinite'
                        }} />
                      </div>
                    </div>
                    <div style={{ 
                      marginTop: '0.75rem', 
                      fontSize: '13px', 
                      textAlign: 'center', 
                      color: 'var(--text-secondary)',
                      fontWeight: 500
                    }}>
                      {gpuDownloadProgress.overallProgress.toFixed(1)}%
                    </div>
                  </div>
                ) : (
                  <button 
                    className="btn-primary"
                    onClick={handleDownloadGpuComponents}
                    style={{ 
                      width: '100%', 
                      padding: '0.75rem 1rem',
                      borderRadius: '9999px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '0.5rem',
                      fontSize: '14px',
                      fontWeight: 500
                    }}
                  >
                    <Download size={16} />
                    下载 GPU 组件 (645 MB)
                  </button>
                )}
              </>
            )}
          </div>

          {/* 模型选择 */}
          <h4 className="subsection-title" style={{ marginTop: '1rem', marginBottom: '0.5rem', fontSize: '0.95rem', fontWeight: 500 }}>模型大小</h4>
          <div className="model-type-grid">
            {[
              { value: 'tiny', label: 'Tiny 模型', size: '75 MB', desc: '最快速度，适合实时场景' },
              { value: 'base', label: 'Base 模型', size: '145 MB', desc: '推荐使用，速度与精度平衡' },
              { value: 'small', label: 'Small 模型', size: '488 MB', desc: '更高精度，适合准确识别' },
              { value: 'large-v3-turbo-q5', label: 'Turbo-Q5 量化', size: '540 MB', desc: '极高精度 + 小体积（推荐）' },
              { value: 'large-v3-turbo-q8', label: 'Turbo-Q8 量化', size: '835 MB', desc: '极高精度 + 高质量量化' },
              { value: 'medium', label: 'Medium 模型', size: '1.5 GB', desc: '最佳精度，需要更多时间' },
              { value: 'large-v3-turbo', label: 'Large-v3-Turbo', size: '1.62 GB', desc: '极高精度 + 快速' },
              { value: 'large-v3', label: 'Large-v3 模型', size: '3.1 GB', desc: '极高精度，专业级识别' }
            ].map(opt => (
              <label
                key={opt.value}
                className={`model-card ${whisperModelType === opt.value ? 'active' : ''} ${isDownloadingWhisperModel ? 'disabled' : ''}`}
              >
                <input
                  type="radio"
                  name="whisperModelType"
                  value={opt.value}
                  checked={whisperModelType === opt.value}
                  onChange={() => handleWhisperModelTypeChange(opt.value as any)}
                  disabled={isDownloadingWhisperModel}
                />
                <div className="model-icon">
                  <Zap size={24} />
                </div>
                <div className="model-info">
                  <div className="model-header">
                    <span className="model-name">{opt.label}</span>
                    <span className="model-size">{opt.size}</span>
                  </div>
                  <span className="model-desc">{opt.desc}</span>
                </div>
                {whisperModelType === opt.value && <div className="model-check"><Check size={14} /></div>}
              </label>
            ))}
          </div>

          {/* 模型状态 */}
          <div className="stt-model-status">
            {isLoadingWhisperStatus ? (
              <p>正在检查模型状态...</p>
            ) : whisperModelStatus ? (
              <div className="model-info">
                <div className={`status-indicator ${whisperModelStatus.exists ? 'ready' : 'missing'}`}>
                  {whisperModelStatus.exists ? (
                    <>
                      <CheckCircle size={20} />
                      <span>模型已就绪</span>
                    </>
                  ) : (
                    <>
                      <AlertCircle size={20} />
                      <span>模型未下载</span>
                    </>
                  )}
                </div>
                {whisperModelStatus.exists && whisperModelStatus.sizeBytes && (
                  <p className="model-size">模型大小: {formatFileSize(whisperModelStatus.sizeBytes)}</p>
                )}
              </div>
            ) : (
              <p>无法获取模型状态</p>
            )}
          </div>

          {/* 下载进度 */}
          {isDownloadingWhisperModel && (
            <div className="download-progress">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${whisperDownloadProgress}%` }} />
              </div>
              <span className="progress-text">{whisperDownloadProgress.toFixed(1)}%</span>
            </div>
          )}

          {/* 操作按钮 */}
          <div className="btn-row" style={{ marginTop: '1rem' }}>
            {!whisperModelStatus?.exists && (
              <button
                className="btn btn-primary"
                onClick={handleDownloadWhisperModel}
                disabled={isDownloadingWhisperModel}
              >
                <Download size={16} /> {isDownloadingWhisperModel ? '下载中...' : '下载模型'}
              </button>
            )}
            {whisperModelStatus?.exists && (
              <button
                className="btn btn-danger"
                onClick={async () => {
                  const modelSizes = {
                    tiny: '75 MB',
                    base: '145 MB',
                    small: '488 MB',
                    medium: '1.5 GB',
                    'large-v3': '3.1 GB',
                    'large-v3-turbo': '1.62 GB',
                    'large-v3-turbo-q5': '540 MB',
                    'large-v3-turbo-q8': '835 MB'
                  }
                  const currentModelSize = modelSizes[whisperModelType]
                  if (confirm(`确定要清除 Whisper 模型吗？下次使用需要重新下载 (${currentModelSize})。`)) {
                    try {
                      const result = await window.electronAPI.sttWhisper.clearModel(whisperModelType)
                      if (result.success) {
                        showMessage('模型清除成功', true)
                        await loadWhisperStatus()
                      } else {
                        showMessage(result.error || '模型清除失败', false)
                      }
                    } catch (e) {
                      showMessage(`模型清除失败: ${e}`, false)
                    }
                  }
                }}
              >
                <Trash2 size={16} /> 清除模型
              </button>
            )}
            <button
              className="btn btn-secondary"
              onClick={loadWhisperStatus}
              disabled={isLoadingWhisperStatus}
            >
              <RefreshCw size={16} className={isLoadingWhisperStatus ? 'spin' : ''} /> 刷新状态
            </button>
          </div>
        </>
      )}

      <h3 className="section-title" style={{ marginTop: '2rem' }}>使用说明</h3>
      <div className="stt-instructions">
        <ol>
          <li>选择 CPU 或 GPU 模式</li>
          <li>下载对应的语音识别模型（仅需一次）</li>
          <li>在聊天记录中点击语音消息</li>
          <li>点击"转文字"按钮即可将语音转换为文字</li>
        </ol>
        <p className="note">
          <strong>注意：</strong>所有语音识别均在本地完成，不会上传任何数据，保护您的隐私。
        </p>
      </div>
    </div>
  )



  const handleSecurityMethodSelect = async (method: 'biometric' | 'password') => {
    // 1. 如果点击的是当前已激活的方法 -> 关闭
    if (isAuthEnabled && authMethod === method) {
      await disableAuth()
      showMessage('已关闭应用锁', true)
      if (method === 'password') {
        setShowPasswordInput(false)
        setPasswordInput('')
      }
      return
    }

    // 2. 如果点击的是另一个方法 -> 确认切换
    if (isAuthEnabled && authMethod !== method) {
      setSecurityConfirm({
        show: true,
        title: '切换认证方式',
        message: method === 'biometric'
          ? '切换到 Windows Hello 将清除当前的密码设置，是否继续？'
          : '切换到密码认证将清除当前的生物识别设置，是否继续？',
        onConfirm: async () => {
          await disableAuth()
          if (method === 'biometric') {
            activateBiometric()
          } else {
            setShowPasswordInput(true)
          }
          setSecurityConfirm(prev => ({ ...prev, show: false }))
        }
      })
      return
    }

    // 3. 如果当前未激活任何方法 -> 直接开启
    if (method === 'biometric') {
      activateBiometric()
    } else {
      setShowPasswordInput(true)
    }
  }

  const activateBiometric = async () => {
    showMessage('正在等待 Windows Hello 验证...', true)
    const result = await enableAuth()
    if (result.success) {
      showMessage('已启用 Windows Hello', true)
      setShowPasswordInput(false)
    } else {
      showMessage(result.error || '启用失败', false)
    }
  }

  const renderSecurityTab = () => (
    <div className="tab-content">
      <h3 className="section-title">安全保护</h3>
      <div className="section-desc">配置应用启动时的安全验证方式，保护您的隐私数据。</div>

      <div className="security-grid">
        {/* Windows Hello Card */}
        <div
          className={`security-card ${isAuthEnabled && authMethod === 'biometric' ? 'active' : ''}`}
          onClick={() => handleSecurityMethodSelect('biometric')}
          style={{ cursor: 'pointer' }}
        >
          <div className="security-preview-area">
            <div className="preview-lock-screen">
              <div className="preview-avatar">
                <Lock size={20} />
              </div>
              <div className="preview-badge">
                <Fingerprint /> Windows Hello
              </div>
              <div className="preview-btn" />
            </div>
          </div>
          <div className="security-content">
            <div className="security-header">
              <span className="security-title">Windows Hello</span>
              {isAuthEnabled && authMethod === 'biometric' && (
                <div className="theme-check" style={{ position: 'relative', top: 0, right: 0, transform: 'scale(1)', background: 'var(--primary)', boxShadow: 'none' }}>
                  <Check size={12} />
                </div>
              )}
            </div>
            <div className="security-desc">
              使用系统的面部识别、指纹或 PIN 码进行验证。体验最流畅，安全性高。
            </div>
          </div>
        </div>

        {/* Custom Password Card */}
        <div
          className={`security-card ${isAuthEnabled && authMethod === 'password' ? 'active' : ''}`}
          onClick={() => handleSecurityMethodSelect('password')}
          style={{ cursor: 'pointer' }}
        >
          <div className="security-preview-area">
            <div className="preview-lock-screen">
              <div className="preview-avatar">
                <ShieldCheck size={20} />
              </div>
              <div className="preview-input" />
              <div className="preview-btn" style={{ width: '32px' }} />
            </div>
          </div>
          <div className="security-content">
            <div className="security-header">
              <span className="security-title">自定义应用密码</span>
              {isAuthEnabled && authMethod === 'password' && (
                <div className="theme-check" style={{ position: 'relative', top: 0, right: 0, transform: 'scale(1)', background: 'var(--primary)', boxShadow: 'none' }}>
                  <Check size={12} />
                </div>
              )}
            </div>
            <div className="security-desc">
              设置应用专属密码。如果不方便使用生物识别，或者需要在多台设备间同步配置时推荐。
            </div>

            {/* Input area - prevent click propagation to avoid toggling card off while typing */}
            {(showPasswordInput || (isAuthEnabled && authMethod === 'password')) && (
              <div
                className="password-setup-inline"
                onClick={(e) => e.stopPropagation()}
                style={{ cursor: 'default' }}
              >
                <label className="field-label">
                  {authMethod === 'password' ? '修改密码 (留空不修改)' : '设置新密码'}
                </label>
                <div className="password-input-row">
                  <input
                    type="password"
                    className="field-input"
                    value={passwordInput}
                    onChange={(e) => setPasswordInput(e.target.value)}
                    placeholder="******"
                  />
                  <button
                    className="btn btn-primary"
                    disabled={!passwordInput}
                    onClick={async () => {
                      if (!passwordInput) return
                      const result = await setupPassword(passwordInput)
                      if (result.success) {
                        showMessage(authMethod === 'password' ? '密码已更新' : '已启用密码锁', true)
                        setPasswordInput('')
                        setShowPasswordInput(false)
                      } else {
                        showMessage(result.error || '设置失败', false)
                      }
                    }}
                  >
                    <Save size={14} /> 保存
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Confirmation Modal */}
      {securityConfirm.show && (
        <div className="clear-dialog-overlay">
          <div className="clear-dialog">
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <AlertCircle className="text-warning" size={20} color="#f59e0b" />
              {securityConfirm.title}
            </h3>
            <p>{securityConfirm.message}</p>
            <div className="dialog-actions">
              <button
                className="btn btn-secondary"
                onClick={() => setSecurityConfirm(prev => ({ ...prev, show: false }))}
              >
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={securityConfirm.onConfirm}
              >
                确定切换
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )

  const renderDataManagementTab = () => (
    <div className="tab-content">
      {/* 导出设置 */}
      <section className="settings-section">
        <h3 className="section-title">导出设置</h3>

        <div className="form-group">
          <label>导出目录</label>
          <span className="form-hint">聊天记录导出的默认保存位置</span>
          <input type="text" placeholder={defaultExportPath || '系统下载目录'} value={exportPath || defaultExportPath} onChange={(e) => setExportPath(e.target.value)} />
          <div className="btn-row">
            <button className="btn btn-secondary" onClick={handleSelectExportPath}><FolderOpen size={16} /> 浏览选择</button>
            <button className="btn btn-secondary" onClick={handleResetExportPath}><RotateCcw size={16} /> 恢复默认</button>
          </div>
        </div>

        <div className="form-group">
          <label>默认日期范围</label>
          <span className="form-hint">导出时自动填充的日期范围，0表示不限制</span>
          <div className="date-range-options">
            {[
              { value: 0, label: '不限制', desc: '全部消息' },
              { value: 1, label: '今天', desc: '仅今日消息' },
              { value: 7, label: '最近7天', desc: '过去一周' },
              { value: 30, label: '最近30天', desc: '过去一个月' },
              { value: 90, label: '最近90天', desc: '过去三个月' },
              { value: 180, label: '最近180天', desc: '过去半年' },
              { value: 365, label: '最近1年', desc: '过去一年' }
            ].map(option => (
              <label
                key={option.value}
                className={`date-range-card ${exportDefaultDateRange === option.value ? 'active' : ''}`}
              >
                <input
                  type="radio"
                  name="exportDefaultDateRange"
                  value={option.value}
                  checked={exportDefaultDateRange === option.value}
                  onChange={(e) => setExportDefaultDateRange(Number(e.target.value))}
                />
                <div className="date-range-content">
                  <span className="date-range-label">{option.label}</span>
                  <span className="date-range-desc">{option.desc}</span>
                </div>
                {exportDefaultDateRange === option.value && (
                  <div className="date-range-check"><Check size={14} /></div>
                )}
              </label>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label>默认导出选项</label>
          <div className="export-default-options">
            <label className={`export-option-card ${exportDefaultAvatars ? 'active' : ''}`}>
              <input
                type="checkbox"
                checked={exportDefaultAvatars}
                onChange={(e) => setExportDefaultAvatars(e.target.checked)}
              />
              <div className="option-content">
                <div className="option-icon">
                  <User size={20} />
                </div>
                <div className="option-info">
                  <span className="option-label">默认导出头像</span>
                  <span className="option-desc">勾选后导出时默认包含头像</span>
                </div>
              </div>
              {exportDefaultAvatars && (
                <div className="option-check"><Check size={14} /></div>
              )}
            </label>
          </div>
        </div>
      </section>

      <div className="divider" style={{ margin: '2rem 0', borderBottom: '1px solid var(--border-color)', opacity: 0.1 }} />

      {/* 缓存管理 */}
      <section className="settings-section cache-management">
        <h3 className="section-title">缓存管理</h3>
        {isLoadingCacheSize ? (
          <p className="cache-loading">正在计算缓存大小...</p>
        ) : cacheSize ? (
          <div className="cache-cards">
            <div className="cache-card">
              <div className="cache-card-header">
                <ImageIcon size={20} className="cache-card-icon" />
                <span className="cache-card-label">图片缓存</span>
              </div>
              <div className="cache-card-size">{formatFileSize(cacheSize.images)}</div>
              <button type="button" className="btn btn-secondary cache-card-btn" onClick={handleClearImages}>
                <Trash2 size={14} /> 清除
              </button>
            </div>
            <div className="cache-card">
              <div className="cache-card-header">
                <Smile size={20} className="cache-card-icon" />
                <span className="cache-card-label">表情包缓存</span>
              </div>
              <div className="cache-card-size">{formatFileSize(cacheSize.emojis)}</div>
              <button type="button" className="btn btn-secondary cache-card-btn" onClick={handleClearEmojis}>
                <Trash2 size={14} /> 清除
              </button>
            </div>
            <div className="cache-card">
              <div className="cache-card-header">
                <Database size={20} className="cache-card-icon" />
                <span className="cache-card-label">数据库缓存</span>
              </div>
              <div className="cache-card-size">{formatFileSize(cacheSize.databases)}</div>
              <button type="button" className="btn btn-secondary cache-card-btn" onClick={handleClearDatabases}>
                <Trash2 size={14} /> 清除
              </button>
            </div>
            <div className="cache-card cache-card-config">
              <div className="cache-card-header">
                <Key size={20} className="cache-card-icon" />
                <span className="cache-card-label">配置信息</span>
              </div>
              <div className="cache-card-desc">密钥、路径等</div>
              <button type="button" className="btn btn-secondary cache-card-btn" onClick={handleClearConfig}>
                <Trash2 size={14} /> 清除配置
              </button>
            </div>
            <div className="cache-card cache-card-total">
              <div className="cache-card-header">
                <Layers size={20} className="cache-card-icon" />
                <span className="cache-card-label">总计</span>
              </div>
              <div className="cache-card-size">{formatFileSize(cacheSize.total)}</div>
              <button type="button" className="btn btn-danger cache-card-btn" onClick={handleClearAllCache}>
                <Trash2 size={14} /> 清除所有缓存
              </button>
            </div>
          </div>
        ) : (
          <p>无法获取缓存信息</p>
        )}
      </section>

      <div className="divider" style={{ margin: '2rem 0', borderBottom: '1px solid var(--border-color)', opacity: 0.1 }} />

      {/* 日志管理 */}
      <section className="settings-section">
        <h3 className="section-title">日志管理</h3>

        <div className="form-group">
          <div className="log-stats-lite" style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}>
            <span className="log-value">日志文件: {logFiles.length}个</span>
            <span className="log-value">总大小: {formatFileSize(logSize)}</span>
            <span className="log-value">当前级别: {currentLogLevel}</span>
          </div>

          <div className="log-level-options" style={{ marginBottom: '1rem' }}>
            {['DEBUG', 'INFO', 'WARN', 'ERROR'].map((level) => (
              <button
                key={level}
                className={`log-level-btn ${currentLogLevel === level ? 'active' : ''}`}
                onClick={() => handleLogLevelChange(level)}
              >
                {level}
              </button>
            ))}
          </div>

          <div className="btn-row">
            <button className="btn btn-secondary" onClick={handleOpenLogDirectory}>
              <FolderOpen size={16} /> 打开日志目录
            </button>
            <button className="btn btn-secondary" onClick={loadLogFiles} disabled={isLoadingLogs}>
              <RefreshCw size={16} className={isLoadingLogs ? 'spin' : ''} /> 刷新
            </button>
            <button className="btn btn-danger" onClick={handleClearLogs}>
              <Trash2 size={16} /> 清除所有日志
            </button>
          </div>
        </div>

        <div className="log-files" style={{ marginTop: '1rem' }}>
          <h4>最近日志</h4>
          {isLoadingLogs ? (
            <p>正在加载...</p>
          ) : logFiles.length > 0 ? (
            <div className="log-file-list" style={{ maxHeight: '200px', overflowY: 'auto' }}>
              {logFiles.map((file) => (
                <div
                  key={file.name}
                  className={`log-file-item ${selectedLogFile === file.name ? 'selected' : ''}`}
                  onClick={() => handleLogFileSelect(file.name)}
                >
                  <div className="log-file-info">
                    <span className="log-file-name">{file.name}</span>
                    <span className="log-file-size">{formatFileSize(file.size)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p>暂无日志文件</p>
          )}
        </div>

        {selectedLogFile && (
          <div className="log-content log-content-selectable" style={{ marginTop: '1rem' }}>
            <div className="log-content-text" style={{ maxHeight: '300px', overflowY: 'auto' }}>
              <pre>{logContent}</pre>
            </div>
          </div>
        )}
      </section>
    </div>
  )





  const getTypeDisplayName = (type: string | null) => {
    if (!type) return '未激活'
    const typeMap: Record<string, string> = {
      '30days': '30天试用版',
      '90days': '90天标准版',
      '365days': '365天专业版',
      'permanent': '永久版'
    }
    return typeMap[type] || type
  }

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '永久'
    return new Date(dateStr).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  }

  const renderActivationTab = () => (
    <div className="tab-content activation-tab">
      <div className={`activation-status-card ${activationStatus?.isActivated ? 'activated' : 'inactive'}`}>
        <div className="status-icon">
          {activationStatus?.isActivated ? (
            <CheckCircle size={48} />
          ) : (
            <AlertCircle size={48} />
          )}
        </div>
        <div className="status-content">
          <h3>{activationStatus?.isActivated ? '已激活' : '未激活'}</h3>
          {activationStatus?.isActivated && (
            <>
              <p className="status-type">{getTypeDisplayName(activationStatus.type)}</p>
              {activationStatus.daysRemaining !== null && activationStatus.type !== 'permanent' && (
                <p className="status-expires">
                  <Clock size={14} />
                  {activationStatus.daysRemaining > 0
                    ? `剩余 ${activationStatus.daysRemaining} 天`
                    : '已过期'}
                </p>
              )}
              {activationStatus.expiresAt && (
                <p className="status-date">到期时间：{formatDate(activationStatus.expiresAt)}</p>
              )}
              {activationStatus.activatedAt && (
                <p className="status-date">激活时间：{formatDate(activationStatus.activatedAt)}</p>
              )}
            </>
          )}
        </div>
      </div>

      <div className="device-info-card">
        <h4>设备信息</h4>
        <div className="device-id-row">
          <span className="label">设备标识：</span>
          <code>{activationStatus?.deviceId || '获取中...'}</code>
        </div>
      </div>

      <div className="activation-actions">
        <button className="btn btn-secondary" onClick={() => checkActivationStatus()}>
          <RefreshCw size={16} /> 刷新状态
        </button>
        <button className="btn btn-primary" onClick={() => window.electronAPI.window.openPurchaseWindow()}>
          <Key size={16} /> 获取激活码
        </button>
      </div>
    </div>
  )

  const location = useLocation()

  // 检查导航传递的更新信息
  useEffect(() => {
    if (location.state?.updateInfo) {
      setUpdateInfo(location.state.updateInfo)
    }
  }, [location.state])

  const renderAboutTab = () => (
    <div className="tab-content about-tab">
      <div className="about-card">
        <div className="about-logo">
          <img src={appIcon === 'xinnian' ? "./xinnian.png" : "./logo.png"} alt="密语" />
        </div>
        <h2 className="about-name">密语</h2>
        <p className="about-slogan">CipherTalk</p>
        <p className="about-version">v{appVersion || '...'}</p>

        <div className="about-update">
          {updateInfo?.hasUpdate ? (
            <>
              <p className="update-hint">新版本 v{updateInfo.version} 可用</p>
              {isDownloading ? (
                <div className="download-progress">
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${downloadProgress}%` }} />
                  </div>
                  <span>{downloadProgress.toFixed(0)}%</span>
                </div>
              ) : (
                <button className="btn btn-primary" onClick={handleUpdateNow}>
                  <Download size={16} /> 立即更新
                </button>
              )}
            </>
          ) : (
            <button className="btn btn-secondary" onClick={handleCheckUpdate} disabled={isCheckingUpdate}>
              <RefreshCw size={16} className={isCheckingUpdate ? 'spin' : ''} />
              {isCheckingUpdate ? '检查中...' : '检查更新'}
            </button>
          )}
        </div>
      </div>

      <div className="about-footer">
        <div className="github-capsules" style={{ display: 'flex', gap: '12px', justifyContent: 'center', marginBottom: '16px' }}>
          <button
            className="btn btn-secondary"
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', borderRadius: '20px' }}
            onClick={() => window.electronAPI.shell.openExternal('https://github.com/ILoveBingLu/miyu')}
          >
            <Github size={16} />
            <span>密语 CipherTalk</span>
          </button>
          <button
            className="btn btn-secondary"
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 16px', borderRadius: '20px' }}
            onClick={() => window.electronAPI.shell.openExternal('https://github.com/hicccc77/WeFlow')}
          >
            <Github size={16} />
            <span>WeFlow</span>
          </button>
        </div>

        <p className="about-warning" style={{ color: '#ff4d4f', fontWeight: 500, marginBottom: '20px' }}>
          软件为免费，如果有人找你收钱，请骂死他，太贱了，拿别人东西卖钱！
        </p>

        <div className="about-links">
          <a href="#" onClick={(e) => { e.preventDefault(); window.electronAPI.shell.openExternal('https://miyu.aiqji.com') }}>官网</a>
          <span>·</span>
          <a href="#" onClick={(e) => { e.preventDefault(); window.electronAPI.shell.openExternal('https://chatlab.fun') }}>ChatLab</a>
          <span>·</span>
          <a href="#" onClick={(e) => { e.preventDefault(); window.electronAPI.window.openAgreementWindow() }}>用户协议</a>
        </div>
        <p className="copyright">© {new Date().getFullYear()} 密语-CipherTalk. All rights reserved.</p>
      </div>
    </div>
  )

  return (
    <div className="settings-page">
      {message && <div className={`message-toast ${message.success ? 'success' : 'error'}`}>{message.text}</div>}

      {/* 清除确认对话框 */}
      {showClearDialog && (
        <div className="clear-dialog-overlay">
          <div className="clear-dialog">
            <h3>{showClearDialog.title}</h3>
            <p>{showClearDialog.message}</p>
            <div className="dialog-actions">
              <button
                className="btn btn-danger"
                onClick={confirmClear}
              >
                确定
              </button>
              <button
                className="btn btn-secondary dialog-cancel"
                onClick={() => setShowClearDialog(null)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="settings-header">
        <h1>设置</h1>
        <div className="settings-actions">
          <button className="btn btn-secondary" onClick={handleTestConnection} disabled={isLoading || isTesting}>
            <Plug size={16} /> {isTesting ? '测试中...' : '测试连接'}
          </button>
          <button className="btn btn-primary" onClick={handleSaveConfig} disabled={isLoading}>
            <Save size={16} /> {isLoading ? '保存中...' : '保存配置'}
          </button>
        </div>
      </div>

      <div className="settings-tabs">
        {tabs.map(tab => (
          <button key={tab.id} className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`} onClick={() => setActiveTab(tab.id)}>
            <tab.icon size={16} />
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      <div className="settings-body">
        {activeTab === 'appearance' && renderAppearanceTab()}
        {activeTab === 'database' && renderDatabaseTab()}
        {activeTab === 'security' && renderSecurityTab()}
        {activeTab === 'stt' && renderSttTab()}
        {activeTab === 'ai' && (
          <AISummarySettings
            provider={aiProvider}
            setProvider={setAiProviderState}
            apiKey={aiApiKey}
            setApiKey={setAiApiKeyState}
            model={aiModel}
            setModel={setAiModelState}
            defaultTimeRange={aiDefaultTimeRange}
            setDefaultTimeRange={setAiDefaultTimeRangeState}
            summaryDetail={aiSummaryDetail}
            setSummaryDetail={setAiSummaryDetailState}
            enableThinking={aiEnableThinking}
            setEnableThinking={setAiEnableThinkingState}
            messageLimit={aiMessageLimit}
            setMessageLimit={setAiMessageLimitState}
            showMessage={showMessage}
          />
        )}
        {activeTab === 'data' && renderDataManagementTab()}
        {activeTab === 'activation' && renderActivationTab()}
        {activeTab === 'about' && renderAboutTab()}
      </div>
    </div>
  )
}

export default SettingsPage
