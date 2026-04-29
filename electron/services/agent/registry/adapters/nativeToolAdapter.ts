import { getNativeSessionQATools } from '../../../ai-agent/qa/nativeTools'
import { wrapNativeToolDefinition, type UnifiedTool } from '../unifiedTool'

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
