import { ConfigService } from './config'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import * as crypto from 'crypto'

export interface TopContact {
  username: string
  displayName: string
  avatarUrl?: string
  messageCount: number
  sentCount: number
  receivedCount: number
}

export interface MonthlyTopFriend {
  month: number
  displayName: string
  avatarUrl?: string
  messageCount: number
}

export interface ChatPeakDay {
  date: string
  messageCount: number
  topFriend?: string
  topFriendCount?: number
}

export interface ActivityHeatmap {
  data: number[][] // 7x24 矩阵，weekday x hour
}

export interface AnnualReportData {
  year: number
  totalMessages: number
  totalFriends: number
  coreFriends: TopContact[]
  monthlyTopFriends: MonthlyTopFriend[]
  peakDay: ChatPeakDay | null
  longestStreak: {
    friendName: string
    days: number
    startDate: string
    endDate: string
  } | null
  activityHeatmap: ActivityHeatmap
  midnightKing: {
    displayName: string
    count: number
    percentage: number
  } | null
  selfAvatarUrl?: string
  // 新增字段
  mutualFriend: {
    displayName: string
    avatarUrl?: string
    sentCount: number
    receivedCount: number
    ratio: number // 接近1表示双向奔赴
  } | null
  socialInitiative: {
    initiatedChats: number // 主动发起的对话数
    receivedChats: number // 被动回复的对话数
    initiativeRate: number // 主动率百分比
  } | null
  responseSpeed: {
    avgResponseTime: number // 平均回复时间（秒）
    fastestFriend: string // 回复最快的好友
    fastestTime: number // 最快回复时间
  } | null
  topPhrases: {
    phrase: string
    count: number
  }[]
}

class AnnualReportService {
  private configService: ConfigService
  private messageDbCache: Map<string, Database.Database> = new Map()

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

