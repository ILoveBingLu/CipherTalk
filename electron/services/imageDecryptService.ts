import { app, BrowserWindow } from 'electron'
import { basename, dirname, extname, join } from 'path'
import { pathToFileURL } from 'url'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs'
import { writeFile } from 'fs/promises'
import crypto from 'crypto'
import Database from 'better-sqlite3'
import { Worker } from 'worker_threads'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { ConfigService } from './config'

const execFileAsync = promisify(execFile)

// 获取 ffmpeg-static 的路径
function getStaticFfmpegPath(): string | null {
  try {
    // ffmpeg-static 导出的是路径字符串
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpegStatic = require('ffmpeg-static')
    if (typeof ffmpegStatic === 'string') {
      return ffmpegStatic
    }
    return null
  } catch {
    return null
  }
}

type DecryptResult = {
  success: boolean
  localPath?: string
  error?: string
  isThumb?: boolean  // 是否是缩略图（没有高清图时返回缩略图）
}

type HardlinkState = {
  db: Database.Database
  imageTable?: string
  dirTable?: string
}

export class ImageDecryptService {
  private configService = new ConfigService()
  private hardlinkCache = new Map<string, HardlinkState>()
  private resolvedCache = new Map<string, string>()
  private pending = new Map<string, Promise<DecryptResult>>()
  private readonly defaultV1AesKey = 'cfcd208495d565ef'
  private cacheIndexed = false
  private cacheIndexing: Promise<void> | null = null
  private updateFlags = new Map<string, boolean>()

  async resolveCachedImage(payload: { sessionId?: string; imageMd5?: string; imageDatName?: string }): Promise<DecryptResult & { hasUpdate?: boolean }> {
    await this.ensureCacheIndexed()
    const cacheKeys = this.getCacheKeys(payload)
    const cacheKey = cacheKeys[0]
    if (!cacheKey) {
      return { success: false, error: '缺少图片标识' }
    }
    for (const key of cacheKeys) {
      const cached = this.resolvedCache.get(key)
      if (cached && existsSync(cached) && this.isImageFile(cached)) {
        const localPath = this.filePathToUrl(cached)
        const isThumb = this.isThumbnailPath(cached)
        const hasUpdate = isThumb ? (this.updateFlags.get(key) ?? false) : false
        if (isThumb) {
          this.triggerUpdateCheck(payload, key, cached)
        } else {
          this.updateFlags.delete(key)
        }
        this.emitCacheResolved(payload, key, localPath)
        return { success: true, localPath, hasUpdate }
      }
      if (cached && !this.isImageFile(cached)) {
        this.resolvedCache.delete(key)
      }
    }

    for (const key of cacheKeys) {
      const existing = this.findCachedOutput(key, payload.sessionId)
      if (existing) {
        this.cacheResolvedPaths(key, payload.imageMd5, payload.imageDatName, existing)
        const localPath = this.filePathToUrl(existing)
        const isThumb = this.isThumbnailPath(existing)
        const hasUpdate = isThumb ? (this.updateFlags.get(key) ?? false) : false
        if (isThumb) {
          this.triggerUpdateCheck(payload, key, existing)
        } else {
          this.updateFlags.delete(key)
        }
        this.emitCacheResolved(payload, key, localPath)
        return { success: true, localPath, hasUpdate }
      }
    }
    return { success: false, error: '未找到缓存图片' }
  }

