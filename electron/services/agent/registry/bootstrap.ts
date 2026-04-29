import { mcpClientService } from '../../mcpClientService'
import { skillManagerService } from '../../skillManagerService'
import { createMcpToolsForServer } from './adapters/mcpToolAdapter'
import { createNativeSessionQATools } from './adapters/nativeToolAdapter'
import { createSkillTool } from './adapters/skillToolAdapter'
import { toolRegistry } from './toolRegistry'

let bootstrapped = false

export async function bootstrapAgentTools(): Promise<void> {
  if (bootstrapped) return
  bootstrapped = true

  for (const tool of createNativeSessionQATools()) {
    toolRegistry.upsert(tool)
  }

  for (const skill of skillManagerService.listSkills()) {
    toolRegistry.upsert(createSkillTool(skill, skillManagerService))
  }

  for (const server of mcpClientService.listAllServerStatuses()) {
    if (server.status !== 'connected') continue
    const tools = await createMcpToolsForServer(server.name)
    for (const tool of tools) toolRegistry.upsert(tool)
  }
}

export async function refreshMcpTools(serverName: string): Promise<void> {
  toolRegistry.unregisterBy((tool) => tool.source === 'mcp' && tool.serverName === serverName)
  if (mcpClientService.getServerStatus(serverName) !== 'connected') return
  const tools = await createMcpToolsForServer(serverName)
  for (const tool of tools) toolRegistry.upsert(tool)
}