  private cleanAccountDirName(dirName: string): string {
    const trimmed = dirName.trim()
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

    // 3. 扫描目录查找匹配
    try {
      const entries = fs.readdirSync(baseDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        
        const dirName = entry.name
        const dirNameLower = dirName.toLowerCase()
        const wxidLower = wxid.toLowerCase()
        const cleanedWxidLower = cleanedWxid.toLowerCase()
        
        // 精确匹配（忽略大小写）
        if (dirNameLower === wxidLower || dirNameLower === cleanedWxidLower) return dirName
        
        // 前缀匹配: 目录名以 wxid 或 cleanedWxid 开头
        if (dirNameLower.startsWith(wxidLower + '_') || dirNameLower.startsWith(cleanedWxidLower + '_')) return dirName
        
        // 反向前缀匹配: wxid 或 cleanedWxid 以目录名开头
        if (wxidLower.startsWith(dirNameLower + '_') || cleanedWxidLower.startsWith(dirNameLower + '_')) return dirName
        
        // 清理目录名后匹配
        const cleanedDirName = this.cleanAccountDirName(dirName)
        if (cleanedDirName.toLowerCase() === wxidLower || cleanedDirName.toLowerCase() === cleanedWxidLower) return dirName
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
    } catch {
      return null
    }
  }

  private getTableHash(username: string): string {
    return crypto.createHash('md5').update(username).digest('hex')
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

  private myRowIdCache: Map<string, number | null> = new Map()

  private getMyRowId(db: Database.Database, dbPath: string, myWxid: string): number | null {
    const cacheKey = `${dbPath}:${myWxid}`
    if (this.myRowIdCache.has(cacheKey)) {
      return this.myRowIdCache.get(cacheKey)!
    }
    try {
      const row = db.prepare('SELECT rowid FROM Name2Id WHERE user_name = ?').get(myWxid) as { rowid: number } | undefined
      const rowId = row?.rowid ?? null
      this.myRowIdCache.set(cacheKey, rowId)
      return rowId
    } catch {
      this.myRowIdCache.set(cacheKey, null)
      return null
    }
  }

  async getAvailableYears(): Promise<{ success: boolean; data?: number[]; error?: string }> {
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

      const dbDir = path.join(baseDir, accountDir)
      
      const dbFiles = this.findMessageDbFiles(dbDir)

      if (dbFiles.length === 0) {
        return { success: false, error: '未找到消息数据库' }
      }

      const years = new Set<number>()

      for (const dbPath of dbFiles) {
        const db = this.getMessageDb(dbPath)
        if (!db) continue

        const tables = db.prepare(`
          SELECT name FROM sqlite_master 
          WHERE type='table' AND name LIKE 'Msg_%'
        `).all() as { name: string }[]

        for (const { name: tableName } of tables) {
          try {
            const result = db.prepare(`
              SELECT MIN(create_time) as min_time, MAX(create_time) as max_time
              FROM "${tableName}" WHERE create_time > 0
            `).get() as { min_time: number; max_time: number } | undefined

            if (result?.min_time && result?.max_time) {
              const minYear = new Date(result.min_time * 1000).getFullYear()
              const maxYear = new Date(result.max_time * 1000).getFullYear()
              for (let y = minYear; y <= maxYear; y++) {
                if (y >= 2010 && y <= new Date().getFullYear()) {
                  years.add(y)
                }
              }
            }
          } catch { /* skip */ }
        }
      }

      const sortedYears = Array.from(years).sort((a, b) => b - a)
      return { success: true, data: sortedYears }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async generateReport(year: number): Promise<{ success: boolean; data?: AnnualReportData; error?: string }> {
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

      // 获取私聊会话列表
      const sessionDbPath = path.join(dbDir, 'session.db')
      if (!fs.existsSync(sessionDbPath)) {
        return { success: false, error: '未找到 session.db' }
      }

      const sessionDb = new Database(sessionDbPath, { readonly: true })
      const sessions = sessionDb.prepare(`
        SELECT username FROM SessionTable 
        WHERE username NOT LIKE '%@chatroom'
        AND username != 'filehelper'
        AND username NOT LIKE 'gh_%'
      `).all() as { username: string }[]
      sessionDb.close()

      // 过滤掉自己（同时匹配原始wxid和清理后的wxid）
      const wxidLower = wxid.toLowerCase()
      const cleanedWxidLower = cleanedWxid.toLowerCase()
      const privateUsernames = sessions
        .map(s => s.username)
        .filter(u => {
          const uLower = u.toLowerCase()
          return uLower !== wxidLower && uLower !== cleanedWxidLower
        })

      // 构建 hash -> username 映射
      const hashToUsername = new Map<string, string>()
      for (const username of privateUsernames) {
        hashToUsername.set(this.getTableHash(username), username)
      }

      const startTime = Math.floor(new Date(year, 0, 1).getTime() / 1000)
      const endTime = Math.floor(new Date(year, 11, 31, 23, 59, 59).getTime() / 1000)

      // 统计数据
      let totalMessages = 0
      const contactStats = new Map<string, { sent: number; received: number }>()
      const monthlyStats = new Map<string, Map<number, number>>()
      const dailyStats = new Map<string, number>()
      const dailyContactStats = new Map<string, Map<string, number>>()
      const heatmapData: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0))
      const midnightStats = new Map<string, number>()
      
      // 新增统计数据
      const conversationStarts = new Map<string, { initiated: number; received: number }>() // 对话发起统计
      const responseTimeStats = new Map<string, number[]>() // 回复时间统计
      const phraseCount = new Map<string, number>() // 常用语统计
      let lastMessageTime = new Map<string, { time: number; isSent: boolean }>() // 用于计算回复时间
      
      // 火花统计：每个会话的活跃日期集合
      const sessionActiveDays = new Map<string, Set<string>>()

      let tablesProcessed = 0

      // 遍历所有消息数据库
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
          // 从表名提取 hash，查找对应的 sessionId
          const tableHash = tableName.replace('Msg_', '')
          const sessionId = hashToUsername.get(tableHash)
          if (!sessionId) continue // 不是私聊表

          tablesProcessed++

          try {
            // 必须有 Name2Id 表和 myRowId 才能正确判断发送者
            if (!hasName2Id || myRowId === null) {
              // 没有 Name2Id 表，无法判断发送者，跳过此表
              continue
            }

            // 检查表是否有内容字段（按优先级尝试多个字段名）
            const columns = db.prepare(`PRAGMA table_info("${tableName}")`).all() as { name: string }[]
            const columnNames = columns.map(c => c.name.toLowerCase())
            
            // 内容字段候选列表（按优先级排序）
            const contentCandidates = ['display_content', 'message_content', 'content', 'msg_content', 'WCDB_CT_message_content']
            let contentColumn: string | null = null
            for (const candidate of contentCandidates) {
              if (columnNames.includes(candidate.toLowerCase())) {
                contentColumn = candidate
                break
              }
            }

            const selectFields = `
              create_time, 
              CASE WHEN real_sender_id = ${myRowId} THEN 1 ELSE 0 END as is_sent,
              strftime('%Y-%m-%d', create_time, 'unixepoch', 'localtime') as day,
              CAST(strftime('%m', create_time, 'unixepoch', 'localtime') AS INTEGER) as month,
              CAST(strftime('%H', create_time, 'unixepoch', 'localtime') AS INTEGER) as hour,
              CAST(strftime('%w', create_time, 'unixepoch', 'localtime') AS INTEGER) as weekday,
              local_type
              ${contentColumn ? `, "${contentColumn}" as msg_content` : ''}
            `

            const query = `
              SELECT ${selectFields}
              FROM "${tableName}"
              WHERE create_time >= ? AND create_time <= ?
              ORDER BY create_time ASC
            `

            const messages = db.prepare(query).all(startTime, endTime) as { 
              create_time: number; is_sent: number; day: string; month: number; hour: number; weekday: number;
              local_type: number; msg_content?: string | null
            }[]

            // 用于计算对话发起和回复时间
            let lastMsg = lastMessageTime.get(sessionId)
            const CONVERSATION_GAP = 3600 // 1小时内算同一对话

            for (const msg of messages) {
              totalMessages++

              // 联系人统计
              if (!contactStats.has(sessionId)) {
                contactStats.set(sessionId, { sent: 0, received: 0 })
              }
              const stats = contactStats.get(sessionId)!
              if (msg.is_sent === 1) {
                stats.sent++
              } else {
                stats.received++
              }

              // 对话发起统计
              if (!conversationStarts.has(sessionId)) {
                conversationStarts.set(sessionId, { initiated: 0, received: 0 })
              }
              const convStats = conversationStarts.get(sessionId)!
              
              if (!lastMsg || (msg.create_time - lastMsg.time) > CONVERSATION_GAP) {
                // 新对话开始
                if (msg.is_sent === 1) {
                  convStats.initiated++
                } else {
                  convStats.received++
                }
              } else if (lastMsg.isSent !== (msg.is_sent === 1)) {
                // 回复时间统计（对方发消息后我回复）
                if (msg.is_sent === 1 && !lastMsg.isSent) {
                  const responseTime = msg.create_time - lastMsg.time
                  if (responseTime > 0 && responseTime < 86400) { // 24小时内的回复
                    if (!responseTimeStats.has(sessionId)) {
                      responseTimeStats.set(sessionId, [])
                    }
                    responseTimeStats.get(sessionId)!.push(responseTime)
                  }
                }
              }
              
              lastMsg = { time: msg.create_time, isSent: msg.is_sent === 1 }
              lastMessageTime.set(sessionId, lastMsg)

              // 常用语统计（只统计文本消息，local_type 1 和 244813135921 都是文本消息）
              if ((msg.local_type === 1 || msg.local_type === 244813135921) && msg.msg_content && msg.is_sent === 1) {
                const content = String(msg.msg_content)
                  .trim()
                  .toLowerCase()
                  .replace(/[\p{P}\p{S}]+$/gu, '');
                // 过滤掉系统消息、链接等
                if (content.length >= 2 && content.length <= 20 && 
                    !content.includes('http') && 
                    !content.includes('<') &&
                    !content.startsWith('[') &&
                    !content.startsWith('<?xml')) {
                  phraseCount.set(content, (phraseCount.get(content) || 0) + 1)
                }
              }

              // 月度统计
              if (!monthlyStats.has(sessionId)) {
                monthlyStats.set(sessionId, new Map())
              }
              const monthMap = monthlyStats.get(sessionId)!
              monthMap.set(msg.month, (monthMap.get(msg.month) || 0) + 1)

              // 日统计
              dailyStats.set(msg.day, (dailyStats.get(msg.day) || 0) + 1)
              if (!dailyContactStats.has(msg.day)) {
                dailyContactStats.set(msg.day, new Map())
              }
              const dayContactMap = dailyContactStats.get(msg.day)!
              dayContactMap.set(sessionId, (dayContactMap.get(sessionId) || 0) + 1)

              // 火花统计：收集每个会话的活跃日期
              if (!sessionActiveDays.has(sessionId)) {
                sessionActiveDays.set(sessionId, new Set())
              }
              sessionActiveDays.get(sessionId)!.add(msg.day)

              // 热力图 (weekday: 0=周日, 1-6=周一到周六)
              const weekdayIndex = msg.weekday === 0 ? 6 : msg.weekday - 1
              heatmapData[weekdayIndex][msg.hour]++

              // 深夜统计 (0-5点)
              if (msg.hour >= 0 && msg.hour < 6) {
                midnightStats.set(sessionId, (midnightStats.get(sessionId) || 0) + 1)
              }
            }
          } catch {
            // skip error
          }
        }
      }

