import type { ShortcutService, ShortcutUpdateResult } from './shortcutService'

class DarwinShortcutService implements ShortcutService {
  async updateDesktopShortcutIcon(_iconPath: string): Promise<ShortcutUpdateResult> {
    // macOS 没有与 Windows .lnk 对应的统一桌面快捷方式图标更新入口，这里保持成功返回即可。
    return { success: true }
  }
}

export const shortcutService = new DarwinShortcutService()
