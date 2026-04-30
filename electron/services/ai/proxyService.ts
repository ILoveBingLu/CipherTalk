import { HttpsProxyAgent } from 'https-proxy-agent'

function getDefaultSession(): any | null {
  try {
    const moduleName = 'electron'
    const requireFunc = module.require.bind(module) as NodeRequire
    const electronModule = requireFunc(moduleName)
    return electronModule?.session?.defaultSession || null
  } catch {
    return null
  }
}

/**
 * 代理服务 - 解决 Electron 主进程网络代理问题
 * 
 * 核心问题：
 * - 渲染进程：自动跟随系统代理（像 Chrome）
 * - 主进程 Node.js：默认直连，看不见系统代理（像普通后台服务）
 * 
 * 解决方案：
 * 1. Ask：通过 session.resolveProxy 获取系统代理地址
 * 2. Pass：构建 HttpsProxyAgent 中间件
 * 3. Inject：注入到 OpenAI SDK 的 httpAgent 配置
 */
class ProxyService {
  private cachedProxyUrl: string | null = null
  private lastCheckTime: number = 0
  private readonly CACHE_DURATION = 60000 // 缓存 1 分钟

  /**
   * 获取系统代理配置
   * @param targetUrl 目标 URL（用于判断代理规则）
   * @returns 代理地址（如 http://127.0.0.1:7890）或 null
   */
  async getSystemProxy(targetUrl: string = 'https://api.openai.com'): Promise<string | null> {
    try {
      const defaultSession = getDefaultSession()
      // worker 线程没有 electron.session API，直接跳过
      if (!defaultSession) {
        return null
      }

      // 使用缓存避免频繁查询
      const now = Date.now()
      if (this.cachedProxyUrl && (now - this.lastCheckTime) < this.CACHE_DURATION) {
        return this.cachedProxyUrl
      }

      // 通过 Electron session 获取系统代理
      const proxyInfo = await defaultSession.resolveProxy(targetUrl)
      
      console.log('[ProxyService] 系统代理信息:', proxyInfo)

      // 解析代理字符串
      // 格式示例：
      // - "DIRECT" - 直连
      // - "PROXY 127.0.0.1:7890" - HTTP 代理
      // - "HTTPS 127.0.0.1:7890" - HTTPS 代理
      // - "SOCKS5 127.0.0.1:1080" - SOCKS5 代理
      if (proxyInfo && proxyInfo !== 'DIRECT') {
        const match = proxyInfo.match(/(?:PROXY|HTTPS|SOCKS5?)\s+([^\s;]+)/)
        if (match) {
          const proxyAddress = match[1]
          
          // 构建完整的代理 URL
          let proxyUrl: string
          if (proxyInfo.startsWith('SOCKS')) {
            proxyUrl = `socks5://${proxyAddress}`
          } else {
            proxyUrl = `http://${proxyAddress}`
          }

          this.cachedProxyUrl = proxyUrl
          this.lastCheckTime = now
          
          console.log('[ProxyService] 检测到代理:', proxyUrl)
          return proxyUrl
        }
      }

      // 没有代理
      this.cachedProxyUrl = null
      this.lastCheckTime = now
      console.log('[ProxyService] 未检测到代理，使用直连')
      return null

    } catch (error) {
      console.error('[ProxyService] 获取系统代理失败:', error)
      return null
    }
  }

  /**
   * 创建代理 Agent（用于 Node.js HTTP 请求）
   * @param targetUrl 目标 URL
   * @returns HttpsProxyAgent 实例或 undefined
   */
  async createProxyAgent(targetUrl: string = 'https://api.openai.com'): Promise<any> {
    const proxyUrl = await this.getSystemProxy(targetUrl)
    
    if (!proxyUrl) {
      return undefined
    }

    try {
      // 创建代理 Agent
      const agent = new HttpsProxyAgent(proxyUrl)
      console.log('[ProxyService] 已创建代理 Agent:', proxyUrl)
      return agent
    } catch (error) {
      console.error('[ProxyService] 创建代理 Agent 失败:', error)
      return undefined
    }
  }

  /**
   * 清除缓存（用于手动刷新代理配置）
   */
  clearCache(): void {
    this.cachedProxyUrl = null
    this.lastCheckTime = 0
    console.log('[ProxyService] 代理缓存已清除')
  }

  /**
   * 测试代理连接
   * @param proxyUrl 代理地址
   * @param testUrl 测试目标 URL
   */
  async testProxy(proxyUrl: string, testUrl: string = 'https://www.google.com'): Promise<boolean> {
    try {
      const https = await import('https')
      const { URL } = await import('url')
      const agent = new HttpsProxyAgent(proxyUrl)
      
      return new Promise((resolve) => {
        const url = new URL(testUrl)
        const req = https.request({
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname,
          method: 'HEAD',
          agent: agent,
          timeout: 5000
        }, (res) => {
          resolve(res.statusCode !== undefined && res.statusCode < 500)
        })

        req.on('error', () => resolve(false))
        req.on('timeout', () => {
          req.destroy()
          resolve(false)
        })
        
        req.end()
      })
    } catch (error) {
      console.error('[ProxyService] 测试代理失败:', error)
      return false
    }
  }
}

// 导出单例
export const proxyService = new ProxyService()
