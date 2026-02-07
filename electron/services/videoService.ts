import { dirname, join } from 'path'
import { existsSync, readdirSync, statSync, readFileSync } from 'fs'
import { ConfigService } from './config'
import Database from 'better-sqlite3'
import { app } from 'electron'

export interface VideoInfo {
  videoUrl?: string       // 视频文件路径（用�?readFile�?
  coverUrl?: string       // 封面 data URL
  thumbUrl?: string       // 缩略�?data URL
  exists: boolean
}

class VideoService {
  private configService: ConfigService

  constructor() {
    this.configService = new ConfigService()
  }

  /**
   * 获取数据库根目录
   */
  private getDbPath(): string {
    return this.configService.get('dbPath') || ''
  }

  /**
   * 获取当前用户的wxid
   */
  private getMyWxid(): string {
    return this.configService.get('myWxid') || ''
  }

  /**
   * 获取缓存目录（解密后的数据库存放位置�?   */
  private getCachePath(): string {
    const cachePath = this.configService.get('cachePath')
    if (cachePath) return cachePath
    return this.getDefaultCachePath()
  }

  private getDefaultCachePath(): string {
    if (process.env.VITE_DEV_SERVER_URL) {
      const documentsPath = app.getPath('documents')
      return join(documentsPath, 'CipherTalkData')
    }

    const exePath = app.getPath('exe')
    const installDir = dirname(exePath)

    const isOnCDrive = /^[cC]:/i.test(installDir) || installDir.startsWith('\\')
    if (isOnCDrive) {
      const documentsPath = app.getPath('documents')
      return join(documentsPath, 'CipherTalkData')
    }

    return join(installDir, 'CipherTalkData')
  }

  /**
   * 清理 wxid 目录名（去掉后缀�?
   */
  private cleanWxid(wxid: string): string {
    const trimmed = wxid.trim()
    if (!trimmed) return trimmed

    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[^_]+)/i)
      if (match) return match[1]
      return trimmed
    }

    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
    if (suffixMatch) return suffixMatch[1]

    return trimmed
  }

  /**
   * �?video_hardlink_info_v4 表查询视频文件名
   */
  private queryVideoFileName(md5: string): string | undefined {
    const cachePath = this.getCachePath()
    const wxid = this.getMyWxid()
    const cleanedWxid = this.cleanWxid(wxid)
    const dbPath = this.getDbPath()
    
    if (!cachePath || !wxid) return undefined

    // hardlink.db 可能在多个位�?
    const possiblePaths = new Set<string>([
      join(cachePath, cleanedWxid, 'hardlink.db'),
      join(cachePath, wxid, 'hardlink.db'),
      join(cachePath, 'hardlink.db'),
      join(cachePath, 'databases', cleanedWxid, 'hardlink.db'),
      join(cachePath, 'databases', wxid, 'hardlink.db')
    ])

    if (dbPath) {
      const baseCandidates = new Set<string>([
        dbPath,
        join(dbPath, wxid),
        join(dbPath, cleanedWxid)
      ])
      for (const base of baseCandidates) {
        possiblePaths.add(join(base, 'hardlink.db'))
        possiblePaths.add(join(base, 'msg', 'hardlink.db'))
      }
    }
    
    let hardlinkDbPath: string | undefined
    for (const p of possiblePaths) {
      if (existsSync(p)) {
        hardlinkDbPath = p
        break
      }
    }
    
    if (!hardlinkDbPath) return undefined

    try {
      const db = new Database(hardlinkDbPath, { readonly: true })
      
      // 查询视频文件�?
      const row = db.prepare(`
        SELECT file_name, md5 FROM video_hardlink_info_v4 
        WHERE md5 = ? 
        LIMIT 1
      `).get(md5) as { file_name: string; md5: string } | undefined

      db.close()

      if (row?.file_name) {
        // 提取不带扩展名的文件名作�?MD5
        return row.file_name.replace(/\.[^.]+$/, '')
      }
    } catch {
      // 忽略错误
    }

    return undefined
  }

  /**
   * 将文件转换为 data URL
   */
  private fileToDataUrl(filePath: string, mimeType: string): string | undefined {
    try {
      if (!existsSync(filePath)) return undefined
      const buffer = readFileSync(filePath)
      return `data:${mimeType};base64,${buffer.toString('base64')}`
    } catch {
      return undefined
    }
  }

  /**
   * 根据视频MD5获取视频文件信息
   * 视频存放�? {数据库根目录}/{用户wxid}/msg/video/{年月}/
   * 文件命名: {md5}.mp4, {md5}.jpg, {md5}_thumb.jpg
   */
  getVideoInfo(videoMd5: string): VideoInfo {
    const dbPath = this.getDbPath()
    const wxid = this.getMyWxid()

    if (!dbPath || !wxid || !videoMd5) {
      return { exists: false }
    }

    // 先尝试从数据库查询真正的视频文件�?
    const realVideoMd5 = this.queryVideoFileName(videoMd5) || videoMd5

    const videoBaseDir = join(dbPath, wxid, 'msg', 'video')
    
    if (!existsSync(videoBaseDir)) {
      return { exists: false }
    }

    // 遍历年月目录查找视频文件
    try {
      const allDirs = readdirSync(videoBaseDir)
      
      // 支持多种目录格式: YYYY-MM, YYYYMM, 或其�?
      const yearMonthDirs = allDirs
        .filter(dir => {
          const dirPath = join(videoBaseDir, dir)
          return statSync(dirPath).isDirectory()
        })
        .sort((a, b) => b.localeCompare(a)) // 从最新的目录开始查�?

      for (const yearMonth of yearMonthDirs) {
        const dirPath = join(videoBaseDir, yearMonth)

        const videoPath = join(dirPath, `${realVideoMd5}.mp4`)
        const coverPath = join(dirPath, `${realVideoMd5}.jpg`)
        const thumbPath = join(dirPath, `${realVideoMd5}_thumb.jpg`)

        // 检查视频文件是否存�?
        if (existsSync(videoPath)) {
          return {
            videoUrl: `file:///${videoPath.replace(/\\/g, '/')}`,  // 转换为 file:// 协议
            coverUrl: this.fileToDataUrl(coverPath, 'image/jpeg'),
            thumbUrl: this.fileToDataUrl(thumbPath, 'image/jpeg'),
            exists: true
          }
        }
      }
    } catch {
      // 忽略错误
    }

    return { exists: false }
  }

  /**
   * 根据消息内容解析视频MD5
   */
  parseVideoMd5(content: string): string | undefined {
    if (!content) return undefined

    try {
      // 尝试从XML中提取md5
      // 格式可能�? <md5>xxx</md5> �?md5="xxx"
      const md5Match = /<md5>([a-fA-F0-9]+)<\/md5>/i.exec(content)
      if (md5Match) {
        return md5Match[1].toLowerCase()
      }

      const attrMatch = /md5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content)
      if (attrMatch) {
        return attrMatch[1].toLowerCase()
      }

      // 尝试从videomsg标签中提�?
      const videoMsgMatch = /<videomsg[^>]*md5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content)
      if (videoMsgMatch) {
        return videoMsgMatch[1].toLowerCase()
      }
    } catch (e) {
      console.error('解析视频MD5失败:', e)
    }

    return undefined
  }
}

export const videoService = new VideoService()
