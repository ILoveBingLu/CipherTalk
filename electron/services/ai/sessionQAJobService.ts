import type { WebContents } from 'electron'
import { Worker } from 'worker_threads'
import type {
  SessionQAJobEvent,
  SessionQAProgressEvent,
  SessionQACancelResult,
  SessionQAStartResult,
  SessionQATimelineItem
} from '../../../src/types/ai'
import type { SessionQAOptions } from './aiService'
import { dataManagementService } from '../dataManagementService'
import { aiService } from './aiService'
import { getElectronWorkerEnv } from '../workerEnvironment'
import { BaseJobService, findElectronWorkerPath, createRequestId, type BaseJob } from './baseJobService'

type SessionQAJob = Omit<BaseJob, 'options'> & {
  conversationId: number
  assistantContent: string
  assistantThinkContent: string
  assistantIsThinking: boolean
  progressEvents: SessionQAProgressEvent[]
  timelineEvents: SessionQATimelineItem[]
  timelineItemSeq: number
  options: Omit<SessionQAStartOptions, 'requestId'>
}

type SessionQAStartOptions = SessionQAOptions & {
  requestId?: string
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

function sortTimelineEvents(items: SessionQATimelineItem[]): SessionQATimelineItem[] {
  return [...items].sort((a, b) =>
    a.order - b.order
    || a.createdAt - b.createdAt
    || a.id.localeCompare(b.id)
  )
}

class SessionQAJobService extends BaseJobService<SessionQAJob> {
  private vectorWarmupJobs = new Map<string, Worker>()

  start(options: SessionQAStartOptions, sender: WebContents): SessionQAStartResult {
    const requestId = options.requestId?.trim() || createRequestId('qa')
    if (this.findJob(requestId)) {
      return { success: false, requestId, error: '相同 requestId 的问答任务已存在' }
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

    const result = this.createWorker('sessionQaWorker.js', {
      requestId,
      options: workerOptions
    }, (job, reason) => {
      this.forwardEvent(job.requestId, {
        kind: 'error',
        error: reason
      })
    })
    if (!result) {
      return { success: false, requestId, error: '未找到 sessionQaWorker.js' }
    }

    const job: SessionQAJob = {
      requestId,
      conversationId: conversation.conversationId,
      worker: result.worker,
      sender,
      seq: 0,
      assistantContent: '',
      assistantThinkContent: '',
      assistantIsThinking: false,
      progressEvents: [],
      timelineEvents: [],
      timelineItemSeq: 0,
      options: workerOptions
    }
    this.jobs.set(requestId, job)
    dataManagementService.pauseForAi()
    this.warmupVectorIndex(workerOptions.sessionId)

    result.worker.on('message', (message) => {
      this.forwardEvent(requestId, message as Partial<SessionQAJobEvent>)
    })

    this.notifyConversationUpdated(job)
    this.forwardEvent(requestId, {
      kind: 'progress',
      progress: {
        id: 'job-start',
        stage: 'intent',
        status: 'completed',
        title: '启动问答任务',
        displayName: '启动问答任务',
        nodeName: '启动问答任务',
        detail: '任务已创建，正在进入问答流程',
        source: 'model',
        requestId,
        createdAt: Date.now()
      }
    })

    return { success: true, requestId, conversationId: conversation.conversationId }
  }

  async cancel(requestId: string): Promise<SessionQACancelResult> {
    const job = this.findJob(requestId)
    if (!job) {
      return { success: false, requestId, error: '问答任务不存在或已结束' }
    }

    const createdAt = Date.now()
    const progress: SessionQAProgressEvent = {
      id: 'job-cancelled',
      stage: 'answer',
      status: 'failed',
      title: '已取消回答',
      displayName: '已取消回答',
      nodeName: '已取消回答',
      detail: '用户已取消本次问答',
      source: 'model',
      requestId,
      createdAt
    }
    job.progressEvents = upsertProgressEvent(job.progressEvents, progress)
    const timelineItem = this.upsertTimelineProgress(job, progress, ++job.seq, createdAt)
    this.removeJob(requestId)
    await job.worker.terminate()
    this.persistAssistantMessage(job, {
      kind: 'cancelled',
      error: '已取消回答。'
    })
    this.send(job, {
      requestId,
      seq: ++job.seq,
      kind: 'cancelled',
      createdAt,
      progress,
      timelineItems: [timelineItem]
    })
    this.notifyConversationUpdated(job)
    return { success: true, requestId }
  }

  private forwardEvent(requestId: string, event: Partial<SessionQAJobEvent>) {
    const job = this.findJob(requestId)
    if (!job) return

    const nextSeq = ++job.seq
    const nextCreatedAt = typeof event.createdAt === 'number' ? event.createdAt : Date.now()
    const kind = event.kind || 'error'
    const timelineItems: SessionQATimelineItem[] = []
    let nextProgress = event.progress

    if (event.kind === 'chunk' && event.chunk) {
      timelineItems.push(...this.appendAssistantChunk(job, event.chunk, nextSeq, nextCreatedAt))
    }

    if (event.kind === 'progress' && event.progress) {
      const progress = {
        ...event.progress,
        requestId: event.progress.requestId || requestId,
        createdAt: event.progress.createdAt || nextCreatedAt
      }
      nextProgress = progress
      job.progressEvents = upsertProgressEvent(job.progressEvents, progress)
      timelineItems.push(this.upsertTimelineProgress(job, progress, nextSeq, nextCreatedAt))
    }

    if (event.kind === 'error' && !event.progress) {
      const progress: SessionQAProgressEvent = {
        id: 'job-error',
        stage: 'answer',
        status: 'failed',
        title: '问答失败',
        displayName: '问答失败',
        nodeName: '问答失败',
        detail: event.error || '问答失败',
        source: 'model',
        requestId,
        createdAt: nextCreatedAt
      }
      nextProgress = progress
      job.progressEvents = upsertProgressEvent(job.progressEvents, progress)
      timelineItems.push(this.upsertTimelineProgress(job, progress, nextSeq, nextCreatedAt))
    }

    const nextEvent: SessionQAJobEvent = {
      requestId,
      seq: nextSeq,
      kind,
      createdAt: nextCreatedAt,
      progress: nextProgress,
      timelineItems: timelineItems.length ? timelineItems : event.timelineItems,
      chunk: event.chunk,
      result: event.result,
      error: event.error
    }

    this.send(job, nextEvent)
    if (nextEvent.kind === 'final' || nextEvent.kind === 'error' || nextEvent.kind === 'cancelled') {
      this.persistAssistantMessage(job, nextEvent)
      this.removeJob(requestId)
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

  private appendAssistantChunk(
    job: SessionQAJob,
    chunk: string,
    order: number,
    createdAt: number
  ): SessionQATimelineItem[] {
    let remaining = chunk
    const changed = new Map<string, SessionQATimelineItem>()

    const appendText = (channel: 'answer' | 'think', content: string) => {
      if (!content) return

      if (channel === 'think') {
        job.assistantThinkContent += content
      } else {
        job.assistantContent += content
      }

      const lastItem = job.timelineEvents[job.timelineEvents.length - 1]
      if (lastItem?.type === 'text' && lastItem.channel === channel) {
        lastItem.content += content
        changed.set(lastItem.id, lastItem)
        return
      }

      const item: SessionQATimelineItem = {
        type: 'text',
        id: `text:${++job.timelineItemSeq}`,
        order: order + (job.timelineItemSeq / 1_000_000),
        createdAt,
        requestId: job.requestId,
        channel,
        content
      }
      job.timelineEvents.push(item)
      changed.set(item.id, item)
    }

    while (remaining.length > 0) {
      if (job.assistantIsThinking) {
        const closeIndex = remaining.indexOf('</think')
        if (closeIndex < 0) {
          appendText('think', remaining)
          break
        }
        appendText('think', remaining.slice(0, closeIndex))
        job.assistantIsThinking = false
        remaining = remaining.slice(closeIndex + '</think'.length)
        continue
      }

      const openIndex = remaining.indexOf('<think')
      if (openIndex < 0) {
        appendText('answer', remaining)
        break
      }
      appendText('answer', remaining.slice(0, openIndex))
      job.assistantIsThinking = true
      remaining = remaining.slice(openIndex + '<think'.length)
    }

    return Array.from(changed.values())
  }

  private upsertTimelineProgress(
    job: SessionQAJob,
    progress: SessionQAProgressEvent,
    order: number,
    createdAt: number
  ): SessionQATimelineItem {
    const id = `progress:${progress.id}`
    const index = job.timelineEvents.findIndex((item) => item.id === id)
    if (index >= 0) {
      const existing = job.timelineEvents[index] as SessionQATimelineItem
      const item: SessionQATimelineItem = existing.type === 'progress'
        ? {
            ...existing,
            event: {
              ...progress,
              createdAt: existing.event.createdAt || progress.createdAt || createdAt
            }
          }
        : existing
      job.timelineEvents[index] = item
      return item
    }

    const lastTimelineItem = job.timelineEvents[job.timelineEvents.length - 1]
    const shouldAttachToolToThink = progress.stage === 'tool'
      && (
        job.assistantIsThinking
        || (lastTimelineItem?.type === 'text' && lastTimelineItem.channel === 'think')
      )

    const item: SessionQATimelineItem = {
      type: 'progress',
      id,
      order,
      createdAt,
      requestId: job.requestId,
      channel: shouldAttachToolToThink ? 'think' : 'answer',
      event: progress
    }
    job.timelineEvents.push(item)
    job.timelineEvents = sortTimelineEvents(job.timelineEvents)
    return item
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
        timelineEvents: job.timelineEvents,
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

  private warmupVectorIndex(sessionId: string) {
    if (!sessionId || this.vectorWarmupJobs.has(sessionId)) return

    const workerPath = findElectronWorkerPath('sessionVectorIndexWorker.js')
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

  protected removeJob(requestId: string): boolean {
    const removed = super.removeJob(requestId)
    if (removed) dataManagementService.resumeFromAi()
    return removed
  }
}

export const sessionQAJobService = new SessionQAJobService()
