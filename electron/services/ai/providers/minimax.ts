import OpenAI from 'openai'
import { BaseAIProvider, ChatOptions } from './base'

/**
 * MiniMax 提供商元数据
 *
 * 2026-04-23 对齐官方 OpenAI 兼容文档：
 * - baseURL: https://api.minimaxi.com/v1
 * - reasoning_split=true 时，思考内容单独出现在 reasoning_details 字段
 */
export const MiniMaxMetadata = {
  id: 'minimax',
  name: 'minimax',
  displayName: 'MiniMax',
  description: 'MiniMax OpenAI 兼容文本模型',
  models: [
    'MiniMax-M2.7',
    'MiniMax-M2.7-highspeed',
    'MiniMax-M2.5',
    'MiniMax-M2.5-highspeed',
    'MiniMax-M2.1',
    'MiniMax-M2.1-highspeed',
    'MiniMax-M2'
  ],
  pricing: '¥0.0021/1K tokens 起（估算）',
  pricingDetail: {
    input: 0.0021,
    output: 0.0084
  },
  website: 'https://platform.minimaxi.com/',
  logo: './AI-logo/minimax.svg'
}

const THINK_OPEN_TAG = '<think>'
const THINK_CLOSE_TAG = '</think>'
const TAG_BUFFER_LENGTH = THINK_CLOSE_TAG.length

function extractIncrementalText(current: string, previous: string): string {
  if (!current) return ''
  if (!previous) return current
  return current.startsWith(previous) ? current.slice(previous.length) : current
}

/**
 * MiniMax 在 OpenAI 兼容接口中支持通过 reasoning_split=true
 * 将思考内容拆到 reasoning_details 字段中。
 */
export class MiniMaxProvider extends BaseAIProvider {
  name = MiniMaxMetadata.name
  displayName = MiniMaxMetadata.displayName
  models = MiniMaxMetadata.models
  pricing = MiniMaxMetadata.pricingDetail

  constructor(apiKey: string) {
    super(apiKey, 'https://api.minimaxi.com/v1')
  }

  async streamChat(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options: ChatOptions,
    onChunk: (chunk: string) => void
  ): Promise<void> {
    const client = await this.getClient()
    const enableThinking = options?.enableThinking !== false

    const requestParams: any = {
      model: options?.model || this.models[0],
      messages,
      temperature: options?.temperature || 0.7,
      stream: true,
      extra_body: {
        reasoning_split: true
      }
    }

    if (options?.maxTokens) {
      requestParams.max_tokens = options.maxTokens
    }

    const stream = await client.chat.completions.create(requestParams) as any

    let reasoningBuffer = ''
    let textBuffer = ''
    let isThinking = false
    let contentBuffer = ''

    const emitThinkOpen = () => {
      if (!enableThinking || isThinking) return
      onChunk(THINK_OPEN_TAG)
      isThinking = true
    }

    const emitThinkClose = () => {
      if (!isThinking) return
      if (enableThinking) {
        onChunk(THINK_CLOSE_TAG)
      }
      isThinking = false
    }

    const emitPlainText = (text: string) => {
      if (!text) return
      if (isThinking) {
        if (enableThinking) {
          onChunk(text)
        }
        return
      }
      onChunk(text)
    }

    const emitBufferedContent = (text: string) => {
      let remaining = text

      while (remaining.length > 0) {
        const openIndex = remaining.indexOf(THINK_OPEN_TAG)
        const closeIndex = remaining.indexOf(THINK_CLOSE_TAG)

        if (openIndex === -1 && closeIndex === -1) {
          emitPlainText(remaining)
          return
        }

        const nextIndex = [openIndex, closeIndex]
          .filter(index => index >= 0)
          .sort((a, b) => a - b)[0]

        if (nextIndex > 0) {
          emitPlainText(remaining.slice(0, nextIndex))
          remaining = remaining.slice(nextIndex)
          continue
        }

        if (remaining.startsWith(THINK_OPEN_TAG)) {
          emitThinkOpen()
          remaining = remaining.slice(THINK_OPEN_TAG.length)
          continue
        }

        if (remaining.startsWith(THINK_CLOSE_TAG)) {
          emitThinkClose()
          remaining = remaining.slice(THINK_CLOSE_TAG.length)
          continue
        }

        emitPlainText(remaining[0])
        remaining = remaining.slice(1)
      }
    }

    const flushContentBuffer = (force = false) => {
      if (!contentBuffer) return

      const flushLength = force
        ? contentBuffer.length
        : Math.max(0, contentBuffer.length - TAG_BUFFER_LENGTH)

      if (flushLength <= 0) return

      const flushChunk = contentBuffer.slice(0, flushLength)
      contentBuffer = contentBuffer.slice(flushLength)
      emitBufferedContent(flushChunk)
    }

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta
      if (!delta) continue

      const reasoningDetails = Array.isArray(delta.reasoning_details)
        ? delta.reasoning_details
        : []

      if (reasoningDetails.length > 0) {
        for (const detail of reasoningDetails) {
          const reasoningText = typeof detail?.text === 'string' ? detail.text : ''
          const newReasoning = extractIncrementalText(reasoningText, reasoningBuffer)
          reasoningBuffer = reasoningText || reasoningBuffer

          if (!newReasoning) continue

          emitThinkOpen()
          if (enableThinking) {
            onChunk(newReasoning)
          }
        }
      } else if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        const newReasoning = extractIncrementalText(delta.reasoning_content, reasoningBuffer)
        reasoningBuffer = delta.reasoning_content

        if (newReasoning) {
          emitThinkOpen()
          if (enableThinking) {
            onChunk(newReasoning)
          }
        }
      }

      if (typeof delta.content === 'string' && delta.content) {
        const newContent = extractIncrementalText(delta.content, textBuffer)
        textBuffer = delta.content

        if (newContent) {
          const hasThinkTags = newContent.includes(THINK_OPEN_TAG) || newContent.includes(THINK_CLOSE_TAG)
          if (isThinking && !hasThinkTags) {
            emitThinkClose()
          }

          contentBuffer += newContent
          flushContentBuffer(false)
        }
      }
    }

    flushContentBuffer(true)
    emitThinkClose()
  }
}
