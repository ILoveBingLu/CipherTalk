import { app, BrowserWindow, ipcMain, nativeTheme, protocol, net } from 'electron'
import { join } from 'path'
import { readFileSync, existsSync, mkdirSync } from 'fs'
import { autoUpdater } from 'electron-updater'
import { DatabaseService } from './services/database'

import { wechatDecryptService } from './services/decryptService'
import { ConfigService } from './services/config'
import { wxKeyService } from './services/wxKeyService'
import { dbPathService } from './services/dbPathService'
import { wcdbService } from './services/wcdbService'
import { dataManagementService } from './services/dataManagementService'
import { imageDecryptService } from './services/imageDecryptService'
import { imageKeyService } from './services/imageKeyService'
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
import { windowsHelloService, WindowsHelloResult } from './services/windowsHelloService'
import { shortcutService } from './services/shortcutService'

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
autoUpdater.disableDifferentialDownload = true  // 禁用差分更新，强制全量下载

/**
 * 比较两个语义化版本号
 * @param version1 版本1
 * @param version2 版本2
 * @returns version1 > version2 返回 true
 */
function isNewerVersion(version1: string, version2: string): boolean {
  const v1Parts = version1.split('.').map(Number)
  const v2Parts = version2.split('.').map(Number)

  // 补齐版本号位数
  const maxLength = Math.max(v1Parts.length, v2Parts.length)
  while (v1Parts.length < maxLength) v1Parts.push(0)
  while (v2Parts.length < maxLength) v2Parts.push(0)

  for (let i = 0; i < maxLength; i++) {
    if (v1Parts[i] > v2Parts[i]) return true
    if (v1Parts[i] < v2Parts[i]) return false
  }

  return false // 版本相同
}

// 单例服务
let dbService: DatabaseService | null = null

let configService: ConfigService | null = null
let logService: LogService | null = null

// 聊天窗口实例
let chatWindow: BrowserWindow | null = null
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

