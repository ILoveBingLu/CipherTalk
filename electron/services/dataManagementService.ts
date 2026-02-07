import * as fs from 'fs'
import * as path from 'path'
import { app, BrowserWindow } from 'electron'
import { ConfigService } from './config'
import { wechatDecryptService } from './decryptService'
import { imageDecryptService } from './imageDecryptService'
import { chatService } from './chatService'

// 文件系统监听器类型
type FileWatcher = fs.FSWatcher | null

export interface DatabaseFileInfo {
  fileName: string
  filePath: string
  fileSize: number
  wxid: string
  isDecrypted: boolean
  decryptedPath?: string
  needsUpdate: boolean  // 是否需要增量更新
  originalModified?: number  // 源文件修改时间戳
  decryptedModified?: number  // 解密文件修改时间戳
}

export interface ImageFileInfo {
  fileName: string
  filePath: string
  fileSize: number
  isDecrypted: boolean
  decryptedPath?: string
  version: number  // 0=V3, 1=V4-V1, 2=V4-V2
}

class DataManagementService {
  private configService: ConfigService
  private dbWatcher: FileWatcher = null
  private autoUpdateEnabled: boolean = false
  private autoUpdateInterval: NodeJS.Timeout | null = null
  private lastCheckTime: number = 0
  private isUpdating: boolean = false
  private silentMode: boolean = false
  private updateListeners: Set<(hasUpdate: boolean) => void> = new Set()
  private lastUpdateTime: number = 0
  private pendingUpdateCount: number = 0 // 待处理的更新请求数
  private updateQueue: Array<() => Promise<void>> = [] // 更新队列
  private isProcessingQueue: boolean = false

  constructor() {
    this.configService = new ConfigService()
  }