      // 获取联系人信息
      const contactDbPath = path.join(dbDir, 'contact.db')
      const contactInfoMap = new Map<string, { displayName: string; avatarUrl?: string }>()
      let selfAvatarUrl: string | undefined

      if (fs.existsSync(contactDbPath)) {
        try {
          const contactDb = new Database(contactDbPath, { readonly: true })
          
          // 获取自己的头像
          try {
            const self = contactDb.prepare(`
              SELECT small_head_url FROM contact WHERE username = ?
            `).get(cleanedWxid) as { small_head_url?: string } | undefined
            selfAvatarUrl = self?.small_head_url
          } catch { /* skip */ }

          for (const sessionId of Array.from(contactStats.keys())) {
            try {
              const contact = contactDb.prepare(`
                SELECT nick_name, remark, small_head_url FROM contact WHERE username = ?
              `).get(sessionId) as { nick_name?: string; remark?: string; small_head_url?: string } | undefined
              if (contact) {
                contactInfoMap.set(sessionId, {
                  displayName: contact.remark || contact.nick_name || sessionId,
                  avatarUrl: contact.small_head_url
                })
              }
            } catch { /* skip */ }
          }
          contactDb.close()
        } catch { /* skip */ }
      }

      // 构建年度挚友 (Top 10)
      const coreFriends: TopContact[] = Array.from(contactStats.entries())
        .map(([sessionId, stats]) => {
          const info = contactInfoMap.get(sessionId)
          return {
            username: sessionId,
            displayName: info?.displayName || sessionId,
            avatarUrl: info?.avatarUrl,
            messageCount: stats.sent + stats.received,
            sentCount: stats.sent,
            receivedCount: stats.received
          }
        })
        .sort((a, b) => b.messageCount - a.messageCount)
        .slice(0, 3)

