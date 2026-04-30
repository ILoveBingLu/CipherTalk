/**
 * AI JobService 基类，封装 Worker 生命周期管理、事件转发、think-tag 解析。
 * 供 SummaryJobService / SessionQAJobService 继承。
 */
import { app, type WebContents } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { getElectronWorkerEnv } from '../workerEnvironment'

// ─── Worker 路径解析 ───

export function findElectronWorkerPath(fileName: string): string | null {
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

// ─── Think-tag 解析 ───

export interface ThinkTagParseState {
  content: string
  thinkContent: string
  isThinking: boolean
}

export function parseThinkTags(state: ThinkTagParseState, chunk: string, contentKey: 'content' | 'summaryText' | 'assistantContent' = 'content'): ThinkTagParseState {
  let remaining = chunk
  const result = { ...state }

  while (remaining.length > 0) {
    if (result.isThinking) {
      const closeIndex = remaining.indexOf('</think')
      if (closeIndex < 0) {
        result.thinkContent += remaining
        break
      }
      result.thinkContent += remaining.slice(0, closeIndex)
      result.isThinking = false
      remaining = remaining.slice(closeIndex + '</think'.length)
      continue
    }
    const openIndex = remaining.indexOf('<think')
    if (openIndex < 0) {
      result.content += remaining
      break
    }
    result.content += remaining.slice(0, openIndex)
    result.isThinking = true
    remaining = remaining.slice(openIndex + '<think'.length)
  }

  return result
}

// ─── Request ID ───

export function createRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

// ─── Job 基类 ───

export interface BaseJob {
  requestId: string
  worker: Worker
  sender: WebContents
  seq: number
  options: any
}

export abstract class BaseJobService<TJob extends BaseJob> {
  protected jobs = new Map<string, TJob>()

  protected createWorker(
    workerFileName: string,
    workerData: Record<string, any>,
    onRequestAborted: (job: TJob, reason: string) => void
  ): { worker: Worker; workerPath: string } | null {
    const workerPath = findElectronWorkerPath(workerFileName)
    if (!workerPath) return null

    const worker = new Worker(workerPath, {
      env: getElectronWorkerEnv(),
      workerData
    })

    worker.on('error', (error) => {
      const job = this.findJob(workerData.requestId)
      if (job) {
        onRequestAborted(job, String(error))
        this.removeJob(job.requestId)
      }
    })

    worker.on('exit', (code) => {
      const job = this.findJob(workerData.requestId)
      if (!job) return
      if (code !== 0) {
        onRequestAborted(job, `任务异常退出，代码：${code}`)
      }
      this.removeJob(job.requestId)
    })

    return { worker, workerPath }
  }

  protected findJob(requestId: string): TJob | undefined {
    return this.jobs.get(requestId)
  }

  protected removeJob(requestId: string): boolean {
    return this.jobs.delete(requestId)
  }

  protected terminateJob(job: TJob): void {
    this.removeJob(job.requestId)
    void job.worker.terminate().catch(() => undefined)
  }

  protected sendToRenderer(job: TJob, channel: string, data: any): void {
    if (!job.sender.isDestroyed()) {
      job.sender.send(channel, data)
    }
  }

  abstract cancel(requestId: string): Promise<{ success: boolean; error?: string }>
}
