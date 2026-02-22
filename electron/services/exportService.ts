import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import * as http from 'http'
import Database from 'better-sqlite3'
import { app } from 'electron'
import { ConfigService } from './config'
import { voiceTranscribeService } from './voiceTranscribeService'
import * as XLSX from 'xlsx'
import { HtmlExportGenerator } from './htmlExportGenerator'
import { imageDecryptService } from './imageDecryptService'
import { videoService } from './videoService'

// ChatLab 0.0.2 格式类型定义
interface ChatLabHeader {
  version: string
  exportedAt: number
  generator: string
  description?: string
}

interface ChatLabMeta {
  name: string
  platform: string
  type: 'group' | 'private'
  groupId?: string
  groupAvatar?: string
  ownerId?: string
}

interface MemberRole {
  id: string
  name?: string
}

interface ChatLabMember {
  platformId: string
  accountName: string
  groupNickname?: string
  avatar?: string
  roles?: MemberRole[]
}

interface ChatLabMessage {
  sender: string
  accountName: string
  groupNickname?: string
  timestamp: number
  type: number
  content: string | null
  platformMessageId?: string
  replyToMessageId?: string
  chatRecords?: ChatRecordItem[]  // 嵌套的聊天记录
}

interface ChatRecordItem {
  sender: string
  accountName: string
  timestamp: number
  type: number
  content: string
  avatar?: string
}

interface ChatLabExport {
  chatlab: ChatLabHeader
  meta: ChatLabMeta
  members: ChatLabMember[]
  messages: ChatLabMessage[]
}

// 消息类型映射：微信 localType -> ChatLab type
const MESSAGE_TYPE_MAP: Record<number, number> = {
  1: 0,      // 文本 -> TEXT
  3: 1,      // 图片 -> IMAGE
  34: 2,     // 语音 -> VOICE
  43: 3,     // 视频 -> VIDEO
  49: 7,     // 链接/文件 -> LINK (需要进一步判断)
  47: 5,     // 表情包 -> EMOJI
  48: 8,     // 位置 -> LOCATION
  42: 27,    // 名片 -> CONTACT
  50: 23,    // 通话 -> CALL
  10000: 80, // 系统消息 -> SYSTEM
}

export interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'html' | 'txt' | 'excel' | 'sql'
  dateRange?: { start: number; end: number } | null
  exportMedia?: boolean
  exportAvatars?: boolean
  exportImages?: boolean
  exportVideos?: boolean
  exportEmojis?: boolean
  exportVoices?: boolean
  exportFiles?: boolean
  mediaPathMap?: Map<number, string>
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

export interface ExportProgress {
  current: number
  total: number
  currentSession: string
  phase: 'preparing' | 'exporting' | 'writing' | 'complete'
  detail?: string
}

class ExportService {
  private configService: ConfigService
  private dbDir: string | null = null
  private contactDb: Database.Database | null = null
  private headImageDb: Database.Database | null = null
  private messageDbCache: Map<string, Database.Database> = new Map()
  private contactColumnsCache: { hasBigHeadUrl: boolean; hasSmallHeadUrl: boolean; selectCols: string[] } | null = null

