import Database from 'better-sqlite3'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import * as http from 'http'
import * as fzstd from 'fzstd'
import { app } from 'electron'
import { ConfigService } from './config'

export interface ChatSession {
  username: string
  type: number
  unreadCount: number
  summary: string
  sortTimestamp: number  // 用于排序
  lastTimestamp: number  // 用于显示时间
  lastMsgType: number
  displayName?: string
  avatarUrl?: string
}

export interface ContactInfo {
  username: string
  displayName: string
  remark?: string
  nickname?: string
  avatarUrl?: string
  type: 'friend' | 'group' | 'official' | 'other'
}

export interface Message {
  localId: number
  serverId: number
  localType: number
  createTime: number
  sortSeq: number
  isSend: number | null
  senderUsername: string | null
  parsedContent: string
  rawContent: string
  // 表情包相关
  emojiCdnUrl?: string
  emojiMd5?: string
  emojiLocalPath?: string  // 本地缓存路径
  // 引用消息相关
  quotedContent?: string
  quotedSender?: string
  quotedImageMd5?: string
  // 图片相关
  imageMd5?: string
  imageDatName?: string
  // 视频相关
  videoMd5?: string
  // 语音相关
  voiceDuration?: number  // 语音时长（秒）
  // 商店表情相关
  productId?: string
  // 文件消息相关
  fileName?: string       // 文件名
  fileSize?: number       // 文件大小（字节）
  fileExt?: string        // 文件扩展名
  fileMd5?: string        // 文件 MD5
  chatRecordList?: ChatRecordItem[] // 聊天记录列表 (Type 19)
}

export interface ChatRecordItem {
  datatype: number
  datadesc?: string
  datatitle?: string
  sourcename?: string
  sourcetime?: string
  sourceheadurl?: string
  fileext?: string
  datasize?: number
  messageuuid?: string
  // 媒体信息
  dataurl?: string
  datathumburl?: string
  datacdnurl?: string
  qaeskey?: string
  aeskey?: string
  md5?: string
  imgheight?: number
  imgwidth?: number
  thumbheadurl?: string
  duration?: number
}

export interface Contact {
  username: string
  alias: string
  remark: string
  nickName: string
}

// 表情包缓存
const emojiCache: Map<string, string> = new Map()
const emojiDownloading: Map<string, Promise<string | null>> = new Map()

// 缓存过期时间（毫秒）
const SESSION_TABLE_CACHE_DURATION = 60 * 1000  // 60秒，与原项目一致

class ChatService extends EventEmitter {
  private configService: ConfigService
  private sessionDb: Database.Database | null = null
  private contactDb: Database.Database | null = null
  private emoticonDb: Database.Database | null = null
  private emotionDb: Database.Database | null = null
  private headImageDb: Database.Database | null = null
  private messageDbCache: Map<string, Database.Database> = new Map()
  private dbDir: string | null = null

  // 缓存：已知的消息数据库文件列表
  private knownMessageDbFiles: Set<string> = new Set()
  // 缓存：会话ID -> 所有包含该会话消息的数据库和表名（增量更新）
  private sessionTableCache: Map<string, { dbPath: string; tableName: string }[]> = new Map()
  // 缓存时间戳
  private sessionTableCacheTime: number = 0
  // 缓存：当前用户在 Name2Id 表中的 rowid（按数据库路径）- 这个是稳定的
  private myRowIdCache: Map<string, number | null> = new Map()
  // 缓存：数据库是否有 Name2Id 表 - 表结构不会变
  private hasName2IdCache: Map<string, boolean> = new Map()
  // 缓存：预编译的 SQL 语句 - 提升查询性能
  private preparedStmtCache: Map<string, Database.Statement> = new Map()
  // 缓存：联系人表结构信息 - 表结构不会变
  private contactColumnsCache: { hasBigHeadUrl: boolean; hasSmallHeadUrl: boolean; selectCols: string[] } | null = null
  // 缓存：头像 base64 数据
  private avatarBase64Cache: Map<string, string> = new Map()
  // 标记：head_image.db 是否损坏
  private headImageDbCorrupted: boolean = false

  // 自动同步相关
  private syncTimer: NodeJS.Timeout | null = null
  private lastDbCheckTime: number = 0

  // 增量同步相关
  private currentSessionId: string | null = null
  // 记录每个会话已读取的最大 sortSeq (用于此后的增量查询)
  private sessionCursor: Map<string, number> = new Map()

  constructor() {
    super()
    this.configService = new ConfigService()
  }

  /**
   * 设置当前聚焦的会话 ID
   * 用于增量同步时只推送当前会话的消息
   */
  setCurrentSession(sessionId: string | null): void {
    this.currentSessionId = sessionId
  }

  /**
   * 清理账号目录名（支持 wxid_ 格式和自定义微信号格式）
   */
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

  /**
   * 获取解密后的数据库目录
   * - 如果配置了 cachePath，使用配置的路径
   * - 开发环境：使用文档目录
   * - 生产环境：
   *   - C 盘安装：使用文档目录
   *   - 其他盘安装：使用软件安装目录
   */
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

