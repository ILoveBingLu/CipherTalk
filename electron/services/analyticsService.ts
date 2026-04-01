import { ConfigService } from './config'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

export interface ChatStatistics {
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

export interface TimeDistribution {
  hourlyDistribution: Record<number, number>
  weekdayDistribution: Record<number, number>
  monthlyDistribution: Record<string, number>
}

export interface ContactRanking {
  username: string
  displayName: string
  avatarUrl?: string
  messageCount: number
  sentCount: number
  receivedCount: number
  lastMessageTime: number | null
}

type TimeRangeFilter = {
  startTimeSec?: number
  endTimeSec?: number
}

class AnalyticsService {
  private configService: ConfigService
  private messageDbCache: Map<string, Database.Database> = new Map()
  private myRowIdCache: Map<string, number | null> = new Map()

  constructor() {
    this.configService = new ConfigService()
  }

  private getDecryptedDbDir(): string {
    const cachePath = this.configService.get('cachePath')
    if (cachePath) return cachePath
    
    // 开发环境使用文档目录
    if (process.env.VITE_DEV_SERVER_URL) {
      const documentsPath = app.getPath('documents')
      return path.join(documentsPath, 'CipherTalkData')
    }
    
    // 生产环境
    const exePath = app.getPath('exe')
    const installDir = path.dirname(exePath)
    
    // 检查是否安装在 C 盘
    const isOnCDrive = /^[cC]:/i.test(installDir) || installDir.startsWith('\\')
    
    if (isOnCDrive) {
      const documentsPath = app.getPath('documents')
      return path.join(documentsPath, 'CipherTalkData')
    }
    
    return path.join(installDir, 'CipherTalkData')
  }