  /**
   * 扫描数据库文件
   * 只扫描当前用户配置的 wxid 目录下的数据库
   */
  async scanDatabases(): Promise<{ success: boolean; databases?: DatabaseFileInfo[]; error?: string }> {
    try {
      const databases: DatabaseFileInfo[] = []

      // 获取配置的数据库路径
      const dbPath = this.configService.get('dbPath')
      if (!dbPath) {
        return { success: false, error: '请先在设置页面配置数据库路径' }
      }

      // 获取配置的 wxid
      const wxid = this.configService.get('myWxid')
      if (!wxid) {
        return { success: false, error: '请先在设置页面配置 wxid' }
      }

      // 获取缓存目录（优先使用配置的路径）
      let cipherTalkDir = this.configService.get('cachePath')
      if (!cipherTalkDir) {
        cipherTalkDir = this.getDefaultCachePath()
      }

      // 检查路径是否存在
      if (!fs.existsSync(dbPath)) {
        return { success: false, error: `数据库路径不存在: ${dbPath}` }
      }

      // 智能识别路径类型
      const pathParts = dbPath.split(path.sep)
      const lastPart = pathParts[pathParts.length - 1]

      if (lastPart === 'db_storage') {
        // 直接选择了 db_storage 目录
        const accountName = pathParts.length >= 2 ? this.cleanAccountDirName(pathParts[pathParts.length - 2]) : 'unknown'
        await this.scanDbStorageDirectory(dbPath, accountName, cipherTalkDir, databases)
      } else {
        // 只扫描配置的 wxid 目录
        // 先查找实际的账号目录名（可能包含后缀如 _bf70）
        const actualAccountDir = this.findAccountDir(dbPath, wxid)

        if (!actualAccountDir) {
          return { success: false, error: `未找到账号目录: ${wxid}` }
        }

        const cleanedAccountName = this.cleanAccountDirName(actualAccountDir)
        const dbStoragePath = path.join(dbPath, actualAccountDir, 'db_storage')

        if (fs.existsSync(dbStoragePath)) {
          await this.scanDbStorageDirectory(dbStoragePath, cleanedAccountName, cipherTalkDir, databases)
        } else {
          return { success: false, error: `账号目录下不存在 db_storage: ${dbStoragePath}` }
        }
      }

      // 按文件大小排序
      databases.sort((a, b) => a.fileSize - b.fileSize)

      return { success: true, databases }
    } catch (e) {
      console.error('扫描数据库失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 扫描 db_storage 目录
   */
  private async scanDbStorageDirectory(
    dbStoragePath: string,
    accountName: string,
    cipherTalkDir: string,
    databases: DatabaseFileInfo[]
  ): Promise<void> {
    const dbFiles = this.findAllDbFiles(dbStoragePath)

    for (const filePath of dbFiles) {
      const fileName = path.basename(filePath)
      const stats = fs.statSync(filePath)
      const fileSize = stats.size
      const originalModified = stats.mtimeMs

      // 检查是否已解密
      const decryptedFileName = fileName.replace(/\.db$/, '') + '.db'
      const decryptedPath = path.join(cipherTalkDir, accountName, decryptedFileName)
      const isDecrypted = fs.existsSync(decryptedPath)

      let decryptedModified: number | undefined
      let needsUpdate = false

      if (isDecrypted) {
        const decryptedStats = fs.statSync(decryptedPath)
        decryptedModified = decryptedStats.mtimeMs
        // 源文件比解密文件新，需要更新
        needsUpdate = originalModified > decryptedModified
      }

      databases.push({
        fileName,
        filePath,
        fileSize,
        wxid: accountName,
        isDecrypted,
        decryptedPath,
        needsUpdate,
        originalModified,
        decryptedModified
      })
    }
  }

  /**
   * 递归查找所有 .db 文件
   */
  private findAllDbFiles(dir: string): string[] {
    const dbFiles: string[] = []

    const scan = (currentDir: string) => {
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true })

        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name)

          if (entry.isDirectory()) {
            scan(fullPath)
          } else if (entry.isFile() && entry.name.endsWith('.db')) {
            dbFiles.push(fullPath)
          }
        }
      } catch (e) {
        // 忽略无法访问的目录
      }
    }

    scan(dir)
    return dbFiles
  }

  /**
   * 清理账号目录名
   * 微信账号目录格式多样：
   * - wxid_xxxxx（传统格式）
   * - 纯数字（QQ号绑定）
   * - 自定义微信号格式（如 chenggongyouyue003_03d9）
   * 
   * 注意：不再去除后缀，因为自定义微信号本身可能包含下划线
   */
  private cleanAccountDirName(dirName: string): string {
    const trimmed = dirName.trim()
    if (!trimmed) return trimmed

    // wxid_ 开头的账号，提取主要部分（去除可能的随机后缀）
    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[a-zA-Z0-9]+)/i)
      if (match) return match[1]
      return trimmed
    }

    // 自定义微信号或其他格式，直接返回（不做处理）
    // 因为自定义微信号本身可能包含下划线，如 chenggongyouyue003_03d9
    return trimmed
  }

  /**
   * 查找账号对应的实际目录名
   * 因为目录名可能是 wxid_xxx、abc123 或 abc123_xxxx 等格式
   * 支持多种匹配方式以兼容不同版本的目录命名
   */
  private findAccountDir(baseDir: string, wxid: string): string | null {
    if (!fs.existsSync(baseDir)) return null

    const cleanedWxid = this.cleanAccountDirName(wxid)

    // 1. 直接匹配原始 wxid
    const directPath = path.join(baseDir, wxid)
    if (fs.existsSync(directPath)) {
      return wxid
    }

    // 2. 直接匹配清理后的 wxid
    if (cleanedWxid !== wxid) {
      const cleanedPath = path.join(baseDir, cleanedWxid)
      if (fs.existsSync(cleanedPath)) {
        return cleanedWxid
      }
    }

    // 3. 扫描目录，查找匹配的账号目录
    try {
      const entries = fs.readdirSync(baseDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        const dirName = entry.name
        const dirNameLower = dirName.toLowerCase()
        const wxidLower = wxid.toLowerCase()
        const cleanedWxidLower = cleanedWxid.toLowerCase()

        // 精确匹配（忽略大小写）
        if (dirNameLower === wxidLower || dirNameLower === cleanedWxidLower) {
          return dirName
        }

        // 前缀匹配
        if (dirNameLower.startsWith(wxidLower + '_') || dirNameLower.startsWith(cleanedWxidLower + '_')) {
          return dirName
        }

        // 反向前缀匹配
        if (wxidLower.startsWith(dirNameLower + '_') || cleanedWxidLower.startsWith(dirNameLower + '_')) {
          return dirName
        }

        // 清理后匹配
        const cleanedDirName = this.cleanAccountDirName(dirName)
        if (cleanedDirName.toLowerCase() === wxidLower || cleanedDirName.toLowerCase() === cleanedWxidLower) {
          return dirName
        }
      }
    } catch (e) {
      console.error('查找账号目录失败:', e)
    }

    return null
  }

  /**
   * 批量解密所有待解密的数据库
   */
  async decryptAll(): Promise<{ success: boolean; successCount?: number; failCount?: number; error?: string }> {
    try {
      const scanResult = await this.scanDatabases()
      if (!scanResult.success || !scanResult.databases) {
        return { success: false, error: scanResult.error || '扫描数据库失败' }
      }

      const pendingFiles = scanResult.databases.filter(db => !db.isDecrypted)
      if (pendingFiles.length === 0) {
        return { success: true, successCount: 0, failCount: 0 }
      }

      const key = this.configService.get('decryptKey')
      if (!key) {
        return { success: false, error: '请先在设置页面配置解密密钥' }
      }

      let successCount = 0
      let failCount = 0
      const totalFiles = pendingFiles.length

      for (let i = 0; i < pendingFiles.length; i++) {
        const file = pendingFiles[i]
        const time = new Date().toLocaleTimeString()
        console.log(`[${time}] [数据解密] 正在解密: ${file.fileName} (${i + 1}/${totalFiles})`)

        // 发送进度到前端
        this.sendProgress({
          type: 'decrypt',
          current: i,
          total: totalFiles,
          fileName: file.fileName,
          fileProgress: 0
        })

        const outputDir = path.dirname(file.decryptedPath!)
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true })
        }

        const result = await wechatDecryptService.decryptDatabase(
          file.filePath,
          file.decryptedPath!,
          key,
          (current, total) => {
            this.sendProgress({
              type: 'decrypt',
              current: i,
              total: totalFiles,
              fileName: file.fileName,
              fileProgress: Math.round((current / total) * 100)
            })
          }
        )

        if (result.success) {
          successCount++
          const time = new Date().toLocaleTimeString()
          console.log(`[${time}] [数据解密] 解密成功: ${file.fileName}`)
        } else {
          failCount++
          const time = new Date().toLocaleTimeString()
          console.error(`[${time}] [数据解密] 解密失败: ${file.fileName}`, result.error)
        }

        // 关键：强制让出主线程时间片，防止批量处理时 UI 卡死
        // 即使是 Worker 解密，连续的 IPC 通信和主线程调度也会导致卡顿
        await new Promise(resolve => setTimeout(resolve, 10))
      }

      // 完成
      this.sendProgress({ type: 'complete' })

      // 刷新 chatService 的缓存，让下次访问时重新扫描数据库
      chatService.refreshMessageDbCache()

      return { success: true, successCount, failCount }
    } catch (e) {
      console.error('批量解密失败:', e)
      this.sendProgress({ type: 'error', error: String(e) })
      return { success: false, error: String(e) }
    }
  }

  /**
   * 增量更新（只更新有变化的文件）
   */
  async incrementalUpdate(silent: boolean = false): Promise<{ success: boolean; successCount?: number; failCount?: number; error?: string }> {
    // 设置静默模式
    const previousSilentMode = this.silentMode
    this.silentMode = silent

    try {
      const scanResult = await this.scanDatabases()
      if (!scanResult.success || !scanResult.databases) {
        return { success: false, error: scanResult.error || '扫描数据库失败' }
      }

      const filesToUpdate = scanResult.databases.filter(db => db.needsUpdate)
      if (filesToUpdate.length === 0) {
        return { success: true, successCount: 0, failCount: 0 }
      }

      const key = this.configService.get('decryptKey')
      if (!key) {
        return { success: false, error: '请先在设置页面配置解密密钥' }
      }

      // 不再关闭整个 chatService，而是在更新每个文件前只关闭那个特定的数据库
      // 这样用户可以在增量更新时继续查看其他会话的消息
      imageDecryptService.clearHardlinkCache()

      let successCount = 0
      let failCount = 0
      const totalFiles = filesToUpdate.length

      for (let i = 0; i < filesToUpdate.length; i++) {
        const file = filesToUpdate[i]

        // 在处理每个文件前让出时间片，避免阻塞UI
        const time = new Date().toLocaleTimeString()
        // console.log(`[${time}] [增量同步] 正在同步数据库: ${file.fileName} (${i + 1}/${totalFiles})`) // 减少日志
        if (i > 0) {
          await new Promise(resolve => setImmediate(resolve))
        }

        this.sendProgress({
          type: 'update',
          current: i,
          total: totalFiles,
          fileName: file.fileName,
          fileProgress: 0
        })

        // 检查源文件是否存在且可读
        if (!fs.existsSync(file.filePath)) {
          console.warn(`源文件不存在: ${file.filePath}`)
          failCount++
          continue
        }

        // 尝试读取源文件的前几个字节，检查文件是否可读
        try {
          const fd = fs.openSync(file.filePath, 'r')
          fs.closeSync(fd)
        } catch (e) {
          console.warn(`源文件无法读取: ${file.filePath}`, e)
          failCount++
          continue
        }

        const backupPath = file.decryptedPath + '.old.' + Date.now()

        // 在备份/覆盖文件前，先关闭该数据库的连接，释放文件锁
        chatService.closeDatabase(file.fileName)
        // 等待文件句柄释放
        await new Promise(resolve => setTimeout(resolve, 100))

        if (fs.existsSync(file.decryptedPath!)) {
          // 尝试备份文件，如果失败则重试几次
          let backupSuccess = false
          const maxRetries = 3
          for (let retry = 0; retry < maxRetries; retry++) {
            try {
              // 如果是 hardlink.db，再次清理缓存
              if (file.fileName.toLowerCase().includes('hardlink')) {
                imageDecryptService.clearHardlinkCache()
                await new Promise(resolve => setTimeout(resolve, 200))
              }

              fs.renameSync(file.decryptedPath!, backupPath)
              backupSuccess = true
              break
            } catch (e: any) {
              if (e.code === 'EBUSY' || e.code === 'EPERM') {
                // 文件被占用，等待后重试
                if (retry < maxRetries - 1) {
                  // console.warn(`备份文件失败（重试 ${retry + 1}/${maxRetries}）: ${file.fileName}`, e.code)
                  await new Promise(resolve => setTimeout(resolve, 500 * (retry + 1)))
                } else {
                  // console.error(`备份旧文件失败（已重试 ${maxRetries} 次），将尝试直接覆盖: ${file.fileName}`, e)
                  // 即使备份失败，也不中断，尝试直接覆盖原文件
                  // 很多时候 rename 失败是因为杀毒软件扫描或文件锁定，但写入可能仍有机会成功
                }
              } else {
                // 非文件占用错误，记录并继续尝试
                console.error(`备份文件遇到非锁定错误: ${file.fileName}`, e)
              }
            }
          }

          if (!backupSuccess) {
            // 重试失败，跳过这个文件
            continue
          }
        }

        const result = await wechatDecryptService.decryptDatabase(
          file.filePath,
          file.decryptedPath!,
          key,
          (current, total) => {
            this.sendProgress({
              type: 'update',
              current: i,
              total: totalFiles,
              fileName: file.fileName,
              fileProgress: Math.round((current / total) * 100)
            })
          }
        )

        // 验证解密后的文件是否完整（FTS 数据库跳过完整性检查）
        const isFtsDb = file.fileName.toLowerCase().includes('fts') || file.fileName.toLowerCase().includes('_fts')
        const skipIntegrityCheck = this.configService.get('skipIntegrityCheck') === true
        if (result.success && fs.existsSync(file.decryptedPath!) && !isFtsDb && !skipIntegrityCheck) {
          try {
            // 尝试打开解密后的数据库文件，验证完整性
            // 使用异步方式，避免阻塞主线程
            const Database = require('better-sqlite3')
            const testDb = new Database(file.decryptedPath!, { readonly: true })

            // 让出时间片，避免阻塞UI
            await new Promise(resolve => setImmediate(resolve))

            const integrityResult = testDb.prepare('PRAGMA integrity_check').get() as any
            testDb.close()

            // 再次让出时间片
            await new Promise(resolve => setImmediate(resolve))

            // 检查完整性结果
            if (integrityResult && typeof integrityResult === 'object' && integrityResult['integrity_check'] !== 'ok') {
              throw new Error('数据库完整性检查失败')
            }
          } catch (integrityError: any) {
            // 只对真正的损坏错误进行处理，忽略 FTS 数据库的逻辑错误
            if (integrityError?.code === 'SQLITE_CORRUPT' || integrityError?.message?.includes('malformed')) {
              console.error(`解密后的数据库文件损坏: ${file.decryptedPath}`, integrityError)
              // 关闭可能占用文件的连接
              chatService.close()
              await new Promise(resolve => setTimeout(resolve, 200))

              // 恢复备份（先删除损坏文件，再重命名备份）
              if (fs.existsSync(backupPath)) {
                try {
                  // 先尝试删除损坏的文件
                  if (fs.existsSync(file.decryptedPath!)) {
                    try {
                      fs.unlinkSync(file.decryptedPath!)
                    } catch (e) {
                      // 如果删除失败，尝试重命名
                      const corruptedPath = file.decryptedPath! + '.corrupted.' + Date.now()
                      try {
                        fs.renameSync(file.decryptedPath!, corruptedPath)
                      } catch { }
                    }
                  }
                  // 然后恢复备份
                  fs.renameSync(backupPath, file.decryptedPath!)
                  console.log(`已恢复备份文件: ${file.fileName}`)
                } catch (e: any) {
                  console.error(`恢复备份失败: ${file.fileName}`, e)
                  // 如果恢复失败，记录错误但继续处理其他文件
                }
              }
              failCount++
              continue
            } else {
              // 其他错误（如 SQL logic error）可能是 FTS 数据库的正常情况，记录但不失败
              console.warn(`数据库验证警告（可能正常）: ${file.fileName}`, integrityError?.code || integrityError?.message)
            }
          }
        }

        if (result.success) {
          successCount++
          // const time = new Date().toLocaleTimeString()
          // console.log(`[${time}] [增量同步] 同步成功: ${file.fileName}`) // 减少日志
          if (fs.existsSync(backupPath)) {
            try { fs.unlinkSync(backupPath) } catch { }
          }
        } else {
          failCount++
          const time = new Date().toLocaleTimeString()
          console.error(`[${time}] [增量同步] 同步失败: ${file.fileName}`, result.error)
          if (fs.existsSync(backupPath)) {
            try { fs.renameSync(backupPath, file.decryptedPath!) } catch { }
          }
        }

        // 关键：强制让出主线程时间片，防止批量处理时 UI 卡死
        await new Promise(resolve => setTimeout(resolve, 10))
      }

      this.sendProgress({ type: 'complete' })

      // 刷新 chatService 的缓存，让下次访问时重新扫描数据库
      chatService.refreshMessageDbCache()

      return { success: true, successCount, failCount }
    } catch (e) {
      const time = new Date().toLocaleTimeString()
      console.error(`[${time}] [增量同步] 过程出现异常:`, e)
      this.sendProgress({ type: 'error', error: String(e) })
      return { success: false, error: String(e) }
    } finally {
      // 恢复之前的静默模式状态
      this.silentMode = previousSilentMode
    }
  }



  /**
   * 发送进度到前端（发送到所有窗口，确保主窗口能收到）
   */
  private sendProgress(data: any) {
    // 如果当前是静默模式，不发送进度事件
    if (this.silentMode) {
      return
    }

    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('dataManagement:progress', data)
      }
    }
  }

  /**
   * 获取当前缓存目录
   */
  getCurrentCachePath(): string {
    const cachePath = this.configService.get('cachePath')
    if (cachePath) return cachePath
    return this.getDefaultCachePath()
  }

  /**
   * 获取默认缓存目录
   * - 开发环境：使用文档目录
   * - 生产环境：
   *   - 如果安装在 C 盘：使用文档目录（C 盘可能有写入权限问题）
   *   - 如果安装在其他盘：使用软件安装目录
   */
  getDefaultCachePath(): string {
    // 开发环境使用文档目录
    if (process.env.VITE_DEV_SERVER_URL) {
      const documentsPath = app.getPath('documents')
      return path.join(documentsPath, 'CipherTalkData')
    }

    // 生产环境
    const exePath = app.getPath('exe')
    const installDir = path.dirname(exePath)

    // 检查是否安装在 C 盘（Windows）
    const isOnCDrive = /^[cC]:/i.test(installDir) || installDir.startsWith('\\')

    if (isOnCDrive) {
      // C 盘可能有写入权限问题，使用文档目录
      const documentsPath = app.getPath('documents')
      return path.join(documentsPath, 'CipherTalkData')
    }

    // 其他盘使用软件安装目录
    return path.join(installDir, 'CipherTalkData')
  }

  /**
   * 迁移缓存到新目录
   */
  async migrateCache(newCachePath: string): Promise<{ success: boolean; movedCount?: number; error?: string }> {
    try {
      // 检查可能存在数据的目录：配置的路径和默认路径
      const configuredPath = this.configService.get('cachePath')
      const defaultPath = this.getDefaultCachePath()

      // 确定实际的旧缓存目录（优先检查默认路径是否有数据）
      let oldCachePath: string | null = null

      // 如果默认路径存在且有内容，优先迁移它
      if (fs.existsSync(defaultPath) && fs.readdirSync(defaultPath).length > 0) {
        oldCachePath = defaultPath
      }
      // 否则检查配置的路径
      else if (configuredPath && fs.existsSync(configuredPath) && fs.readdirSync(configuredPath).length > 0) {
        oldCachePath = configuredPath
      }

      if (!oldCachePath) {
        // 没有找到需要迁移的数据，直接创建新目录
        fs.mkdirSync(newCachePath, { recursive: true })
        return { success: true, movedCount: 0 }
      }

      if (oldCachePath === newCachePath) {
        return { success: false, error: '新旧目录相同，无需迁移' }
      }

      console.log(`迁移缓存: ${oldCachePath} -> ${newCachePath}`)

      // 确保新目录存在
      fs.mkdirSync(newCachePath, { recursive: true })

      // 获取旧目录下的所有文件和文件夹
      const entries = fs.readdirSync(oldCachePath, { withFileTypes: true })
      let movedCount = 0

      for (const entry of entries) {
        const oldPath = path.join(oldCachePath, entry.name)
        const newPath = path.join(newCachePath, entry.name)

        this.sendProgress({
          type: 'migrate',
          fileName: entry.name,
          current: movedCount,
          total: entries.length
        })

        try {
          if (entry.isDirectory()) {
            // 递归复制目录
            await this.copyDirectory(oldPath, newPath)
          } else {
            // 复制文件
            fs.copyFileSync(oldPath, newPath)
          }
          movedCount++
        } catch (e) {
          console.error(`迁移失败: ${entry.name}`, e)
        }
      }

      // 删除旧目录
      try {
        fs.rmSync(oldCachePath, { recursive: true, force: true })
      } catch (e) {
        console.warn('删除旧缓存目录失败:', e)
      }

      this.sendProgress({ type: 'complete' })

      return { success: true, movedCount }
    } catch (e) {
      console.error('缓存迁移失败:', e)
      this.sendProgress({ type: 'error', error: String(e) })
      return { success: false, error: String(e) }
    }
  }

  /**
   * 递归复制目录
   */
  private async copyDirectory(src: string, dest: string): Promise<void> {
    fs.mkdirSync(dest, { recursive: true })
    const entries = fs.readdirSync(src, { withFileTypes: true })

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)

      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath)
      } else {
        fs.copyFileSync(srcPath, destPath)
      }
    }
  }

  /**
   * 扫描图片文件（扫描已解密的图片，而不是 .dat 文件）
   */
  async scanImages(imagesDir: string): Promise<{ success: boolean; images?: ImageFileInfo[]; error?: string }> {
    try {
      if (!fs.existsSync(imagesDir)) {
        return { success: false, error: `目录不存在: ${imagesDir}` }
      }

      const images: ImageFileInfo[] = []
      
      // 支持的图片格式
      const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']

      let batchImages: ImageFileInfo[] = []
      const BATCH_SIZE = 100

      const flushBatch = () => {
        if (batchImages.length > 0) {
          this.sendProgress({
            type: 'imageBatch',
            images: [...batchImages]
          })
          batchImages = []
        }
      }

      // 让出事件循环，避免阻塞 UI
      const yieldToMain = () => new Promise<void>(resolve => setImmediate(resolve))

      const scanDir = async (dir: string): Promise<void> => {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true })
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name)

            if (entry.isDirectory()) {
              // 递归扫描子目录（wxid/session/date 结构）
              await scanDir(fullPath)
            } else if (entry.isFile()) {
              // 检查是否是图片文件
              const ext = path.extname(entry.name).toLowerCase()
              if (!imageExtensions.includes(ext)) continue

              try {
                const stats = fs.statSync(fullPath)
                // 跳过太小的文件
                if (stats.size < 100) continue

                const imageInfo: ImageFileInfo = {
                  fileName: entry.name,
                  filePath: fullPath,
                  fileSize: stats.size,
                  isDecrypted: true,  // 已经是解密后的文件
                  decryptedPath: fullPath,
                  version: 0  // 已解密的文件不需要版本信息
                }

                images.push(imageInfo)
                batchImages.push(imageInfo)

                // 每 BATCH_SIZE 个发送一次，并让出事件循环
                if (batchImages.length >= BATCH_SIZE) {
                  flushBatch()
                  await yieldToMain()
                }
              } catch {
                // 忽略无法访问的文件
              }
            }
          }
        } catch {
          // 忽略无法访问的目录
        }
      }

      await scanDir(imagesDir)

      // 发送剩余的
      flushBatch()

      // 按文件大小排序（从小到大）
      images.sort((a, b) => a.fileSize - b.fileSize)

      // 扫描完成通知
      this.sendProgress({
        type: 'imageScanComplete',
        total: images.length
      })

      return { success: true, images }
    } catch (e) {
      console.error('扫描图片失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 静默扫描图片（不发送事件，用于批量解密）
   */
  private async scanImagesQuiet(accountDir: string): Promise<ImageFileInfo[]> {
    const images: ImageFileInfo[] = []
    const cachePath = this.getCurrentCachePath()
    const imageOutputDir = path.join(cachePath, 'images')
    const imageSuffixes = ['.b', '.h', '.t', '.c', '.w', '.l', '_b', '_h', '_t', '_c', '_w', '_l']

    const scanDir = (dir: string): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name)

          if (entry.isDirectory()) {
            if (entry.name === 'db_storage' || entry.name === 'database') continue
            scanDir(fullPath)
          } else if (entry.name.endsWith('.dat')) {
            const baseName = path.basename(entry.name, '.dat').toLowerCase()
            const isImageFile = imageSuffixes.some(suffix => baseName.endsWith(suffix))
            if (!isImageFile) continue

            try {
              const stats = fs.statSync(fullPath)
              if (stats.size < 100) continue

              const version = imageDecryptService.getDatVersion(fullPath)
              const relativePath = path.relative(accountDir, fullPath)
              const outputRelativePath = relativePath.replace(/\.dat$/, '')

              let isDecrypted = false
              for (const ext of ['.jpg', '.png', '.gif', '.bmp', '.webp']) {
                const possiblePath = path.join(imageOutputDir, outputRelativePath + ext)
                if (fs.existsSync(possiblePath)) {
                  isDecrypted = true
                  break
                }
              }

              // 只添加未解密的图片
              if (!isDecrypted) {
                images.push({
                  fileName: entry.name,
                  filePath: fullPath,
                  fileSize: stats.size,
                  isDecrypted: false,
                  version
                })
              }
            } catch {
              // 忽略
            }
          }
        }
      } catch {
        // 忽略
      }
    }

    scanDir(accountDir)
    return images
  }

  /**
   * 批量解密图片
   */
  async decryptImages(accountDir: string): Promise<{ success: boolean; successCount?: number; failCount?: number; error?: string }> {
    try {
      // 获取密钥
      const xorKeyStr = this.configService.get('imageXorKey')
      const aesKeyStr = this.configService.get('imageAesKey')

      if (!xorKeyStr) {
        return { success: false, error: '请先在设置页面配置图片 XOR 密钥' }
      }

      const xorKey = parseInt(String(xorKeyStr), 16)
      if (isNaN(xorKey)) {
        return { success: false, error: 'XOR 密钥格式错误' }
      }

      // 静默扫描图片（不发送事件到前端）
      console.log('开始扫描待解密图片...')
      const pendingImages = await this.scanImagesQuiet(accountDir)
      console.log(`找到 ${pendingImages.length} 个待解密图片`)

      if (pendingImages.length === 0) {
        return { success: true, successCount: 0, failCount: 0 }
      }

      const cachePath = this.getCurrentCachePath()
      const imageOutputDir = path.join(cachePath, 'images')

      // 确保输出目录存在
      if (!fs.existsSync(imageOutputDir)) {
        fs.mkdirSync(imageOutputDir, { recursive: true })
      }

      let successCount = 0
      let failCount = 0
      const totalFiles = pendingImages.length
      const aesKeyBuffer = aesKeyStr ? imageDecryptService.asciiKey16(String(aesKeyStr)) : Buffer.alloc(16)

      // 分批处理，每批 50 个，避免内存溢出
      const BATCH_SIZE = 50

      for (let i = 0; i < pendingImages.length; i++) {
        const img = pendingImages[i]

        // 每 10 个更新一次进度，减少 IPC 通信
        if (i % 10 === 0 || i === pendingImages.length - 1) {
          this.sendProgress({
            type: 'image',
            current: i,
            total: totalFiles,
            fileName: img.fileName,
            fileProgress: Math.round(((i + 1) / totalFiles) * 100)
          })
        }

        try {
          // 计算输出路径（保持目录结构）
          const relativePath = path.relative(accountDir, img.filePath)
          const outputRelativePath = relativePath.replace(/\.dat$/, '')

          // 解密图片
          const decrypted = imageDecryptService.decryptDatFile(img.filePath, xorKey, aesKeyBuffer)

          // 检测图片格式
          const ext = this.detectImageFormat(decrypted)
          const outputPath = path.join(imageOutputDir, outputRelativePath + ext)

          // 确保输出目录存在
          const outputDir = path.dirname(outputPath)
          if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true })
          }

          fs.writeFileSync(outputPath, decrypted)
          successCount++
        } catch (e) {
          // 静默失败，不打印每个错误
          failCount++
        }

        // 每批处理完后让出事件循环，避免阻塞
        if ((i + 1) % BATCH_SIZE === 0) {
          await new Promise(resolve => setImmediate(resolve))
        }
      }

      this.sendProgress({ type: 'complete' })
      console.log(`批量解密完成: 成功 ${successCount}, 失败 ${failCount}`)

      return { success: true, successCount, failCount }
    } catch (e) {
      console.error('批量解密图片失败:', e)
      this.sendProgress({ type: 'error', error: String(e) })
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取图片目录（返回解密后的图片缓存目录）
   */
  getImageDirectories(): { success: boolean; directories?: { wxid: string; path: string }[]; error?: string } {
    try {
      const dbPath = this.configService.get('dbPath')
      const wxid = this.configService.get('myWxid')
      
      if (!dbPath || !wxid) {
        return { success: false, error: '请先在设置页面配置数据库路径和账号' }
      }

      // 获取缓存路径（解密后的文件存储位置）
      const cachePath = this.getCurrentCachePath()
      if (!fs.existsSync(cachePath)) {
        return { success: false, error: '缓存目录不存在，请先解密数据库' }
      }

      // 图片统一存放在 images 目录下
      const imagesDir = path.join(cachePath, 'images')
      if (!fs.existsSync(imagesDir)) {
        return { success: false, error: '图片目录不存在，请先解密数据库' }
      }

      // 返回图片目录（所有账号共享）
      return {
        success: true,
        directories: [{ wxid, path: imagesDir }]
      }
    } catch (e) {
      console.error('获取图片目录失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 单个图片解密
   */
  async decryptSingleImage(filePath: string): Promise<{ success: boolean; outputPath?: string; error?: string }> {
    try {
      // 获取密钥
      const xorKeyStr = this.configService.get('imageXorKey')
      const aesKeyStr = this.configService.get('imageAesKey')

      if (!xorKeyStr) {
        return { success: false, error: '请先在设置页面配置图片 XOR 密钥' }
      }

      const xorKey = parseInt(String(xorKeyStr), 16)
      if (isNaN(xorKey)) {
        return { success: false, error: 'XOR 密钥格式错误' }
      }

      if (!fs.existsSync(filePath)) {
        return { success: false, error: '文件不存在' }
      }

      // 获取 dbPath 来计算相对路径
      const dbPath = this.configService.get('dbPath')
      if (!dbPath) {
        return { success: false, error: '请先配置数据库路径' }
      }

      // 找到账号根目录
      const pathParts = dbPath.split(path.sep)
      const lastPart = pathParts[pathParts.length - 1]
      let accountDir: string

      if (lastPart === 'db_storage') {
        accountDir = path.dirname(dbPath)
      } else {
        // 从文件路径中提取账号目录
        const filePathParts = filePath.split(path.sep)
        const dbPathIndex = filePathParts.findIndex((p, i) =>
          i > 0 && filePathParts.slice(0, i).join(path.sep) === dbPath
        )
        if (dbPathIndex > 0) {
          accountDir = filePathParts.slice(0, dbPathIndex + 1).join(path.sep)
        } else {
          // 尝试从文件路径推断
          accountDir = path.dirname(filePath)
          while (accountDir !== path.dirname(accountDir)) {
            if (fs.existsSync(path.join(accountDir, 'db_storage'))) {
              break
            }
            accountDir = path.dirname(accountDir)
          }
        }
      }

      const cachePath = this.getCurrentCachePath()
      const imageOutputDir = path.join(cachePath, 'images')

      // 计算输出路径
      const relativePath = path.relative(accountDir, filePath)
      const outputRelativePath = relativePath.replace(/\.dat$/, '')

      // 解密图片
      const aesKeyBuffer = aesKeyStr ? imageDecryptService.asciiKey16(String(aesKeyStr)) : undefined
      console.log('解密图片:', filePath)
      console.log('XOR Key:', xorKey.toString(16))
      console.log('AES Key String:', aesKeyStr)
      console.log('AES Key Buffer:', aesKeyBuffer?.toString('hex'))
      console.log('图片版本:', imageDecryptService.getDatVersion(filePath))

      const decrypted = imageDecryptService.decryptDatFile(filePath, xorKey, aesKeyBuffer || Buffer.alloc(16))

      // 检测图片格式
      const ext = this.detectImageFormat(decrypted)
      const outputPath = path.join(imageOutputDir, outputRelativePath + ext)

      // 确保输出目录存在
      const outputDir = path.dirname(outputPath)
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true })
      }

      fs.writeFileSync(outputPath, decrypted)

      return { success: true, outputPath }
    } catch (e) {
      console.error('解密单个图片失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 检测图片格式
   */
  private detectImageFormat(data: Buffer): string {
    if (data.length < 4) return '.bin'

    // JPEG: FF D8 FF
    if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) {
      return '.jpg'
    }
    // PNG: 89 50 4E 47
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) {
      return '.png'
    }
    // GIF: 47 49 46 38
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) {
      return '.gif'
    }
    // BMP: 42 4D
    if (data[0] === 0x42 && data[1] === 0x4D) {
      return '.bmp'
    }
    // WebP: 52 49 46 46 ... 57 45 42 50
    if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) {
      if (data.length >= 12 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
        return '.webp'
      }
    }

    return '.bin'
  }

  /**
   * 检查是否有需要更新的数据库（不执行更新，只检查）
   */
  async checkForUpdates(): Promise<{ hasUpdate: boolean; updateCount?: number; error?: string }> {
    try {
      const scanResult = await this.scanDatabases()
      if (!scanResult.success || !scanResult.databases) {
        return { hasUpdate: false, error: scanResult.error }
      }

      const filesToUpdate = scanResult.databases.filter(db => db.needsUpdate)
      return { hasUpdate: filesToUpdate.length > 0, updateCount: filesToUpdate.length }
    } catch (e) {
      return { hasUpdate: false, error: String(e) }
    }
  }

  /**
   * 启用自动更新（文件监听 + 定时检查）
   */
  enableAutoUpdate(intervalSeconds?: number): void {
    // 检查配置是否允许自动更新
    if (!this.configService.get('autoUpdateDatabase')) {
      console.log('[DataManagement] 自动更新配置为关闭，跳过启动')
      return
    }

    // 获取配置的间隔
    const configuredInterval = (this.configService.get('autoUpdateCheckInterval') as number) || 60
    const finalInterval = intervalSeconds || configuredInterval

    if (this.autoUpdateEnabled) {
      this.disableAutoUpdate()
    }

    this.autoUpdateEnabled = true
    this.lastCheckTime = Date.now()

    // 启动文件系统监听（实时检测，立即生效）
    this.startFileWatcher()

    // 启动定时检查（作为备选方案，仅在文件监听失效时使用）
    this.autoUpdateInterval = setInterval(async () => {
      if (this.isUpdating) return

      // 再次检查配置，以防运行时被修改
      if (!this.configService.get('autoUpdateDatabase')) {
        return
      }

      const checkResult = await this.checkForUpdates()
      if (checkResult.hasUpdate) {
        // 通知监听器
        this.updateListeners.forEach(listener => listener(true))
      }
    }, finalInterval * 1000)
  }

  /**
   * 禁用自动更新
   */
  disableAutoUpdate(): void {
    this.autoUpdateEnabled = false

    // 停止文件监听
    if (this.dbWatcher) {
      this.dbWatcher.close()
      this.dbWatcher = null
    }

    // 停止定时检查
    if (this.autoUpdateInterval) {
      clearInterval(this.autoUpdateInterval)
      this.autoUpdateInterval = null
    }

    console.log('[DataManagement] 自动更新已禁用')
  }

  /**
   * 启动文件系统监听
   */
  private startFileWatcher(): void {
    const dbPath = this.configService.get('dbPath')
    if (!dbPath) return

    try {
      // 智能查找 db_storage 目录
      let dbStoragePath: string | null = null

      // 1. 检查 dbPath 本身是否是 db_storage
      if (path.basename(dbPath).toLowerCase() === 'db_storage' && fs.existsSync(dbPath)) {
        dbStoragePath = dbPath
      }
      // 2. 检查 dbPath/db_storage
      else if (fs.existsSync(path.join(dbPath, 'db_storage'))) {
        dbStoragePath = path.join(dbPath, 'db_storage')
      }
      // 3. 检查 dbPath/[wxid]/db_storage（如果配置了 wxid）
      else {
        const myWxid = this.configService.get('myWxid')
        if (myWxid) {
          // 尝试直接路径
          const wxidDbStorage = path.join(dbPath, myWxid, 'db_storage')
          if (fs.existsSync(wxidDbStorage)) {
            dbStoragePath = wxidDbStorage
          } else {
            // 尝试查找匹配的账号目录
            try {
              const entries = fs.readdirSync(dbPath, { withFileTypes: true })
              for (const entry of entries) {
                if (!entry.isDirectory()) continue
                const dirName = entry.name.toLowerCase()
                const wxidLower = myWxid.toLowerCase()
                // 精确匹配或前缀匹配
                if (dirName === wxidLower || dirName.startsWith(wxidLower + '_')) {
                  const candidate = path.join(dbPath, entry.name, 'db_storage')
                  if (fs.existsSync(candidate)) {
                    dbStoragePath = candidate
                    break
                  }
                }
              }
            } catch (e) {
              // 忽略错误
            }
          }
        }
      }

      if (!dbStoragePath || !fs.existsSync(dbStoragePath)) {
        console.warn(`[DataManagement] db_storage 目录不存在 (dbPath: ${dbPath})，跳过文件监听`)
        return
      }

      // 使用防抖，避免频繁触发
      let debounceTimer: NodeJS.Timeout | null = null

      this.dbWatcher = fs.watch(dbStoragePath, { recursive: true }, async (eventType, filename) => {
        if (!filename || this.isUpdating) return

        // 检查配置
        if (!this.configService.get('autoUpdateDatabase')) return

        // 只监听 .db 文件
        if (!filename.toLowerCase().endsWith('.db')) return

        // 防抖：配置的毫秒数内的多次变化只触发一次
        const debounceTime = (this.configService.get('autoUpdateDebounceTime') as number) || 500

        if (debounceTimer) {
          clearTimeout(debounceTimer)
        }

        debounceTimer = setTimeout(async () => {
          // console.log(`[DataManagement] 检测到数据库文件变化: ${filename}`)

          // 检查更新频率限制
          const now = Date.now()
          const timeSinceLastUpdate = now - this.lastUpdateTime
          const MIN_UPDATE_INTERVAL = (this.configService.get('autoUpdateMinInterval') as number) || 1000

          if (timeSinceLastUpdate < MIN_UPDATE_INTERVAL) {
            // 如果距离上次更新不足最小间隔，延迟到满足间隔
            const delay = MIN_UPDATE_INTERVAL - timeSinceLastUpdate
            // console.log(`[DataManagement] 更新过于频繁，延迟 ${delay}ms 后执行`)
            setTimeout(() => {
              this.triggerUpdate()
            }, delay)
            return
          }

          // 检查更新队列长度，避免堆积过多
          if (this.pendingUpdateCount > 3) {
            console.warn(`[DataManagement] 更新队列过长（${this.pendingUpdateCount}），跳过本次更新请求`)
            return
          }

          // 等待文件写入完成（微信写入数据库可能需要一些时间）
          // 延迟1秒，确保文件完全写入完成
          await new Promise(resolve => setTimeout(resolve, 1000))

          // 触发更新
          this.triggerUpdate()
        }, debounceTime)
      })
    } catch (e) {
      console.error('[DataManagement] 启动文件监听失败:', e)
    }
  }

  /**
   * 触发更新（带频率限制和队列管理）
   */
  private triggerUpdate(): void {
    // 检查配置
    if (!this.configService.get('autoUpdateDatabase')) {
      return
    }

    // 获取最小更新间隔配置
    const MIN_UPDATE_INTERVAL = (this.configService.get('autoUpdateMinInterval') as number) || 1000

    // 如果正在更新，增加待处理计数
    if (this.isUpdating) {
      this.pendingUpdateCount++
      console.log(`[DataManagement] 更新进行中，待处理请求数: ${this.pendingUpdateCount}`)
      return
    }

    // 检查更新频率限制
    const now = Date.now()
    const timeSinceLastUpdate = now - this.lastUpdateTime

    if (timeSinceLastUpdate < MIN_UPDATE_INTERVAL) {
      // 延迟到满足间隔
      const delay = MIN_UPDATE_INTERVAL - timeSinceLastUpdate
      setTimeout(() => {
        this.triggerUpdate()
      }, delay)
      return
    }

    // 通知监听器触发更新
    this.updateListeners.forEach(listener => listener(true))
  }

  /**
   * 添加更新监听器
   */
  onUpdateAvailable(listener: (hasUpdate: boolean) => void): () => void {
    this.updateListeners.add(listener)
    return () => {
      this.updateListeners.delete(listener)
    }
  }

  /**
   * 自动执行增量更新（如果检测到更新）
   * @param silent 是否静默更新（不显示进度）
   */
  async autoIncrementalUpdate(silent: boolean = false): Promise<{ success: boolean; updated: boolean; error?: string }> {
    // 检查配置
    if (!this.configService.get('autoUpdateDatabase')) {
      return { success: true, updated: false }
    }

    if (this.isUpdating) {
      // 如果正在更新，返回待处理状态
      this.pendingUpdateCount++
      return { success: false, updated: false, error: '正在更新中，请稍候' }
    }

    // 检查更新频率限制
    const now = Date.now()
    const timeSinceLastUpdate = now - this.lastUpdateTime
    const MIN_UPDATE_INTERVAL = (this.configService.get('autoUpdateMinInterval') as number) || 1000

    if (timeSinceLastUpdate < MIN_UPDATE_INTERVAL) {
      const remainingTime = MIN_UPDATE_INTERVAL - timeSinceLastUpdate
      return { success: false, updated: false, error: `更新过于频繁，请 ${Math.ceil(remainingTime / 1000)} 秒后重试` }
    }

    const checkResult = await this.checkForUpdates()
    if (!checkResult.hasUpdate) {
      return { success: true, updated: false }
    }

    const time = new Date().toLocaleTimeString()
    console.log(`[${time}] [自动更新] 检测到数据库更新, 共有 ${checkResult.updateCount} 个文件需要动态同步...`)

    this.isUpdating = true
    this.lastUpdateTime = now
    const startTime = now

    try {
      // 检查聊天窗口是否打开（如果打开，可能需要用户手动刷新）
      // 但为了自动更新，我们允许在聊天窗口打开时也更新
      // 因为 chatService.close() 会关闭连接，更新后需要重新连接

      // 设置更新超时（最多30秒）
      const updatePromise = this.incrementalUpdate(silent)
      const timeoutPromise = new Promise<{ success: boolean; successCount?: number; failCount?: number; error?: string }>((resolve) => {
        setTimeout(() => {
          resolve({ success: false, error: '更新超时（超过30秒）' })
        }, 30000)
      })

      const result = await Promise.race([updatePromise, timeoutPromise])
      const updateDuration = Date.now() - startTime

      this.isUpdating = false
      this.pendingUpdateCount = 0 // 重置待处理计数

      if (result.success) {
        // 通知监听器更新完成
        // const time = new Date().toLocaleTimeString()
        // console.log(`[${time}] [自动更新] 增量同步完成, 成功更新 ${result.successCount} 个文件`) // 减少日志
        this.updateListeners.forEach(listener => listener(false))
        return { success: true, updated: result.successCount! > 0 }
      } else {
        const time = new Date().toLocaleTimeString()
        console.error(`[${time}] [自动更新] 同步进程失败: ${result.error}`)
        return { success: false, updated: false, error: result.error }
      }
    } catch (e) {
      this.isUpdating = false
      this.pendingUpdateCount = 0
      const time = new Date().toLocaleTimeString()
      console.error(`[${time}] [自动更新] 发生严重异常:`, e)
      return { success: false, updated: false, error: String(e) }
    }
  }
}

export const dataManagementService = new DataManagementService()
