import { systemPreferences } from 'electron'
import { windowsHelloService } from './windowsHelloService'

export type SystemAuthStatus = {
  platform: NodeJS.Platform
  available: boolean
  method: 'windows-hello' | 'touch-id' | 'none'
  displayName: string
  error?: string
}

export type SystemAuthVerifyResult = {
  success: boolean
  method: 'windows-hello' | 'touch-id' | 'none'
  error?: string
}

class SystemAuthService {
  getStatus(): SystemAuthStatus {
    if (process.platform === 'win32') {
      const available = windowsHelloService.isAvailable()
      return {
        platform: process.platform,
        available,
        method: available ? 'windows-hello' : 'none',
        displayName: 'Windows Hello',
        error: available ? undefined : '当前设备未启用 Windows Hello'
      }
    }

    if (process.platform === 'darwin') {
      const available = systemPreferences.canPromptTouchID()
      return {
        platform: process.platform,
        available,
        method: available ? 'touch-id' : 'none',
        displayName: 'Touch ID',
        error: available ? undefined : '当前设备不支持 Touch ID 或未启用'
      }
    }

    return {
      platform: process.platform,
      available: false,
      method: 'none',
      displayName: '系统验证',
      error: `当前平台不支持系统验证: ${process.platform}`
    }
  }

  async verify(reason?: string): Promise<SystemAuthVerifyResult> {
    const status = this.getStatus()

    if (!status.available) {
      return {
        success: false,
        method: status.method,
        error: status.error || '当前设备不可用'
      }
    }

    if (process.platform === 'win32') {
      const result = windowsHelloService.verify(reason || '请验证您的身份')
      return {
        success: result.success,
        method: 'windows-hello',
        error: result.error
      }
    }

    if (process.platform === 'darwin') {
      try {
        await systemPreferences.promptTouchID(reason || '请验证您的身份')
        return { success: true, method: 'touch-id' }
      } catch (e: any) {
        const message = String(e?.message || e || '')
        return {
          success: false,
          method: 'touch-id',
          error: message.includes('User canceled')
            ? '用户取消了 Touch ID 验证'
            : message || 'Touch ID 验证失败'
        }
      }
    }

    return {
      success: false,
      method: 'none',
      error: `当前平台不支持系统验证: ${process.platform}`
    }
  }
}

export const systemAuthService = new SystemAuthService()
