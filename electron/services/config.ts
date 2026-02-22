import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'path'
import fs from 'fs'

interface ConfigSchema {
  // 数据库相关
  dbPath: string
  decryptKey: string
  myWxid: string

  // 图片解密相关
  imageXorKey: string
  imageAesKey: string

  // 缓存相关
  cachePath: string
  lastOpenedDb: string
  lastSession: string

  // 导出相关
  exportPath: string

  // 界面相关
  theme: string
  themeMode: string
  appIcon: string
  language: string

  // 协议相关
  agreementVersion: number

  // 激活相关
  activationData: string

  // STT 相关
  sttLanguages: string[]
  sttModelType: 'int8' | 'float32'
  sttMode: 'cpu' | 'gpu'  // STT 模式：CPU (SenseVoice) 或 GPU (Whisper)
  whisperModelType: 'tiny' | 'base' | 'small' | 'medium'  // Whisper 模型类型

  // 日志相关
  logLevel: string

  // 数据管理相关
  skipIntegrityCheck: boolean
  autoUpdateDatabase: boolean  // 是否自动更新数据库
  // 自动同步高级参数
  autoUpdateCheckInterval: number     // 检查间隔（秒）
  autoUpdateMinInterval: number       // 最小更新间隔（毫秒）
  autoUpdateDebounceTime: number      // 防抖时间（毫秒）

  // AI 相关
  aiCurrentProvider: string  // 当前选中的提供商
  aiProviderConfigs: {  // 每个提供商的独立配置
    [providerId: string]: {
      apiKey: string
      model: string
    }
  }
  aiDefaultTimeRange: number
  aiSummaryDetail: 'simple' | 'normal' | 'detailed'
  aiEnableCache: boolean
  aiEnableThinking: boolean  // 是否显示思考过程
  aiMessageLimit: number     // 摘要提取的消息条数限制
}

const defaults: ConfigSchema = {
  dbPath: '',
  decryptKey: '',
  myWxid: '',
  imageXorKey: '',
  imageAesKey: '',
  cachePath: '',
  lastOpenedDb: '',
  lastSession: '',
  exportPath: '',
  theme: 'cloud-dancer',
  themeMode: 'light',
  appIcon: 'default',
  language: 'zh-CN',
  sttLanguages: ['zh'],
  sttModelType: 'int8',
  sttMode: 'cpu',  // 默认使用 CPU 模式
  whisperModelType: 'small',  // 默认使用 small 模型
  agreementVersion: 0,
  activationData: '',
  logLevel: 'WARN', // 默认只记录警告和错误
  skipIntegrityCheck: false, // 默认进行完整性检查
  autoUpdateDatabase: true,  // 默认开启自动更新
  autoUpdateCheckInterval: 60,     // 默认 60 秒检查一次
  autoUpdateMinInterval: 1000,     // 默认最小更新间隔 1 秒
  autoUpdateDebounceTime: 500,     // 默认防抖时间 0.5 秒
  // AI 默认配置
  aiCurrentProvider: 'zhipu',
  aiProviderConfigs: {},  // 空对象，用户配置后填充
  aiDefaultTimeRange: 7, // 默认7天
  aiSummaryDetail: 'normal',
  aiEnableCache: true,
  aiEnableThinking: true,  // 默认显示思考过程
  aiMessageLimit: 3000     // 默认3000条，用户可调至5000
}

export class ConfigService {
  private db: Database.Database | null = null
  private dbPath: string

  constructor() {
    const userDataPath = app.getPath('userData')
    this.dbPath = path.join(userDataPath, 'ciphertalk-config.db')
    this.initDatabase()
  }

  private initDatabase(): void {
    try {
      // 确保目录存在
      const dir = path.dirname(this.dbPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      this.db = new Database(this.dbPath)

      // 创建配置表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS config (
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `)

      // 创建 TLD 缓存表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tld_cache (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          tlds TEXT,
          updated_at INTEGER
        )
      `)



      // 初始化默认值
      const insertStmt = this.db.prepare(`
        INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)
      `)

      for (const [key, value] of Object.entries(defaults)) {
        insertStmt.run(key, JSON.stringify(value))
      }

      // 迁移：修复旧版本产生的空 STT 语言配置，默认为中文
      try {
        const sttRow = this.db.prepare("SELECT value FROM config WHERE key = 'sttLanguages'").get() as { value: string } | undefined
        if (sttRow) {
          const langs = JSON.parse(sttRow.value)
          if (Array.isArray(langs) && langs.length === 0) {
            this.db.prepare("UPDATE config SET value = ? WHERE key = 'sttLanguages'").run(JSON.stringify(['zh']))
          }
        }
      } catch (e) {
        console.error('迁移 STT 配置失败:', e)
      }

      // 迁移：将旧的 AI 配置迁移到新结构（支持多提供商）
      try {
        const oldProviderRow = this.db.prepare("SELECT value FROM config WHERE key = 'aiProvider'").get() as { value: string } | undefined
        const oldApiKeyRow = this.db.prepare("SELECT value FROM config WHERE key = 'aiApiKey'").get() as { value: string } | undefined
        const oldModelRow = this.db.prepare("SELECT value FROM config WHERE key = 'aiModel'").get() as { value: string } | undefined

        if (oldProviderRow && oldApiKeyRow) {
          const oldProvider = JSON.parse(oldProviderRow.value)
          const oldApiKey = JSON.parse(oldApiKeyRow.value)
          const oldModel = oldModelRow ? JSON.parse(oldModelRow.value) : ''

          // 如果有旧配置且 API Key 不为空，迁移到新结构
          if (oldApiKey) {
            const newConfigs: any = {}
            newConfigs[oldProvider] = {
              apiKey: oldApiKey,
              model: oldModel
            }

            this.db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run('aiCurrentProvider', JSON.stringify(oldProvider))
            this.db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run('aiProviderConfigs', JSON.stringify(newConfigs))

            // 删除旧配置
            this.db.prepare("DELETE FROM config WHERE key IN ('aiProvider', 'aiApiKey', 'aiModel')").run()

            console.log('[Config] AI 配置已迁移到新结构')
          }
        }
      } catch (e) {
        console.error('迁移 AI 配置失败:', e)
      }
    } catch (e) {
      console.error('初始化配置数据库失败:', e)
    }
  }

