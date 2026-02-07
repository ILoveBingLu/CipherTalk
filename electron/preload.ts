import { contextBridge, ipcRenderer } from 'electron'

// 暴露给渲染进程的 API
contextBridge.exposeInMainWorld('electronAPI', {
  // 配置
  config: {
    get: (key: string) => ipcRenderer.invoke('config:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('config:set', key, value),
    getTldCache: () => ipcRenderer.invoke('config:getTldCache'),
    setTldCache: (tlds: string[]) => ipcRenderer.invoke('config:setTldCache', tlds)
  },

  // 数据库操作
  db: {
    open: (dbPath: string, key?: string) => ipcRenderer.invoke('db:open', dbPath, key),
    query: (sql: string, params?: any[]) => ipcRenderer.invoke('db:query', sql, params),
    close: () => ipcRenderer.invoke('db:close')
  },

  // 解密
  decrypt: {
    database: (sourcePath: string, key: string, outputPath: string) =>
      ipcRenderer.invoke('decrypt:database', sourcePath, key, outputPath),
    image: (imagePath: string) => ipcRenderer.invoke('decrypt:image', imagePath)
  },

  // 对话框
  dialog: {
    openFile: (options: any) => ipcRenderer.invoke('dialog:openFile', options),
    saveFile: (options: any) => ipcRenderer.invoke('dialog:saveFile', options)
  },

  // Shell
  shell: {
    openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    showItemInFolder: (fullPath: string) => ipcRenderer.invoke('shell:showItemInFolder', fullPath)
  },

  // App
  app: {
    getDownloadsPath: () => ipcRenderer.invoke('app:getDownloadsPath'),
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
    downloadAndInstall: () => ipcRenderer.invoke('app:downloadAndInstall'),
    getStartupDbConnected: () => ipcRenderer.invoke('app:getStartupDbConnected'),
    setAppIcon: (iconName: string) => ipcRenderer.invoke('app:setAppIcon', iconName),
    onDownloadProgress: (callback: (progress: number) => void) => {
      ipcRenderer.on('app:downloadProgress', (_, progress) => callback(progress))
      return () => ipcRenderer.removeAllListeners('app:downloadProgress')
    },
    onUpdateAvailable: (callback: (info: { version: string; releaseNotes: string }) => void) => {
      ipcRenderer.on('app:updateAvailable', (_, info) => callback(info))
      return () => ipcRenderer.removeAllListeners('app:updateAvailable')
    }
  },

  // 窗口控制
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    openChatWindow: () => ipcRenderer.invoke('window:openChatWindow'),
    openGroupAnalyticsWindow: () => ipcRenderer.invoke('window:openGroupAnalyticsWindow'),
    openAnnualReportWindow: (year: number) => ipcRenderer.invoke('window:openAnnualReportWindow', year),
    openAgreementWindow: () => ipcRenderer.invoke('window:openAgreementWindow'),
    openPurchaseWindow: () => ipcRenderer.invoke('window:openPurchaseWindow'),
    openWelcomeWindow: () => ipcRenderer.invoke('window:openWelcomeWindow'),
    completeWelcome: () => ipcRenderer.invoke('window:completeWelcome'),
    isChatWindowOpen: () => ipcRenderer.invoke('window:isChatWindowOpen'),
    closeChatWindow: () => ipcRenderer.invoke('window:closeChatWindow'),
    setTitleBarOverlay: (options: { symbolColor: string }) => ipcRenderer.send('window:setTitleBarOverlay', options),
    openImageViewerWindow: (imagePath: string) => ipcRenderer.invoke('window:openImageViewerWindow', imagePath),
    openVideoPlayerWindow: (videoPath: string, videoWidth?: number, videoHeight?: number) => ipcRenderer.invoke('window:openVideoPlayerWindow', videoPath, videoWidth, videoHeight),
    openBrowserWindow: (url: string, title?: string) => ipcRenderer.invoke('window:openBrowserWindow', url, title),
    openAISummaryWindow: (sessionId: string, sessionName: string) => ipcRenderer.invoke('window:openAISummaryWindow', sessionId, sessionName),
    openChatHistoryWindow: (sessionId: string, messageId: number) => ipcRenderer.invoke('window:openChatHistoryWindow', sessionId, messageId),
    resizeToFitVideo: (videoWidth: number, videoHeight: number) => ipcRenderer.invoke('window:resizeToFitVideo', videoWidth, videoHeight),
    splashReady: () => ipcRenderer.send('window:splashReady'),
    onSplashFadeOut: (callback: () => void) => {
      ipcRenderer.on('splash:fadeOut', () => callback())
      return () => ipcRenderer.removeAllListeners('splash:fadeOut')
    }
  },

  // Windows Hello 原生验证 (比 WebAuthn 更快)
  windowsHello: {
    isAvailable: () => ipcRenderer.invoke('windowsHello:isAvailable') as Promise<boolean>,
    verify: (message?: string) => ipcRenderer.invoke('windowsHello:verify', message) as Promise<{
      success: boolean
      result: number  // WindowsHelloResult 枚举值
      error?: string
    }>
  },

  // 密钥获取
  wxKey: {
    isWeChatRunning: () => ipcRenderer.invoke('wxkey:isWeChatRunning'),
    getWeChatPid: () => ipcRenderer.invoke('wxkey:getWeChatPid'),
    killWeChat: () => ipcRenderer.invoke('wxkey:killWeChat'),
    launchWeChat: () => ipcRenderer.invoke('wxkey:launchWeChat'),
    waitForWindow: (maxWaitSeconds?: number) => ipcRenderer.invoke('wxkey:waitForWindow', maxWaitSeconds),
    startGetKey: (customWechatPath?: string) => ipcRenderer.invoke('wxkey:startGetKey', customWechatPath),
    cancel: () => ipcRenderer.invoke('wxkey:cancel'),
    detectCurrentAccount: (dbPath?: string, maxTimeDiffMinutes?: number) => ipcRenderer.invoke('wxkey:detectCurrentAccount', dbPath, maxTimeDiffMinutes),
    onStatus: (callback: (data: { status: string; level: number }) => void) => {
      ipcRenderer.on('wxkey:status', (_, data) => callback(data))
      return () => ipcRenderer.removeAllListeners('wxkey:status')
    }
  },

  // 数据库路径
  dbPath: {
    autoDetect: () => ipcRenderer.invoke('dbpath:autoDetect'),
    scanWxids: (rootPath: string) => ipcRenderer.invoke('dbpath:scanWxids', rootPath),
    getDefault: () => ipcRenderer.invoke('dbpath:getDefault'),
    getBestCachePath: () => ipcRenderer.invoke('dbpath:getBestCachePath')
  },

  // WCDB 数据库
  wcdb: {
    testConnection: (dbPath: string, hexKey: string, wxid: string, isAutoConnect?: boolean) =>
      ipcRenderer.invoke('wcdb:testConnection', dbPath, hexKey, wxid, isAutoConnect),
    open: (dbPath: string, hexKey: string, wxid: string) =>
      ipcRenderer.invoke('wcdb:open', dbPath, hexKey, wxid),
    close: () => ipcRenderer.invoke('wcdb:close'),
    decryptDatabase: (dbPath: string, hexKey: string, wxid: string) =>
      ipcRenderer.invoke('wcdb:decryptDatabase', dbPath, hexKey, wxid),
    onDecryptProgress: (callback: (data: any) => void) => {
      ipcRenderer.on('wcdb:decryptProgress', (_, data) => callback(data))
      return () => ipcRenderer.removeAllListeners('wcdb:decryptProgress')
    }
  },

  // 数据管理
  dataManagement: {
    scanDatabases: () => ipcRenderer.invoke('dataManagement:scanDatabases'),
    decryptAll: () => ipcRenderer.invoke('dataManagement:decryptAll'),
    incrementalUpdate: () => ipcRenderer.invoke('dataManagement:incrementalUpdate'),
    getCurrentCachePath: () => ipcRenderer.invoke('dataManagement:getCurrentCachePath'),
    getDefaultCachePath: () => ipcRenderer.invoke('dataManagement:getDefaultCachePath'),
    migrateCache: (newCachePath: string) => ipcRenderer.invoke('dataManagement:migrateCache', newCachePath),
    scanImages: (dirPath: string) => ipcRenderer.invoke('dataManagement:scanImages', dirPath),
    decryptImages: (dirPath: string) => ipcRenderer.invoke('dataManagement:decryptImages', dirPath),
    getImageDirectories: () => ipcRenderer.invoke('dataManagement:getImageDirectories'),
    decryptSingleImage: (filePath: string) => ipcRenderer.invoke('dataManagement:decryptSingleImage', filePath),
    checkForUpdates: () => ipcRenderer.invoke('dataManagement:checkForUpdates'),
    enableAutoUpdate: (intervalSeconds?: number) => ipcRenderer.invoke('dataManagement:enableAutoUpdate', intervalSeconds),
    disableAutoUpdate: () => ipcRenderer.invoke('dataManagement:disableAutoUpdate'),
    autoIncrementalUpdate: (silent?: boolean) => ipcRenderer.invoke('dataManagement:autoIncrementalUpdate', silent),
    onProgress: (callback: (data: any) => void) => {
      ipcRenderer.on('dataManagement:progress', (_, data) => callback(data))
      return () => ipcRenderer.removeAllListeners('dataManagement:progress')
    },
    onUpdateAvailable: (callback: (hasUpdate: boolean) => void) => {
      ipcRenderer.on('dataManagement:updateAvailable', (_, hasUpdate) => callback(hasUpdate))
      return () => ipcRenderer.removeAllListeners('dataManagement:updateAvailable')
    }
  },

  // 图片解密
  imageDecrypt: {
    batchDetectXorKey: (dirPath: string) => ipcRenderer.invoke('imageDecrypt:batchDetectXorKey', dirPath),
    decryptImage: (inputPath: string, outputPath: string, xorKey: number, aesKey?: string) =>
      ipcRenderer.invoke('imageDecrypt:decryptImage', inputPath, outputPath, xorKey, aesKey)
  },

  // 图片解密（新 API）
  image: {
    decrypt: (payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; force?: boolean }) =>
      ipcRenderer.invoke('image:decrypt', payload),
    resolveCache: (payload: { sessionId?: string; imageMd5?: string; imageDatName?: string }) =>
      ipcRenderer.invoke('image:resolveCache', payload),
    onUpdateAvailable: (callback: (data: { cacheKey: string; imageMd5?: string; imageDatName?: string }) => void) => {
      ipcRenderer.on('image:updateAvailable', (_, data) => callback(data))
      return () => ipcRenderer.removeAllListeners('image:updateAvailable')
    },
    onCacheResolved: (callback: (data: { cacheKey: string; imageMd5?: string; imageDatName?: string; localPath: string }) => void) => {
      ipcRenderer.on('image:cacheResolved', (_, data) => callback(data))
      return () => ipcRenderer.removeAllListeners('image:cacheResolved')
    }
  },

  // 视频
  video: {
    getVideoInfo: (videoMd5: string) => ipcRenderer.invoke('video:getVideoInfo', videoMd5),
    readFile: (videoPath: string) => ipcRenderer.invoke('video:readFile', videoPath),
    parseVideoMd5: (content: string) => ipcRenderer.invoke('video:parseVideoMd5', content)
  },

  // 图片密钥获取
  imageKey: {
    getImageKeys: (userDir: string) => ipcRenderer.invoke('imageKey:getImageKeys', userDir),
    onProgress: (callback: (msg: string) => void) => {
      ipcRenderer.on('imageKey:progress', (_, msg) => callback(msg))
      return () => ipcRenderer.removeAllListeners('imageKey:progress')
    }
  },

  // 聊天
  chat: {
    connect: () => ipcRenderer.invoke('chat:connect'),
    getSessions: () => ipcRenderer.invoke('chat:getSessions'),
    getContacts: () => ipcRenderer.invoke('chat:getContacts'),
    getMessages: (sessionId: string, offset?: number, limit?: number) =>
      ipcRenderer.invoke('chat:getMessages', sessionId, offset, limit),
    getAllVoiceMessages: (sessionId: string) =>
      ipcRenderer.invoke('chat:getAllVoiceMessages', sessionId),
    getContact: (username: string) => ipcRenderer.invoke('chat:getContact', username),
    getContactAvatar: (username: string) => ipcRenderer.invoke('chat:getContactAvatar', username),
    resolveTransferDisplayNames: (chatroomId: string, payerUsername: string, receiverUsername: string) =>
      ipcRenderer.invoke('chat:resolveTransferDisplayNames', chatroomId, payerUsername, receiverUsername),
    getMyAvatarUrl: () => ipcRenderer.invoke('chat:getMyAvatarUrl'),
    getMyUserInfo: () => ipcRenderer.invoke('chat:getMyUserInfo'),
    downloadEmoji: (cdnUrl: string, md5?: string, productId?: string, createTime?: number) => ipcRenderer.invoke('chat:downloadEmoji', cdnUrl, md5, productId, createTime),
    close: () => ipcRenderer.invoke('chat:close'),
    refreshCache: () => ipcRenderer.invoke('chat:refreshCache'),
    setCurrentSession: (sessionId: string | null) => ipcRenderer.invoke('chat:setCurrentSession', sessionId),
    getSessionDetail: (sessionId: string) => ipcRenderer.invoke('chat:getSessionDetail', sessionId),
    getVoiceData: (sessionId: string, msgId: string, createTime?: number) => ipcRenderer.invoke('chat:getVoiceData', sessionId, msgId, createTime),
    getMessagesByDate: (sessionId: string, targetTimestamp: number, limit?: number) =>
      ipcRenderer.invoke('chat:getMessagesByDate', sessionId, targetTimestamp, limit),
    getMessage: (sessionId: string, localId: number) => ipcRenderer.invoke('chat:getMessage', sessionId, localId),
    getDatesWithMessages: (sessionId: string, year: number, month: number) =>
      ipcRenderer.invoke('chat:getDatesWithMessages', sessionId, year, month),
    onSessionsUpdated: (callback: (sessions: any[]) => void) => {
      const listener = (_: any, sessions: any[]) => callback(sessions)
      ipcRenderer.on('chat:sessions-updated', listener)
      return () => ipcRenderer.removeListener('chat:sessions-updated', listener)
    },
    onNewMessages: (callback: (data: { sessionId: string; messages: any[] }) => void) => {
      const listener = (_: any, data: any) => callback(data)
      ipcRenderer.on('chat:new-messages', listener)
      return () => ipcRenderer.removeListener('chat:new-messages', listener)
    }
  },

  // 数据分析
  analytics: {
    getOverallStatistics: () => ipcRenderer.invoke('analytics:getOverallStatistics'),
    getContactRankings: (limit?: number) => ipcRenderer.invoke('analytics:getContactRankings', limit),
    getTimeDistribution: () => ipcRenderer.invoke('analytics:getTimeDistribution')
  },

  // 群聊分析
  groupAnalytics: {
    getGroupChats: () => ipcRenderer.invoke('groupAnalytics:getGroupChats'),
    getGroupMembers: (chatroomId: string) => ipcRenderer.invoke('groupAnalytics:getGroupMembers', chatroomId),
    getGroupMessageRanking: (chatroomId: string, limit?: number, startTime?: number, endTime?: number) => ipcRenderer.invoke('groupAnalytics:getGroupMessageRanking', chatroomId, limit, startTime, endTime),
    getGroupActiveHours: (chatroomId: string, startTime?: number, endTime?: number) => ipcRenderer.invoke('groupAnalytics:getGroupActiveHours', chatroomId, startTime, endTime),
    getGroupMediaStats: (chatroomId: string, startTime?: number, endTime?: number) => ipcRenderer.invoke('groupAnalytics:getGroupMediaStats', chatroomId, startTime, endTime)
  },

  // 年度报告
  annualReport: {
    getAvailableYears: () => ipcRenderer.invoke('annualReport:getAvailableYears'),
    generateReport: (year: number) => ipcRenderer.invoke('annualReport:generateReport', year)
  },

  // 导出
  export: {
    exportSessions: (sessionIds: string[], outputDir: string, options: any) =>
      ipcRenderer.invoke('export:exportSessions', sessionIds, outputDir, options),
    exportSession: (sessionId: string, outputPath: string, options: any) =>
      ipcRenderer.invoke('export:exportSession', sessionId, outputPath, options),
    exportContacts: (outputDir: string, options: any) =>
      ipcRenderer.invoke('export:exportContacts', outputDir, options),
    onProgress: (callback: (data: any) => void) => {
      ipcRenderer.on('export:progress', (_, data) => callback(data))
      return () => ipcRenderer.removeAllListeners('export:progress')
    }
  },

  // 激活
  activation: {
    getDeviceId: () => ipcRenderer.invoke('activation:getDeviceId'),
    verifyCode: (code: string) => ipcRenderer.invoke('activation:verifyCode', code),
    activate: (code: string) => ipcRenderer.invoke('activation:activate', code),
    checkStatus: () => ipcRenderer.invoke('activation:checkStatus'),
    getTypeDisplayName: (type: string | null) => ipcRenderer.invoke('activation:getTypeDisplayName', type),
    clearCache: () => ipcRenderer.invoke('activation:clearCache')
  },
  cache: {
    clearImages: () => ipcRenderer.invoke('cache:clearImages'),
    clearEmojis: () => ipcRenderer.invoke('cache:clearEmojis'),
    clearDatabases: () => ipcRenderer.invoke('cache:clearDatabases'),
    clearAll: () => ipcRenderer.invoke('cache:clearAll'),
    clearConfig: () => ipcRenderer.invoke('cache:clearConfig'),
    getCacheSize: () => ipcRenderer.invoke('cache:getCacheSize')
  },
  log: {
    getLogFiles: () => ipcRenderer.invoke('log:getLogFiles'),
    readLogFile: (filename: string) => ipcRenderer.invoke('log:readLogFile', filename),
    clearLogs: () => ipcRenderer.invoke('log:clearLogs'),
    getLogSize: () => ipcRenderer.invoke('log:getLogSize'),
    getLogDirectory: () => ipcRenderer.invoke('log:getLogDirectory'),
    setLogLevel: (level: string) => ipcRenderer.invoke('log:setLogLevel', level),
    getLogLevel: () => ipcRenderer.invoke('log:getLogLevel')
  },

  // 语音转文字 (STT)
  stt: {
    getModelStatus: () => ipcRenderer.invoke('stt:getModelStatus'),
    downloadModel: () => ipcRenderer.invoke('stt:downloadModel'),
    transcribe: (wavBase64: string, sessionId: string, createTime: number, force?: boolean) => ipcRenderer.invoke('stt:transcribe', wavBase64, sessionId, createTime, force),
    onDownloadProgress: (callback: (progress: { modelName: string; downloadedBytes: number; totalBytes?: number; percent?: number }) => void) => {
      ipcRenderer.on('stt:downloadProgress', (_, progress) => callback(progress))
      return () => ipcRenderer.removeAllListeners('stt:downloadProgress')
    },
    onPartialResult: (callback: (text: string) => void) => {
      ipcRenderer.on('stt:partialResult', (_, text) => callback(text))
      return () => ipcRenderer.removeAllListeners('stt:partialResult')
    },
    getCachedTranscript: (sessionId: string, createTime: number) => ipcRenderer.invoke('stt:getCachedTranscript', sessionId, createTime),
    updateTranscript: (sessionId: string, createTime: number, transcript: string) => ipcRenderer.invoke('stt:updateTranscript', sessionId, createTime, transcript),
    clearModel: () => ipcRenderer.invoke('stt:clearModel')
  },

  // 语音转文字 - Whisper GPU 加速
  sttWhisper: {
    detectGPU: () => ipcRenderer.invoke('stt-whisper:detect-gpu'),
    checkModel: (modelType: string) => ipcRenderer.invoke('stt-whisper:check-model', modelType),
    downloadModel: (modelType: string) => ipcRenderer.invoke('stt-whisper:download-model', modelType),
    clearModel: (modelType: string) => ipcRenderer.invoke('stt-whisper:clear-model', modelType),
    transcribe: (wavData: Buffer, options: { modelType?: string; language?: string }) => 
      ipcRenderer.invoke('stt-whisper:transcribe', wavData, options),
    onDownloadProgress: (callback: (progress: { downloadedBytes: number; totalBytes?: number; percent?: number }) => void) => {
      ipcRenderer.on('stt-whisper:download-progress', (_, progress) => callback(progress))
      return () => ipcRenderer.removeAllListeners('stt-whisper:download-progress')
    },
    downloadGPUComponents: () => ipcRenderer.invoke('stt-whisper:download-gpu-components'),
    checkGPUComponents: () => ipcRenderer.invoke('stt-whisper:check-gpu-components'),
    onGPUDownloadProgress: (callback: (progress: { currentFile: string; fileProgress: number; overallProgress: number; completedFiles: number; totalFiles: number }) => void) => {
      ipcRenderer.on('stt-whisper:gpu-download-progress', (_, progress) => callback(progress))
      return () => ipcRenderer.removeAllListeners('stt-whisper:gpu-download-progress')
    }
  },

  // AI 摘要
  ai: {
    getProviders: () => ipcRenderer.invoke('ai:getProviders'),
    getProxyStatus: () => ipcRenderer.invoke('ai:getProxyStatus'),
    refreshProxy: () => ipcRenderer.invoke('ai:refreshProxy'),
    testProxy: (proxyUrl: string, testUrl?: string) => ipcRenderer.invoke('ai:testProxy', proxyUrl, testUrl),
    testConnection: (provider: string, apiKey: string) => ipcRenderer.invoke('ai:testConnection', provider, apiKey),
    estimateCost: (messageCount: number, provider: string) => ipcRenderer.invoke('ai:estimateCost', messageCount, provider),
    getUsageStats: (startDate?: string, endDate?: string) => ipcRenderer.invoke('ai:getUsageStats', startDate, endDate),
    getSummaryHistory: (sessionId: string, limit?: number) => ipcRenderer.invoke('ai:getSummaryHistory', sessionId, limit),
    deleteSummary: (id: number) => ipcRenderer.invoke('ai:deleteSummary', id),
    renameSummary: (id: number, customName: string) => ipcRenderer.invoke('ai:renameSummary', id, customName),
    cleanExpiredCache: () => ipcRenderer.invoke('ai:cleanExpiredCache'),
    generateSummary: (sessionId: string, timeRange: number, options: {
      provider: string
      apiKey: string
      model: string
      detail: 'simple' | 'normal' | 'detailed'
    }) => ipcRenderer.invoke('ai:generateSummary', sessionId, timeRange, options),
    onSummaryChunk: (callback: (chunk: string) => void) => {
      ipcRenderer.on('ai:summaryChunk', (_, chunk) => callback(chunk))
      return () => ipcRenderer.removeAllListeners('ai:summaryChunk')
    }
  }
})

  // 主题由 index.html 中的内联脚本处理，这里只负责同步 localStorage
  ; (async () => {
    try {
      const theme = await ipcRenderer.invoke('config:get', 'theme') || 'cloud-dancer'
      const themeMode = await ipcRenderer.invoke('config:get', 'themeMode') || 'light'

      // 更新 localStorage 以供下次同步使用（主窗口场景）
      try {
        localStorage.setItem('theme', theme)
        localStorage.setItem('themeMode', themeMode)
      } catch (e) {
        // localStorage 可能不可用
      }
    } catch (e) {
      // 忽略错误
    }
  })()
