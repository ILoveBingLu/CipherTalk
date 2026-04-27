import { buildToolResultText } from './presentation'
import { getMcpConfigSnapshot, getMcpHealthPayload, getMcpStatusPayload } from './runtime'
import { McpReadService } from './readService'
import type { McpStreamPartialPayloadMap, McpStreamProgressPayload, McpToolName, McpToolResult } from './types'

const readService = new McpReadService()

type ExecuteStreamReporter = {
  progress?: (payload: McpStreamProgressPayload) => void | Promise<void>
  partial?: <K extends keyof McpStreamPartialPayloadMap>(toolName: K, payload: McpStreamPartialPayloadMap[K]) => void | Promise<void>
}

/**
 * 执行 MCP 工具（泛型版本）
 *
 * 调用方可通过工具名自动推断返回的 payload 类型：
 * ```ts
 * const result = await executeMcpTool('search_messages', { ... })
 * result.payload.hits // 自动推断为 McpSearchHit[]
 * ```
 */
export async function executeMcpTool<T extends McpToolName>(
  toolName: T,
  args: Record<string, unknown> = {},
  reporter?: ExecuteStreamReporter
): Promise<McpToolResult<T>> {
  // 注意：switch-case 内部 TypeScript 无法将泛型 T 缩窄到具体字面量，
  // 因此每个分支的 return 需要 as McpToolResult<T> 进行断言。
  // 类型安全由 McpToolPayloadMap 的映射关系保证。
  switch (toolName) {
    case 'health_check': {
      const payload = getMcpHealthPayload()
      return { summary: 'CipherTalk MCP health is available.', payload } as McpToolResult<T>
    }
    case 'get_status': {
      const payload = getMcpStatusPayload()
      return { summary: 'CipherTalk MCP status loaded.', payload } as McpToolResult<T>
    }
    case 'get_moments_timeline': {
      const payload = await readService.getMomentsTimeline(args as any)
      return { summary: buildToolResultText('get_moments_timeline', payload), payload } as McpToolResult<T>
    }
    case 'resolve_session': {
      const payload = await readService.resolveSession(args as any, reporter)
      return { summary: buildToolResultText('resolve_session', payload), payload } as McpToolResult<T>
    }
    case 'export_chat': {
      const payload = await readService.exportChat(args as any, reporter)
      return {
        summary: payload.success
          ? `Exported chat for ${payload.resolvedSession?.displayName || payload.resolvedSession?.sessionId || 'target session'}.`
          : payload.success === false
            ? `Failed to export chat for ${payload.resolvedSession?.displayName || payload.resolvedSession?.sessionId || 'target session'}.`
            : payload.canExport
            ? `Prepared export for ${payload.resolvedSession?.displayName || payload.resolvedSession?.sessionId || 'target session'}.`
            : 'Export request needs more information.',
        payload
      } as McpToolResult<T>
    }
    case 'get_global_statistics': {
      const payload = await readService.getGlobalStatistics(args as any)
      return { summary: 'Loaded global statistics.', payload } as McpToolResult<T>
    }
    case 'get_contact_rankings': {
      const payload = await readService.getContactRankings(args as any)
      return { summary: `Loaded ${payload.items.length} contact rankings.`, payload } as McpToolResult<T>
    }
    case 'get_activity_distribution': {
      const payload = await readService.getActivityDistribution(args as any)
      return { summary: 'Loaded activity distribution.', payload } as McpToolResult<T>
    }
    case 'list_sessions': {
      const payload = await readService.listSessions(args as any, reporter)
      return { summary: buildToolResultText('list_sessions', payload), payload } as McpToolResult<T>
    }
    case 'get_messages': {
      const defaults = getMcpConfigSnapshot()
      const payload = await readService.getMessages(args as any, defaults.mcpExposeMediaPaths, reporter)
      return { summary: buildToolResultText('get_messages', payload), payload } as McpToolResult<T>
    }
    case 'list_contacts': {
      const payload = await readService.listContacts(args as any, reporter)
      return { summary: buildToolResultText('list_contacts', payload), payload } as McpToolResult<T>
    }
    case 'search_messages': {
      const defaults = getMcpConfigSnapshot()
      const payload = await readService.searchMessages(args as any, defaults.mcpExposeMediaPaths, reporter)
      return { summary: buildToolResultText('search_messages', payload), payload } as McpToolResult<T>
    }
    case 'search_memory': {
      const defaults = getMcpConfigSnapshot()
      const payload = await readService.searchMemory(args as any, defaults.mcpExposeMediaPaths, reporter)
      return { summary: buildToolResultText('search_memory', payload), payload } as McpToolResult<T>
    }
    case 'get_session_context': {
      const defaults = getMcpConfigSnapshot()
      const payload = await readService.getSessionContext(args as any, defaults.mcpExposeMediaPaths, reporter)
      return { summary: buildToolResultText('get_session_context', payload), payload } as McpToolResult<T>
    }
    case 'get_session_statistics': {
      const payload = await readService.getSessionStatistics(args as any, reporter)
      return { summary: buildToolResultText('get_session_statistics', payload), payload } as McpToolResult<T>
    }
    case 'get_keyword_statistics': {
      const payload = await readService.getKeywordStatistics(args as any, reporter)
      return { summary: buildToolResultText('get_keyword_statistics', payload), payload } as McpToolResult<T>
    }
    default:
      throw new Error(`Unsupported MCP tool: ${toolName satisfies never}`)
  }
}