  async decryptImage(payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; force?: boolean }): Promise<DecryptResult> {
    await this.ensureCacheIndexed()
    const cacheKey = payload.imageMd5 || payload.imageDatName
    if (!cacheKey) {
      return { success: false, error: '缺少图片标识' }
    }

    // 即使 force=true，也先检查是否有高清图缓存
    if (payload.force) {
      // 查找高清图缓存
      const hdCached = this.findCachedOutput(cacheKey, payload.sessionId, true)
      if (hdCached && existsSync(hdCached) && this.isImageFile(hdCached)) {
        const localPath = this.filePathToUrl(hdCached)
        return { success: true, localPath, isThumb: false }
      }
    } else {
      // 常规缓存检查（可能返回缩略图）
      const cached = this.resolvedCache.get(cacheKey)
      if (cached && existsSync(cached) && this.isImageFile(cached)) {
        const localPath = this.filePathToUrl(cached)
        return { success: true, localPath }
      }
      if (cached && !this.isImageFile(cached)) {
        this.resolvedCache.delete(cacheKey)
      }
    }

    const pending = this.pending.get(cacheKey)
    if (pending) {
      return pending
    }

    const task = this.decryptImageInternal(payload, cacheKey)
    this.pending.set(cacheKey, task)
    try {
      return await task
    } finally {
      this.pending.delete(cacheKey)
    }
  }

  private async decryptImageInternal(
    payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; force?: boolean },
    cacheKey: string
  ): Promise<DecryptResult> {
    try {
      const wxid = this.configService.get('myWxid')
      const dbPath = this.configService.get('dbPath')
      if (!wxid || !dbPath) {
        return { success: false, error: '未配置账号或数据库路径' }
      }

      const accountDir = this.resolveAccountDir(dbPath, wxid)
      if (!accountDir) {
        console.error(`[ImageDecrypt] 未找到账号目录 wxid=${wxid} dbPath=${dbPath}`)
        return { success: false, error: '未找到账号目录' }
      }

      const datPath = await this.resolveDatPath(
        accountDir,
        payload.imageMd5,
        payload.imageDatName,
        payload.sessionId,
        { allowThumbnail: !payload.force, skipResolvedCache: Boolean(payload.force) }
      )

      // 如果要求高清图但没找到，直接返回提示
      if (!datPath && payload.force) {
        console.warn(`[ImageDecrypt] 未找到高清图: ${payload.imageDatName || payload.imageMd5}`)
        return { success: false, error: '未找到高清图，请在微信中点开该图片查看后重试' }
      }
      if (!datPath) {
        console.warn(`[ImageDecrypt] 未找到图片文件: ${payload.imageDatName || payload.imageMd5} sessionId=${payload.sessionId}`)
        return { success: false, error: '未找到图片文件' }
      }

      if (!extname(datPath).toLowerCase().includes('dat')) {
        this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, datPath)
        const localPath = this.filePathToUrl(datPath)
        const isThumb = this.isThumbnailPath(datPath)
        return { success: true, localPath, isThumb }
      }

      // 查找已缓存的解密文件
      const existing = this.findCachedOutput(cacheKey, payload.sessionId, payload.force)
      if (existing) {
        const isHd = this.isHdPath(existing)
        // 如果要求高清但找到的是缩略图，继续解密高清图
        if (!(payload.force && !isHd)) {
          this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, existing)
          const localPath = this.filePathToUrl(existing)
          const isThumb = this.isThumbnailPath(existing)
          return { success: true, localPath, isThumb }
        }
      }

      const xorKeyStr = this.configService.get('imageXorKey')
      // 支持十六进制格式（如 0x53）和十进制格式
      let xorKey: number
      if (typeof xorKeyStr === 'string') {
        const trimmed = xorKeyStr.trim()
        if (trimmed.toLowerCase().startsWith('0x')) {
          xorKey = parseInt(trimmed, 16)
        } else {
          xorKey = parseInt(trimmed, 10)
        }
      } else {
        xorKey = xorKeyStr as number
      }
      if (Number.isNaN(xorKey) || (!xorKey && xorKey !== 0)) {
        return { success: false, error: '未配置图片解密密钥' }
      }

      const aesKeyRaw = this.configService.get('imageAesKey')
      const aesKey = this.resolveAesKey(aesKeyRaw)

      let decrypted = await this.decryptDatAuto(datPath, xorKey, aesKey)

      // 检查是否是 wxgf 格式，如果是则尝试提取真实图片数据
      const wxgfResult = await this.unwrapWxgf(decrypted)
      decrypted = wxgfResult.data

      let ext = this.detectImageExtension(decrypted)

      // 如果是 wxgf 格式且没检测到扩展名
      if (wxgfResult.isWxgf && !ext) {
        // wxgf 格式需要 ffmpeg 转换，如果转换失败则无法显示
        ext = '.hevc'
      }

      const finalExt = ext || '.jpg'

      const outputPath = this.getCacheOutputPathFromDat(datPath, finalExt, payload.sessionId)
      await writeFile(outputPath, decrypted)

      const isThumb = this.isThumbnailPath(datPath)
      this.cacheResolvedPaths(cacheKey, payload.imageMd5, payload.imageDatName, outputPath)
      if (!isThumb) {
        this.clearUpdateFlags(cacheKey, payload.imageMd5, payload.imageDatName)
      }

      // 对于 hevc 格式，返回错误提示用户安装 ffmpeg
      if (finalExt === '.hevc') {
        console.warn(`[ImageDecrypt] 检测到 wxgf/hevc 格式图片，但未启用转换或转换失败: ${cacheKey}`)
        return {
          success: false,
          error: '此图片为微信新格式(wxgf)，需要安装 ffmpeg 才能显示。请运行: winget install ffmpeg',
          isThumb
        }
      }

      const localPath = this.filePathToUrl(outputPath)

      return { success: true, localPath, isThumb }
    } catch (e) {
      console.error(`[ImageDecrypt] 解密异常: ${cacheKey}`, e)
      return { success: false, error: String(e) }
    }
  }

  private resolveAccountDir(dbPath: string, wxid: string): string | null {
    const cleanedWxid = this.cleanAccountDirName(wxid)
    const normalized = dbPath.replace(/[\\/]+$/, '')

    // 1. 直接匹配原始 wxid
    const directOriginal = join(normalized, wxid)
    if (existsSync(directOriginal)) return directOriginal

    // 2. 直接匹配清理后的 wxid
    if (cleanedWxid !== wxid) {
      const directCleaned = join(normalized, cleanedWxid)
      if (existsSync(directCleaned)) return directCleaned
    }

    if (this.isAccountDir(normalized)) return normalized

    // 3. 扫描目录查找匹配
    try {
      const entries = readdirSync(normalized)
      const wxidLower = wxid.toLowerCase()
      const cleanedWxidLower = cleanedWxid.toLowerCase()
      for (const entry of entries) {
        const entryPath = join(normalized, entry)
        if (!this.isDirectory(entryPath)) continue
        const lowerEntry = entry.toLowerCase()

        // 精确匹配或前缀匹配
        if (lowerEntry === wxidLower || lowerEntry === cleanedWxidLower ||
          lowerEntry.startsWith(`${wxidLower}_`) || lowerEntry.startsWith(`${cleanedWxidLower}_`)) {
          if (this.isAccountDir(entryPath)) return entryPath
        }
      }
    } catch { }

    return null
  }

  /**
   * 获取解密后的缓存目录（用于查找 hardlink.db）
   */
  private getDecryptedCacheDir(wxid: string): string | null {
    // 获取有效的缓存路径（配置的或默认的）
    const configuredPath = this.configService.get('cachePath')
    const cachePath = configuredPath || this.getDefaultCachePath()

    const cleanedWxid = this.cleanAccountDirName(wxid)

    // 1. 先尝试原始 wxid
    const cacheAccountDirOriginal = join(cachePath, wxid)
    if (existsSync(join(cacheAccountDirOriginal, 'hardlink.db'))) {
      return cacheAccountDirOriginal
    }

    // 2. 再尝试清理后的 wxid
    if (cleanedWxid !== wxid) {
      const cacheAccountDirCleaned = join(cachePath, cleanedWxid)
      if (existsSync(join(cacheAccountDirCleaned, 'hardlink.db'))) {
        return cacheAccountDirCleaned
      }
    }

    // 3. 检查根目录
    if (existsSync(join(cachePath, 'hardlink.db'))) {
      return cachePath
    }

    return null
  }

  private isAccountDir(dirPath: string): boolean {
    return (
      existsSync(join(dirPath, 'hardlink.db')) ||
      existsSync(join(dirPath, 'db_storage')) ||
      existsSync(join(dirPath, 'FileStorage', 'Image')) ||
      existsSync(join(dirPath, 'FileStorage', 'Image2')) ||
      existsSync(join(dirPath, 'msg', 'attach'))  // 新版微信图片存储位置
    )
  }

  private isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  private cleanAccountDirName(dirName: string): string {
    const trimmed = dirName.trim()
    if (!trimmed) return trimmed

    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[^_]+)/i)
      if (match) return match[1]
      return trimmed
    }

    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
    if (suffixMatch) return suffixMatch[1]

    return trimmed
  }

  private async resolveDatPath(
    accountDir: string,
    imageMd5?: string,
    imageDatName?: string,
    sessionId?: string,
    options?: { allowThumbnail?: boolean; skipResolvedCache?: boolean }
  ): Promise<string | null> {
    const allowThumbnail = options?.allowThumbnail ?? true
    const skipResolvedCache = options?.skipResolvedCache ?? false

    // 优先通过 hardlink.db 查询
    if (imageMd5) {
      const hardlinkPath = this.resolveHardlinkPath(accountDir, imageMd5, sessionId)
      if (hardlinkPath) {
        const isThumb = this.isThumbnailPath(hardlinkPath)
        if (allowThumbnail || !isThumb) {
          this.cacheDatPath(accountDir, imageMd5, hardlinkPath)
          if (imageDatName) this.cacheDatPath(accountDir, imageDatName, hardlinkPath)
          return hardlinkPath
        }
        // hardlink 找到的是缩略图，但要求高清图
        // 尝试在同一目录下查找高清图变体（快速查找，不遍历）
        const hdPath = this.findHdVariantInSameDir(hardlinkPath)
        if (hdPath) {
          this.cacheDatPath(accountDir, imageMd5, hdPath)
          if (imageDatName) this.cacheDatPath(accountDir, imageDatName, hdPath)
          return hdPath
        }
        // 没找到高清图，返回 null（不进行全局搜索）
        return null
      }
    }

    if (!imageMd5 && imageDatName && this.looksLikeMd5(imageDatName)) {
      const hardlinkPath = this.resolveHardlinkPath(accountDir, imageDatName, sessionId)
      if (hardlinkPath) {
        const isThumb = this.isThumbnailPath(hardlinkPath)
        if (allowThumbnail || !isThumb) {
          this.cacheDatPath(accountDir, imageDatName, hardlinkPath)
          return hardlinkPath
        }
        // hardlink 找到的是缩略图，但要求高清图
        const hdPath = this.findHdVariantInSameDir(hardlinkPath)
        if (hdPath) {
          this.cacheDatPath(accountDir, imageDatName, hdPath)
          return hdPath
        }
        return null
      }
    }

    if (!imageDatName) {
      return null
    }
    if (!skipResolvedCache) {
      const cached = this.resolvedCache.get(imageDatName)
      if (cached && existsSync(cached)) {
        if (allowThumbnail || !this.isThumbnailPath(cached)) return cached
        // 缓存的是缩略图，尝试找高清图
        const hdPath = this.findHdVariantInSameDir(cached)
        if (hdPath) return hdPath
      }
    }

    // 只有在 hardlink 完全没有记录时才搜索文件夹
    const datPath = await this.searchDatFile(accountDir, imageDatName, allowThumbnail)
    if (datPath) {
      this.resolvedCache.set(imageDatName, datPath)
      this.cacheDatPath(accountDir, imageDatName, datPath)
      return datPath
    }
    const normalized = this.normalizeDatBase(imageDatName)
    if (normalized !== imageDatName.toLowerCase()) {
      const normalizedPath = await this.searchDatFile(accountDir, normalized, allowThumbnail)
      if (normalizedPath) {
        this.resolvedCache.set(imageDatName, normalizedPath)
        this.cacheDatPath(accountDir, imageDatName, normalizedPath)
        return normalizedPath
      }
    }
    return null
  }

  /**
   * 在同一目录下查找高清图变体
   * 缩略图: xxx_t.dat -> 高清图: xxx_h.dat 或 xxx.dat
   */
  private findHdVariantInSameDir(thumbPath: string): string | null {
    try {
      const dir = dirname(thumbPath)
      const fileName = basename(thumbPath).toLowerCase()

      // 提取基础名称（去掉 _t.dat 或 .t.dat）
      let baseName = fileName
      if (baseName.endsWith('_t.dat')) {
        baseName = baseName.slice(0, -6)
      } else if (baseName.endsWith('.t.dat')) {
        baseName = baseName.slice(0, -6)
      } else {
        return null
      }

      // 尝试查找高清图变体
      const variants = [
        `${baseName}_h.dat`,
        `${baseName}.h.dat`,
        `${baseName}.dat`
      ]

      for (const variant of variants) {
        const variantPath = join(dir, variant)
        if (existsSync(variantPath)) {
          return variantPath
        }
      }
    } catch { }
    return null
  }

  private async resolveThumbnailDatPath(
    accountDir: string,
    imageMd5?: string,
    imageDatName?: string,
    sessionId?: string
  ): Promise<string | null> {
    if (imageMd5) {
      const hardlinkPath = this.resolveHardlinkPath(accountDir, imageMd5, sessionId)
      if (hardlinkPath && this.isThumbnailPath(hardlinkPath)) return hardlinkPath
    }

    if (!imageMd5 && imageDatName && this.looksLikeMd5(imageDatName)) {
      const hardlinkPath = this.resolveHardlinkPath(accountDir, imageDatName, sessionId)
      if (hardlinkPath && this.isThumbnailPath(hardlinkPath)) return hardlinkPath
    }

    if (!imageDatName) return null
    return this.searchDatFile(accountDir, imageDatName, true, true)
  }

  private async checkHasUpdate(
    payload: { sessionId?: string; imageMd5?: string; imageDatName?: string },
    cacheKey: string,
    cachedPath: string
  ): Promise<boolean> {
    if (!cachedPath || !existsSync(cachedPath)) return false
    const isThumbnail = this.isThumbnailPath(cachedPath)
    if (!isThumbnail) return false
    const wxid = this.configService.get('myWxid')
    const dbPath = this.configService.get('dbPath')
    if (!wxid || !dbPath) return false
    const accountDir = this.resolveAccountDir(dbPath, wxid)
    if (!accountDir) return false

    const quickDir = this.getCachedDatDir(accountDir, payload.imageDatName, payload.imageMd5)
    if (quickDir) {
      const baseName = payload.imageDatName || payload.imageMd5 || cacheKey
      const candidate = this.findNonThumbnailVariantInDir(quickDir, baseName)
      if (candidate) {
        return true
      }
    }

    const thumbPath = await this.resolveThumbnailDatPath(
      accountDir,
      payload.imageMd5,
      payload.imageDatName,
      payload.sessionId
    )
    if (thumbPath) {
      const baseName = payload.imageDatName || payload.imageMd5 || cacheKey
      const candidate = this.findNonThumbnailVariantInDir(dirname(thumbPath), baseName)
      if (candidate) {
        return true
      }
      const searchHit = await this.searchDatFileInDir(dirname(thumbPath), baseName, false)
      if (searchHit && this.isNonThumbnailVariantDat(searchHit)) {
        return true
      }
    }
    return false
  }

  private triggerUpdateCheck(
    payload: { sessionId?: string; imageMd5?: string; imageDatName?: string },
    cacheKey: string,
    cachedPath: string
  ): void {
    if (this.updateFlags.get(cacheKey)) return
    void this.checkHasUpdate(payload, cacheKey, cachedPath).then((hasUpdate) => {
      if (!hasUpdate) return
      this.updateFlags.set(cacheKey, true)
      this.emitImageUpdate(payload, cacheKey)
    }).catch(() => { })
  }

  private looksLikeMd5(value: string): boolean {
    return /^[a-fA-F0-9]{16,32}$/.test(value)
  }

  private resolveHardlinkPath(accountDir: string, md5: string, sessionId?: string): string | null {
    // 优先从解密后的缓存目录查找 hardlink.db
    const wxid = this.configService.get('myWxid')
    const cacheDir = wxid ? this.getDecryptedCacheDir(wxid) : null

    // 收集所有可能的 hardlink.db 路径
    const hardlinkPaths: string[] = []
    if (cacheDir) {
      const cachePath = join(cacheDir, 'hardlink.db')
      if (existsSync(cachePath)) hardlinkPaths.push(cachePath)
    }
    const accountPath = join(accountDir, 'hardlink.db')
    if (existsSync(accountPath) && !hardlinkPaths.includes(accountPath)) {
      hardlinkPaths.push(accountPath)
    }

    if (hardlinkPaths.length === 0) {
      return null
    }

    // 依次尝试每个 hardlink.db
    for (const hardlinkPath of hardlinkPaths) {
      try {
        const state = this.getHardlinkState(hardlinkPath, hardlinkPath)
        if (!state.imageTable) {
          continue
        }

        const row = state.db
          .prepare(`SELECT dir1, dir2, file_name FROM ${state.imageTable} WHERE lower(md5) = lower(?) LIMIT 1`)
          .get(md5) as { dir1?: number; dir2?: number; file_name?: string } | undefined

        if (!row) {
          continue
        }

        const { dir1, dir2, file_name: fileName } = row
        if (dir1 === undefined || dir2 === undefined || !fileName) continue

        const lowerFileName = fileName.toLowerCase()
        if (lowerFileName.endsWith('.dat')) {
          const baseLower = lowerFileName.slice(0, -4)
          if (!this.isLikelyImageDatBase(baseLower) && !this.looksLikeMd5(baseLower)) {
            continue
          }
        }

        // dir1 和 dir2 是 rowid，需要从 dir2id 表查询对应的目录名
        let dir1Name: string | null = null
        let dir2Name: string | null = null

        if (state.dirTable) {
          try {
            // 通过 rowid 查询目录名
            const dir1Row = state.db
              .prepare(`SELECT username FROM ${state.dirTable} WHERE rowid = ? LIMIT 1`)
              .get(dir1) as { username?: string } | undefined
            if (dir1Row?.username) dir1Name = dir1Row.username

            const dir2Row = state.db
              .prepare(`SELECT username FROM ${state.dirTable} WHERE rowid = ? LIMIT 1`)
              .get(dir2) as { username?: string } | undefined
            if (dir2Row?.username) dir2Name = dir2Row.username
          } catch {
            // ignore
          }
        }

        if (!dir1Name || !dir2Name) {
          continue
        }

        // 构建可能的所有路径结构（仅限 msg/attach）
        const possiblePaths = [
          // 常见结构: msg/attach/xx/yy/Img/name
          join(accountDir, 'msg', 'attach', dir1Name, dir2Name, 'Img', fileName),
          join(accountDir, 'msg', 'attach', dir1Name, dir2Name, 'mg', fileName),
          join(accountDir, 'msg', 'attach', dir1Name, dir2Name, fileName),
        ]

        for (const fullPath of possiblePaths) {
          if (existsSync(fullPath)) {
            return fullPath
          }
        }
      } catch {
        // ignore
      }
    }

    return null
  }

  private getHardlinkState(accountDir: string, hardlinkPath: string): HardlinkState {
    const cached = this.hardlinkCache.get(accountDir)
    if (cached) return cached

    const db = new Database(hardlinkPath, { readonly: true, fileMustExist: true })
    const imageRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'image_hardlink_info%' ORDER BY name DESC LIMIT 1")
      .get() as { name?: string } | undefined
    const dirRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dir2id%' LIMIT 1")
      .get() as { name?: string } | undefined
    const state: HardlinkState = {
      db,
      imageTable: imageRow?.name as string | undefined,
      dirTable: dirRow?.name as string | undefined
    }
    this.hardlinkCache.set(accountDir, state)
    return state
  }

  private async searchDatFile(
    accountDir: string,
    datName: string,
    allowThumbnail = true,
    thumbOnly = false
  ): Promise<string | null> {
    const key = `${accountDir}|${datName}`
    const cached = this.resolvedCache.get(key)
    if (cached && existsSync(cached)) {
      if (allowThumbnail || !this.isThumbnailPath(cached)) return cached
    }

    const root = join(accountDir, 'msg', 'attach')
    if (!existsSync(root)) return null

    // 优化1：快速概率性查找
    // 包含：1. 基于文件名的前缀猜测 (旧版)
    //       2. 基于日期的最近月份扫描 (新版无索引时)
    const fastHit = await this.fastProbabilisticSearch(root, datName)
    if (fastHit) {
      this.resolvedCache.set(key, fastHit)
      return fastHit
    }

    // 优化2：兜底扫描 (异步非阻塞)
    const found = await this.walkForDatInWorker(root, datName.toLowerCase(), 8, allowThumbnail, thumbOnly)
    if (found) {
      this.resolvedCache.set(key, found)
      return found
    }
    return null
  }

  /**
   * 基于文件名的哈希特征猜测可能的路径
   * 包含：1. 微信旧版结构 filename.substr(0, 2)/...
   *       2. 微信新版结构 msg/attach/{hash}/{YYYY-MM}/Img/filename
   */
  private async fastProbabilisticSearch(root: string, datName: string): Promise<string | null> {
    const { promises: fs } = require('fs')
    const { join } = require('path')

    try {
      // --- 策略 A: 旧版路径猜测 (msg/attach/xx/yy/...) ---
      const lowerName = datName.toLowerCase()
      let baseName = lowerName
      if (baseName.endsWith('.dat')) {
        baseName = baseName.slice(0, -4)
        if (baseName.endsWith('_t') || baseName.endsWith('.t') || baseName.endsWith('_hd')) {
          baseName = baseName.slice(0, -3)
        } else if (baseName.endsWith('_thumb')) {
          baseName = baseName.slice(0, -6)
        }
      }

      const candidates: string[] = []
      if (/^[a-f0-9]{32}$/.test(baseName)) {
        const dir1 = baseName.substring(0, 2)
        const dir2 = baseName.substring(2, 4)
        candidates.push(
          join(root, dir1, dir2, datName),
          join(root, dir1, dir2, 'Img', datName),
          join(root, dir1, dir2, 'mg', datName),
          join(root, dir1, dir2, 'Image', datName)
        )
      }

      for (const path of candidates) {
        try {
          await fs.access(path)
          return path
        } catch { }
      }

      // --- 策略 B: 新版 Session 哈希路径猜测 ---
      try {
        const entries = await fs.readdir(root, { withFileTypes: true })
        const sessionDirs = entries
          .filter((e: any) => e.isDirectory() && e.name.length === 32 && /^[a-f0-9]+$/i.test(e.name))
          .map((e: any) => e.name)

        if (sessionDirs.length === 0) return null

        const now = new Date()
        const months: string[] = []
        for (let i = 0; i < 2; i++) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
          const mStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
          months.push(mStr)
        }

        const targetNames = [datName]
        if (baseName !== lowerName) {
          targetNames.push(`${baseName}.dat`)
          targetNames.push(`${baseName}_t.dat`)
          targetNames.push(`${baseName}_thumb.dat`)
        }

        const batchSize = 20
        for (let i = 0; i < sessionDirs.length; i += batchSize) {
          const batch = sessionDirs.slice(i, i + batchSize)
          const tasks = batch.map(async (sessDir: string) => {
            for (const month of months) {
              const subDirs = ['Img', 'Image']
              for (const sub of subDirs) {
                const dirPath = join(root, sessDir, month, sub)
                try { await fs.access(dirPath) } catch { continue }
                for (const name of targetNames) {
                  const p = join(dirPath, name)
                  try { await fs.access(p); return p } catch { }
                }
              }
            }
            return null
          })
          const results = await Promise.all(tasks)
          const hit = results.find(r => r !== null)
          if (hit) return hit
        }
      } catch { }

    } catch { }
    return null
  }

  private async searchDatFileInDir(
    dirPath: string,
    datName: string,
    allowThumbnail = true
  ): Promise<string | null> {
    if (!existsSync(dirPath)) return null
    return await this.walkForDatInWorker(dirPath, datName.toLowerCase(), 3, allowThumbnail, false)
  }

  private async walkForDatInWorker(
    root: string,
    datName: string,
    maxDepth = 4,
    allowThumbnail = true,
    thumbOnly = false
  ): Promise<string | null> {
    const { promises: fs } = require('fs')
    const { join } = require('path')

    // 广度优先搜索 (BFS) 队列
    const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }]
    const targetBase = this.normalizeDatBase(datName.toLowerCase())

    while (queue.length > 0) {
      // 每次取出一批并行处理，提高 IO 吞吐
      const batchSize = 10
      const batch = queue.splice(0, batchSize)

      const results = await Promise.all(batch.map(async ({ path: currentPath, depth }) => {
        if (depth > maxDepth) return null
        try {
          const entries = await fs.readdir(currentPath, { withFileTypes: true })
          for (const entry of entries) {
            const fullPath = join(currentPath, entry.name)
            if (entry.isDirectory()) {
              queue.push({ path: fullPath, depth: depth + 1 })
            } else if (entry.isFile()) {
              const lowerName = entry.name.toLowerCase()
              if (!lowerName.endsWith('.dat')) continue

              const isThumb = this.isThumbnailDat(lowerName)
              if (thumbOnly && !isThumb) continue
              if (!allowThumbnail && isThumb) continue

              if (this.matchesDatName(entry.name, datName)) {
                return fullPath
              }
            }
          }
        } catch { }
        return null
      }))

      const found = results.find(r => r !== null)
      if (found) return found
    }
    return null
  }

  private matchesDatName(fileName: string, datName: string): boolean {
    const lower = fileName.toLowerCase()
    const base = lower.endsWith('.dat') ? lower.slice(0, -4) : lower
    const normalizedBase = this.normalizeDatBase(base)
    const normalizedTarget = this.normalizeDatBase(datName.toLowerCase())
    if (normalizedBase === normalizedTarget) return true
    const pattern = new RegExp(`^${datName}(?:[._][a-z])?\\.dat$`, 'i')
    if (pattern.test(lower)) return true
    return lower.endsWith('.dat') && lower.includes(datName)
  }

  private scoreDatName(fileName: string): number {
    if (fileName.includes('.t.dat') || fileName.includes('_t.dat')) return 1
    if (fileName.includes('.c.dat') || fileName.includes('_c.dat')) return 1
    return 2
  }

  private isThumbnailDat(fileName: string): boolean {
    const lower = fileName.toLowerCase()
    return (
      lower.includes('.t.dat') ||
      lower.includes('_t.dat') ||
      lower.includes('_thumb.dat')
    )
  }

  private hasXVariant(baseLower: string): boolean {
    return /[._][a-z]$/.test(baseLower)
  }

  private isThumbnailPath(filePath: string): boolean {
    const lower = basename(filePath).toLowerCase()
    if (this.isThumbnailDat(lower)) return true
    const ext = extname(lower)
    const base = ext ? lower.slice(0, -ext.length) : lower
    // 支持新命名 _thumb 和旧命名 _t
    return (
      base.endsWith('_t') ||
      base.endsWith('_thumb') ||
      base.endsWith('.t')
    )
  }

  private isHdPath(filePath: string): boolean {
    const lower = basename(filePath).toLowerCase()
    const ext = extname(lower)
    const base = ext ? lower.slice(0, -ext.length) : lower
    return base.endsWith('_hd') || base.endsWith('_h')
  }

  private hasImageVariantSuffix(baseLower: string): boolean {
    return /[._][a-z]$/.test(baseLower)
  }

  private isLikelyImageDatBase(baseLower: string): boolean {
    return this.hasImageVariantSuffix(baseLower) || this.looksLikeMd5(baseLower)
  }

  private normalizeDatBase(name: string): string {
    let base = name.toLowerCase()
    if (base.endsWith('.dat') || base.endsWith('.jpg')) {
      base = base.slice(0, -4)
    }
    while (/[._][a-z]$/.test(base)) {
      base = base.slice(0, -2)
    }
    return base
  }

  private findCachedOutput(cacheKey: string, sessionId?: string, preferHd: boolean = false): string | null {
    const allRoots = this.getAllCacheRoots()
    const normalizedKey = this.normalizeDatBase(cacheKey.toLowerCase())
    const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp']

    // 遍历所有可能的缓存根路径
    for (const root of allRoots) {
      // 新目录结构: Images/{sessionId}/{年-月}/{文件名}_thumb.jpg 或 _hd.jpg
      // 需要遍历 sessionId 目录下的所有日期目录
      if (sessionId) {
        const sessionDir = join(root, sessionId)
        if (existsSync(sessionDir)) {
          try {
            const dateDirs = readdirSync(sessionDir, { withFileTypes: true })
              .filter(d => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
              .map(d => d.name)
              .sort()
              .reverse() // 最新的日期优先

            for (const dateDir of dateDirs) {
              const imageDir = join(sessionDir, dateDir)
              // 清理旧的 .hevc 文件
              this.cleanupHevcFiles(imageDir, normalizedKey)
              for (const ext of extensions) {
                if (preferHd) {
                  const hdPath = join(imageDir, `${normalizedKey}_hd${ext}`)
                  if (existsSync(hdPath)) return hdPath
                }
                const thumbPath = join(imageDir, `${normalizedKey}_thumb${ext}`)
                if (existsSync(thumbPath)) return thumbPath
                if (!preferHd) {
                  const hdPath = join(imageDir, `${normalizedKey}_hd${ext}`)
                  if (existsSync(hdPath)) return hdPath
                }
              }
            }
          } catch { }
        }
      }

      // 遍历所有 sessionId 目录查找
      try {
        const sessionDirs = readdirSync(root, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name)

        for (const session of sessionDirs) {
          const sessionDir = join(root, session)
          // 检查是否是日期目录结构
          try {
            const subDirs = readdirSync(sessionDir, { withFileTypes: true })
              .filter(d => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
              .map(d => d.name)

            for (const dateDir of subDirs) {
              const imageDir = join(sessionDir, dateDir)
              // 清理旧的 .hevc 文件
              this.cleanupHevcFiles(imageDir, normalizedKey)
              for (const ext of extensions) {
                if (preferHd) {
                  const hdPath = join(imageDir, `${normalizedKey}_hd${ext}`)
                  if (existsSync(hdPath)) return hdPath
                }
                const thumbPath = join(imageDir, `${normalizedKey}_thumb${ext}`)
                if (existsSync(thumbPath)) return thumbPath
                if (!preferHd) {
                  const hdPath = join(imageDir, `${normalizedKey}_hd${ext}`)
                  if (existsSync(hdPath)) return hdPath
                }
              }
            }
          } catch { }
        }
      } catch { }

      // 兼容旧目录结构: Images/{normalizedKey}/{normalizedKey}_thumb.jpg
      const oldImageDir = join(root, normalizedKey)
      if (existsSync(oldImageDir)) {
        // 清理旧的 .hevc 文件
        this.cleanupHevcFiles(oldImageDir, normalizedKey)
        for (const ext of extensions) {
          if (preferHd) {
            const hdPath = join(oldImageDir, `${normalizedKey}_hd${ext}`)
            if (existsSync(hdPath)) return hdPath
          }
          const thumbPath = join(oldImageDir, `${normalizedKey}_thumb${ext}`)
          if (existsSync(thumbPath)) return thumbPath
          if (!preferHd) {
            const hdPath = join(oldImageDir, `${normalizedKey}_hd${ext}`)
            if (existsSync(hdPath)) return hdPath
          }
        }
      }

      // 兼容最旧的平铺结构
      for (const ext of extensions) {
        const candidate = join(root, `${cacheKey}${ext}`)
        if (existsSync(candidate)) return candidate
      }
    }

    return null
  }

  /**
   * 清理旧的 .hevc 文件（ffmpeg 转换失败时遗留的）
   */
  private cleanupHevcFiles(dirPath: string, normalizedKey: string): void {
    try {
      const hevcThumb = join(dirPath, `${normalizedKey}_thumb.hevc`)
      const hevcHd = join(dirPath, `${normalizedKey}_hd.hevc`)
      if (existsSync(hevcThumb)) unlinkSync(hevcThumb)
      if (existsSync(hevcHd)) unlinkSync(hevcHd)
    } catch { }
  }

  /**
   * 从 DAT 路径中提取日期（年-月）
   * 路径格式: .../2026-01/Img/xxx.dat
   */
  private extractDateFromPath(datPath: string): string {
    // 匹配 yyyy-MM 格式的日期目录
    const match = datPath.match(/[\\\/](\d{4}-\d{2})[\\\/]/i)
    if (match) {
      return match[1]
    }
    // 如果没找到，使用当前日期
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  }

  /**
   * 生成缓存输出路径
   * 格式: Images/{sessionId}/{年-月}/{文件名}_thumb.jpg 或 _hd.jpg
   */
  private getCacheOutputPathFromDat(datPath: string, ext: string, sessionId?: string): string {
    const name = basename(datPath)
    const lower = name.toLowerCase()
    const base = lower.endsWith('.dat') ? name.slice(0, -4) : name

    // 提取基础名称（去掉 _t, _h 等后缀）
    const normalizedBase = this.normalizeDatBase(base)

    // 判断是缩略图还是高清图
    const isThumb = this.isThumbnailDat(lower)
    const suffix = isThumb ? '_thumb' : '_hd'

    // 提取日期
    const dateDir = this.extractDateFromPath(datPath)

    // 使用 sessionId 或 'unknown' 作为会话目录
    const sessionDir = sessionId || 'unknown'

    // 分级存储: Images/{sessionId}/{年-月}/{文件名}_thumb.jpg
    const imageDir = join(this.getCacheRoot(), sessionDir, dateDir)
    if (!existsSync(imageDir)) {
      mkdirSync(imageDir, { recursive: true })
    }

    return join(imageDir, `${normalizedBase}${suffix}${ext}`)
  }

  private cacheResolvedPaths(cacheKey: string, imageMd5: string | undefined, imageDatName: string | undefined, outputPath: string): void {
    this.resolvedCache.set(cacheKey, outputPath)
    if (imageMd5 && imageMd5 !== cacheKey) {
      this.resolvedCache.set(imageMd5, outputPath)
    }
    if (imageDatName && imageDatName !== cacheKey && imageDatName !== imageMd5) {
      this.resolvedCache.set(imageDatName, outputPath)
    }
  }

  private getCacheKeys(payload: { imageMd5?: string; imageDatName?: string }): string[] {
    const keys: string[] = []
    const addKey = (value?: string) => {
      if (!value) return
      const lower = value.toLowerCase()
      if (!keys.includes(value)) keys.push(value)
      if (!keys.includes(lower)) keys.push(lower)
      const normalized = this.normalizeDatBase(lower)
      if (normalized && !keys.includes(normalized)) keys.push(normalized)
    }
    addKey(payload.imageMd5)
    if (payload.imageDatName && payload.imageDatName !== payload.imageMd5) {
      addKey(payload.imageDatName)
    }
    return keys
  }

  private cacheDatPath(accountDir: string, datName: string, datPath: string): void {
    const key = `${accountDir}|${datName}`
    this.resolvedCache.set(key, datPath)
    const normalized = this.normalizeDatBase(datName)
    if (normalized && normalized !== datName.toLowerCase()) {
      this.resolvedCache.set(`${accountDir}|${normalized}`, datPath)
    }
  }

  private clearUpdateFlags(cacheKey: string, imageMd5?: string, imageDatName?: string): void {
    this.updateFlags.delete(cacheKey)
    if (imageMd5) this.updateFlags.delete(imageMd5)
    if (imageDatName) this.updateFlags.delete(imageDatName)
  }

  private getCachedDatDir(accountDir: string, imageDatName?: string, imageMd5?: string): string | null {
    const keys = [
      imageDatName ? `${accountDir}|${imageDatName}` : null,
      imageDatName ? `${accountDir}|${this.normalizeDatBase(imageDatName)}` : null,
      imageMd5 ? `${accountDir}|${imageMd5}` : null
    ].filter(Boolean) as string[]
    for (const key of keys) {
      const cached = this.resolvedCache.get(key)
      if (cached && existsSync(cached)) return dirname(cached)
    }
    return null
  }

  private findNonThumbnailVariantInDir(dirPath: string, baseName: string): string | null {
    let entries: string[]
    try {
      entries = readdirSync(dirPath)
    } catch {
      return null
    }
    const target = this.normalizeDatBase(baseName.toLowerCase())
    for (const entry of entries) {
      const lower = entry.toLowerCase()
      if (!lower.endsWith('.dat')) continue
      if (this.isThumbnailDat(lower)) continue
      if (!this.hasXVariant(lower.slice(0, -4))) continue
      const baseLower = lower.slice(0, -4)
      if (this.normalizeDatBase(baseLower) !== target) continue
      return join(dirPath, entry)
    }
    return null
  }

  private isNonThumbnailVariantDat(datPath: string): boolean {
    const lower = basename(datPath).toLowerCase()
    if (!lower.endsWith('.dat')) return false
    if (this.isThumbnailDat(lower)) return false
    const baseLower = lower.slice(0, -4)
    return this.hasXVariant(baseLower)
  }

  private emitImageUpdate(payload: { sessionId?: string; imageMd5?: string; imageDatName?: string }, cacheKey: string): void {
    const message = { cacheKey, imageMd5: payload.imageMd5, imageDatName: payload.imageDatName }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('image:updateAvailable', message)
      }
    }
  }

  private emitCacheResolved(payload: { sessionId?: string; imageMd5?: string; imageDatName?: string }, cacheKey: string, localPath: string): void {
    const message = { cacheKey, imageMd5: payload.imageMd5, imageDatName: payload.imageDatName, localPath }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('image:cacheResolved', message)
      }
    }
  }

  private async ensureCacheIndexed(): Promise<void> {
    if (this.cacheIndexed) return
    if (this.cacheIndexing) return this.cacheIndexing
    this.cacheIndexing = new Promise((resolve) => {
      const allRoots = this.getAllCacheRoots()
      const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp']

      for (const root of allRoots) {
        let entries: string[]
        try {
          entries = readdirSync(root)
        } catch {
          continue
        }
        for (const entry of entries) {
          const lower = entry.toLowerCase()
          const ext = extensions.find((item) => lower.endsWith(item))
          if (!ext) continue
          const fullPath = join(root, entry)
          try {
            if (!statSync(fullPath).isFile()) continue
          } catch {
            continue
          }
          const base = entry.slice(0, -ext.length)
          this.addCacheIndex(base, fullPath)
          const normalized = this.normalizeDatBase(base)
          if (normalized && normalized !== base.toLowerCase()) {
            this.addCacheIndex(normalized, fullPath)
          }
        }
      }
      this.cacheIndexed = true
      this.cacheIndexing = null
      resolve()
    })
    return this.cacheIndexing
  }

  private addCacheIndex(key: string, path: string): void {
    const normalizedKey = key.toLowerCase()
    const existing = this.resolvedCache.get(normalizedKey)
    if (existing) {
      const existingIsThumb = this.isThumbnailPath(existing)
      const candidateIsThumb = this.isThumbnailPath(path)
      if (!existingIsThumb && candidateIsThumb) return
    }
    this.resolvedCache.set(normalizedKey, path)
  }

  /**
   * 获取默认缓存路径（与 dataManagementService 保持一致）
   */
  private getDefaultCachePath(): string {
    // 开发环境使用文档目录
    if (process.env.VITE_DEV_SERVER_URL) {
      const documentsPath = app.getPath('documents')
      return join(documentsPath, 'CipherTalkData')
    }

    // 生产环境
    const exePath = app.getPath('exe')
    const installDir = require('path').dirname(exePath)

    // 检查是否安装在 C 盘
    const isOnCDrive = /^[cC]:/i.test(installDir) || installDir.startsWith('\\\\')

    if (isOnCDrive) {
      const documentsPath = app.getPath('documents')
      return join(documentsPath, 'CipherTalkData')
    }

    return join(installDir, 'CipherTalkData')
  }

  private getCacheRoot(): string {
    const configured = this.configService.get('cachePath')
    const root = configured
      ? join(configured, 'Images')
      : join(this.getDefaultCachePath(), 'Images')
    if (!existsSync(root)) {
      mkdirSync(root, { recursive: true })
    }
    return root
  }

  /**
   * 获取所有可能的缓存根路径（用于查找已缓存的图片）
   * 包含新路径和旧的 CipherTalk/Images 路径
   */
  private getAllCacheRoots(): string[] {
    const roots: string[] = []
    const configured = this.configService.get('cachePath')
    const documentsPath = app.getPath('documents')

    // 主要路径（当前使用的）
    const mainRoot = this.getCacheRoot()
    roots.push(mainRoot)

    // 如果配置了自定义路径，也检查其下的 Images
    if (configured) {
      roots.push(join(configured, 'Images'))
      roots.push(join(configured, 'images'))
    }

    // 默认路径
    const defaultPath = this.getDefaultCachePath()
    roots.push(join(defaultPath, 'Images'))
    roots.push(join(defaultPath, 'images'))

    // 兼容旧的 CipherTalk/Images 路径
    const oldPath = join(documentsPath, 'CipherTalk', 'Images')
    roots.push(oldPath)

    // 去重
    const uniqueRoots = Array.from(new Set(roots))
    // 过滤存在的路径
    const existingRoots = uniqueRoots.filter(r => existsSync(r))

    return existingRoots
  }

  private resolveAesKey(aesKeyRaw: string): Buffer | null {
    const trimmed = aesKeyRaw?.trim() ?? ''
    if (!trimmed) return null
    return this.asciiKey16(trimmed)
  }

  private async decryptDatAuto(datPath: string, xorKey: number, aesKey: Buffer | null): Promise<Buffer> {
    const version = this.getDatVersion(datPath)

    if (version === 0) {
      return this.decryptDatV3(datPath, xorKey)
    }
    if (version === 1) {
      const key = this.asciiKey16(this.defaultV1AesKey)
      return this.decryptDatV4(datPath, xorKey, key)
    }
    // version === 2
    if (!aesKey || aesKey.length !== 16) {
      throw new Error('请到设置配置图片解密密钥')
    }
    return this.decryptDatV4(datPath, xorKey, aesKey)
  }

  public decryptDatFile(inputPath: string, xorKey: number, aesKey?: Buffer): Buffer {
    const version = this.getDatVersion(inputPath)
    if (version === 0) {
      return this.decryptDatV3(inputPath, xorKey)
    } else if (version === 1) {
      const key = this.asciiKey16(this.defaultV1AesKey)
      return this.decryptDatV4(inputPath, xorKey, key)
    } else {
      if (!aesKey || aesKey.length !== 16) {
        throw new Error('V4版本需要16字节AES密钥')
      }
      return this.decryptDatV4(inputPath, xorKey, aesKey)
    }
  }

  public getDatVersion(inputPath: string): number {
    if (!existsSync(inputPath)) {
      throw new Error('文件不存在')
    }
    const bytes = readFileSync(inputPath)
    if (bytes.length < 6) {
      return 0
    }
    const signature = bytes.subarray(0, 6)
    if (this.compareBytes(signature, Buffer.from([0x07, 0x08, 0x56, 0x31, 0x08, 0x07]))) {
      return 1
    }
    if (this.compareBytes(signature, Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]))) {
      return 2
    }
    return 0
  }

  private decryptDatV3(inputPath: string, xorKey: number): Buffer {
    const data = readFileSync(inputPath)
    const out = Buffer.alloc(data.length)
    for (let i = 0; i < data.length; i += 1) {
      out[i] = data[i] ^ xorKey
    }
    return out
  }

  private decryptDatV4(inputPath: string, xorKey: number, aesKey: Buffer): Buffer {
    const bytes = readFileSync(inputPath)
    if (bytes.length < 0x0f) {
      throw new Error('文件太小，无法解析')
    }

    const header = bytes.subarray(0, 0x0f)
    const data = bytes.subarray(0x0f)
    const aesSize = this.bytesToInt32(header.subarray(6, 10))
    const xorSize = this.bytesToInt32(header.subarray(10, 14))

    // AES 数据需要对齐到 16 字节（PKCS7 填充）
    // 当 aesSize % 16 === 0 时，仍需要额外 16 字节的填充
    const remainder = ((aesSize % 16) + 16) % 16
    const alignedAesSize = aesSize + (16 - remainder)

    if (alignedAesSize > data.length) {
      throw new Error('文件格式异常：AES 数据长度超过文件实际长度')
    }

    const aesData = data.subarray(0, alignedAesSize)
    let unpadded: Buffer = Buffer.alloc(0)
    if (aesData.length > 0) {
      const decipher = crypto.createDecipheriv('aes-128-ecb', aesKey, null)
      decipher.setAutoPadding(false)
      const decrypted = Buffer.concat([decipher.update(aesData), decipher.final()])

      // 使用 PKCS7 填充移除
      unpadded = this.strictRemovePadding(decrypted)
    }

    const remaining = data.subarray(alignedAesSize)
    if (xorSize < 0 || xorSize > remaining.length) {
      throw new Error('文件格式异常：XOR 数据长度不合法')
    }

    let rawData = Buffer.alloc(0)
    let xoredData = Buffer.alloc(0)
    if (xorSize > 0) {
      const rawLength = remaining.length - xorSize
      if (rawLength < 0) {
        throw new Error('文件格式异常：原始数据长度小于XOR长度')
      }
      rawData = remaining.subarray(0, rawLength)
      const xorData = remaining.subarray(rawLength)
      xoredData = Buffer.alloc(xorData.length)
      for (let i = 0; i < xorData.length; i += 1) {
        xoredData[i] = xorData[i] ^ xorKey
      }
    } else {
      rawData = remaining
      xoredData = Buffer.alloc(0)
    }

    return Buffer.concat([unpadded, rawData, xoredData])
  }

  private bytesToInt32(bytes: Buffer): number {
    if (bytes.length !== 4) {
      throw new Error('需要4个字节')
    }
    return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
  }

  asciiKey16(keyString: string): Buffer {
    if (keyString.length < 16) {
      throw new Error('AES密钥至少需要16个字符')
    }
    return Buffer.from(keyString, 'ascii').subarray(0, 16)
  }

  private strictRemovePadding(data: Buffer): Buffer {
    if (!data.length) {
      throw new Error('解密结果为空，填充非法')
    }
    const paddingLength = data[data.length - 1]
    if (paddingLength === 0 || paddingLength > 16 || paddingLength > data.length) {
      throw new Error('PKCS7 填充长度非法')
    }
    for (let i = data.length - paddingLength; i < data.length; i += 1) {
      if (data[i] !== paddingLength) {
        throw new Error('PKCS7 填充内容非法')
      }
    }
    return data.subarray(0, data.length - paddingLength)
  }

  /**
   * 解包 wxgf 格式
   * wxgf 是微信的图片格式，内部使用 HEVC 编码
   * 参考：https://sarv.blog/posts/wxam/
   * 
   * wxgf 文件结构:
   * - 4 bytes: magic "wxgf" (77 78 67 66)
   * - 后续是分片数据，每个分片包含 HEVC NALU
   */
  private async unwrapWxgf(buffer: Buffer): Promise<{ data: Buffer; isWxgf: boolean }> {
    // 检查是否是 wxgf 格式 (77 78 67 66 = "wxgf")
    if (buffer.length < 20 ||
      buffer[0] !== 0x77 || buffer[1] !== 0x78 ||
      buffer[2] !== 0x67 || buffer[3] !== 0x66) {
      return { data: buffer, isWxgf: false }
    }

    // 先尝试搜索内嵌的传统图片签名（有些 wxgf 可能直接包含 JPG/PNG）
    for (let i = 4; i < Math.min(buffer.length - 12, 4096); i++) {
      // JPG
      if (buffer[i] === 0xff && buffer[i + 1] === 0xd8 && buffer[i + 2] === 0xff) {
        return { data: buffer.subarray(i), isWxgf: false }
      }
      // PNG
      if (buffer[i] === 0x89 && buffer[i + 1] === 0x50 &&
        buffer[i + 2] === 0x4e && buffer[i + 3] === 0x47) {
        return { data: buffer.subarray(i), isWxgf: false }
      }
    }

    // 提取 HEVC NALU 裸流
    const hevcData = this.extractHevcNalu(buffer)
    // console.log(`[ImageDecrypt] wxgf buffer=${buffer.length} hevcData=${hevcData?.length}`)

    if (!hevcData || hevcData.length < 100) {
      console.warn(`[ImageDecrypt] HEVC NALU 提取失败或数据过短: buffer=${buffer.length} hevc=${hevcData?.length ?? 0}`)
      return { data: buffer, isWxgf: true }
    }

    // 尝试用 ffmpeg 转换
    try {
      const jpgData = await this.convertHevcToJpg(hevcData)
      if (jpgData && jpgData.length > 0) {
        return { data: jpgData, isWxgf: false }
      }
    } catch (e) {
      console.error('[ImageDecrypt] unwrapWxgf 转换过程异常:', e)
    }

    // ffmpeg 失败，返回原始 HEVC 数据
    return { data: hevcData, isWxgf: true }
  }

  /**
   * 从 wxgf 数据中提取 HEVC NALU 裸流
   * 
   * wxgf 格式分析（基于 https://sarv.blog/posts/wxam/）:
   * - 文件头: "wxgf" + 元数据
   * - 数据区: 包含 HEVC NALU 单元
   * - HEVC NALU 起始码: 0x00000001 或 0x000001
   * 
   * HEVC NAL Unit Type (在起始码后的第一个字节的高6位):
   * - VPS (32): 视频参数集
   * - SPS (33): 序列参数集  
   * - PPS (34): 图像参数集
   * - IDR (19/20): 关键帧
   */
  private extractHevcNalu(buffer: Buffer): Buffer | null {
    const nalUnits: Buffer[] = []
    let i = 4 // 跳过 "wxgf" 头

    // 解析 wxgf 头部获取数据偏移
    // wxgf 头部结构不固定，我们直接搜索 HEVC NALU 起始码

    while (i < buffer.length - 4) {
      // 查找 4 字节起始码 0x00000001
      if (buffer[i] === 0x00 && buffer[i + 1] === 0x00 &&
        buffer[i + 2] === 0x00 && buffer[i + 3] === 0x01) {

        // 找到起始码，确定 NAL 单元的结束位置
        let nalStart = i
        let nalEnd = buffer.length

        // 搜索下一个起始码
        for (let j = i + 4; j < buffer.length - 3; j++) {
          if (buffer[j] === 0x00 && buffer[j + 1] === 0x00) {
            if (buffer[j + 2] === 0x01 ||
              (buffer[j + 2] === 0x00 && j + 3 < buffer.length && buffer[j + 3] === 0x01)) {
              nalEnd = j
              break
            }
          }
        }

        // 提取 NAL 单元
        const nalUnit = buffer.subarray(nalStart, nalEnd)
        if (nalUnit.length > 4) {
          nalUnits.push(nalUnit)
        }

        i = nalEnd
      } else if (buffer[i] === 0x00 && buffer[i + 1] === 0x00 && buffer[i + 2] === 0x01) {
        // 3 字节起始码
        let nalStart = i
        let nalEnd = buffer.length

        for (let j = i + 3; j < buffer.length - 2; j++) {
          if (buffer[j] === 0x00 && buffer[j + 1] === 0x00) {
            if (buffer[j + 2] === 0x01 ||
              (buffer[j + 2] === 0x00 && j + 3 < buffer.length && buffer[j + 3] === 0x01)) {
              nalEnd = j
              break
            }
          }
        }

        const nalUnit = buffer.subarray(nalStart, nalEnd)
        if (nalUnit.length > 3) {
          nalUnits.push(nalUnit)
        }

        i = nalEnd
      } else {
        i++
      }
    }

    if (nalUnits.length === 0) {
      // 备用方案：直接从第一个起始码开始截取到文件末尾
      for (let j = 4; j < buffer.length - 4; j++) {
        if (buffer[j] === 0x00 && buffer[j + 1] === 0x00 &&
          buffer[j + 2] === 0x00 && buffer[j + 3] === 0x01) {
          return buffer.subarray(j)
        }
      }
      return null
    }

    // 合并所有 NAL 单元
    return Buffer.concat(nalUnits)
  }

  /**
   * 获取 ffmpeg 可执行文件路径
   * 优先使用 ffmpeg-static 提供的路径，如果不可用则尝试系统 PATH
   */
  private getFfmpegPath(): string {
    // 尝试获取 ffmpeg-static 的路径
    const staticPath = getStaticFfmpegPath()
    if (staticPath) {
      // 处理 asar 打包的情况
      const unpackedPath = staticPath.replace('app.asar', 'app.asar.unpacked')
      if (existsSync(unpackedPath)) {
        return unpackedPath
      }
      if (existsSync(staticPath)) {
        return staticPath
      }
    }
    // 回退到系统 PATH
    console.warn(`[ImageDecrypt] ffmpeg-static 未找到解压路径，尝试使用系统 ffmpeg: ${staticPath}`)
    return 'ffmpeg'
  }

  /**
   * 使用 ffmpeg 将 HEVC 裸流转换为 JPG
   * 使用 spawn + 管道，最小化开销
   */
  private convertHevcToJpg(hevcData: Buffer): Promise<Buffer | null> {
    const ffmpeg = this.getFfmpegPath()
    // console.log(`[ImageDecrypt] 使用 ffmpeg: ${ffmpeg}`)

    return new Promise((resolve) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { spawn } = require('child_process')
      const chunks: Buffer[] = []
      const errChunks: Buffer[] = []

      const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'hevc',
        '-i', 'pipe:0',
        '-vframes', '1',
        '-q:v', '3',           // 稍微降低质量，加快编码
        '-f', 'mjpeg',
        'pipe:1'
      ]

      const proc = spawn(ffmpeg, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true      // Windows 下隐藏窗口
      })

      proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      proc.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk))

      proc.on('close', (code: number) => {
        if (code === 0 && chunks.length > 0) {
          const result = Buffer.concat(chunks)
          resolve(result)
        } else {
          const errMsg = Buffer.concat(errChunks).toString()
          console.error(`[ImageDecrypt] ffmpeg 转换失败 code=${code} err=${errMsg}`)
          resolve(null)
        }
      })

      proc.on('error', (err: any) => {
        console.error(`[ImageDecrypt] ffmpeg 启动失败: ${ffmpeg}`, err)
        resolve(null)
      })

      // 写入数据并关闭
      try {
        proc.stdin.write(hevcData)
        proc.stdin.end()
      } catch (e) {
        console.error('[ImageDecrypt] 写入 ffmpeg stdin 失败', e)
        resolve(null)
      }
    })
  }

  private detectImageExtension(buffer: Buffer): string | null {
    if (buffer.length < 12) return null

    // 检查是否是 wxgf 格式，如果是则跳过头部再检测
    if (buffer[0] === 0x77 && buffer[1] === 0x78 && buffer[2] === 0x67 && buffer[3] === 0x66) {
      // wxgf 格式，尝试在不同偏移位置查找图片签名
      const offsets = [0x10, 0x12, 0x14, 0x18, 0x20, 0xd0, 0x100]
      for (const offset of offsets) {
        if (buffer.length > offset + 12) {
          const ext = this.detectImageExtensionAt(buffer, offset)
          if (ext) return ext
        }
      }
      // 暴力搜索 JPG 签名 (ff d8 ff)
      for (let i = 4; i < Math.min(buffer.length - 3, 512); i++) {
        if (buffer[i] === 0xff && buffer[i + 1] === 0xd8 && buffer[i + 2] === 0xff) {
          return '.jpg'
        }
      }
      return null
    }

    return this.detectImageExtensionAt(buffer, 0)
  }

  private detectImageExtensionAt(buffer: Buffer, offset: number): string | null {
    if (buffer.length < offset + 12) return null
    if (buffer[offset] === 0x47 && buffer[offset + 1] === 0x49 && buffer[offset + 2] === 0x46) return '.gif'
    if (buffer[offset] === 0x89 && buffer[offset + 1] === 0x50 && buffer[offset + 2] === 0x4e && buffer[offset + 3] === 0x47) return '.png'
    if (buffer[offset] === 0xff && buffer[offset + 1] === 0xd8 && buffer[offset + 2] === 0xff) return '.jpg'
    if (buffer[offset] === 0x52 && buffer[offset + 1] === 0x49 && buffer[offset + 2] === 0x46 && buffer[offset + 3] === 0x46 &&
      buffer[offset + 8] === 0x57 && buffer[offset + 9] === 0x45 && buffer[offset + 10] === 0x42 && buffer[offset + 11] === 0x50) {
      return '.webp'
    }
    return null
  }

  private bufferToDataUrl(buffer: Buffer, ext: string): string | null {
    const mimeType = this.mimeFromExtension(ext)
    if (!mimeType) return null
    return `data:${mimeType};base64,${buffer.toString('base64')}`
  }

  private fileToDataUrl(filePath: string): string | null {
    try {
      const ext = extname(filePath).toLowerCase()
      const mimeType = this.mimeFromExtension(ext)
      if (!mimeType) return null
      const data = readFileSync(filePath)
      return `data:${mimeType};base64,${data.toString('base64')}`
    } catch {
      return null
    }
  }

  private mimeFromExtension(ext: string): string | null {
    switch (ext.toLowerCase()) {
      case '.gif':
        return 'image/gif'
      case '.png':
        return 'image/png'
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg'
      case '.webp':
        return 'image/webp'
      case '.heic':
      case '.heif':
        return 'image/heic'
      default:
        return null
    }
  }

  private filePathToUrl(filePath: string): string {
    const url = pathToFileURL(filePath).toString()
    try {
      const mtime = statSync(filePath).mtimeMs
      return `${url}?v=${Math.floor(mtime)}`
    } catch {
      return url
    }
  }

  private isImageFile(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase()
    return ext === '.gif' || ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp'
  }

  private compareBytes(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false
    }
    return true
  }

  // 保留原有的批量检测 XOR 密钥方法（用于兼容）
  async batchDetectXorKey(dirPath: string, maxFiles: number = 100): Promise<number | null> {
    const keyCount: Map<number, number> = new Map()
    let filesChecked = 0

    const V1_SIGNATURE = Buffer.from([0x07, 0x08, 0x56, 0x31, 0x08, 0x07])
    const V2_SIGNATURE = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])
    const IMAGE_SIGNATURES: { [key: string]: Buffer } = {
      jpg: Buffer.from([0xFF, 0xD8, 0xFF]),
      png: Buffer.from([0x89, 0x50, 0x4E, 0x47]),
      gif: Buffer.from([0x47, 0x49, 0x46, 0x38]),
      bmp: Buffer.from([0x42, 0x4D]),
      webp: Buffer.from([0x52, 0x49, 0x46, 0x46])
    }

    const detectXorKeyFromV3 = (header: Buffer): number | null => {
      for (const [, signature] of Object.entries(IMAGE_SIGNATURES)) {
        const xorKey = header[0] ^ signature[0]
        let valid = true
        for (let i = 0; i < signature.length && i < header.length; i++) {
          if ((header[i] ^ xorKey) !== signature[i]) {
            valid = false
            break
          }
        }
        if (valid) return xorKey
      }
      return null
    }

    const scanDir = (dir: string) => {
      if (filesChecked >= maxFiles) return
      try {
        const entries = readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (filesChecked >= maxFiles) return
          const fullPath = join(dir, entry.name)
          if (entry.isDirectory()) {
            scanDir(fullPath)
          } else if (entry.name.endsWith('.dat')) {
            try {
              const header = Buffer.alloc(16)
              const fd = require('fs').openSync(fullPath, 'r')
              require('fs').readSync(fd, header, 0, 16, 0)
              require('fs').closeSync(fd)

              if (header.subarray(0, 6).equals(V1_SIGNATURE) || header.subarray(0, 6).equals(V2_SIGNATURE)) {
                continue
              }

              const key = detectXorKeyFromV3(header)
              if (key !== null) {
                keyCount.set(key, (keyCount.get(key) || 0) + 1)
                filesChecked++
              }
            } catch { }
          }
        }
      } catch { }
    }

    scanDir(dirPath)

    if (keyCount.size === 0) return null

    let maxCount = 0
    let mostCommonKey: number | null = null
    keyCount.forEach((count, key) => {
      if (count > maxCount) {
        maxCount = count
        mostCommonKey = key
      }
    })

    return mostCommonKey
  }

  // 保留原有的解密到文件方法（用于兼容）
  async decryptToFile(inputPath: string, outputPath: string, xorKey: number, aesKey?: Buffer): Promise<void> {
    const version = this.getDatVersion(inputPath)
    let decrypted: Buffer

    if (version === 0) {
      decrypted = this.decryptDatV3(inputPath, xorKey)
    } else if (version === 1) {
      const key = this.asciiKey16(this.defaultV1AesKey)
      decrypted = this.decryptDatV4(inputPath, xorKey, key)
    } else {
      if (!aesKey || aesKey.length !== 16) {
        throw new Error('V4版本需要16字节AES密钥')
      }
      decrypted = this.decryptDatV4(inputPath, xorKey, aesKey)
    }

    const outputDir = dirname(outputPath)
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true })
    }

    await writeFile(outputPath, decrypted)
  }

  /**
   * 清理 hardlink 数据库缓存（用于增量更新时释放文件）
   */
  clearHardlinkCache(): void {
    this.hardlinkCache.forEach((state, accountDir) => {
      try {
        state.db.close()
      } catch (e) {
        console.warn(`关闭 hardlink 数据库失败: ${accountDir}`, e)
      }
    })
    this.hardlinkCache.clear()
  }
}

export const imageDecryptService = new ImageDecryptService()
