import type { ShortcutService, ShortcutUpdateResult } from './shortcutService'

class UnsupportedShortcutService implements ShortcutService {
  async updateDesktopShortcutIcon(_iconPath: string): Promise<ShortcutUpdateResult> {
    return {
      success: false,
      error: `Desktop shortcut icon update is not supported on ${process.platform}`
    }
  }
}

export const shortcutService = new UnsupportedShortcutService()
