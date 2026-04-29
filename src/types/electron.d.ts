import type { ChatSession, Message, Contact, ContactInfo } from './models'
import type {
  EmbeddingDevice,
  EmbeddingMode,
  EmbeddingDeviceStatus,
  EmbeddingModelDownloadProgress,
  EmbeddingModelProfile,
  EmbeddingModelStatus,
  OnlineEmbeddingConfig,
  OnlineEmbeddingConfigInput,
  OnlineEmbeddingProviderInfo,
  OnlineEmbeddingTestResult,
  SessionQAConversationDetail,
  SessionQAConversationSummary,
  SessionQAHistoryMessage,
  SessionQAJobEvent,
  SessionQAProgressEvent,
  SessionQACancelResult,
  SessionQAStartResult,
  SessionQAResult,
  SessionMemoryBuildProgressEvent,
  SessionMemoryBuildState,
  SessionProfileMemoryBuildResult,
  SessionProfileMemoryState,
  SessionVectorIndexProgressEvent,
  SessionVectorIndexState,
  SummaryResult,
  SummaryStructuredAnalysis
} from './ai'
import type { AccountProfile } from './account'


export interface ImageListItem {
  imagePath: string
  liveVideoPath?: string
}

export interface ImageViewerOpenOptions {
  sessionId?: string
  imageMd5?: string
  imageDatName?: string
}

