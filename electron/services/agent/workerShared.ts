/**
 * Worker 线程共用工具函数，供 summaryWorker / sessionQaWorker 共享。
 * 仅在 Worker 线程内使用，不依赖 electron 主进程模块。
 */
import { parentPort } from 'worker_threads'
import { aiService } from '../ai/aiService'

// ─── Worker 事件通信 ───

export type WorkerEventKind = 'progress' | 'chunk' | 'final' | 'error'

export interface WorkerEventEnvelope {
  requestId: string
  seq: number
  createdAt: number
  kind: WorkerEventKind
  progress?: any
  chunk?: string
  result?: any
  error?: string
}

export function createWorkerMessenger(requestId: string) {
  let seq = 0
  const startedAt = Date.now()

  function post(event: Omit<WorkerEventEnvelope, 'requestId' | 'seq' | 'createdAt'>) {
    parentPort?.postMessage({
      requestId,
      seq: ++seq,
      createdAt: Date.now(),
      ...event
    } satisfies WorkerEventEnvelope)
  }

  function postProgress(progress: Record<string, any>) {
    post({
      kind: 'progress',
      progress: {
        ...progress,
        requestId,
        createdAt: Date.now(),
        elapsedMs: Date.now() - startedAt
      }
    })
  }

  function postChunk(chunk: string) {
    post({ kind: 'chunk', chunk })
  }

  function postFinal(result: any) {
    post({ kind: 'final', result })
  }

  function postError(error: string) {
    post({ kind: 'error', error })
  }

  return { post, postProgress, postChunk, postFinal, postError }
}

export type WorkerMessenger = ReturnType<typeof createWorkerMessenger>

// ─── runAgent 事件迭代 ───

import type { AgentEvent } from './types'

export interface AgentEventLoopHandlers {
  onThought?: (content: string, turn: number) => void
  onToolCall?: (toolCallId: string, name: string, args: Record<string, unknown>, turn: number) => void
  onToolResult?: (toolCallId: string, name: string, result: any, toolId: string, turn: number) => void
  onText?: (content: string) => void
}

export async function consumeAgentEvents(
  agentIterable: AsyncIterable<AgentEvent>,
  handlers: AgentEventLoopHandlers
): Promise<{ tokenUsage?: { totalTokens?: number } }> {
  let doneTokenUsage: { totalTokens?: number } | undefined

  for await (const event of agentIterable) {
    if (event.type === 'thought') {
      handlers.onThought?.(event.content, event.turn)
    } else if (event.type === 'tool_call') {
      handlers.onToolCall?.(event.toolCallId, event.name, event.args, event.turn)
    } else if (event.type === 'tool_result') {
      handlers.onToolResult?.(event.toolCallId, event.name, event.result, event.toolId, event.turn)
    } else if (event.type === 'text') {
      handlers.onText?.(event.content)
    } else if (event.type === 'error') {
      throw new Error(event.message)
    } else if (event.type === 'done') {
      doneTokenUsage = event.tokenUsage
    }
  }

  return { tokenUsage: doneTokenUsage }
}

// ─── Token / Cost 计算 ───

export function estimateTokenUsage(
  doneTokenUsage: { totalTokens?: number } | undefined,
  promptText: string,
  outputText: string
): number {
  return Number(doneTokenUsage?.totalTokens || aiService.estimateTokens(promptText + outputText))
}

export function calculateCost(tokensUsed: number, pricePerK: number): number {
  return (tokensUsed / 1000) * pricePerK
}

// ─── 文本工具 ───

export function compactText(text: string, maxLength: number): string {
  if (!text) return ''
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}
