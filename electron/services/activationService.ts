import { app } from 'electron'
import crypto from 'crypto'
import os from 'os'
import { execSync } from 'child_process'
import { ConfigService } from './config'

// 激活功能开关 - 设置为 false 可以临时禁用激活功能
const ACTIVATION_ENABLED = false

// API 配置
const API_BASE = 'https://miyu.admin.aiqji.com'

// 加密密钥（混淆存储）
const _k1 = [0x43, 0x69, 0x70, 0x68, 0x65, 0x72] // Cipher
const _k2 = [0x54, 0x61, 0x6c, 0x6b, 0x32, 0x30, 0x32, 0x36] // Talk2026
const ENCRYPTION_KEY = Buffer.from([..._k1, ..._k2]).toString()

// 激活状态接口
export interface ActivationStatus {
  isActivated: boolean
  type: string | null
  expiresAt: string | null
  activatedAt: string | null
  daysRemaining: number | null
  deviceId: string
}

// 激活结果接口
export interface ActivationResult {
  success: boolean
  message: string
  data?: {
    type: string
    expires_at: string | null
    activated_at: string
  }
}

class ActivationService {
  private deviceId: string | null = null
  private cachedStatus: ActivationStatus | null = null
  private lastCheckTime: number = 0
  private readonly CHECK_INTERVAL = 5 * 60 * 1000 // 5分钟缓存

  /**
   * 获取设备唯一标识（CPU + 主板信息）
   */
  getDeviceId(): string {
    if (this.deviceId) return this.deviceId

    try {
      const factors: string[] = []

      // 1. CPU 信息
      const cpus = os.cpus()
      if (cpus.length > 0) {
        factors.push(cpus[0].model)
      }

      // 2. 主板序列号（Windows）
      if (process.platform === 'win32') {
        try {
          // 尝试使用 PowerShell 获取序列号 (替代已弃用的 wmic)
          const biosSerial = execSync('powershell -Command "Get-WmiObject Win32_Bios | Select-Object -ExpandProperty SerialNumber"', {
            encoding: 'buffer',
            stdio: ['ignore', 'pipe', 'ignore'] // 忽略 stderr 防止错误输出
          })
          const serial = biosSerial.toString('utf8').trim()
          if (serial && serial !== 'To be filled by O.E.M.') {
            factors.push(serial)
          }
        } catch { }

        // 3. 主板UUID（更可靠的标识）
        try {
          // 尝试使用 PowerShell 获取 UUID
          const uuid = execSync('powershell -Command "Get-WmiObject Win32_ComputerSystemProduct | Select-Object -ExpandProperty UUID"', {
            encoding: 'buffer',
            stdio: ['ignore', 'pipe', 'ignore']
          })
          const uuidValue = uuid.toString('utf8').trim()
          if (uuidValue && uuidValue !== 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF') {
            factors.push(uuidValue)
          }
        } catch { }
      }

      // 组合并哈希
      const combined = factors.join('|')
      this.deviceId = crypto.createHash('sha256').update(combined).digest('hex').substring(0, 32)

      return this.deviceId
    } catch (e) {
      // 降级方案：使用随机 ID 并持久化
      console.error('获取设备ID失败:', e)
      this.deviceId = crypto.randomBytes(16).toString('hex')
      return this.deviceId
    }
  }

  /**
   * 加密数据
   */
  private encrypt(data: string): string {
    const iv = crypto.randomBytes(16)
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32)
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
    let encrypted = cipher.update(data, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    return iv.toString('hex') + ':' + encrypted
  }

