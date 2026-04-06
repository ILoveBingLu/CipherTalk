export type ShortcutUpdateResult = {
  success: boolean
  error?: string
}

export interface ShortcutService {
  updateDesktopShortcutIcon(iconPath: string): Promise<ShortcutUpdateResult>
}

import { shortcutService as windowsShortcutService } from './shortcutService.win32'
import { shortcutService as darwinShortcutService } from './shortcutService.darwin'
import { shortcutService as unsupportedShortcutService } from './shortcutService.unsupported'

const shortcutService: ShortcutService =
  process.platform === 'win32'
    ? windowsShortcutService
    : process.platform === 'darwin'
      ? darwinShortcutService
      : unsupportedShortcutService

export { shortcutService }
