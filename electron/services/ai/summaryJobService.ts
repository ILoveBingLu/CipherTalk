import type { WebContents } from 'electron'
import type { SummaryResult, SessionQAProgressEvent } from '../../../src/types/ai'
import type { Contact, Message } from '../chatService'
import { aiDatabase, type SaveAnalysisArtifactsInput } from './aiDatabase'
import { memoryDatabase, hashMemoryContent } from '../memory/memoryDatabase'
import { memoryBuildService } from '../memory/memoryBuildService'
import { BaseJobService, createRequestId, parseThinkTags, type ThinkTagParseState, type BaseJob } from './baseJobService'

type SummaryJob = BaseJob & {
  summaryText: string
  thinkText: string
  isThinking: boolean
  progressEvents: SessionQAProgressEvent[]
  options: SummaryWorkflowStartOptions
}

export type SummaryWorkflowStartOptions = {
  sessionId: string
  sessionName?: string
  timeRangeDays: number
  timeRangeStart?: number
  timeRangeEnd?: number
  providerName: string
  apiKey?: string
  model?: string
  detail?: 'simple' | 'normal' | 'detailed'
  systemPromptPreset?: 'default' | 'decision-focus' | 'action-focus' | 'risk-focus' | 'custom'
  customSystemPrompt?: string
  customRequirement?: string
  enableThinking?: boolean
  inputMessageScopeNote?: string
  messages: Message[]
  contacts: Array<{ username: string; remark: string; nickName: string; alias: string }>
}

class SummaryJobService extends BaseJobService<SummaryJob> {
  start(options: SummaryWorkflowStartOptions, sender: WebContents): { success: boolean; requestId?: string; error?: string } {
    const requestId = createRequestId('summary')

    const { messages: _msgs, contacts: _contacts, ...workerOptions } = options
    const result = this.createWorker('summaryWorker.js', {
      requestId,
      options: workerOptions,
      messages: options.messages,
      contacts: options.contacts
    }, (job, reason) => {
      this.sendToRenderer(job, 'ai:summaryEvent', {
        requestId: job.requestId, seq: ++job.seq,
        createdAt: Date.now(), kind: 'error', error: reason
      })
    })
    if (!result) return { success: false, error: '未找到 summaryWorker.js' }

    const job: SummaryJob = {
      requestId,
      worker: result.worker,
      sender,
      seq: 0,
      summaryText: '',
      thinkText: '',
      isThinking: false,
      progressEvents: [],
      options
    }
    this.jobs.set(requestId, job)

    result.worker.on('message', (message) => {
      this.forwardEvent(requestId, message)
    })

    return { success: true, requestId }
  }

  async cancel(requestId: string): Promise<{ success: boolean; error?: string }> {
    const job = this.findJob(requestId)
    if (!job) return { success: false, error: '摘要任务不存在或已结束' }
    this.terminateJob(job)
    return { success: true }
  }

  private forwardEvent(requestId: string, event: any) {
    const job = this.findJob(requestId)
    if (!job) return

    const nextSeq = ++job.seq

    if (event.kind === 'chunk' && event.chunk) {
      const state: ThinkTagParseState = {
        content: job.summaryText,
        thinkContent: job.thinkText,
        isThinking: job.isThinking
      }
      const updated = parseThinkTags(state, event.chunk)
      job.summaryText = updated.content
      job.thinkText = updated.thinkContent
      job.isThinking = updated.isThinking

      this.sendToRenderer(job, 'ai:summaryChunk', event.chunk)
    }

    if (event.kind === 'progress' && event.progress) {
      job.progressEvents.push(event.progress)
    }

    this.sendToRenderer(job, 'ai:summaryEvent', {
      requestId,
      seq: nextSeq,
      createdAt: Date.now(),
      ...event
    })

    if (event.kind === 'final' && event.result) {
      this.persistSummaryResult(job, event.result)
      this.terminateJob(job)
    }

    if (event.kind === 'error') {
      this.terminateJob(job)
    }
  }

  private persistSummaryResult(job: SummaryJob, result: SummaryResult) {
    try {
      const summaryId = aiDatabase.saveSummary({
        sessionId: result.sessionId,
        timeRangeStart: result.timeRangeStart,
        timeRangeEnd: result.timeRangeEnd,
        timeRangeDays: result.timeRangeDays,
        messageCount: result.messageCount,
        summaryText: result.summaryText || job.summaryText,
        tokensUsed: result.tokensUsed,
        cost: result.cost,
        provider: result.provider,
        model: result.model,
        promptText: '',
        structuredResultJson: result.structuredAnalysis
          ? JSON.stringify(result.structuredAnalysis)
          : undefined,
        createdAt: result.createdAt
      })

      try {
        const artifactsPayload: SaveAnalysisArtifactsInput = {
          summaryId,
          sessionId: result.sessionId,
          timeRangeStart: result.timeRangeStart,
          timeRangeEnd: result.timeRangeEnd,
          timeRangeDays: result.timeRangeDays,
          rawMessageCount: result.messageCount,
          status: result.structuredAnalysis ? 'completed' : 'fallback_legacy',
          sourceKind: result.structuredAnalysis ? 'generate_summary' : 'generate_summary_legacy',
          evidenceResolved: false,
          blocksAvailable: !!result.structuredAnalysis,
          blockCount: result.blockCount ?? 0,
          provider: result.provider,
          model: result.model,
          createdAt: result.createdAt,
          updatedAt: result.createdAt
        }
        aiDatabase.saveAnalysisArtifacts(artifactsPayload)
      } catch (error) {
        console.warn('[SummaryJob] 分析产物写入失败:', error)
      }

      try {
        const title = `摘要 ${result.timeRangeDays > 0 ? `最近${result.timeRangeDays}天` : '全部消息'} ${result.timeRangeStart}-${result.timeRangeEnd}`
        const content = (result.summaryText || job.summaryText).slice(0, 8000)
        memoryDatabase.upsertMemoryItem({
          memoryUid: `timeline_summary:${result.sessionId}:${summaryId}`,
          sourceType: 'timeline_summary',
          sessionId: result.sessionId,
          contactId: result.sessionId.includes('@chatroom') ? null : result.sessionId,
          groupId: result.sessionId.includes('@chatroom') ? result.sessionId : null,
          title,
          content,
          contentHash: hashMemoryContent(title, content),
          tags: ['timeline_summary', `summary:${summaryId}`],
          importance: 0.7,
          confidence: 1,
          timeStart: result.timeRangeStart,
          timeEnd: result.timeRangeEnd,
          sourceRefs: []
        })
        void memoryBuildService.prepareSessionMemory(result.sessionId)
      } catch (error) {
        console.warn('[SummaryJob] 摘要记忆写入失败:', error)
      }

      aiDatabase.updateUsageStats(result.provider, result.model, result.tokensUsed, result.cost)
    } catch (error) {
      console.warn('[SummaryJob] 摘要结果持久化失败:', error)
    }
  }
}

export const summaryJobService = new SummaryJobService()
