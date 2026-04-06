import { basename, join } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'

type PathCandidate = {
  path: string
  accountCount: number
  latestModified: number
  score: number
}

export class DbPathService {
  async autoDetect(): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      const candidates = this.collectCandidates()
      if (candidates.length > 0) {
        return { success: true, path: candidates[0].path }
      }

      return { success: false, error: '未能自动检测到微信数据库目录' }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  scanWxids(rootPath: string): string[] {
    try {
      if (this.isAccountDir(rootPath)) {
        return [basename(rootPath)]
      }
      return this.findAccountDirs(rootPath)
    } catch {
      return []
    }
  }

  getDefaultPath(): string {
    const home = homedir()
    const detected = this.collectCandidates()[0]
    if (detected) return detected.path

    if (process.platform === 'darwin') {
      const appSupportBase = join(
        home,
        'Library',
        'Containers',
        'com.tencent.xinWeChat',
        'Data',
        'Library',
        'Application Support',
        'com.tencent.xinWeChat'
      )

      for (const entry of this.safeReadDir(appSupportBase)) {
        if (this.isMacVersionDir(entry)) {
          return join(appSupportBase, entry)
        }
      }

      return join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'xwechat_files')
    }

    return join(home, 'Documents', 'xwechat_files')
  }

  private getPossibleRoots(): string[] {
    const home = homedir()
    const possiblePaths: string[] = []

    if (process.platform === 'darwin') {
      const appSupportBase = join(
        home,
        'Library',
        'Containers',
        'com.tencent.xinWeChat',
        'Data',
        'Library',
        'Application Support',
        'com.tencent.xinWeChat'
      )

      for (const entry of this.safeReadDir(appSupportBase)) {
        if (this.isMacVersionDir(entry)) {
          possiblePaths.push(join(appSupportBase, entry))
        }
      }

      possiblePaths.push(
        join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'xwechat_files'),
        join(home, 'Documents', 'xwechat_files'),
        join(home, 'Documents', 'WeChat Files')
      )
      return possiblePaths
    }

    return [
      join(home, 'Documents', 'xwechat_files'),
      join(home, 'Documents', 'WeChat Files')
    ]
  }

  private collectCandidates(): PathCandidate[] {
    const candidates: PathCandidate[] = []
    const seen = new Set<string>()

    const pushCandidate = (candidatePath: string) => {
      const normalized = String(candidatePath || '').replace(/[\\/]+$/, '')
      if (!normalized || seen.has(normalized) || !existsSync(normalized)) return
      seen.add(normalized)

      if (this.isAccountDir(normalized)) {
        const latestModified = this.getAccountModifiedTime(normalized)
        candidates.push({
          path: normalized,
          accountCount: 1,
          latestModified,
          score: 1_000_000 + latestModified
        })
        return
      }

      const accounts = this.findAccountDirs(normalized)
      if (accounts.length === 0) return

      let latestModified = 0
      for (const account of accounts) {
        latestModified = Math.max(latestModified, this.getAccountModifiedTime(join(normalized, account)))
      }

      const rootName = basename(normalized).toLowerCase()
      const rootBonus =
        process.platform === 'darwin' && this.isMacVersionDir(rootName) ? 50_000 :
          rootName === 'xwechat_files' ? 30_000 :
            rootName === 'wechat files' ? 20_000 :
              0

      candidates.push({
        path: normalized,
        accountCount: accounts.length,
        latestModified,
        score: rootBonus + accounts.length * 10_000 + latestModified
      })
    }

    for (const candidate of this.getPossibleRoots()) {
      pushCandidate(candidate)
    }

    if (process.platform === 'darwin') {
      for (const candidate of this.getMacNestedRoots()) {
        pushCandidate(candidate)
      }
    }

    return candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.path.localeCompare(b.path)
    })
  }

  private getMacNestedRoots(): string[] {
    const home = homedir()
    const appSupportBase = join(
      home,
      'Library',
      'Containers',
      'com.tencent.xinWeChat',
      'Data',
      'Library',
      'Application Support',
      'com.tencent.xinWeChat'
    )

    const nestedRoots: string[] = []

    for (const entry of this.safeReadDir(appSupportBase)) {
      if (!this.isMacVersionDir(entry)) continue

      const versionDir = join(appSupportBase, entry)
      nestedRoots.push(versionDir)

      for (const child of this.safeReadDir(versionDir)) {
        if (!this.isPotentialAccountName(child)) continue
        nestedRoots.push(join(versionDir, child))
      }
    }

    return nestedRoots
  }

  private findAccountDirs(rootPath: string): string[] {
    const accounts: string[] = []

    try {
      for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (!this.isPotentialAccountName(entry.name)) continue

        const entryPath = join(rootPath, entry.name)
        if (this.isAccountDir(entryPath)) {
          accounts.push(entry.name)
        }
      }
    } catch {
      // ignore
    }

    return accounts.sort((a, b) => {
      const aTime = this.getAccountModifiedTime(join(rootPath, a))
      const bTime = this.getAccountModifiedTime(join(rootPath, b))
      if (bTime !== aTime) return bTime - aTime
      return a.localeCompare(b)
    })
  }

  private isAccountDir(entryPath: string): boolean {
    return (
      existsSync(join(entryPath, 'db_storage')) ||
      existsSync(join(entryPath, 'FileStorage', 'Image')) ||
      existsSync(join(entryPath, 'FileStorage', 'Image2')) ||
      existsSync(join(entryPath, 'msg', 'attach'))
    )
  }

  private isPotentialAccountName(name: string): boolean {
    const lower = name.toLowerCase()
    return !(
      lower.startsWith('all') ||
      lower.startsWith('applet') ||
      lower.startsWith('backup') ||
      lower.startsWith('wmpf') ||
      lower.startsWith('app_data')
    )
  }

  private isMacVersionDir(name: string): boolean {
    return /^\d+\.\d+b\d+\.\d+/.test(name) || /^\d+\.\d+\.\d+/.test(name)
  }

  private getAccountModifiedTime(entryPath: string): number {
    try {
      const accountStat = statSync(entryPath)
      let latest = accountStat.mtimeMs

      for (const candidate of [
        join(entryPath, 'db_storage'),
        join(entryPath, 'FileStorage', 'Image'),
        join(entryPath, 'FileStorage', 'Image2'),
        join(entryPath, 'msg', 'attach')
      ]) {
        if (existsSync(candidate)) {
          latest = Math.max(latest, statSync(candidate).mtimeMs)
        }
      }

      return latest
    } catch {
      return 0
    }
  }

  private safeReadDir(dirPath: string): string[] {
    try {
      if (!existsSync(dirPath)) return []
      return readdirSync(dirPath)
    } catch {
      return []
    }
  }
}

export const dbPathService = new DbPathService()