  private cleanAccountDirName(name: string): string {
    const trimmed = name.trim()
    if (!trimmed) return trimmed
    
    // wxid_ 开头的标准格式: wxid_xxx_yyyy -> wxid_xxx
    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[a-zA-Z0-9]+)/i)
      if (match) return match[1]
      return trimmed
    }
    
    // 自定义微信号格式: xxx_yyyy (4位后缀) -> xxx
    // 例如: xiangchao1985_b29d -> xiangchao1985
    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
    if (suffixMatch) return suffixMatch[1]
    
    return trimmed
  }

  /**
   * 查找账号对应的实际目录名
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
        
        // 前缀匹配: 目录名以 wxid 或 cleanedWxid 开头
        if (dirNameLower.startsWith(wxidLower + '_') || dirNameLower.startsWith(cleanedWxidLower + '_')) {
          return dirName
        }
        
        // 反向前缀匹配: wxid 或 cleanedWxid 以目录名开头
        if (wxidLower.startsWith(dirNameLower + '_') || cleanedWxidLower.startsWith(dirNameLower + '_')) {
          return dirName
        }
        
        // 清理目录名后匹配
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

  private findMessageDbFiles(dbDir: string): string[] {
    try {
      const files = fs.readdirSync(dbDir)
      return files.filter(f => {
        const lower = f.toLowerCase()
        return (lower.startsWith('msg') || lower.startsWith('message')) && lower.endsWith('.db')
      }).map(f => path.join(dbDir, f))
    } catch {
      return []
    }
  }

  private getMessageDb(dbPath: string): Database.Database | null {
    if (this.messageDbCache.has(dbPath)) {
      return this.messageDbCache.get(dbPath)!
    }
    try {
      const db = new Database(dbPath, { readonly: true })
      this.messageDbCache.set(dbPath, db)
      return db
    } catch (e) {
      return null
    }
  }

  private hasName2IdTable(db: Database.Database): boolean {
    try {
      const result = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = 'Name2Id'"
      ).get()
      return !!result
    } catch {
      return false
    }
  }

  private getMyRowId(db: Database.Database, dbPath: string, myWxid: string): number | null {
    const cacheKey = `${dbPath}:${myWxid}`
    if (this.myRowIdCache.has(cacheKey)) {
      return this.myRowIdCache.get(cacheKey)!
    }
    try {
      // 先尝试原始 wxid
      let row = db.prepare('SELECT rowid FROM Name2Id WHERE user_name = ?').get(myWxid) as any
      
      // 如果没找到，尝试清理后的 wxid
      if (!row) {
        const cleanedWxid = this.cleanAccountDirName(myWxid)
        if (cleanedWxid !== myWxid) {
          row = db.prepare('SELECT rowid FROM Name2Id WHERE user_name = ?').get(cleanedWxid) as any
        }
      }
      
      const rowId = row?.rowid ?? null
      this.myRowIdCache.set(cacheKey, rowId)
      return rowId
    } catch {
      this.myRowIdCache.set(cacheKey, null)
      return null
    }
  }

  private toTimestampSeconds(value?: number | null): number | undefined {
    if (!value || !Number.isFinite(value) || value <= 0) return undefined
    return value >= 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value)
  }

  private normalizeTimeRange(startTime?: number, endTime?: number): TimeRangeFilter {
    const startTimeSec = this.toTimestampSeconds(startTime)
    const endTimeSec = this.toTimestampSeconds(endTime)

    if (startTimeSec && endTimeSec && startTimeSec > endTimeSec) {
      return {
        startTimeSec: endTimeSec,
        endTimeSec: startTimeSec
      }
    }

    return { startTimeSec, endTimeSec }
  }

  private buildTimeWhereClause(range: TimeRangeFilter, columnName: string = 'create_time'): string {
    const clauses: string[] = []

    if (range.startTimeSec) {
      clauses.push(`${columnName} >= ${range.startTimeSec}`)
    }

    if (range.endTimeSec) {
      clauses.push(`${columnName} <= ${range.endTimeSec}`)
    }

    return clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
  }

  /**
   * 判断是否为私聊会话（排除群聊、公众号、系统账号等）
   */
  private isPrivateSession(username: string, cleanedWxid: string): boolean {
    if (!username) return false
    
    // 排除自己
    if (username.toLowerCase() === cleanedWxid.toLowerCase()) return false
    
    // 排除群聊
    if (username.includes('@chatroom')) return false
    
    // 排除文件传输助手
    if (username === 'filehelper') return false
    
    // 排除公众号
    if (username.startsWith('gh_')) return false

    // 排除系统账号
    const excludeList = [
      'weixin', 'qqmail', 'fmessage', 'medianote', 'floatbottle',
      'newsapp', 'brandsessionholder', 'brandservicesessionholder',
      'notifymessage', 'opencustomerservicemsg', 'notification_messages',
      'userexperience_alarm', 'helper_folders', 'placeholder_foldgroup',
      '@helper_folders', '@placeholder_foldgroup'
    ]

    for (const prefix of excludeList) {
      if (username.startsWith(prefix) || username === prefix) return false
    }

    // 排除客服和 OpenIM
    if (username.includes('@kefu.openim') || username.includes('@openim')) return false
    if (username.includes('service_')) return false

    return true
  }

  /**
   * 获取私聊会话列表
   */
  private getPrivateSessions(sessionDb: Database.Database, cleanedWxid: string): string[] {
    const sessions = sessionDb.prepare(`
      SELECT username FROM SessionTable
    `).all() as { username: string }[]
    
    return sessions
      .map(s => s.username)
      .filter(u => this.isPrivateSession(u, cleanedWxid))
  }


  async getOverallStatistics(startTime?: number, endTime?: number): Promise<{ success: boolean; data?: ChatStatistics; error?: string }> {
    try {
      const wxid = this.configService.get('myWxid')
      if (!wxid) {
        return { success: false, error: '未配置微信ID' }
      }

      const baseDir = this.getDecryptedDbDir()
      const accountDir = this.findAccountDir(baseDir, wxid)
      
      if (!accountDir) {
        return { success: false, error: `未找到账号 ${wxid} 的数据库目录` }
      }

      const cleanedWxid = this.cleanAccountDirName(wxid)
      const dbDir = path.join(baseDir, accountDir)

      const dbFiles = this.findMessageDbFiles(dbDir)
      
      if (dbFiles.length === 0) {
        return { success: false, error: '未找到消息数据库' }
      }

      // 获取私聊会话列表（排除群聊、公众号等）
      const sessionDbPath = path.join(dbDir, 'session.db')
      if (!fs.existsSync(sessionDbPath)) {
        return { success: false, error: '未找到 session.db' }
      }

      const sessionDb = new Database(sessionDbPath, { readonly: true })
      const privateUsernames = this.getPrivateSessions(sessionDb, cleanedWxid)
      sessionDb.close()

      const crypto = require('crypto')
      const getTableHash = (username: string) => {
        return crypto.createHash('md5').update(username).digest('hex')
      }
      const timeRange = this.normalizeTimeRange(startTime, endTime)
      const timeWhere = this.buildTimeWhereClause(timeRange)

      // 构建私聊表名的 hash 集合
      const privateTableHashes = new Set(privateUsernames.map(u => getTableHash(u)))

      let totalMessages = 0
      let textMessages = 0
      let imageMessages = 0
      let voiceMessages = 0
      let videoMessages = 0
      let emojiMessages = 0
      let otherMessages = 0
      let sentMessages = 0
      let receivedMessages = 0
      let firstMessageTime: number | null = null
      let lastMessageTime: number | null = null
      const messageTypeCounts: Record<number, number> = {}
      // 用 Set 收集所有活跃日期，避免重复计算
      const activeDatesSet = new Set<string>()

      for (const dbPath of dbFiles) {
        const db = this.getMessageDb(dbPath)
        if (!db) continue

        const hasName2Id = this.hasName2IdTable(db)
        const myRowId = hasName2Id ? this.getMyRowId(db, dbPath, cleanedWxid) : null

        const tables = db.prepare(`
          SELECT name FROM sqlite_master 
          WHERE type='table' AND name LIKE 'Msg_%'
        `).all() as { name: string }[]

        for (const { name: tableName } of tables) {
          // 检查表名是否属于私聊会话
          const tableHash = tableName.replace('Msg_', '')
          if (!privateTableHashes.has(tableHash)) {
            continue // 跳过群聊和其他非私聊表
          }

          try {
            let statsQuery: string
            if (hasName2Id && myRowId !== null) {
              statsQuery = `
                SELECT 
                  COUNT(*) as total,
                  SUM(CASE WHEN local_type = 1 OR local_type = 244813135921 THEN 1 ELSE 0 END) as text_count,
                  SUM(CASE WHEN local_type = 3 THEN 1 ELSE 0 END) as image_count,
                  SUM(CASE WHEN local_type = 34 THEN 1 ELSE 0 END) as voice_count,
                  SUM(CASE WHEN local_type = 43 THEN 1 ELSE 0 END) as video_count,
                  SUM(CASE WHEN local_type = 47 THEN 1 ELSE 0 END) as emoji_count,
                  SUM(CASE WHEN real_sender_id = ${myRowId} THEN 1 ELSE 0 END) as sent_count,
                  SUM(CASE WHEN real_sender_id != ${myRowId} THEN 1 ELSE 0 END) as received_count,
                  MIN(create_time) as first_time,
                  MAX(create_time) as last_time
                FROM "${tableName}"${timeWhere}
              `
            } else {
              statsQuery = `
                SELECT 
                  COUNT(*) as total,
                  SUM(CASE WHEN local_type = 1 OR local_type = 244813135921 THEN 1 ELSE 0 END) as text_count,
                  SUM(CASE WHEN local_type = 3 THEN 1 ELSE 0 END) as image_count,
                  SUM(CASE WHEN local_type = 34 THEN 1 ELSE 0 END) as voice_count,
                  SUM(CASE WHEN local_type = 43 THEN 1 ELSE 0 END) as video_count,
                  SUM(CASE WHEN local_type = 47 THEN 1 ELSE 0 END) as emoji_count,
                  SUM(CASE WHEN is_send = 1 THEN 1 ELSE 0 END) as sent_count,
                  SUM(CASE WHEN is_send = 0 OR is_send IS NULL THEN 1 ELSE 0 END) as received_count,
                  MIN(create_time) as first_time,
                  MAX(create_time) as last_time
                FROM "${tableName}"${timeWhere}
              `
            }

            const stats = db.prepare(statsQuery).get() as any

            if (stats && stats.total > 0) {
              totalMessages += stats.total
              textMessages += stats.text_count || 0
              imageMessages += stats.image_count || 0
              voiceMessages += stats.voice_count || 0
              videoMessages += stats.video_count || 0
              emojiMessages += stats.emoji_count || 0
              sentMessages += stats.sent_count || 0
              receivedMessages += stats.received_count || 0

              if (stats.first_time) {
                if (!firstMessageTime || stats.first_time < firstMessageTime) {
                  firstMessageTime = stats.first_time
                }
              }
              if (stats.last_time) {
                if (!lastMessageTime || stats.last_time > lastMessageTime) {
                  lastMessageTime = stats.last_time
                }
              }

              // 收集该会话的所有活跃日期
              const dates = db.prepare(`
                SELECT DISTINCT date(create_time, 'unixepoch', 'localtime') as day
                FROM "${tableName}"${timeWhere}
              `).all() as { day: string }[]
              
              for (const { day } of dates) {
                if (day) activeDatesSet.add(day)
              }

              const typeCounts = db.prepare(`
                SELECT local_type, COUNT(*) as count
                FROM "${tableName}"
                ${timeWhere ? timeWhere : ''}
                GROUP BY local_type
              `).all() as { local_type: number; count: number }[]

              for (const { local_type, count } of typeCounts) {
                messageTypeCounts[local_type] = (messageTypeCounts[local_type] || 0) + count
              }
            }
          } catch (e) {
            // skip
          }
        }
      }

      otherMessages = totalMessages - textMessages - imageMessages - voiceMessages - videoMessages - emojiMessages

      return {
        success: true,
        data: {
          totalMessages,
          textMessages,
          imageMessages,
          voiceMessages,
          videoMessages,
          emojiMessages,
          otherMessages: Math.max(0, otherMessages),
          sentMessages,
          receivedMessages,
          firstMessageTime,
          lastMessageTime,
          activeDays: activeDatesSet.size,
          messageTypeCounts
        }
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }


  async getContactRankings(limit: number = 20, startTime?: number, endTime?: number): Promise<{ success: boolean; data?: ContactRanking[]; error?: string }> {
    try {
      const wxid = this.configService.get('myWxid')
      if (!wxid) {
        return { success: false, error: '未配置微信ID' }
      }

      const baseDir = this.getDecryptedDbDir()
      const accountDir = this.findAccountDir(baseDir, wxid)
      
      if (!accountDir) {
        return { success: false, error: `未找到账号 ${wxid} 的数据库目录` }
      }

      const cleanedWxid = this.cleanAccountDirName(wxid)
      const dbDir = path.join(baseDir, accountDir)

      const dbFiles = this.findMessageDbFiles(dbDir)
      if (dbFiles.length === 0) {
        return { success: false, error: '未找到消息数据库' }
      }

      const sessionDbPath = path.join(dbDir, 'session.db')
      if (!fs.existsSync(sessionDbPath)) {
        return { success: false, error: '未找到 session.db' }
      }

      const sessionDb = new Database(sessionDbPath, { readonly: true })
      const privateUsernames = this.getPrivateSessions(sessionDb, cleanedWxid)
      sessionDb.close()

      const contactStats: Map<string, { 
        messageCount: number
        sentCount: number
        receivedCount: number
        lastMessageTime: number | null
      }> = new Map()

      const crypto = require('crypto')
      const getTableHash = (username: string) => {
        return crypto.createHash('md5').update(username).digest('hex')
      }
      const timeRange = this.normalizeTimeRange(startTime, endTime)
      const timeWhere = this.buildTimeWhereClause(timeRange)

      for (const username of privateUsernames) {
        const tableHash = getTableHash(username)

        // 遍历所有数据库，累加统计（同一会话可能分布在多个数据库中）
        for (const dbPath of dbFiles) {
          const db = this.getMessageDb(dbPath)
          if (!db) continue

          const tables = db.prepare(`
            SELECT name FROM sqlite_master 
            WHERE type='table' AND name LIKE 'Msg_%'
          `).all() as { name: string }[]

          for (const { name: tableName } of tables) {
            if (!tableName.includes(tableHash)) continue

            try {
              const hasName2Id = this.hasName2IdTable(db)
              const myRowId = hasName2Id ? this.getMyRowId(db, dbPath, cleanedWxid) : null

              let statsQuery: string
              if (hasName2Id && myRowId !== null) {
                statsQuery = `
                  SELECT 
                    COUNT(*) as total,
                    SUM(CASE WHEN real_sender_id = ${myRowId} THEN 1 ELSE 0 END) as sent_count,
                    SUM(CASE WHEN real_sender_id != ${myRowId} THEN 1 ELSE 0 END) as received_count,
                    MAX(create_time) as last_time
                  FROM "${tableName}"${timeWhere}
                `
              } else {
                statsQuery = `
                  SELECT 
                    COUNT(*) as total,
                    SUM(CASE WHEN is_send = 1 THEN 1 ELSE 0 END) as sent_count,
                    SUM(CASE WHEN is_send = 0 OR is_send IS NULL THEN 1 ELSE 0 END) as received_count,
                    MAX(create_time) as last_time
                  FROM "${tableName}"${timeWhere}
                `
              }

              const stats = db.prepare(statsQuery).get() as any

              if (stats && stats.total > 0) {
                const existing = contactStats.get(username)
                if (existing) {
                  existing.messageCount += stats.total
                  existing.sentCount += stats.sent_count || 0
                  existing.receivedCount += stats.received_count || 0
                  if (stats.last_time && (!existing.lastMessageTime || stats.last_time > existing.lastMessageTime)) {
                    existing.lastMessageTime = stats.last_time
                  }
                } else {
                  contactStats.set(username, {
                    messageCount: stats.total,
                    sentCount: stats.sent_count || 0,
                    receivedCount: stats.received_count || 0,
                    lastMessageTime: stats.last_time || null
                  })
                }
              }
            } catch (e) {
              // skip
            }
          }
        }
      }

      const contactDbPath = path.join(dbDir, 'contact.db')
      const contactInfo: Map<string, { displayName: string; avatarUrl?: string }> = new Map()
      
      if (fs.existsSync(contactDbPath)) {
        const contactDb = new Database(contactDbPath, { readonly: true })
        const usernames = Array.from(contactStats.keys())
        
        // 检查表结构
        const columns = contactDb.prepare("PRAGMA table_info(contact)").all() as { name: string }[]
        const columnNames = columns.map(c => c.name)
        const hasBigHeadUrl = columnNames.includes('big_head_url')
        const hasSmallHeadUrl = columnNames.includes('small_head_url')
        
        for (const username of usernames) {
          try {
            const selectCols = ['nick_name', 'remark']
            if (hasBigHeadUrl) selectCols.push('big_head_url')
            if (hasSmallHeadUrl) selectCols.push('small_head_url')
            
            const contact = contactDb.prepare(`
              SELECT ${selectCols.join(', ')} FROM contact WHERE username = ?
            `).get(username) as { nick_name?: string; remark?: string; big_head_url?: string; small_head_url?: string } | undefined
            
            if (contact) {
              const avatarUrl = (hasBigHeadUrl && contact.big_head_url) 
                ? contact.big_head_url 
                : (hasSmallHeadUrl && contact.small_head_url) 
                  ? contact.small_head_url 
                  : undefined
              contactInfo.set(username, {
                displayName: contact.remark || contact.nick_name || username,
                avatarUrl
              })
            }
          } catch (e) {
            // skip
          }
        }
        contactDb.close()
      }

      const rankings: ContactRanking[] = Array.from(contactStats.entries())
        .map(([username, stats]) => {
          const info = contactInfo.get(username)
          return {
            username,
            displayName: info?.displayName || username,
            avatarUrl: info?.avatarUrl,
            messageCount: stats.messageCount,
            sentCount: stats.sentCount,
            receivedCount: stats.receivedCount,
            lastMessageTime: stats.lastMessageTime
          }
        })
        .sort((a, b) => {
          const messageCountDelta = b.messageCount - a.messageCount
          if (messageCountDelta !== 0) return messageCountDelta
          return (b.lastMessageTime || 0) - (a.lastMessageTime || 0)
        })
        .slice(0, limit)

      return { success: true, data: rankings }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }


  async getTimeDistribution(startTime?: number, endTime?: number): Promise<{ success: boolean; data?: TimeDistribution; error?: string }> {
    try {
      const wxid = this.configService.get('myWxid')
      if (!wxid) {
        return { success: false, error: '未配置微信ID' }
      }

      const baseDir = this.getDecryptedDbDir()
      const accountDir = this.findAccountDir(baseDir, wxid)
      
      if (!accountDir) {
        return { success: false, error: `未找到账号 ${wxid} 的数据库目录` }
      }

      const cleanedWxid = this.cleanAccountDirName(wxid)
      const dbDir = path.join(baseDir, accountDir)

      // 获取私聊会话列表
      const sessionDbPath = path.join(dbDir, 'session.db')
      if (!fs.existsSync(sessionDbPath)) {
        return { success: false, error: '未找到 session.db' }
      }

      const sessionDb = new Database(sessionDbPath, { readonly: true })
      const privateUsernames = this.getPrivateSessions(sessionDb, cleanedWxid)
      sessionDb.close()

      const crypto = require('crypto')
      const getTableHash = (username: string) => {
        return crypto.createHash('md5').update(username).digest('hex')
      }

      const privateTableHashes = new Set(privateUsernames.map(u => getTableHash(u)))
      const timeRange = this.normalizeTimeRange(startTime, endTime)
      const timeWhere = this.buildTimeWhereClause(timeRange)

      const dbFiles = this.findMessageDbFiles(dbDir)
      
      const hourlyDistribution: Record<number, number> = {}
      const weekdayDistribution: Record<number, number> = {}
      const monthlyDistribution: Record<string, number> = {}

      for (let i = 0; i < 24; i++) hourlyDistribution[i] = 0
      for (let i = 1; i <= 7; i++) weekdayDistribution[i] = 0

      for (const dbPath of dbFiles) {
        const db = this.getMessageDb(dbPath)
        if (!db) continue

        const tables = db.prepare(`
          SELECT name FROM sqlite_master 
          WHERE type='table' AND name LIKE 'Msg_%'
        `).all() as { name: string }[]

        for (const { name: tableName } of tables) {
          // 只统计私聊表
          const tableHash = tableName.replace('Msg_', '')
          if (!privateTableHashes.has(tableHash)) {
            continue
          }

          try {
            const hourly = db.prepare(`
              SELECT 
                CAST(strftime('%H', create_time, 'unixepoch', 'localtime') AS INTEGER) as hour,
                COUNT(*) as count
              FROM "${tableName}"${timeWhere}
              GROUP BY hour
            `).all() as { hour: number; count: number }[]

            for (const { hour, count } of hourly) {
              hourlyDistribution[hour] = (hourlyDistribution[hour] || 0) + count
            }

            const weekday = db.prepare(`
              SELECT 
                CAST(strftime('%w', create_time, 'unixepoch', 'localtime') AS INTEGER) as dow,
                COUNT(*) as count
              FROM "${tableName}"${timeWhere}
              GROUP BY dow
            `).all() as { dow: number; count: number }[]

            for (const { dow, count } of weekday) {
              const weekdayNum = dow === 0 ? 7 : dow
              weekdayDistribution[weekdayNum] = (weekdayDistribution[weekdayNum] || 0) + count
            }

            const monthly = db.prepare(`
              SELECT 
                strftime('%Y-%m', create_time, 'unixepoch', 'localtime') as month,
                COUNT(*) as count
              FROM "${tableName}"${timeWhere}
              GROUP BY month
            `).all() as { month: string; count: number }[]

            for (const { month, count } of monthly) {
              if (month) {
                monthlyDistribution[month] = (monthlyDistribution[month] || 0) + count
              }
            }
          } catch (e) {
            // skip
          }
        }
      }

      return {
        success: true,
        data: {
          hourlyDistribution,
          weekdayDistribution,
          monthlyDistribution
        }
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  close() {
    this.messageDbCache.forEach(db => {
      try {
        db.close()
      } catch (e) {
        // ignore
      }
    })
    this.messageDbCache.clear()
    this.myRowIdCache.clear()
  }
}

export const analyticsService = new AnalyticsService()