  get<K extends keyof ConfigSchema>(key: K): ConfigSchema[K] {
    try {
      if (!this.db) {
        return defaults[key]
      }
      const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined
      if (row) {
        return JSON.parse(row.value)
      }
      return defaults[key]
    } catch (e) {
      console.error(`获取配置 ${key} 失败:`, e)
      return defaults[key]
    }
  }

  set<K extends keyof ConfigSchema>(key: K, value: ConfigSchema[K]): void {
    try {
      if (!this.db) return
      this.db.prepare(`
        INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)
      `).run(key, JSON.stringify(value))
    } catch (e) {
      console.error(`设置配置 ${key} 失败:`, e)
    }
  }

  getAll(): ConfigSchema {
    try {
      if (!this.db) {
        return { ...defaults }
      }
      const rows = this.db.prepare('SELECT key, value FROM config').all() as { key: string; value: string }[]
      const result = { ...defaults }
      for (const row of rows) {
        if (row.key in defaults) {
          (result as any)[row.key] = JSON.parse(row.value)
        }
      }
      return result
    } catch (e) {
      console.error('获取所有配置失败:', e)
      return { ...defaults }
    }
  }

  clear(): void {
    try {
      if (!this.db) return
      this.db.exec('DELETE FROM config')
      // 重新插入默认值
      const insertStmt = this.db.prepare(`
        INSERT INTO config (key, value) VALUES (?, ?)
      `)
      for (const [key, value] of Object.entries(defaults)) {
        insertStmt.run(key, JSON.stringify(value))
      }
    } catch (e) {
      console.error('清除配置失败:', e)
    }
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  // TLD 缓存相关方法
  getTldCache(): { tlds: string[]; updatedAt: number } | null {
    try {
      if (!this.db) return null
      const row = this.db.prepare('SELECT tlds, updated_at FROM tld_cache WHERE id = 1').get() as { tlds: string; updated_at: number } | undefined
      if (row) {
        return {
          tlds: JSON.parse(row.tlds),
          updatedAt: row.updated_at
        }
      }
      return null
    } catch (e) {
      console.error('获取 TLD 缓存失败:', e)
      return null
    }
  }

  setTldCache(tlds: string[]): void {
    try {
      if (!this.db) return
      const now = Date.now()
      this.db.prepare(`
        INSERT OR REPLACE INTO tld_cache (id, tlds, updated_at) VALUES (1, ?, ?)
      `).run(JSON.stringify(tlds), now)
    } catch (e) {
      console.error('设置 TLD 缓存失败:', e)
    }
  }

  // AI 配置便捷方法
  getAICurrentProvider(): string {
    return this.get('aiCurrentProvider')
  }

  setAICurrentProvider(provider: string): void {
    this.set('aiCurrentProvider', provider)
  }

  getAIProviderConfig(providerId: string): { apiKey: string; model: string; baseURL?: string } | null {
    const configs = this.get('aiProviderConfigs')
    return configs[providerId] || null
  }

  setAIProviderConfig(providerId: string, config: { apiKey: string; model: string; baseURL?: string }): void {
    const configs = this.get('aiProviderConfigs')
    configs[providerId] = config
    this.set('aiProviderConfigs', configs)
  }

  getAllAIProviderConfigs(): { [providerId: string]: { apiKey: string; model: string; baseURL?: string } } {
    return this.get('aiProviderConfigs')
  }

  getAIMessageLimit(): number {
    return this.get('aiMessageLimit')
  }

  setAIMessageLimit(limit: number): void {
    this.set('aiMessageLimit', limit)
  }

  getCacheBasePath(): string {
    const configured = this.get('cachePath')
    if (configured && configured.trim().length > 0) {
      return configured
    }
    return path.join(app.getPath('documents'), 'CipherTalk')
  }
}
