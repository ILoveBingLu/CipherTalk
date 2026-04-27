/**
 * 进度事件构建与发射
 */
import type {
  SessionQAAgentOptions,
  SessionQAProgressEvent,
  SessionQAProgressSource
} from './types'

/**
 * 推断进度事件来源
 */
function inferProgressSource(event: Omit<SessionQAProgressEvent, 'createdAt'>): SessionQAProgressSource {
  if (event.stage === 'answer') return 'model'
  if (event.stage === 'thought') return 'model'
  switch (event.toolName) {
    case 'read_summary_facts':
      return 'summary'
    case 'search_messages':
    case 'read_context':
      return 'search_index'
    case 'prepare_vector_index':
      return 'vector'
    case 'aggregate_messages':
    case 'get_session_statistics':
    case 'get_keyword_statistics':
      return 'aggregate'
    default:
      return 'chat'
  }
}

/**
 * 构建进度事件（自动填充 createdAt 和 source）
 */
export function buildProgressEvent(
  event: Omit<SessionQAProgressEvent, 'createdAt'>
): SessionQAProgressEvent {
  return {
    ...event,
    createdAt: Date.now(),
    source: event.source || inferProgressSource(event)
  }
}

/**
 * 发射进度事件
 */
export function emitProgress(
  options: Pick<SessionQAAgentOptions, 'onProgress'>,
  event: Omit<SessionQAProgressEvent, 'createdAt'>
) {
  options.onProgress?.(buildProgressEvent(event))
}
