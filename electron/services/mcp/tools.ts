import { z } from 'zod'
import { createToolError, createToolSuccess } from './result'
import { getMcpConfigSnapshot, getMcpHealthPayload, getMcpStatusPayload } from './runtime'
import { McpReadService } from './service'
import { MCP_CONTACT_KINDS, MCP_MESSAGE_KINDS } from './types'

const readService = new McpReadService()

export function registerCipherTalkMcpTools(server: any) {
  server.registerTool('health_check', {
    title: 'Health Check',
    description: 'Return CipherTalk MCP health information.'
  }, async () => {
    try {
      const payload = getMcpHealthPayload()
      return createToolSuccess('CipherTalk MCP health is available.', payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('get_status', {
    title: 'Get Status',
    description: 'Return CipherTalk MCP runtime and configuration status.'
  }, async () => {
    try {
      const payload = getMcpStatusPayload()
      return createToolSuccess('CipherTalk MCP status loaded.', payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('get_global_statistics', {
    title: 'Get Global Statistics',
    description: 'Return global private-chat statistics for agent-side analysis.',
    inputSchema: {
      startTime: z.number().int().positive().optional().describe('Optional start timestamp in seconds or milliseconds.'),
      endTime: z.number().int().positive().optional().describe('Optional end timestamp in seconds or milliseconds.')
    }
  }, async (args: unknown) => {
    try {
      const payload = await readService.getGlobalStatistics((args || {}) as any)
      return createToolSuccess('Loaded global statistics.', payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('get_contact_rankings', {
    title: 'Get Contact Rankings',
    description: 'Return ranked private-chat contacts by message count.',
    inputSchema: {
      limit: z.number().int().positive().optional().describe('Maximum number of contacts to return.'),
      startTime: z.number().int().positive().optional().describe('Optional start timestamp in seconds or milliseconds.'),
      endTime: z.number().int().positive().optional().describe('Optional end timestamp in seconds or milliseconds.')
    }
  }, async (args: unknown) => {
    try {
      const payload = await readService.getContactRankings((args || {}) as any)
      return createToolSuccess(`Loaded ${payload.items.length} contact rankings.`, payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('get_activity_distribution', {
    title: 'Get Activity Distribution',
    description: 'Return hourly, weekday, and monthly message distributions.',
    inputSchema: {
      startTime: z.number().int().positive().optional().describe('Optional start timestamp in seconds or milliseconds.'),
      endTime: z.number().int().positive().optional().describe('Optional end timestamp in seconds or milliseconds.')
    }
  }, async (args: unknown) => {
    try {
      const payload = await readService.getActivityDistribution((args || {}) as any)
      return createToolSuccess('Loaded activity distribution.', payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('list_sessions', {
    title: 'List Sessions',
    description: 'List chat sessions with search and pagination.',
    inputSchema: {
      q: z.string().optional().describe('Optional search keyword.'),
      offset: z.number().int().nonnegative().optional().describe('Pagination offset.'),
      limit: z.number().int().positive().optional().describe('Pagination limit.'),
      unreadOnly: z.boolean().optional().describe('Only return sessions with unread messages.')
    }
  }, async (args: unknown) => {
    try {
      const payload = await readService.listSessions((args || {}) as any)
      return createToolSuccess(`Loaded ${payload.items.length} sessions.`, payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('get_messages', {
    title: 'Get Messages',
    description: 'List messages from one chat session with filters and pagination.',
    inputSchema: {
      sessionId: z.string().trim().min(1).describe('Required session identifier / username.'),
      offset: z.number().int().nonnegative().optional().describe('Pagination offset.'),
      limit: z.number().int().positive().optional().describe('Pagination limit.'),
      order: z.enum(['asc', 'desc']).optional().describe('Message sort order by time.'),
      keyword: z.string().optional().describe('Optional content keyword filter.'),
      startTime: z.number().int().positive().optional().describe('Start timestamp in seconds or milliseconds.'),
      endTime: z.number().int().positive().optional().describe('End timestamp in seconds or milliseconds.'),
      includeRaw: z.boolean().optional().describe('Include raw message content when true.'),
      includeMediaPaths: z.boolean().optional().describe('Resolve media local paths when true.')
    }
  }, async (args: unknown) => {
    try {
      const defaults = getMcpConfigSnapshot()
      const payload = await readService.getMessages((args || {}) as any, defaults.mcpExposeMediaPaths)
      return createToolSuccess(`Loaded ${payload.items.length} messages.`, payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('list_contacts', {
    title: 'List Contacts',
    description: 'List contacts, groups, and official accounts for agent-side resolution.',
    inputSchema: {
      q: z.string().optional().describe('Optional search keyword.'),
      offset: z.number().int().nonnegative().optional().describe('Pagination offset.'),
      limit: z.number().int().positive().optional().describe('Pagination limit.'),
      types: z.array(z.enum(MCP_CONTACT_KINDS)).optional().describe('Optional contact kinds to include.')
    }
  }, async (args: unknown) => {
    try {
      const payload = await readService.listContacts((args || {}) as any)
      return createToolSuccess(`Loaded ${payload.items.length} contacts.`, payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('search_messages', {
    title: 'Search Messages',
    description: 'Search messages across one or more sessions and return agent-friendly hits.',
    inputSchema: {
      query: z.string().trim().min(1).describe('Required full-text query.'),
      sessionId: z.string().trim().min(1).optional().describe('Single session identifier to search.'),
      sessionIds: z.array(z.string().trim().min(1)).max(20).optional().describe('Multiple session identifiers to search.'),
      startTime: z.number().int().positive().optional().describe('Start timestamp in seconds or milliseconds.'),
      endTime: z.number().int().positive().optional().describe('End timestamp in seconds or milliseconds.'),
      kinds: z.array(z.enum(MCP_MESSAGE_KINDS)).optional().describe('Optional message kinds to include.'),
      direction: z.enum(['in', 'out']).optional().describe('Optional direction filter.'),
      senderUsername: z.string().trim().min(1).optional().describe('Optional sender username filter.'),
      matchMode: z.enum(['substring', 'exact']).optional().describe('Search match mode.'),
      limit: z.number().int().positive().optional().describe('Maximum number of hits to return.'),
      includeRaw: z.boolean().optional().describe('Include raw message content when true.'),
      includeMediaPaths: z.boolean().optional().describe('Resolve media local paths when true.')
    }
  }, async (args: unknown) => {
    try {
      const defaults = getMcpConfigSnapshot()
      const payload = await readService.searchMessages((args || {}) as any, defaults.mcpExposeMediaPaths)
      return createToolSuccess(`Loaded ${payload.hits.length} message hits.`, payload)
    } catch (error) {
      return createToolError(error)
    }
  })

  server.registerTool('get_session_context', {
    title: 'Get Session Context',
    description: 'Return the latest session context or messages around a cursor anchor.',
    inputSchema: {
      sessionId: z.string().trim().min(1).describe('Required session identifier / username.'),
      mode: z.enum(['latest', 'around']).describe('Context mode.'),
      anchorCursor: z.object({
        sortSeq: z.number().int(),
        createTime: z.number().int().positive(),
        localId: z.number().int()
      }).optional().describe('Required cursor when mode=around.'),
      beforeLimit: z.number().int().positive().optional().describe('Latest count or before-context count.'),
      afterLimit: z.number().int().positive().optional().describe('After-context count when mode=around.'),
      includeRaw: z.boolean().optional().describe('Include raw message content when true.'),
      includeMediaPaths: z.boolean().optional().describe('Resolve media local paths when true.')
    }
  }, async (args: unknown) => {
    try {
      const defaults = getMcpConfigSnapshot()
      const payload = await readService.getSessionContext((args || {}) as any, defaults.mcpExposeMediaPaths)
      return createToolSuccess(`Loaded ${payload.items.length} context messages.`, payload)
    } catch (error) {
      return createToolError(error)
    }
  })
}
