import { app, type WebContents } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import type {
  SessionQAJobEvent,
  SessionQAProgressEvent,
  SessionQACancelResult,
  SessionQAStartResult
} from '../../../src/types/ai'
import type { SessionQAOptions } from './aiService'
import { dataManagementService } from '../dataManagementService'
import { aiService } from './aiService'
import { getElectronWorkerEnv } from '../workerEnvironment'

type SessionQAJob = {
  requestId: string
  conversationId: number
  worker: Worker
  sender: WebContents
  seq: number
  assistantContent: string
  assistantThinkContent: string
  assistantIsThinking: boolean
  progressEvents: SessionQAProgressEvent[]
  options: Omit<SessionQAStartOptions, 'requestId'>
}

type SessionQAStartOptions = SessionQAOptions & {
  requestId?: string
}

function createRequestId(): string {
  return `qa-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function upsertProgressEvent(
  events: SessionQAProgressEvent[],
  event: SessionQAProgressEvent
): SessionQAProgressEvent[] {
  const index = events.findIndex((item) => item.id === event.id)
  if (index < 0) return [...events, event]

  return events.map((item, itemIndex) => itemIndex === index
    ? { ...event, createdAt: item.createdAt || event.createdAt }
    : item
  )
}

class SessionQAJobService {
  private jobs = new Map<string, SessionQAJob>()
  private vectorWarmupJobs = new Map<string, Worker>()

  start(options: SessionQAStartOptions, sender: WebContents): SessionQAStartResult {
    const requestId = options.requestId?.trim() || createRequestId()
    if (this.jobs.has(requestId)) {
      return { success: false, requestId, error: '相同 requestId 的问答任务已存在' }
    }

    const workerPath = this.findWorkerPath()
    if (!workerPath) {
      return { success: false, requestId, error: '未找到 sessionQaWorker.js' }
    }

    const { requestId: _ignored, ...workerOptions } = options
    const conversation = this.resolveConversation(workerOptions)
    if (!conversation.success) {
      return { success: false, requestId, error: conversation.error }
    }
    workerOptions.conversationId = conversation.conversationId
    aiService.saveSessionQAMessage({
      conversationId: conversation.conversationId,
      role: 'user',
      content: workerOptions.question,
      provider: workerOptions.provider,
      model: workerOptions.model,
      requestId,
      createdAt: Date.now()
    })

    const worker = new Worker(workerPath, {
      env: getElectronWorkerEnv(),
      workerData: {
        requestId,
        options: workerOptions
      }
    })

    const job: SessionQAJob = {
      requestId,
      conversationId: conversation.conversationId,
      worker,
      sender,
      seq: 0,
      assistantContent: '',
      assistantThinkContent: '',
      assistantIsThinking: false,
      progressEvents: [],
      options: workerOptions
    }
    this.jobs.set(requestId, job)
    dataManagementService.pauseForAi()
    this.warmupVectorIndex(workerOptions.sessionId)

    worker.on('message', (message) => {
      this.forwardEvent(requestId, message as Partial<SessionQAJobEvent>)
    })

    worker.on('error', (error) => {
      this.forwardEvent(requestId, {
        kind: 'error',
        error: String(error)
      })
      this.jobs.delete(requestId)
    })

    worker.on('exit', (code) => {
      dataManagementService.resumeFromAi()
      const current = this.jobs.get(requestId)
      if (!current) return
      if (code !== 0) {
        this.forwardEvent(requestId, {
          kind: 'error',
          error: `问答任务异常退出，代码：${code}`
        })
      }
      this.jobs.delete(requestId)
    })

    this.notifyConversationUpdated(job)

    return { success: true, requestId, conversationId: conversation.conversationId }
  }

  async cancel(requestId: string): Promise<SessionQACancelResult> {
    const job = this.jobs.get(requestId)
    if (!job) {
      return { success: false, requestId, error: '问答任务不存在或已结束' }
    }

    this.jobs.delete(requestId)
    await job.worker.terminate()
    this.persistAssistantMessage(job, {
      kind: 'cancelled',
      error: '已取消回答。'
    })
    this.send(job, {
      requestId,
      seq: ++job.seq,
      kind: 'cancelled',
      createdAt: Date.now()
    })
    this.notifyConversationUpdated(job)
    return { success: true, requestId }
  }

  private forwardEvent(requestId: string, event: Partial<SessionQAJobEvent>) {
    const job = this.jobs.get(requestId)
    if (!job) return

    if (event.kind === 'chunk' && event.chunk) {
      this.appendAssistantChunk(job, event.chunk)
    }

    if (event.kind === 'progress' && event.progress) {
      job.progressEvents = upsertProgressEvent(job.progressEvents, event.progress)
    }

    const nextEvent: SessionQAJobEvent = {
      requestId,
      seq: typeof event.seq === 'number' ? event.seq : ++job.seq,
      kind: event.kind || 'error',
      createdAt: typeof event.createdAt === 'number' ? event.createdAt : Date.now(),
      progress: event.progress,
      chunk: event.chunk,
      result: event.result,
      error: event.error
    }

    this.send(job, nextEvent)
    if (nextEvent.kind === 'final' || nextEvent.kind === 'error' || nextEvent.kind === 'cancelled') {
      this.persistAssistantMessage(job, nextEvent)
      this.jobs.delete(requestId)
      void job.worker.terminate().catch(() => undefined)
      this.notifyConversationUpdated(job)
      if (nextEvent.kind === 'final') {
        void this.generateConversationTitle(job)
      }
    }
  }

  private send(job: SessionQAJob, event: SessionQAJobEvent) {
    if (job.sender.isDestroyed()) return
    job.sender.send('ai:sessionQaEvent', event)
  }

  private resolveConversation(options: Omit<SessionQAStartOptions, 'requestId'>): { success: true; conversationId: number } | { success: false; error: string } {
    try {
      if (options.conversationId) {
        const existing = aiService.getSessionQAConversation(options.conversationId)
        if (existing && existing.sessionId === options.sessionId) {
          return { success: true, conversationId: existing.id }
        }
      }

      const created = aiService.createSessionQAConversation({
        sessionId: options.sessionId,
        sessionName: options.sessionName,
        provider: options.provider,
        model: options.model
      })
      return { success: true, conversationId: created.id }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  private appendAssistantChunk(job: SessionQAJob, chunk: string) {
    let remaining = chunk
    while (remaining.length > 0) {
      if (job.assistantIsThinking) {
        const closeIndex = remaining.indexOf('</think>')
        if (closeIndex < 0) {
          job.assistantThinkContent += remaining
          break
        }
        job.assistantThinkContent += remaining.slice(0, closeIndex)
        job.assistantIsThinking = false
        remaining = remaining.slice(closeIndex + '</think>'.length)
        continue
      }

      const openIndex = remaining.indexOf('<think>')
      if (openIndex < 0) {
        job.assistantContent += remaining
        break
      }
      job.assistantContent += remaining.slice(0, openIndex)
      job.assistantIsThinking = true
      remaining = remaining.slice(openIndex + '<think>'.length)
    }
  }

  private persistAssistantMessage(job: SessionQAJob, event: Partial<SessionQAJobEvent>) {
    try {
      const result = event.result
      const error = event.kind === 'error'
        ? event.error || '问答失败'
        : event.kind === 'cancelled'
          ? event.error || '已取消回答。'
          : undefined

      aiService.saveSessionQAMessage({
        conversationId: job.conversationId,
        role: 'assistant',
        content: result?.answerText || job.assistantContent,
        thinkContent: job.assistantThinkContent || undefined,
        error,
        result,
        evidenceRefs: result?.evidenceRefs,
        toolCalls: result?.toolCalls,
        progressEvents: job.progressEvents,
        tokensUsed: result?.tokensUsed,
        cost: result?.cost,
        provider: result?.provider || job.options.provider,
        model: result?.model || job.options.model,
        requestId: job.requestId,
        createdAt: result?.createdAt || Date.now()
      })
    } catch (error) {
      console.warn('[SessionQAJob] 保存问答消息失败:', error)
    }
  }

  private notifyConversationUpdated(job: SessionQAJob) {
    if (job.sender.isDestroyed()) return
    try {
      const conversation = aiService.getSessionQAConversation(job.conversationId)
      if (conversation) {
        job.sender.send('ai:sessionQaConversationUpdated', conversation)
      }
    } catch (error) {
      console.warn('[SessionQAJob] 推送问答会话更新失败:', error)
    }
  }

  private async generateConversationTitle(job: SessionQAJob) {
    try {
      await aiService.generateSessionQAConversationTitle({
        conversationId: job.conversationId,
        provider: job.options.provider,
        apiKey: job.options.apiKey,
        model: job.options.model
      })
      this.notifyConversationUpdated(job)
    } catch (error) {
      console.warn('[SessionQAJob] 生成问答会话标题失败:', error)
      this.notifyConversationUpdated(job)
    }
  }

  private findWorkerPath(): string | null {
    return this.findElectronWorkerPath('sessionQaWorker.js')
  }

  private warmupVectorIndex(sessionId: string) {
    if (!sessionId || this.vectorWarmupJobs.has(sessionId)) return

    const workerPath = this.findElectronWorkerPath('sessionVectorIndexWorker.js')
    if (!workerPath) return

    const worker = new Worker(workerPath, {
      env: getElectronWorkerEnv(),
      workerData: { sessionId }
    })
    this.vectorWarmupJobs.set(sessionId, worker)
    dataManagementService.pauseForAi()

    worker.on('message', (message: { type?: string; error?: string }) => {
      if (message?.type === 'error') {
        console.warn('[SessionQAJob] 后台语义向量增强失败:', message.error)
      }
      if (message?.type === 'completed' || message?.type === 'error') {
        void worker.terminate().catch(() => undefined)
      }
    })
    worker.on('error', (error) => {
      console.warn('[SessionQAJob] 后台语义向量增强 Worker 异常:', error)
      this.vectorWarmupJobs.delete(sessionId)
    })
    worker.on('exit', () => {
      dataManagementService.resumeFromAi()
      this.vectorWarmupJobs.delete(sessionId)
    })
  }

  private findElectronWorkerPath(fileName: string): string | null {
    const candidates = app.isPackaged
      ? [
          join(process.resourcesPath, 'app.asar', 'dist-electron', fileName),
          join(process.resourcesPath, 'app.asar.unpacked', 'dist-electron', fileName),
          join(process.resourcesPath, 'dist-electron', fileName),
          join(__dirname, fileName),
          join(__dirname, '..', '..', fileName),
          join(__dirname, '..', fileName)
        ]
      : [
          join(__dirname, fileName),
          join(__dirname, '..', '..', fileName),
          join(__dirname, '..', fileName),
          join(app.getAppPath(), 'dist-electron', fileName)
        ]

    return candidates.find((candidate) => existsSync(candidate)) || null
  }
}

export const sessionQAJobService = new SessionQAJobService()