  constructor() {
    this.configService = new ConfigService()
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

        if (dirNameLower === wxidLower || dirNameLower === cleanedWxidLower) return dirName
        if (dirNameLower.startsWith(wxidLower + '_') || dirNameLower.startsWith(cleanedWxidLower + '_')) return dirName
        if (wxidLower.startsWith(dirNameLower + '_') || cleanedWxidLower.startsWith(dirNameLower + '_')) return dirName

        const cleanedDirName = this.cleanAccountDirName(dirName)
        if (cleanedDirName.toLowerCase() === wxidLower || cleanedDirName.toLowerCase() === cleanedWxidLower) return dirName
      }
    } catch (e) {
      console.error('查找账号目录失败:', e)
    }

    return null
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
      this.dbDir = dbDir

      const contactDbPath = path.join(dbDir, 'contact.db')
      if (fs.existsSync(contactDbPath)) {
        this.contactDb = new Database(contactDbPath, { readonly: true })
      }

      const headImageDbPath = path.join(dbDir, 'head_image.db')
      if (fs.existsSync(headImageDbPath)) {
        this.headImageDb = new Database(headImageDbPath, { readonly: true })
      }

      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  close(): void {
    try {
      this.contactDb?.close()
      this.messageDbCache.forEach(db => {
        try { db.close() } catch { }
      })
    } catch { }
    this.contactDb = null
    this.messageDbCache.clear()
    this.contactColumnsCache = null
    this.dbDir = null
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

  private findMessageDbs(): string[] {
    if (!this.dbDir) return []
    const dbs: string[] = []
    try {
      const files = fs.readdirSync(this.dbDir)
      for (const file of files) {
        const lower = file.toLowerCase()
        if ((lower.startsWith('message') || lower.startsWith('msg')) && lower.endsWith('.db')) {
          dbs.push(path.join(this.dbDir, file))
        }
      }
    } catch { }
    return dbs
  }

  private getTableNameHash(sessionId: string): string {
    const crypto = require('crypto')
    return crypto.createHash('md5').update(sessionId).digest('hex')
  }

  private findMessageTable(db: Database.Database, sessionId: string): string | null {
    try {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
      ).all() as any[]
      const hash = this.getTableNameHash(sessionId)
      for (const table of tables) {
        if ((table.name as string).includes(hash)) {
          return table.name
        }
      }
    } catch { }
    return null
  }

  private findSessionTables(sessionId: string): { db: Database.Database; tableName: string; dbPath: string }[] {
    const dbs = this.findMessageDbs()
    const result: { db: Database.Database; tableName: string; dbPath: string }[] = []

    for (const dbPath of dbs) {
      const db = this.getMessageDb(dbPath)
      if (!db) continue
      const tableName = this.findMessageTable(db, sessionId)
      if (tableName) {
        result.push({ db, tableName, dbPath })
      }
    }
    return result
  }

  /**
   * 获取联系人信息
   */
  private async getContactInfo(username: string): Promise<{ displayName: string; avatarUrl?: string }> {
    if (!this.contactDb) return { displayName: username }

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
        SELECT ${selectCols.join(', ')} FROM contact WHERE username = ?
      `).get(username) as any

      if (contact) {
        const displayName = contact.remark || contact.nick_name || contact.alias || username
        let avatarUrl: string | undefined

        // 优先使用 URL 头像
        if (hasBigHeadUrl && contact.big_head_url) {
          avatarUrl = contact.big_head_url
        } else if (hasSmallHeadUrl && contact.small_head_url) {
          avatarUrl = contact.small_head_url
        }

        // 如果没有 URL 头像，尝试从 head_image.db 获取 base64
        if (!avatarUrl) {
          avatarUrl = await this.getAvatarFromHeadImageDb(username)
        }

        return { displayName, avatarUrl }
      }
    } catch { }
    return { displayName: username }
  }

  /**
   * 从 head_image.db 获取头像（转换为 base64 data URL）
   */
  private async getAvatarFromHeadImageDb(username: string): Promise<string | undefined> {
    if (!this.headImageDb || !username) return undefined

    try {
      const row = this.headImageDb.prepare(`
        SELECT image_buffer FROM head_image WHERE username = ?
      `).get(username) as any

      if (!row || !row.image_buffer) return undefined

      const buffer = Buffer.from(row.image_buffer)
      const base64 = buffer.toString('base64')
      return `data:image/jpeg;base64,${base64}`
    } catch {
      return undefined
    }
  }

  /**
   * 从转账消息 XML 中提取并解析 "谁转账给谁" 描述
   */
  private async resolveTransferDesc(
    content: string,
    myWxid: string,
    groupNicknamesMap: Map<string, string>,
    getContactName: (username: string) => Promise<string>
  ): Promise<string | null> {
    const xmlType = this.extractXmlValue(content, 'type')
    if (xmlType !== '2000') return null

    const payerUsername = this.extractXmlValue(content, 'payer_username')
    const receiverUsername = this.extractXmlValue(content, 'receiver_username')
    if (!payerUsername || !receiverUsername) return null

    const cleanedMyWxid = myWxid ? this.cleanAccountDirName(myWxid) : ''

    const resolveName = async (username: string): Promise<string> => {
      if (myWxid && (username === myWxid || username === cleanedMyWxid)) {
        const groupNick = groupNicknamesMap.get(username) || groupNicknamesMap.get(username.toLowerCase())
        if (groupNick) return groupNick
        return '我'
      }
      const groupNick = groupNicknamesMap.get(username) || groupNicknamesMap.get(username.toLowerCase())
      if (groupNick) return groupNick
      return getContactName(username)
    }

    const [payerName, receiverName] = await Promise.all([
      resolveName(payerUsername),
      resolveName(receiverUsername)
    ])

    return `${payerName} 转账给 ${receiverName}`
  }

  /**
   * 转换微信消息类型到 ChatLab 类型
   */
  private convertMessageType(localType: number, content: string): number {
    // 检查 XML 中的 type 标签（支持大 localType 的情况）
    const xmlTypeMatch = /<type>(\d+)<\/type>/i.exec(content)
    const xmlType = xmlTypeMatch ? parseInt(xmlTypeMatch[1]) : null

    // 特殊处理 type 49 或 XML type
    if (localType === 49 || xmlType) {
      const subType = xmlType || 0
      switch (subType) {
        case 6: return 4   // 文件 -> FILE
        case 19: return 7  // 聊天记录 -> LINK (ChatLab 没有专门的聊天记录类型)
        case 33:
        case 36: return 24 // 小程序 -> SHARE
        case 57: return 25 // 引用回复 -> REPLY
        case 2000: return 99 // 转账 -> OTHER (ChatLab 没有转账类型)
        case 5:
        case 49: return 7  // 链接 -> LINK
        default:
          if (xmlType) return 7 // 有 XML type 但未知，默认为链接
      }
    }
    return MESSAGE_TYPE_MAP[localType] ?? 99 // 未知类型 -> OTHER
  }

  /**
   * 解码消息内容
   */
  private decodeMessageContent(messageContent: any, compressContent: any): string {
    let content = this.decodeMaybeCompressed(compressContent)
    if (!content || content.length === 0) {
      content = this.decodeMaybeCompressed(messageContent)
    }
    return content
  }

  private decodeMaybeCompressed(raw: any): string {
    if (!raw) return ''
    if (Buffer.isBuffer(raw)) {
      return this.decodeBinaryContent(raw)
    }
    if (typeof raw === 'string') {
      if (raw.length === 0) return ''
      // 只有当字符串足够长（超过16字符）且看起来像 hex 时才尝试解码
      // 短字符串（如 "123456" 等纯数字）容易被误判为 hex
      if (raw.length > 16 && this.looksLikeHex(raw)) {
        const bytes = Buffer.from(raw, 'hex')
        if (bytes.length > 0) return this.decodeBinaryContent(bytes)
      }
      // 只有当字符串足够长（超过16字符）且看起来像 base64 时才尝试解码
      // 短字符串（如 "test", "home" 等）容易被误判为 base64
      if (raw.length > 16 && this.looksLikeBase64(raw)) {
        try {
          const bytes = Buffer.from(raw, 'base64')
          return this.decodeBinaryContent(bytes)
        } catch { }
      }
      return raw
    }
    return ''
  }

  private decodeBinaryContent(data: Buffer): string {
    if (data.length === 0) return ''
    try {
      if (data.length >= 4) {
        const magic = data.readUInt32LE(0)
        if (magic === 0xFD2FB528) {
          const fzstd = require('fzstd')
          const decompressed = fzstd.decompress(data)
          return Buffer.from(decompressed).toString('utf-8')
        }
      }
      const decoded = data.toString('utf-8')
      const replacementCount = (decoded.match(/\uFFFD/g) || []).length
      if (replacementCount < decoded.length * 0.2) {
        return decoded.replace(/\uFFFD/g, '')
      }
      return data.toString('latin1')
    } catch {
      return ''
    }
  }

  private looksLikeHex(s: string): boolean {
    if (s.length % 2 !== 0) return false
    return /^[0-9a-fA-F]+$/.test(s)
  }

  private looksLikeBase64(s: string): boolean {
    if (s.length % 4 !== 0) return false
    return /^[A-Za-z0-9+/=]+$/.test(s)
  }

  /**
   * 解析消息内容为可读文本
   */
  private parseMessageContent(content: string, localType: number, sessionId?: string, createTime?: number, mediaPathMap?: Map<number, string>): string | null {
    if (!content) return null

    // 检查 XML 中的 type 标签（支持大 localType 的情况）
    const xmlTypeMatch = /<type>(\d+)<\/type>/i.exec(content)
    const xmlType = xmlTypeMatch ? xmlTypeMatch[1] : null

    switch (localType) {
      case 1: // 文本
        return this.stripSenderPrefix(content)
      case 3: {
        // 图片消息：如果有媒体映射表，返回相对路径
        if (mediaPathMap && createTime && mediaPathMap.has(createTime)) {
          return `[图片] ${mediaPathMap.get(createTime)}`
        }
        return '[图片]'
      }
      case 34: {
        // 语音消息
        const transcript = (sessionId && createTime) ? voiceTranscribeService.getCachedTranscript(sessionId, createTime) : null
        if (mediaPathMap && createTime && mediaPathMap.has(createTime)) {
          return `[语音消息] ${mediaPathMap.get(createTime)}${transcript ? ' ' + transcript : ''}`
        }
        if (transcript) {
          return `[语音消息] ${transcript}`
        }
        return '[语音消息]'
      }
      case 42: return '[名片]'
      case 43: {
        if (mediaPathMap && createTime && mediaPathMap.has(createTime)) {
          return `[视频] ${mediaPathMap.get(createTime)}`
        }
        return '[视频]'
      }
      case 47: {
        if (mediaPathMap && createTime && mediaPathMap.has(createTime)) {
          return `[动画表情] ${mediaPathMap.get(createTime)}`
        }
        return '[动画表情]'
      }
      case 48: return '[位置]'
      case 49: {
        const title = this.extractXmlValue(content, 'title')
        const type = this.extractXmlValue(content, 'type')

        // 群公告消息（type 87）
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

        if (type === '6') {
          if (mediaPathMap && createTime && mediaPathMap.has(createTime)) {
            return `[文件] ${mediaPathMap.get(createTime)} ${title || ''}`
          }
          return title ? `[文件] ${title}` : '[文件]'
        }
        if (type === '19') return title ? `[聊天记录] ${title}` : '[聊天记录]'
        if (type === '33' || type === '36') return title ? `[小程序] ${title}` : '[小程序]'
        if (type === '57') return title || '[引用消息]'
        if (type === '5' || type === '49') return title ? `[链接] ${title}` : '[链接]'
        return title ? `[链接] ${title}` : '[链接]'
      }
      case 50: return '[通话]'
      case 10000: return this.cleanSystemMessage(content)
      case 244813135921: {
        // 引用消息
        const title = this.extractXmlValue(content, 'title')
        return title || '[引用消息]'
      }
      default:
        // 对于未知的 localType，检查 XML type 来判断消息类型
        if (xmlType) {
          const title = this.extractXmlValue(content, 'title')

          // 群公告消息（type 87）
          if (xmlType === '87') {
            const textAnnouncement = this.extractXmlValue(content, 'textannouncement')
            if (textAnnouncement) {
              return `[群公告] ${textAnnouncement}`
            }
            return '[群公告]'
          }

          // 转账消息
          if (xmlType === '2000') {
            const feedesc = this.extractXmlValue(content, 'feedesc')
            const payMemo = this.extractXmlValue(content, 'pay_memo')
            if (feedesc) {
              return payMemo ? `[转账] ${feedesc} ${payMemo}` : `[转账] ${feedesc}`
            }
            return '[转账]'
          }

          // 其他类型
          if (xmlType === '6') {
            if (mediaPathMap && createTime && mediaPathMap.has(createTime)) {
              return `[文件] ${mediaPathMap.get(createTime)} ${title || ''}`
            }
            return title ? `[文件] ${title}` : '[文件]'
          }
          if (xmlType === '19') return title ? `[聊天记录] ${title}` : '[聊天记录]'
          if (xmlType === '33' || xmlType === '36') return title ? `[小程序] ${title}` : '[小程序]'
          if (xmlType === '57') return title || '[引用消息]'
          if (xmlType === '5' || xmlType === '49') return title ? `[链接] ${title}` : '[链接]'

          // 有 title 就返回 title
          if (title) return title
        }

        // 最后尝试提取文本内容
        return this.stripSenderPrefix(content) || null
    }
  }

  private stripSenderPrefix(content: string): string {
    return content.replace(/^[\s]*([a-zA-Z0-9_-]+):(?!\/\/)\s*/, '')
  }

  /**
   * 从撤回消息内容中提取撤回者的 wxid
   * @returns { isRevoke: true, isSelfRevoke: true } - 是自己撤回的消息
   * @returns { isRevoke: true, revokerWxid: string } - 是别人撤回的消息，提取到撤回者
   * @returns { isRevoke: false } - 不是撤回消息
   */
  private extractRevokerInfo(content: string): { isRevoke: boolean; isSelfRevoke?: boolean; revokerWxid?: string } {
    if (!content) return { isRevoke: false }

    // 检查是否是撤回消息
    if (!content.includes('revokemsg') && !content.includes('撤回')) {
      return { isRevoke: false }
    }

    // 检查是否是 "你撤回了" - 自己撤回
    if (content.includes('你撤回')) {
      return { isRevoke: true, isSelfRevoke: true }
    }

    // 尝试从 <session> 标签提取（格式: wxid_xxx）
    const sessionMatch = /<session>([^<]+)<\/session>/i.exec(content)
    if (sessionMatch) {
      const session = sessionMatch[1].trim()
      // 如果 session 是 wxid 格式，返回它
      if (session.startsWith('wxid_') || /^[a-zA-Z][a-zA-Z0-9_-]+$/.test(session)) {
        return { isRevoke: true, revokerWxid: session }
      }
    }

    // 尝试从 <fromusername> 提取
    const fromUserMatch = /<fromusername>([^<]+)<\/fromusername>/i.exec(content)
    if (fromUserMatch) {
      return { isRevoke: true, revokerWxid: fromUserMatch[1].trim() }
    }

    // 是撤回消息但无法提取撤回者
    return { isRevoke: true }
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

  /**
   * 导出单个会话为 ChatLab 格式
   */
  async exportSessionToChatLab(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.dbDir) {
        const connectResult = await this.connect()
        if (!connectResult.success) return connectResult
      }

      const myWxid = this.configService.get('myWxid') || ''
      const cleanedMyWxid = this.cleanAccountDirName(myWxid)
      const isGroup = sessionId.includes('@chatroom')

      // 获取会话信息
      const sessionInfo = await this.getContactInfo(sessionId)

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing',
        detail: '正在准备导出...'
      })

      // 查找消息表
      const dbTablePairs = this.findSessionTables(sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息' }
      }

      // 收集所有消息
      const allMessages: any[] = []
      const memberSet = new Map<string, ChatLabMember>()
      // 群昵称缓存 (platformId -> groupNickname)
      const groupNicknameCache = new Map<string, string>()

      for (const { db, tableName, dbPath } of dbTablePairs) {
        try {
          // 检查是否有 Name2Id 表
          const hasName2Id = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='Name2Id'"
          ).get()

          let sql: string
          if (hasName2Id) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   ORDER BY m.create_time ASC`
          } else {
            sql = `SELECT * FROM ${tableName} ORDER BY create_time ASC`
          }

          const rows = db.prepare(sql).all() as any[]

          for (const row of rows) {
            const createTime = row.create_time || 0

            // 时间范围过滤
            if (options.dateRange) {
              if (createTime < options.dateRange.start || createTime > options.dateRange.end) {
                continue
              }
            }

            const content = this.decodeMessageContent(row.message_content, row.compress_content)
            const localType = row.local_type || row.type || 1
            const senderUsername = row.sender_username || ''

            // 判断是否是自己发送
            const isSend = row.is_send === 1 || senderUsername === cleanedMyWxid

            // 确定实际发送者
            let actualSender: string
            if (localType === 10000 || localType === 266287972401) {
              // 系统消息特殊处理
              const revokeInfo = this.extractRevokerInfo(content)
              if (revokeInfo.isRevoke) {
                // 撤回消息
                if (revokeInfo.isSelfRevoke) {
                  // "你撤回了" - 发送者是当前用户
                  actualSender = cleanedMyWxid
                } else if (revokeInfo.revokerWxid) {
                  // 提取到了撤回者的 wxid
                  actualSender = revokeInfo.revokerWxid
                } else {
                  // 无法确定撤回者，使用 sessionId
                  actualSender = sessionId
                }
              } else {
                // 普通系统消息（如"xxx加入群聊"），发送者是群聊ID
                actualSender = sessionId
              }
            } else {
              actualSender = isSend ? cleanedMyWxid : senderUsername
            }

            // 提取消息ID (local_id 或 server_id)
            const platformMessageId = row.server_id ? String(row.server_id) : (row.local_id ? String(row.local_id) : undefined)

            // 提取引用消息ID (从 type 57 的 XML 中解析)
            let replyToMessageId: string | undefined
            if (localType === 49 && content.includes('<type>57</type>')) {
              const svridMatch = /<svrid>(\d+)<\/svrid>/i.exec(content)
              if (svridMatch) {
                replyToMessageId = svridMatch[1]
              }
            }

            // 提取群昵称 (从消息内容中解析)
            let groupNickname: string | undefined
            if (isGroup && actualSender) {
              // 尝试从缓存获取
              if (groupNicknameCache.has(actualSender)) {
                groupNickname = groupNicknameCache.get(actualSender)
              } else {
                // 尝试从消息内容中提取群昵称
                const nicknameFromContent = this.extractGroupNickname(content, actualSender)
                if (nicknameFromContent) {
                  groupNickname = nicknameFromContent
                  groupNicknameCache.set(actualSender, nicknameFromContent)
                }
              }
            }

            // 检查是否是聊天记录消息（type=19）
            const xmlType = this.extractXmlValue(content, 'type')
            let chatRecordList: any[] | undefined
            if (xmlType === '19' || localType === 49) {
              chatRecordList = this.parseChatHistory(content)
            }

            allMessages.push({
              createTime,
              localType,
              content,
              senderUsername: actualSender,
              isSend,
              platformMessageId,
              replyToMessageId,
              groupNickname,
              chatRecordList
            })

            // 收集成员信息
            if (actualSender && !memberSet.has(actualSender)) {
              const memberInfo = await this.getContactInfo(actualSender)
              memberSet.set(actualSender, {
                platformId: actualSender,
                accountName: memberInfo.displayName,
                ...(groupNickname && { groupNickname }),
                ...(options.exportAvatars && memberInfo.avatarUrl && { avatar: memberInfo.avatarUrl })
              })
            } else if (actualSender && groupNickname && !memberSet.get(actualSender)?.groupNickname) {
              // 更新已有成员的群昵称
              const existing = memberSet.get(actualSender)!
              memberSet.set(actualSender, { ...existing, groupNickname })
            }
          }
        } catch (e) {
          console.error('导出消息失败:', e)
        }
      }

      // 按时间排序
      allMessages.sort((a, b) => a.createTime - b.createTime)

      onProgress?.({
        current: 50,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'exporting',
        detail: '正在读取消息...'
      })

      // 构建 ChatLab 格式消息
      const chatLabMessages: ChatLabMessage[] = []

      for (const msg of allMessages) {
        const memberInfo = memberSet.get(msg.senderUsername) || { platformId: msg.senderUsername, accountName: msg.senderUsername }
        let parsedContent = this.parseMessageContent(msg.content, msg.localType, sessionId, msg.createTime, options.mediaPathMap)

        // 转账消息：追加 "谁转账给谁" 信息
        if (parsedContent && parsedContent.startsWith('[转账]') && msg.content) {
          const transferDesc = await this.resolveTransferDesc(
            msg.content,
            myWxid,
            new Map<string, string>(),
            async (username) => {
              const info = await this.getContactInfo(username)
              return info.displayName || username
            }
          )
          if (transferDesc) {
            parsedContent = parsedContent.replace('[转账]', `[转账] (${transferDesc})`)
          }
        }

        const message: ChatLabMessage = {
          sender: msg.senderUsername,
          accountName: memberInfo.accountName,
          timestamp: msg.createTime,
          type: this.convertMessageType(msg.localType, msg.content),
          content: parsedContent
        }

        // 添加可选字段
        if (msg.groupNickname) message.groupNickname = msg.groupNickname
        if (msg.platformMessageId) message.platformMessageId = msg.platformMessageId
        if (msg.replyToMessageId) message.replyToMessageId = msg.replyToMessageId

        // 如果有聊天记录，添加为嵌套字段
        if (msg.chatRecordList && msg.chatRecordList.length > 0) {
          const chatRecords: ChatRecordItem[] = []

          for (const record of msg.chatRecordList) {
            // 解析时间戳 (格式: "YYYY-MM-DD HH:MM:SS")
            let recordTimestamp = msg.createTime
            if (record.sourcetime) {
              try {
                const timeParts = record.sourcetime.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
                if (timeParts) {
                  const date = new Date(
                    parseInt(timeParts[1]),
                    parseInt(timeParts[2]) - 1,
                    parseInt(timeParts[3]),
                    parseInt(timeParts[4]),
                    parseInt(timeParts[5]),
                    parseInt(timeParts[6])
                  )
                  recordTimestamp = Math.floor(date.getTime() / 1000)
                }
              } catch (e) {
                console.error('解析聊天记录时间失败:', e)
              }
            }

            // 转换消息类型
            let recordType = 0 // TEXT
            let recordContent = record.datadesc || record.datatitle || ''

            switch (record.datatype) {
              case 1:
                recordType = 0 // TEXT
                break
              case 3:
                recordType = 1 // IMAGE
                recordContent = '[图片]'
                break
              case 8:
              case 49:
                recordType = 4 // FILE
                recordContent = record.datatitle ? `[文件] ${record.datatitle}` : '[文件]'
                break
              case 34:
                recordType = 2 // VOICE
                recordContent = '[语音消息]'
                break
              case 43:
                recordType = 3 // VIDEO
                recordContent = '[视频]'
                break
              case 47:
                recordType = 5 // EMOJI
                recordContent = '[动画表情]'
                break
              default:
                recordType = 0
                recordContent = record.datadesc || record.datatitle || '[消息]'
            }

            const chatRecord: ChatRecordItem = {
              sender: record.sourcename || 'unknown',
              accountName: record.sourcename || 'unknown',
              timestamp: recordTimestamp,
              type: recordType,
              content: recordContent
            }

            // 添加头像（如果启用导出头像）
            if (options.exportAvatars && record.sourceheadurl) {
              chatRecord.avatar = record.sourceheadurl
            }

            chatRecords.push(chatRecord)

            // 添加成员信息
            if (record.sourcename && !memberSet.has(record.sourcename)) {
              memberSet.set(record.sourcename, {
                platformId: record.sourcename,
                accountName: record.sourcename,
                ...(options.exportAvatars && record.sourceheadurl && { avatar: record.sourceheadurl })
              })
            }
          }

          message.chatRecords = chatRecords
        }

        chatLabMessages.push(message)
      }

      // 构建 meta
      const meta: ChatLabMeta = {
        name: sessionInfo.displayName,
        platform: 'wechat',
        type: isGroup ? 'group' : 'private',
        ownerId: cleanedMyWxid
      }
      if (isGroup) {
        meta.groupId = sessionId
        // 添加群头像
        if (options.exportAvatars && sessionInfo.avatarUrl) {
          meta.groupAvatar = sessionInfo.avatarUrl
        }
      }

      const chatLabExport: ChatLabExport = {
        chatlab: {
          version: '0.0.2',
          exportedAt: Math.floor(Date.now() / 1000),
          generator: 'CipherTalk'
        },
        meta,
        members: Array.from(memberSet.values()),
        messages: chatLabMessages
      }

      onProgress?.({
        current: 80,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing',
        detail: '正在写入文件...'
      })

      // 写入文件
      if (options.format === 'chatlab-jsonl') {
        // JSONL 格式
        const lines: string[] = []
        lines.push(JSON.stringify({
          _type: 'header',
          chatlab: chatLabExport.chatlab,
          meta: chatLabExport.meta
        }))
        for (const member of chatLabExport.members) {
          lines.push(JSON.stringify({ _type: 'member', ...member }))
        }
        for (const message of chatLabExport.messages) {
          lines.push(JSON.stringify({ _type: 'message', ...message }))
        }
        fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8')
      } else {
        // JSON 格式
        fs.writeFileSync(outputPath, JSON.stringify(chatLabExport, null, 2), 'utf-8')
      }

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete',
        detail: '导出完成'
      })

      return { success: true }
    } catch (e) {
      console.error('ExportService: 导出失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 从消息内容中提取群昵称
   */
  private extractGroupNickname(content: string, senderUsername: string): string | undefined {
    // 尝试从 msgsource 中提取
    const msgsourceMatch = /<msgsource>[\s\S]*?<\/msgsource>/i.exec(content)
    if (msgsourceMatch) {
      // 提取 <atuserlist> 或其他可能包含昵称的字段
      const displaynameMatch = /<displayname>([^<]+)<\/displayname>/i.exec(msgsourceMatch[0])
      if (displaynameMatch) {
        return displaynameMatch[1]
      }
    }
    return undefined
  }

  /**
   * 解析合并转发的聊天记录 (Type 19)
   */
  private parseChatHistory(content: string): any[] | undefined {
    try {
      const type = this.extractXmlValue(content, 'type')
      if (type !== '19') return undefined

      // 提取 recorditem 中的 CDATA
      const match = /<recorditem>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?<\/recorditem>/.exec(content)
      if (!match) return undefined

      const innerXml = match[1]
      const items: any[] = []
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

        items.push({
          datatype,
          sourcename,
          sourcetime,
          sourceheadurl,
          datadesc: this.decodeHtmlEntities(datadesc),
          datatitle: this.decodeHtmlEntities(datatitle),
          fileext,
          datasize
        })
      }

      return items.length > 0 ? items : undefined
    } catch (e) {
      console.error('ExportService: 解析聊天记录失败:', e)
      return undefined
    }
  }

  /**
   * 解码 HTML 实体
   */
  private decodeHtmlEntities(text: string): string {
    if (!text) return ''
    return text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
  }

  /**
   * 格式化聊天记录为 JSON 导出格式
   */
  private formatChatRecordsForJson(chatRecordList: any[], options: ExportOptions): any[] {
    return chatRecordList.map(record => {
      // 解析时间戳
      let timestamp = 0
      if (record.sourcetime) {
        try {
          const timeParts = record.sourcetime.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
          if (timeParts) {
            const date = new Date(
              parseInt(timeParts[1]),
              parseInt(timeParts[2]) - 1,
              parseInt(timeParts[3]),
              parseInt(timeParts[4]),
              parseInt(timeParts[5]),
              parseInt(timeParts[6])
            )
            timestamp = Math.floor(date.getTime() / 1000)
          }
        } catch (e) {
          console.error('解析聊天记录时间失败:', e)
        }
      }

      // 转换消息类型名称
      let typeName = '文本消息'
      let content = record.datadesc || record.datatitle || ''

      switch (record.datatype) {
        case 1:
          typeName = '文本消息'
          break
        case 3:
          typeName = '图片消息'
          content = '[图片]'
          break
        case 8:
        case 49:
          typeName = '文件消息'
          content = record.datatitle ? `[文件] ${record.datatitle}` : '[文件]'
          break
        case 34:
          typeName = '语音消息'
          content = '[语音消息]'
          break
        case 43:
          typeName = '视频消息'
          content = '[视频]'
          break
        case 47:
          typeName = '动画表情'
          content = '[动画表情]'
          break
        default:
          typeName = '其他消息'
          content = record.datadesc || record.datatitle || '[消息]'
      }

      const chatRecord: any = {
        sender: record.sourcename || 'unknown',
        senderDisplayName: record.sourcename || 'unknown',
        timestamp,
        formattedTime: timestamp > 0 ? this.formatTimestamp(timestamp) : record.sourcetime,
        type: typeName,
        datatype: record.datatype,
        content
      }

      // 添加头像
      if (options.exportAvatars && record.sourceheadurl) {
        chatRecord.senderAvatar = record.sourceheadurl
      }

      // 添加文件信息
      if (record.fileext) {
        chatRecord.fileExt = record.fileext
      }
      if (record.datasize > 0) {
        chatRecord.fileSize = record.datasize
      }

      return chatRecord
    })
  }

  /**
   * 从 extra_buffer 中提取手机号
   * 微信的 extra_buffer 是 protobuf 格式的二进制数据
   * 手机号通常存储在特定的 tag 字段中
   */
  private extractPhoneFromExtraBuf(extraBuffer: any): string | undefined {
    if (!extraBuffer) return undefined

    try {
      let data: Buffer
      if (Buffer.isBuffer(extraBuffer)) {
        data = extraBuffer
      } else if (typeof extraBuffer === 'string') {
        // 可能是 hex 或 base64 编码
        if (/^[0-9a-fA-F]+$/.test(extraBuffer)) {
          data = Buffer.from(extraBuffer, 'hex')
        } else {
          data = Buffer.from(extraBuffer, 'base64')
        }
      } else {
        return undefined
      }

      if (data.length === 0) return undefined

      // 方法1: 尝试解析微信的 protobuf-like 格式
      // 微信 extra_buffer 格式: [tag(1byte)][length(1-2bytes)][data]
      // 手机号可能在 tag 0x42 (66) 或其他位置
      const phoneFromProtobuf = this.parseWechatExtraBuffer(data)
      if (phoneFromProtobuf) return phoneFromProtobuf

      // 方法2: 转为字符串尝试匹配
      const str = data.toString('utf-8')

      // 尝试匹配手机号格式（中国大陆手机号）
      const phoneRegex = /1[3-9]\d{9}/g
      const matches = str.match(phoneRegex)
      if (matches && matches.length > 0) {
        return matches[0]
      }

      // 尝试匹配带国际区号的手机号 +86
      const intlRegex = /\+86\s*1[3-9]\d{9}/g
      const intlMatches = str.match(intlRegex)
      if (intlMatches && intlMatches.length > 0) {
        return intlMatches[0].replace(/\s+/g, '')
      }

      // 方法3: 在二进制数据中查找手机号模式
      const hexStr = data.toString('hex')
      // 手机号 ASCII: 31 (1) 后跟 3-9 的数字
      const hexPhoneRegex = /31[33-39][30-39]{9}/gi
      const hexMatches = hexStr.match(hexPhoneRegex)
      if (hexMatches && hexMatches.length > 0) {
        const phone = Buffer.from(hexMatches[0], 'hex').toString('ascii')
        if (/^1[3-9]\d{9}$/.test(phone)) {
          return phone
        }
      }

      // 方法4: 尝试 latin1 编码
      const latin1Str = data.toString('latin1')
      const latin1Matches = latin1Str.match(phoneRegex)
      if (latin1Matches && latin1Matches.length > 0) {
        return latin1Matches[0]
      }
    } catch (e) {
      // 解析失败，忽略
    }

    return undefined
  }

  /**
   * 解析微信 extra_buffer 的 protobuf-like 格式
   * 格式: 连续的 [tag][length][value] 结构
   */
  private parseWechatExtraBuffer(data: Buffer): string | undefined {
    try {
      let offset = 0
      const results: { tag: number; value: string }[] = []

      while (offset < data.length - 2) {
        const tag = data[offset]
        offset++

        // 读取长度 (可能是 1 或 2 字节)
        let length = data[offset]
        offset++

        // 如果长度字节的高位为1，可能是变长编码
        if (length > 127 && offset < data.length) {
          // 简单处理：跳过这个字段
          length = length & 0x7f
        }

        if (length === 0 || offset + length > data.length) {
          // 无效长度，尝试下一个位置
          continue
        }

        // 读取值
        const valueBytes = data.slice(offset, offset + length)
        offset += length

        // 尝试解码为字符串
        const valueStr = valueBytes.toString('utf-8')

        // 检查是否是手机号
        const phoneMatch = valueStr.match(/^1[3-9]\d{9}$/)
        if (phoneMatch) {
          return phoneMatch[0]
        }

        // 检查是否包含手机号
        const containsPhone = valueStr.match(/1[3-9]\d{9}/)
        if (containsPhone) {
          return containsPhone[0]
        }

        results.push({ tag, value: valueStr })
      }

      // 在所有解析出的值中查找手机号
      for (const item of results) {
        const phoneMatch = item.value.match(/1[3-9]\d{9}/)
        if (phoneMatch) {
          return phoneMatch[0]
        }
      }
    } catch (e) {
      // 解析失败
    }

    return undefined
  }

  /**
   * 获取消息类型名称
   */
  private getMessageTypeName(localType: number, content?: string): string {
    // 检查 XML 中的 type 标签（支持大 localType 的情况）
    if (content) {
      const xmlTypeMatch = /<type>(\d+)<\/type>/i.exec(content)
      const xmlType = xmlTypeMatch ? xmlTypeMatch[1] : null

      if (xmlType) {
        switch (xmlType) {
          case '87': return '群公告'
          case '2000': return '转账消息'
          case '5': return '链接消息'
          case '6': return '文件消息'
          case '19': return '聊天记录'
          case '33':
          case '36': return '小程序消息'
          case '57': return '引用消息'
        }
      }
    }

    const typeNames: Record<number, string> = {
      1: '文本消息',
      3: '图片消息',
      34: '语音消息',
      42: '名片消息',
      43: '视频消息',
      47: '动画表情',
      48: '位置消息',
      49: '链接消息',
      50: '通话消息',
      10000: '系统消息'
    }
    return typeNames[localType] || '其他消息'
  }

  /**
   * 格式化时间戳为可读字符串
   */
  private formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp * 1000)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    const seconds = String(date.getSeconds()).padStart(2, '0')
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
  }

  /**
   * 导出单个会话为详细 JSON 格式（原项目格式）
   */
  async exportSessionToDetailedJson(
    sessionId: string,
    outputPath: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.dbDir) {
        const connectResult = await this.connect()
        if (!connectResult.success) return connectResult
      }

      const myWxid = this.configService.get('myWxid') || ''
      const cleanedMyWxid = this.cleanAccountDirName(myWxid)
      const isGroup = sessionId.includes('@chatroom')

      // 获取会话信息
      const sessionInfo = await this.getContactInfo(sessionId)
      const myInfo = await this.getContactInfo(cleanedMyWxid)

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'preparing',
        detail: '正在准备导出...'
      })

      // 查找消息表
      const dbTablePairs = this.findSessionTables(sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息' }
      }

      // 收集所有消息
      const allMessages: any[] = []
      let firstMessageTime: number | null = null
      let lastMessageTime: number | null = null

      for (const { db, tableName } of dbTablePairs) {
        try {
          const hasName2Id = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='Name2Id'"
          ).get()

          let sql: string
          if (hasName2Id) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   ORDER BY m.create_time ASC`
          } else {
            sql = `SELECT * FROM ${tableName} ORDER BY create_time ASC`
          }

          const rows = db.prepare(sql).all() as any[]

          for (const row of rows) {
            const createTime = row.create_time || 0

            if (options.dateRange) {
              if (createTime < options.dateRange.start || createTime > options.dateRange.end) {
                continue
              }
            }

            const content = this.decodeMessageContent(row.message_content, row.compress_content)
            const localType = row.local_type || row.type || 1
            const senderUsername = row.sender_username || ''
            const isSend = row.is_send === 1 || senderUsername === cleanedMyWxid

            // 确定实际发送者
            let actualSender: string
            if (localType === 10000 || localType === 266287972401) {
              // 系统消息特殊处理
              const revokeInfo = this.extractRevokerInfo(content)
              if (revokeInfo.isRevoke) {
                if (revokeInfo.isSelfRevoke) {
                  actualSender = cleanedMyWxid
                } else if (revokeInfo.revokerWxid) {
                  actualSender = revokeInfo.revokerWxid
                } else {
                  actualSender = sessionId
                }
              } else {
                actualSender = sessionId
              }
            } else {
              actualSender = isSend ? cleanedMyWxid : (senderUsername || sessionId)
            }
            const senderInfo = await this.getContactInfo(actualSender)

            // 提取 source（msgsource）
            let source = ''
            const msgsourceMatch = /<msgsource>[\s\S]*?<\/msgsource>/i.exec(content)
            if (msgsourceMatch) {
              source = msgsourceMatch[0]
            }

            // 提取消息ID
            const platformMessageId = row.server_id ? String(row.server_id) : (row.local_id ? String(row.local_id) : undefined)

            // 提取引用消息ID
            let replyToMessageId: string | undefined
            if (localType === 49 && content.includes('<type>57</type>')) {
              const svridMatch = /<svrid>(\d+)<\/svrid>/i.exec(content)
              if (svridMatch) {
                replyToMessageId = svridMatch[1]
              }
            }

            // 提取群昵称
            const groupNickname = isGroup ? this.extractGroupNickname(content, actualSender) : undefined

            // 检查是否是聊天记录消息（type=19）
            const xmlType = this.extractXmlValue(content, 'type')
            let chatRecordList: any[] | undefined
            if (xmlType === '19' || localType === 49) {
              chatRecordList = this.parseChatHistory(content)
            }

            allMessages.push({
              localId: row.local_id || allMessages.length + 1,
              platformMessageId,
              createTime,
              formattedTime: this.formatTimestamp(createTime),
              type: this.getMessageTypeName(localType, content),
              localType,
              chatLabType: this.convertMessageType(localType, content),
              content: this.parseMessageContent(content, localType, sessionId, createTime, options.mediaPathMap),
              rawContent: content, // 保留原始内容（用于转账描述解析）
              isSend: isSend ? 1 : 0,
              senderUsername: actualSender,
              senderDisplayName: senderInfo.displayName,
              ...(groupNickname && { groupNickname }),
              ...(replyToMessageId && { replyToMessageId }),
              ...(options.exportAvatars && senderInfo.avatarUrl && { senderAvatar: senderInfo.avatarUrl }),
              ...(chatRecordList && { chatRecords: this.formatChatRecordsForJson(chatRecordList, options) }),
              source
            })

            // 更新时间范围
            if (firstMessageTime === null || createTime < firstMessageTime) {
              firstMessageTime = createTime
            }
            if (lastMessageTime === null || createTime > lastMessageTime) {
              lastMessageTime = createTime
            }
          }
        } catch (e) {
          console.error('导出消息失败:', e)
        }
      }

      // 按时间排序
      allMessages.sort((a, b) => a.createTime - b.createTime)

      onProgress?.({
        current: 70,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'writing',
        detail: '正在写入文件...'
      })

      // 转账消息：追加 "谁转账给谁" 信息
      for (const msg of allMessages) {
        if (msg.content && msg.content.startsWith('[转账]') && msg.rawContent) {
          const transferDesc = await this.resolveTransferDesc(
            msg.rawContent,
            myWxid,
            new Map<string, string>(),
            async (username: string) => {
              const info = await this.getContactInfo(username)
              return info.displayName || username
            }
          )
          if (transferDesc) {
            msg.content = msg.content.replace('[转账]', `[转账] (${transferDesc})`)
          }
        }
      }

      // 构建详细 JSON 格式（包含 ChatLab 元信息）
      const detailedExport = {
        // ChatLab 兼容的元信息
        exportInfo: {
          version: '0.0.2',
          exportedAt: Math.floor(Date.now() / 1000),
          generator: 'CipherTalk',
          format: 'detailed-json'
        },
        session: {
          wxid: sessionId,
          nickname: sessionInfo.displayName,
          remark: sessionInfo.displayName,
          displayName: sessionInfo.displayName,
          type: isGroup ? '群聊' : '私聊',
          platform: 'wechat',
          isGroup,
          ownerId: cleanedMyWxid,
          ...(isGroup && { groupId: sessionId }),
          ...(options.exportAvatars && sessionInfo.avatarUrl && { avatar: sessionInfo.avatarUrl }),
          firstTimestamp: firstMessageTime,
          lastTimestamp: lastMessageTime,
          messageCount: allMessages.length
        },
        messages: allMessages
      }

      fs.writeFileSync(outputPath, JSON.stringify(detailedExport, null, 2), 'utf-8')

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: sessionInfo.displayName,
        phase: 'complete',
        detail: '导出完成'
      })

      return { success: true }
    } catch (e) {
      console.error('ExportService: 导出失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 导出单个会话为 Excel 格式
   */
  async exportSessionToExcel(
    sessionId: string,
    outputPath: string,
    options: ExportOptions
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.dbDir) {
        return { success: false, error: '数据库未连接' }
      }

      const sessionInfo = await this.getContactInfo(sessionId)
      const cleanedMyWxid = (this.configService.get('myWxid') || '').replace(/^wxid_/, '')
      const fullMyWxid = `wxid_${cleanedMyWxid}`

      // 查找消息数据库和表
      const dbTablePairs = this.findSessionTables(sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息' }
      }

      // 收集所有消息
      const allMessages: any[] = []

      for (const { db, tableName } of dbTablePairs) {
        try {
          const hasName2Id = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='Name2Id'"
          ).get()

          let sql: string
          if (hasName2Id) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   ORDER BY m.create_time ASC`
          } else {
            sql = `SELECT * FROM ${tableName} ORDER BY create_time ASC`
          }

          const rows = db.prepare(sql).all() as any[]

          for (const row of rows) {
            const createTime = row.create_time || 0

            if (options.dateRange) {
              if (createTime < options.dateRange.start || createTime > options.dateRange.end) {
                continue
              }
            }

            const content = this.decodeMessageContent(row.message_content, row.compress_content)
            const localType = row.local_type || row.type || 1
            const senderUsername = row.sender_username || ''

            // 判断是否是自己发送的消息
            const isSend = row.is_send === 1 ||
              senderUsername === cleanedMyWxid ||
              senderUsername === fullMyWxid

            // 确定实际发送者
            let actualSender: string
            if (localType === 10000 || localType === 266287972401) {
              // 系统消息特殊处理
              const revokeInfo = this.extractRevokerInfo(content)
              if (revokeInfo.isRevoke) {
                if (revokeInfo.isSelfRevoke) {
                  actualSender = cleanedMyWxid
                } else if (revokeInfo.revokerWxid) {
                  actualSender = revokeInfo.revokerWxid
                } else {
                  actualSender = sessionId
                }
              } else {
                actualSender = sessionId
              }
            } else {
              actualSender = isSend ? cleanedMyWxid : (senderUsername || sessionId)
            }
            const senderInfo = await this.getContactInfo(actualSender)

            // 检查是否是聊天记录消息（type=19）
            const xmlType = this.extractXmlValue(content, 'type')
            let chatRecordList: any[] | undefined
            if (xmlType === '19' || localType === 49) {
              chatRecordList = this.parseChatHistory(content)
            }

            allMessages.push({
              createTime,
              talker: actualSender,
              type: localType,
              content,
              senderName: senderInfo.displayName,
              senderAvatar: options.exportAvatars ? senderInfo.avatarUrl : undefined,
              isSend,
              chatRecordList
            })
          }
        } catch (e) {
          console.error(`读取消息表 ${tableName} 失败:`, e)
        }
      }

      if (allMessages.length === 0) {
        return { success: false, error: '没有消息可导出' }
      }

      // 按时间排序
      allMessages.sort((a, b) => a.createTime - b.createTime)

      // 准备 Excel 数据
      const excelData: any[] = []

      for (let index = 0; index < allMessages.length; index++) {
        const msg = allMessages[index]
        const msgType = this.getMessageTypeName(msg.type, msg.content)
        const time = new Date(msg.createTime * 1000)

        // 获取消息内容（使用统一的解析方法）
        let messageContent = this.parseMessageContent(msg.content, msg.type, sessionId, msg.createTime, options.mediaPathMap)

        // 转账消息：追加 "谁转账给谁" 信息
        if (messageContent && messageContent.startsWith('[转账]') && msg.content) {
          const transferDesc = await this.resolveTransferDesc(
            msg.content,
            fullMyWxid,
            new Map<string, string>(),
            async (username: string) => {
              const info = await this.getContactInfo(username)
              return info.displayName || username
            }
          )
          if (transferDesc) {
            messageContent = messageContent.replace('[转账]', `[转账] (${transferDesc})`)
          }
        }

        const row: any = {
          '序号': index + 1,
          '时间': time.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }),
          '日期': time.toLocaleDateString('zh-CN'),
          '时刻': time.toLocaleTimeString('zh-CN'),
          '星期': ['日', '一', '二', '三', '四', '五', '六'][time.getDay()],
          '发送者': msg.senderName,
          '微信ID': msg.talker,
          '消息类型': msgType,
          '消息内容': messageContent || '',
          '原始类型代码': msg.type,
          '时间戳': msg.createTime
        }

        // 只有勾选导出头像时才添加头像链接列
        if (options.exportAvatars && msg.senderAvatar) {
          row['头像链接'] = msg.senderAvatar
        }

        // 如果有聊天记录，添加聊天记录详情列
        if (msg.chatRecordList && msg.chatRecordList.length > 0) {
          const recordDetails = msg.chatRecordList.map((record: any, idx: number) => {
            const recordType = this.getChatRecordTypeName(record.datatype)
            const recordContent = this.getChatRecordContent(record)
            return `${idx + 1}. [${record.sourcename}] ${record.sourcetime} ${recordType}: ${recordContent}`
          }).join('\n')
          row['聊天记录详情'] = recordDetails
        }

        excelData.push(row)
      }

      // 创建工作簿
      const wb = XLSX.utils.book_new()
      const ws = XLSX.utils.json_to_sheet(excelData)

      // 设置列宽（根据是否导出头像和聊天记录动态调整）
      const colWidths: any[] = [
        { wch: 6 },   // 序号
        { wch: 20 },  // 时间
        { wch: 12 },  // 日期
        { wch: 10 },  // 时刻
        { wch: 6 },   // 星期
        { wch: 15 },  // 发送者
        { wch: 25 },  // 微信ID
        { wch: 12 },  // 消息类型
        { wch: 50 },  // 消息内容
        { wch: 8 },   // 原始类型代码
        { wch: 12 }   // 时间戳
      ]

      if (options.exportAvatars) {
        colWidths.push({ wch: 50 })  // 头像链接
      }

      // 检查是否有聊天记录消息
      const hasChatRecords = allMessages.some(msg => msg.chatRecordList && msg.chatRecordList.length > 0)
      if (hasChatRecords) {
        colWidths.push({ wch: 80 })  // 聊天记录详情
      }

      ws['!cols'] = colWidths

      // 添加工作表（工作表名称最多31个字符，且不能包含特殊字符）
      const sheetName = sessionInfo.displayName
        .substring(0, 31)
        .replace(/[:\\\/\?\*\[\]]/g, '_')
      XLSX.utils.book_append_sheet(wb, ws, sheetName)

      // 写入文件（使用 buffer 方式，避免 xlsx 直接写文件的问题）
      try {
        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' })
        fs.writeFileSync(outputPath, wbout)
      } catch (writeError) {
        console.error('写入文件失败:', writeError)
        return { success: false, error: `文件写入失败: ${String(writeError)}` }
      }

      return { success: true }
    } catch (e) {
      console.error('ExportService: Excel 导出失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 导出单个会话为 HTML 格式（数据内嵌版本）
   */
  async exportSessionToHtml(
    sessionId: string,
    outputPath: string,
    options: ExportOptions
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.dbDir) {
        return { success: false, error: '数据库未连接' }
      }

      const sessionInfo = await this.getContactInfo(sessionId)
      const myWxid = this.configService.get('myWxid') || ''
      const cleanedMyWxid = this.cleanAccountDirName(myWxid)
      const isGroup = sessionId.includes('@chatroom')

      // 查找消息数据库和表
      const dbTablePairs = this.findSessionTables(sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息' }
      }

      // 收集所有消息
      const allMessages: any[] = []
      const memberSet = new Map<string, any>()

      for (const { db, tableName } of dbTablePairs) {
        try {
          const hasName2Id = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='Name2Id'"
          ).get()

          let sql: string
          if (hasName2Id) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   ORDER BY m.create_time ASC`
          } else {
            sql = `SELECT * FROM ${tableName} ORDER BY create_time ASC`
          }

          const rows = db.prepare(sql).all() as any[]

          for (const row of rows) {
            const createTime = row.create_time || 0

            if (options.dateRange) {
              if (createTime < options.dateRange.start || createTime > options.dateRange.end) {
                continue
              }
            }

            const content = this.decodeMessageContent(row.message_content, row.compress_content)
            const localType = row.local_type || row.type || 1
            const senderUsername = row.sender_username || ''
            const isSend = row.is_send === 1 || senderUsername === cleanedMyWxid

            // 确定实际发送者
            let actualSender: string
            if (localType === 10000 || localType === 266287972401) {
              // 系统消息特殊处理
              const revokeInfo = this.extractRevokerInfo(content)
              if (revokeInfo.isRevoke) {
                if (revokeInfo.isSelfRevoke) {
                  actualSender = cleanedMyWxid
                } else if (revokeInfo.revokerWxid) {
                  actualSender = revokeInfo.revokerWxid
                } else {
                  actualSender = sessionId
                }
              } else {
                actualSender = sessionId
              }
            } else {
              actualSender = isSend ? cleanedMyWxid : (senderUsername || sessionId)
            }
            const senderInfo = await this.getContactInfo(actualSender)

            // 检查是否是聊天记录消息
            const xmlType = this.extractXmlValue(content, 'type')
            let chatRecordList: any[] | undefined
            if (xmlType === '19' || localType === 49) {
              chatRecordList = this.parseChatHistory(content)
            }

            allMessages.push({
              timestamp: createTime,
              sender: actualSender,
              senderName: senderInfo.displayName,
              type: localType,
              content: this.parseMessageContent(content, localType, sessionId, createTime, options.mediaPathMap),
              rawContent: content,
              isSend,
              chatRecords: chatRecordList ? this.formatChatRecordsForJson(chatRecordList, options) : undefined
            })

            // 收集成员信息
            if (!memberSet.has(actualSender)) {
              memberSet.set(actualSender, {
                id: actualSender,
                name: senderInfo.displayName,
                avatar: options.exportAvatars ? senderInfo.avatarUrl : undefined
              })
            }

            // 收集聊天记录中的成员
            if (chatRecordList) {
              for (const record of chatRecordList) {
                if (record.sourcename && !memberSet.has(record.sourcename)) {
                  memberSet.set(record.sourcename, {
                    id: record.sourcename,
                    name: record.sourcename,
                    avatar: options.exportAvatars ? record.sourceheadurl : undefined
                  })
                }
              }
            }
          }
        } catch (e) {
          console.error(`读取消息表 ${tableName} 失败:`, e)
        }
      }

      if (allMessages.length === 0) {
        return { success: false, error: '没有消息可导出' }
      }

      // 按时间排序
      allMessages.sort((a, b) => a.timestamp - b.timestamp)

      // 准备导出数据
      const exportData = {
        meta: {
          sessionId,
          sessionName: sessionInfo.displayName,
          isGroup,
          exportTime: Date.now(),
          messageCount: allMessages.length,
          dateRange: options.dateRange ? {
            start: options.dateRange.start,
            end: options.dateRange.end
          } : null
        },
        members: Array.from(memberSet.values()),
        messages: allMessages
      }

      // 直接写入单文件 HTML（CSS/JS/数据全部内联）
      const outputDir = path.dirname(outputPath)
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true })
      }

      fs.writeFileSync(outputPath, HtmlExportGenerator.generateHtmlWithData(exportData), 'utf-8')

      return { success: true }
    } catch (e) {
      console.error('ExportService: HTML 导出失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取聊天记录消息的类型名称
   */
  private getChatRecordTypeName(datatype: number): string {
    const typeNames: Record<number, string> = {
      1: '文本',
      3: '图片',
      8: '文件',
      34: '语音',
      43: '视频',
      47: '表情',
      49: '文件'
    }
    return typeNames[datatype] || '其他'
  }

  /**
   * 获取聊天记录消息的内容
   */
  private getChatRecordContent(record: any): string {
    switch (record.datatype) {
      case 1:
        return record.datadesc || record.datatitle || ''
      case 3:
        return '[图片]'
      case 8:
      case 49:
        return record.datatitle ? `[文件] ${record.datatitle}` : '[文件]'
      case 34:
        return '[语音消息]'
      case 43:
        return '[视频]'
      case 47:
        return '[动画表情]'
      default:
        return record.datadesc || record.datatitle || '[消息]'
    }
  }

  /**
   * 批量导出多个会话
   */
  async exportSessions(
    sessionIds: string[],
    outputDir: string,
    options: ExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; successCount: number; failCount: number; error?: string }> {
    let successCount = 0
    let failCount = 0

    try {
      if (!this.dbDir) {
        const connectResult = await this.connect()
        if (!connectResult.success) {
          return { success: false, successCount: 0, failCount: sessionIds.length, error: connectResult.error }
        }
      }

      // 确保输出目录存在
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true })
      }

      for (let i = 0; i < sessionIds.length; i++) {
        const sessionId = sessionIds[i]
        const sessionInfo = await this.getContactInfo(sessionId)

        onProgress?.({
          current: i + 1,
          total: sessionIds.length,
          currentSession: sessionInfo.displayName,
          phase: 'exporting',
          detail: '正在读取消息...'
        })

        // 生成文件名（清理非法字符）
        const safeName = sessionInfo.displayName.replace(/[<>:"\/\\|?*]/g, '_')
        let ext = '.json'
        if (options.format === 'chatlab-jsonl') ext = '.jsonl'
        else if (options.format === 'excel') ext = '.xlsx'
        else if (options.format === 'html') ext = '.html'

        // 当导出媒体时，创建会话子文件夹，把文件和媒体都放进去
        const hasMedia = options.exportImages || options.exportVideos || options.exportEmojis || options.exportVoices || options.exportFiles
        const sessionOutputDir = hasMedia ? path.join(outputDir, safeName) : outputDir
        if (hasMedia && !fs.existsSync(sessionOutputDir)) {
          fs.mkdirSync(sessionOutputDir, { recursive: true })
        }

        const outputPath = path.join(sessionOutputDir, `${safeName}${ext}`)

        // 先导出媒体文件，收集路径映射表
        let mediaPathMap: Map<number, string> | undefined
        if (hasMedia) {
          try {
            mediaPathMap = await this.exportMediaFiles(sessionId, safeName, sessionOutputDir, options, (detail) => {
              onProgress?.({
                current: i + 1,
                total: sessionIds.length,
                currentSession: sessionInfo.displayName,
                phase: 'writing',
                detail
              })
            })
          } catch (e) {
            console.error(`导出 ${sessionId} 媒体文件失败:`, e)
          }
        }

        // 将媒体路径映射表附加到 options 上
        const exportOpts = mediaPathMap ? { ...options, mediaPathMap } : options

        let result: { success: boolean; error?: string }

        // 根据格式选择导出方法
        if (options.format === 'json') {
          result = await this.exportSessionToDetailedJson(sessionId, outputPath, exportOpts)
        } else if (options.format === 'chatlab' || options.format === 'chatlab-jsonl') {
          result = await this.exportSessionToChatLab(sessionId, outputPath, exportOpts)
        } else if (options.format === 'excel') {
          result = await this.exportSessionToExcel(sessionId, outputPath, exportOpts)
        } else if (options.format === 'html') {
          result = await this.exportSessionToHtml(sessionId, outputPath, exportOpts)
        } else {
          result = { success: false, error: `不支持的格式: ${options.format}` }
        }

        if (result.success) {
          successCount++
        } else {
          failCount++
          console.error(`导出 ${sessionId} 失败:`, result.error)
        }

        // 让出事件循环，避免阻塞主进程
        await new Promise(resolve => setImmediate(resolve))
      }

      onProgress?.({
        current: sessionIds.length,
        total: sessionIds.length,
        currentSession: '',
        phase: 'complete',
        detail: '导出完成'
      })

      return { success: true, successCount, failCount }
    } catch (e) {
      return { success: false, successCount, failCount, error: String(e) }
    }
  }

  /**
   * 导出会话的媒体文件（图片和视频）
   */
  private async exportMediaFiles(
    sessionId: string,
    safeName: string,
    outputDir: string,
    options: ExportOptions,
    onDetail?: (detail: string) => void
  ): Promise<Map<number, string>> {
    // 返回 createTime → 相对路径 的映射表
    const mediaPathMap = new Map<number, string>()

    const dbTablePairs = this.findSessionTables(sessionId)
    if (dbTablePairs.length === 0) return mediaPathMap

    // 创建媒体输出目录（直接在会话文件夹下创建子目录）
    const imageOutDir = options.exportImages ? path.join(outputDir, 'images') : ''
    const videoOutDir = options.exportVideos ? path.join(outputDir, 'videos') : ''
    const emojiOutDir = options.exportEmojis ? path.join(outputDir, 'emojis') : ''
    const fileOutDir = options.exportFiles ? path.join(outputDir, 'files') : ''

    if (options.exportImages && !fs.existsSync(imageOutDir)) {
      fs.mkdirSync(imageOutDir, { recursive: true })
    }
    if (options.exportVideos && !fs.existsSync(videoOutDir)) {
      fs.mkdirSync(videoOutDir, { recursive: true })
    }
    if (options.exportEmojis && !fs.existsSync(emojiOutDir)) {
      fs.mkdirSync(emojiOutDir, { recursive: true })
    }
    if (options.exportFiles && !fs.existsSync(fileOutDir)) {
      fs.mkdirSync(fileOutDir, { recursive: true })
    }

    let imageCount = 0
    let videoCount = 0
    let emojiCount = 0
    let fileCount = 0
    let emojiTotal = 0
    let emojiProcessed = 0

    // 构建查询条件：只查需要的消息类型
    const typeConditions: string[] = []
    if (options.exportImages) typeConditions.push('3')
    if (options.exportVideos) typeConditions.push('43')
    if (options.exportEmojis) typeConditions.push('47')

    // 图片/视频/表情循环（语音在后面独立处理）
    if (typeConditions.length > 0) {
      // 预先统计表情总数
      if (options.exportEmojis) {
        for (const { db, tableName } of dbTablePairs) {
          try {
            const cnt = db.prepare(`SELECT COUNT(*) as c FROM ${tableName} WHERE local_type = 47`).get() as any
            emojiTotal += cnt?.c || 0
          } catch { }
        }
        if (emojiTotal > 0) onDetail?.(`正在导出表情包 (共 ${emojiTotal} 个)...`)
      }

      for (const { db, tableName } of dbTablePairs) {
        try {
          const hasName2Id = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='Name2Id'"
          ).get()

          const typeFilter = typeConditions.map(t => `local_type = ${t}`).join(' OR ')

          // 用 SELECT * 获取完整行，包含 packed_info_data
          let sql: string
          if (hasName2Id) {
            sql = `SELECT m.* FROM ${tableName} m WHERE (${typeFilter}) ORDER BY m.create_time ASC`
          } else {
            sql = `SELECT * FROM ${tableName} WHERE (${typeFilter}) ORDER BY create_time ASC`
          }

          const rows = db.prepare(sql).all() as any[]

          for (const row of rows) {
            const createTime = row.create_time || 0

            // 时间范围过滤
            if (options.dateRange) {
              if (createTime < options.dateRange.start || createTime > options.dateRange.end) {
                continue
              }
            }

            const localType = row.local_type || row.type || 1
            const content = this.decodeMessageContent(row.message_content, row.compress_content)

            // 导出图片
            if (options.exportImages && localType === 3) {
              try {
                // 从 XML 提取 md5
                const imageMd5 = this.extractXmlValue(content, 'md5') ||
                  (/\<img[^>]*\smd5\s*=\s*['"]([^'"]+)['"]/i.exec(content))?.[1] ||
                  undefined

                // 从 packed_info_data 解析 dat 文件名（缓存文件以此命名）
                const imageDatName = this.parseImageDatName(row)

                if (imageMd5 || imageDatName) {
                  const cacheResult = await imageDecryptService.decryptImage({
                    sessionId,
                    imageMd5,
                    imageDatName
                  })

                  if (cacheResult.success && cacheResult.localPath) {
                    // localPath 是 file:///path?v=xxx 格式，转为本地路径
                    let filePath = cacheResult.localPath
                      .replace(/\?v=\d+$/, '')
                      .replace(/^file:\/\/\//i, '')
                    filePath = decodeURIComponent(filePath)

                    if (fs.existsSync(filePath)) {
                      const ext = path.extname(filePath) || '.jpg'
                      const fileName = `${createTime}_${imageMd5 || imageDatName}${ext}`
                      const destPath = path.join(imageOutDir, fileName)
                      if (!fs.existsSync(destPath)) {
                        fs.copyFileSync(filePath, destPath)
                        imageCount++
                        // 记录映射：createTime → 相对路径
                        mediaPathMap.set(createTime, `images/${fileName}`)
                      }
                    }
                  }
                }
              } catch (e) {
                // 跳过单张图片的错误
              }
            }

            // 导出视频
            if (options.exportVideos && localType === 43) {
              try {
                const videoMd5 = videoService.parseVideoMd5(content)
                if (videoMd5) {
                  const videoInfo = videoService.getVideoInfo(videoMd5)
                  if (videoInfo.exists && videoInfo.videoUrl) {
                    const videoPath = videoInfo.videoUrl.replace(/^file:\/\/\//i, '').replace(/\//g, path.sep)
                    if (fs.existsSync(videoPath)) {
                      const fileName = `${createTime}_${videoMd5}.mp4`
                      const destPath = path.join(videoOutDir, fileName)
                      if (!fs.existsSync(destPath)) {
                        fs.copyFileSync(videoPath, destPath)
                        videoCount++
                        // 记录映射：createTime → 相对路径
                        mediaPathMap.set(createTime, `videos/${fileName}`)
                      }
                    }
                  }
                }
              } catch (e) {
                // 跳过单个视频的错误
              }
            }

            // 导出表情包
            if (options.exportEmojis && localType === 47) {
              emojiProcessed++
              onDetail?.(`表情导出: ${emojiProcessed}/${emojiTotal}`)
              try {
                // 从 XML 提取 cdnUrl 和 md5
                const cdnUrlMatch = /cdnurl\s*=\s*['"]([^'"]+)['"]/i.exec(content)
                const thumbUrlMatch = /thumburl\s*=\s*['"]([^'"]+)['"]/i.exec(content)
                const md5Match = /(?:emoticon)?md5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content) ||
                  /<md5>([^<]+)<\/md5>/i.exec(content)
                const encryptUrlMatch = /encrypturl\s*=\s*['"]([^'"]+)['"]/i.exec(content)
                const aesKeyMatch = /aeskey\s*=\s*['"]([a-zA-Z0-9]+)['"]/i.exec(content)

                let cdnUrl = cdnUrlMatch?.[1] || thumbUrlMatch?.[1] || ''
                const emojiMd5 = md5Match?.[1] || ''
                let encryptUrl = encryptUrlMatch?.[1] || ''
                const aesKey = aesKeyMatch?.[1] || ''

                if (cdnUrl) cdnUrl = cdnUrl.replace(/&amp;/g, '&')
                if (encryptUrl) encryptUrl = encryptUrl.replace(/&amp;/g, '&')

                if (emojiMd5 || cdnUrl) {
                  const cacheKey = emojiMd5 || this.hashString(cdnUrl)
                  // 确定文件扩展名
                  const ext = cdnUrl.includes('.gif') || content.includes('type="2"') ? '.gif' : '.png'
                  const fileName = `${createTime}_${cacheKey}${ext}`
                  const destPath = path.join(emojiOutDir, fileName)

                  if (!fs.existsSync(destPath)) {
                    // 1. 先检查本地缓存（cachePath/Emojis/）
                    let sourceFile = this.findLocalEmoji(cacheKey)

                    // 2. 找不到就从 CDN 下载
                    if (!sourceFile && cdnUrl) {
                      sourceFile = await this.downloadEmojiFile(cdnUrl, cacheKey)
                    }

                    // 3. CDN 失败，尝试 encryptUrl + AES 解密
                    if (!sourceFile && encryptUrl && aesKey) {
                      sourceFile = await this.downloadAndDecryptEmoji(encryptUrl, aesKey, cacheKey)
                    }

                    if (sourceFile && fs.existsSync(sourceFile)) {
                      fs.copyFileSync(sourceFile, destPath)
                      emojiCount++
                      mediaPathMap.set(createTime, `emojis/${fileName}`)
                    }
                  } else {
                    // 文件已存在，只记录映射
                    mediaPathMap.set(createTime, `emojis/${fileName}`)
                  }
                }
              } catch (e) {
                // 跳过单个表情的错误
              }
            }
          }
        } catch (e) {
          console.error(`[Export] 读取媒体消息失败:`, e)
        }
      }
    } // 结束 typeConditions > 0

    // === 语音导出（独立流程：需要从 MediaDb 读取） ===
    let voiceCount = 0
    if (options.exportVoices) {
      const voiceOutDir = path.join(outputDir, 'voices')
      if (!fs.existsSync(voiceOutDir)) {
        fs.mkdirSync(voiceOutDir, { recursive: true })
      }

      onDetail?.('正在导出语音消息...')

      // 1. 收集所有语音消息的 createTime
      const voiceCreateTimes: number[] = []
      for (const { db, tableName } of dbTablePairs) {
        try {
          let sql = `SELECT create_time FROM ${tableName} WHERE local_type = 34`
          if (options.dateRange) {
            sql += ` AND create_time >= ${options.dateRange.start} AND create_time <= ${options.dateRange.end}`
          }
          sql += ` ORDER BY create_time`
          const rows = db.prepare(sql).all() as any[]
          for (const row of rows) {
            if (row.create_time) voiceCreateTimes.push(row.create_time)
          }
        } catch { }
      }

      if (voiceCreateTimes.length > 0) {
        // 2. 查找 MediaDb
        const mediaDbs = this.findMediaDbs()

        if (mediaDbs.length > 0) {
          // 3. 只初始化一次 silk-wasm
          let silkWasm: any = null
          try {
            silkWasm = require('silk-wasm')
          } catch (e) {
            console.error('[Export] silk-wasm 加载失败:', e)
          }

          if (silkWasm) {
            // 4. 打开所有 MediaDb，预先建立 VoiceInfo 查询
            interface VoiceDbInfo {
              db: InstanceType<typeof Database>
              voiceTable: string
              dataColumn: string
              timeColumn: string
              chatNameIdColumn: string | null
              name2IdTable: string | null
            }
            const voiceDbs: VoiceDbInfo[] = []

            for (const dbPath of mediaDbs) {
              try {
                const mediaDb = new Database(dbPath, { readonly: true })
                const tables = mediaDb.prepare(
                  "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'VoiceInfo%'"
                ).all() as any[]
                if (tables.length === 0) { mediaDb.close(); continue }

                const voiceTable = tables[0].name
                const columns = mediaDb.prepare(`PRAGMA table_info('${voiceTable}')`).all() as any[]
                const colNames = columns.map((c: any) => c.name.toLowerCase())

                const dataColumn = colNames.find((c: string) => ['voice_data', 'buf', 'voicebuf', 'data'].includes(c))
                const timeColumn = colNames.find((c: string) => ['create_time', 'createtime', 'time'].includes(c))
                if (!dataColumn || !timeColumn) { mediaDb.close(); continue }

                const chatNameIdColumn = colNames.find((c: string) => ['chat_name_id', 'chatnameid', 'chat_nameid'].includes(c)) || null
                const n2iTables = mediaDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Name2Id%'").all() as any[]
                const name2IdTable = n2iTables.length > 0 ? n2iTables[0].name : null

                voiceDbs.push({ db: mediaDb, voiceTable, dataColumn, timeColumn, chatNameIdColumn, name2IdTable })
              } catch { }
            }

            // 5. 串行处理语音（避免内存溢出）
            const myWxid = this.configService.get('myWxid')
            const candidates = [sessionId]
            if (myWxid && myWxid !== sessionId) candidates.push(myWxid)

            const total = voiceCreateTimes.length
            for (let idx = 0; idx < total; idx++) {
              const createTime = voiceCreateTimes[idx]
              const fileName = `${createTime}.wav`
              const destPath = path.join(voiceOutDir, fileName)

              // 已存在则跳过
              if (fs.existsSync(destPath)) {
                mediaPathMap.set(createTime, `voices/${fileName}`)
                continue
              }

              // 在 MediaDb 中查找 SILK 数据
              let silkData: Buffer | null = null
              for (const vdb of voiceDbs) {
                try {
                  // 策略1: chatNameId + createTime
                  if (vdb.chatNameIdColumn && vdb.name2IdTable) {
                    for (const cand of candidates) {
                      const n2i = vdb.db.prepare(`SELECT rowid FROM ${vdb.name2IdTable} WHERE user_name = ?`).get(cand) as any
                      if (n2i?.rowid) {
                        const row = vdb.db.prepare(`SELECT ${vdb.dataColumn} AS data FROM ${vdb.voiceTable} WHERE ${vdb.chatNameIdColumn} = ? AND ${vdb.timeColumn} = ? LIMIT 1`).get(n2i.rowid, createTime) as any
                        if (row?.data) {
                          silkData = this.decodeVoiceBlob(row.data)
                          if (silkData) break
                        }
                      }
                    }
                  }
                  // 策略2: 仅 createTime
                  if (!silkData) {
                    const row = vdb.db.prepare(`SELECT ${vdb.dataColumn} AS data FROM ${vdb.voiceTable} WHERE ${vdb.timeColumn} = ? LIMIT 1`).get(createTime) as any
                    if (row?.data) {
                      silkData = this.decodeVoiceBlob(row.data)
                    }
                  }
                  if (silkData) break
                } catch { }
              }

              if (!silkData) continue

              try {
                // SILK → PCM → WAV（串行，立即释放）
                const result = await silkWasm.decode(silkData, 24000)
                silkData = null // 释放 SILK 数据
                if (!result?.data) continue
                const pcmData = Buffer.from(result.data)
                const wavData = this.createWavBuffer(pcmData, 24000)
                fs.writeFileSync(destPath, wavData)
                voiceCount++
                mediaPathMap.set(createTime, `voices/${fileName}`)
              } catch { }

              // 进度日志
              if ((idx + 1) % 10 === 0 || idx === total - 1) {
                onDetail?.(`语音导出: ${idx + 1}/${total}`)
              }
            }

            // 6. 关闭所有 MediaDb
            for (const vdb of voiceDbs) {
              try { vdb.db.close() } catch { }
            }
          }
        }
      }
    }

    // === 文件导出（独立流程：从微信原始目录复制） ===
    if (options.exportFiles) {
      onDetail?.('正在导出文件...')
      const wechatDir = this.configService.get('dbPath') as string
      const wxid = this.configService.get('myWxid') as string

      if (wechatDir && wxid) {
        const accountDir = this.findAccountDir(wechatDir, wxid)
        const fileBaseDir = path.join(wechatDir, accountDir || wxid, 'msg', 'file')

        for (const { db, tableName } of dbTablePairs) {
          try {
            let sql = `SELECT * FROM ${tableName} WHERE local_type = 49`
            if (options.dateRange) {
              sql += ` AND create_time >= ${options.dateRange.start} AND create_time <= ${options.dateRange.end}`
            }
            sql += ` ORDER BY create_time ASC`
            const rows = db.prepare(sql).all() as any[]

            for (const row of rows) {
              try {
                const createTime = row.create_time || 0
                const content = this.decodeMessageContent(row.message_content, row.compress_content)
                const xmlType = this.extractXmlValue(content, 'type')
                if (xmlType !== '6') continue

                const fileName = this.extractXmlValue(content, 'title')
                if (!fileName) continue

                // 根据消息时间计算年月目录
                const msgDate = new Date(createTime * 1000)
                const dateFolder = `${msgDate.getFullYear()}-${String(msgDate.getMonth() + 1).padStart(2, '0')}`
                const srcPath = path.join(fileBaseDir, dateFolder, fileName)

                if (fs.existsSync(srcPath)) {
                  const safeFileName = `${createTime}_${fileName}`
                  const destPath = path.join(fileOutDir, safeFileName)
                  if (!fs.existsSync(destPath)) {
                    fs.copyFileSync(srcPath, destPath)
                    fileCount++
                  }
                  mediaPathMap.set(createTime, `files/${safeFileName}`)
                }
              } catch { }
            }
          } catch (e) {
            console.error('[Export] 读取文件消息失败:', e)
          }
        }
      }
    }

    const parts: string[] = []
    if (imageCount > 0) parts.push(`${imageCount} 张图片`)
    if (videoCount > 0) parts.push(`${videoCount} 个视频`)
    if (emojiCount > 0) parts.push(`${emojiCount} 个表情`)
    if (voiceCount > 0) parts.push(`${voiceCount} 条语音`)
    if (fileCount > 0) parts.push(`${fileCount} 个文件`)
    const summary = parts.length > 0 ? `媒体导出完成: ${parts.join(', ')}` : '无媒体文件'
    onDetail?.(summary)
    console.log(`[Export] ${sessionId} ${summary}`)
    return mediaPathMap
  }

  /**
   * 从数据库行的 packed_info_data 中解析图片 dat 文件名
   * 复制自 chatService.parseImageDatNameFromRow 逻辑
   */
  private parseImageDatName(row: Record<string, any>): string | undefined {
    // 尝试多种可能的字段名
    const fieldNames = [
      'packed_info_data', 'packed_info', 'packedInfoData', 'packedInfo',
      'PackedInfoData', 'PackedInfo',
      'WCDB_CT_packed_info_data', 'WCDB_CT_packed_info',
      'WCDB_CT_PackedInfoData', 'WCDB_CT_PackedInfo'
    ]
    let packed: any = undefined
    for (const name of fieldNames) {
      if (row[name] !== undefined && row[name] !== null) {
        packed = row[name]
        break
      }
    }

    // 解码为 Buffer
    let buffer: Buffer | null = null
    if (!packed) return undefined
    if (Buffer.isBuffer(packed)) {
      buffer = packed
    } else if (packed instanceof Uint8Array) {
      buffer = Buffer.from(packed)
    } else if (Array.isArray(packed)) {
      buffer = Buffer.from(packed)
    } else if (typeof packed === 'string') {
      const trimmed = packed.trim()
      if (/^[a-fA-F0-9]+$/.test(trimmed) && trimmed.length % 2 === 0) {
        try { buffer = Buffer.from(trimmed, 'hex') } catch { }
      }
      if (!buffer) {
        try { buffer = Buffer.from(trimmed, 'base64') } catch { }
      }
    } else if (typeof packed === 'object' && Array.isArray(packed.data)) {
      buffer = Buffer.from(packed.data)
    }

    if (!buffer || buffer.length === 0) return undefined

    // 提取可打印字符
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

    // 匹配 dat 文件名
    const match = /([0-9a-fA-F]{8,})(?:\.t)?\.dat/.exec(text)
    if (match?.[1]) return match[1].toLowerCase()
    const hexMatch = /([0-9a-fA-F]{16,})/.exec(text)
    return hexMatch?.[1]?.toLowerCase()
  }

  /**
   * 简单字符串哈希（用于无 md5 时生成缓存 key）
   */
  private hashString(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const chr = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + chr
      hash |= 0
    }
    return Math.abs(hash).toString(16)
  }

  /**
   * 查找本地缓存的表情包文件
   */
  private findLocalEmoji(cacheKey: string): string | null {
    try {
      const cachePath = this.configService.get('cachePath')
      if (!cachePath) return null

      const emojiCacheDir = path.join(cachePath, 'Emojis')
      if (!fs.existsSync(emojiCacheDir)) return null

      // 检查各种扩展名
      const extensions = ['.gif', '.png', '.webp', '.jpg', '.jpeg', '']
      for (const ext of extensions) {
        const filePath = path.join(emojiCacheDir, `${cacheKey}${ext}`)
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath)
          if (stat.isFile() && stat.size > 0) return filePath
        }
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * 从 CDN 下载表情包文件并缓存（使用微信 UA + 重定向 + SSL bypass）
   */
  private downloadEmojiFile(cdnUrl: string, cacheKey: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const cachePath = this.configService.get('cachePath')
        if (!cachePath) { resolve(null); return }

        const emojiCacheDir = path.join(cachePath, 'Emojis')
        if (!fs.existsSync(emojiCacheDir)) fs.mkdirSync(emojiCacheDir, { recursive: true })

        let url = cdnUrl
        if (url.startsWith('http://') && (url.includes('qq.com') || url.includes('wechat.com'))) {
          url = url.replace('http://', 'https://')
        }

        this.doDownloadBuffer(url, (buffer) => {
          if (!buffer) { resolve(null); return }
          const ext = this.detectEmojiExt(buffer)
          const filePath = path.join(emojiCacheDir, `${cacheKey}${ext}`)
          fs.writeFileSync(filePath, buffer)
          resolve(filePath)
        })
      } catch { resolve(null) }
    })
  }

  /**
   * 下载加密表情并用 AES 解密
   */
  private async downloadAndDecryptEmoji(encryptUrl: string, aesKey: string, cacheKey: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const cachePath = this.configService.get('cachePath')
        if (!cachePath) { resolve(null); return }

        const emojiCacheDir = path.join(cachePath, 'Emojis')
        if (!fs.existsSync(emojiCacheDir)) fs.mkdirSync(emojiCacheDir, { recursive: true })

        let url = encryptUrl.replace(/&amp;/g, '&')
        if (url.startsWith('http://') && (url.includes('qq.com') || url.includes('wechat.com'))) {
          url = url.replace('http://', 'https://')
        }

        this.doDownloadBuffer(url, (buffer) => {
          if (!buffer) { resolve(null); return }
          try {
            const crypto = require('crypto')
            const keyBuf = Buffer.from(crypto.createHash('md5').update(aesKey).digest('hex').slice(0, 16), 'utf8')
            const decipher = crypto.createDecipheriv('aes-128-ecb', keyBuf, null)
            decipher.setAutoPadding(true)
            const decrypted = Buffer.concat([decipher.update(buffer), decipher.final()])
            const ext = this.detectEmojiExt(decrypted)
            const filePath = path.join(emojiCacheDir, `${cacheKey}${ext}`)
            fs.writeFileSync(filePath, decrypted)
            resolve(filePath)
          } catch { resolve(null) }
        })
      } catch { resolve(null) }
    })
  }

  private doDownloadBuffer(url: string, callback: (buf: Buffer | null) => void, redirectCount = 0): void {
    if (redirectCount > 5) { callback(null); return }
    const protocol = url.startsWith('https') ? https : http
    const req = protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x67001431) NetType/WIFI WindowsWechat/3.9.11.17(0x63090b11)',
        'Accept': '*/*',
      },
      rejectUnauthorized: false,
      timeout: 15000
    }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
        const loc = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href
        this.doDownloadBuffer(loc, callback, redirectCount + 1)
        return
      }
      if (res.statusCode !== 200) { callback(null); return }
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        callback(buf.length > 0 ? buf : null)
      })
      res.on('error', () => callback(null))
    })
    req.on('error', () => callback(null))
    req.setTimeout(15000, () => { req.destroy(); callback(null) })
  }

  private detectEmojiExt(buf: Buffer): string {
    if (buf[0] === 0x89 && buf[1] === 0x50) return '.png'
    if (buf[0] === 0xFF && buf[1] === 0xD8) return '.jpg'
    if (buf[0] === 0x52 && buf[1] === 0x49) return '.webp'
    return '.gif'
  }

  /**
   * 查找 media 数据库文件
   */
  private findMediaDbs(): string[] {
    if (!this.dbDir) return []
    const result: string[] = []
    try {
      const files = fs.readdirSync(this.dbDir)
      for (const file of files) {
        const lower = file.toLowerCase()
        if (lower.startsWith('media') && lower.endsWith('.db')) {
          result.push(path.join(this.dbDir, file))
        }
      }
    } catch { }
    return result
  }

  /**
   * 解码语音 Blob 数据为 Buffer
   */
  private decodeVoiceBlob(raw: any): Buffer | null {
    if (!raw) return null
    if (Buffer.isBuffer(raw)) return raw
    if (raw instanceof Uint8Array) return Buffer.from(raw)
    if (Array.isArray(raw)) return Buffer.from(raw)
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (/^[a-fA-F0-9]+$/.test(trimmed) && trimmed.length % 2 === 0) {
        try { return Buffer.from(trimmed, 'hex') } catch { }
      }
      try { return Buffer.from(trimmed, 'base64') } catch { }
    }
    if (typeof raw === 'object' && Array.isArray(raw.data)) {
      return Buffer.from(raw.data)
    }
    return null
  }

  /**
   * PCM 数据生成 WAV 文件 Buffer
   */
  private createWavBuffer(pcmData: Buffer, sampleRate: number = 24000, channels: number = 1): Buffer {
    const pcmLength = pcmData.length
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + pcmLength, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(channels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(sampleRate * channels * 2, 28)
    header.writeUInt16LE(channels * 2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(pcmLength, 40)
    return Buffer.concat([header, pcmData])
  }

  /**
   * 导出通讯录
   */
  async exportContacts(
    outputDir: string,
    options: ContactExportOptions,
    onProgress?: (progress: ExportProgress) => void
  ): Promise<{ success: boolean; successCount?: number; error?: string }> {
    try {
      if (!this.dbDir) {
        const connectResult = await this.connect()
        if (!connectResult.success) {
          return { success: false, error: connectResult.error }
        }
      }

      onProgress?.({
        current: 0,
        total: 100,
        currentSession: '通讯录',
        phase: 'preparing',
        detail: '正在连接数据库...'
      })

      if (!this.contactDb) {
        return { success: false, error: '联系人数据库未连接' }
      }

      // 确保输出目录存在
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true })
      }

      // 获取表结构
      const columns = this.contactDb.prepare("PRAGMA table_info(contact)").all() as any[]
      const columnNames = columns.map((c: any) => c.name)

      // 打印所有列名用于调试
      console.log('Contact table columns:', columnNames)

      const hasBigHeadUrl = columnNames.includes('big_head_url')
      const hasSmallHeadUrl = columnNames.includes('small_head_url')
      const hasLocalType = columnNames.includes('local_type')
      // 微信数据库中手机号可能的字段名
      const hasMobile = columnNames.includes('mobile')
      const hasPhone = columnNames.includes('phone')
      const hasPhoneNumber = columnNames.includes('phone_number')
      const hasTel = columnNames.includes('tel')
      const hasExtraBuffer = columnNames.includes('extra_buffer')
      const hasDescription = columnNames.includes('description')

      const selectCols = ['username', 'remark', 'nick_name', 'alias']
      if (hasBigHeadUrl) selectCols.push('big_head_url')
      if (hasSmallHeadUrl) selectCols.push('small_head_url')
      if (hasLocalType) selectCols.push('local_type')
      if (hasMobile) selectCols.push('mobile')
      if (hasPhone) selectCols.push('phone')
      if (hasPhoneNumber) selectCols.push('phone_number')
      if (hasTel) selectCols.push('tel')
      if (hasExtraBuffer) selectCols.push('extra_buffer')
      if (hasDescription) selectCols.push('description')

      onProgress?.({
        current: 20,
        total: 100,
        currentSession: '通讯录',
        phase: 'exporting',
        detail: '正在读取联系人数据...'
      })

      const rows = this.contactDb.prepare(`
        SELECT ${selectCols.join(', ')} FROM contact
      `).all() as any[]

      // 过滤和转换联系人
      const contacts: any[] = []
      for (const row of rows) {
        const username = row.username || ''

        // 过滤系统账号
        if (!username || username === 'filehelper' || username === 'fmessage' ||
          username === 'floatbottle' || username === 'medianote' ||
          username === 'newsapp' || username.startsWith('fake_')) {
          continue
        }

        // 如果指定了选中列表且不为空，则只导出选中的
        if (options.selectedUsernames && options.selectedUsernames.length > 0) {
          if (!options.selectedUsernames.includes(username)) {
            continue
          }
        }

        // 判断类型
        let type: 'friend' | 'group' | 'official' | 'other' = 'friend'
        if (username.includes('@chatroom')) {
          type = 'group'
        } else if (username.startsWith('gh_')) {
          type = 'official'
        } else if (hasLocalType) {
          const localType = row.local_type || 0
          if (localType === 3) type = 'official'
        }

        // 仅当没有指定选中列表时，才应用类型过滤
        if (!options.selectedUsernames || options.selectedUsernames.length === 0) {
          if (type === 'friend' && !options.contactTypes.friends) continue
          if (type === 'group' && !options.contactTypes.groups) continue
          if (type === 'official' && !options.contactTypes.officials) continue
        }

        const displayName = row.remark || row.nick_name || row.alias || username
        let avatarUrl: string | undefined
        if (options.exportAvatars) {
          if (hasBigHeadUrl && row.big_head_url) {
            avatarUrl = row.big_head_url
          } else if (hasSmallHeadUrl && row.small_head_url) {
            avatarUrl = row.small_head_url
          }
        }

        // 获取手机号 - 尝试多个可能的字段
        let mobile = row.mobile || row.phone || row.phone_number || row.tel || ''

        // 如果有 extra_buffer，尝试从中解析手机号
        if (!mobile && row.extra_buffer) {
          const phoneMatch = this.extractPhoneFromExtraBuf(row.extra_buffer)
          if (phoneMatch) mobile = phoneMatch
        }

        contacts.push({
          username,
          displayName,
          remark: row.remark || '',
          nickname: row.nick_name || '',
          alias: row.alias || '',
          mobile,
          type,
          avatarUrl
        })
      }

      onProgress?.({
        current: 60,
        total: 100,
        currentSession: '通讯录',
        phase: 'writing',
        detail: `正在处理 ${contacts.length} 个联系人...`
      })

      // 按类型和名称排序
      contacts.sort((a, b) => {
        const typeOrder: Record<string, number> = { friend: 0, group: 1, official: 2, other: 3 }
        if (typeOrder[a.type] !== typeOrder[b.type]) {
          return typeOrder[a.type] - typeOrder[b.type]
        }
        return a.displayName.localeCompare(b.displayName, 'zh-CN')
      })

      // 根据格式导出
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      let outputPath: string

      if (options.format === 'json') {
        outputPath = path.join(outputDir, `contacts_${timestamp}.json`)
        const exportData = {
          exportInfo: {
            version: '1.0.0',
            exportedAt: Math.floor(Date.now() / 1000),
            generator: 'CipherTalk',
            platform: 'wechat'
          },
          statistics: {
            total: contacts.length,
            friends: contacts.filter(c => c.type === 'friend').length,
            groups: contacts.filter(c => c.type === 'group').length,
            officials: contacts.filter(c => c.type === 'official').length
          },
          contacts
        }
        fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2), 'utf-8')
      } else if (options.format === 'csv') {
        outputPath = path.join(outputDir, `contacts_${timestamp}.csv`)
        const headers = ['用户名', '显示名称', '备注', '昵称', '手机号', '类型', '头像URL']
        const csvLines = [headers.join(',')]
        for (const c of contacts) {
          const row = [
            `"${c.username}"`,
            `"${c.displayName.replace(/"/g, '""')}"`,
            `"${(c.remark || '').replace(/"/g, '""')}"`,
            `"${(c.nickname || '').replace(/"/g, '""')}"`,
            `"${c.mobile || ''}"`,
            `"${c.type}"`,
            `"${c.avatarUrl || ''}"`
          ]
          csvLines.push(row.join(','))
        }
        // 添加 BOM 以支持 Excel 正确识别 UTF-8
        fs.writeFileSync(outputPath, '\ufeff' + csvLines.join('\n'), 'utf-8')
      } else if (options.format === 'vcf') {
        outputPath = path.join(outputDir, `contacts_${timestamp}.vcf`)
        const vcfLines: string[] = []
        for (const c of contacts) {
          if (c.type === 'group') continue // vCard 不支持群组
          vcfLines.push('BEGIN:VCARD')
          vcfLines.push('VERSION:3.0')
          // 如果有备注，显示名称用备注，原昵称放到 ORG 或 NOTE
          if (c.remark && c.remark !== c.nickname) {
            vcfLines.push(`FN:${c.remark}`)
            // N 字段：姓;名;中间名;前缀;后缀
            vcfLines.push(`N:${c.remark};;;;`)
            if (c.nickname) vcfLines.push(`NICKNAME:${c.nickname}`)
            vcfLines.push(`NOTE:微信昵称: ${c.nickname || c.username}`)
          } else {
            vcfLines.push(`FN:${c.displayName}`)
            vcfLines.push(`N:${c.displayName};;;;`)
            if (c.nickname && c.nickname !== c.displayName) {
              vcfLines.push(`NICKNAME:${c.nickname}`)
            }
          }
          if (c.mobile) vcfLines.push(`TEL;TYPE=CELL:${c.mobile}`)
          vcfLines.push(`X-WECHAT-ID:${c.username}`)
          if (c.avatarUrl) vcfLines.push(`PHOTO;VALUE=URI:${c.avatarUrl}`)
          vcfLines.push('END:VCARD')
          vcfLines.push('')
        }
        fs.writeFileSync(outputPath, vcfLines.join('\n'), 'utf-8')
      } else {
        return { success: false, error: `不支持的格式: ${options.format}` }
      }

      onProgress?.({
        current: 100,
        total: 100,
        currentSession: '通讯录',
        phase: 'complete',
        detail: '导出完成'
      })

      return { success: true, successCount: contacts.length }
    } catch (e) {
      console.error('ExportService: 导出通讯录失败:', e)
      return { success: false, error: String(e) }
    }
  }
}

export const exportService = new ExportService()