  /**
   * 解密数据
   */
  private decrypt(encryptedData: string): string | null {
    try {
      const [ivHex, encrypted] = encryptedData.split(':')
      if (!ivHex || !encrypted) return null

      const iv = Buffer.from(ivHex, 'hex')
      const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32)
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
      let decrypted = decipher.update(encrypted, 'hex', 'utf8')
      decrypted += decipher.final('utf8')
      return decrypted
    } catch {
      return null
    }
  }

  /**
   * 生成签名（防篡改）
   */
  private generateSignature(data: object): string {
    const sortedKeys = Object.keys(data).sort()
    const str = sortedKeys.map(k => `${k}=${(data as any)[k]}`).join('&')
    return crypto.createHmac('sha256', ENCRYPTION_KEY).update(str).digest('hex')
  }

  /**
   * 验证签名
   */
  private verifySignature(data: object, signature: string): boolean {
    return this.generateSignature(data) === signature
  }

  /**
   * 验证激活码（在线）
   */
  async verifyCode(code: string): Promise<{ success: boolean; message: string }> {
    // 如果激活功能被禁用，直接返回成功
    if (!ACTIVATION_ENABLED) {
      return { success: true, message: '激活码有效（功能已禁用）' }
    }

    try {
      const response = await fetch(`${API_BASE}/api/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      })

      const result = await response.json() as { success: boolean; message?: string }
      return {
        success: result.success,
        message: result.message || (result.success ? '激活码有效' : '激活码无效')
      }
    } catch (e) {
      return { success: false, message: '网络错误，请检查网络连接' }
    }
  }

  /**
   * 激活设备
   */
  async activate(code: string): Promise<ActivationResult> {
    // 如果激活功能被禁用，直接返回成功
    if (!ACTIVATION_ENABLED) {
      // 清除缓存，强制刷新状态
      this.cachedStatus = null
      this.lastCheckTime = 0

      return {
        success: true,
        message: '激活成功（功能已禁用）',
        data: {
          type: 'permanent',
          expires_at: null,
          activated_at: new Date().toISOString()
        }
      }
    }

    try {
      const deviceId = this.getDeviceId()

      const response = await fetch(`${API_BASE}/api/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, device_id: deviceId })
      })

      const result = await response.json() as {
        success: boolean
        message?: string
        data?: {
          type: string
          expires_at: string | null
          activated_at: string
        }
      }

      if (result.success && result.data) {
        // 保存激活信息到本地（加密存储）
        await this.saveActivationData({
          code,
          deviceId,
          type: result.data.type,
          expiresAt: result.data.expires_at,
          activatedAt: result.data.activated_at,
          timestamp: Date.now()
        })

        // 清除缓存
        this.cachedStatus = null
        this.lastCheckTime = 0

        return {
          success: true,
          message: '激活成功',
          data: result.data
        }
      }

      return {
        success: false,
        message: result.message || '激活失败'
      }
    } catch (e) {
      return { success: false, message: '网络错误，请检查网络连接' }
    }
  }

  /**
   * 检查激活状态
   */
  async checkActivation(): Promise<ActivationStatus> {
    const deviceId = this.getDeviceId()

    // 如果激活功能被禁用，直接返回已激活状态
    if (!ACTIVATION_ENABLED) {
      const status: ActivationStatus = {
        isActivated: true,
        type: 'permanent',
        expiresAt: null,
        activatedAt: new Date().toISOString(),
        daysRemaining: null,
        deviceId
      }
      this.cachedStatus = status
      this.lastCheckTime = Date.now()
      return status
    }

    // 使用缓存
    if (this.cachedStatus && Date.now() - this.lastCheckTime < this.CHECK_INTERVAL) {
      return this.cachedStatus
    }

    // 1. 先检查本地存储
    const localData = await this.loadActivationData()

    if (!localData) {
      return this.createInactiveStatus(deviceId)
    }

    // 2. 验证设备ID
    if (localData.deviceId !== deviceId) {
      // 设备ID不匹配，可能是复制的数据
      await this.clearActivationData()
      return this.createInactiveStatus(deviceId)
    }

    // 3. 检查本地过期时间
    if (localData.expiresAt) {
      const expiresDate = new Date(localData.expiresAt)
      const now = new Date()
      if (now > expiresDate) {
        // 本地已过期
        const status: ActivationStatus = {
          isActivated: false,
          type: localData.type,
          expiresAt: localData.expiresAt,
          activatedAt: localData.activatedAt,
          daysRemaining: 0,
          deviceId
        }
        this.cachedStatus = status
        this.lastCheckTime = Date.now()
        return status
      }
    }

    // 4. 在线验证（每次启动或间隔时间后）
    try {
      const response = await fetch(`${API_BASE}/api/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId })
      })

      const result = await response.json() as {
        success: boolean
        message?: string
        data?: {
          type: string
          expires_at: string | null
          activated_at: string
        }
      }

      if (result.success && result.data) {
        // 更新本地数据
        await this.saveActivationData({
          ...localData,
          type: result.data.type,
          expiresAt: result.data.expires_at,
          activatedAt: result.data.activated_at,
          timestamp: Date.now()
        })

        const status = this.createActiveStatus(deviceId, result.data)
        this.cachedStatus = status
        this.lastCheckTime = Date.now()
        return status
      } else {
        // 服务器说未激活或已过期
        if (result.message === '激活已过期') {
          const status: ActivationStatus = {
            isActivated: false,
            type: localData.type,
            expiresAt: localData.expiresAt,
            activatedAt: localData.activatedAt,
            daysRemaining: 0,
            deviceId
          }
          this.cachedStatus = status
          this.lastCheckTime = Date.now()
          return status
        }

        // 设备未激活
        await this.clearActivationData()
        return this.createInactiveStatus(deviceId)
      }
    } catch {
      // 网络错误，使用本地数据（离线模式）
      const status = this.createActiveStatus(deviceId, {
        type: localData.type,
        expires_at: localData.expiresAt,
        activated_at: localData.activatedAt
      })
      this.cachedStatus = status
      this.lastCheckTime = Date.now()
      return status
    }
  }

  /**
   * 创建未激活状态
   */
  private createInactiveStatus(deviceId: string): ActivationStatus {
    return {
      isActivated: false,
      type: null,
      expiresAt: null,
      activatedAt: null,
      daysRemaining: null,
      deviceId
    }
  }

  /**
   * 创建已激活状态
   */
  private createActiveStatus(deviceId: string, data: {
    type: string
    expires_at: string | null
    activated_at: string
  }): ActivationStatus {
    let daysRemaining: number | null = null

    if (data.expires_at) {
      const expiresDate = new Date(data.expires_at)
      const now = new Date()
      const diffTime = expiresDate.getTime() - now.getTime()
      daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24))
      if (daysRemaining < 0) daysRemaining = 0
    }

    return {
      isActivated: true,
      type: data.type,
      expiresAt: data.expires_at,
      activatedAt: data.activated_at,
      daysRemaining,
      deviceId
    }
  }

  /**
   * 保存激活数据（加密）
   */
  private async saveActivationData(data: {
    code: string
    deviceId: string
    type: string
    expiresAt: string | null
    activatedAt: string
    timestamp: number
  }): Promise<void> {
    try {
      const configService = new ConfigService()

      // 添加签名
      const signature = this.generateSignature(data)
      const dataWithSig = { ...data, sig: signature }

      // 加密存储
      const encrypted = this.encrypt(JSON.stringify(dataWithSig))
      configService.set('activationData' as any, encrypted)
      configService.close()
    } catch (e) {
      console.error('保存激活数据失败:', e)
    }
  }

  /**
   * 加载激活数据（解密）
   */
  private async loadActivationData(): Promise<{
    code: string
    deviceId: string
    type: string
    expiresAt: string | null
    activatedAt: string
    timestamp: number
  } | null> {
    try {
      const configService = new ConfigService()

      const encrypted = configService.get('activationData' as any) as string
      configService.close()

      if (!encrypted) return null

      const decrypted = this.decrypt(encrypted)
      if (!decrypted) return null

      const data = JSON.parse(decrypted)

      // 验证签名
      const { sig, ...dataWithoutSig } = data
      if (!this.verifySignature(dataWithoutSig, sig)) {
        console.error('激活数据签名验证失败')
        return null
      }

      return dataWithoutSig
    } catch (e) {
      console.error('加载激活数据失败:', e)
      return null
    }
  }

  /**
   * 清除激活数据
   */
  private async clearActivationData(): Promise<void> {
    try {
      const configService = new ConfigService()
      configService.set('activationData' as any, '')
      configService.close()
    } catch (e) {
      console.error('清除激活数据失败:', e)
    }
  }

  /**
   * 获取激活类型显示名称
   */
  getTypeDisplayName(type: string | null): string {
    if (!type) return '未激活'
    const typeMap: Record<string, string> = {
      '30days': '30天试用版',
      '90days': '90天标准版',
      '365days': '365天专业版',
      'permanent': '永久版'
    }
    return typeMap[type] || type
  }

  /**
   * 清除缓存（用于强制刷新）
   */
  clearCache(): void {
    this.cachedStatus = null
    this.lastCheckTime = 0
  }
}

export const activationService = new ActivationService()