      // 构建月度好友
      const monthlyTopFriends: MonthlyTopFriend[] = []
      for (let month = 1; month <= 12; month++) {
        let maxCount = 0
        let topSessionId = ''
        const sessionIds = Array.from(monthlyStats.keys())
        for (const sessionId of sessionIds) {
          const monthMap = monthlyStats.get(sessionId)!
          const count = monthMap.get(month) || 0
          if (count > maxCount) {
            maxCount = count
            topSessionId = sessionId
          }
        }
        const info = contactInfoMap.get(topSessionId)
        monthlyTopFriends.push({
          month,
          displayName: info?.displayName || (topSessionId ? topSessionId : '暂无'),
          avatarUrl: info?.avatarUrl,
          messageCount: maxCount
        })
      }

      // 找出巅峰日
      let peakDay: ChatPeakDay | null = null
      let maxDayCount = 0
      const days = Array.from(dailyStats.keys())
      for (const day of days) {
        const count = dailyStats.get(day)!
        if (count > maxDayCount) {
          maxDayCount = count
          const dayContactMap = dailyContactStats.get(day)
          let topFriend = ''
          let topFriendCount = 0
          if (dayContactMap) {
            const contactIds = Array.from(dayContactMap.keys())
            for (const sessionId of contactIds) {
              const c = dayContactMap.get(sessionId)!
              if (c > topFriendCount) {
                topFriendCount = c
                topFriend = contactInfoMap.get(sessionId)?.displayName || sessionId
              }
            }
          }
          peakDay = { date: day, messageCount: count, topFriend, topFriendCount }
        }
      }

