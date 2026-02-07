import { join } from 'path'
import { existsSync, rmSync, readdirSync, statSync } from 'fs'
import { app } from 'electron'
import { ConfigService } from './config'

export class CacheService {
  constructor(private configService: ConfigService) {}

  /**
   * 获取有效的缓存路径
   * - 如果配置了 cachePath，使用配置的路径
   * - 开发环境：使用文档目录
   * - 生产环境：
   *   - C 盘安装：使用文档目录
   *   - 其他盘安装：使用软件安装目录
   */
  private getEffectiveCachePath(): string {
    const cachePath = this.configService.get('cachePath')
    if (cachePath) return cachePath
    
    // 开发环境使用文档目录
    if (process.env.VITE_DEV_SERVER_URL) {
      const documentsPath = app.getPath('documents')
      return join(documentsPath, 'CipherTalkData')
    }
    
    // 生产环境
    const exePath = app.getPath('exe')
    const installDir = require('path').dirname(exePath)
    
    // 检查是否安装在 C 盘
    const isOnCDrive = /^[cC]:/i.test(installDir) || installDir.startsWith('\\\\')
    
    if (isOnCDrive) {
      const documentsPath = app.getPath('documents')
      return join(documentsPath, 'CipherTalkData')
    }
    
    return join(installDir, 'CipherTalkData')
  }

  /**
   * 获取图片缓存目录（兼容旧的 CipherTalk/Images 路径）
   */
  private getImagesCachePaths(): string[] {
    const cachePath = this.configService.get('cachePath')
    const documentsPath = app.getPath('documents')
    
    const paths: string[] = []
    
    // 如果配置了自定义路径
    if (cachePath) {
      paths.push(join(cachePath, 'Images'))
      paths.push(join(cachePath, 'images'))
    }
    
    // 添加默认路径
    const defaultPath = this.getEffectiveCachePath()
    paths.push(join(defaultPath, 'Images'))
    paths.push(join(defaultPath, 'images'))
    
    // 兼容旧的 CipherTalk/Images 路径
    paths.push(join(documentsPath, 'CipherTalk', 'Images'))
    
    return Array.from(new Set(paths)) // 去重
  }

