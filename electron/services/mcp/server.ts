import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ConfigService } from '../config'
import {
  ApiQueryError,
  queryContacts,
  queryHealth,
  queryMessages,
  querySessions,
  queryStatus
} from '../httpApiFacade'

function formatToolResult(data: unknown, isError = false) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2)
      }
    ],
    structuredContent: (data && typeof data === 'object' ? data : { value: data }) as Record<string, unknown>,
    isError
  }
}

function formatToolError(error: unknown) {
  if (error instanceof ApiQueryError) {
    return formatToolResult(error.toResponse(), true)
  }

  return formatToolResult({
    code: 'INTERNAL_ERROR',
    message: String(error)
  }, true)
}

function getHttpRuntimeStatus() {
  const configService = new ConfigService()
  const enabled = Boolean(configService.get('httpApiEnabled'))
  const port = Number(configService.get('httpApiPort') || 5031)
  const token = String(configService.get('httpApiToken') || '')
  configService.close()

  return {
    enabled,
    running: enabled,
    host: '127.0.0.1',
    port,
    startedAt: Date.now(),
    token,
    startError: ''
  }
}

function getMcpDefaults() {
  const configService = new ConfigService()
  const mcpEnabled = Boolean(configService.get('mcpEnabled'))
  const mcpExposeMediaPaths = configService.get('mcpExposeMediaPaths') !== false
  configService.close()
  return { mcpEnabled, mcpExposeMediaPaths }
}

export function createCipherTalkMcpServer() {
  const server = new McpServer({
    name: 'ciphertalk-mcp',
    version: '1.0.0'
  })

  server.registerTool('health_check', {
    title: 'Health Check',
    description: 'Return the embedded CipherTalk service health status.'
  }, async () => {
    return formatToolResult(queryHealth())
  })

  server.registerTool('get_status', {
    title: 'Get Status',
    description: 'Return CipherTalk service and configuration status.',
    inputSchema: {
      verbose: z.boolean().optional().describe('Whether to include verbose debug and app details.')
    }
  }, async ({ verbose }) => {
    try {
      return formatToolResult(queryStatus(getHttpRuntimeStatus(), Boolean(verbose)))
    } catch (error) {
      return formatToolError(error)
    }
  })

  server.registerTool('list_sessions', {
    title: 'List Sessions',
    description: 'List chat sessions with pagination, filtering, and sorting.',
    inputSchema: {
      q: z.string().optional().describe('Search keyword.'),
      type: z.array(z.string()).optional().describe('Session types: friend, group, official, other.'),
      unreadOnly: z.boolean().optional().describe('Only include sessions with unread messages.'),
      sort: z.string().optional().describe('Sort mode.'),
      offset: z.number().int().nonnegative().optional().describe('Pagination offset.'),
      limit: z.number().int().positive().optional().describe('Pagination limit.')
    }
  }, async (args) => {
    try {
      return formatToolResult(await querySessions(args))
    } catch (error) {
      return formatToolError(error)
    }
  })

  server.registerTool('get_messages', {
    title: 'Get Messages',
    description: 'Query messages from a session with filtering, field selection, and optional media path resolution.',
    inputSchema: {
      sessionId: z.string().describe('Required session identifier / chat username.'),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
      sort: z.string().optional(),
      keyword: z.string().optional(),
      msgType: z.array(z.number().int()).optional(),
      messageKind: z.array(z.string()).optional(),
      appMsgType: z.array(z.string()).optional(),
      startTime: z.number().int().positive().optional().describe('Unix timestamp in seconds or milliseconds.'),
      endTime: z.number().int().positive().optional().describe('Unix timestamp in seconds or milliseconds.'),
      includeRaw: z.boolean().optional(),
      resolveMediaPath: z.boolean().optional(),
      resolveVoicePath: z.boolean().optional(),
      adaptive: z.boolean().optional(),
      maxScan: z.number().int().positive().optional(),
      fields: z.array(z.string()).optional().describe('Requested field groups.')
    }
  }, async (args) => {
    try {
      const defaults = getMcpDefaults()
      const resolveMediaPath = args.resolveMediaPath ?? defaults.mcpExposeMediaPaths
      return formatToolResult(await queryMessages({
        ...args,
        resolveMediaPath
      }))
    } catch (error) {
      return formatToolError(error)
    }
  })

  server.registerTool('list_contacts', {
    title: 'List Contacts',
    description: 'List contacts with pagination, filtering, and optional avatar fields.',
    inputSchema: {
      q: z.string().optional().describe('Search keyword.'),
      type: z.array(z.string()).optional().describe('Contact types: friend, group, official, former_friend, other.'),
      includeAvatar: z.boolean().optional(),
      sort: z.string().optional(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional()
    }
  }, async (args) => {
    try {
      return formatToolResult(await queryContacts(args))
    } catch (error) {
      return formatToolError(error)
    }
  })

  return server
}