      // 找出深夜好友
      let midnightKing: AnnualReportData['midnightKing'] = null
      const totalMidnight = Array.from(midnightStats.values()).reduce((a: number, b: number) => a + b, 0)
      if (totalMidnight > 0) {
        let maxMidnight = 0
        let midnightSessionId = ''
        const midnightIds = Array.from(midnightStats.keys())
        for (const sessionId of midnightIds) {
          const count = midnightStats.get(sessionId)!
          if (count > maxMidnight) {
            maxMidnight = count
            midnightSessionId = sessionId
          }
        }
        const info = contactInfoMap.get(midnightSessionId)
        midnightKing = {
          displayName: info?.displayName || midnightSessionId,
          count: maxMidnight,
          percentage: Math.round((maxMidnight / totalMidnight) * 1000) / 10
        }
      }

      // 计算最长连续聊天（基于 sessionActiveDays 中收集的活跃日期）
      let longestStreak: AnnualReportData['longestStreak'] = null
      let bestStreakDays = 0
      let bestStreakSessionId = ''
      let bestStreakStart: Date | null = null
      let bestStreakEnd: Date | null = null

      for (const [sessionId, activeDaysSet] of Array.from(sessionActiveDays.entries())) {
        if (activeDaysSet.size < 2) continue // 至少需要2天才能形成连续

        // 将日期字符串转换为 Date 对象并排序
        const sortedDates = Array.from(activeDaysSet)
          .map(dateStr => new Date(dateStr + 'T00:00:00'))
          .sort((a, b) => a.getTime() - b.getTime())

        // 计算最长连续天数
        let currentStreak = 1
        let currentStart = sortedDates[0]
        let maxStreak = 1
        let maxStart = sortedDates[0]
        let maxEnd = sortedDates[0]

        for (let i = 1; i < sortedDates.length; i++) {
          const prevDate = sortedDates[i - 1]
          const currDate = sortedDates[i]
          const diffDays = Math.round((currDate.getTime() - prevDate.getTime()) / (24 * 60 * 60 * 1000))

          if (diffDays === 1) {
            // 连续的一天
            currentStreak++
          } else {
            // 不连续，重新开始计数
            currentStreak = 1
            currentStart = currDate
          }

          if (currentStreak > maxStreak) {
            maxStreak = currentStreak
            maxStart = currentStart
            maxEnd = currDate
          }
        }

        if (maxStreak > bestStreakDays) {
          bestStreakDays = maxStreak
          bestStreakSessionId = sessionId
          bestStreakStart = maxStart
          bestStreakEnd = maxEnd
        }
      }