  /**
   * 清除图片缓存
   */
  async clearImages(): Promise<{ success: boolean; error?: string }> {
    try {
      const imagePaths = this.getImagesCachePaths()
      
      for (const imagesDir of imagePaths) {
        if (existsSync(imagesDir)) {
          rmSync(imagesDir, { recursive: true, force: true })
        }
      }

      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 清除表情包缓存
   */
  async clearEmojis(): Promise<{ success: boolean; error?: string }> {
    try {
      const cachePath = this.getEffectiveCachePath()
      const documentsPath = app.getPath('documents')
      const emojiPaths = [
        join(cachePath, 'Emojis'),
        join(documentsPath, 'CipherTalk', 'Emojis'),
      ]
      for (const emojiPath of emojiPaths) {
        if (existsSync(emojiPath)) {
          rmSync(emojiPath, { recursive: true, force: true })
        }
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 仅清除数据库缓存（解密后的 .db 文件），不删除图片、表情包、配置等
   */
  async clearDatabases(): Promise<{ success: boolean; error?: string }> {
    try {
      const cachePath = this.getEffectiveCachePath()
      if (!existsSync(cachePath)) {
        return { success: true }
      }

      const wxid = this.configService.get('myWxid')
      if (wxid) {
        const possibleFolderNames = [
          wxid,
          (wxid as string).replace('wxid_', ''),
          (wxid as string).split('_').slice(0, 2).join('_'),
        ]
        for (const folderName of possibleFolderNames) {
          const wxidFolderPath = join(cachePath, folderName)
          if (existsSync(wxidFolderPath)) {
            this.clearDbFilesInFolder(wxidFolderPath)
            break
          }
        }
      }

      const files = readdirSync(cachePath)
      for (const file of files) {
        const filePath = join(cachePath, file)
        const stat = statSync(filePath)
        if (stat.isFile() && file.endsWith('.db')) {
          rmSync(filePath, { force: true })
        }
      }

      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 清除所有缓存
   */
  async clearAll(): Promise<{ success: boolean; error?: string }> {
    try {
      const cachePath = this.getEffectiveCachePath()

      if (!existsSync(cachePath)) {
        // 同时检查旧的 CipherTalk 目录
        const documentsPath = app.getPath('documents')
        const oldCipherTalkDir = join(documentsPath, 'CipherTalk')
        if (existsSync(oldCipherTalkDir)) {
          rmSync(oldCipherTalkDir, { recursive: true, force: true })
        }
        return { success: true }
      }

      // 清除指定的缓存目录
      const dirsToRemove = ['images', 'Images', 'Emojis', 'logs']
      
      for (const dir of dirsToRemove) {
        const dirPath = join(cachePath, dir)
        if (existsSync(dirPath)) {
          rmSync(dirPath, { recursive: true, force: true })
        }
      }

      // 清除数据库缓存
      await this.clearDatabases()

      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 清除文件夹中的.db文件
   */
  private clearDbFilesInFolder(folderPath: string): void {
    if (!existsSync(folderPath)) {
      return
    }

    try {
      const files = readdirSync(folderPath)
      
      for (const file of files) {
        const filePath = join(folderPath, file)
        const stat = statSync(filePath)
        
        if (stat.isDirectory()) {
          // 递归清除子目录中的.db文件
          this.clearDbFilesInFolder(filePath)
        } else if (stat.isFile() && file.endsWith('.db')) {
          rmSync(filePath, { force: true })
        }
      }
    } catch (e) {
      // 忽略权限错误等
    }
  }

  /**
   * 清除配置
   */
  async clearConfig(): Promise<{ success: boolean; error?: string }> {
    try {
      // 清除所有配置项
      const configKeys = [
        'decryptKey',
        'dbPath', 
        'myWxid',
        'cachePath',
        'imageXorKey',
        'imageAesKey',
        'exportPath'
      ]

      for (const key of configKeys) {
        this.configService.set(key as any, '' as any)
      }

      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取缓存大小
   */
  async getCacheSize(): Promise<{ 
    success: boolean; 
    error?: string;
    size?: {
      images: number
      emojis: number
      databases: number
      logs: number
      total: number
    }
  }> {
    try {
      const cachePath = this.getEffectiveCachePath()
      const documentsPath = app.getPath('documents')

      // 计算图片大小（包含所有可能的路径）
      let imagesSize = 0
      for (const imgPath of this.getImagesCachePaths()) {
        imagesSize += this.getFolderSize(imgPath)
      }
      
      // 计算表情包大小
      let emojisSize = this.getFolderSize(join(cachePath, 'Emojis'))
      // 也检查旧的 CipherTalk 目录
      const oldEmojiPath = join(documentsPath, 'CipherTalk', 'Emojis')
      emojisSize += this.getFolderSize(oldEmojiPath)
      
      // 计算数据库大小
      let databasesSize = this.getDatabaseFilesSize(cachePath)
      // 也检查旧的 CipherTalk 目录
      const oldCipherTalkDir = join(documentsPath, 'CipherTalk')
      if (existsSync(oldCipherTalkDir)) {
        databasesSize += this.getDatabaseFilesSize(oldCipherTalkDir)
      }
      
      // 计算日志大小
      const logsSize = this.getFolderSize(join(cachePath, 'logs'))

      const size = {
        images: imagesSize,
        emojis: emojisSize,
        databases: databasesSize,
        logs: logsSize,
        total: imagesSize + emojisSize + databasesSize + logsSize
      }

      return { success: true, size }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取文件夹大小
   */
  private getFolderSize(folderPath: string): number {
    if (!existsSync(folderPath)) {
      return 0
    }

    let totalSize = 0
    
    try {
      const files = readdirSync(folderPath)
      
      for (const file of files) {
        const filePath = join(folderPath, file)
        const stat = statSync(filePath)
        
        if (stat.isDirectory()) {
          totalSize += this.getFolderSize(filePath)
        } else {
          totalSize += stat.size
        }
      }
    } catch (e) {
      // 忽略权限错误等
    }

    return totalSize
  }

  /**
   * 获取数据库文件大小
   */
  private getDatabaseFilesSize(cachePath: string): number {
    if (!existsSync(cachePath)) {
      return 0
    }

    let totalSize = 0
    
    try {
      // 获取配置的wxid
      const wxid = this.configService.get('myWxid')
      
      if (wxid) {
        // 尝试多种可能的文件夹名称
        const possibleFolderNames = [
          wxid, // 完整的wxid
          wxid.replace('wxid_', ''), // 去掉wxid_前缀
          wxid.split('_').slice(0, 2).join('_'), // 取前两部分，如 wxid_7r9dov5f7mse12
        ]
        
        for (const folderName of possibleFolderNames) {
          const wxidFolderPath = join(cachePath, folderName)
          if (existsSync(wxidFolderPath)) {
            // 统计整个文件夹的大小
            totalSize += this.getFolderSize(wxidFolderPath)
            break // 找到一个就停止
          }
        }
      }
      
      // 同时检查根目录下的.db文件
      const files = readdirSync(cachePath)
      for (const file of files) {
        const filePath = join(cachePath, file)
        const stat = statSync(filePath)
        
        if (stat.isFile() && file.endsWith('.db')) {
          totalSize += stat.size
        }
      }
    } catch (e) {
      // 忽略权限错误等
    }

    return totalSize
  }

  /**
   * 判断是否是wxid文件夹
   */
  private isWxidFolder(folderName: string): boolean {
    // wxid通常以wxid_开头，或者是其他微信ID格式
    // 也可能是纯字母数字组合，长度通常在10-30之间
    return (
      folderName.startsWith('wxid_') || 
      /^[a-zA-Z0-9_-]{8,30}$/.test(folderName)
    )
  }

  /**
   * 递归查找 .db 文件
   */
  private findDbFilesRecursive(dirPath: string): number {
    if (!existsSync(dirPath)) {
      return 0
    }

    let totalSize = 0
    
    try {
      const files = readdirSync(dirPath)
      
      for (const file of files) {
        const filePath = join(dirPath, file)
        const stat = statSync(filePath)
        
        if (stat.isDirectory()) {
          // 递归查找子目录
          totalSize += this.findDbFilesRecursive(filePath)
        } else if (stat.isFile() && file.endsWith('.db')) {
          // 累加 .db 文件大小
          totalSize += stat.size
        }
      }
    } catch (e) {
      // 忽略权限错误等
    }

    return totalSize
  }
}