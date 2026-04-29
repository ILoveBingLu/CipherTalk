import { mcpClientService } from '../../mcpClientService'
import { skillManagerService } from '../../skillManagerService'
import { createMcpToolsForServer } from './adapters/mcpToolAdapter'
import { createNativeSessionQATools, createNativeUtilityTools } from './adapters/nativeToolAdapter'
import { createSkillTool } from './adapters/skillToolAdapter'
import { toolRegistry } from './toolRegistry'

let bootstrapped = false

export async function bootstrapAgentTools(): Promise<void> {
  if (bootstrapped) return
  bootstrapped = true

  for (const tool of createNativeUtilityTools()) {
    toolRegistry.upsert(tool)
  }

  for (const tool of createNativeSessionQATools()) {
    toolRegistry.upsert(tool)
  }

  refreshSkillTools()

  for (const server of mcpClientService.listAllServerStatuses()) {
    if (server.status !== 'connected') continue
    const tools = await createMcpToolsForServer(server.name)
    for (const tool of tools) toolRegistry.upsert(tool)
  }
}

export async function refreshMcpTools(serverName: string): Promise<void> {
  toolRegistry.unregisterBy((tool) => tool.source === 'mcp' && tool.serverName === serverName)
  if (!mcpClientService.hasClientConfig(serverName) || mcpClientService.getServerStatus(serverName) !== 'connected') return
  const tools = await createMcpToolsForServer(serverName)
  for (const tool of tools) toolRegistry.upsert(tool)
}

export function refreshSkillTools(): void {
  const skills = skillManagerService.listSkills()
  const currentSkillToolIds = new Set(skills.map((skill) => `skill:${skill.name}`.replace(/\s+/g, '_')))
  toolRegistry.unregisterBy((tool) => tool.source === 'skill' && !currentSkillToolIds.has(tool.id))
  for (const skill of skills) {
    toolRegistry.upsert(createSkillTool(skill, skillManagerService))
  }
}