      // 构建最终结果
      if (bestStreakSessionId && bestStreakDays > 0 && bestStreakStart && bestStreakEnd) {
        const info = contactInfoMap.get(bestStreakSessionId)
        const formatDate = (d: Date) => {
          const y = d.getFullYear()
          const m = String(d.getMonth() + 1).padStart(2, '0')
          const day = String(d.getDate()).padStart(2, '0')
          return `${y}-${m}-${day}`
        }
        longestStreak = {
          friendName: info?.displayName || bestStreakSessionId,
          days: bestStreakDays,
          startDate: formatDate(bestStreakStart),
          endDate: formatDate(bestStreakEnd)
        }
      }

      // 计算双向奔赴（发送/接收比例最接近1:1的好友）
      let mutualFriend: AnnualReportData['mutualFriend'] = null
      let bestRatioDiff = Infinity
      const contactEntries = Array.from(contactStats.entries())
      for (const [sessionId, stats] of contactEntries) {
        if (stats.sent >= 50 && stats.received >= 50) { // 至少各50条消息
          const ratio = stats.sent / stats.received
          const ratioDiff = Math.abs(ratio - 1)
          if (ratioDiff < bestRatioDiff) {
            bestRatioDiff = ratioDiff
            const info = contactInfoMap.get(sessionId)
            mutualFriend = {
              displayName: info?.displayName || sessionId,
              avatarUrl: info?.avatarUrl,
              sentCount: stats.sent,
              receivedCount: stats.received,
              ratio: Math.round(ratio * 100) / 100
            }
          }
        }
      }

      // 计算社交主动性
      let socialInitiative: AnnualReportData['socialInitiative'] = null
      let totalInitiated = 0
      let totalReceived = 0
      const convValues = Array.from(conversationStarts.values())
      for (const stats of convValues) {
        totalInitiated += stats.initiated
        totalReceived += stats.received
      }
      const totalConversations = totalInitiated + totalReceived
      if (totalConversations > 0) {
        socialInitiative = {
          initiatedChats: totalInitiated,
          receivedChats: totalReceived,
          initiativeRate: Math.round((totalInitiated / totalConversations) * 1000) / 10
        }
      }

      // 计算回复速度
      let responseSpeed: AnnualReportData['responseSpeed'] = null
      let allResponseTimes: number[] = []
      let fastestFriendId = ''
      let fastestAvgTime = Infinity
      const responseEntries = Array.from(responseTimeStats.entries())
      for (const [sessionId, times] of responseEntries) {
        if (times.length >= 10) { // 至少10次回复
          allResponseTimes.push(...times)
          const avgTime = times.reduce((a: number, b: number) => a + b, 0) / times.length
          if (avgTime < fastestAvgTime) {
            fastestAvgTime = avgTime
            fastestFriendId = sessionId
          }
        }
      }
      if (allResponseTimes.length > 0) {
        const avgResponseTime = allResponseTimes.reduce((a: number, b: number) => a + b, 0) / allResponseTimes.length
        const fastestInfo = contactInfoMap.get(fastestFriendId)
        responseSpeed = {
          avgResponseTime: Math.round(avgResponseTime),
          fastestFriend: fastestInfo?.displayName || fastestFriendId,
          fastestTime: Math.round(fastestAvgTime)
        }
      }

      // 计算年度常用语（Top 32 for word cloud）
      const topPhrases = Array.from(phraseCount.entries())
        .filter(([_, count]) => count >= 2) // 至少使用2次
        .sort((a, b) => b[1] - a[1])
        .slice(0, 32)
        .map(([phrase, count]) => ({ phrase, count }))

      const reportData: AnnualReportData = {
        year,
        totalMessages,
        totalFriends: contactStats.size,
        coreFriends,
        monthlyTopFriends,
        peakDay,
        longestStreak,
        activityHeatmap: { data: heatmapData },
        midnightKing,
        selfAvatarUrl,
        mutualFriend,
        socialInitiative,
        responseSpeed,
        topPhrases
      }

      return { success: true, data: reportData }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  close() {
    this.messageDbCache.forEach(db => {
      try { db.close() } catch { /* ignore */ }
    })
    this.messageDbCache.clear()
  }
}

export const annualReportService = new AnnualReportService()
