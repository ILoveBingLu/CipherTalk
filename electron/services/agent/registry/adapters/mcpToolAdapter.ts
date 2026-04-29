import type { McpToolInfo } from '../../../mcpClientService'
import { mcpClientService } from '../../../mcpClientService'
import { createToolId, toOpenAITool, type UnifiedTool } from '../unifiedTool'

export function createMcpTool(serverName: string, tool: McpToolInfo): UnifiedTool {
  return {
    id: createToolId('mcp', tool.name, serverName),
    name: `${serverName}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
    description: tool.description || `MCP tool ${tool.name} from ${serverName}`,
    parameters: (tool.inputSchema || { type: 'object', properties: {} }) as Record<string, unknown>,
    source: 'mcp',
    sourceLabel: serverName,
    serverName,
    async execute(args) {
      if (!this.isAvailable()) {
        throw new Error(`MCP server "${serverName}" is unavailable`)
      }
      const result = await mcpClientService.callTool(serverName, tool.name, args)
      if (!result.success) {
        throw new Error(result.error || `MCP tool "${tool.name}" failed`)
      }
      return {
        ok: true,
        content: typeof result.result === 'string' ? result.result : JSON.stringify(result.result),
        data: result.result
      }
    },
    toOpenAITool() {
      return toOpenAITool(this)
    },
    isAvailable() {
      return mcpClientService.getServerStatus(serverName) === 'connected'
    }
  }
}

export async function createMcpToolsForServer(serverName: string): Promise<UnifiedTool[]> {
  const result = await mcpClientService.listToolsFromServer(serverName)
  if (!result.success || !result.tools) return []
  return result.tools.map((tool) => createMcpTool(serverName, tool))
}
