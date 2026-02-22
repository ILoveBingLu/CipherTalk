import { join, dirname } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import { app } from 'electron'

export class WcdbService {
  private lib: any = null
  private koffi: any = null
  private initialized = false
  private handle: number | null = null  // 改为 number 类型

  // 函数引用
  private wcdbInit: any = null
  private wcdbShutdown: any = null
  private wcdbOpenAccount: any = null
  private wcdbCloseAccount: any = null
  private wcdbFreeString: any = null
  private wcdbGetSessions: any = null
  private wcdbGetLogs: any = null
  private wcdbGetSnsTimeline: any = null

  /**
   * 获取 DLL 路径
   */
  private getDllPath(): string {
    const resourcesPath = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(app.getAppPath(), 'resources')

    return join(resourcesPath, 'wcdb_api.dll')
  }

  /**
   * 递归查找 session.db 文件
   */
  private findSessionDb(dir: string, depth = 0): string | null {
    if (depth > 5) return null

    try {
      const entries = readdirSync(dir)

      for (const entry of entries) {
        if (entry.toLowerCase() === 'session.db') {
          const fullPath = join(dir, entry)
          if (statSync(fullPath).isFile()) {
            return fullPath
          }
        }
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry)
        try {
          if (statSync(fullPath).isDirectory()) {
            const found = this.findSessionDb(fullPath, depth + 1)
            if (found) return found
          }
        } catch { }
      }
    } catch (e) {
      console.error('查找 session.db 失败:', e)
    }

