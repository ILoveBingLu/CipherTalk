import { app } from 'electron'
import { dirname, join } from 'path'
import { existsSync } from 'fs'

export interface RuntimePlatformInfo {
  platform: NodeJS.Platform
  arch: string
}

export interface CachePathResult {
  success: boolean
  path: string
  drive: string
}

export function getRuntimePlatformInfo(): RuntimePlatformInfo {
  return {
    platform: process.platform,
    arch: process.arch
  }
}

export function getDefaultCachePath(): string {
  const documentsPath = app.getPath('documents')

  if (process.platform === 'darwin') {
    return join(documentsPath, 'CipherTalkData')
  }

  if (process.env.VITE_DEV_SERVER_URL) {
    return join(documentsPath, 'CipherTalkData')
  }

  const exePath = app.getPath('exe')
  const installDir = dirname(exePath)
  const isOnCDrive = /^[cC]:/i.test(installDir) || installDir.startsWith('\\\\')

  if (process.platform === 'win32') {
    if (isOnCDrive) {
      return join(documentsPath, 'CipherTalkData')
    }
    return join(installDir, 'CipherTalkData')
  }

  return join(app.getPath('userData'), 'CipherTalkData')
}

export function getBestCachePath(): CachePathResult {
  if (process.platform !== 'win32') {
    return {
      success: true,
      path: getDefaultCachePath(),
      drive: 'default'
    }
  }

  const drives = ['D', 'E', 'F', 'C']

  for (const drive of drives) {
    const drivePath = `${drive}:\\`
    if (existsSync(drivePath)) {
      return {
        success: true,
        path: join(drivePath, 'CipherTalkDB'),
        drive
      }
    }
  }

  return {
    success: true,
    path: getDefaultCachePath(),
    drive: 'default'
  }
}
