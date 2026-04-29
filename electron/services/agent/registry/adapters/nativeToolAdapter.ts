import { getNativeSessionQATools } from '../../../ai-agent/qa/nativeTools'
import { wrapNativeToolDefinition, type UnifiedTool } from '../unifiedTool'

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required
  }
}

function getCurrentTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function readStringArg(args: Record<string, unknown>, key: string): string {
  return String(args[key] || '').trim()
}

export function createNativeUtilityTools(): UnifiedTool[] {
  return [
    wrapNativeToolDefinition({
      type: 'function',
      function: {
        name: 'get_current_time',
        description: '获取当前日期和时间。适合用户询问今天、现在、当前时间、日期、星期、时区，或需要基于当前时间理解相对日期时调用。',
        parameters: objectSchema({
          timeZone: {
            type: 'string',
            description: '可选 IANA 时区，例如 Asia/Shanghai、America/New_York。为空时使用系统当前时区。'
          },
          locale: {
            type: 'string',
            description: '可选语言区域，例如 zh-CN、en-US。为空时使用 zh-CN。'
          }
        })
      }
    }, async (args) => {
      const requestedTimeZone = readStringArg(args, 'timeZone')
      const timeZone = requestedTimeZone || getCurrentTimeZone()
      const locale = readStringArg(args, 'locale') || 'zh-CN'
      const now = new Date()
      let formatted = ''
      try {
        formatted = new Intl.DateTimeFormat(locale, {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          weekday: 'long',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
          timeZoneName: 'short'
        }).format(now)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          ok: false,
          content: `无法获取指定时区的当前时间：${message}`,
          error: 'invalid_time_zone_or_locale'
        }
      }

      return {
        ok: true,
        content: `当前时间：${formatted}\nISO：${now.toISOString()}\n时区：${timeZone}`,
        data: {
          iso: now.toISOString(),
          unixMs: now.getTime(),
          unixSeconds: Math.floor(now.getTime() / 1000),
          timeZone,
          locale,
          formatted
        }
      }
    }, { sourceLabel: 'CipherTalk' })
  ]
}

const SESSION_QA_NATIVE_TOOL_NAMES = new Set([
  'search_messages',
  'read_context',
  'read_latest',
  'read_by_time_range',
  'get_session_statistics',
  'get_keyword_statistics',
  'aggregate_messages',
  'resolve_participant',
  'read_summary_facts'
])

export function createNativeSessionQATools(): UnifiedTool[] {
  return getNativeSessionQATools()
    .filter((tool) => SESSION_QA_NATIVE_TOOL_NAMES.has(tool.function.name))
    .map((definition) => wrapNativeToolDefinition(definition, async (args, context) => {
      if (!context.nativeSessionQAToolExecutor) {
        return {
          ok: false,
          content: 'SessionQA native tool executor is not available for this agent run.',
          error: 'native_session_qa_executor_unavailable'
        }
      }
      return context.nativeSessionQAToolExecutor(definition.function.name, args)
    }, { sourceLabel: 'SessionQA' }))
}