    return null
  }

  /**
   * 初始化 wcdb 库
   * 返回: { success: boolean, error?: string }
   */
  private async initialize(): Promise<{ success: boolean; error?: string }> {
    if (this.initialized) return { success: true }

    try {
      this.koffi = require('koffi')
      const dllPath = this.getDllPath()

      if (!existsSync(dllPath)) {
        const msg = `WCDB DLL 不存在: ${dllPath}`
        console.error(msg)
        return { success: false, error: msg }
      }

      // 关键修复：显式预加载依赖库 WCDB.dll
      const wcdbCorePath = join(dirname(dllPath), 'WCDB.dll')
      if (existsSync(wcdbCorePath)) {
        try {
          this.koffi.load(wcdbCorePath)
        } catch (e: any) {
          console.warn('预加载 WCDB.dll 失败:', e)
          // 不要在这里返回失败，尝试继续加载主 DLL
        }
      } else {
        console.warn('预加载警告: WCDB.dll 未找到', wcdbCorePath)
      }

      // 尝试加载主 DLL
      try {
        this.lib = this.koffi.load(dllPath)
      } catch (e: any) {
        const msg = `koffi.load(wcdb_api) 失败: ${e.message}`
        console.error(msg)
        return { success: false, error: msg }
      }

      // 定义类型 - 使用与 C 接口完全匹配的签名
      // wcdb_status wcdb_init()
      this.wcdbInit = this.lib.func('int32 wcdb_init()')

      // wcdb_status wcdb_shutdown()
      this.wcdbShutdown = this.lib.func('int32 wcdb_shutdown()')

      // wcdb_status wcdb_open_account(const char* session_db_path, const char* hex_key, wcdb_handle* out_handle)
      this.wcdbOpenAccount = this.lib.func('int32 wcdb_open_account(const char* path, const char* key, _Out_ int64* handle)')

      // wcdb_status wcdb_close_account(wcdb_handle handle)
      this.wcdbCloseAccount = this.lib.func('int32 wcdb_close_account(int64 handle)')

      // void wcdb_free_string(char* ptr)
      this.wcdbFreeString = this.lib.func('void wcdb_free_string(void* ptr)')

      // wcdb_status wcdb_get_sessions(wcdb_handle handle, char** out_json)
      this.wcdbGetSessions = this.lib.func('int32 wcdb_get_sessions(int64 handle, _Out_ void** outJson)')

      // wcdb_status wcdb_get_logs(char** out_json)
      this.wcdbGetLogs = this.lib.func('int32 wcdb_get_logs(_Out_ void** outJson)')

      // wcdb_status wcdb_get_sns_timeline(wcdb_handle handle, int32 limit, int32 offset, const char* username, const char* keyword, int32 start_time, int32 end_time, char** out_json)
      this.wcdbGetSnsTimeline = this.lib.func('int32 wcdb_get_sns_timeline(int64 handle, int32 limit, int32 offset, const char* username, const char* keyword, int32 startTime, int32 endTime, _Out_ void** outJson)')

      // 初始化
      const initResult = this.wcdbInit()
      if (initResult !== 0) {
        const msg = `WCDB wcdb_init() 返回错误码: ${initResult}`
        console.error(msg)
        return { success: false, error: msg }
      }

      this.initialized = true
      return { success: true }
    } catch (e: any) {
      console.error('WCDB 初始化异常:', e)
      return { success: false, error: `初始化异常: ${e.message}` }
    }
  }

  /**
   * 测试数据库连接
   */
  async testConnection(dbPath: string, hexKey: string, wxid: string): Promise<{ success: boolean; error?: string; sessionCount?: number }> {
    try {
      if (!this.initialized) {
        const initRes = await this.initialize()
        if (!initRes.success) {
          return { success: false, error: initRes.error || 'WCDB 初始化失败(未知原因)' }
        }
      }

      // 构建 db_storage 目录路径
      const dbStoragePath = join(dbPath, wxid, 'db_storage')

      if (!existsSync(dbStoragePath)) {
        return { success: false, error: `数据库目录不存在: ${dbStoragePath}` }
      }

      // 递归查找 session.db
      const sessionDbPath = this.findSessionDb(dbStoragePath)

      if (!sessionDbPath) {
        return { success: false, error: `未找到 session.db 文件` }
      }

      // 分配输出参数内存 - 使用 number 数组
      const handleOut = [0]

      const result = this.wcdbOpenAccount(sessionDbPath, hexKey, handleOut)

      if (result !== 0) {
        // 获取 DLL 内部日志
        await this.printLogs()
        let errorMsg = '数据库打开失败'
        if (result === -1) errorMsg = '参数错误'
        else if (result === -2) errorMsg = '密钥错误'
        else if (result === -3) errorMsg = '数据库打开失败'
        return { success: false, error: `${errorMsg} (错误码: ${result})` }
      }

      const handle = handleOut[0]
      if (handle <= 0) {
        return { success: false, error: '无效的数据库句柄' }
      }

      // 保存句柄，保持连接打开（不再关闭）
      this.handle = handle

      return { success: true, sessionCount: 0 }
    } catch (e) {
      console.error('测试连接异常:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 打印 DLL 内部日志（仅在出错时调用）
   */
  private async printLogs(): Promise<void> {
    try {
      if (!this.wcdbGetLogs) return
      const outPtr = [null as any]
      const result = this.wcdbGetLogs(outPtr)
      if (result === 0 && outPtr[0]) {
        try {
          const jsonStr = this.koffi.decode(outPtr[0], 'char', -1)
          console.error('WCDB 内部日志:', jsonStr)
          this.wcdbFreeString(outPtr[0])
        } catch (e) {
          // ignore
        }
      }
    } catch (e) {
      console.error('获取日志失败:', e)
    }
  }

  /**
   * 打开数据库
   */
  async open(dbPath: string, hexKey: string, wxid: string): Promise<boolean> {
    try {
      if (!this.initialized) {
        const initOk = await this.initialize()
        if (!initOk) return false
      }

      if (this.handle !== null) {
        this.close()
      }

      const dbStoragePath = join(dbPath, wxid, 'db_storage')

      if (!existsSync(dbStoragePath)) {
        console.error('数据库目录不存在:', dbStoragePath)
        return false
      }

      const sessionDbPath = this.findSessionDb(dbStoragePath)
      if (!sessionDbPath) {
        console.error('未找到 session.db 文件')
        return false
      }

      const handleOut = [0]  // 使用 number 而不是 BigInt
      const result = this.wcdbOpenAccount(sessionDbPath, hexKey, handleOut)

      if (result !== 0) {
        console.error('打开数据库失败:', result)
        return false
      }

      const handle = handleOut[0]
      if (handle <= 0) {
        return false
      }

      this.handle = handle
      return true
    } catch (e) {
      console.error('打开数据库异常:', e)
      return false
    }
  }

  /**
   * 关闭数据库
   * 注意：wcdb_close_account 可能导致崩溃，使用 shutdown 代替
   */
  close(): void {
    if (this.handle !== null || this.initialized) {
      try {
        // 不调用 closeAccount，直接 shutdown
        this.wcdbShutdown()
      } catch (e) {
        console.error('WCDB shutdown 出错:', e)
      }
      this.handle = null
      this.initialized = false
    }
  }

  /**
   * 关闭服务（与 close 相同）
   */
  shutdown(): void {
    this.close()
  }

  /**
   * 获取朋友圈时间线
   */
  async getSnsTimeline(limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number): Promise<{ success: boolean; timeline?: any[]; error?: string }> {
    if (!this.initialized || this.handle === null) {
      return { success: false, error: 'WCDB 未初始化' }
    }

    try {
      const outJson = [null]
      
      // 将 usernames 数组转换为 JSON 字符串
      const usernamesJson = usernames && usernames.length > 0 ? JSON.stringify(usernames) : ''

      const result = this.wcdbGetSnsTimeline(
        this.handle,
        limit,
        offset,
        usernamesJson,
        keyword || '',
        startTime || 0,
        endTime || 0,
        outJson
      )

      if (result !== 0) {
        return { success: false, error: `获取朋友圈失败 (错误码: ${result})` }
      }

      if (!outJson[0]) {
        return { success: true, timeline: [] }
      }

      // 使用 -1 读取到 null 终止符
      const jsonStr = this.koffi.decode(outJson[0], 'char', -1)
      this.wcdbFreeString(outJson[0])

      const timeline = JSON.parse(jsonStr)
      return { success: true, timeline }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  /**
   * 解密朋友圈图片（使用纯 JS 实现，不依赖 DLL）
   */
  async decryptSnsImage(encryptedData: Buffer, key: string): Promise<Buffer> {
    // 朋友圈图片解密暂不支持，返回原始数据
    console.warn('[wcdbService] 朋友圈图片解密暂不支持，DLL 未提供该功能')
    return encryptedData
  }

  /**
   * 解密朋友圈视频（使用纯 JS 实现，不依赖 DLL）
   */
  async decryptSnsVideo(encryptedData: Buffer, key: string): Promise<Buffer> {
    // 朋友圈视频解密暂不支持，返回原始数据
    console.warn('[wcdbService] 朋友圈视频解密暂不支持，DLL 未提供该功能')
    return encryptedData
  }
}

export const wcdbService = new WcdbService()
