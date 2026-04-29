import type { SkillInfo, SkillManagerService } from '../../../skillManagerService'
import { createToolId, toOpenAITool, type UnifiedTool } from '../unifiedTool'

export function createSkillTool(skill: SkillInfo, skillManager: SkillManagerService): UnifiedTool {
  const name = `skill_${skill.name}`.replace(/[^a-zA-Z0-9_-]/g, '_')
  return {
    id: createToolId('skill', skill.name),
    name,
    description: skill.description || `Run skill ${skill.name}`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: { type: 'string', description: 'User input or task for the skill.' }
      },
      required: ['input']
    },
    source: 'skill',
    sourceLabel: skill.builtin ? 'Built-in Skills' : 'User Skills',
    async execute(args, context) {
      const content = skillManager.readSkillContent(skill.name)
      if (!content.success || !content.content) {
        throw new Error(content.error || `Skill "${skill.name}" not found`)
      }
      const input = String(args.input || context.userMessage || '')
      const prompt = `${content.content}\n\nUser input:\n${input}`.trim()
      if (!context.provider) {
        return { ok: true, content: prompt, data: { prompt } }
      }
      const response = await context.provider.chat([
        { role: 'user', content: prompt }
      ], {
        model: context.model,
        temperature: context.agent.temperature,
        maxTokens: context.agent.maxTokens,
        enableThinking: false
      })
      return { ok: true, content: response }
    },
    toOpenAITool() {
      return toOpenAITool(this)
    },
    isAvailable() {
      return true
    }
  }
}
