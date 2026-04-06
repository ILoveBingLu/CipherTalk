import { nativeDecryptService } from './nativeDecryptService'

/**
 * 微信数据库解密服务
 * 纯原生库实现封装
 */
export class WeChatDecryptService {

  /**
   * 验证密钥是否正确
   * 目前未实现单独的验证逻辑，依赖解密过程中的验证
   */
  validateKey(dbPath: string, hexKey: string): boolean {
    return true
  }

  /**
   * 解密数据库
   * 使用原生库解密（高性能、异步不卡顿）
   */
  async decryptDatabase(
    inputPath: string,
    outputPath: string,
    hexKey: string,
    onProgress?: (current: number, total: number) => void
  ): Promise<{ success: boolean; error?: string }> {

    // 检查服务是否可用
    if (!nativeDecryptService.isAvailable()) {
      return { success: false, error: '原生解密服务不可用：原生库加载失败或 Worker 未启动' }
    }

    try {
      // console.log(`[Decrypt] 开始解密: ${inputPath} -> ${outputPath}`) // 减少日志

      // 使用异步原生库解密
      const result = await nativeDecryptService.decryptDatabaseAsync(inputPath, outputPath, hexKey, onProgress)

      if (result.success) {
        // console.log('[Decrypt] 解密成功') // 减少日志
        return { success: true }
      } else {
        console.warn(`[Decrypt] 解密失败: ${result.error}`)
        return { success: false, error: result.error }
      }
    } catch (e) {
      console.error('[Decrypt] 调用异常:', e)
      return { success: false, error: String(e) }
    }
  }
}

export const wechatDecryptService = new WeChatDecryptService()
