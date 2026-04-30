import { mcpClientService } from '../../mcpClientService'
import { skillManagerService } from '../../skillManagerService'
import { workflowConfigStore } from '../config/workflowConfigStore'
import { workflowRegistry } from '../workflow/workflowRegistry'
import { createMcpToolsForServer } from './adapters/mcpToolAdapter'
import { createSkillTool } from './adapters/skillToolAdapter'
import { registerNativeAgentTools } from './nativeToolBootstrap'
import { toolRegistry } from './toolRegistry'

let bootstrapped = false

export async function bootstrapAgentTools(): Promise<void> {
  if (bootstrapped) return
  bootstrapped = true

  registerNativeAgentTools()

  refreshSkillTools()

  for (const server of mcpClientService.listAllServerStatuses()) {
    if (server.status !== 'connected') continue
    const tools = await createMcpToolsForServer(server.name)
    for (const tool of tools) toolRegistry.upsert(tool)
  }

  for (const workflow of workflowConfigStore.list()) {
    workflowRegistry.register(workflow, workflowRegistry.get(workflow.id)?.hooks || {})
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