export interface UpdateDownloadProgressPayload {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export type HttpApiListenMode = 'localhost' | 'lan'

export interface HttpApiStatusPayload {
  running: boolean
  host: string
  listenMode: HttpApiListenMode
  port: number
  enabled: boolean
  startedAt: string
  uptimeMs: number
  tokenConfigured: boolean
  tokenPreview: string
  baseUrl: string
  chatlabBaseUrl: string
  lanAddresses: string[]
  endpoints: Array<{ method: string; path: string; desc: string }>
  lastError: string
}

export interface ElectronAPI {
  window: {
    minimize: () => void
    maximize: () => void
    close: () => void
    splashReady: () => void
    onSplashFadeOut?: (callback: () => void) => () => void
    openChatWindow: () => Promise<boolean>
    openMomentsWindow: (filterUsername?: string) => Promise<boolean>
    onMomentsFilterUser: (callback: (username: string) => void) => () => void
    openGroupAnalyticsWindow: () => Promise<boolean>
    openAnnualReportWindow: (year: number) => Promise<boolean>
    openAgreementWindow: () => Promise<boolean>
    openPurchaseWindow: () => Promise<boolean>
    openWelcomeWindow: (mode?: 'default' | 'add-account') => Promise<boolean>
    completeWelcome: () => Promise<boolean>
    isChatWindowOpen: () => Promise<boolean>
    closeChatWindow: () => Promise<boolean>
    setTitleBarOverlay: (options: { symbolColor: string }) => void
    openImageViewerWindow: (
      imagePath: string,
      liveVideoPath?: string,
      imageList?: ImageListItem[],
      options?: ImageViewerOpenOptions
    ) => Promise<void>
    openVideoPlayerWindow: (videoPath: string, videoWidth?: number, videoHeight?: number) => Promise<void>
    openBrowserWindow: (url: string, title?: string) => Promise<void>
    resizeToFitVideo: (videoWidth: number, videoHeight: number) => Promise<void>
    openAISummaryWindow: (sessionId: string, sessionName: string) => Promise<boolean>
    openChatHistoryWindow: (sessionId: string, messageId: number) => Promise<boolean>
    onImageListUpdate: (callback: (data: { imageList: ImageListItem[], currentIndex: number }) => void) => () => void
  }
  config: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    getTldCache: () => Promise<{ tlds: string[]; updatedAt: number } | null>
    setTldCache: (tlds: string[]) => Promise<void>
  }
  accounts: {
    list: () => Promise<AccountProfile[]>
    getActive: () => Promise<AccountProfile | null>
    setActive: (accountId: string) => Promise<AccountProfile | null>
    save: (profile: Omit<AccountProfile, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt'>) => Promise<AccountProfile | null>
    update: (accountId: string, patch: Partial<Omit<AccountProfile, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt'>>) => Promise<AccountProfile | null>
    delete: (accountId: string, deleteLocalData?: boolean) => Promise<{ success: boolean; error?: string; deleted?: AccountProfile | null; nextActiveAccountId?: string }>
  }
  skillManager: {
    list: () => Promise<Array<{ name: string; version: string; description: string; builtin: boolean }>>
    readContent: (skillName: string) => Promise<{ success: boolean; content?: string; error?: string }>
    updateContent: (skillName: string, content: string) => Promise<{ success: boolean; error?: string }>
    exportZip: (skillName: string) => Promise<{ success: boolean; outputPath?: string; fileName?: string; version?: string; error?: string }>
    importZip: (zipPath: string) => Promise<{ success: boolean; skillName?: string; error?: string }>
    delete: (skillName: string) => Promise<{ success: boolean; error?: string }>
    create: (skillName: string, content: string) => Promise<{ success: boolean; error?: string }>
  }
  mcpClient: {
    listConfigs: () => Promise<Record<string, { type: string; command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string; headers?: Record<string, string>; timeoutMs?: number; autoConnect?: boolean }>>
    saveConfig: (name: string, config: { type: string; command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string; headers?: Record<string, string>; timeoutMs?: number; autoConnect?: boolean }, overwrite?: boolean) => Promise<{ success: boolean; error?: string }>
    deleteConfig: (name: string) => Promise<{ success: boolean; error?: string }>
    connect: (name: string) => Promise<{ success: boolean; tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>; error?: string }>
    disconnect: (name: string) => Promise<{ success: boolean; error?: string }>
    listTools: (name: string) => Promise<{ success: boolean; tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>; error?: string }>
    callTool: (name: string, toolName: string, args: Record<string, unknown>) => Promise<{ success: boolean; result?: unknown; error?: string }>
    listStatuses: () => Promise<Array<{ name: string; config: { type: string; command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string; headers?: Record<string, string>; timeoutMs?: number; autoConnect?: boolean }; status: string; toolCount: number; error?: string }>>
  }
  agent: {
    list: (options?: { isBuiltin?: boolean; search?: string }) => Promise<any[]>
    get: (id: string) => Promise<any | null>
    create: (input: any) => Promise<any>
    update: (id: string, patch: any) => Promise<any>
    delete: (id: string) => Promise<{ success: boolean; error?: string }>
    listTools: () => Promise<any[]>
    getRuntimeSettings: () => Promise<{
      memoryModelPresetId: string
      vectorRecallEnabled: boolean
      vectorEmbeddingMode: 'inherit' | 'local' | 'online'
      vectorEmbeddingProfileId: string
    }>
    updateRuntimeSettings: (patch: Partial<{
      memoryModelPresetId: string
      vectorRecallEnabled: boolean
      vectorEmbeddingMode: 'inherit' | 'local' | 'online'
      vectorEmbeddingProfileId: string
    }>) => Promise<{
      memoryModelPresetId: string
      vectorRecallEnabled: boolean
      vectorEmbeddingMode: 'inherit' | 'local' | 'online'
      vectorEmbeddingProfileId: string
    }>
    listSessions: (options?: { search?: string; limit?: number }) => Promise<any[]>
    getSession: (id: string) => Promise<any | null>
    createSession: (input?: { title?: string; agentId?: string }) => Promise<any>
    updateSession: (id: string, patch: { title?: string; agentId?: string | null }) => Promise<any | null>
    deleteSession: (id: string) => Promise<{ success: boolean; error?: string }>
    getSessionMemoryState: (id: string) => Promise<any>
    listSessionSummaries: (id: string) => Promise<any[]>
    updateSessionSummary: (id: string, content: string) => Promise<any | null>
    deleteSessionSummary: (id: string) => Promise<{ success: boolean; sessionId?: string; memoryState?: any; error?: string }>
    clearSessionSummaries: (id: string) => Promise<{ success: boolean; deletedCount: number; result?: any; error?: string }>
    compressSessionContext: (input: { sessionId?: string; agentId?: string }) => Promise<{ success: boolean; summary?: any; memoryState?: any; error?: string }>
    listSessionObservations: (id: string) => Promise<any[]>
    updateSessionObservation: (id: string, patch: { title?: string; content?: string; type?: string; tags?: string[] }) => Promise<any | null>
    deleteSessionObservation: (id: string) => Promise<{ success: boolean; sessionId?: string; memoryState?: any; error?: string }>
    clearSessionObservations: (id: string) => Promise<{ success: boolean; deletedCount: number; result?: any; error?: string }>
    execute: (request: any) => Promise<{ success: boolean; requestId: string; sessionId?: string; error?: string }>
    cancel: (requestId: string) => Promise<{ success: boolean; error?: string }>
    onExecuteEvent: (requestId: string, callback: (event: any) => void) => () => void
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
  file: {
    delete: (filePath: string) => Promise<{ success: boolean; error?: string }>
    copy: (sourcePath: string, destPath: string) => Promise<{ success: boolean; error?: string }>
    writeBase64: (filePath: string, base64Data: string) => Promise<{ success: boolean; error?: string }>
  }
  shell: {
    openPath: (path: string) => Promise<string>
    openExternal: (url: string) => Promise<void>
    showItemInFolder: (fullPath: string) => Promise<void>
  }
  app: {
    getDownloadsPath: () => Promise<string>
    getVersion: () => Promise<string>
    getPlatformInfo: () => Promise<{ platform: string; arch: string }>
    getMcpLaunchConfig: () => Promise<{
      command: string
      args: string[]
      cwd: string
      mode: 'dev' | 'packaged'
    } | null>
    getUpdateState: () => Promise<{
      hasUpdate: boolean
      forceUpdate: boolean
      currentVersion: string
      version?: string
      releaseNotes?: string
      title?: string
      message?: string
      minimumSupportedVersion?: string
      reason?: 'minimum-version' | 'blocked-version'
      checkedAt: number
      updateSource: 'github' | 'custom' | 'none'
      policySource: 'github' | 'custom' | 'none'
      diagnostics?: {
        phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'failed'
        strategy: 'unknown' | 'differential' | 'full'
        fallbackToFull: boolean
        lastError?: string
        lastEvent?: string
        progressPercent?: number
        downloadedBytes?: number
        totalBytes?: number
        targetVersion?: string
        lastUpdatedAt: number
      }
    } | null>
    getUpdateSourceInfo: () => Promise<{
      primaryUpdateSource: 'github'
      githubRepository: {
        owner: string
        repo: string
      }
      policySources: Array<'github' | 'custom'>
      policyPrecedence: 'github'
      forceUpdatePolicyFallbackUrl: string
    }>
    getMcpLaunchConfig: () => Promise<{
      command: string
      args: string[]
      cwd: string
      mode: 'dev' | 'packaged'
    } | null>
    getUpdateState: () => Promise<{
      hasUpdate: boolean
      forceUpdate: boolean
      currentVersion: string
      version?: string
      releaseNotes?: string
      title?: string
      message?: string
      minimumSupportedVersion?: string
      reason?: 'minimum-version' | 'blocked-version'
      checkedAt: number
      updateSource: 'github' | 'custom' | 'none'
      policySource: 'github' | 'custom' | 'none'
      diagnostics?: {
        phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'failed'
        strategy: 'unknown' | 'differential' | 'full'
        fallbackToFull: boolean
        lastError?: string
        lastEvent?: string
        progressPercent?: number
        downloadedBytes?: number
        totalBytes?: number
        targetVersion?: string
        lastUpdatedAt: number
      }
    } | null>
    getUpdateSourceInfo: () => Promise<{
      primaryUpdateSource: 'github'
      githubRepository: {
        owner: string
        repo: string
      }
      policySources: Array<'github' | 'custom'>
      policyPrecedence: 'github'
      forceUpdatePolicyFallbackUrl: string
    }>
    checkForUpdates: () => Promise<{
      hasUpdate: boolean
      forceUpdate: boolean
      currentVersion: string
      version?: string
      releaseNotes?: string
      title?: string
      message?: string
      minimumSupportedVersion?: string
      reason?: 'minimum-version' | 'blocked-version'
      checkedAt: number
      updateSource: 'github' | 'custom' | 'none'
      policySource: 'github' | 'custom' | 'none'
      diagnostics?: {
        phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'failed'
        strategy: 'unknown' | 'differential' | 'full'
        fallbackToFull: boolean
        lastError?: string
        lastEvent?: string
        progressPercent?: number
        downloadedBytes?: number
        totalBytes?: number
        targetVersion?: string
        lastUpdatedAt: number
      }
    }>
    downloadAndInstall: () => Promise<void>
    getStartupDbConnected?: () => Promise<boolean>
    setAppIcon: (iconName: string) => Promise<void>
    onDownloadProgress: (callback: (progress: UpdateDownloadProgressPayload) => void) => () => void
    onUpdateAvailable: (callback: (info: {
      hasUpdate: boolean
      forceUpdate: boolean
      currentVersion: string
      version?: string
      releaseNotes?: string
      title?: string
      message?: string
      minimumSupportedVersion?: string
      reason?: 'minimum-version' | 'blocked-version'
      checkedAt: number
      updateSource: 'github' | 'custom' | 'none'
      policySource: 'github' | 'custom' | 'none'
      diagnostics?: {
        phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'failed'
        strategy: 'unknown' | 'differential' | 'full'
        fallbackToFull: boolean
        lastError?: string
        lastEvent?: string
        progressPercent?: number
        downloadedBytes?: number
        totalBytes?: number
        targetVersion?: string
        lastUpdatedAt: number
      }
    }) => void) => () => void
  }
  httpApi: {
    getStatus: () => Promise<{
      success: boolean
      status?: HttpApiStatusPayload
      error?: string
    }>
    applySettings: (payload: { enabled: boolean; port: number; token: string; listenMode: HttpApiListenMode }) => Promise<{
      success: boolean
      status?: HttpApiStatusPayload
      error?: string
    }>
    restart: () => Promise<{
      success: boolean
      status?: HttpApiStatusPayload
      error?: string
    }>
  }
  systemAuth: {
    getStatus: () => Promise<{
      platform: string
      available: boolean
      method: 'windows-hello' | 'touch-id' | 'none'
      displayName: string
      error?: string
    }>
    verify: (reason?: string) => Promise<{
      success: boolean
      method: 'windows-hello' | 'touch-id' | 'none'
      error?: string
    }>
  }
  wxKey: {
    isWeChatRunning: () => Promise<boolean>
    getWeChatPid: () => Promise<number | null>
    killWeChat: () => Promise<boolean>
    launchWeChat: () => Promise<boolean>
    waitForWindow: (maxWaitSeconds?: number) => Promise<boolean>
    startGetKey: (customWechatPath?: string, dbPath?: string) => Promise<{ success: boolean; key?: string; error?: string; needManualPath?: boolean; validatedWxid?: string }>
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
    resolveValidWxid: (dbPath: string, hexKey: string) => Promise<{ success: boolean; wxid?: string; error?: string }>
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
    decryptSingleDatabase: (filePath: string) => Promise<{
      success: boolean
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
    deleteThumbnails: () => Promise<{ success: boolean; deleted: number; error?: string }>
    countThumbnails: () => Promise<{ success: boolean; count: number; error?: string }>
  }
  video: {
    getVideoInfo: (videoMd5: string, rawContent?: string) => Promise<{
      success: boolean
      error?: string
      exists: boolean
      videoUrl?: string
      coverUrl?: string
      thumbUrl?: string
      diagnostics?: {
        requestedMd5?: string
        candidateMd5s?: string[]
        searchedFileKeys?: string[]
        matchedMd5?: string
        hardlinkMatchedMd5?: string
        hardlinkDbPath?: string
        accountDir?: string
        videoBaseDir?: string
        reason?: 'missing_input' | 'missing_config' | 'account_dir_not_found' | 'video_dir_missing' | 'local_file_missing'
        summary?: string
      }
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
    parseChannelVideo: (content: string) => Promise<{
      success: boolean
      error?: string
      videoInfo?: {
        objectId: string
        title: string
        author: string
        avatar?: string
        videoUrl: string
        thumbUrl?: string
        coverUrl?: string
        duration?: number
        width?: number
        height?: number
      }
    }>
    downloadChannelVideo: (videoInfo: any, key?: string) => Promise<{
      success: boolean
      filePath?: string
      error?: string
      needsKey?: boolean
    }>
    onDownloadProgress: (callback: (progress: {
      objectId: string
      downloaded: number
      total: number
      percentage: number
    }) => void) => () => void
  }
  imageKey: {
    getImageKeys: (userDir: string) => Promise<{ success: boolean; xorKey?: number; aesKey?: string; error?: string }>
    onProgress: (callback: (msg: string) => void) => () => void
  }
  chat: {
    connect: () => Promise<{ success: boolean; error?: string }>
    getSessions: (offset?: number, limit?: number) => Promise<{ success: boolean; sessions?: ChatSession[]; hasMore?: boolean; error?: string }>
    getContacts: () => Promise<{ success: boolean; contacts?: ContactInfo[]; error?: string }>
    getMessages: (sessionId: string, offset?: number, limit?: number) => Promise<{
      success: boolean;
      messages?: Message[];
      hasMore?: boolean;
      error?: string
    }>
    getMessagesBefore: (
      sessionId: string,
      cursorSortSeq: number,
      limit?: number,
      cursorCreateTime?: number,
      cursorLocalId?: number
    ) => Promise<{
      success: boolean;
      messages?: Message[];
      hasMore?: boolean;
      error?: string
    }>
    getMessagesAfter: (
      sessionId: string,
      cursorSortSeq: number,
      limit?: number,
      cursorCreateTime?: number,
      cursorLocalId?: number
    ) => Promise<{
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
    getAllImageMessages: (sessionId: string) => Promise<{
      success: boolean;
      images?: { imageMd5?: string; imageDatName?: string; createTime?: number }[];
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
    downloadEmoji: (cdnUrl: string, md5?: string, productId?: string, createTime?: number, encryptUrl?: string, aesKey?: string) => Promise<{ success: boolean; localPath?: string; error?: string }>
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
  // 朋友圈相关
  sns: {
    getTimeline: (limit?: number, offset?: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number) => Promise<{
      success: boolean
      timeline?: Array<{
        id: string
        username: string
        nickname: string
        avatarUrl?: string
        createTime: number
        contentDesc: string
        type?: number
        media: Array<{
          url: string
          thumb: string
          md5?: string
          token?: string
          key?: string
          encIdx?: string
          livePhoto?: {
            url: string
            thumb: string
            token?: string
            key?: string
            encIdx?: string
          }
        }>
        likes: string[]
        comments: Array<{
          id: string
          nickname: string
          content: string
          refCommentId: string
          refNickname?: string
          emojis?: Array<{
            url: string
            md5: string
            width: number
            height: number
            encryptUrl?: string
            aesKey?: string
          }>
          images?: Array<{
            url: string
            token?: string
            key?: string
            encIdx?: string
            thumbUrl?: string
            thumbUrlToken?: string
            thumbKey?: string
            thumbEncIdx?: string
            width?: number
            height?: number
            heightPercentage?: number
            fileSize?: number
            minArea?: number
            mediaId?: string
            md5?: string
          }>
        }>
        rawXml?: string
      }>
      error?: string
    }>
    proxyImage: (params: { url: string; key?: string | number }) => Promise<{
      success: boolean
      dataUrl?: string
      videoPath?: string
      localPath?: string
      error?: string
    }>
    downloadImage: (params: { url: string; key?: string | number }) => Promise<{
      success: boolean
      error?: string
    }>
    downloadEmoji: (params: { url: string; encryptUrl?: string; aesKey?: string }) => Promise<{
      success: boolean
      localPath?: string
      error?: string
    }>
    writeExportFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>
    saveMediaToDir: (params: { url: string; key?: string | number; outputDir: string; index: number; md5?: string; isAvatar?: boolean; username?: string; isEmoji?: boolean; encryptUrl?: string; aesKey?: string }) => Promise<{ success: boolean; fileName?: string; error?: string }>
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
    clearCurrentAccount: (deleteLocalData?: boolean) => Promise<{ success: boolean; error?: string }>
    clearAllAccountConfigs: () => Promise<{ success: boolean; error?: string }>
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
    testOnlineConfig: (overrides?: {
      provider?: 'openai-compatible' | 'aliyun-qwen-asr' | 'custom'
      apiKey?: string
      baseURL?: string
      model?: string
      language?: string
      timeoutMs?: number
    }) => Promise<{
      success: boolean
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
      history?: SummaryResult[]
      error?: string
    }>
    listSessionQAConversations: (sessionId: string, limit?: number) => Promise<{
      success: boolean
      conversations?: SessionQAConversationSummary[]
      error?: string
    }>
    getSessionQAConversation: (conversationId: number) => Promise<{
      success: boolean
      conversation?: SessionQAConversationDetail
      error?: string
    }>
    createSessionQAConversation: (options: { sessionId: string; sessionName?: string; linkedSummaryId?: number }) => Promise<{
      success: boolean
      conversation?: SessionQAConversationSummary
      error?: string
    }>
    renameSessionQAConversation: (conversationId: number, title: string) => Promise<{
      success: boolean
      error?: string
    }>
    deleteSessionQAConversation: (conversationId: number) => Promise<{
      success: boolean
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
      systemPromptPreset?: 'default' | 'decision-focus' | 'action-focus' | 'risk-focus' | 'custom'
      customSystemPrompt?: string
      customRequirement?: string
      sessionName?: string
      enableThinking?: boolean
    }) => Promise<{
      success: boolean
      result?: SummaryResult
      error?: string
    }>
    askSessionQuestion: (options: {
      sessionId: string
      sessionName?: string
      question: string
      summaryText?: string
      structuredAnalysis?: SummaryStructuredAnalysis
      history?: SessionQAHistoryMessage[]
      provider: string
      apiKey: string
      model: string
      enableThinking?: boolean
    }) => Promise<{
      success: boolean
      result?: SessionQAResult
      error?: string
    }>
    startSessionQuestion: (options: {
      requestId?: string
      conversationId?: number
      sessionId: string
      sessionName?: string
      question: string
      summaryText?: string
      structuredAnalysis?: SummaryStructuredAnalysis
      history?: SessionQAHistoryMessage[]
      provider: string
      apiKey: string
      model: string
      enableThinking?: boolean
    }) => Promise<SessionQAStartResult>
    cancelSessionQuestion: (requestId: string) => Promise<SessionQACancelResult>
    getSessionVectorIndexState: (sessionId: string) => Promise<{
      success: boolean
      result?: SessionVectorIndexState
      error?: string
    }>
    prepareSessionVectorIndex: (options: { sessionId: string }) => Promise<{
      success: boolean
      result?: SessionVectorIndexState
      error?: string
    }>
    cancelSessionVectorIndex: (sessionId: string) => Promise<{
      success: boolean
      result?: SessionVectorIndexState
      error?: string
    }>
    getSessionMemoryBuildState: (sessionId: string) => Promise<{
      success: boolean
      result?: SessionMemoryBuildState
      error?: string
    }>
    prepareSessionMemory: (options: { sessionId: string }) => Promise<{
      success: boolean
      result?: SessionMemoryBuildState
      error?: string
    }>
    getSessionProfileMemoryState: (sessionId: string) => Promise<{
      success: boolean
      result?: SessionProfileMemoryState
      error?: string
    }>
    buildSessionProfileMemory: (options: {
      sessionId: string
      sessionName?: string
      provider: string
      apiKey: string
      model: string
    }) => Promise<{
      success: boolean
      result?: SessionProfileMemoryBuildResult
      error?: string
    }>
    getEmbeddingModelProfiles: () => Promise<{
      success: boolean
      result?: EmbeddingModelProfile[]
      currentProfileId?: string
      embeddingMode?: EmbeddingMode
      error?: string
    }>
    setEmbeddingMode: (mode: EmbeddingMode) => Promise<{
      success: boolean
      result?: EmbeddingMode
      error?: string
    }>
    setEmbeddingModelProfile: (profileId: string) => Promise<{
      success: boolean
      result?: string
      error?: string
    }>
    setEmbeddingVectorDim: (profileId: string, dim: number) => Promise<{
      success: boolean
      result?: number
      vectorModelId?: string
      error?: string
    }>
    getEmbeddingDeviceStatus: () => Promise<{
      success: boolean
      result?: EmbeddingDeviceStatus
      embeddingMode?: EmbeddingMode
      error?: string
    }>
    setEmbeddingDevice: (device: EmbeddingDevice) => Promise<{
      success: boolean
      result?: EmbeddingDevice
      status?: EmbeddingDeviceStatus
      error?: string
    }>
    getEmbeddingModelStatus: (profileId?: string) => Promise<{
      success: boolean
      result?: EmbeddingModelStatus
      error?: string
    }>
    downloadEmbeddingModel: (profileId?: string) => Promise<{
      success: boolean
      result?: EmbeddingModelStatus
      error?: string
    }>
    clearEmbeddingModel: (profileId?: string) => Promise<{
      success: boolean
      result?: EmbeddingModelStatus
      error?: string
    }>
    getOnlineEmbeddingProviders: () => Promise<{
      success: boolean
      result?: OnlineEmbeddingProviderInfo[]
      error?: string
    }>
    listOnlineEmbeddingConfigs: () => Promise<{
      success: boolean
      result?: OnlineEmbeddingConfig[]
      currentConfigId?: string
      error?: string
    }>
    saveOnlineEmbeddingConfig: (payload: OnlineEmbeddingConfigInput) => Promise<{
      success: boolean
      result?: OnlineEmbeddingConfig
      error?: string
    }>
    deleteOnlineEmbeddingConfig: (configId: string) => Promise<{
      success: boolean
      result?: { deleted: boolean; currentConfigId: string; configs: OnlineEmbeddingConfig[] }
      error?: string
    }>
    setCurrentOnlineEmbeddingConfig: (configId: string) => Promise<{
      success: boolean
      result?: OnlineEmbeddingConfig
      error?: string
    }>
    testOnlineEmbeddingConfig: (payload: OnlineEmbeddingConfigInput) => Promise<{
      success: boolean
      result?: OnlineEmbeddingTestResult
      error?: string
    }>
    clearSemanticVectorIndex: (vectorModel?: string) => Promise<{
      success: boolean
      result?: { success: boolean; deletedCount: number; vectorModel: string }
      error?: string
    }>
    onSummaryChunk: (callback: (chunk: string) => void) => () => void
    onSessionQAChunk: (callback: (chunk: string) => void) => () => void
    onSessionQAProgress: (callback: (event: SessionQAProgressEvent) => void) => () => void
    onSessionQAEvent: (callback: (event: SessionQAJobEvent) => void) => () => void
    onSessionQAConversationUpdated: (callback: (event: SessionQAConversationDetail) => void) => () => void
    onSessionVectorIndexProgress: (callback: (event: SessionVectorIndexProgressEvent) => void) => () => void
    onSessionMemoryBuildProgress: (callback: (event: SessionMemoryBuildProgressEvent) => void) => () => void
    onEmbeddingModelDownloadProgress: (callback: (event: EmbeddingModelDownloadProgress) => void) => () => void
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
