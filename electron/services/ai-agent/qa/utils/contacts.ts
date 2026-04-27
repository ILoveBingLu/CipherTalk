/**
 * QA 联系人显示名映射
 */
import { chatService } from '../../../chatService'
import { groupAnalyticsService } from '../../../groupAnalyticsService'

function normalizeDisplayName(value?: string | null): string {
  return String(value || '').trim()
}

function setContactDisplayName(map: Map<string, string>, username?: string | null, displayName?: string | null) {
  const key = normalizeDisplayName(username)
  const name = normalizeDisplayName(displayName)
  if (!key || !name) return
  map.set(key, name)
}

/**
 * 为单次 QA 加载联系人显示名映射。
 *
 * - 私聊/普通联系人来自 contact.db 的通讯录。
 * - 群聊额外加载群成员列表，覆盖同名 key，优先使用当前群里的成员显示名。
 */
export async function loadSessionContactMap(sessionId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()

  try {
    const result = await chatService.getContacts()
    if (result.success) {
      for (const contact of result.contacts || []) {
        setContactDisplayName(
          map,
          contact.username,
          contact.remark || contact.nickname || contact.displayName || contact.username
        )
      }
    }
  } catch (error) {
    console.warn('[SessionQAAgent] 加载联系人映射失败:', error)
  }

  if (sessionId.includes('@chatroom')) {
    try {
      const result = await groupAnalyticsService.getGroupMembers(sessionId)
      if (result.success) {
        for (const member of result.data || []) {
          setContactDisplayName(map, member.username, member.displayName || member.username)
        }
      }
    } catch (error) {
      console.warn('[SessionQAAgent] 加载群成员映射失败:', error)
    }
  }

  return map
}