  /**
   * 连接数据库
   */
  async connect(): Promise<{ success: boolean; error?: string }> {
    try {
      const wxid = this.configService.get('myWxid')
      if (!wxid) {
        return { success: false, error: '请先在设置页面配置微信ID' }
      }

      const baseDir = this.getDecryptedDbDir()
      const accountDir = this.findAccountDir(baseDir, wxid)

      if (!accountDir) {
        return { success: false, error: `未找到账号 ${wxid} 的数据库目录，请先解密数据库` }
      }

      const dbDir = path.join(baseDir, accountDir)

      const sessionDbPath = path.join(dbDir, 'session.db')
      if (!fs.existsSync(sessionDbPath)) {
        return { success: false, error: '未找到 session.db，请先解密数据库' }
      }

      this.close()

      this.sessionDb = new Database(sessionDbPath, { readonly: true })
      this.dbDir = dbDir

      const contactDbPath = path.join(dbDir, 'contact.db')
      if (fs.existsSync(contactDbPath)) {
        this.contactDb = new Database(contactDbPath, { readonly: true })
      }

      const emoticonDbPath = path.join(dbDir, 'emoticon.db')
      if (fs.existsSync(emoticonDbPath)) {
        this.emoticonDb = new Database(emoticonDbPath, { readonly: true })
      }

      const emotionDbPath = path.join(dbDir, 'emotion.db')
      if (fs.existsSync(emotionDbPath)) {
        this.emotionDb = new Database(emotionDbPath, { readonly: true })
      }

      const headImageDbPath = path.join(dbDir, 'head_image.db')
      if (fs.existsSync(headImageDbPath)) {
        this.headImageDb = new Database(headImageDbPath, { readonly: true })
      }

      // 连接时强制清除所有缓存，确保获取最新数据
      // 这解决了增量更新后重新打开窗口时数据不刷新的问题
      this.sessionTableCache.clear()
      this.sessionTableCacheTime = 0
      this.knownMessageDbFiles.clear()
      this.avatarBase64Cache.clear()

      return { success: true }
    } catch (e) {
      console.error('ChatService: 连接数据库失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    // 先停止自动同步定时器
    this.stopAutoSync()

    try {
      this.sessionDb?.close()
      this.contactDb?.close()
      this.emoticonDb?.close()
      this.emotionDb?.close()
      this.headImageDb?.close()
      this.messageDbCache.forEach(db => {
        try { db.close() } catch { }
      })
    } catch (e) {
      console.error('ChatService: 关闭数据库失败:', e)
    }
    this.sessionDb = null
    this.contactDb = null
    this.headImageDb = null
    this.messageDbCache.clear()
    this.knownMessageDbFiles.clear()
    this.sessionTableCache.clear()
    this.sessionTableCacheTime = 0
    this.myRowIdCache.clear()
    this.hasName2IdCache.clear()
    this.preparedStmtCache.clear()
    this.contactColumnsCache = null
    this.avatarBase64Cache.clear()
    this.dbDir = null
  }

  /**
   * 关闭指定的数据库文件（用于增量更新时释放单个文件）
   * 这样可以在更新某个数据库时，不影响其他数据库的查询
   */
  closeDatabase(fileName: string): void {
    const fileNameLower = fileName.toLowerCase()

    // 检查是否是核心数据库
    if (fileNameLower === 'session.db' && this.sessionDb) {
      try { this.sessionDb.close() } catch { }
      this.sessionDb = null
      return
    }

    if (fileNameLower === 'contact.db' && this.contactDb) {
      try { this.contactDb.close() } catch { }
      this.contactDb = null
      this.contactColumnsCache = null
      return
    }

    if (fileNameLower === 'emoticon.db' && this.emoticonDb) {
      try { this.emoticonDb.close() } catch { }
      this.emoticonDb = null
      return
    }

    if (fileNameLower === 'emotion.db' && this.emotionDb) {
      try { this.emotionDb.close() } catch { }
      this.emotionDb = null
      return
    }

    if (fileNameLower === 'head_image.db' && this.headImageDb) {
      try { this.headImageDb.close() } catch { }
      this.headImageDb = null
      this.avatarBase64Cache.clear()
      return
    }

    // 检查是否是消息数据库（在缓存中查找）
    const entries = Array.from(this.messageDbCache.entries())
    for (let i = 0; i < entries.length; i++) {
      const [dbPath, db] = entries[i]
      if (dbPath.toLowerCase().endsWith(fileNameLower)) {
        try { db.close() } catch { }
        this.messageDbCache.delete(dbPath)
        this.knownMessageDbFiles.delete(dbPath)
        // 清除相关的预编译语句缓存
        const stmtKeys = Array.from(this.preparedStmtCache.keys())
        for (let j = 0; j < stmtKeys.length; j++) {
          if (stmtKeys[j].startsWith(dbPath)) {
            this.preparedStmtCache.delete(stmtKeys[j])
          }
        }
        // 清除会话表缓存（因为可能包含这个数据库的信息）
        this.sessionTableCache.clear()
        this.sessionTableCacheTime = 0
        return
      }
    }
  }

  /**
   * 获取会话列表
   */
  async getSessions(): Promise<{ success: boolean; sessions?: ChatSession[]; error?: string }> {
    try {
      if (!this.sessionDb) {
        const connectResult = await this.connect()
        if (!connectResult.success) {
          return { success: false, error: connectResult.error }
        }
      }

      // 获取表列表
      const tables = this.sessionDb!.prepare(
        "SELECT name FROM sqlite_master WHERE type='table'"
      ).all() as any[]
      const tableNames = tables.map(t => t.name)

      // 查找会话表
      let sessionTableName: string | null = null
      for (const name of ['SessionTable', 'Session', 'session']) {
        if (tableNames.includes(name)) {
          sessionTableName = name
          break
        }
      }

      if (!sessionTableName) {
        return { success: false, error: '未找到会话表' }
      }

      // 获取表结构
      const columns = this.sessionDb!.prepare(
        `PRAGMA table_info(${sessionTableName})`
      ).all() as any[]
      const columnNames = columns.map((c: any) => c.name)

      // 查询所有数据
      const rows = this.sessionDb!.prepare(
        `SELECT * FROM ${sessionTableName} ORDER BY sort_timestamp DESC`
      ).all() as any[]

      // 转换为 ChatSession
      const sessions: ChatSession[] = []
      for (const row of rows) {
        const username = row.username || row.user_name || row.userName || ''

        if (!this.shouldKeepSession(username)) continue

        const sortTs = row.sort_timestamp || row.sortTimestamp || 0
        const lastTs = row.last_timestamp || row.lastTimestamp || sortTs

        sessions.push({
          username,
          type: row.type || 0,
          unreadCount: row.unread_count || row.unreadCount || 0,
          summary: this.processSummary(row.summary || row.digest || '', row.last_msg_type || row.lastMsgType || 1),
          sortTimestamp: sortTs,
          lastTimestamp: lastTs,
          lastMsgType: row.last_msg_type || row.lastMsgType || 0,
          displayName: username
        })
      }

      // 获取联系人信息
      await this.enrichSessionsWithContacts(sessions)

      return { success: true, sessions }
    } catch (e) {
      console.error('ChatService: 获取会话列表失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 补充联系人信息
   */
  private async enrichSessionsWithContacts(sessions: ChatSession[]): Promise<void> {
    if (!this.contactDb || sessions.length === 0) return

    try {
      // 检查 contact 表是否存在
      const tables = this.contactDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='contact'"
      ).all()

      if (tables.length === 0) {
        return
      }

      // 使用缓存的列信息
      if (!this.contactColumnsCache) {
        const columns = this.contactDb.prepare("PRAGMA table_info(contact)").all() as any[]
        const columnNames = columns.map((c: any) => c.name)

        const hasBigHeadUrl = columnNames.includes('big_head_url')
        const hasSmallHeadUrl = columnNames.includes('small_head_url')

        const selectCols = ['username', 'remark', 'nick_name', 'alias']
        if (hasBigHeadUrl) selectCols.push('big_head_url')
        if (hasSmallHeadUrl) selectCols.push('small_head_url')

        this.contactColumnsCache = { hasBigHeadUrl, hasSmallHeadUrl, selectCols }
      }

      const { hasBigHeadUrl, hasSmallHeadUrl, selectCols } = this.contactColumnsCache

      const stmt = this.contactDb.prepare(`
        SELECT ${selectCols.join(', ')}
        FROM contact
        WHERE username = ?
      `)

      for (const session of sessions) {
        try {
          const contact = stmt.get(session.username) as any
          if (contact) {
            session.displayName = contact.remark || contact.nick_name || contact.alias || session.username

            if (hasBigHeadUrl && contact.big_head_url) {
              session.avatarUrl = contact.big_head_url
            } else if (hasSmallHeadUrl && contact.small_head_url) {
              session.avatarUrl = contact.small_head_url
            } else {
              // 如果 contact 表中没有头像 URL，尝试从 head_image.db 获取
              session.avatarUrl = await this.getAvatarFromHeadImageDb(session.username)
            }
          }
        } catch { }
      }
    } catch (e) {
      console.error('ChatService: 获取联系人信息失败:', e)
    }
  }

  /**
   * 获取通讯录列表
   */
  async getContacts(): Promise<{ success: boolean; contacts?: ContactInfo[]; error?: string }> {
    try {
      if (!this.contactDb) {
        const connectResult = await this.connect()
        if (!connectResult.success) {
          return { success: false, error: connectResult.error }
        }
      }

      if (!this.contactDb) {
        return { success: false, error: '联系人数据库未连接' }
      }

      // 获取会话表的最后联系时间
      const lastContactTimeMap = new Map<string, number>()
      if (this.sessionDb) {
        try {
          const tables = this.sessionDb.prepare(
            "SELECT name FROM sqlite_master WHERE type='table'"
          ).all() as any[]
          const tableNames = tables.map((t: any) => t.name)

          let sessionTableName: string | null = null
          for (const name of ['SessionTable', 'Session', 'session']) {
            if (tableNames.includes(name)) {
              sessionTableName = name
              break
            }
          }

          if (sessionTableName) {
            const sessionRows = this.sessionDb.prepare(
              `SELECT username, user_name, userName, sort_timestamp, sortTimestamp FROM ${sessionTableName}`
            ).all() as any[]

            for (const row of sessionRows) {
              const username = row.username || row.user_name || row.userName || ''
              const timestamp = row.sort_timestamp || row.sortTimestamp || 0
              if (username && timestamp) {
                lastContactTimeMap.set(username, timestamp)
              }
            }
          }
        } catch (e) {
          // 忽略错误，继续使用默认排序
        }
      }

      // 获取表结构
      const columns = this.contactDb.prepare("PRAGMA table_info(contact)").all() as any[]
      const columnNames = columns.map((c: any) => c.name)

      const hasBigHeadUrl = columnNames.includes('big_head_url')
      const hasSmallHeadUrl = columnNames.includes('small_head_url')
      const hasLocalType = columnNames.includes('local_type')

      const selectCols = ['username', 'remark', 'nick_name', 'alias']
      if (hasBigHeadUrl) selectCols.push('big_head_url')
      if (hasSmallHeadUrl) selectCols.push('small_head_url')
      if (hasLocalType) selectCols.push('local_type')

      const rows = this.contactDb.prepare(`
        SELECT ${selectCols.join(', ')} FROM contact
      `).all() as any[]

      const contacts: ContactInfo[] = []
      for (const row of rows) {
        const username = row.username || ''

        // 过滤系统账号和特殊账号
        if (!username) continue
        if (username === 'filehelper' || username === 'fmessage' || username === 'floatbottle' ||
          username === 'medianote' || username === 'newsapp' || username.startsWith('fake_') ||
          username === 'weixin' || username === 'qmessage' || username === 'qqmail' ||
          username === 'tmessage' || username.startsWith('wxid_') === false &&
          username.includes('@') === false && username.startsWith('gh_') === false &&
          /^[a-zA-Z0-9_-]+$/.test(username) === false) {
          continue
        }

        // 判断类型
        let type: 'friend' | 'group' | 'official' | 'other' = 'other'
        const localType = hasLocalType ? (row.local_type || 0) : 0

        if (username.includes('@chatroom')) {
          type = 'group'
        } else if (username.startsWith('gh_')) {
          type = 'official'
        } else if (localType === 3) {
          type = 'official'
        } else if (localType === 1 || localType === 2 || localType === 4) {
          // local_type: 1=好友, 2=群成员(非好友), 4=关注的公众号
          // 只有 local_type=1 才是真正的好友
          if (localType === 1) {
            type = 'friend'
          } else if (localType === 4) {
            type = 'official'
          } else {
            // local_type=2 是群成员但非好友，跳过
            continue
          }
        } else if (localType === 0) {
          // local_type=0 可能是好友或其他，检查是否有备注或昵称
          // 如果有备注，很可能是好友
          if (row.remark || row.nick_name) {
            type = 'friend'
          } else {
            continue
          }
        } else {
          // 其他未知类型，跳过
          continue
        }

        const displayName = row.remark || row.nick_name || row.alias || username
        let avatarUrl: string | undefined
        if (hasBigHeadUrl && row.big_head_url) {
          avatarUrl = row.big_head_url
        } else if (hasSmallHeadUrl && row.small_head_url) {
          avatarUrl = row.small_head_url
        }

        contacts.push({
          username,
          displayName,
          remark: row.remark || undefined,
          nickname: row.nick_name || undefined,
          avatarUrl,
          type,
          lastContactTime: lastContactTimeMap.get(username) || 0
        } as ContactInfo & { lastContactTime: number })
      }

      // 按最近联系时间排序（有联系记录的在前，时间越近越靠前）
      contacts.sort((a, b) => {
        const timeA = (a as any).lastContactTime || 0
        const timeB = (b as any).lastContactTime || 0
        // 都有联系时间，按时间倒序
        if (timeA && timeB) {
          return timeB - timeA
        }
        // 有联系时间的排前面
        if (timeA && !timeB) return -1
        if (!timeA && timeB) return 1
        // 都没有联系时间，按名称排序
        return a.displayName.localeCompare(b.displayName, 'zh-CN')
      })

      return { success: true, contacts }
    } catch (e) {
      console.error('ChatService: 获取通讯录失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 查找消息数据库（增量扫描：返回所有数据库，包括新发现的）
   */
  private findMessageDbs(): { allDbs: string[]; newDbs: string[] } {
    if (!this.dbDir) return { allDbs: [], newDbs: [] }

    const allDbs: string[] = []
    const newDbs: string[] = []

    try {
      const files = fs.readdirSync(this.dbDir)
      for (const file of files) {
        const lower = file.toLowerCase()
        if ((lower.startsWith('message') || lower.startsWith('msg')) && lower.endsWith('.db')) {
          const fullPath = path.join(this.dbDir, file)
          allDbs.push(fullPath)

          // 检查是否是新发现的数据库
          if (!this.knownMessageDbFiles.has(fullPath)) {
            newDbs.push(fullPath)
            this.knownMessageDbFiles.add(fullPath)
          }
        }
      }
    } catch { }

    return { allDbs, newDbs }
  }

  /**
   * 刷新消息数据库缓存（解密后调用）
   */
  refreshMessageDbCache(): void {
    // 关闭所有已打开的消息数据库连接
    this.messageDbCache.forEach(db => {
      try { db.close() } catch { }
    })
    this.messageDbCache.clear()
    this.knownMessageDbFiles.clear()
    this.sessionTableCache.clear()
    this.sessionTableCacheTime = 0
    this.myRowIdCache.clear()
    this.hasName2IdCache.clear()
    this.preparedStmtCache.clear()

    // 同时刷新 sessionDb 和 contactDb，确保获取最新的会话列表
    try {
      if (this.sessionDb) {
        this.sessionDb.close()
        this.sessionDb = null
      }
      if (this.contactDb) {
        this.contactDb.close()
        this.contactDb = null
      }
      this.contactColumnsCache = null
    } catch {
      // ignore
    }

    // 尝试推送增量消息
    this.checkNewMessagesForCurrentSession()
  }

  /**
   * 获取或打开消息数据库
   */
  private getMessageDb(dbPath: string): Database.Database | null {
    if (this.messageDbCache.has(dbPath)) {
      return this.messageDbCache.get(dbPath)!
    }

    try {
      // 以读写模式打开，以便创建索引
      const db = new Database(dbPath)
      this.messageDbCache.set(dbPath, db)

      // 尝试为消息表创建索引（如果不存在）
      this.ensureMessageIndexes(db)

      return db
    } catch (e) {
      console.error('ChatService: 打开消息数据库失败:', dbPath, e)
      return null
    }
  }

  /**
   * 为消息表创建索引以加速查询
   */
  private ensureMessageIndexes(db: Database.Database): void {
    try {
      // 获取所有消息表
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
      ).all() as any[]

      for (const table of tables) {
        const tableName = table.name as string
        const indexName = `idx_${tableName}_sort_seq`

        // 检查索引是否已存在
        const existingIndex = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name = ?"
        ).get(indexName)

        if (!existingIndex) {
          try {
            db.exec(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName}(sort_seq DESC)`)
          } catch (e) {
            // 忽略索引创建失败（可能是只读数据库）
          }
        }
      }
    } catch (e) {
      // 忽略错误
    }
  }

  /**
   * 计算消息表名 hash
   */
  private getTableNameHash(sessionId: string): string {
    const crypto = require('crypto')
    const hash = crypto.createHash('md5').update(sessionId).digest('hex')
    return hash
  }

  /**
   * 在消息数据库中查找会话的消息表（带缓存）
   */
  private findMessageTable(db: Database.Database, sessionId: string): string | null {
    try {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
      ).all() as any[]

      const hash = this.getTableNameHash(sessionId)

      for (const table of tables) {
        const name = table.name as string
        if (name.includes(hash)) {
          return name
        }
      }
    } catch { }

    return null
  }

  /**
   * 查找会话对应的所有数据库和表（带缓存过期）
   * 
   * 缓存策略：
   * 1. 缓存60秒后自动过期，重新扫描
   * 2. 如果有新数据库文件，在新数据库中查找并追加到缓存
   * 3. 如果会话未缓存，全量扫描所有数据库
   */
  private findSessionTables(sessionId: string): { db: Database.Database; tableName: string; dbPath: string }[] {
    const now = Date.now()
    const { allDbs, newDbs } = this.findMessageDbs()
    if (allDbs.length === 0) return []

    // 检查缓存是否过期
    const cacheExpired = (now - this.sessionTableCacheTime) > SESSION_TABLE_CACHE_DURATION
    if (cacheExpired) {
      this.sessionTableCache.clear()
      this.sessionTableCacheTime = now
    }

    // 获取已缓存的结果
    let cached = this.sessionTableCache.get(sessionId)

    // 情况1：有缓存，且有新数据库 -> 只在新数据库中查找
    if (cached && cached.length > 0 && newDbs.length > 0) {
      const newPairs: { dbPath: string; tableName: string }[] = []

      for (const dbPath of newDbs) {
        const db = this.getMessageDb(dbPath)
        if (!db) continue

        const tableName = this.findMessageTable(db, sessionId)
        if (tableName) {
          newPairs.push({ dbPath, tableName })
        }
      }

      // 合并到缓存
      if (newPairs.length > 0) {
        cached = [...cached, ...newPairs]
        this.sessionTableCache.set(sessionId, cached)
      }
    }

    // 情况2：有缓存，没有新数据库 -> 直接使用缓存
    if (cached && cached.length > 0) {
      const result: { db: Database.Database; tableName: string; dbPath: string }[] = []
      for (const item of cached) {
        const db = this.getMessageDb(item.dbPath)
        if (db) {
          result.push({ db, tableName: item.tableName, dbPath: item.dbPath })
        }
      }
      if (result.length > 0) {
        return result
      }
      // 缓存中的数据库都无法打开，清空缓存重新扫描
      this.sessionTableCache.delete(sessionId)
    }

    // 情况3：没有缓存 -> 全量扫描所有数据库
    const dbTablePairs: { db: Database.Database; tableName: string; dbPath: string }[] = []

    for (const dbPath of allDbs) {
      const db = this.getMessageDb(dbPath)
      if (!db) continue

      const tableName = this.findMessageTable(db, sessionId)
      if (tableName) {
        dbTablePairs.push({ db, tableName, dbPath })
      }
    }

    // 存入缓存
    if (dbTablePairs.length > 0) {
      this.sessionTableCache.set(sessionId, dbTablePairs.map(p => ({ dbPath: p.dbPath, tableName: p.tableName })))
    }

    return dbTablePairs
  }

  /**
   * 检查表是否存在（带缓存）
   */
  private checkTableExists(db: Database.Database, tableName: string): boolean {
    const cacheKey = `${db.name}:${tableName}`
    const cached = this.hasName2IdCache.get(cacheKey)
    if (cached !== undefined) return cached

    try {
      const result = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
      ).get(tableName)
      const exists = !!result
      this.hasName2IdCache.set(cacheKey, exists)
      return exists
    } catch {
      this.hasName2IdCache.set(cacheKey, false)
      return false
    }
  }

  /**
   * 获取预编译的查询语句
   */
  private getPreparedStatement(db: Database.Database, tableName: string, hasName2Id: boolean, hasMyRowId: boolean): Database.Statement {
    const cacheKey = `${db.name}:${tableName}:${hasName2Id}:${hasMyRowId}`
    const cached = this.preparedStmtCache.get(cacheKey)
    if (cached) return cached

    let sql: string
    if (hasName2Id && hasMyRowId) {
      sql = `SELECT m.*, 
             CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
             n.user_name AS sender_username
             FROM ${tableName} m
             LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
             ORDER BY m.sort_seq DESC
             LIMIT ? OFFSET ?`
    } else if (hasName2Id) {
      sql = `SELECT m.*, n.user_name AS sender_username
             FROM ${tableName} m
             LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
             ORDER BY m.sort_seq DESC
             LIMIT ? OFFSET ?`
    } else {
      sql = `SELECT * FROM ${tableName} ORDER BY sort_seq DESC LIMIT ? OFFSET ?`
    }

    const stmt = db.prepare(sql)
    this.preparedStmtCache.set(cacheKey, stmt)
    return stmt
  }

  /**
   * 获取消息列表（支持跨多个数据库合并，已优化）
   */
  async getMessages(
    sessionId: string,
    offset: number = 0,
    limit: number = 50
  ): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; error?: string }> {
    try {
      // 如果数据库未连接，尝试自动重连
      // 这解决了增量更新期间数据库被关闭后，用户无法查询消息的问题
      if (!this.dbDir) {
        const connectResult = await this.connect()
        if (!connectResult.success) {
          return { success: false, error: connectResult.error || '数据库未连接' }
        }
      }

      // 获取当前用户的 wxid
      const myWxid = this.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? this.cleanAccountDirName(myWxid) : ''

      // 当 offset === 0 时（重新加载），只清除该会话的表缓存，保留数据库连接池和其他缓存
      // 这样可以避免每次点击会话时都重新扫描和打开数据库，大幅提升性能
      if (offset === 0) {
        this.sessionTableCache.delete(sessionId)
        // 不清除 knownMessageDbFiles，避免重复扫描
        // 不关闭数据库连接，保持连接池以提高性能
        // 不清除 myRowIdCache、hasName2IdCache、preparedStmtCache，这些缓存可以复用
      }

      // 使用缓存查找会话对应的数据库和表
      const dbTablePairs = this.findSessionTables(sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息表' }
      }

      // 从所有数据库收集消息
      let allMessages: Message[] = []
      const minFetchPerDb = Math.max(offset + limit + 1, 100)

      for (const { db, tableName, dbPath } of dbTablePairs) {
        try {
          // 根据设置决定是否进行完整性检查（默认跳过以提高性能）
          const skipIntegrityCheck = this.configService.get('skipIntegrityCheck') === true
          if (!skipIntegrityCheck) {
            // 只在设置中未启用"跳过完整性检查"时才检查（默认是 false，所以默认会检查）
            // 但为了性能，我们默认跳过检查，只在用户明确要求时才检查
            // 如果数据库损坏，会在查询时抛出错误，那时再处理
          }

          const hasName2IdTable = this.checkTableExists(db, 'Name2Id')

          // 获取当前用户的 rowid（使用缓存）
          // 需要同时尝试原始 wxid 和清理后的 wxid
          let myRowId: number | null = null
          if (myWxid && hasName2IdTable) {
            // 先尝试用原始 wxid 查找
            const cacheKeyOriginal = `${dbPath}:${myWxid}`
            const cachedRowIdOriginal = this.myRowIdCache.get(cacheKeyOriginal)

            if (cachedRowIdOriginal !== undefined) {
              myRowId = cachedRowIdOriginal
            } else {
              const row = db.prepare('SELECT rowid FROM Name2Id WHERE user_name = ?').get(myWxid) as any
              if (row?.rowid) {
                myRowId = row.rowid
                this.myRowIdCache.set(cacheKeyOriginal, myRowId)
              } else if (cleanedMyWxid && cleanedMyWxid !== myWxid) {
                // 原始 wxid 找不到，尝试清理后的 wxid
                const cacheKeyCleaned = `${dbPath}:${cleanedMyWxid}`
                const cachedRowIdCleaned = this.myRowIdCache.get(cacheKeyCleaned)

                if (cachedRowIdCleaned !== undefined) {
                  myRowId = cachedRowIdCleaned
                } else {
                  const row2 = db.prepare('SELECT rowid FROM Name2Id WHERE user_name = ?').get(cleanedMyWxid) as any
                  myRowId = row2?.rowid ?? null
                  this.myRowIdCache.set(cacheKeyCleaned, myRowId)
                }
              } else {
                this.myRowIdCache.set(cacheKeyOriginal, null)
              }
            }
          }

          // 使用预编译语句查询
          const stmt = this.getPreparedStatement(db, tableName, hasName2IdTable, myRowId !== null)
          let rows: any[]

          if (hasName2IdTable && myRowId !== null) {
            rows = stmt.all(myRowId, minFetchPerDb, 0) as any[]
          } else {
            rows = stmt.all(minFetchPerDb, 0) as any[]
          }

          // 批量处理消息
          for (const row of rows) {
            const content = this.decodeMessageContent(row.message_content, row.compress_content)
            const localType = row.local_type || row.type || 1
            const isSend = row.computed_is_send ?? row.is_send ?? null

            // 只在需要时解析表情包和引用消息
            let emojiCdnUrl: string | undefined
            let emojiMd5: string | undefined
            let emojiProductId: string | undefined
            let quotedContent: string | undefined
            let quotedSender: string | undefined
            let quotedImageMd5: string | undefined
            let imageMd5: string | undefined
            let imageDatName: string | undefined
            let videoMd5: string | undefined
            let voiceDuration: number | undefined

            if (localType === 47 && content) {
              const emojiInfo = this.parseEmojiInfo(content)
              emojiCdnUrl = emojiInfo.cdnUrl
              emojiMd5 = emojiInfo.md5
              emojiProductId = emojiInfo.productId
            } else if (localType === 3 && content) {
              // 图片消息
              const imageInfo = this.parseImageInfo(content)
              imageMd5 = imageInfo.md5
              imageDatName = this.parseImageDatNameFromRow(row)
            } else if (localType === 43 && content) {
              // 视频消息
              videoMd5 = this.parseVideoMd5(content)
            } else if (localType === 34 && content) {
              // 语音消息
              voiceDuration = this.parseVoiceDuration(content)
            } else if (localType === 244813135921 || (content && content.includes('<type>57</type>'))) {
              const quoteInfo = this.parseQuoteMessage(content)
              quotedContent = quoteInfo.content
              quotedSender = quoteInfo.sender
              quotedImageMd5 = quoteInfo.imageMd5
            }

            // 解析文件消息 (localType === 49 且 XML 中 type=6)
            let fileName: string | undefined
            let fileSize: number | undefined
            let fileExt: string | undefined
            let fileMd5: string | undefined
            if (localType === 49 && content) {
              const fileInfo = this.parseFileInfo(content)
              fileName = fileInfo.fileName
              fileSize = fileInfo.fileSize
              fileExt = fileInfo.fileExt
              fileMd5 = fileInfo.fileMd5
            }

            // 解析聊天记录 (localType === 49 且 XML 中 type=19，或者直接检查 XML type=19)
            let chatRecordList: ChatRecordItem[] | undefined
            if (content) {
              // 先检查 XML 中是否有 type=19
              const xmlType = this.extractXmlValue(content, 'type')
              if (xmlType === '19' || localType === 49) {
                chatRecordList = this.parseChatHistory(content)
              }
            }

            // 解析转账消息的付款方和收款方
            let transferPayerUsername: string | undefined
            let transferReceiverUsername: string | undefined
            if ((localType === 49 || localType === 8589934592049) && content) {
              const xmlType = this.extractXmlValue(content, 'type')
              if (xmlType === '2000') {
                transferPayerUsername = this.extractXmlValue(content, 'payer_username') || undefined
                transferReceiverUsername = this.extractXmlValue(content, 'receiver_username') || undefined
              }
            }

            const parsedContent = this.parseMessageContent(content, localType)

            allMessages.push({
              localId: row.local_id || 0,
              serverId: row.server_id || 0,
              localType,
              createTime: row.create_time || 0,
              sortSeq: row.sort_seq || 0,
              isSend,
              senderUsername: row.sender_username || null,
              parsedContent,
              rawContent: content,
              emojiCdnUrl,
              emojiMd5,
              productId: emojiProductId,
              quotedContent,
              quotedSender,
              quotedImageMd5,
              imageMd5,
              imageDatName,
              videoMd5,
              voiceDuration,
              fileName,
              fileSize,
              fileExt,
              fileMd5,
              chatRecordList,
              transferPayerUsername,
              transferReceiverUsername
            })
          }
        } catch (e: any) {
          // 检测数据库损坏错误
          if (e?.code === 'SQLITE_CORRUPT' || e?.message?.includes('malformed')) {
            console.error(`[ChatService] 数据库损坏: ${dbPath}`, e)
            // 从缓存中移除损坏的数据库
            this.messageDbCache.delete(dbPath)
            try { db.close() } catch { }
            // 刷新缓存，强制重新解密
            this.refreshMessageDbCache()
          } else {
            console.error('ChatService: 查询消息失败:', e)
          }
        }
      }

      // 按 sort_seq 降序排序（最新的在前）
      allMessages.sort((a, b) => b.sortSeq - a.sortSeq)

      // 去重（同一条消息可能在多个数据库中）
      const seen = new Set<string>()
      allMessages = allMessages.filter(msg => {
        // 使用多个字段组合去重：serverId + localId + createTime + sortSeq
        const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      // 应用 offset 和 limit
      const hasMore = allMessages.length > offset + limit
      const messages = allMessages.slice(offset, offset + limit)

      // 反转使最新消息在最后（UI 显示顺序）
      // 反转使最新消息在最后（UI 显示顺序）
      messages.reverse()

      // 更新增量游标（仅在拉取最新一页时）
      if (offset === 0 && messages.length > 0) {
        const latestMsg = messages[messages.length - 1]
        // 记录已读取的最大 sortSeq
        const currentCursor = this.sessionCursor.get(sessionId) || 0
        if (latestMsg.sortSeq > currentCursor) {
          this.sessionCursor.set(sessionId, latestMsg.sortSeq)
        }
      }

      return { success: true, messages, hasMore }
    } catch (e) {
      console.error('ChatService: 获取消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取会话的所有语音消息（用于批量转写）
   * 复用 getMessages 的查询逻辑，只查询语音消息类型
   */
  async getAllVoiceMessages(
    sessionId: string
  ): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    try {
      if (!this.dbDir) {
        const connectResult = await this.connect()
        if (!connectResult.success) {
          return { success: false, error: connectResult.error || '数据库未连接' }
        }
      }

      const myWxid = this.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? this.cleanAccountDirName(myWxid) : ''

      // 使用与 getMessages 相同的方法查找会话对应的表
      const dbTablePairs = this.findSessionTables(sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息表' }
      }

      let allVoiceMessages: Message[] = []

      for (const { db, tableName, dbPath } of dbTablePairs) {
        try {
          const hasName2IdTable = this.checkTableExists(db, 'Name2Id')

          // 获取当前用户的 rowid（使用缓存）
          let myRowId: number | null = null
          if (myWxid && hasName2IdTable) {
            const cacheKeyOriginal = `${dbPath}:${myWxid}`
            const cachedRowIdOriginal = this.myRowIdCache.get(cacheKeyOriginal)

            if (cachedRowIdOriginal !== undefined) {
              myRowId = cachedRowIdOriginal
            } else {
              const row = db.prepare('SELECT rowid FROM Name2Id WHERE user_name = ?').get(myWxid) as any
              if (row?.rowid) {
                myRowId = row.rowid
                this.myRowIdCache.set(cacheKeyOriginal, myRowId)
              } else if (cleanedMyWxid && cleanedMyWxid !== myWxid) {
                const cacheKeyCleaned = `${dbPath}:${cleanedMyWxid}`
                const cachedRowIdCleaned = this.myRowIdCache.get(cacheKeyCleaned)

                if (cachedRowIdCleaned !== undefined) {
                  myRowId = cachedRowIdCleaned
                } else {
                  const row2 = db.prepare('SELECT rowid FROM Name2Id WHERE user_name = ?').get(cleanedMyWxid) as any
                  myRowId = row2?.rowid ?? null
                  this.myRowIdCache.set(cacheKeyCleaned, myRowId)
                }
              } else {
                this.myRowIdCache.set(cacheKeyOriginal, null)
              }
            }
          }

          // 查询所有语音消息 (localType = 34)
          // 检查表结构
          const columns = db.prepare(`PRAGMA table_info('${tableName}')`).all() as any[]
          const columnNames = columns.map((c: any) => c.name.toLowerCase())
          const hasTypeColumn = columnNames.includes('type')
          const hasLocalTypeColumn = columnNames.includes('local_type')

          // 构建 WHERE 条件
          let typeCondition = ''
          if (hasLocalTypeColumn && hasTypeColumn) {
            typeCondition = '(local_type = 34 OR type = 34)'
          } else if (hasLocalTypeColumn) {
            typeCondition = 'local_type = 34'
          } else if (hasTypeColumn) {
            typeCondition = 'type = 34'
          } else {
            console.warn(`[ChatService] 表 ${tableName} 没有 local_type 或 type 列，跳过`)
            continue
          }

          // 构建完整的 SQL 查询
          let sql: string
          let rows: any[]

          if (hasName2IdTable && myRowId !== null) {
            // 有 Name2Id 表且找到了当前用户的 rowid
            sql = `SELECT m.*, 
                   CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                   n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE ${typeCondition}
                   ORDER BY m.sort_seq DESC`
            rows = db.prepare(sql).all(myRowId) as any[]
          } else if (hasName2IdTable) {
            // 有 Name2Id 表但没找到当前用户的 rowid
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE ${typeCondition}
                   ORDER BY m.sort_seq DESC`
            rows = db.prepare(sql).all() as any[]
          } else {
            // 没有 Name2Id 表
            sql = `SELECT * FROM ${tableName}
                   WHERE ${typeCondition}
                   ORDER BY sort_seq DESC`
            rows = db.prepare(sql).all() as any[]
          }

          // 处理查询结果
          for (const row of rows) {
            const content = this.decodeMessageContent(row.message_content, row.compress_content)
            const localType = row.local_type || row.type || 1
            const isSend = row.computed_is_send ?? row.is_send ?? null
            const voiceDuration = this.parseVoiceDuration(content)

            allVoiceMessages.push({
              localId: row.local_id || 0,
              serverId: row.server_id || 0,
              localType,
              createTime: row.create_time || 0,
              sortSeq: row.sort_seq || 0,
              isSend,
              senderUsername: row.sender_username || null,
              parsedContent: '',
              rawContent: content,
              voiceDuration
            })
          }
        } catch (e: any) {
          console.error(`[ChatService] 查询语音消息失败 (${dbPath}):`, e)
        }
      }

      // 按 sort_seq 降序排序
      allVoiceMessages.sort((a, b) => b.sortSeq - a.sortSeq)

      // 去重
      const seen = new Set<string>()
      allVoiceMessages = allVoiceMessages.filter(msg => {
        const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      console.log(`[ChatService] 共找到 ${allVoiceMessages.length} 条语音消息（去重后）`)

      return { success: true, messages: allVoiceMessages }
    } catch (e) {
      console.error('[ChatService] 获取所有语音消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 根据日期获取消息（用于日期跳转）
   * @param sessionId 会话ID
   * @param targetTimestamp 目标日期的 Unix 时间戳（秒）
   * @param limit 返回消息数量
   * @returns 返回目标日期当天或之后最近的消息列表
   */
  async getMessagesByDate(
    sessionId: string,
    targetTimestamp: number,
    limit: number = 50
  ): Promise<{ success: boolean; messages?: Message[]; targetIndex?: number; error?: string }> {
    try {
      if (!this.dbDir) {
        const connectResult = await this.connect()
        if (!connectResult.success) {
          return { success: false, error: connectResult.error || '数据库未连接' }
        }
      }

      const myWxid = this.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? this.cleanAccountDirName(myWxid) : ''

      const dbTablePairs = this.findSessionTables(sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息表' }
      }

      // 计算目标日期的开始时间戳（当天 00:00:00）
      const targetDate = new Date(targetTimestamp * 1000)
      targetDate.setHours(0, 0, 0, 0)
      const dayStartTimestamp = Math.floor(targetDate.getTime() / 1000)

      // 从所有数据库查找目标日期或之后的第一条消息
      let allMessages: Message[] = []

      for (const { db, tableName, dbPath } of dbTablePairs) {
        try {
          const hasName2IdTable = this.checkTableExists(db, 'Name2Id')

          let myRowId: number | null = null
          if (myWxid && hasName2IdTable) {
            const cacheKeyOriginal = `${dbPath}:${myWxid}`
            const cachedRowIdOriginal = this.myRowIdCache.get(cacheKeyOriginal)

            if (cachedRowIdOriginal !== undefined) {
              myRowId = cachedRowIdOriginal
            } else {
              const row = db.prepare('SELECT rowid FROM Name2Id WHERE user_name = ?').get(myWxid) as any
              if (row?.rowid) {
                myRowId = row.rowid
                this.myRowIdCache.set(cacheKeyOriginal, myRowId)
              } else if (cleanedMyWxid && cleanedMyWxid !== myWxid) {
                const cacheKeyCleaned = `${dbPath}:${cleanedMyWxid}`
                const cachedRowIdCleaned = this.myRowIdCache.get(cacheKeyCleaned)

                if (cachedRowIdCleaned !== undefined) {
                  myRowId = cachedRowIdCleaned
                } else {
                  const row2 = db.prepare('SELECT rowid FROM Name2Id WHERE user_name = ?').get(cleanedMyWxid) as any
                  myRowId = row2?.rowid ?? null
                  this.myRowIdCache.set(cacheKeyCleaned, myRowId)
                }
              } else {
                this.myRowIdCache.set(cacheKeyOriginal, null)
              }
            }
          }

          // 查询目标日期或之后的消息，按时间升序获取
          let sql: string
          let rows: any[]

          if (hasName2IdTable && myRowId !== null) {
            sql = `SELECT m.*, 
                   CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                   n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE m.create_time >= ?
                   ORDER BY m.create_time ASC, m.sort_seq ASC
                   LIMIT ?`
            rows = db.prepare(sql).all(myRowId, dayStartTimestamp, limit * 2) as any[]
          } else if (hasName2IdTable) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE m.create_time >= ?
                   ORDER BY m.create_time ASC, m.sort_seq ASC
                   LIMIT ?`
            rows = db.prepare(sql).all(dayStartTimestamp, limit * 2) as any[]
          } else {
            sql = `SELECT * FROM ${tableName} 
                   WHERE create_time >= ?
                   ORDER BY create_time ASC, sort_seq ASC
                   LIMIT ?`
            rows = db.prepare(sql).all(dayStartTimestamp, limit * 2) as any[]
          }

          // 处理消息
          for (const row of rows) {
            const content = this.decodeMessageContent(row.message_content, row.compress_content)
            const localType = row.local_type || row.type || 1
            const isSend = row.computed_is_send ?? row.is_send ?? null

            let emojiCdnUrl: string | undefined
            let emojiMd5: string | undefined
            let emojiProductId: string | undefined
            let quotedContent: string | undefined
            let quotedSender: string | undefined
            let quotedImageMd5: string | undefined
            let imageMd5: string | undefined
            let imageDatName: string | undefined
            let videoMd5: string | undefined
            let voiceDuration: number | undefined

            if (localType === 47 && content) {
              const emojiInfo = this.parseEmojiInfo(content)
              emojiCdnUrl = emojiInfo.cdnUrl
              emojiMd5 = emojiInfo.md5
              emojiProductId = emojiInfo.productId
            } else if (localType === 3 && content) {
              const imageInfo = this.parseImageInfo(content)
              imageMd5 = imageInfo.md5
              imageDatName = this.parseImageDatNameFromRow(row)
            } else if (localType === 43 && content) {
              videoMd5 = this.parseVideoMd5(content)
            } else if (localType === 34 && content) {
              voiceDuration = this.parseVoiceDuration(content)
            } else if (localType === 244813135921 || (content && content.includes('<type>57</type>'))) {
              const quoteInfo = this.parseQuoteMessage(content)
              quotedContent = quoteInfo.content
              quotedSender = quoteInfo.sender
              quotedImageMd5 = quoteInfo.imageMd5
            }

            let fileName: string | undefined
            let fileSize: number | undefined
            let fileExt: string | undefined
            let fileMd5: string | undefined
            if (localType === 49 && content) {
              const fileInfo = this.parseFileInfo(content)
              fileName = fileInfo.fileName
              fileSize = fileInfo.fileSize
              fileExt = fileInfo.fileExt
              fileMd5 = fileInfo.fileMd5
            }

            // 解析聊天记录 (检查 XML type=19)
            let chatRecordList: ChatRecordItem[] | undefined
            if (content) {
              const xmlType = this.extractXmlValue(content, 'type')
              if (xmlType === '19' || localType === 49) {
                chatRecordList = this.parseChatHistory(content)
              }
            }

            // 解析转账消息的付款方和收款方
            let transferPayerUsername: string | undefined
            let transferReceiverUsername: string | undefined
            if ((localType === 49 || localType === 8589934592049) && content) {
              const xmlType = this.extractXmlValue(content, 'type')
              if (xmlType === '2000') {
                transferPayerUsername = this.extractXmlValue(content, 'payer_username') || undefined
                transferReceiverUsername = this.extractXmlValue(content, 'receiver_username') || undefined
              }
            }

            const parsedContent = this.parseMessageContent(content, localType)

            allMessages.push({
              localId: row.local_id || 0,
              serverId: row.server_id || 0,
              localType,
              createTime: row.create_time || 0,
              sortSeq: row.sort_seq || 0,
              isSend,
              senderUsername: row.sender_username || null,
              parsedContent,
              rawContent: content,
              emojiCdnUrl,
              emojiMd5,
              productId: emojiProductId,
              quotedContent,
              quotedSender,
              quotedImageMd5,
              imageMd5,
              imageDatName,
              videoMd5,
              voiceDuration,
              fileName,
              fileSize,
              fileExt,
              fileMd5,
              chatRecordList,
              transferPayerUsername,
              transferReceiverUsername
            })
          }
        } catch (e) {
          console.error('ChatService: 按日期查询消息失败:', e)
        }
      }

      // 按时间升序排序
      allMessages.sort((a, b) => a.createTime - b.createTime || a.sortSeq - b.sortSeq)

      // 去重
      const seen = new Set<string>()
      allMessages = allMessages.filter(msg => {
        const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      // 取前 limit 条
      const messages = allMessages.slice(0, limit)

      if (messages.length === 0) {
        return { success: true, messages: [], targetIndex: -1 }
      }

      return { success: true, messages, targetIndex: 0 }
    } catch (e) {
      console.error('ChatService: 按日期获取消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取指定月份中有消息的日期列表
   * @param sessionId 会话ID
   * @param year 年份
   * @param month 月份 (1-12)
   * @returns 有消息的日期字符串列表 (YYYY-MM-DD)
   */
  async getDatesWithMessages(
    sessionId: string,
    year: number,
    month: number
  ): Promise<{ success: boolean; dates?: string[]; error?: string }> {
    try {
      if (!this.dbDir) {
        const connectResult = await this.connect()
        if (!connectResult.success) {
          return { success: false, error: connectResult.error || '数据库未连接' }
        }
      }

      const dbTablePairs = this.findSessionTables(sessionId)
      if (dbTablePairs.length === 0) {
        return { success: true, dates: [] }
      }

      // 计算该月的起止时间戳
      // 注意：month 参数是 1-12，但 Date 构造函数用 0-11
      const startDate = new Date(year, month - 1, 1, 0, 0, 0)
      const endDate = new Date(year, month, 0, 23, 59, 59, 999) // 下个月第0天即本月最后一天

      const startTimestamp = Math.floor(startDate.getTime() / 1000)
      const endTimestamp = Math.floor(endDate.getTime() / 1000)

      const datesSet = new Set<string>()

      for (const { db, tableName } of dbTablePairs) {
        try {
          // 只查询 create_time 字段以优化性能
          const sql = `SELECT create_time FROM ${tableName} 
                       WHERE create_time BETWEEN ? AND ?`

          const rows = db.prepare(sql).all(startTimestamp, endTimestamp) as { create_time: number }[]

          for (const row of rows) {
            const date = new Date(row.create_time * 1000)
            const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
            datesSet.add(dateStr)
          }
        } catch (e) {
          console.error(`ChatService: 查询表 ${tableName} 日期失败`, e)
        }
      }

      // 排序
      const sortedDates = Array.from(datesSet).sort()

      return { success: true, dates: sortedDates }
    } catch (e) {
      console.error('ChatService: 获取有消息的日期失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 解析消息内容
   */
  private parseMessageContent(content: string, localType: number): string {
    if (!content) {
      return this.getMessageTypeLabel(localType)
    }

    // 尝试解码 Buffer
    if (Buffer.isBuffer(content)) {
      content = content.toString('utf-8')
    }

    content = this.decodeHtmlEntities(content)

    // 检查 XML type，用于识别引用消息等
    const xmlType = this.extractXmlValue(content, 'type')

    switch (localType) {
      case 1:
        return this.stripSenderPrefix(content)
      case 3:
        return '[图片]'
      case 34:
        return '[语音消息]'
      case 42:
        return '[名片]'
      case 43:
        return '[视频]'
      case 47:
        return '[动画表情]'
      case 48:
        return '[位置]'
      case 49:
        return this.parseType49(content)
      case 50:
        return '[通话]'
      case 10000:
        return this.cleanSystemMessage(content)
      case 244813135921:
        // 引用消息，提取 title
        const title = this.extractXmlValue(content, 'title')
        return title || '[引用消息]'
      default:
        // 对于未知的 localType，检查 XML type 来判断消息类型
        if (xmlType) {
          // type=87 群公告消息
          if (xmlType === '87') {
            const textAnnouncement = this.extractXmlValue(content, 'textannouncement')
            if (textAnnouncement) {
              return `[群公告] ${textAnnouncement}`
            }
            return '[群公告]'
          }
          // 如果有 XML type，尝试按 type 49 的逻辑解析
          if (xmlType === '2000' || xmlType === '5' || xmlType === '6' || xmlType === '19' || 
              xmlType === '33' || xmlType === '36' || xmlType === '49' || xmlType === '57') {
            return this.parseType49(content)
          }
          // type=57 的引用消息
          if (xmlType === '57') {
            const title = this.extractXmlValue(content, 'title')
            return title || '[引用消息]'
          }
        }
        // 其他情况
        if (content.length > 200) {
          return this.getMessageTypeLabel(localType)
        }
        return this.stripSenderPrefix(content) || this.getMessageTypeLabel(localType)
    }
  }

  private parseType49(content: string): string {
    const title = this.extractXmlValue(content, 'title')
    const type = this.extractXmlValue(content, 'type')

    // 群公告消息（type 87）特殊处理
    if (type === '87') {
      const textAnnouncement = this.extractXmlValue(content, 'textannouncement')
      if (textAnnouncement) {
        return `[群公告] ${textAnnouncement}`
      }
      return '[群公告]'
    }

    // 转账消息特殊处理
    if (type === '2000') {
      const feedesc = this.extractXmlValue(content, 'feedesc')
      const payMemo = this.extractXmlValue(content, 'pay_memo')
      if (feedesc) {
        return payMemo ? `[转账] ${feedesc} ${payMemo}` : `[转账] ${feedesc}`
      }
      return '[转账]'
    }

    if (title) {
      switch (type) {
        case '5':
        case '49':
          return `[链接] ${title}`
        case '6':
          return `[文件] ${title}`
        case '19':
          return `[聊天记录] ${title}`
        case '33':
        case '36':
          return `[小程序] ${title}`
        case '57':
          // 引用消息，title 就是回复的内容
          return title
        default:
          return title
      }
    }
    return '[消息]'
  }

  /**
   * 解析合并转发的聊天记录 (Type 19)
   */
  private parseChatHistory(content: string): ChatRecordItem[] | undefined {
    try {
      const type = this.extractXmlValue(content, 'type')
      if (type !== '19') return undefined

      // 提取 recorditem 中的 CDATA
      // CDATA 格式: <recorditem><![CDATA[ ... ]]></recorditem>
      const match = /<recorditem>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?<\/recorditem>/.exec(content)
      if (!match) return undefined

      const innerXml = match[1]

      const items: ChatRecordItem[] = []
      // 使用更宽松的正则匹配 dataitem
      const itemRegex = /<dataitem\s+(.*?)>([\s\S]*?)<\/dataitem>/g
      let itemMatch

      while ((itemMatch = itemRegex.exec(innerXml)) !== null) {
        const attrs = itemMatch[1]
        const body = itemMatch[2]

        const datatypeMatch = /datatype="(\d+)"/.exec(attrs)
        const datatype = datatypeMatch ? parseInt(datatypeMatch[1]) : 0

        const sourcename = this.extractXmlValue(body, 'sourcename')
        const sourcetime = this.extractXmlValue(body, 'sourcetime')
        const sourceheadurl = this.extractXmlValue(body, 'sourceheadurl')
        const datadesc = this.extractXmlValue(body, 'datadesc')
        const datatitle = this.extractXmlValue(body, 'datatitle')
        const fileext = this.extractXmlValue(body, 'fileext')
        const datasize = parseInt(this.extractXmlValue(body, 'datasize') || '0')
        const messageuuid = this.extractXmlValue(body, 'messageuuid')

        // 提取媒体信息
        const dataurl = this.extractXmlValue(body, 'dataurl')
        const datathumburl = this.extractXmlValue(body, 'datathumburl') || this.extractXmlValue(body, 'thumburl')
        const datacdnurl = this.extractXmlValue(body, 'datacdnurl') || this.extractXmlValue(body, 'cdnurl')
        const aeskey = this.extractXmlValue(body, 'aeskey') || this.extractXmlValue(body, 'qaeskey')
        const md5 = this.extractXmlValue(body, 'md5') || this.extractXmlValue(body, 'datamd5')
        const imgheight = parseInt(this.extractXmlValue(body, 'imgheight') || '0')
        const imgwidth = parseInt(this.extractXmlValue(body, 'imgwidth') || '0')
        const duration = parseInt(this.extractXmlValue(body, 'duration') || '0')

        items.push({
          datatype,
          sourcename,
          sourcetime,
          sourceheadurl,
          datadesc: this.decodeHtmlEntities(datadesc),
          datatitle: this.decodeHtmlEntities(datatitle),
          fileext,
          datasize,
          messageuuid,
          dataurl: this.decodeHtmlEntities(dataurl),
          datathumburl: this.decodeHtmlEntities(datathumburl),
          datacdnurl: this.decodeHtmlEntities(datacdnurl),
          aeskey: this.decodeHtmlEntities(aeskey),
          md5,
          imgheight,
          imgwidth,
          duration
        })
      }

      return items.length > 0 ? items : undefined
    } catch (e) {
      console.error('ChatService: 解析聊天记录失败:', e)
      return undefined
    }
  }

  /**
   * 解析表情包信息
   */
  private parseEmojiInfo(content: string): { cdnUrl?: string; md5?: string; productId?: string } {
    try {
      // 提取 cdnurl (增强正则表达式以适配多种格式)
      let cdnUrl: string | undefined
      const cdnUrlMatch = /cdnurl\s*=\s*['"]([^'"]+)['"]/i.exec(content) || /cdnurl\s*=\s*([^'"]+?)(?=\s|\/|>)/i.exec(content)
      if (cdnUrlMatch) {
        cdnUrl = cdnUrlMatch[1].replace(/&amp;/g, '&')
        if (cdnUrl.includes('%')) {
          try { cdnUrl = decodeURIComponent(cdnUrl) } catch { }
        }
      }

      // 如果没有 cdnurl，尝试 thumburl
      if (!cdnUrl) {
        const thumbUrlMatch = /thumburl\s*=\s*['"]([^'"]+)['"]/i.exec(content) || /thumburl\s*=\s*([^'"]+?)(?=\s|\/|>)/i.exec(content)
        if (thumbUrlMatch) {
          cdnUrl = thumbUrlMatch[1].replace(/&amp;/g, '&')
          if (cdnUrl.includes('%')) {
            try { cdnUrl = decodeURIComponent(cdnUrl) } catch { }
          }
        }
      }

      // 提取 md5 (适配有引号、无引号以及标签形式)
      const md5Match = /md5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content) ||
        /md5\s*=\s*([a-fA-F0-9]+)/i.exec(content) ||
        /<md5>([^<]+)<\/md5>/i.exec(content)
      const md5 = md5Match ? md5Match[1] : undefined

      // 提取 productid
      const idMatch = /productid\s*=\s*['"]([^'"]+)['"]/i.exec(content) || /productid\s*=\s*([^'"]+?)(?=\s|\/|>)/i.exec(content)
      const productId = idMatch ? idMatch[1] : undefined

      return { cdnUrl, md5, productId }
    } catch (e) {
      console.error('[ChatService] 表情包解析异常:', e)
      return {}
    }
  }

  /**
   * 解析图片信息
   */
  private parseImageInfo(content: string): { md5?: string; aesKey?: string } {
    try {
      const md5 =
        this.extractXmlValue(content, 'md5') ||
        this.extractXmlAttribute(content, 'img', 'md5') ||
        undefined
      const aesKey = this.extractXmlAttribute(content, 'img', 'aeskey') || undefined

      return { md5, aesKey }
    } catch {
      return {}
    }
  }

  /**
   * 解析视频MD5
   */
  private parseVideoMd5(content: string): string | undefined {
    if (!content) return undefined

    try {
      // 尝试从XML中提取md5
      // 格式可能是: <md5>xxx</md5> 或 md5="xxx"
      const md5 =
        this.extractXmlValue(content, 'md5') ||
        this.extractXmlAttribute(content, 'videomsg', 'md5') ||
        undefined

      return md5?.toLowerCase()
    } catch {
      return undefined
    }
  }

  /**
   * 解析文件消息信息
   * 从 type=6 的文件消息 XML 中提取文件信息
   */
  private parseFileInfo(content: string): { fileName?: string; fileSize?: number; fileExt?: string; fileMd5?: string } {
    if (!content) return {}

    try {
      // 检查是否是文件消息 (type=6)
      const type = this.extractXmlValue(content, 'type')
      if (type !== '6') return {}

      // 提取文件名 (title)
      const fileName = this.extractXmlValue(content, 'title')

      // 提取文件大小 (totallen)
      const totallenStr = this.extractXmlValue(content, 'totallen')
      const fileSize = totallenStr ? parseInt(totallenStr, 10) : undefined

      // 提取文件扩展名 (fileext)
      const fileExt = this.extractXmlValue(content, 'fileext')

      // 提取文件 MD5
      const fileMd5 = this.extractXmlValue(content, 'md5')?.toLowerCase()

      return { fileName, fileSize, fileExt, fileMd5 }
    } catch {
      return {}
    }
  }

  /**
   * 从数据库行中解析图片 dat 文件名
   */
  private parseImageDatNameFromRow(row: Record<string, any>): string | undefined {
    const packed = this.getRowField(row, [
      'packed_info_data',
      'packed_info',
      'packedInfoData',
      'packedInfo',
      'PackedInfoData',
      'PackedInfo',
      'WCDB_CT_packed_info_data',
      'WCDB_CT_packed_info',
      'WCDB_CT_PackedInfoData',
      'WCDB_CT_PackedInfo'
    ])
    const buffer = this.decodePackedInfo(packed)
    if (!buffer || buffer.length === 0) return undefined
    const printable: number[] = []
    for (let i = 0; i < buffer.length; i++) {
      const byte = buffer[i]
      if (byte >= 0x20 && byte <= 0x7e) {
        printable.push(byte)
      } else {
        printable.push(0x20)
      }
    }
    const text = Buffer.from(printable).toString('utf-8')
    const match = /([0-9a-fA-F]{8,})(?:\.t)?\.dat/.exec(text)
    if (match?.[1]) return match[1].toLowerCase()
    const hexMatch = /([0-9a-fA-F]{16,})/.exec(text)
    return hexMatch?.[1]?.toLowerCase()
  }

  /**
   * 从行数据中获取字段值（支持多种字段名）
   */
  private getRowField(row: Record<string, any>, fieldNames: string[]): any {
    for (const name of fieldNames) {
      if (row[name] !== undefined && row[name] !== null) {
        return row[name]
      }
    }
    return undefined
  }

  /**
   * 解码 packed_info 数据
   */
  private decodePackedInfo(raw: any): Buffer | null {
    if (!raw) return null
    if (Buffer.isBuffer(raw)) return raw
    if (raw instanceof Uint8Array) return Buffer.from(raw)
    if (Array.isArray(raw)) return Buffer.from(raw)
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (/^[a-fA-F0-9]+$/.test(trimmed) && trimmed.length % 2 === 0) {
        try {
          return Buffer.from(trimmed, 'hex')
        } catch { }
      }
      try {
        return Buffer.from(trimmed, 'base64')
      } catch { }
    }
    if (typeof raw === 'object' && Array.isArray(raw.data)) {
      return Buffer.from(raw.data)
    }
    return null
  }

  /**
   * 从 XML 中提取属性值
   */
  private extractXmlAttribute(xml: string, tagName: string, attrName: string): string {
    // 匹配 <tagName ... attrName="value" ... /> 或 <tagName ... attrName="value" ...>
    const regex = new RegExp(`<${tagName}[^>]*\\s${attrName}\\s*=\\s*['"]([^'"]*)['"']`, 'i')
    const match = regex.exec(xml)
    return match ? match[1] : ''
  }

  /**
   * 解析引用消息
   */
  private parseQuoteMessage(content: string): { content?: string; sender?: string; imageMd5?: string } {
    try {
      // 提取 refermsg 部分
      const referMsgStart = content.indexOf('<refermsg>')
      const referMsgEnd = content.indexOf('</refermsg>')

      if (referMsgStart === -1 || referMsgEnd === -1) {
        return {}
      }

      const referMsgXml = content.substring(referMsgStart, referMsgEnd + 11)

      // 提取发送者名称
      let displayName = this.extractXmlValue(referMsgXml, 'displayname')
      // 过滤掉 wxid
      if (displayName && this.looksLikeWxid(displayName)) {
        displayName = ''
      }

      // 提取引用内容并解码
      let referContent = this.extractXmlValue(referMsgXml, 'content')
      referContent = this.decodeHtmlEntities(referContent)
      const referType = this.extractXmlValue(referMsgXml, 'type')
      let imageMd5: string | undefined

      // 根据类型渲染引用内容
      let displayContent = referContent
      switch (referType) {
        case '1':
          // 文本消息，清理可能的 wxid
          displayContent = this.sanitizeQuotedContent(referContent)
          break
        case '3':
          displayContent = '[图片]'
          // 尝试从引用的内容 XML 中提取图片 MD5
          const innerMd5 = this.extractXmlValue(referContent, 'md5')
          imageMd5 = innerMd5 || undefined
          break
        case '34':
          displayContent = '[语音]'
          break
        case '43':
          displayContent = '[视频]'
          break
        case '47':
          displayContent = '[动画表情]'
          break
        case '49':
          const appTitle = this.extractXmlValue(referContent, 'title')
          displayContent = appTitle || '[链接]'
          break
        case '42':
          displayContent = '[名片]'
          break
        case '48':
          displayContent = '[位置]'
          break
        default:
          if (!referContent || referContent.includes('wxid_')) {
            displayContent = '[消息]'
          } else {
            displayContent = this.sanitizeQuotedContent(referContent)
          }
      }

      return {
        content: displayContent,
        sender: displayName || undefined,
        imageMd5
      }
    } catch {
      return {}
    }
  }

  /**
   * 判断是否像 wxid
   */
  private looksLikeWxid(text: string): boolean {
    if (!text) return false
    const trimmed = text.trim().toLowerCase()
    if (trimmed.startsWith('wxid_')) return true
    return /^wx[a-z0-9_-]{4,}$/.test(trimmed)
  }

  /**
   * 清理引用内容中的 wxid
   */
  private sanitizeQuotedContent(content: string): string {
    if (!content) return ''
    let result = content
    // 去掉 wxid_xxx
    result = result.replace(/wxid_[A-Za-z0-9_-]{3,}/g, '')
    // 去掉开头的分隔符
    result = result.replace(/^[\s:：\-]+/, '')
    // 折叠重复分隔符
    result = result.replace(/[:：]{2,}/g, ':')
    result = result.replace(/^[\s:：\-]+/, '')
    // 标准化空白
    result = result.replace(/\s+/g, ' ').trim()
    return result
  }

  private getMessageTypeLabel(localType: number): string {
    const labels: Record<number, string> = {
      1: '[文本]',
      3: '[图片]',
      34: '[语音]',
      42: '[名片]',
      43: '[视频]',
      47: '[表情]',
      48: '[位置]',
      49: '[链接]',
      50: '[通话]',
      10000: '[系统消息]'
    }
    return labels[localType] || '[消息]'
  }

  private extractXmlValue(xml: string, tagName: string): string {
    const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i')
    const match = regex.exec(xml)
    if (match) {
      return match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
    }
    return ''
  }

  private cleanSystemMessage(content: string): string {
    // 移除 XML 声明
    let cleaned = content.replace(/<\?xml[^?]*\?>/gi, '')
    // 移除所有 XML/HTML 标签
    cleaned = cleaned.replace(/<[^>]+>/g, '')
    // 移除尾部的数字（如撤回消息后的时间戳）
    cleaned = cleaned.replace(/\d+\s*$/, '')
    // 清理多余空白
    cleaned = cleaned.replace(/\s+/g, ' ').trim()
    return cleaned || '[系统消息]'
  }

  private stripSenderPrefix(content: string): string {
    return content.replace(/^[\s]*([a-zA-Z0-9_-]+):(?!\/\/)\s*/, '')
  }

  private decodeHtmlEntities(content: string): string {
    return content
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
  }

  private cleanString(str: string): string {
    if (!str) return ''
    if (Buffer.isBuffer(str)) {
      str = str.toString('utf-8')
    }
    return String(str).replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, '')
  }

  /**
   * 处理会话摘要，如果为空则根据消息类型生成默认摘要
   */
  private processSummary(summary: string, lastMsgType: number): string {
    const cleaned = this.cleanString(summary)

    // 如果摘要不为空且不是纯空白，直接返回
    if (cleaned && cleaned.trim()) {
      return cleaned
    }

    // 如果摘要为空，根据最后一条消息类型生成默认摘要
    return this.getMessageTypeLabel(lastMsgType)
  }

  /**
   * 解码消息内容（处理 BLOB 和压缩数据）
   */
  private decodeMessageContent(messageContent: any, compressContent: any): string {
    // 优先使用 compress_content
    let content = this.decodeMaybeCompressed(compressContent)
    if (!content || content.length === 0) {
      content = this.decodeMaybeCompressed(messageContent)
    }
    return content
  }

  /**
   * 尝试解码可能压缩的内容
   */
  private decodeMaybeCompressed(raw: any): string {
    if (!raw) return ''

    // 如果是 Buffer/Uint8Array
    if (Buffer.isBuffer(raw)) {
      return this.decodeBinaryContent(raw)
    }

    // 如果是字符串
    if (typeof raw === 'string') {
      if (raw.length === 0) return ''

      // 检查是否是 hex 编码
      // 只有当字符串足够长（超过16字符）且看起来像 hex 时才尝试解码
      // 短字符串（如 "123456" 等纯数字）容易被误判为 hex
      if (raw.length > 16 && this.looksLikeHex(raw)) {
        const bytes = Buffer.from(raw, 'hex')
        if (bytes.length > 0) {
          return this.decodeBinaryContent(bytes)
        }
      }

      // 检查是否是 base64 编码
      // 只有当字符串足够长（超过16字符）且看起来像 base64 时才尝试解码
      // 短字符串（如 "test", "home" 等）容易被误判为 base64
      if (raw.length > 16 && this.looksLikeBase64(raw)) {
        try {
          const bytes = Buffer.from(raw, 'base64')
          return this.decodeBinaryContent(bytes)
        } catch { }
      }

      // 普通字符串
      return raw
    }

    return ''
  }

  /**
   * 解码二进制内容（处理 zstd 压缩）
   */
  private decodeBinaryContent(data: Buffer): string {
    if (data.length === 0) return ''

    try {
      // 检查是否是 zstd 压缩数据 (magic number: 0xFD2FB528)
      if (data.length >= 4) {
        const magic = data.readUInt32LE(0)
        if (magic === 0xFD2FB528) {
          // zstd 压缩，需要解压
          try {
            const decompressed = fzstd.decompress(data)
            return Buffer.from(decompressed).toString('utf-8')
          } catch (e) {
            console.error('zstd 解压失败:', e)
          }
        }
      }

      // 尝试直接 UTF-8 解码
      const decoded = data.toString('utf-8')
      // 检查是否有太多替换字符
      const replacementCount = (decoded.match(/\uFFFD/g) || []).length
      if (replacementCount < decoded.length * 0.2) {
        return decoded.replace(/\uFFFD/g, '')
      }

      // 尝试 latin1 解码
      return data.toString('latin1')
    } catch {
      return ''
    }
  }

  /**
   * 检查是否像 hex 编码
   */
  private looksLikeHex(s: string): boolean {
    if (s.length % 2 !== 0) return false
    return /^[0-9a-fA-F]+$/.test(s)
  }

  /**
   * 检查是否像 base64 编码
   */
  private looksLikeBase64(s: string): boolean {
    if (s.length % 4 !== 0) return false
    return /^[A-Za-z0-9+/=]+$/.test(s)
  }

  private shouldKeepSession(username: string): boolean {
    if (!username) return false
    if (username.startsWith('gh_')) return false

    // 过滤折叠对话占位符
    if (username === '@placeholder_foldgroup') return false

    const excludeList = [
      'weixin', 'qqmail', 'fmessage', 'medianote', 'floatbottle',
      'newsapp', 'brandsessionholder', 'brandservicesessionholder',
      'notifymessage', 'opencustomerservicemsg', 'notification_messages',
      'userexperience_alarm'
    ]

    for (const prefix of excludeList) {
      if (username.startsWith(prefix) || username === prefix) return false
    }

    if (username.includes('@kefu.openim') || username.includes('@openim')) return false
    if (username.includes('service_')) return false

    return true
  }

  async getContact(username: string): Promise<Contact | null> {
    if (!this.contactDb) return null

    try {
      const row = this.contactDb.prepare(`
        SELECT username, alias, remark, nick_name as nickName
        FROM contact WHERE username = ?
      `).get(username) as any

      if (!row) return null

      return {
        username: row.username,
        alias: row.alias || '',
        remark: row.remark || '',
        nickName: row.nickName || ''
      }
    } catch {
      return null
    }
  }

  /**
   * 获取联系人头像和显示名称（用于群聊消息）
   */
  async getContactAvatar(username: string): Promise<{ avatarUrl?: string; displayName?: string } | null> {
    if (!this.contactDb || !username) return null

    try {
      // 使用缓存的列信息
      if (!this.contactColumnsCache) {
        const columns = this.contactDb.prepare("PRAGMA table_info(contact)").all() as any[]
        const columnNames = columns.map((c: any) => c.name)

        const hasBigHeadUrl = columnNames.includes('big_head_url')
        const hasSmallHeadUrl = columnNames.includes('small_head_url')

        const selectCols = ['username', 'remark', 'nick_name', 'alias']
        if (hasBigHeadUrl) selectCols.push('big_head_url')
        if (hasSmallHeadUrl) selectCols.push('small_head_url')

        this.contactColumnsCache = { hasBigHeadUrl, hasSmallHeadUrl, selectCols }
      }

      const { hasBigHeadUrl, hasSmallHeadUrl, selectCols } = this.contactColumnsCache

      const row = this.contactDb.prepare(`
        SELECT ${selectCols.join(', ')}
        FROM contact
        WHERE username = ?
      `).get(username) as any

      if (!row) return null

      const displayName = row.remark || row.nick_name || row.alias || username
      let avatarUrl = (hasBigHeadUrl && row.big_head_url)
        ? row.big_head_url
        : (hasSmallHeadUrl && row.small_head_url)
          ? row.small_head_url
          : undefined

      // 如果没有头像 URL，尝试从 head_image.db 获取
      if (!avatarUrl) {
        avatarUrl = await this.getAvatarFromHeadImageDb(username)
      }

      return { avatarUrl, displayName }
    } catch {
      return null
    }
  }

  /**
   * 解析转账消息中的付款方和收款方显示名称
   * 优先使用群昵称（从 chatroom_info 表），群昵称为空时回退到微信昵称/备注
   */
  async resolveTransferDisplayNames(
    chatroomId: string,
    payerUsername: string,
    receiverUsername: string
  ): Promise<{ payerName: string; receiverName: string }> {
    try {
      // 如果是群聊，尝试从 contact.db 获取群昵称
      let groupNicknames: Record<string, string> = {}
      if (chatroomId.endsWith('@chatroom') && this.contactDb) {
        try {
          // 尝试从 chatroom_info 表获取群成员昵称
          const tables = this.contactDb.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%chatroom%'"
          ).all() as any[]
          for (const t of tables) {
            try {
              // chatroom_info 表通常有 chatroom_name + member_list 或类似结构
              const rows = this.contactDb.prepare(
                `SELECT * FROM ${t.name} WHERE chatroom_name = ? OR username = ?`
              ).all(chatroomId, chatroomId) as any[]
              for (const row of rows) {
                // 尝试解析 room_data 字段（XML/JSON 格式的群成员信息）
                const roomData = row.room_data || row.ext_buffer || ''
                if (roomData && typeof roomData === 'string') {
                  // 从 XML 中提取群昵称：<member><username>wxid</username><displayName>nick</displayName></member>
                  const memberRegex = /<member>[\s\S]*?<username>(.*?)<\/username>[\s\S]*?<displayName>(.*?)<\/displayName>[\s\S]*?<\/member>/gi
                  let match
                  while ((match = memberRegex.exec(roomData)) !== null) {
                    if (match[1] && match[2]) {
                      groupNicknames[match[1]] = match[2]
                    }
                  }
                }
              }
            } catch { /* 表结构不匹配，跳过 */ }
          }
        } catch { /* 查询失败，继续用联系人信息兜底 */ }
      }

      // 获取当前用户 wxid，用于识别"自己"
      const myWxid = this.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? this.cleanAccountDirName(myWxid) : ''

      // 解析名称：自己 > 群昵称 > 备注 > 昵称 > alias > wxid
      const resolveName = async (username: string): Promise<string> => {
        if (!username) return username

        // 特判：如果是当前用户自己（contact 表通常不包含自己）
        if (myWxid && (username === myWxid || username === cleanedMyWxid)) {
          // 先查群昵称中是否有自己
          const myGroupNick = groupNicknames[username]
          if (myGroupNick) return myGroupNick
          // 尝试从 contact 表查自己的昵称
          try {
            const myInfo = await this.getMyUserInfo()
            if (myInfo.success && myInfo.userInfo?.nickName) {
              return myInfo.userInfo.nickName
            }
          } catch { /* ignore */ }
          return '我'
        }

        const groupNick = groupNicknames[username]
        if (groupNick) return groupNick

        const contact = await this.getContact(username)
        if (contact) {
          return contact.remark || contact.nickName || contact.alias || username
        }
        return username
      }

      const [payerName, receiverName] = await Promise.all([
        resolveName(payerUsername),
        resolveName(receiverUsername)
      ])

      return { payerName, receiverName }
    } catch {
      return { payerName: payerUsername, receiverName: receiverUsername }
    }
  }

  /**
   * 从 head_image.db 获取头像（转换为 base64 data URL）
   */
  private async getAvatarFromHeadImageDb(username: string): Promise<string | undefined> {
    if (!this.headImageDb || !username) return undefined

    try {
      // 检查缓存
      if (this.avatarBase64Cache.has(username)) {
        return this.avatarBase64Cache.get(username)
      }

      const row = this.headImageDb.prepare(`
        SELECT image_buffer FROM head_image WHERE username = ?
      `).get(username) as any

      if (!row || !row.image_buffer) return undefined

      // 将 Buffer 转换为 base64 data URL
      const buffer = Buffer.from(row.image_buffer)
      const base64 = buffer.toString('base64')
      const dataUrl = `data:image/jpeg;base64,${base64}`

      // 缓存结果
      this.avatarBase64Cache.set(username, dataUrl)

      return dataUrl
    } catch (e: any) {
      // 如果是数据库损坏错误，只记录一次警告，避免刷屏
      if (e.code === 'SQLITE_CORRUPT') {
        if (!this.headImageDbCorrupted) {
          console.warn(`[ChatService] head_image.db 数据库文件损坏，头像功能可能受影响`)
          this.headImageDbCorrupted = true
        }
      } else {
        console.error(`获取 ${username} 的头像失败:`, e)
      }
      return undefined
    }
  }

  /**
   * 获取当前用户的头像 URL
   */
  async getMyAvatarUrl(): Promise<{ success: boolean; avatarUrl?: string; error?: string }> {
    try {
      if (!this.contactDb) {
        const connectResult = await this.connect()
        if (!connectResult.success) {
          return { success: false, error: connectResult.error }
        }
      }

      const myWxid = this.configService.get('myWxid')
      if (!myWxid) {
        return { success: false, error: '未配置微信ID' }
      }

      // 注意：contact.db 中的 username 是完整的 wxid，不需要清理

      // 检查 contact 表是否存在
      const tables = this.contactDb!.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='contact'"
      ).all()

      if (tables.length === 0) {
        return { success: false, error: 'contact 表不存在' }
      }

      // 获取表结构
      const columns = this.contactDb!.prepare("PRAGMA table_info(contact)").all() as any[]
      const columnNames = columns.map((c: any) => c.name)

      const hasBigHeadUrl = columnNames.includes('big_head_url')
      const hasSmallHeadUrl = columnNames.includes('small_head_url')

      if (!hasBigHeadUrl && !hasSmallHeadUrl) {
        return { success: false, error: '联系人表中没有头像字段' }
      }

      const selectCols = ['username']
      if (hasBigHeadUrl) selectCols.push('big_head_url')
      if (hasSmallHeadUrl) selectCols.push('small_head_url')

      // 使用原始 wxid 查询
      const row = this.contactDb!.prepare(`
        SELECT ${selectCols.join(', ')}
        FROM contact
        WHERE username = ?
      `).get(myWxid) as any

      if (!row) {
        // 如果找不到，尝试用清理后的 wxid
        const cleanedWxid = this.cleanAccountDirName(myWxid)

        const row2 = this.contactDb!.prepare(`
          SELECT ${selectCols.join(', ')}
          FROM contact
          WHERE username = ?
        `).get(cleanedWxid) as any

        if (!row2) {
          return { success: true, avatarUrl: undefined }
        }

        const avatarUrl2 = (hasBigHeadUrl && row2.big_head_url)
          ? row2.big_head_url
          : (hasSmallHeadUrl && row2.small_head_url)
            ? row2.small_head_url
            : undefined

        return { success: true, avatarUrl: avatarUrl2 }
      }

      const avatarUrl = (hasBigHeadUrl && row.big_head_url)
        ? row.big_head_url
        : (hasSmallHeadUrl && row.small_head_url)
          ? row.small_head_url
          : undefined

      return { success: true, avatarUrl }
    } catch (e) {
      console.error('ChatService: 获取当前用户头像失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取当前用户的完整信息（昵称、微信号、头像）
   */
  async getMyUserInfo(): Promise<{
    success: boolean
    userInfo?: {
      wxid: string
      nickName: string
      alias: string
      avatarUrl: string
    }
    error?: string
  }> {
    try {
      if (!this.contactDb) {
        const connectResult = await this.connect()
        if (!connectResult.success) {
          return { success: false, error: connectResult.error }
        }
      }

      const myWxid = this.configService.get('myWxid')
      if (!myWxid) {
        return { success: false, error: '未配置微信ID' }
      }

      // 检查 contact 表是否存在
      const tables = this.contactDb!.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='contact'"
      ).all()

      if (tables.length === 0) {
        return { success: false, error: 'contact 表不存在' }
      }

      // 获取表结构
      const columns = this.contactDb!.prepare("PRAGMA table_info(contact)").all() as any[]
      const columnNames = columns.map((c: any) => c.name)

      const hasBigHeadUrl = columnNames.includes('big_head_url')
      const hasSmallHeadUrl = columnNames.includes('small_head_url')

      const selectCols = ['username', 'nick_name', 'alias']
      if (hasBigHeadUrl) selectCols.push('big_head_url')
      if (hasSmallHeadUrl) selectCols.push('small_head_url')

      // 使用原始 wxid 查询
      let row = this.contactDb!.prepare(`
        SELECT ${selectCols.join(', ')}
        FROM contact
        WHERE username = ?
      `).get(myWxid) as any

      if (!row) {
        // 如果找不到，尝试用清理后的 wxid
        const cleanedWxid = this.cleanAccountDirName(myWxid)
        row = this.contactDb!.prepare(`
          SELECT ${selectCols.join(', ')}
          FROM contact
          WHERE username = ?
        `).get(cleanedWxid) as any
      }

      if (!row) {
        return {
          success: true,
          userInfo: {
            wxid: myWxid,
            nickName: '',
            alias: '',
            avatarUrl: ''
          }
        }
      }

      const avatarUrl = (hasBigHeadUrl && row.big_head_url)
        ? row.big_head_url
        : (hasSmallHeadUrl && row.small_head_url)
          ? row.small_head_url
          : ''

      return {
        success: true,
        userInfo: {
          wxid: myWxid,
          nickName: row.nick_name || '',
          alias: row.alias || '',
          avatarUrl
        }
      }
    } catch (e) {
      console.error('ChatService: 获取当前用户信息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取商店表情包的备选 URL 列表
   * 尝试不同的域名和扩展名组合
   */
  private getAlternativeStoreEmojiUrls(productId: string, md5: string): string[] {
    const urls: string[] = []

    try {
      const prefix = 'com.tencent.xin.emoticon.'
      if (!productId.startsWith(prefix)) {
        return urls
      }

      const productPath = productId.substring(prefix.length)

      // 多个可能的域名
      const baseUrls = [
        'https://emoji.qpic.cn/resource/emoticon',
        'https://mmbiz.qpic.cn/mmemoticon',
        'https://emoji.weixin.qq.com/resource/emoticon',
      ]

      // 多个可能的扩展名
      const extensions = ['webp', 'png', 'jpg']

      // 生成所有组合
      for (const baseUrl of baseUrls) {
        for (const ext of extensions) {
          urls.push(`${baseUrl}/${productPath}/${md5}.${ext}`)
        }
      }
    } catch (e) {
      // 忽略错误
    }

    return urls
  }

  /**
   * 构造商店表情包的 URL
   * 根据 productId 和 MD5 拼接微信表情资源 CDN 链接
   * 
   * 规则来源：iWeChat 项目的表情解析逻辑
   * URL 格式：https://emoji.weixin.qq.com/resource/emoticon/{product_path}/{md5}.{ext}
   */
  private constructStoreEmojiUrl(productId: string, md5: string): string | null {
    try {
      // 移除前缀 "com.tencent.xin.emoticon."
      const prefix = 'com.tencent.xin.emoticon.'
      if (!productId.startsWith(prefix)) {
        return null
      }

      const productPath = productId.substring(prefix.length)

      // 尝试多种可能的扩展名和域名
      const baseUrls = [
        'https://emoji.weixin.qq.com/resource/emoticon',
        'https://emoji.qpic.cn/resource/emoticon',
        'https://mmbiz.qpic.cn/mmemoticon',
      ]

      const extensions = ['gif', 'webp', 'png']

      // 返回第一个可能的 URL（后续会尝试下载）
      // 优先使用 gif 格式
      return `${baseUrls[0]}/${productPath}/${md5}.gif`
    } catch (e) {
      return null
    }
  }

  /**
   * 从本地文件系统查找表情包文件
   * 用于商店表情包，当消息中没有 CDN URL 时
   */
  private async findLocalEmojiFile(md5: string, productId: string): Promise<string | null> {
    try {
      const dbPath = this.configService.get('dbPath')
      const myWxid = this.configService.get('myWxid')

      if (!dbPath || !myWxid || !fs.existsSync(dbPath)) {
        return null
      }

      const accountDirName = this.findAccountDir(dbPath, myWxid)
      if (!accountDirName) {
        return null
      }

      const accountRootDir = path.join(dbPath, accountDirName)
      const md5Lower = md5.toLowerCase()

      // 商店表情包可能的路径
      const candidatePaths: string[] = [
        // 路径 1: All Users/Emoji/<package_id>/<md5>
        path.join(dbPath, 'All Users', 'Emoji', productId, md5Lower),
        path.join(dbPath, 'All Users', 'Emoji', productId, md5),

        // 路径 2: <wxid>/FileStorage/Stickers/<package_id>/<md5>
        path.join(accountRootDir, 'FileStorage', 'Stickers', productId, md5Lower),
        path.join(accountRootDir, 'FileStorage', 'Stickers', productId, md5),

        // 路径 3: <wxid>/business/emoticon/<package_id>/<md5>
        path.join(accountRootDir, 'business', 'emoticon', productId, md5Lower),
        path.join(accountRootDir, 'business', 'emoticon', productId, md5),

        // 路径 4: <wxid>/Stickers/<package_id>/<md5>
        path.join(accountRootDir, 'Stickers', productId, md5Lower),
        path.join(accountRootDir, 'Stickers', productId, md5),
      ]

      // 路径 5: 搜索 cache 目录下的 Emoticon 子目录（微信缓存，按月份分组）
      const cacheDir = path.join(accountRootDir, 'cache')
      if (fs.existsSync(cacheDir)) {
        try {
          const cacheDirs = fs.readdirSync(cacheDir)
          for (const subDir of cacheDirs) {
            const emoticonDir = path.join(cacheDir, subDir, 'Emoticon')
            if (fs.existsSync(emoticonDir)) {
              candidatePaths.push(path.join(emoticonDir, md5Lower))
              candidatePaths.push(path.join(emoticonDir, md5))
            }
          }
        } catch (e) {
          // 忽略 cache 目录读取错误
        }
      }

      // 检查每个候选路径
      for (const candidatePath of candidatePaths) {
        if (fs.existsSync(candidatePath)) {
          const stat = fs.statSync(candidatePath)
          if (stat.isFile() && stat.size > 0) {
            return candidatePath
          }
        }
      }

      // 如果直接路径不存在，尝试在目录中查找（可能有扩展名）
      for (const candidatePath of candidatePaths) {
        const dir = path.dirname(candidatePath)
        if (fs.existsSync(dir)) {
          try {
            const files = fs.readdirSync(dir)
            const baseName = path.basename(candidatePath)

            // 查找匹配的文件（可能有 .gif, .png 等扩展名）
            for (const file of files) {
              if (file.toLowerCase().startsWith(baseName.toLowerCase())) {
                const fullPath = path.join(dir, file)
                const stat = fs.statSync(fullPath)
                if (stat.isFile() && stat.size > 0) {
                  return fullPath
                }
              }
            }
          } catch (e) {
            // 忽略目录读取错误
          }
        }
      }

      // 尝试从打包文件中提取
      const extractedFile = await this.extractEmojiFromPackage(md5, productId)
      if (extractedFile) {
        return extractedFile
      }

      return null
    } catch (e) {
      return null
    }
  }

  /**
   * 从打包文件中提取表情包
   * 商店表情包通常打包存储，需要使用 offset 和 size 提取
   */
  private async extractEmojiFromPackage(md5: string, productId: string): Promise<string | null> {
    try {
      if (!this.emoticonDb) {
        return null
      }

      // 从数据库获取 offset 和 size
      const row = this.emoticonDb.prepare(`
        SELECT emoticon_offset_, emoticon_size_ 
        FROM kStoreEmoticonFilesTable 
        WHERE LOWER(md5_) = LOWER(?) AND package_id_ = ?
      `).get(md5, productId) as any

      if (!row || !row.emoticon_offset_ || !row.emoticon_size_) {
        return null
      }

      const offset = row.emoticon_offset_
      const size = row.emoticon_size_

      // 查找打包文件
      const dbPath = this.configService.get('dbPath')
      const myWxid = this.configService.get('myWxid')

      if (!dbPath || !myWxid) {
        return null
      }

      const accountDirName = this.findAccountDir(dbPath, myWxid)
      if (!accountDirName) {
        return null
      }

      const accountRootDir = path.join(dbPath, accountDirName)

      // 打包文件可能的路径
      const packagePaths = [
        path.join(accountRootDir, 'FileStorage', 'Stickers', productId),
        path.join(accountRootDir, 'business', 'emoticon', productId),
        path.join(accountRootDir, 'Stickers', productId),
        path.join(dbPath, 'All Users', 'Emoji', productId),
      ]

      let packageFile: string | null = null

      // 查找打包文件（可能是目录中的某个文件）
      for (const packageDir of packagePaths) {
        if (!fs.existsSync(packageDir)) continue

        try {
          const stat = fs.statSync(packageDir)

          // 如果是文件，直接使用
          if (stat.isFile()) {
            packageFile = packageDir
            break
          }

          // 如果是目录，查找可能的打包文件
          if (stat.isDirectory()) {
            const files = fs.readdirSync(packageDir)

            // 查找可能的打包文件（通常是最大的文件或特定名称）
            for (const file of files) {
              const filePath = path.join(packageDir, file)
              const fileStat = fs.statSync(filePath)

              if (fileStat.isFile()) {
                // 检查文件大小是否足够包含我们要提取的数据
                if (fileStat.size >= offset + size) {
                  packageFile = filePath
                  break
                }
              }
            }

            if (packageFile) break
          }
        } catch (e) {
          // 忽略错误
        }
      }

      if (!packageFile) {
        return null
      }

      const buffer = fs.readFileSync(packageFile)

      if (buffer.length < offset + size) {
        return null
      }

      const emojiData = buffer.slice(offset, offset + size)

      // 保存到缓存目录
      const cacheDir = this.getEmojiCacheDir()
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true })
      }

      // 检测文件格式
      const ext = this.detectImageExtension(emojiData) || '.gif'
      const outputPath = path.join(cacheDir, `${md5}${ext}`)

      fs.writeFileSync(outputPath, emojiData)

      return outputPath
    } catch (e) {
      return null
    }
  }

  /**
   * 从消息数据库中查找表情包 CDN URL
   * 用于商店表情包，因为它们的完整 URL（包含 filekey）只存在于消息内容中
   */
  private async findEmojiUrlFromMessages(md5: string, createTime?: number): Promise<string | null> {
    try {
      // 查找所有消息数据库
      const { allDbs } = this.findMessageDbs()

      if (allDbs.length === 0) return null

      // 遍历所有消息数据库，查找匹配的表情消息
      for (const dbPath of allDbs) {
        try {
          const db = this.getMessageDb(dbPath)
          if (!db) continue

          // 查找所有消息表
          const tables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
          ).all() as any[]

          for (const table of tables) {
            const tableName = table.name as string

            try {
              let rows: any[]

              // 如果有 createTime，使用时间范围查询（更精确）
              if (createTime) {
                const timeStart = createTime - 5
                const timeEnd = createTime + 5

                rows = db.prepare(`
                  SELECT local_id, create_time, message_content, compress_content 
                  FROM ${tableName} 
                  WHERE local_type = 47 
                  AND create_time >= ? 
                  AND create_time <= ?
                  LIMIT 100
                `).all(timeStart, timeEnd) as any[]
              } else {
                // 没有 createTime，查询最近的表情消息（按时间倒序）
                rows = db.prepare(`
                  SELECT local_id, create_time, message_content, compress_content 
                  FROM ${tableName} 
                  WHERE local_type = 47 
                  ORDER BY create_time DESC
                  LIMIT 200
                `).all() as any[]
              }

              for (const row of rows) {
                const content = this.decodeMessageContent(row.message_content, row.compress_content)
                if (!content) continue

                // 解析表情信息
                const emojiInfo = this.parseEmojiInfo(content)

                // 检查 MD5 是否匹配（不区分大小写）
                if (emojiInfo.md5 && emojiInfo.md5.toLowerCase() === md5.toLowerCase()) {
                  if (emojiInfo.cdnUrl) {
                    return emojiInfo.cdnUrl
                  }
                }
              }
            } catch (e: any) {
              // 忽略单个表查询错误（静默处理损坏的表）
            }
          }
        } catch (e: any) {
          // 忽略损坏的数据库（静默处理）
        }
      }

      return null
    } catch (e) {
      return null
    }
  }

  /**
   * 获取表情包缓存目录
   */
  private getEmojiCacheDir(): string {
    const cachePath = this.configService.get('cachePath')
    if (cachePath) {
      return path.join(cachePath, 'Emojis')
    }
    // 回退到默认目录
    return path.join(this.getDecryptedDbDir(), 'Emojis')
  }

  /**
   * 下载或获取表情包本地缓存
   * 如果 cdnUrl 为空但 md5 存在，则尝试通过本地存储或多种拼接规则下载
   */
  async downloadEmoji(cdnUrl: string, md5?: string, productId?: string, createTime?: number): Promise<{ success: boolean; localPath?: string; error?: string }> {
    // 如果没有 cdnUrl 也没有 md5，无法处理
    if (!cdnUrl && !md5) {
      return { success: false, error: '无效的 CDN URL 和 MD5' }
    }

    // 生成缓存 key
    const cacheKey = md5 || this.hashString(cdnUrl)

    // 检查内存缓存
    const cached = emojiCache.get(cacheKey)
    if (cached && fs.existsSync(cached)) {
      const dataUrl = this.fileToDataUrl(cached)
      if (dataUrl) {
        return { success: true, localPath: dataUrl }
      }
    }

    // 检查是否正在下载
    const downloading = emojiDownloading.get(cacheKey)
    if (downloading) {
      const result = await downloading
      if (result) {
        const dataUrl = this.fileToDataUrl(result)
        if (dataUrl) {
          return { success: true, localPath: dataUrl }
        }
      }
      return { success: false, error: '下载失败' }
    }

    // 确保缓存目录存在
    const cacheDir = this.getEmojiCacheDir()
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true })
    }

    // 检查本地是否已有缓存文件
    const extensions = ['.gif', '.png', '.webp', '.jpg', '.jpeg']
    for (const ext of extensions) {
      const filePath = path.join(cacheDir, `${cacheKey}${ext}`)
      if (fs.existsSync(filePath)) {
        emojiCache.set(cacheKey, filePath)
        const dataUrl = this.fileToDataUrl(filePath)
        if (dataUrl) {
          return { success: true, localPath: dataUrl }
        }
      }
    }

    // [精简] 基础 ID 与链接获取
    let effectiveProductId = productId
    let finalCdnUrl = cdnUrl

    // 尝试从本地数据库补充 productId (商店表情包)
    if (!effectiveProductId && md5 && (this as any).emoticonDb) {
      try {
        const row = (this as any).emoticonDb.prepare('SELECT package_id_ FROM kStoreEmoticonFilesTable WHERE LOWER(md5_) = LOWER(?)').get(md5) as any
        if (row?.package_id_) {
          effectiveProductId = row.package_id_
        }
      } catch (e) { }
    }

    // [New] 尝试从本地数据库查找 CDN URL (修复: 增强匹配逻辑、不区分大小写)
    if (!finalCdnUrl && md5) {
      const targetDbs = []
      if (this.emoticonDb) targetDbs.push(this.emoticonDb)
      if (this.emotionDb) targetDbs.push(this.emotionDb)

      if (targetDbs.length > 0) {
        // 优先查询 kNonStoreEmoticonTable (非商店表情包，最常用)
        const priorityTables = [
          { name: 'kNonStoreEmoticonTable', md5Col: 'md5', urlCols: ['cdn_url', 'encrypt_url', 'extern_url'] },
          { name: 'kStoreEmoticonFilesTable', md5Col: 'md5_', urlCols: [] }, // 商店表情包需要通过 package_id 构建
        ]

        // 备用表名（兼容旧版本）
        const candidateTables = ['CustomEmoticon', 'Emoticon', 'EmojiInfo', 'SmileyInfo', 'EmoticonInfo']
        let found = false

        for (const db of targetDbs) {
          // 1. 优先查询已知表结构
          for (const tableInfo of priorityTables) {
            try {
              const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableInfo.name)
              if (!tableExists) continue

              if (tableInfo.urlCols.length > 0) {
                // kNonStoreEmoticonTable: 尝试多个 URL 字段
                for (const urlCol of tableInfo.urlCols) {
                  try {
                    const row = db.prepare(`SELECT ${urlCol} as url FROM ${tableInfo.name} WHERE LOWER(${tableInfo.md5Col}) = LOWER(?) LIMIT 1`).get(md5) as any
                    if (row?.url) {
                      finalCdnUrl = row.url
                      found = true
                      break
                    }
                  } catch (err) { }
                }
              }

              if (found) break
            } catch (err) { }
          }

          if (found) break

          // 2. 备用：动态查询未知表结构
          for (const tableName of candidateTables) {
            try {
              // 检查表是否存在
              const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName)
              if (!tableExists) continue

              // 动态获取列名以适配不同版本 (md5 vs md5_, cdnUrl vs cdn_url)
              const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as any[]
              const colNames = columns.map(c => c.name)
              const md5Col = colNames.find(c => ['md5', 'md5_'].includes(c.toLowerCase()))
              const urlCol = colNames.find(c => ['cdnurl', 'cdn_url', 'cdnurl_', 'url', 'encrypturl', 'encrypt_url'].includes(c.toLowerCase()))

              if (md5Col && urlCol) {
                // 使用 LOWER 确保 MD5 大小写不一致也能匹配 (微信数据库中 MD5 有时是大写)
                const row = db.prepare(`SELECT ${urlCol} as url FROM ${tableName} WHERE LOWER(${md5Col}) = LOWER(?) LIMIT 1`).get(md5) as any
                if (row?.url) {
                  finalCdnUrl = row.url
                  found = true
                  break
                }
              }
            } catch (err) { }
          }
          if (found) break
        }
      }
    }

    // [Critical] 如果仍然没有 CDN URL，尝试从消息数据库中提取（商店表情包的关键）
    if (!finalCdnUrl && md5) {
      try {
        const emojiUrl = await this.findEmojiUrlFromMessages(md5, createTime)
        if (emojiUrl) {
          finalCdnUrl = emojiUrl
        }
      } catch (e) {
        // 忽略错误
      }
    }

    // [New] 如果仍然没有 URL，尝试通过 productId 构造 URL（商店表情包）
    if (!finalCdnUrl && md5 && effectiveProductId) {
      try {
        const constructedUrl = this.constructStoreEmojiUrl(effectiveProductId, md5)
        if (constructedUrl) {
          finalCdnUrl = constructedUrl
        }
      } catch (e) {
        // 忽略构造 URL 失败
      }
    }

    // [New] 如果仍然没有 URL，尝试从本地文件系统查找（商店表情包）
    if (!finalCdnUrl && md5 && effectiveProductId) {
      try {
        const localFile = await this.findLocalEmojiFile(md5, effectiveProductId)
        if (localFile) {
          const dataUrl = this.fileToDataUrl(localFile)
          if (dataUrl) {
            emojiCache.set(cacheKey, localFile)
            return { success: true, localPath: dataUrl }
          }
        }
      } catch (e) {
        // 忽略查找本地文件失败
      }
    }

    if (!finalCdnUrl && !effectiveProductId) {
      // 非商店表情包，尝试备选 URL
      const fallbackUrls: string[] = [
        `https://emoji.qpic.cn/wx_emoji/${md5}/0`,
        `https://emoji.qpic.cn/wx_emoji/${md5}/126`
      ]

      for (const url of fallbackUrls) {
        try {
          const localPath = await this.doDownloadEmoji(url, cacheKey, cacheDir)
          if (localPath) {
            const dataUrl = this.fileToDataUrl(localPath)
            if (dataUrl) {
              emojiCache.set(cacheKey, localPath)
              return { success: true, localPath: dataUrl }
            }
          }
        } catch (e) { }
      }

      return { success: false, error: '表情包不可用：未找到 CDN URL，本地文件也不存在' }
    }

    if (!finalCdnUrl) {
      return { success: false, error: '商店表情包暂不可用：需要从微信重新下载' }
    }

    // 普通 CDN 下载流程
    try {
      const localPath = await this.doDownloadEmoji(finalCdnUrl, cacheKey, cacheDir)
      if (localPath) {
        emojiCache.set(cacheKey, localPath)
        const dataUrl = this.fileToDataUrl(localPath)
        if (dataUrl) return { success: true, localPath: dataUrl }
      }
    } catch (e) {
      // 忽略下载失败
    }

    // 如果是商店表情包且下载失败，尝试其他扩展名和域名
    if (effectiveProductId && md5) {
      const alternativeUrls = this.getAlternativeStoreEmojiUrls(effectiveProductId, md5)

      for (const altUrl of alternativeUrls) {
        try {
          const localPath = await this.doDownloadEmoji(altUrl, cacheKey, cacheDir)
          if (localPath) {
            emojiCache.set(cacheKey, localPath)
            const dataUrl = this.fileToDataUrl(localPath)
            if (dataUrl) {
              return { success: true, localPath: dataUrl }
            }
          }
        } catch (e) {
          // 继续尝试下一个
        }
      }
    }

    return { success: false, error: '下载失败' }
  }

  /**
   * 将文件转为 data URL (带 ZSTD 解压与 XOR 解密)
   */
  private fileToDataUrl(filePath: string): string | null {
    try {
      let buffer = fs.readFileSync(filePath)
      if (!buffer || buffer.length === 0) return null

      // 1. ZSTD 解压缩
      const zstdMagic = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
      const zstdIndex = buffer.indexOf(zstdMagic)
      if (zstdIndex !== -1 && zstdIndex < 256) {
        try {
          const decompressed = Buffer.from(fzstd.decompress(buffer.slice(zstdIndex)))
          if (decompressed.length > 0) buffer = decompressed
        } catch (e) { }
      }

      // 2. 格式识别与 XOR 解密
      let mimeType = this.detectMimeType(buffer)
      let decryptedBuffer = buffer

      if (!mimeType) {
        const xorKeyHex = this.configService.get('imageXorKey')
        const xorKey = xorKeyHex ? parseInt(xorKeyHex, 16) : null

        // 尝试偏移 0 和 16
        for (const offset of [0, 16]) {
          if (buffer.length <= offset) continue
          const part = buffer.slice(offset)

          // 尝试配置的 XOR Key
          if (xorKey !== null && !isNaN(xorKey)) {
            const temp = Buffer.alloc(part.length)
            for (let i = 0; i < part.length; i++) temp[i] = part[i] ^ xorKey
            const m = this.detectMimeType(temp)
            if (m) {
              decryptedBuffer = temp
              mimeType = m
              break
            }
          }

          // 简单暴力破解单字节 XOR (仅常用图片头)
          const heads = [0x47, 0x89, 0xFF] // GIF, PNG, JPG
          for (const head of heads) {
            const key = part[0] ^ head
            const temp = Buffer.alloc(part.length)
            for (let i = 0; i < part.length; i++) temp[i] = part[i] ^ key
            const m = this.detectMimeType(temp)
            if (m) {
              decryptedBuffer = temp
              mimeType = m
              break
            }
          }
          if (mimeType) break
        }
      }

      if (!mimeType) mimeType = 'image/gif' // 兜底

      return `data:${mimeType};base64,${decryptedBuffer.toString('base64')}`
    } catch (e) {
      return null
    }
  }

  /**
   * 辅助：探测 Buffer 是哪种图片格式
   */
  private detectMimeType(buffer: Buffer): string | null {
    if (buffer.length < 4) return null
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png'
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg'
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'image/webp'
    return null
  }

  /**
   * 执行表情包下载 (深度模拟微信环境)
   */
  private doDownloadEmoji(url: string, cacheKey: string, cacheDir: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        // 强制升级 http 到 https (解决 ECONNRESET)
        if (url.startsWith('http://') && (url.includes('qq.com') || url.includes('wechat.com'))) {
          url = url.replace('http://', 'https://')
        }

        const urlObj = new URL(url)
        const protocol = url.startsWith('https') ? https : http

        // 使用真实微信 PC 端 Headers
        const options = {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x67001431) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/3.9.11.17(0x63090b11) XWEB/1158',
            'Accept': '*/*',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Connection': 'keep-alive'
          },
          // [Fix] 针对腾讯/微信 CDN 域名跳过证书验证
          rejectUnauthorized: false,
          timeout: 10000
        }

        const request = protocol.get(url, options, (response) => {
          // 处理重定向 (支持多级跳转)
          if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 303 || response.statusCode === 307) {
            const redirectUrl = response.headers.location
            if (redirectUrl) {
              const fullRedirectUrl = redirectUrl.startsWith('http') ? redirectUrl : `${urlObj.protocol}//${urlObj.host}${redirectUrl}`
              this.doDownloadEmoji(fullRedirectUrl, cacheKey, cacheDir).then(resolve)
              return
            }
          }

          if (response.statusCode !== 200) {
            resolve(null)
            return
          }

          const chunks: Buffer[] = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => {
            const buffer = Buffer.concat(chunks)
            if (buffer.length === 0) {
              resolve(null)
              return
            }

            // 根据二进制内容自动纠正文件后缀
            const ext = this.detectImageExtension(buffer) || this.getExtFromUrl(url) || '.gif'
            const filePath = path.join(cacheDir, `${cacheKey}${ext}`)

            try {
              if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
              fs.writeFileSync(filePath, buffer)
              resolve(filePath)
            } catch (err) {
              resolve(null)
            }
          })
          response.on('error', () => resolve(null))
        })

        request.on('error', (err) => {
          resolve(null)
        })
        request.setTimeout(15000, () => {
          request.destroy()
          resolve(null)
        })
      } catch (e) {
        resolve(null)
      }
    })
  }

