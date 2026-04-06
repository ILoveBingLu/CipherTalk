/**
 * Windows Hello 原生服务
 * 使用 koffi 调用 wx_key.dll 中的 Windows Hello API 进行生物识别验证
 * 比 WebAuthn API 更快，直接调用 WinRT
 * 功能已集成到 wx_key.dll 中，与密钥获取共用同一 DLL
 */

import { app } from 'electron'
import path from 'path'

// Windows Hello 结果枚举
export enum WindowsHelloResult {
    VERIFIED = 0,           // 验证成功
    DEVICE_NOT_PRESENT = 1, // 设备不存在
    NOT_CONFIGURED = 2,     // 未配置
    DISABLED_BY_POLICY = 3, // 被策略禁用
    DEVICE_BUSY = 4,        // 设备忙
    RETRIES_EXHAUSTED = 5,  // 重试次数耗尽
    CANCELED = 6,           // 用户取消
    UNKNOWN_ERROR = 99      // 未知错误
}

// 错误消息映射
const ERROR_MESSAGES: Record<number, string> = {
    [WindowsHelloResult.VERIFIED]: '验证成功',
    [WindowsHelloResult.DEVICE_NOT_PRESENT]: '未检测到生物识别设备',
    [WindowsHelloResult.NOT_CONFIGURED]: 'Windows Hello 未配置，请在系统设置中设置',
    [WindowsHelloResult.DISABLED_BY_POLICY]: 'Windows Hello 被系统策略禁用',
    [WindowsHelloResult.DEVICE_BUSY]: '生物识别设备正忙，请稍后重试',
    [WindowsHelloResult.RETRIES_EXHAUSTED]: '验证失败次数过多，请稍后重试',
    [WindowsHelloResult.CANCELED]: '用户取消了验证',
    [WindowsHelloResult.UNKNOWN_ERROR]: '发生未知错误'
}

class WindowsHelloService {
    private lib: any = null
    private functions: {
        WindowsHelloAvailable: () => number
        WindowsHelloVerify: (message: string) => number
        WindowsHelloGetErrorMessage: (result: number) => string
    } | null = null

    /**
     * 初始化 DLL (使用 wx_key.dll，Windows Hello 功能已集成)
     */
    private init(): boolean {
        if (this.lib) return true
        if (process.platform !== 'win32') return false

        try {
            const koffi = require('koffi')

            // 确定 DLL 路径 - 使用现有的 wx_key.dll
            const isDev = !app.isPackaged
            let dllPath: string

            if (isDev) {
                // 开发环境：从 native-dlls 目录加载
                dllPath = path.join(__dirname, '../../native-dlls/wx_key.dll')
            } else {
                // 生产环境：从 resources 目录加载
                dllPath = path.join(process.resourcesPath, 'resources/wx_key.dll')
            }

            console.log('[WindowsHello] 加载 DLL:', dllPath)

            // 加载 DLL
            this.lib = koffi.load(dllPath)

            // 定义函数签名
            this.functions = {
                WindowsHelloAvailable: this.lib.func('int WindowsHelloAvailable()'),
                WindowsHelloVerify: this.lib.func('int WindowsHelloVerify(const char* message)'),
                WindowsHelloGetErrorMessage: this.lib.func('const char* WindowsHelloGetErrorMessage(int result)')
            }

            console.log('[WindowsHello] DLL 加载成功')
            return true
        } catch (e: any) {
            console.error('[WindowsHello] 初始化失败:', e.message)
            this.lib = null
            this.functions = null
            return false
        }
    }

    /**
     * 检查 Windows Hello 是否可用
     */
    isAvailable(): boolean {
        if (process.platform !== 'win32') return false
        if (!this.init()) return false

        try {
            const result = this.functions!.WindowsHelloAvailable()
            return result === 1
        } catch (e: any) {
            console.error('[WindowsHello] 检查可用性失败:', e.message)
            return false
        }
    }

    /**
     * 请求 Windows Hello 验证
     * @param message 向用户显示的消息
     * @returns 验证结果
     */
    verify(message: string = 'CipherTalk 需要验证您的身份'): { success: boolean; result: WindowsHelloResult; error?: string } {
        if (process.platform !== 'win32') {
            return {
                success: false,
                result: WindowsHelloResult.DEVICE_NOT_PRESENT,
                error: '当前平台不支持 Windows Hello'
            }
        }

        if (!this.init()) {
            return {
                success: false,
                result: WindowsHelloResult.UNKNOWN_ERROR,
                error: 'Windows Hello DLL 未初始化'
            }
        }

        try {
            const result = this.functions!.WindowsHelloVerify(message) as WindowsHelloResult

            if (result === WindowsHelloResult.VERIFIED) {
                return { success: true, result }
            }

            return {
                success: false,
                result,
                error: ERROR_MESSAGES[result] || '未知错误'
            }
        } catch (e: any) {
            console.error('[WindowsHello] 验证失败:', e.message)
            return {
                success: false,
                result: WindowsHelloResult.UNKNOWN_ERROR,
                error: e.message || '验证过程发生异常'
            }
        }
    }

    /**
     * 获取错误消息
     */
    getErrorMessage(result: WindowsHelloResult): string {
        return ERROR_MESSAGES[result] || '未知错误'
    }
}

// 导出单例
export const windowsHelloService = new WindowsHelloService()

// 导出类型和枚举
export type { WindowsHelloService }
