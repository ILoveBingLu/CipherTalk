import type { ChatSession, Message, Contact, ContactInfo } from './models'
import type { SummaryResult } from './ai'

export interface ElectronAPI {
  window: {
    minimize: () => void
    maximize: () => void
    close: () => void
    splashReady: () => void
    onSplashFadeOut?: (callback: () => void) => () => void
    openChatWindow: () => Promise<boolean>
    openGroupAnalyticsWindow: () => Promise<boolean>
    openAnnualReportWindow: (year: number) => Promise<boolean>
    openAgreementWindow: () => Promise<boolean>
    openPurchaseWindow: () => Promise<boolean>
    openWelcomeWindow: () => Promise<boolean>
    completeWelcome: () => Promise<boolean>
    isChatWindowOpen: () => Promise<boolean>
    closeChatWindow: () => Promise<boolean>
    setTitleBarOverlay: (options: { symbolColor: string }) => void
    openImageViewerWindow: (imagePath: string) => Promise<void>
    openVideoPlayerWindow: (videoPath: string, videoWidth?: number, videoHeight?: number) => Promise<void>
    openBrowserWindow: (url: string, title?: string) => Promise<void>
    resizeToFitVideo: (videoWidth: number, videoHeight: number) => Promise<void>
    openAISummaryWindow: (sessionId: string, sessionName: string) => Promise<boolean>
    openChatHistoryWindow: (sessionId: string, messageId: number) => Promise<boolean>
  }
  config: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    getTldCache: () => Promise<{ tlds: string[]; updatedAt: number } | null>
    setTldCache: (tlds: string[]) => Promise<void>
  }
  db: {
    open: (dbPath: string, key?: string) => Promise<boolean>
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>
    close: () => Promise<void>
  }
  decrypt: {
    database: (sourcePath: string, key: string, outputPath: string) => Promise<boolean>
    image: (imagePath: string) => Promise<Uint8Array | null>
  }
  dialog: {
    openFile: (options?: Electron.OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>
    saveFile: (options?: Electron.SaveDialogOptions) => Promise<Electron.SaveDialogReturnValue>
  }
  shell: {
    openPath: (path: string) => Promise<string>
    openExternal: (url: string) => Promise<void>
    showItemInFolder: (fullPath: string) => Promise<void>
  }
  app: {
    getDownloadsPath: () => Promise<string>
    getVersion: () => Promise<string>
    checkForUpdates: () => Promise<{ hasUpdate: boolean; version?: string; releaseNotes?: string }>
    downloadAndInstall: () => Promise<void>
    getStartupDbConnected?: () => Promise<boolean>
    setAppIcon: (iconName: string) => Promise<void>
    onDownloadProgress: (callback: (progress: number) => void) => () => void
    onUpdateAvailable: (callback: (info: { version: string; releaseNotes: string }) => void) => () => void
  }
  // Windows Hello 原生验证 (比 WebAuthn 更快)
  windowsHello: {
    /** 检查 Windows Hello 是否可用 */
    isAvailable: () => Promise<boolean>
    /** 请求 Windows Hello 验证 */
    verify: (message?: string) => Promise<{
      success: boolean
      result: number  // 0=成功, 1=设备不存在, 2=未配置, 3=策略禁用, 4=设备忙, 5=重试耗尽, 6=取消, 99=未知错误
      error?: string
    }>
  }
  wxKey: {
    isWeChatRunning: () => Promise<boolean>
    getWeChatPid: () => Promise<number | null>
    killWeChat: () => Promise<boolean>
    launchWeChat: () => Promise<boolean>
    waitForWindow: (maxWaitSeconds?: number) => Promise<boolean>
    startGetKey: (customWechatPath?: string) => Promise<{ success: boolean; key?: string; error?: string; needManualPath?: boolean }>
    cancel: () => Promise<boolean>
    detectCurrentAccount: (dbPath?: string, maxTimeDiffMinutes?: number) => Promise<{ wxid: string; dbPath: string } | null>
    onStatus: (callback: (data: { status: string; level: number }) => void) => () => void
  }
  dbPath: {
    autoDetect: () => Promise<{ success: boolean; path?: string; error?: string }>
    scanWxids: (rootPath: string) => Promise<string[]>
    getDefault: () => Promise<string>
    getBestCachePath: () => Promise<{ success: boolean; path: string; drive: string }>
  }
  wcdb: {
    testConnection: (dbPath: string, hexKey: string, wxid: string, isAutoConnect?: boolean) => Promise<{ success: boolean; error?: string; sessionCount?: number }>
    open: (dbPath: string, hexKey: string, wxid: string) => Promise<boolean>
    close: () => Promise<boolean>
    decryptDatabase: (dbPath: string, hexKey: string, wxid: string) => Promise<{ success: boolean; error?: string; totalFiles?: number; successCount?: number; failCount?: number }>
    onDecryptProgress: (callback: (data: { current: number; total: number; currentFile?: string; status: string; pageProgress?: { current: number; total: number } }) => void) => () => void
  }
  dataManagement: {
    scanDatabases: () => Promise<{
      success: boolean
      databases?: DatabaseFileInfo[]
      error?: string
    }>
    decryptAll: () => Promise<{
      success: boolean
      successCount?: number
      failCount?: number
      error?: string
    }>
    incrementalUpdate: () => Promise<{
      success: boolean
      successCount?: number
      failCount?: number
      error?: string
    }>
    getCurrentCachePath: () => Promise<string>
    getDefaultCachePath: () => Promise<string>
    migrateCache: (newCachePath: string) => Promise<{
      success: boolean
      movedCount?: number
      error?: string
    }>
    scanImages: (dirPath: string) => Promise<{
      success: boolean
      images?: ImageFileInfo[]
      error?: string
    }>
    decryptImages: (dirPath: string) => Promise<{
      success: boolean
      successCount?: number
      failCount?: number
      error?: string
    }>
    onProgress: (callback: (data: any) => void) => () => void
    getImageDirectories: () => Promise<{
      success: boolean
      directories?: { wxid: string; path: string }[]
      error?: string
    }>
    decryptSingleImage: (filePath: string) => Promise<{
      success: boolean
      outputPath?: string
      error?: string
    }>
    checkForUpdates: () => Promise<{
      hasUpdate: boolean
      updateCount?: number
      error?: string
    }>
    enableAutoUpdate: (intervalSeconds?: number) => Promise<{ success: boolean }>
    disableAutoUpdate: () => Promise<{ success: boolean }>
    autoIncrementalUpdate: (silent?: boolean) => Promise<{
      success: boolean
      updated: boolean
      error?: string
    }>
    onProgress: (callback: (data: DecryptProgress) => void) => () => void
    onUpdateAvailable: (callback: (hasUpdate: boolean) => void) => () => void
  }
  imageDecrypt: {
    batchDetectXorKey: (dirPath: string) => Promise<{ success: boolean; key?: number | null; error?: string }>
    decryptImage: (inputPath: string, outputPath: string, xorKey: number, aesKey?: string) => Promise<{ success: boolean; error?: string }>
  }
  image: {
    decrypt: (payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; force?: boolean }) => Promise<{ success: boolean; localPath?: string; error?: string }>
    resolveCache: (payload: { sessionId?: string; imageMd5?: string; imageDatName?: string }) => Promise<{ success: boolean; localPath?: string; hasUpdate?: boolean; error?: string }>
    onUpdateAvailable: (callback: (data: { cacheKey: string; imageMd5?: string; imageDatName?: string }) => void) => () => void
    onCacheResolved: (callback: (data: { cacheKey: string; imageMd5?: string; imageDatName?: string; localPath: string }) => void) => () => void
  }
  video: {
    getVideoInfo: (videoMd5: string) => Promise<{
      success: boolean
      error?: string
      exists: boolean
      videoUrl?: string
      coverUrl?: string
      thumbUrl?: string
    }>
    readFile: (videoPath: string) => Promise<{
      success: boolean
      error?: string
      data?: string
    }>
    parseVideoMd5: (content: string) => Promise<{
      success: boolean
      error?: string
      md5?: string
    }>
  }
  imageKey: {
    getImageKeys: (userDir: string) => Promise<{ success: boolean; xorKey?: number; aesKey?: string; error?: string }>
    onProgress: (callback: (msg: string) => void) => () => void
  }
  chat: {
    connect: () => Promise<{ success: boolean; error?: string }>
    getSessions: () => Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }>
    getContacts: () => Promise<{ success: boolean; contacts?: ContactInfo[]; error?: string }>
    getMessages: (sessionId: string, offset?: number, limit?: number) => Promise<{
      success: boolean;
      messages?: Message[];
      hasMore?: boolean;
      error?: string
    }>
    getAllVoiceMessages: (sessionId: string) => Promise<{
      success: boolean;
      messages?: Message[];
      error?: string
    }>
    getContact: (username: string) => Promise<Contact | null>
    getContactAvatar: (username: string) => Promise<{ avatarUrl?: string; displayName?: string } | null>
    resolveTransferDisplayNames: (chatroomId: string, payerUsername: string, receiverUsername: string) => Promise<{ payerName: string; receiverName: string }>
    getMyAvatarUrl: () => Promise<{ success: boolean; avatarUrl?: string; error?: string }>
    getMyUserInfo: () => Promise<{
      success: boolean
      userInfo?: {
        wxid: string
        nickName: string
        alias: string
        avatarUrl: string
      }
      error?: string
    }>
    downloadEmoji: (cdnUrl: string, md5?: string, productId?: string, createTime?: number) => Promise<{ success: boolean; localPath?: string; error?: string }>
    close: () => Promise<boolean>
    refreshCache: () => Promise<boolean>
    setCurrentSession: (sessionId: string | null) => Promise<boolean>
    onNewMessages: (callback: (data: { sessionId: string; messages: Message[] }) => void) => () => void
    getSessionDetail: (sessionId: string) => Promise<{
      success: boolean
      detail?: {
        wxid: string
        displayName: string
        remark?: string
        nickName?: string
        alias?: string
        avatarUrl?: string
        messageCount: number
        firstMessageTime?: number
        latestMessageTime?: number
        messageTables: { dbName: string; tableName: string; count: number }[]
      }
      error?: string
    }>
    getVoiceData: (sessionId: string, msgId: string, createTime?: number) => Promise<{
      success: boolean
      data?: string  // base64 encoded WAV
      error?: string
    }>
    getMessagesByDate: (sessionId: string, targetTimestamp: number, limit?: number) => Promise<{
      success: boolean
      messages?: Message[]
      targetIndex?: number
      targetIndex?: number
      error?: string
    }>
    getMessage: (sessionId: string, localId: number) => Promise<{ success: boolean; message?: Message; error?: string }>
    getDatesWithMessages: (sessionId: string, year: number, month: number) => Promise<{
      success: boolean
      dates?: string[]
      error?: string
    }>
    onSessionsUpdated: (callback: (sessions: ChatSession[]) => void) => () => void
  }
  analytics: {
    getOverallStatistics: () => Promise<{
      success: boolean
      data?: {
        totalMessages: number
        textMessages: number
        imageMessages: number
        voiceMessages: number
        videoMessages: number
        emojiMessages: number
        otherMessages: number
        sentMessages: number
        receivedMessages: number
        firstMessageTime: number | null
        lastMessageTime: number | null
        activeDays: number
        messageTypeCounts: Record<number, number>
      }
      error?: string
    }>
    getContactRankings: (limit?: number) => Promise<{
      success: boolean
      data?: Array<{
        username: string
        displayName: string
        avatarUrl?: string
        messageCount: number
        sentCount: number
        receivedCount: number
        lastMessageTime: number | null
      }>
      error?: string
    }>
    getTimeDistribution: () => Promise<{
      success: boolean
      data?: {
        hourlyDistribution: Record<number, number>
        weekdayDistribution: Record<number, number>
        monthlyDistribution: Record<string, number>
      }
      error?: string
    }>
  }
  groupAnalytics: {
    getGroupChats: () => Promise<{
      success: boolean
      data?: Array<{
        username: string
        displayName: string
        memberCount: number
        avatarUrl?: string
      }>
      error?: string
    }>
    getGroupMembers: (chatroomId: string) => Promise<{
      success: boolean
      data?: Array<{
        username: string
        displayName: string
        avatarUrl?: string
      }>
      error?: string
    }>
    getGroupMessageRanking: (chatroomId: string, limit?: number, startTime?: number, endTime?: number) => Promise<{
      success: boolean
      data?: Array<{
        member: {
          username: string
          displayName: string
          avatarUrl?: string
        }
        messageCount: number
      }>
      error?: string
    }>
    getGroupActiveHours: (chatroomId: string, startTime?: number, endTime?: number) => Promise<{
      success: boolean
      data?: {
        hourlyDistribution: Record<number, number>
      }
      error?: string
    }>
    getGroupMediaStats: (chatroomId: string, startTime?: number, endTime?: number) => Promise<{
      success: boolean
      data?: {
        typeCounts: Array<{
          type: number
          name: string
          count: number
        }>
        total: number
      }
      error?: string
    }>
  }
  annualReport: {
    getAvailableYears: () => Promise<{
      success: boolean
      data?: number[]
      error?: string
    }>
    generateReport: (year: number) => Promise<{
      success: boolean
      data?: {
        year: number
        totalMessages: number
        totalFriends: number
        coreFriends: Array<{
          username: string
          displayName: string
          avatarUrl?: string
          messageCount: number
          sentCount: number
          receivedCount: number
        }>
        monthlyTopFriends: Array<{
          month: number
          displayName: string
          avatarUrl?: string
          messageCount: number
        }>
        peakDay: {
          date: string
          messageCount: number
          topFriend?: string
          topFriendCount?: number
        } | null
        longestStreak: {
          friendName: string
          days: number
          startDate: string
          endDate: string
        } | null
        activityHeatmap: {
          data: number[][]
        }
        midnightKing: {
          displayName: string
          count: number
          percentage: number
        } | null
        selfAvatarUrl?: string
      }
      error?: string
    }>
  }
  export: {
    exportSessions: (sessionIds: string[], outputDir: string, options: ExportOptions) => Promise<{
      success: boolean
      successCount?: number
      failCount?: number
      error?: string
    }>
    exportSession: (sessionId: string, outputPath: string, options: ExportOptions) => Promise<{
      success: boolean
      error?: string
    }>
    exportContacts: (outputDir: string, options: ContactExportOptions) => Promise<{
      success: boolean
      successCount?: number
      error?: string
    }>
    onProgress: (callback: (data: {
      current?: number
      total?: number
      currentSession?: string
      phase?: string
      detail?: string
    }) => void) => () => void
  }
  activation: {
    getDeviceId: () => Promise<string>
    verifyCode: (code: string) => Promise<{ success: boolean; message: string }>
    activate: (code: string) => Promise<ActivationResult>
    checkStatus: () => Promise<ActivationStatus>
    getTypeDisplayName: (type: string | null) => Promise<string>
    clearCache: () => Promise<boolean>
  }
  cache: {
    clearImages: () => Promise<{ success: boolean; error?: string }>
    clearEmojis: () => Promise<{ success: boolean; error?: string }>
    clearDatabases: () => Promise<{ success: boolean; error?: string }>
    clearAll: () => Promise<{ success: boolean; error?: string }>
    clearConfig: () => Promise<{ success: boolean; error?: string }>
    getCacheSize: () => Promise<{
      success: boolean;
      error?: string;
      size?: {
        images: number
        emojis: number
        databases: number
        logs: number
        total: number
      }
    }>
  }
  log: {
    getLogFiles: () => Promise<{
      success: boolean;
      error?: string;
      files?: Array<{ name: string; size: number; mtime: Date }>
    }>
    readLogFile: (filename: string) => Promise<{
      success: boolean;
      error?: string;
      content?: string
    }>
    clearLogs: () => Promise<{ success: boolean; error?: string }>
    getLogSize: () => Promise<{
      success: boolean;
      error?: string;
      size?: number
    }>
    getLogDirectory: () => Promise<{
      success: boolean;
      error?: string;
      directory?: string
    }>
    setLogLevel: (level: string) => Promise<{ success: boolean; error?: string }>
    getLogLevel: () => Promise<{
      success: boolean;
      error?: string;
      level?: string
    }>
  }
  // 语音转文字 (STT)
  stt: {
    getModelStatus: () => Promise<{
      success: boolean
      exists?: boolean
      modelPath?: string
      tokensPath?: string
      sizeBytes?: number
      error?: string
    }>
    downloadModel: () => Promise<{
      success: boolean
      modelPath?: string
      tokensPath?: string
      error?: string
    }>
    transcribe: (wavBase64: string, sessionId: string, createTime: number, force?: boolean) => Promise<{
      success: boolean
      transcript?: string
      cached?: boolean
      error?: string
    }>
    onDownloadProgress: (callback: (progress: {
      modelName: string
      downloadedBytes: number
      totalBytes?: number
      percent?: number
    }) => void) => () => void
    onPartialResult: (callback: (text: string) => void) => () => void
    getCachedTranscript: (sessionId: string, createTime: number) => Promise<{
      success: boolean
      transcript?: string
    }>
    updateTranscript: (sessionId: string, createTime: number, transcript: string) => Promise<{
      success: boolean
      error?: string
    }>
    clearModel: () => Promise<{ success: boolean; error?: string }>
  }
  // 语音转文字 - Whisper GPU 加速
  sttWhisper: {
    detectGPU: () => Promise<{
      available: boolean
      provider: string
      info: string
    }>
    checkModel: (modelType: string) => Promise<{
      exists: boolean
      modelPath?: string
      sizeBytes?: number
      error?: string
    }>
    downloadModel: (modelType: string) => Promise<{
      success: boolean
      error?: string
    }>
    clearModel: (modelType: string) => Promise<{
      success: boolean
      error?: string
    }>
    transcribe: (wavData: Buffer, options: { modelType?: string; language?: string }) => Promise<{
      success: boolean
      transcript?: string
      error?: string
    }>
    onDownloadProgress: (callback: (progress: {
      downloadedBytes: number
      totalBytes?: number
      percent?: number
    }) => void) => () => void
    downloadGPUComponents: () => Promise<{
      success: boolean
      error?: string
    }>
    checkGPUComponents: () => Promise<{
      installed: boolean
      missingFiles?: string[]
      gpuDir?: string
      reason?: string
      error?: string
    }>
    onGPUDownloadProgress: (callback: (progress: {
      currentFile: string
      fileProgress: number
      overallProgress: number
      completedFiles: number
      totalFiles: number
    }) => void) => () => void
  }
  // AI 摘要
  ai: {
    getProviders: () => Promise<Array<{
      id: string
      name: string
      displayName: string
      description: string
      models: string[]
      pricing: string
      pricingDetail: {
        input: number
        output: number
      }
      website?: string
    }>>
    getProxyStatus: () => Promise<{
      success: boolean
      hasProxy?: boolean
      proxyUrl?: string | null
      error?: string
    }>
    refreshProxy: () => Promise<{
      success: boolean
      hasProxy?: boolean
      proxyUrl?: string | null
      message?: string
      error?: string
    }>
    testProxy: (proxyUrl: string, testUrl?: string) => Promise<{
      success: boolean
      message?: string
      error?: string
    }>
    testConnection: (provider: string, apiKey: string) => Promise<{
      success: boolean
      error?: string
      needsProxy?: boolean
    }>
    estimateCost: (messageCount: number, provider: string) => Promise<{
      success: boolean
      tokens?: number
      cost?: number
      error?: string
    }>
    getUsageStats: (startDate?: string, endDate?: string) => Promise<{
      success: boolean
      stats?: any
      error?: string
    }>
    getSummaryHistory: (sessionId: string, limit?: number) => Promise<{
      success: boolean
      history?: any[]
      error?: string
    }>
    deleteSummary: (id: number) => Promise<{
      success: boolean
      error?: string
    }>
    renameSummary: (id: number, customName: string) => Promise<{
      success: boolean
      error?: string
    }>
    cleanExpiredCache: () => Promise<{
      success: boolean
      error?: string
    }>
    readGuide: (guideName: string) => Promise<{
      success: boolean
      content?: string
      error?: string
    }>
    generateSummary: (sessionId: string, timeRange: number, options: {
      provider: string
      apiKey: string
      model: string
      detail: 'simple' | 'normal' | 'detailed'
      customRequirement?: string
      sessionName?: string
      enableThinking?: boolean
    }) => Promise<{
      success: boolean
      result?: SummaryResult
      error?: string
    }>
    onSummaryChunk: (callback: (chunk: string) => void) => () => void
  }
}

export interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'html' | 'txt' | 'excel' | 'sql'
  dateRange?: { start: number; end: number } | null
  exportMedia?: boolean
  exportAvatars?: boolean
}

export interface ContactExportOptions {
  format: 'json' | 'csv' | 'vcf'
  exportAvatars: boolean
  contactTypes: {
    friends: boolean
    groups: boolean
    officials: boolean
  }
  selectedUsernames?: string[]
}

export interface DatabaseFileInfo {
  fileName: string
  filePath: string
  fileSize: number
  wxid: string
  isDecrypted: boolean
  decryptedPath?: string
  needsUpdate?: boolean
}

export interface ImageFileInfo {
  fileName: string
  filePath: string
  fileSize: number
  isDecrypted: boolean
  decryptedPath?: string
  version: number  // 0=V3, 1=V4-V1, 2=V4-V2
}

export interface DecryptProgress {
  type: 'decrypt' | 'update' | 'migrate' | 'image' | 'imageBatch' | 'imageScanComplete' | 'complete' | 'error'
  current?: number
  total?: number
  fileName?: string
  fileProgress?: number
  error?: string
  images?: ImageFileInfo[]
}

export interface ActivationStatus {
  isActivated: boolean
  type: string | null
  expiresAt: string | null
  activatedAt: string | null
  daysRemaining: number | null
  deviceId: string
}

export interface ActivationResult {
  success: boolean
  message: string
  data?: {
    type: string
    expires_at: string | null
    activated_at: string
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        allowpopups?: boolean;
        webpreferences?: string;
        style?: React.CSSProperties;
        ref?: any;
      }
    }
  }

  // Electron 类型声明
  namespace Electron {
    interface OpenDialogOptions {
      title?: string
      defaultPath?: string
      filters?: { name: string; extensions: string[] }[]
      properties?: ('openFile' | 'openDirectory' | 'multiSelections')[]
    }
    interface OpenDialogReturnValue {
      canceled: boolean
      filePaths: string[]
    }
    interface SaveDialogOptions {
      title?: string
      defaultPath?: string
      filters?: { name: string; extensions: string[] }[]
    }
    interface SaveDialogReturnValue {
      canceled: boolean
      filePath?: string
    }
  }
}

export { }