  /**
   * 检测图片格式
   */
  private detectImageExtension(buffer: Buffer): string | null {
    if (buffer.length < 12) return null

    // GIF
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      return '.gif'
    }
    // PNG
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      return '.png'
    }
    // JPEG
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return '.jpg'
    }
    // WEBP
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
      return '.webp'
    }

    return null
  }

  /**
   * 从 URL 获取扩展名
   */
  private getExtFromUrl(url: string): string | null {
    try {
      const pathname = new URL(url).pathname
      const ext = path.extname(pathname).toLowerCase()
      if (['.gif', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
        return ext
      }
    } catch { }
    return null
  }

  /**
   * 简单的字符串哈希
   */
  private hashString(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return Math.abs(hash).toString(16)
  }

  /**
   * 获取会话详情信息
   */
  async getSessionDetail(sessionId: string): Promise<{
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
  }> {
    try {
      if (!this.dbDir) {
        return { success: false, error: '数据库未连接' }
      }

      // 获取联系人信息
      let displayName = sessionId
      let remark: string | undefined
      let nickName: string | undefined
      let alias: string | undefined
      let avatarUrl: string | undefined

      if (this.contactDb) {
        try {
          if (!this.contactColumnsCache) {
            const columns = this.contactDb.prepare("PRAGMA table_info(contact)").all() as any[]
            const columnNames = columns.map((c: any) => c.name)

            const hasBigHeadUrl = columnNames.includes('big_head_url')
            const hasSmallHeadUrl = columnNames.includes('small_head_url')

            const selectCols = ['username', 'remark', 'nick_name', 'alias']
            if (hasBigHeadUrl) selectCols.push('big_head_url')
            if (hasSmallHeadUrl) selectCols.push('small_head_url')

            this.contactColumnsCache = { hasBigHeadUrl, hasSmallHeadUrl, selectCols }
          }

          const { hasBigHeadUrl, hasSmallHeadUrl, selectCols } = this.contactColumnsCache

          const contact = this.contactDb.prepare(`
            SELECT ${selectCols.join(', ')}
            FROM contact
            WHERE username = ?
          `).get(sessionId) as any

          if (contact) {
            remark = contact.remark || undefined
            nickName = contact.nick_name || undefined
            alias = contact.alias || undefined
            displayName = remark || nickName || alias || sessionId

            if (hasBigHeadUrl && contact.big_head_url) {
              avatarUrl = contact.big_head_url
            } else if (hasSmallHeadUrl && contact.small_head_url) {
              avatarUrl = contact.small_head_url
            }
          }
        } catch { }
      }

      // 查找所有包含该会话消息的数据库和表
      const dbTablePairs = this.findSessionTables(sessionId)
      const messageTables: { dbName: string; tableName: string; count: number }[] = []
      let totalMessageCount = 0
      let firstMessageTime: number | undefined
      let latestMessageTime: number | undefined

      for (const { db, tableName, dbPath } of dbTablePairs) {
        try {
          // 获取消息数量
          const countResult = db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get() as any
          const count = countResult?.count || 0
          totalMessageCount += count

          // 获取时间范围
          const timeResult = db.prepare(`
            SELECT MIN(create_time) as first_time, MAX(create_time) as last_time
            FROM ${tableName}
          `).get() as any

          if (timeResult) {
            if (timeResult.first_time) {
              if (!firstMessageTime || timeResult.first_time < firstMessageTime) {
                firstMessageTime = timeResult.first_time
              }
            }
            if (timeResult.last_time) {
              if (!latestMessageTime || timeResult.last_time > latestMessageTime) {
                latestMessageTime = timeResult.last_time
              }
            }
          }

          messageTables.push({
            dbName: path.basename(dbPath),
            tableName,
            count
          })
        } catch { }
      }

      return {
        success: true,
        detail: {
          wxid: sessionId,
          displayName,
          remark,
          nickName,
          alias,
          avatarUrl,
          messageCount: totalMessageCount,
          firstMessageTime,
          latestMessageTime,
          messageTables
        }
      }
    } catch (e) {
      console.error('ChatService: 获取会话详情失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 解析语音时长（秒）
   */
  private parseVoiceDuration(content: string): number | undefined {
    if (!content) return undefined
    // 匹配 voicelength, length, time, playlength 等字段（毫秒）
    const match = /(voicelength|length|time|playlength)\s*=\s*['"]?([0-9]+(?:\.[0-9]+)?)['"]?/i.exec(content)
    if (!match) return undefined
    const ms = parseFloat(match[2])
    if (isNaN(ms) || ms <= 0) return undefined
    // 转换为秒，保留1位小数
    return Math.round(ms / 100) / 10
  }

  /**
   * 查找 media 数据库文件
   */
  private findMediaDbs(): string[] {
    if (!this.dbDir) return []

    const mediaDbFiles: string[] = []

    try {
      const files = fs.readdirSync(this.dbDir)
      for (const file of files) {
        const lower = file.toLowerCase()
        if (lower.startsWith('media') && lower.endsWith('.db')) {
          mediaDbFiles.push(path.join(this.dbDir, file))
        }
      }
    } catch (e) {
      console.error('[ChatService][Voice] 查找 media 数据库失败:', e)
    }

    return mediaDbFiles
  }

  /**
   * 获取单条消息
   */
  /**
   * 获取单条消息
   */
  public async getMessageByLocalId(sessionId: string, localId: number): Promise<{ success: boolean; message?: Message; error?: string }> {
    const dbTablePairs = this.findSessionTables(sessionId)

    for (const { db, tableName } of dbTablePairs) {
      try {
        const row = db.prepare(`SELECT * FROM ${tableName} WHERE local_id = ?`).get(localId) as any
        if (row) {
          const content = this.decodeMessageContent(row.message_content, row.compress_content)
          const localType = row.local_type || row.type || 1

          return {
            success: true,
            message: {
              localId: row.local_id || 0,
              serverId: row.server_id || 0,
              localType,
              createTime: row.create_time || 0,
              sortSeq: row.sort_seq || 0,
              isSend: row.is_send ?? null,
              senderUsername: row.sender_username || null,
              parsedContent: this.parseMessageContent(content, localType),
              rawContent: content,
              chatRecordList: content ? (() => {
                const xmlType = this.extractXmlValue(content, 'type')
                return (xmlType === '19' || localType === 49) ? this.parseChatHistory(content) : undefined
              })() : undefined
            }
          }
        }
      } catch (e) {
        // 忽略单个表查询错误
      }
    }

    return { success: false, error: 'Message not found' }
  }

  /**
   * 获取语音数据（解码为 WAV base64）
   * 参数改为接收 createTime，因为 localId 在不同数据库中可能不一致
   */
  async getVoiceData(sessionId: string, msgId: string, createTime?: number): Promise<{ success: boolean; data?: string; error?: string }> {
    try {
      const localId = parseInt(msgId, 10)
      if (isNaN(localId)) {
        return { success: false, error: '无效的消息ID' }
      }

      // 如果没有传入 createTime，尝试从数据库获取
      let msgCreateTime = createTime
      if (!msgCreateTime) {
        const result = await this.getMessageByLocalId(sessionId, localId)
        if (result.success && result.message) {
          msgCreateTime = result.message.createTime
        }
      }

      if (!msgCreateTime) {
        return { success: false, error: '未找到消息时间戳' }
      }

      // 查找 media 数据库
      const mediaDbs = this.findMediaDbs()

      if (mediaDbs.length === 0) {
        return { success: false, error: '未找到媒体数据库' }
      }

      // 构建查找候选：sessionId, myWxid
      const candidates: string[] = []
      if (sessionId) candidates.push(sessionId)
      const myWxid = this.configService.get('myWxid')
      if (myWxid && !candidates.includes(myWxid)) {
        candidates.push(myWxid)
      }

      // 在 media 数据库中查找语音数据
      let silkData: Buffer | null = null

      for (const dbPath of mediaDbs) {
        try {
          const mediaDb = new Database(dbPath, { readonly: true })

          try {
            // 查找 VoiceInfo 表
            const tables = mediaDb.prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'VoiceInfo%'"
            ).all() as any[]

            if (tables.length === 0) {
              mediaDb.close()
              continue
            }

            const voiceTable = tables[0].name

            // 获取表结构
            const columns = mediaDb.prepare(`PRAGMA table_info('${voiceTable}')`).all() as any[]
            const columnNames = columns.map((c: any) => c.name.toLowerCase())

            // 找到数据列
            const dataColumn = columnNames.find(c =>
              c === 'voice_data' || c === 'buf' || c === 'voicebuf' || c === 'data'
            )
            if (!dataColumn) {
              mediaDb.close()
              continue
            }

            // 找到 chat_name_id 列
            const chatNameIdColumn = columnNames.find(c =>
              c === 'chat_name_id' || c === 'chatnameid' || c === 'chat_nameid'
            )

            // 找到时间列
            const timeColumn = columnNames.find(c =>
              c === 'create_time' || c === 'createtime' || c === 'time'
            )

            // 查找 Name2Id 表
            const name2IdTables = mediaDb.prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Name2Id%'"
            ).all() as any[]

            // 策略1: 通过 chat_name_id + create_time 查找（最准确）
            if (chatNameIdColumn && timeColumn && name2IdTables.length > 0) {
              const name2IdTable = name2IdTables[0].name

              for (const candidate of candidates) {
                // 获取 chat_name_id
                const name2IdRow = mediaDb.prepare(
                  `SELECT rowid FROM ${name2IdTable} WHERE user_name = ?`
                ).get(candidate) as any

                if (!name2IdRow?.rowid) {
                  continue
                }

                const chatNameId = name2IdRow.rowid

                // 用 chat_name_id + create_time 查找
                const sql = `SELECT ${dataColumn} AS data FROM ${voiceTable} WHERE ${chatNameIdColumn} = ? AND ${timeColumn} = ? LIMIT 1`

                const row = mediaDb.prepare(sql).get(chatNameId, msgCreateTime) as any

                if (row?.data) {
                  silkData = this.decodeVoiceBlob(row.data)
                  if (silkData) {
                    break
                  }
                }
              }
            }

            // 策略2: 只通过 create_time 查找（兜底）
            if (!silkData && timeColumn) {
              const sql = `SELECT ${dataColumn} AS data FROM ${voiceTable} WHERE ${timeColumn} = ? LIMIT 1`
              const row = mediaDb.prepare(sql).get(msgCreateTime) as any

              if (row?.data) {
                silkData = this.decodeVoiceBlob(row.data)
              }
            }

            mediaDb.close()
            if (silkData) break
          } catch (e) {
            try { mediaDb.close() } catch { }
          }
        } catch (e) {
          // 忽略单个数据库打开失败
        }
      }

      if (!silkData) {
        return { success: false, error: '未找到语音数据' }
      }

      // 使用 silk-wasm 解码
      try {
        const pcmData = await this.decodeSilkToPcm(silkData, 24000)
        if (!pcmData) {
          return { success: false, error: 'Silk 解码失败' }
        }

        // PCM -> WAV
        const wavData = this.createWavBuffer(pcmData, 24000)

        return { success: true, data: wavData.toString('base64') }
      } catch (e) {
        return { success: false, error: '语音解码失败: ' + String(e) }
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 解码语音 Blob 数据
   */
  private decodeVoiceBlob(raw: any): Buffer | null {
    if (!raw) return null
    if (Buffer.isBuffer(raw)) return raw
    if (raw instanceof Uint8Array) return Buffer.from(raw)
    if (Array.isArray(raw)) return Buffer.from(raw)
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      // 尝试 hex 解码
      if (/^[a-fA-F0-9]+$/.test(trimmed) && trimmed.length % 2 === 0) {
        try {
          return Buffer.from(trimmed, 'hex')
        } catch { }
      }
      // 尝试 base64 解码
      try {
        return Buffer.from(trimmed, 'base64')
      } catch { }
    }
    if (typeof raw === 'object' && Array.isArray(raw.data)) {
      return Buffer.from(raw.data)
    }
    return null
  }

  /**
   * 解码 Silk 数据为 PCM
   * 使用 silk-wasm（纯 JS/WASM）
   */
  private async decodeSilkToPcm(silkData: Buffer, sampleRate: number): Promise<Buffer | null> {
    try {
      // 找到 silk-wasm 的 WASM 文件
      let wasmPath: string

      if (app.isPackaged) {
        // 打包后，WASM 文件在 app.asar.unpacked 中
        wasmPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'silk-wasm', 'lib', 'silk.wasm')
        if (!fs.existsSync(wasmPath)) {
          wasmPath = path.join(process.resourcesPath, 'node_modules', 'silk-wasm', 'lib', 'silk.wasm')
        }
      } else {
        // 开发环境
        wasmPath = path.join(app.getAppPath(), 'node_modules', 'silk-wasm', 'lib', 'silk.wasm')
      }

      if (!fs.existsSync(wasmPath)) {
        return null
      }

      const silkWasm = require('silk-wasm')
      const result = await silkWasm.decode(silkData, sampleRate)

      return Buffer.from(result.data)
    } catch (e) {
      return null
    }
  }


  /**
   * 创建 WAV 文件 Buffer
   */
  private createWavBuffer(pcmData: Buffer, sampleRate: number = 24000, channels: number = 1): Buffer {
    const pcmLength = pcmData.length
    const header = Buffer.alloc(44)

    // RIFF header
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + pcmLength, 4)
    header.write('WAVE', 8)

    // fmt chunk
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)           // chunk size
    header.writeUInt16LE(1, 20)            // audio format (PCM)
    header.writeUInt16LE(channels, 22)     // channels
    header.writeUInt32LE(sampleRate, 24)   // sample rate
    header.writeUInt32LE(sampleRate * channels * 2, 28)  // byte rate
    header.writeUInt16LE(channels * 2, 32) // block align
    header.writeUInt16LE(16, 34)           // bits per sample

    // data chunk
    header.write('data', 36)
    header.writeUInt32LE(pcmLength, 40)

    return Buffer.concat([header, pcmData])
  }

  /**
   * 启动自动增量同步
   * @param intervalMs 检查间隔（毫秒）
   */
  startAutoSync(intervalMs = 5000) {
    if (this.syncTimer) return

    // 立即执行一次
    this.checkUpdates().catch(() => { })

    this.syncTimer = setInterval(() => {
      this.checkUpdates().catch(() => { })
    }, intervalMs)
  }

  /**
   * 停止自动同步
   */
  stopAutoSync() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer)
      this.syncTimer = null
      // console.log('[ChatService] 停止自动增量同步') // 减少日志
    }
  }

  /**
   * 检查数据库是否有更新
   * @param force 是否强制触发（跳过时间检查）
   */
  async checkUpdates(force: boolean = false) {
    // 确保已连接
    if (!this.sessionDb || !this.dbDir) {
      // 如果数据库已关闭，不要尝试重新连接（可能正在同步）
      return
    }

    try {
      const sessionPath = path.join(this.dbDir!, 'session.db')
      const walPath = path.join(this.dbDir!, 'session.db-wal')

      // 检查文件是否存在
      if (!fs.existsSync(sessionPath)) return

      let currentMtime = fs.statSync(sessionPath).mtimeMs

      // 如果存在 WAL 文件，也检查它的修改时间
      if (fs.existsSync(walPath)) {
        const walMtime = fs.statSync(walPath).mtimeMs
        currentMtime = Math.max(currentMtime, walMtime)
      }

      // 如果不是强制检查，且时间没变，则返回
      if (!force) {
        // 首次运行时记录时间但不触发更新
        if (this.lastDbCheckTime === 0) {
          this.lastDbCheckTime = currentMtime
          return
        }

        // 如果时间没变变大，则不触发
        if (currentMtime <= this.lastDbCheckTime) {
          return
        }
      }

      // 更新上一次检查时间
      this.lastDbCheckTime = currentMtime

      // 再次检查数据库是否仍然打开（可能在等待期间被关闭）
      if (!this.sessionDb) {
        return
      }

      // 强制或时间变大：获取最新会话列表并广播
      try {
        const result = await this.getSessions()
        if (result.success && result.sessions) {
          this.emit('sessions-update-available', result.sessions)
        }
      } catch (err) {
        console.error('[ChatService] 获取更新会话列表失败:', err)
      }
    } catch (e) {
      console.error('[ChatService] 检查更新出错:', e)
    }
  }

  /**
   * 检查当前会话的新消息并推送（增量同步）
   * 采用 Push 模式，主动将新解密的消息推送到前端
   */
  private checkNewMessagesForCurrentSession(): void {
    if (!this.currentSessionId) return

    // 如果没有游标，说明尚未加载过历史消息，暂不推送（避免数据不连续）
    const cursor = this.sessionCursor.get(this.currentSessionId) || 0
    if (cursor === 0) return

    try {
      const tables = this.findSessionTables(this.currentSessionId)
      if (tables.length === 0) return

      const allNewMessages: Message[] = []

      // 获取当前用户的 wxid
      const myWxid = this.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? this.cleanAccountDirName(myWxid) : ''

      for (const { db, tableName, dbPath } of tables) {
        // 检查 Name2Id 表
        const hasName2IdTable = this.checkTableExists(db, 'Name2Id')

        // 鲁棒的 myRowId 查找逻辑 (与 getMessages 保持一致)
        let myRowId: number | null = null
        if (myWxid && hasName2IdTable) {
          const cacheKeyOriginal = `${dbPath}:${myWxid}`
          const cachedRowIdOriginal = this.myRowIdCache.get(cacheKeyOriginal)

          if (cachedRowIdOriginal !== undefined) {
            myRowId = cachedRowIdOriginal
          } else {
            try {
              const row = db.prepare('SELECT rowid FROM Name2Id WHERE user_name = ?').get(myWxid) as any
              if (row?.rowid) {
                myRowId = row.rowid
                this.myRowIdCache.set(cacheKeyOriginal, myRowId)
              } else if (cleanedMyWxid && cleanedMyWxid !== myWxid) {
                const cacheKeyCleaned = `${dbPath}:${cleanedMyWxid}`
                const cachedRowIdCleaned = this.myRowIdCache.get(cacheKeyCleaned)

                if (cachedRowIdCleaned !== undefined) {
                  myRowId = cachedRowIdCleaned
                } else {
                  const row2 = db.prepare('SELECT rowid FROM Name2Id WHERE user_name = ?').get(cleanedMyWxid) as any
                  myRowId = row2?.rowid ?? null
                  this.myRowIdCache.set(cacheKeyCleaned, myRowId)
                }
              } else {
                this.myRowIdCache.set(cacheKeyOriginal, null)
              }
            } catch {
              myRowId = null
            }
          }
        }

        // 构建查询 SQL (查询比 cursor 大的消息)
        let sql: string
        if (hasName2IdTable && myRowId !== null) {
          sql = `SELECT m.*, 
                 CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                 n.user_name AS sender_username
                 FROM ${tableName} m
                 LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                 WHERE m.sort_seq > ?
                 ORDER BY m.sort_seq ASC
                 LIMIT 100`
        } else if (hasName2IdTable) {
          sql = `SELECT m.*, n.user_name AS sender_username
                 FROM ${tableName} m
                 LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                 WHERE m.sort_seq > ?
                 ORDER BY m.sort_seq ASC
                 LIMIT 100`
        } else {
          sql = `SELECT * FROM ${tableName} WHERE sort_seq > ? ORDER BY sort_seq ASC LIMIT 100`
        }

        const rows = hasName2IdTable && myRowId !== null
          ? db.prepare(sql).all(myRowId, cursor) as any[]
          : db.prepare(sql).all(cursor) as any[]

        // 解析消息
        for (const row of rows) {
          const content = this.decodeMessageContent(row.message_content, row.compress_content)
          const localType = row.local_type || row.type || 1
          const isSend = row.computed_is_send ?? row.is_send ?? null

          let emojiCdnUrl: string | undefined
          let emojiMd5: string | undefined
          let emojiProductId: string | undefined
          let quotedContent: string | undefined
          let quotedSender: string | undefined
          let quotedImageMd5: string | undefined
          let imageMd5: string | undefined
          let imageDatName: string | undefined
          let videoMd5: string | undefined
          let voiceDuration: number | undefined
          let fileName: string | undefined
          let fileSize: number | undefined
          let fileExt: string | undefined
          let fileMd5: string | undefined

          if (localType === 47 && content) {
            const emojiInfo = this.parseEmojiInfo(content)
            emojiCdnUrl = emojiInfo.cdnUrl
            emojiMd5 = emojiInfo.md5
            emojiProductId = emojiInfo.productId
          } else if (localType === 3 && content) {
            const imageInfo = this.parseImageInfo(content)
            imageMd5 = imageInfo.md5
            imageDatName = this.parseImageDatNameFromRow(row)
          } else if (localType === 43 && content) {
            videoMd5 = this.parseVideoMd5(content)
          } else if (localType === 34 && content) {
            voiceDuration = this.parseVoiceDuration(content)
          } else if (localType === 49 && content) {
            // 解析文件消息
            const fileInfo = this.parseFileInfo(content)
            fileName = fileInfo.fileName
            fileSize = fileInfo.fileSize
            fileExt = fileInfo.fileExt
            fileMd5 = fileInfo.fileMd5
          }

          let chatRecordList: ChatRecordItem[] | undefined
          if (content) {
            const xmlType = this.extractXmlValue(content, 'type')
            if (xmlType === '19' || localType === 49) {
              chatRecordList = this.parseChatHistory(content)
            }
          } else if (localType === 244813135921 || (content && content.includes('<type>57</type>'))) {
            const quoteInfo = this.parseQuoteMessage(content)
            quotedContent = quoteInfo.content
            quotedSender = quoteInfo.sender
            quotedImageMd5 = quoteInfo.imageMd5
          }

          // 解析转账消息的付款方和收款方
          let transferPayerUsername: string | undefined
          let transferReceiverUsername: string | undefined
          if ((localType === 49 || localType === 8589934592049) && content) {
            const xmlType = this.extractXmlValue(content, 'type')
            if (xmlType === '2000') {
              transferPayerUsername = this.extractXmlValue(content, 'payer_username') || undefined
              transferReceiverUsername = this.extractXmlValue(content, 'receiver_username') || undefined
            }
          }

          const parsedContent = this.parseMessageContent(content, localType)

          allNewMessages.push({
            localId: row.local_id || 0,
            serverId: row.server_id || 0,
            localType,
            createTime: row.create_time || 0,
            sortSeq: row.sort_seq || 0,
            isSend,
            senderUsername: row.sender_username || null,
            parsedContent,
            rawContent: content,
            emojiCdnUrl,
            emojiMd5,
            productId: emojiProductId,
            quotedContent,
            quotedSender,
            quotedImageMd5,
            imageMd5,
            imageDatName,
            videoMd5,
            voiceDuration,
            fileName,
            fileSize,
            fileExt,
            fileMd5,
            chatRecordList,
            transferPayerUsername,
            transferReceiverUsername
          })
        }
      }

      if (allNewMessages.length > 0) {
        // 排序
        allNewMessages.sort((a, b) => a.sortSeq - b.sortSeq)

        // 更新游标
        const maxSeq = allNewMessages[allNewMessages.length - 1].sortSeq
        this.sessionCursor.set(this.currentSessionId, maxSeq)

        // 推送事件
        this.emit('new-messages', {
          sessionId: this.currentSessionId,
          messages: allNewMessages
        })
        // console.log(`[ChatService] 推送增量消息: ${allNewMessages.length} 条`)
      }

    } catch (e) {
      // console.error('[ChatService] 增量同步失败:', e)
    }
  }
}

export const chatService = new ChatService()
