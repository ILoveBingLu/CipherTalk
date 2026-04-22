import * as http from 'http'
import { URL, fileURLToPath } from 'url'
import { networkInterfaces } from 'os'
import { app } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { chatLabController, ChatLabControllerError } from './chatLabController'
import { ConfigService } from './config'
import { chatService } from './chatService'
import { querySnsTimeline } from './httpApiFacade'
import { imageDecryptService } from './imageDecryptService'
import { videoService } from './videoService'

interface ApiEnvelopeSuccess<T> {
  success: true
  data: T
  meta: {
    ts: number
    requestId: string
  }
}

interface ApiEnvelopeError {
  success: false
  error: {
    code: string
    message: string
    hint?: string
  }
  meta: {
    ts: number
    requestId: string
  }
}

interface HttpApiSettings {
  enabled: boolean
  host: string
  listenMode: 'localhost' | 'lan'
  port: number
  token: string
}

type ContactType = 'friend' | 'group' | 'official' | 'former_friend' | 'other'
type SessionTypeFilter = 'friend' | 'group' | 'official' | 'other'

class HttpApiService {
  private server: http.Server | null = null
  private readonly connections: Set<import('net').Socket> = new Set()
  private settings: HttpApiSettings = {
    enabled: false,
    host: '127.0.0.1',
    listenMode: 'localhost',
    port: 5031,
    token: ''
  }
  private startedAt = 0
  private startError = ''

  applySettings(next: Partial<HttpApiSettings>): void {
    const listenMode = next.listenMode || this.settings.listenMode || 'localhost'
    this.settings = {
      ...this.settings,
      ...next,
      listenMode,
      host: listenMode === 'lan' ? '0.0.0.0' : '127.0.0.1'
    }
  }