function createWindow() {
  // 获取图标路径 - 打包后在 resources 目录
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : join(process.resourcesPath, 'icon.ico')

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
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

  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : join(process.resourcesPath, 'icon.ico')

  const isDark = nativeTheme.shouldUseDarkColors

  chatWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false  // 允许加载本地文件
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#666666',
      height: 32
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

  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : join(process.resourcesPath, 'icon.ico')

  const isDark = nativeTheme.shouldUseDarkColors

  groupAnalyticsWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false  // 允许加载本地文件
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#666666',
      height: 32
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

  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : join(process.resourcesPath, 'icon.ico')

  const isDark = nativeTheme.shouldUseDarkColors

  chatHistoryWindow = new BrowserWindow({
    width: 600,
    height: 800,
    minWidth: 400,
    minHeight: 500,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false  // 允许加载本地文件
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: isDark ? '#ffffff' : '#1a1a1a',
      height: 32
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

  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : join(process.resourcesPath, 'icon.ico')

  const isDark = nativeTheme.shouldUseDarkColors

  annualReportWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false  // 允许加载本地文件
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: isDark ? '#FFFFFF' : '#333333',
      height: 32
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

  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : join(process.resourcesPath, 'icon.ico')

  const isDark = nativeTheme.shouldUseDarkColors

  agreementWindow = new BrowserWindow({
    width: 800,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false  // 允许加载本地文件
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: isDark ? '#FFFFFF' : '#333333',
      height: 32
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
function createWelcomeWindow() {
  // 如果已存在，聚焦
  if (welcomeWindow && !welcomeWindow.isDestroyed()) {
    welcomeWindow.focus()
    return welcomeWindow
  }

  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : join(process.resourcesPath, 'icon.ico')

  welcomeWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false  // 允许加载本地文件
    },
    show: false
  })

  welcomeWindow.once('ready-to-show', () => {
    welcomeWindow?.show()
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    welcomeWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/welcome-window`)
  } else {
    welcomeWindow.loadFile(join(__dirname, '../dist/index.html'), { hash: '/welcome-window' })
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

  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : join(process.resourcesPath, 'icon.ico')

  purchaseWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    icon: iconPath,
    webPreferences: {
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

/**
 * 创建独立的图片查看窗口
 */
function createImageViewerWindow(imagePath: string) {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : join(process.resourcesPath, 'icon.ico')

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 400,
    minHeight: 300,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false // 允许加载本地文件
    },
    titleBarStyle: 'hidden', // 无边框
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#ffffff',
      height: 32
    },
    show: false,
    backgroundColor: '#000000', // 黑色背景
    autoHideMenuBar: true
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  // 获取主题参数
  const themeParams = getThemeQueryParams()

  // 加载图片查看页面
  // 加载图片查看页面
  const imageParam = `imagePath=${encodeURIComponent(imagePath)}`
  const queryParams = `${themeParams}&${imageParam}`

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
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : join(process.resourcesPath, 'icon.ico')

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
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
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
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : join(process.resourcesPath, 'icon.ico')

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
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

  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : join(process.resourcesPath, 'icon.ico')

  const isDark = nativeTheme.shouldUseDarkColors

  aiSummaryWindow = new BrowserWindow({
    width: 600,
    height: 800,
    minWidth: 500,
    minHeight: 600,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
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

  ipcMain.handle('app:checkForUpdates', async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      if (result && result.updateInfo) {
        const currentVersion = app.getVersion()
        const latestVersion = result.updateInfo.version

        // 使用语义化版本比较
        if (isNewerVersion(latestVersion, currentVersion)) {
          return {
            hasUpdate: true,
            version: latestVersion,
            releaseNotes: result.updateInfo.releaseNotes as string || ''
          }
        }
      }
      return { hasUpdate: false }
    } catch (error) {
      console.error('检查更新失败:', error)
      return { hasUpdate: false }
    }
  })

  ipcMain.handle('app:setAppIcon', async (_, iconName: string) => {
    try {
      const isDev = !!process.env.VITE_DEV_SERVER_URL
      let iconPath = ''

      if (iconName === 'xinnian') {
        iconPath = isDev
          ? join(__dirname, '../public/xinnian.ico')
          : join(process.resourcesPath, 'xinnian.ico')
      } else {
        iconPath = isDev
          ? join(__dirname, '../public/icon.ico')
          : join(process.resourcesPath, 'icon.ico')
      }

      if (existsSync(iconPath)) {
        const { nativeImage } = require('electron')
        const image = nativeImage.createFromPath(iconPath)
        BrowserWindow.getAllWindows().forEach(win => {
          win.setIcon(image)
        })

        // 尝试更新桌面快捷方式图标 (不阻塞主线程)
        shortcutService.updateDesktopShortcutIcon(iconPath).catch(err => {
          console.error('更新快捷方式失败:', err)
        })

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

    // 监听下载进度
    autoUpdater.on('download-progress', (progress) => {
      win?.webContents.send('app:downloadProgress', progress.percent)
    })

    // 下载完成后自动安装
    autoUpdater.on('update-downloaded', () => {
      autoUpdater.quitAndInstall(false, true)
    })

    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      console.error('下载更新失败:', error)
      throw error
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
  ipcMain.handle('window:openImageViewerWindow', (_, imagePath: string) => {
    createImageViewerWindow(imagePath)
  })

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

  // Windows Hello 原生验证 (比 WebAuthn 更快)
  ipcMain.handle('windowsHello:isAvailable', async () => {
    return windowsHelloService.isAvailable()
  })

  ipcMain.handle('windowsHello:verify', async (_, message?: string) => {
    return windowsHelloService.verify(message)
  })

  // 密钥获取相关
  ipcMain.handle('wxkey:isWeChatRunning', async () => {
    return wxKeyService.isWeChatRunning()
  })

  ipcMain.handle('wxkey:getWeChatPid', async () => {
    return wxKeyService.getWeChatPid()
  })

  ipcMain.handle('wxkey:killWeChat', async () => {
    return wxKeyService.killWeChat()
  })

  ipcMain.handle('wxkey:launchWeChat', async () => {
    return wxKeyService.launchWeChat()
  })

  ipcMain.handle('wxkey:waitForWindow', async (_, maxWaitSeconds?: number) => {
    return wxKeyService.waitForWeChatWindow(maxWaitSeconds)
  })

  ipcMain.handle('wxkey:startGetKey', async (event, customWechatPath?: string) => {
    logService?.info('WxKey', '开始获取微信密钥', { customWechatPath })
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
    wxKeyService.dispose()
    return true
  })

  ipcMain.handle('wxkey:detectCurrentAccount', async (_, dbPath?: string, maxTimeDiffMinutes?: number) => {
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
    const { existsSync } = require('fs')
    const { join } = require('path')

    // 按优先级检查磁盘：D、E、F、C
    const drives = ['D', 'E', 'F', 'C']

    for (const drive of drives) {
      const drivePath = `${drive}:\\`
      if (existsSync(drivePath)) {
        const cachePath = join(drivePath, 'CipherTalkDB')
        logService?.info('CachePath', `找到可用磁盘: ${drive}`, { cachePath })
        return { success: true, path: cachePath, drive }
      }
    }

    // 如果都没有，返回用户目录下的默认路径
    const { app } = require('electron')
    const defaultPath = join(app.getPath('userData'), 'cache')
    logService?.warn('CachePath', '未找到常规磁盘，使用默认路径', { defaultPath })
    return { success: true, path: defaultPath, drive: 'default' }
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
      const aesKeyBuffer = aesKey ? imageDecryptService.asciiKey16(aesKey) : undefined
      await imageDecryptService.decryptToFile(inputPath, outputPath, xorKey, aesKeyBuffer)
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

  // 视频相关
  ipcMain.handle('video:getVideoInfo', async (_, videoMd5: string) => {
    try {
      const result = videoService.getVideoInfo(videoMd5)
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

  // 图片密钥获取（从内存）
  ipcMain.handle('imageKey:getImageKeys', async (event, userDir: string) => {
    logService?.info('ImageKey', '开始获取图片密钥', { userDir })
    try {
      // 获取微信 PID
      const pid = wxKeyService.getWeChatPid()
      if (!pid) {
        logService?.error('ImageKey', '微信进程未运行')
        return { success: false, error: '微信进程未运行，请先启动微信并登录' }
      }

      const result = await imageKeyService.getImageKeys(
        userDir,
        pid,
        (msg) => {
          event.sender.send('imageKey:progress', msg)
        }
      )

      if (result.success) {
        logService?.info('ImageKey', '图片密钥获取成功', {
          hasXorKey: result.xorKey !== undefined,
          hasAesKey: !!result.aesKey
        })
      } else {
        logService?.error('ImageKey', '图片密钥获取失败', { error: result.error })
      }

      return result
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

  ipcMain.handle('chat:getSessions', async () => {
    const result = await chatService.getSessions()
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

  ipcMain.handle('chat:downloadEmoji', async (_, cdnUrl: string, md5?: string) => {
    const result = await chatService.downloadEmoji(cdnUrl, md5)
    if (!result.success) {
      logService?.warn('Chat', '下载表情失败', { cdnUrl, error: result.error })
    }
    return result
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
  ipcMain.handle('window:openWelcomeWindow', async () => {
    createWelcomeWindow()
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
                  console.log(`[Whisper GPU] ${waitTime/1000} 秒后重试...`)
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
      const { aiService } = await import('./services/ai/aiService')
      return aiService.getAllProviders()
    } catch (e) {
      console.error('[AI] 获取提供商列表失败:', e)
      return []
    }
  })

  // 代理相关
  ipcMain.handle('ai:getProxyStatus', async () => {
    try {
      const { proxyService } = await import('./services/ai/proxyService')
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
      const { proxyService } = await import('./services/ai/proxyService')
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
      const { proxyService } = await import('./services/ai/proxyService')
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
      const { aiService } = await import('./services/ai/aiService')
      return await aiService.testConnection(provider, apiKey)
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:estimateCost', async (_, messageCount: number, provider: string) => {
    try {
      const { aiService } = await import('./services/ai/aiService')
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
      const { aiService } = await import('./services/ai/aiService')
      const stats = aiService.getUsageStats(startDate, endDate)
      return { success: true, stats }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:getSummaryHistory', async (_, sessionId: string, limit?: number) => {
    try {
      const { aiService } = await import('./services/ai/aiService')
      const history = aiService.getSummaryHistory(sessionId, limit)
      return { success: true, history }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:deleteSummary', async (_, id: number) => {
    try {
      const { aiService } = await import('./services/ai/aiService')
      const success = aiService.deleteSummary(id)
      return { success }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:renameSummary', async (_, id: number, customName: string) => {
    try {
      const { aiService } = await import('./services/ai/aiService')
      const success = aiService.renameSummary(id, customName)
      return { success }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:cleanExpiredCache', async () => {
    try {
      const { aiService } = await import('./services/ai/aiService')
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
    customRequirement?: string
  }) => {
    try {
      const { aiService } = await import('./services/ai/aiService')

      // 初始化服务
      aiService.init()

      // 计算时间范围
      const endTime = Math.floor(Date.now() / 1000)
      const startTime = endTime - (timeRange * 24 * 60 * 60)

      // 获取消息（使用 getMessagesByDate 获取指定时间范围内的消息）
      // 使用用户配置的条数限制（默认 3000）
      const messageLimit = configService?.get('aiMessageLimit') || 3000
      const messagesResult = await chatService.getMessagesByDate(sessionId, startTime, messageLimit)
      if (!messagesResult.success || !messagesResult.messages) {
        return { success: false, error: '获取消息失败' }
      }

      // 过滤时间范围内的消息 (getMessagesByDate 返回的是 >= startTime 的消息)
      const filteredMessages = messagesResult.messages.filter((msg: any) =>
        msg.createTime <= endTime
      )

      if (filteredMessages.length === 0) {
        return { success: false, error: '该时间范围内没有消息' }
      }

      // 获取消息中所有发送者的联系人信息
      const contacts = new Map()
      const senderSet = new Set<string>()

      // 添加会话对象
      senderSet.add(sessionId)

      // 添加所有消息发送者
      filteredMessages.forEach((msg: any) => {
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
        filteredMessages,
        contacts,
        {
          sessionId,
          timeRangeDays: timeRange,
          provider: options.provider,
          apiKey: options.apiKey,
          model: options.model,
          detail: options.detail,
          customRequirement: options.customRequirement
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
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = isDev
    ? join(__dirname, '../public/icon.ico')
    : join(process.resourcesPath, 'icon.ico')

  const splash = new BrowserWindow({
    width: 420,
    height: 320,
    icon: iconPath,
    frame: false,
    transparent: true, // 启用透明，让 CSS 圆角生效
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true, // 不显示在任务栏
    hasShadow: false, // Windows 上透明窗口需要禁用阴影
    show: true, // 直接显示窗口
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
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
      const result = await autoUpdater.checkForUpdates()
      if (result && result.updateInfo) {
        const currentVersion = app.getVersion()
        const latestVersion = result.updateInfo.version

        // 使用语义化版本比较
        if (isNewerVersion(latestVersion, currentVersion) && mainWindow) {
          // 通知渲染进程有新版本
          mainWindow.webContents.send('app:updateAvailable', {
            version: latestVersion,
            releaseNotes: result.updateInfo.releaseNotes || ''
          })
        }
      }
    } catch (error) {
      console.error('启动时检查更新失败:', error)
    }
  }, 3000)
}

app.whenReady().then(async () => {
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

  // 只有在配置完整时才创建主窗口
  // 如果配置不完整，checkAndConnectOnStartup 会创建引导窗口
  if (shouldShowSplash !== false || configService?.get('myWxid')) {
    // 创建主窗口（但不立即显示）
    mainWindow = createWindow()
  }

  // 如果显示了启动屏，主窗口会在启动屏关闭后自动显示（通过 ready-to-show 事件）
  // 如果没有显示启动屏，主窗口会正常显示（通过 ready-to-show 事件）

  // 启动时检测更新
  checkForUpdatesOnStartup()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  // 关闭配置数据库连接
  configService?.close()
})