  async start(): Promise<{ success: boolean; error?: string }> {
    if (!this.settings.enabled) {
      return { success: true }
    }

    if (this.server) {
      return { success: true }
    }

    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res))

      server.on('connection', (socket) => {
        this.connections.add(socket)
        socket.on('close', () => this.connections.delete(socket))
      })

      server.on('error', (err: NodeJS.ErrnoException) => {
        this.startError = err.message
        if (err.code === 'EADDRINUSE') {
          resolve({ success: false, error: `端口 ${this.settings.port} 已被占用` })
          return
        }
        resolve({ success: false, error: err.message })
      })

      server.listen(this.settings.port, this.settings.host, () => {
        this.server = server
        this.startedAt = Date.now()
        this.startError = ''
        resolve({ success: true })
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return

    const currentServer = this.server
    this.server = null

    const sockets = Array.from(this.connections)
    this.connections.clear()
    sockets.forEach((socket) => {
      try {
        socket.destroy()
      } catch {
        // ignore
      }
    })

    await new Promise<void>((resolve) => {
      currentServer.close(() => resolve())
    })
  }

  async restart(): Promise<{ success: boolean; error?: string }> {
    await this.stop()
    if (!this.settings.enabled) return { success: true }
    return this.start()
  }

  isRunning(): boolean {
    return Boolean(this.server)
  }

  getUiStatus() {
    const uptimeMs = this.server && this.startedAt ? Date.now() - this.startedAt : 0
    const lanAddresses = this.settings.listenMode === 'lan' ? this.getLanAddresses() : []
    return {
      running: this.isRunning(),
      host: this.settings.host,
      listenMode: this.settings.listenMode,
      port: this.settings.port,
      enabled: this.settings.enabled,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : '',
      uptimeMs,
      tokenConfigured: Boolean(this.settings.token),
      tokenPreview: this.getTokenPreview(),
      baseUrl: this.getBaseUrl(),
      chatlabBaseUrl: this.getChatLabBaseUrl(),
      lanAddresses,
      endpoints: [
        { method: 'GET', path: '/v1', desc: '接口详情' },
        { method: 'GET', path: '/v1/health', desc: '健康检查' },
        { method: 'GET', path: '/v1/status', desc: '服务状态' },
        { method: 'GET', path: '/v1/sessions', desc: '会话列表' },
        { method: 'GET', path: '/v1/messages', desc: '会话消息' },
        { method: 'GET', path: '/v1/contacts', desc: '联系人列表' },
        { method: 'GET', path: '/v1/sns', desc: '朋友圈时间线' },
        { method: 'GET', path: '/chatlab/sessions', desc: 'ChatLab 会话发现' },
        { method: 'GET', path: '/chatlab/sessions/:id/messages', desc: 'ChatLab 消息拉取' }
      ],
      lastError: this.startError
    }
  }

  private getBaseUrl(): string {
    return `http://${this.getPreferredAccessHost()}:${this.settings.port}/v1`
  }

  private getChatLabBaseUrl(): string {
    return `http://${this.getPreferredAccessHost()}:${this.settings.port}/chatlab`
  }

  private getPreferredAccessHost(): string {
    if (this.settings.listenMode === 'localhost') {
      return '127.0.0.1'
    }

    const lanAddresses = this.getLanAddresses()
    return lanAddresses[0] || '127.0.0.1'
  }

  private getLanAddresses(): string[] {
    const result = new Set<string>()
    const interfaces = networkInterfaces()

    for (const entries of Object.values(interfaces)) {
      for (const entry of entries || []) {
        const family = typeof entry.family === 'string' ? entry.family : String(entry.family)
        if (family !== 'IPv4' || entry.internal) continue
        if (!entry.address || entry.address.startsWith('169.254.')) continue
        result.add(entry.address)
      }
    }

    return Array.from(result)
  }

  private getTokenPreview(): string {
    if (!this.settings.token) return ''
    if (this.settings.token.length <= 6) return '******'
    return `${this.settings.token.slice(0, 3)}***${this.settings.token.slice(-3)}`
  }

  private isAuthRequired(pathname: string): boolean {
    if (!this.settings.token) return false
    if (pathname === '/chatlab' || pathname.startsWith('/chatlab/')) {
      return true
    }
    return pathname !== '/v1' && pathname !== '/v1/' && pathname !== '/v1/health'
  }

  private createRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  }

  private sendJson<T>(
    res: http.ServerResponse,
    statusCode: number,
    payload: ApiEnvelopeSuccess<T> | ApiEnvelopeError
  ): void {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    res.end(JSON.stringify(payload))
  }

  private sendRawJson(
    res: http.ServerResponse,
    statusCode: number,
    payload: Record<string, any>
  ): void {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    res.end(JSON.stringify(payload))
  }

  private sendRedirect(res: http.ServerResponse, to: string): void {
    res.writeHead(307, {
      Location: to,
      'Cache-Control': 'no-store'
    })
    res.end()
  }

  private success<T>(requestId: string, data: T): ApiEnvelopeSuccess<T> {
    return {
      success: true,
      data,
      meta: {
        ts: Date.now(),
        requestId
      }
    }
  }

  private failure(requestId: string, code: string, message: string, hint?: string): ApiEnvelopeError {
    return {
      success: false,
      error: { code, message, hint },
      meta: {
        ts: Date.now(),
        requestId
      }
    }
  }

  private handleCors(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  }

  private extractAuthToken(req: http.IncomingMessage): string {
    const authHeader = req.headers.authorization
    const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader
    if (authValue) {
      const match = authValue.match(/^Bearer\s+(.+)$/i)
      if (match?.[1]) {
        return match[1].trim()
      }
    }
    return ''
  }

  private parseBoolean(value: string | null, defaultValue: boolean): boolean {
    if (value === null) return defaultValue
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
    return defaultValue
  }

  private parseIntInRange(value: string | null, defaultValue: number, min: number, max: number): number {
    if (!value) return defaultValue
    const n = Number.parseInt(value, 10)
    if (!Number.isFinite(n)) return defaultValue
    return Math.max(min, Math.min(max, n))
  }

  private parseNumberList(value: string | null): number[] | null {
    if (!value) return null
    const nums = value
      .split(',')
      .map((x) => Number.parseInt(x.trim(), 10))
      .filter((x) => Number.isFinite(x))
    return nums.length > 0 ? nums : null
  }

  private parseStringSet(value: string | null): Set<string> | null {
    if (!value) return null
    const values = value
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
    return values.length > 0 ? new Set(values) : null
  }

  private parseFields(value: string | null): Set<string> {
    const defaults = ['base', 'type', 'time', 'sender', 'metadata', 'media']
    if (!value || !value.trim()) {
      return new Set(defaults)
    }

    const parts = value
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)

    if (parts.includes('all')) {
      return new Set([
        'all',
        'base',
        'type',
        'time',
        'sender',
        'metadata',
        'media',
        'quote',
        'file',
        'transfer',
        'chatrecord',
        'raw',
        'schema'
      ])
    }

    return new Set(parts)
  }

  private parseTimestampMs(value: string | null): number | null {
    if (!value) return null
    const raw = Number.parseInt(value, 10)
    if (!Number.isFinite(raw) || raw <= 0) return null
    return raw < 1_000_000_000_000 ? raw * 1000 : raw
  }

  private normalizeTimestampMs(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0
    return value < 1_000_000_000_000 ? value * 1000 : value
  }

  private extractXmlType(content?: string): string | undefined {
    if (!content) return undefined
    const match = content.match(/<type>\s*([^<]+)\s*<\/type>/i)
    return match?.[1]?.trim()
  }

  private fileUrlToPathMaybe(input?: string | null): string | null {
    if (!input) return null
    if (input.startsWith('file:///')) {
      try {
        return fileURLToPath(input)
      } catch {
        return null
      }
    }
    return null
  }

  private sanitizePathPart(value: string): string {
    return value.replace(/[\\/:*?"<>|]/g, '_')
  }

  private pruneEmpty(value: any): any {
    if (value === null || value === undefined) return undefined
    if (typeof value === 'string') return value === '' ? undefined : value
    if (Array.isArray(value)) {
      const next = value
        .map((v) => this.pruneEmpty(v))
        .filter((v) => v !== undefined)
      return next.length > 0 ? next : undefined
    }
    if (typeof value === 'object') {
      const out: Record<string, any> = {}
      for (const [k, v] of Object.entries(value)) {
        const pruned = this.pruneEmpty(v)
        if (pruned !== undefined) out[k] = pruned
      }
      return Object.keys(out).length > 0 ? out : undefined
    }
    return value
  }

  private detectMessageKind(message: Record<string, any>): {
    messageKind: string
    typeLabel: string
    appMsgType?: string
  } {
    const localType = Number(message.localType || 0)
    const raw = String(message.rawContent || message.parsedContent || '')
    const appMsgType = this.extractXmlType(raw)

    if (localType === 1) return { messageKind: 'text', typeLabel: '文本' }
    if (localType === 3) return { messageKind: 'image', typeLabel: '图片' }
    if (localType === 34) return { messageKind: 'voice', typeLabel: '语音' }
    if (localType === 42) return { messageKind: 'contact_card', typeLabel: '名片' }
    if (localType === 43) return { messageKind: 'video', typeLabel: '视频' }
    if (localType === 47) return { messageKind: 'emoji', typeLabel: '表情' }
    if (localType === 48) return { messageKind: 'location', typeLabel: '位置' }
    if (localType === 50) return { messageKind: 'voip', typeLabel: '音视频通话' }
    if (localType === 10000) return { messageKind: 'system', typeLabel: '系统消息' }
    if (localType === 244813135921) return { messageKind: 'quote', typeLabel: '引用消息' }

    if (localType === 49 || appMsgType) {
      switch (appMsgType) {
        case '3':
          return { messageKind: 'app_music', typeLabel: '音乐分享', appMsgType }
        case '5':
        case '49':
          return { messageKind: 'app_link', typeLabel: '链接', appMsgType }
        case '6':
          return { messageKind: 'app_file', typeLabel: '文件', appMsgType }
        case '19':
          return { messageKind: 'app_chat_record', typeLabel: '聊天记录', appMsgType }
        case '33':
        case '36':
          return { messageKind: 'app_mini_program', typeLabel: '小程序', appMsgType }
        case '57':
          return { messageKind: 'app_quote', typeLabel: '引用消息', appMsgType }
        case '62':
          return { messageKind: 'app_pat', typeLabel: '拍一拍', appMsgType }
        case '87':
          return { messageKind: 'app_announcement', typeLabel: '群公告', appMsgType }
        case '115':
          return { messageKind: 'app_gift', typeLabel: '微信礼物', appMsgType }
        case '2000':
          return { messageKind: 'app_transfer', typeLabel: '转账', appMsgType }
        case '2001':
          return { messageKind: 'app_red_packet', typeLabel: '红包', appMsgType }
        default:
          return { messageKind: 'app', typeLabel: '应用消息', appMsgType }
      }
    }

    return { messageKind: 'unknown', typeLabel: `未知类型(${localType})` }
  }

  private parseTypeFilter(value: string | null): Set<ContactType> | null {
    if (!value) return null
    const allowed: ContactType[] = ['friend', 'group', 'official', 'former_friend', 'other']
    const result = new Set<ContactType>()
    value
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .forEach((x) => {
        if (allowed.includes(x as ContactType)) {
          result.add(x as ContactType)
        }
      })
    return result.size > 0 ? result : null
  }

  private parseSessionTypeFilter(value: string | null): Set<SessionTypeFilter> | null {
    if (!value) return null
    const allowed: SessionTypeFilter[] = ['friend', 'group', 'official', 'other']
    const result = new Set<SessionTypeFilter>()
    value
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .forEach((x) => {
        if (allowed.includes(x as SessionTypeFilter)) {
          result.add(x as SessionTypeFilter)
        }
      })
    return result.size > 0 ? result : null
  }

  private detectSessionType(username: string): SessionTypeFilter {
    if (username.includes('@chatroom')) return 'group'
    if (username.startsWith('gh_')) return 'official'
    if (username) return 'friend'
    return 'other'
  }

  private async handleChatLabRoute(
    pathname: string,
    searchParams: URLSearchParams,
    res: http.ServerResponse
  ): Promise<void> {
    const resolved = chatLabController.resolveChatLabResource(pathname)

    if (resolved.resource === 'sessions') {
      const payload = await chatLabController.getSessions(searchParams)
      this.sendRawJson(res, 200, payload)
      return
    }

    if (resolved.resource === 'messages') {
      const payload = await chatLabController.getMessages(resolved.sessionId, searchParams)
      this.sendRawJson(res, 200, payload)
      return
    }

    throw new ChatLabControllerError(404, 'NOT_FOUND', 'ChatLab route not found')
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.handleCors(res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const requestId = this.createRequestId()
    const method = req.method || 'GET'

    if (method !== 'GET') {
      this.sendJson(res, 405, this.failure(requestId, 'METHOD_NOT_ALLOWED', 'Only GET is supported'))
      return
    }

    const url = new URL(req.url || '/', `http://${this.settings.host}:${this.settings.port}`)
    const pathname = url.pathname

    // 兼容旧路径：无版本前缀时重定向到 /v1
    if (pathname === '/health') {
      this.sendRedirect(res, '/v1/health')
      return
    }
    if (pathname === '/status') {
      this.sendRedirect(res, '/v1/status')
      return
    }
    if (pathname === '/api/v1' || pathname === '/api/v1/') {
      this.sendRedirect(res, '/v1')
      return
    }
    if (pathname === '/api/v1/health') {
      this.sendRedirect(res, '/v1/health')
      return
    }
    if (pathname === '/api/v1/status') {
      this.sendRedirect(res, '/v1/status')
      return
    }
    if (pathname === '/api/v1/messages') {
      this.sendRedirect(res, '/v1/messages')
      return
    }
    if (pathname === '/api/v1/sessions') {
      this.sendRedirect(res, '/v1/sessions')
      return
    }
    if (pathname === '/api/v1/contacts') {
      this.sendRedirect(res, '/v1/contacts')
      return
    }
    if (pathname === '/api/v1/sns') {
      this.sendRedirect(res, '/v1/sns')
      return
    }
    if (pathname === '/') {
      this.sendRedirect(res, '/v1')
      return
    }

    if (this.isAuthRequired(pathname)) {
      const provided = this.extractAuthToken(req)
      if (!provided || provided !== this.settings.token) {
        this.sendJson(
          res,
          401,
          this.failure(
            requestId,
            'UNAUTHORIZED',
            'Invalid or missing Authorization Bearer token',
            'Use header: Authorization: Bearer <token>'
          )
        )
        return
      }
    }

    if (pathname === '/v1' || pathname === '/v1/') {
      this.sendJson(res, 200, this.success(requestId, {
        name: 'CipherTalk Embedded HTTP API',
        version: '1.0.0',
        baseUrl: this.getBaseUrl(),
        authHeader: 'Authorization: Bearer <token>',
        endpoints: this.getUiStatus().endpoints,
        status: this.getUiStatus()
      }))
      return
    }

    if (pathname === '/v1/health') {
      this.sendJson(res, 200, this.success(requestId, {
        status: 'ok'
      }))
      return
    }

    if (pathname === '/v1/status') {
      const configService = new ConfigService()
      const hasDbPath = Boolean(configService.get('dbPath'))
      const hasWxid = Boolean(configService.get('myWxid'))
      const hasDecryptKey = Boolean(configService.get('decryptKey'))
      configService.close()
      const verbose = url.searchParams.get('verbose') === '1'

      const isApiEnabled = this.settings.enabled
      const isApiRunning = this.isRunning()
      const isDbConfigReady = hasDbPath && hasWxid && hasDecryptKey

      let state: 'ready' | 'disabled' | 'starting_or_error' | 'needs_config' = 'ready'
      let message = 'HTTP API is ready for external calls.'

      if (!isApiEnabled) {
        state = 'disabled'
        message = 'HTTP API is disabled. Enable it in Settings > Open API.'
      } else if (!isApiRunning) {
        state = 'starting_or_error'
        message = this.startError || 'HTTP API is enabled but not running. Try restart in settings.'
      } else if (!isDbConfigReady) {
        state = 'needs_config'
        message = 'API is running, but database-related features need dbPath/decryptKey/wxid configuration.'
      }

      const basePayload = {
        summary: {
          state,
          usable: isApiEnabled && isApiRunning,
          message
        },
        server: {
          running: isApiRunning,
          enabled: isApiEnabled,
          host: this.settings.host,
          listenMode: this.settings.listenMode,
          port: this.settings.port,
          uptimeMs: this.server && this.startedAt ? Date.now() - this.startedAt : 0
        },
        auth: {
          required: Boolean(this.settings.token),
          scheme: 'Authorization: Bearer <token>'
        },
        config: {
          dbConfigReady: isDbConfigReady
        },
        urls: {
          baseUrl: this.getBaseUrl(),
          chatlabBaseUrl: this.getChatLabBaseUrl(),
          lanAddresses: this.settings.listenMode === 'lan' ? this.getLanAddresses() : []
        }
      }

      if (!verbose) {
        this.sendJson(res, 200, this.success(requestId, basePayload))
        return
      }

      this.sendJson(res, 200, this.success(requestId, {
        ...basePayload,
        usage: {
          baseUrl: this.getBaseUrl(),
          chatlabBaseUrl: this.getChatLabBaseUrl(),
          health: '/v1/health',
          status: '/v1/status',
          auth: this.settings.token ? 'Authorization: Bearer <token>' : 'No auth token required'
        },
        app: {
          version: app.getVersion(),
          electronVersion: process.versions.electron,
          nodeVersion: process.versions.node,
          platform: process.platform
        },
        debug: {
          checks: {
            apiEnabled: isApiEnabled,
            apiRunning: isApiRunning,
            dbConfigReady: isDbConfigReady,
            authRequired: Boolean(this.settings.token)
          },
          tokenPreview: this.getTokenPreview(),
          startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : '',
          lastError: this.startError
        }
      }))
      return
    }

    if (pathname === '/chatlab' || pathname.startsWith('/chatlab/')) {
      try {
        await this.handleChatLabRoute(pathname, url.searchParams, res)
      } catch (error) {
        if (error instanceof ChatLabControllerError) {
          this.sendRawJson(res, error.statusCode, error.toResponse())
          return
        }

        this.sendRawJson(res, 500, {
          error: {
            code: 'INTERNAL_ERROR',
            message: error instanceof Error ? error.message : 'Failed to serve ChatLab route'
          }
        })
      }
      return
    }

    if (pathname === '/v1/sessions') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase()
      const typeFilter = this.parseSessionTypeFilter(url.searchParams.get('type'))
      const unreadOnly = this.parseBoolean(url.searchParams.get('unreadOnly'), false)
      const sort = (url.searchParams.get('sort') || 'sortTimestamp_desc').trim()
      const offset = this.parseIntInRange(url.searchParams.get('offset'), 0, 0, 100000)
      const limit = this.parseIntInRange(url.searchParams.get('limit'), 100, 1, 500)

      const sessionsResult = await chatService.getSessions()
      if (!sessionsResult.success) {
        this.sendJson(
          res,
          503,
          this.failure(
            requestId,
            'DB_NOT_CONNECTED',
            sessionsResult.error || 'Failed to read sessions',
            'Please complete DB decrypt/setup in Settings and ensure data is available.'
          )
        )
        return
      }

      let sessions = (sessionsResult.sessions || []).map((item) => {
        const sessionType = this.detectSessionType(item.username || '')
        return {
          username: item.username,
          displayName: item.displayName || item.username,
          avatarUrl: item.avatarUrl,
          summary: item.summary,
          unreadCount: item.unreadCount || 0,
          sortTimestamp: item.sortTimestamp || 0,
          lastTimestamp: item.lastTimestamp || 0,
          lastMsgType: item.lastMsgType || 0,
          sessionType
        }
      })

      if (typeFilter) {
        sessions = sessions.filter((item) => typeFilter.has(item.sessionType))
      }

      if (unreadOnly) {
        sessions = sessions.filter((item) => Number(item.unreadCount || 0) > 0)
      }

      if (q) {
        sessions = sessions.filter((item) => {
          const username = String(item.username || '').toLowerCase()
          const displayName = String(item.displayName || '').toLowerCase()
          const summary = String(item.summary || '').toLowerCase()
          return username.includes(q) || displayName.includes(q) || summary.includes(q)
        })
      }

      if (sort === 'name_asc') {
        sessions.sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || ''), 'zh-CN'))
      } else if (sort === 'name_desc') {
        sessions.sort((a, b) => String(b.displayName || '').localeCompare(String(a.displayName || ''), 'zh-CN'))
      } else if (sort === 'lastTimestamp_asc') {
        sessions.sort((a, b) => Number(a.lastTimestamp || 0) - Number(b.lastTimestamp || 0))
      } else if (sort === 'lastTimestamp_desc') {
        sessions.sort((a, b) => Number(b.lastTimestamp || 0) - Number(a.lastTimestamp || 0))
      } else if (sort === 'unreadCount_desc') {
        sessions.sort((a, b) => Number(b.unreadCount || 0) - Number(a.unreadCount || 0))
      } else {
        sessions.sort((a, b) => Number(b.sortTimestamp || 0) - Number(a.sortTimestamp || 0))
      }

      const total = sessions.length
      const paged = sessions.slice(offset, offset + limit)
      const hasMore = offset + paged.length < total

      this.sendJson(res, 200, this.success(requestId, {
        total,
        offset,
        limit,
        hasMore,
        sort,
        filters: {
          q,
          type: typeFilter ? Array.from(typeFilter) : null,
          unreadOnly
        },
        sessions: paged
      }))
      return
    }

    if (pathname === '/v1/messages') {
      const sessionId = (url.searchParams.get('sessionId') || '').trim()
      if (!sessionId) {
        this.sendJson(
          res,
          400,
          this.failure(
            requestId,
            'BAD_REQUEST',
            'Missing required parameter: sessionId',
            'Use query parameter: sessionId=<chat_username>'
          )
        )
        return
      }

      const offset = this.parseIntInRange(url.searchParams.get('offset'), 0, 0, 100000)
      const limit = this.parseIntInRange(url.searchParams.get('limit'), 50, 1, 200)
      const sort = (url.searchParams.get('sort') || 'createTime_desc').trim()
      const keyword = (url.searchParams.get('keyword') || '').trim().toLowerCase()
      const msgTypeFilter = this.parseNumberList(url.searchParams.get('msgType'))
      const messageKindFilter = this.parseStringSet(url.searchParams.get('messageKind'))
      const appMsgTypeFilter = this.parseStringSet(url.searchParams.get('appMsgType'))
      const startTimeMs = this.parseTimestampMs(url.searchParams.get('startTime'))
      const endTimeMs = this.parseTimestampMs(url.searchParams.get('endTime'))
      const includeRaw = this.parseBoolean(url.searchParams.get('includeRaw'), false)
      const resolveMediaPath = this.parseBoolean(url.searchParams.get('resolveMediaPath'), true)
      const resolveVoicePath = this.parseBoolean(url.searchParams.get('resolveVoicePath'), false)
      const adaptive = this.parseBoolean(url.searchParams.get('adaptive'), true)
      const maxScan = this.parseIntInRange(url.searchParams.get('maxScan'), 5000, 100, 20000)
      const fields = this.parseFields(url.searchParams.get('fields'))
      if (includeRaw) fields.add('raw')

      const includeField = (name: string): boolean => fields.has('all') || fields.has(name)

      const needKindForFilter = Boolean(messageKindFilter || appMsgTypeFilter)
      const needKindForOutput = [
        includeField('type'),
        includeField('metadata'),
        includeField('media')
      ].some(Boolean)

      const shouldResolveMediaPath = includeField('media') && resolveMediaPath
      const shouldResolveVoicePath = includeField('media') && resolveVoicePath
      const includeChatRecordItems = includeField('chatrecord')

      let myWxid = ''
      let dbPath = ''
      let cachePath = ''
      if (shouldResolveVoicePath || shouldResolveMediaPath || includeField('file')) {
        const runtimeConfig = new ConfigService()
        myWxid = String(runtimeConfig.get('myWxid') || '')
        dbPath = String(runtimeConfig.get('dbPath') || '')
        cachePath = String(runtimeConfig.get('cachePath') || '')
        runtimeConfig.close()
      }

      const fetchBatchSize = 200
      const targetCount = offset + limit
      let scanOffset = 0
      let scanned = 0
      let reachedEnd = false
      const matched: any[] = []

      while (scanned < maxScan && matched.length < targetCount) {
        const part = await chatService.getMessages(sessionId, scanOffset, fetchBatchSize)
        if (!part.success) {
          this.sendJson(
            res,
            503,
            this.failure(
              requestId,
              'DB_NOT_CONNECTED',
              part.error || 'Failed to read messages',
              'Please complete DB decrypt/setup in Settings and ensure sessionId is correct.'
            )
          )
          return
        }

        const chunk = part.messages || []
        if (chunk.length === 0) {
          reachedEnd = true
          break
        }

        scanned += chunk.length
        scanOffset += chunk.length

        for (const msg of chunk) {
          if (msgTypeFilter && !msgTypeFilter.includes(Number(msg.localType || 0))) continue

          if (needKindForFilter) {
            const kindInfo = this.detectMessageKind(msg as Record<string, any>)
            if (messageKindFilter && !messageKindFilter.has(kindInfo.messageKind)) continue
            if (appMsgTypeFilter) {
              const appMsgType = (kindInfo.appMsgType || '').toLowerCase()
              if (!appMsgType || !appMsgTypeFilter.has(appMsgType)) continue
            }
          }

          const tMs = this.normalizeTimestampMs(Number(msg.createTime || 0))
          if (startTimeMs && tMs < startTimeMs) continue
          if (endTimeMs && tMs > endTimeMs) continue

          if (keyword) {
            const parsed = String(msg.parsedContent || '').toLowerCase()
            const raw = String(msg.rawContent || '').toLowerCase()
            if (!parsed.includes(keyword) && !raw.includes(keyword)) continue
          }

          matched.push(msg)
        }

        if (!part.hasMore) {
          reachedEnd = true
          break
        }
      }

      if (sort === 'createTime_asc') {
        matched.sort((a, b) => Number(a.createTime || 0) - Number(b.createTime || 0))
      } else {
        matched.sort((a, b) => Number(b.createTime || 0) - Number(a.createTime || 0))
      }

      const page = matched.slice(offset, offset + limit)
      const hasMore = reachedEnd ? matched.length > offset + page.length : true

      const enrichOne = async (m: any): Promise<Record<string, any>> => {
        const base = m as Record<string, any>
        const kind = needKindForOutput ? this.detectMessageKind(base) : { messageKind: 'unknown', typeLabel: '未知类型', appMsgType: undefined }
        const createTimeMs = this.normalizeTimestampMs(Number(base.createTime || 0))
        const senderUsername = base.senderUsername || null

        const metadata = {
          localType: Number(base.localType || 0),
          messageKind: kind.messageKind,
          typeLabel: kind.typeLabel,
          appMsgType: kind.appMsgType || null,
          direction: Number(base.isSend) === 1 ? 'out' : 'in',
          isSystem: Number(base.localType || 0) === 10000 || kind.messageKind === 'app_pat',
          isMedia: ['image', 'voice', 'video', 'emoji'].includes(kind.messageKind),
          hasRawContent: Boolean(base.rawContent),
          hasParsedContent: Boolean(base.parsedContent),
          hasQuote: Boolean(base.quotedContent || base.quotedImageMd5 || base.quotedEmojiMd5),
          hasFile: Boolean(base.fileName || base.fileMd5),
          hasTransfer: Boolean(base.transferPayerUsername || base.transferReceiverUsername),
          hasChatRecord: Array.isArray(base.chatRecordList) && base.chatRecordList.length > 0,
          isLivePhoto: Boolean(base.isLivePhoto)
        }

        const media = {
          imageMd5: base.imageMd5 || null,
          imageDatName: base.imageDatName || null,
          imageCachePath: null as string | null,
          emojiMd5: base.emojiMd5 || null,
          emojiCdnUrl: base.emojiCdnUrl || null,
          emojiCachePath: null as string | null,
          videoMd5: base.videoMd5 || null,
          videoDuration: base.videoDuration || null,
          videoCachePath: null as string | null,
          voiceDuration: base.voiceDuration || null,
          voiceCachePath: null as string | null
        }

        if (shouldResolveMediaPath && (kind.messageKind === 'emoji' || kind.messageKind.startsWith('app_')) && (base.emojiMd5 || base.emojiCdnUrl)) {
          try {
            const emojiResult = await chatService.downloadEmoji(
              String(base.emojiCdnUrl || ''),
              base.emojiMd5,
              base.productId,
              Number(base.createTime || 0),
              base.emojiEncryptUrl,
              base.emojiAesKey
            )
            if (emojiResult.success && emojiResult.cachePath) {
              media.emojiCachePath = emojiResult.cachePath
            }
          } catch {
            // ignore media path resolve errors for API stability
          }
        }

        if (shouldResolveMediaPath && kind.messageKind === 'image' && (base.imageMd5 || base.imageDatName)) {
          try {
            const resolved = await imageDecryptService.resolveCachedImage({
              sessionId,
              imageMd5: base.imageMd5,
              imageDatName: base.imageDatName
            })

            if (resolved.success && resolved.localPath) {
              media.imageCachePath = this.fileUrlToPathMaybe(resolved.localPath)
            } else {
              const decrypted = await imageDecryptService.decryptImage({
                sessionId,
                imageMd5: base.imageMd5,
                imageDatName: base.imageDatName,
                force: false
              })
              if (decrypted.success && decrypted.localPath) {
                media.imageCachePath = this.fileUrlToPathMaybe(decrypted.localPath)
              }
            }
          } catch {
            // ignore image path resolve errors
          }
        }

        if (shouldResolveMediaPath && kind.messageKind === 'video' && base.videoMd5) {
          try {
            const videoInfo = videoService.getVideoInfo(String(base.videoMd5), String(base.rawContent || ''))
            if (videoInfo.exists && videoInfo.videoUrl) {
              media.videoCachePath = this.fileUrlToPathMaybe(videoInfo.videoUrl)
            }
          } catch {
            // ignore video path resolve errors
          }
        }

        if (shouldResolveVoicePath && kind.messageKind === 'voice') {
          try {
            const voiceResult = await chatService.getVoiceData(
              sessionId,
              String(base.localId || ''),
              Number(base.createTime || 0)
            )
            if (voiceResult.success && voiceResult.data) {
              const baseCacheDir = cachePath || join(process.cwd(), 'cache')
              const voiceDir = join(baseCacheDir, 'HttpApiVoices', this.sanitizePathPart(sessionId))
              if (!existsSync(voiceDir)) {
                mkdirSync(voiceDir, { recursive: true })
              }
              const fileName = `${Number(base.createTime || 0)}_${Number(base.localId || 0)}.wav`
              const absPath = join(voiceDir, fileName)
              await writeFile(absPath, Buffer.from(voiceResult.data, 'base64'))
              media.voiceCachePath = absPath
            }
          } catch {
            // ignore voice path resolve errors
          }
        }

        const quote = metadata.hasQuote
          ? {
              content: base.quotedContent || null,
              sender: base.quotedSender || null,
              imageMd5: base.quotedImageMd5 || null,
              emojiMd5: base.quotedEmojiMd5 || null,
              emojiCdnUrl: base.quotedEmojiCdnUrl || null
            }
          : null

        const file = metadata.hasFile
          ? {
              name: base.fileName || null,
              size: base.fileSize || null,
              ext: base.fileExt || null,
              md5: base.fileMd5 || null,
              absolutePath: null as string | null,
              exists: false
            }
          : null

        if (shouldResolveMediaPath && file?.name && dbPath && myWxid) {
          try {
            const msgDate = createTimeMs ? new Date(createTimeMs) : new Date()
            const year = msgDate.getFullYear()
            const month = String(msgDate.getMonth() + 1).padStart(2, '0')
            const dateFolder = `${year}-${month}`
            const abs = join(dbPath, myWxid, 'msg', 'file', dateFolder, String(file.name))
            file.absolutePath = abs
            file.exists = existsSync(abs)
          } catch {
            // ignore file path resolve errors
          }
        }

        const transfer = metadata.hasTransfer
          ? {
              payerUsername: base.transferPayerUsername || null,
              receiverUsername: base.transferReceiverUsername || null
            }
          : null

        const chatRecord = metadata.hasChatRecord
          ? {
              count: Array.isArray(base.chatRecordList) ? base.chatRecordList.length : 0,
              items: includeChatRecordItems ? (base.chatRecordList || []) : undefined
            }
          : null

        const out: Record<string, any> = {}

        if (includeField('base')) {
          out.localId = base.localId || 0
          out.serverId = base.serverId || 0
          out.localType = Number(base.localType || 0)
          out.createTime = Number(base.createTime || 0)
          out.sortSeq = Number(base.sortSeq || 0)
          out.isSend = base.isSend ?? null
          out.senderUsername = senderUsername
          out.parsedContent = base.parsedContent || ''
        }

        if (includeField('raw')) {
          out.rawContent = base.rawContent || null
        }

        if (includeField('type')) {
          out.messageKind = kind.messageKind
          out.typeLabel = kind.typeLabel
          out.appMsgType = kind.appMsgType || null
          out.direction = metadata.direction
        }

        if (includeField('time')) {
          out.createTimeMs = createTimeMs
          out.createTimeIso = createTimeMs ? new Date(createTimeMs).toISOString() : null
        }

        if (includeField('sender')) {
          out.sender = {
            username: senderUsername,
            isSelf: Number(base.isSend) === 1
          }
        }

        if (includeField('metadata')) {
          out.metadata = metadata
        }

        if (includeField('media')) {
          out.media = media
        }

        if (includeField('quote')) {
          out.quote = quote
        }

        if (includeField('file')) {
          out.file = file
        }

        if (includeField('transfer')) {
          out.transfer = transfer
        }

        if (includeField('chatrecord')) {
          out.chatRecord = chatRecord
        }

        return out
      }

      const enrichResults = await Promise.allSettled(page.map((m) => enrichOne(m)))
      const enrichedMessages = enrichResults
        .filter((r): r is PromiseFulfilledResult<Record<string, any>> => r.status === 'fulfilled')
        .map((r) => r.value)

      const normalizedMessages = adaptive
        ? enrichedMessages.map((m) => this.pruneEmpty(m)).filter(Boolean)
        : enrichedMessages

      const finalMessages = includeRaw
        ? normalizedMessages
        : normalizedMessages.map((m) => {
            const { rawContent, ...rest } = m as Record<string, any>
            return rest
          })

      const responsePayload: Record<string, any> = {
        sessionId,
        total: reachedEnd ? matched.length : null,
        offset,
        limit,
        hasMore,
        scanned,
        maxScan,
        sort,
        filters: {
          keyword,
          msgType: msgTypeFilter,
          messageKind: messageKindFilter ? Array.from(messageKindFilter) : null,
          appMsgType: appMsgTypeFilter ? Array.from(appMsgTypeFilter) : null,
          startTime: startTimeMs,
          endTime: endTimeMs,
          includeRaw,
          resolveMediaPath,
          resolveVoicePath,
          adaptive,
          fields: Array.from(fields)
        },
        messages: finalMessages
      }

      if (includeField('schema')) {
        responsePayload.messageTypeSchema = {
          messageKind: {
            text: '文本',
            image: '图片',
            voice: '语音',
            video: '视频',
            emoji: '表情',
            location: '位置',
            contact_card: '名片',
            system: '系统消息',
            quote: '引用消息',
            voip: '音视频通话',
            app_link: '链接',
            app_file: '文件',
            app_chat_record: '聊天记录',
            app_mini_program: '小程序',
            app_transfer: '转账',
            app_red_packet: '红包',
            app_announcement: '群公告',
            app_pat: '拍一拍',
            app_gift: '微信礼物',
            app_music: '音乐分享',
            app: '应用消息',
            unknown: '未知类型'
          },
          direction: {
            out: '我发送',
            in: '我接收'
          }
        }
      }

      this.sendJson(res, 200, this.success(requestId, responsePayload))
      return
    }

    if (pathname === '/v1/contacts') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase()
      const typeFilter = this.parseTypeFilter(url.searchParams.get('type'))
      const includeAvatar = this.parseBoolean(url.searchParams.get('includeAvatar'), true)
      const sort = (url.searchParams.get('sort') || 'lastContactTime_desc').trim()
      const offset = this.parseIntInRange(url.searchParams.get('offset'), 0, 0, 100000)
      const limit = this.parseIntInRange(url.searchParams.get('limit'), 100, 1, 500)

      const contactsResult = await chatService.getContacts()
      if (!contactsResult.success) {
        this.sendJson(
          res,
          503,
          this.failure(
            requestId,
            'DB_NOT_CONNECTED',
            contactsResult.error || 'Failed to read contacts',
            'Please complete DB decrypt/setup in Settings and ensure data is available.'
          )
        )
        return
      }

      let contacts = (contactsResult.contacts || []) as Array<Record<string, any>>

      if (typeFilter) {
        contacts = contacts.filter((item) => typeFilter.has((item.type || 'other') as ContactType))
      }

      if (q) {
        contacts = contacts.filter((item) => {
          const username = String(item.username || '').toLowerCase()
          const displayName = String(item.displayName || '').toLowerCase()
          const remark = String(item.remark || '').toLowerCase()
          const nickname = String(item.nickname || '').toLowerCase()
          return (
            username.includes(q) ||
            displayName.includes(q) ||
            remark.includes(q) ||
            nickname.includes(q)
          )
        })
      }

      if (sort === 'name_asc') {
        contacts.sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || ''), 'zh-CN'))
      } else if (sort === 'name_desc') {
        contacts.sort((a, b) => String(b.displayName || '').localeCompare(String(a.displayName || ''), 'zh-CN'))
      } else if (sort === 'lastContactTime_asc') {
        contacts.sort((a, b) => Number((a as any).lastContactTime || 0) - Number((b as any).lastContactTime || 0))
      } else {
        contacts.sort((a, b) => Number((b as any).lastContactTime || 0) - Number((a as any).lastContactTime || 0))
      }

      const total = contacts.length
      const paged = contacts.slice(offset, offset + limit)
      const hasMore = offset + paged.length < total

      const finalContacts = paged.map((item) => {
        if (includeAvatar) return item
        const { avatarUrl, ...rest } = item
        return rest
      })

      this.sendJson(res, 200, this.success(requestId, {
        total,
        offset,
        limit,
        hasMore,
        sort,
        filters: {
          q,
          type: typeFilter ? Array.from(typeFilter) : null,
          includeAvatar
        },
        contacts: finalContacts
      }))
      return
    }

    if (pathname === '/v1/sns') {
      try {
        const usernames = (url.searchParams.get('usernames') || '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
        const payload = await querySnsTimeline({
          limit: this.parseIntInRange(url.searchParams.get('limit'), 20, 1, 200),
          offset: this.parseIntInRange(url.searchParams.get('offset'), 0, 0, 100000),
          usernames: usernames.length > 0 ? usernames : null,
          keyword: (url.searchParams.get('keyword') || '').trim() || undefined,
          startTime: this.parseTimestampMs(url.searchParams.get('startTime')),
          endTime: this.parseTimestampMs(url.searchParams.get('endTime')),
          includeRaw: this.parseBoolean(url.searchParams.get('includeRaw'), false)
        })
        this.sendJson(res, 200, this.success(requestId, payload))
      } catch (error: any) {
        const statusCode = Number(error?.statusCode) || 500
        const code = String(error?.code || 'INTERNAL_ERROR')
        const message = String(error?.message || 'Failed to read moments timeline')
        const hint = typeof error?.hint === 'string' ? error.hint : 'Try GET /v1 or /v1/status to inspect API availability, or use /v1/sns with valid query params.'
        this.sendJson(res, statusCode, this.failure(requestId, code, message, hint))
      }
      return
    }

    this.sendJson(
      res,
      404,
      this.failure(
        requestId,
        'NOT_FOUND',
        'Route not found',
        'Try GET /v1 for API overview, or use /v1/health, /v1/status, /v1/messages, /v1/contacts, /v1/sessions, /v1/sns'
      )
    )
  }
}

export const httpApiService = new HttpApiService()
