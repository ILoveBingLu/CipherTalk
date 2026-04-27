import { ConfigService } from '../config'
import { aiDatabase, type SaveAnalysisArtifactsInput } from './aiDatabase'
import { ZhipuProvider, ZhipuMetadata } from './providers/zhipu'
import { DeepSeekProvider, DeepSeekMetadata } from './providers/deepseek'
import { QwenProvider, QwenMetadata } from './providers/qwen'
import { DoubaoProvider, DoubaoMetadata } from './providers/doubao'
import { KimiProvider, KimiMetadata } from './providers/kimi'
import { SiliconFlowProvider, SiliconFlowMetadata } from './providers/siliconflow'
import { XiaomiProvider, XiaomiMetadata } from './providers/xiaomi'
import { TencentProvider, TencentMetadata } from './providers/tencent'
import { XAIProvider, XAIMetadata } from './providers/xai'
import { OpenAIProvider, OpenAIMetadata } from './providers/openai'
import { MiniMaxProvider, MiniMaxMetadata } from './providers/minimax'
import { GeminiProvider, GeminiMetadata } from './providers/gemini'
import { OllamaProvider, OllamaMetadata } from './providers/ollama'
import { CustomProvider, CustomMetadata } from './providers/custom'
import { AIProvider } from './providers/base'
import type { Message, Contact } from '../chatService'
import {
  fallbackStructuredAnalysisWithoutEvidence,
  resolveStructuredAnalysisEvidence
} from '../ai-agent/analyzer/evidenceResolver'
import { extractFactsFromBlocks } from '../ai-agent/analyzer/factExtractor'
import {
  renderStandardizedMessages,
  sliceAnalysisBlocks,
  standardizeMessagesForAnalysis
} from '../ai-agent/analyzer/blockSlicer'
import { mergeStructuredAnalysisBlocks } from '../ai-agent/analyzer/resultMerger'
import {
  buildLegacySummaryUserPrompt,
  buildStructuredSummaryUserPrompt
} from '../ai-agent/analyzer/summaryRenderer'
import type {
  AnalysisBlock,
  ExtractedStructuredAnalysis,
  StructuredAnalysis
} from '../ai-agent/types/analysis'
import {
  answerSessionQuestionWithAgent,
  type SessionQAHistoryMessage,
  type SessionQAProgressEvent,
  type SessionQAToolCall
} from '../ai-agent/qa/sessionQaAgent'
import { hashMemoryContent, memoryDatabase } from '../memory/memoryDatabase'
import { memoryBuildService } from '../memory/memoryBuildService'
import { memoryProfileService } from '../memory/memoryProfileService'
import type { SessionProfileMemoryState } from '../memory/memoryProfileService'
import type { MemoryEvidenceRef, MemoryItem, MemoryItemInput, MemorySourceType } from '../memory/memorySchema'
import type {
  SessionQAConversationDetail,
  SessionQAConversationSummary
} from '../../../src/types/ai'

/**
 * 摘要选项
 */
export interface SummaryOptions {
  sessionId: string
  timeRangeDays: number  // 0 表示全部消息
  timeRangeStart?: number
  timeRangeEnd?: number
  provider?: string
  apiKey?: string
  model?: string
  language?: 'zh' | 'en'
  detail?: 'simple' | 'normal' | 'detailed'
  systemPromptPreset?: 'default' | 'decision-focus' | 'action-focus' | 'risk-focus' | 'custom'
  customSystemPrompt?: string
  customRequirement?: string  // 用户自定义要求
  sessionName?: string        // 会话名称
  enableThinking?: boolean    // 是否启用思考模式（推理模式）
  inputMessageScopeNote?: string
}

/**
 * 摘要结果
 */
export interface SummaryResult {
  id?: number
  sessionId: string
  timeRangeStart: number
  timeRangeEnd: number
  timeRangeDays: number
  messageCount: number
  summaryText: string
  tokensUsed: number
  cost: number
  provider: string
  model: string
  createdAt: number
  customName?: string
  structuredAnalysis?: StructuredAnalysis
}

export interface SessionQAOptions {
  conversationId?: number
  sessionId: string
  sessionName?: string
  question: string
  summaryText?: string
  structuredAnalysis?: StructuredAnalysis
  history?: SessionQAHistoryMessage[]
  provider?: string
  apiKey?: string
  model?: string
  enableThinking?: boolean
  agentDecisionMaxTokens?: number
  agentAnswerMaxTokens?: number
}

export interface SessionQAResult {
  sessionId: string
  question: string
  answerText: string
  evidenceRefs: Array<{
    sessionId: string
    localId: number
    createTime: number
    sortSeq: number
    senderUsername?: string
    senderDisplayName?: string
    previewText: string
  }>
  toolCalls: SessionQAToolCall[]
  tokensUsed: number
  cost: number
  provider: string
  model: string
  createdAt: number
}

export interface SessionProfileMemoryBuildOptions {
  sessionId: string
  sessionName?: string
  provider?: string
  apiKey?: string
  model?: string
}

export type SessionProfileMemoryBuildResult = SessionProfileMemoryState & {
  content: string
  provider: string
  model: string
  tokensUsed: number
  cost: number
}

interface StructuredAnalysisAttempt {
  blocks: AnalysisBlock[]
  blockAnalyses: ExtractedStructuredAnalysis[]
  mergedAnalysis: ExtractedStructuredAnalysis
  finalAnalysis: StructuredAnalysis
  blockCount: number
  effectiveMessageCount: number
  evidenceResolved: boolean
}

const SUMMARY_MEMORY_CONTEXT_LIMIT = 18
const SUMMARY_MEMORY_TEXT_LIMIT = 6000
const TIMELINE_SUMMARY_TEXT_LIMIT = 12000

function compactSummaryMemoryText(value: string, limit: number): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}

function overlapsSummaryRange(memory: MemoryItem, startTime: number, endTime: number): boolean {
  const memoryStart = Number(memory.timeStart || memory.timeEnd || 0)
  const memoryEnd = Number(memory.timeEnd || memory.timeStart || 0)
  if (!memoryStart && !memoryEnd) return true
  return memoryEnd >= startTime && memoryStart <= endTime
}

/**
 * AI 服务主类
 */
class AIService {
  private configService: ConfigService
  private initialized = false

  constructor() {
    this.configService = new ConfigService()
  }

  /**
   * 初始化服务
   */
  init(): void {
    if (this.initialized) return

    const cachePath = this.configService.get('cachePath')
    const wxid = this.configService.get('myWxid')

    if (!cachePath || !wxid) {
      throw new Error('配置未完成，无法初始化AI服务')
    }

    // 初始化数据库
    aiDatabase.init(cachePath, wxid)

    this.initialized = true
  }

  /**
   * 获取所有提供商元数据
   */
  getAllProviders() {
    return [
      OpenAIMetadata,
      MiniMaxMetadata,
      GeminiMetadata,
      XAIMetadata,
      DeepSeekMetadata,
      ZhipuMetadata,
      QwenMetadata,
      DoubaoMetadata,
      KimiMetadata,
      SiliconFlowMetadata,
      XiaomiMetadata,
      TencentMetadata,
      OllamaMetadata,
      CustomMetadata
    ]
  }

  /**
   * 获取提供商实例
   */
  private getProvider(providerName?: string, apiKey?: string): AIProvider {
    const name = providerName || this.configService.getAICurrentProvider() || 'zhipu'

    // 如果没有传入 apiKey，从配置中获取当前提供商的配置
    let key = apiKey
    if (!key) {
      const providerConfig = this.configService.getAIProviderConfig(name)
      key = providerConfig?.apiKey
    }

    // Ollama 本地服务不需要 API 密钥
    if (!key && name !== 'ollama') {
      throw new Error('未配置API密钥')
    }

    switch (name) {
      case 'custom':
        // 自定义服务必须提供 baseURL
        const customConfig = this.configService.getAIProviderConfig('custom')
        const customBaseURL = customConfig?.baseURL
        if (!customBaseURL) {
          throw new Error('自定义服务需要配置服务地址')
        }
        return new CustomProvider(key || '', customBaseURL)
      case 'ollama':
        // Ollama 支持自定义 baseURL
        const ollamaConfig = this.configService.getAIProviderConfig('ollama')
        const baseURL = ollamaConfig?.baseURL || 'http://localhost:11434/v1'
        return new OllamaProvider(key || 'ollama', baseURL)
      case 'openai':
        return new OpenAIProvider(key!)
      case 'minimax':
        return new MiniMaxProvider(key!)
      case 'gemini':
        return new GeminiProvider(key!)
      case 'zhipu':
        return new ZhipuProvider(key!)
      case 'deepseek':
        return new DeepSeekProvider(key!)
      case 'qwen':
        return new QwenProvider(key!)
      case 'doubao':
        return new DoubaoProvider(key!)
      case 'kimi':
        return new KimiProvider(key!)
      case 'siliconflow':
        return new SiliconFlowProvider(key!)
      case 'xiaomi':
        return new XiaomiProvider(key!)
      case 'tencent':
        return new TencentProvider(key!)
      case 'xai':
        return new XAIProvider(key!)
      default:
        throw new Error(`不支持的提供商: ${name}`)
    }
  }

  private normalizeGeneratedQATitle(value?: string): string {
    return String(value || '')
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/^[\s"'“”‘’「」『』《》【】\[\]()（）]+|[\s"'“”‘’「」『』《》【】\[\]()（）。.!！?？,，;；:：]+$/g, '')
      .replace(/\s+/g, '')
      .trim()
      .slice(0, 24)
  }

  private buildFallbackQATitle(question?: string): string {
    const normalized = this.normalizeGeneratedQATitle(question)
    if (!normalized) return '新对话'
    return normalized.length > 16 ? normalized.slice(0, 16) : normalized
  }

  /**
   * 获取系统提示词
   */
  private getSystemPrompt(
    language: string = 'zh',
    detail: string = 'normal',
    preset: 'default' | 'decision-focus' | 'action-focus' | 'risk-focus' | 'custom' = 'default',
    customSystemPrompt?: string
  ): string {
    const detailInstructions = {
      simple: '生成极简摘要，字数控制在 100 字以内。只保留最核心的事件和结论，忽略寒暄和琐碎细节。',
      normal: '生成内容适中的摘要。涵盖对话主要话题、关键信息点及明确的约定事项。',
      detailed: '生成详尽的深度分析。除了核心信息外，还需捕捉对话背景、各方态度倾向、潜在风险、具体细节以及所有隐含的待办事项。'
    }

    const detailName = {
      simple: '极致精简',
      normal: '标准平衡',
      detailed: '深度详尽'
    }

    const basePrompt = `### 角色定义
你是一位拥有 10 年经验的高级情报分析师和沟通专家，擅长从琐碎、碎片化的聊天记录中精准提取高价值信息。

### 任务描述
分析用户提供的微信聊天记录（包含时间、发送者及内容），并生成一份**${detailName[detail as keyof typeof detailName] || '标准'}**级别的分析摘要。

### 详细度要求
${detailInstructions[detail as keyof typeof detailInstructions] || detailInstructions.normal}

### 核心规范
1. **真实性**：严格基于提供的聊天文字，不得臆造事实或推测未提及的信息。
2. **客观性**：保持专业、中立的第三方视角。
3. **结构化**：使用清晰的 Markdown 标题和列表。
4. **去噪**：忽略表情包、拍一拍、撤回提示等无意义的干扰信息，专注于实质性内容。
5. **语言**：始终使用中文输出。

### 输出格式模板
## 📝 对话概览
[一句话总结本次对话的核心主题和氛围]

## 💡 核心要点
- [关键点A]：简述事情经过或核心论点。
- [关键点B]：相关的背景或补充说明。

## 🤝 达成共识/决策
- [决策1]：各方最终确认的具体事项。
- [决策2]：已达成的阶段性结论。

## 📅 待办与后续进展
- [ ] **待办事项**：具体负责人、截止日期（如有）及待执行动作。
- [ ] **跟进事项**：需要进一步明确或调研的问题。

---
*注：若对应部分无相关内容，请直接忽略该标题。*`

    const presetInstructionMap: Record<string, string> = {
      'default': '保持通用摘要风格，兼顾信息完整性与可读性。',
      'decision-focus': '重点提取所有决策、结论、拍板事项。若有意见分歧，请明确分歧点和最终取舍。',
      'action-focus': '重点提取可执行事项：负责人、截止时间、前置依赖、下一步动作。尽量转写为清单。',
      'risk-focus': '重点提取风险、阻塞、争议、潜在误解及其影响范围，并给出可执行的缓解建议。'
    }

    if (preset === 'custom') {
      const custom = (customSystemPrompt || '').trim()
      if (custom) {
        return `${basePrompt}\n\n### 用户自定义系统提示词\n${custom}`
      }
      return `${basePrompt}\n\n### 提示\n当前选择了自定义系统提示词，但内容为空。请按默认规则输出。`
    }

    const presetInstruction = presetInstructionMap[preset] || presetInstructionMap.default
    return `${basePrompt}\n\n### 风格偏好\n${presetInstruction}`
  }

  /**
   * 估算 tokens
   */
  estimateTokens(text: string): number {
    // 简单估算：中文约1.5字符=1token，英文约4字符=1token
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length
    const otherChars = text.length - chineseChars
    return Math.ceil(chineseChars / 1.5 + otherChars / 4)
  }

  /**
   * 估算成本
   */
  estimateCost(tokenCount: number, providerName: string): number {
    const provider = this.getProvider(providerName)
    return (tokenCount / 1000) * provider.pricing.input
  }

  /**
   * 生成缓存键
   */
  private getCacheKey(sessionId: string, timeRangeDays: number, endTime: number): string {
    // 按天对齐，避免时间差异导致缓存失效
    const dayAlignedEnd = Math.floor(endTime / 86400) * 86400
    return `${sessionId}_${timeRangeDays}d_${dayAlignedEnd}`
  }

  private buildTimeRangeLabel(timeRangeDays: number): string {
    return timeRangeDays > 0 ? `最近${timeRangeDays}天` : '全部消息'
  }

  private buildSummaryMemoryContext(sessionId: string, startTime: number, endTime: number): string {
    try {
      const sourceTypes: MemorySourceType[] = ['timeline_summary', 'conversation_block', 'fact']
      const items = sourceTypes.flatMap((sourceType) => memoryDatabase.listMemoryItems({
        sessionId,
        sourceType,
        limit: sourceType === 'fact' ? 80 : 40
      }))
        .filter((item) => overlapsSummaryRange(item, startTime, endTime))
        .sort((a, b) =>
          b.importance - a.importance
          || Number(b.timeEnd || b.timeStart || 0) - Number(a.timeEnd || a.timeStart || 0)
          || b.updatedAt - a.updatedAt
        )
        .slice(0, SUMMARY_MEMORY_CONTEXT_LIMIT)

      if (items.length === 0) return ''

      const lines = items.map((item, index) => {
        const time = item.timeStart || item.timeEnd
          ? `${item.timeStart || ''}${item.timeEnd && item.timeEnd !== item.timeStart ? `-${item.timeEnd}` : ''}`
          : 'unknown'
        const refs = item.sourceRefs.slice(0, 3)
          .map((ref) => `${ref.createTime}:${compactSummaryMemoryText(ref.excerpt || '', 80)}`)
          .filter(Boolean)
          .join('；')
        return [
          `${index + 1}. [${item.sourceType}] ${item.title || '无标题'} | time=${time} | importance=${item.importance}`,
          compactSummaryMemoryText(item.content, 360),
          refs ? `证据索引：${refs}` : ''
        ].filter(Boolean).join('\n')
      })

      return compactSummaryMemoryText([
        '以下为本地长期记忆中已存在的同会话时间线、对话块和事实，可用于避免重复分析、补足上下文和校对摘要结论。它们仍必须服从本次输入消息证据，不得据此臆造本次消息中不存在的细节。',
        ...lines
      ].join('\n\n'), SUMMARY_MEMORY_TEXT_LIMIT)
    } catch (error) {
      console.warn('[AIService] 读取摘要长期记忆上下文失败，继续使用原始摘要链路:', error)
      return ''
    }
  }

  private buildTimelineSummaryMemoryInput(input: {
    summaryId: number
    sessionId: string
    timeRangeStart: number
    timeRangeEnd: number
    timeRangeDays: number
    summaryText: string
    structuredAnalysis?: StructuredAnalysis
  }): MemoryItemInput {
    const title = `摘要 ${this.buildTimeRangeLabel(input.timeRangeDays)} ${input.timeRangeStart}-${input.timeRangeEnd}`
    const structured = input.structuredAnalysis
      ? `\n\n结构化事实：\n${JSON.stringify(input.structuredAnalysis)}`
      : ''
    const content = compactSummaryMemoryText(`${input.summaryText}${structured}`, TIMELINE_SUMMARY_TEXT_LIMIT)
    const evidenceRefs = this.collectSummaryEvidenceRefs(input.structuredAnalysis)

    return {
      memoryUid: `timeline_summary:${input.sessionId}:${input.summaryId}`,
      sourceType: 'timeline_summary',
      sessionId: input.sessionId,
      contactId: input.sessionId.includes('@chatroom') ? null : input.sessionId,
      groupId: input.sessionId.includes('@chatroom') ? input.sessionId : null,
      title,
      content,
      contentHash: hashMemoryContent(title, content),
      tags: ['timeline_summary', `summary:${input.summaryId}`, this.buildTimeRangeLabel(input.timeRangeDays)],
      importance: 0.7,
      confidence: 1,
      timeStart: input.timeRangeStart,
      timeEnd: input.timeRangeEnd,
      sourceRefs: evidenceRefs
    }
  }

  private collectSummaryEvidenceRefs(analysis?: StructuredAnalysis): MemoryEvidenceRef[] {
    if (!analysis) return []
    const refs: MemoryEvidenceRef[] = []
    for (const group of [analysis.decisions, analysis.todos, analysis.risks, analysis.events]) {
      for (const item of group || []) {
        for (const ref of item.evidenceRefs || []) {
          refs.push({
            sessionId: ref.sessionId,
            localId: ref.localId,
            createTime: ref.createTime,
            sortSeq: ref.sortSeq,
            ...(ref.senderUsername ? { senderUsername: ref.senderUsername } : {}),
            excerpt: compactSummaryMemoryText(ref.previewText || '', 160)
          })
        }
      }
    }

    const seen = new Set<string>()
    return refs.filter((ref) => {
      const key = `${ref.sessionId}:${ref.localId}:${ref.createTime}:${ref.sortSeq}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, 30)
  }

  private async refreshSummaryMemories(sessionId: string): Promise<void> {
    try {
      await memoryBuildService.prepareSessionMemory(sessionId)
    } catch (error) {
      console.warn('[AIService] 摘要后同步 memory_items 失败:', error)
    }
  }

  private async tryGenerateStructuredAnalysis(
    provider: AIProvider,
    model: string,
    blocks: AnalysisBlock[],
    standardizedMessages: ReturnType<typeof standardizeMessagesForAnalysis>,
    options: SummaryOptions
  ): Promise<StructuredAnalysisAttempt | null> {
    if (standardizedMessages.length === 0 || blocks.length === 0) {
      return null
    }

    try {
      const blockAnalyses = await extractFactsFromBlocks(blocks, provider, {
        model,
        sessionName: options.sessionName || options.sessionId,
        timeRangeLabel: this.buildTimeRangeLabel(options.timeRangeDays)
      })

      const mergedAnalysis = mergeStructuredAnalysisBlocks(blockAnalyses)
      let finalAnalysis: StructuredAnalysis
      let evidenceResolved = false

      try {
        finalAnalysis = resolveStructuredAnalysisEvidence(
          mergedAnalysis,
          standardizedMessages,
          options.sessionId
        )
        evidenceResolved = true
      } catch (error) {
        console.warn('[AIService] 证据解析失败，回退到无证据结构化摘要:', error)
        finalAnalysis = fallbackStructuredAnalysisWithoutEvidence(mergedAnalysis)
      }

      return {
        blocks,
        blockAnalyses,
        mergedAnalysis,
        finalAnalysis,
        blockCount: blocks.length,
        effectiveMessageCount: standardizedMessages.length,
        evidenceResolved
      }
    } catch (error) {
      console.warn('[AIService] 结构化抽取失败，回退到原始摘要链路:', error)
      return null
    }
  }

  /**
   * 生成摘要（流式）
   */
  async generateSummary(
    messages: Message[],
    contacts: Map<string, Contact>,
    options: SummaryOptions,
    onChunk: (chunk: string) => void
  ): Promise<SummaryResult> {
    if (!this.initialized) {
      this.init()
    }

    const endTime = Number.isFinite(options.timeRangeEnd) && Number(options.timeRangeEnd) > 0
      ? Math.floor(Number(options.timeRangeEnd))
      : Math.floor(Date.now() / 1000)
    const startTime = Number.isFinite(options.timeRangeStart) && Number(options.timeRangeStart) >= 0
      ? Math.floor(Number(options.timeRangeStart))
      : (options.timeRangeDays > 0
        ? endTime - (options.timeRangeDays * 24 * 60 * 60)
        : (messages[0]?.createTime || endTime))

    // 获取提供商
    const provider = this.getProvider(options.provider, options.apiKey)
    const model = options.model || provider.models[0]

    // 统一标准化消息，供结构化抽取和 legacy 回退共用。
    const standardizedMessages = standardizeMessagesForAnalysis(messages, contacts, options.sessionId)
    const analysisBlocks = sliceAnalysisBlocks(standardizedMessages)
    const formattedMessages = renderStandardizedMessages(standardizedMessages)

    // 构建提示词
    const presetFromConfig = (this.configService.get('aiSystemPromptPreset') as any) || 'default'
    const customSystemPromptFromConfig = (this.configService.get('aiCustomSystemPrompt') as string) || ''
    const systemPrompt = this.getSystemPrompt(
      options.language,
      options.detail,
      options.systemPromptPreset || presetFromConfig,
      options.customSystemPrompt ?? customSystemPromptFromConfig
    )

    // 使用会话名称优化提示词
    const targetName = options.sessionName || options.sessionId
    const timeRangeLabel = this.buildTimeRangeLabel(options.timeRangeDays)
    const memoryContext = this.buildSummaryMemoryContext(options.sessionId, startTime, endTime)
    const structuredAnalysisResult = await this.tryGenerateStructuredAnalysis(
      provider,
      model,
      analysisBlocks,
      standardizedMessages,
      options
    )

    const userPrompt = structuredAnalysisResult
      ? buildStructuredSummaryUserPrompt({
          targetName,
          timeRangeLabel,
          messageCount: messages.length,
          blockCount: structuredAnalysisResult.blockCount,
          analysis: structuredAnalysisResult.finalAnalysis,
          inputMessageScopeNote: options.inputMessageScopeNote,
          memoryContext,
          customRequirement: options.customRequirement
        })
      : buildLegacySummaryUserPrompt({
          targetName,
          timeRangeLabel,
          messageCount: messages.length,
          formattedMessages,
          inputMessageScopeNote: options.inputMessageScopeNote,
          memoryContext,
          customRequirement: options.customRequirement
        })

    if (structuredAnalysisResult) {
      console.log('[AIService] 结构化抽取完成:', {
        sessionId: options.sessionId,
        blockCount: structuredAnalysisResult.blockCount,
        messageCount: messages.length,
        effectiveMessageCount: standardizedMessages.length,
        evidenceResolved: structuredAnalysisResult.evidenceResolved
      })
    }

    // 流式生成
    let summaryText = ''

    await provider.streamChat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      {
        model,
        enableThinking: options.enableThinking !== false  // 默认启用，除非明确设置为 false
      },
      (chunk) => {
        summaryText += chunk
        onChunk(chunk)
      }
    )

    // 估算 tokens 和成本
    const totalText = systemPrompt + userPrompt + summaryText
    const tokensUsed = this.estimateTokens(totalText)
    const cost = (tokensUsed / 1000) * provider.pricing.input
    const createdAt = Date.now()

    // 保存到数据库
    const summaryId = aiDatabase.saveSummary({
      sessionId: options.sessionId,
      timeRangeStart: startTime,
      timeRangeEnd: endTime,
      timeRangeDays: options.timeRangeDays,
      messageCount: messages.length,
      summaryText: summaryText,
      tokensUsed: tokensUsed,
      cost: cost,
      provider: provider.name,
      model: model,
      promptText: userPrompt,
      structuredResultJson: structuredAnalysisResult
        ? JSON.stringify(structuredAnalysisResult.finalAnalysis)
        : undefined,
      createdAt
    })

    console.log('[AIService] 摘要已保存到数据库，ID:', summaryId)

    const analysisArtifactsPayload: SaveAnalysisArtifactsInput = {
      summaryId,
      sessionId: options.sessionId,
      timeRangeStart: startTime,
      timeRangeEnd: endTime,
      timeRangeDays: options.timeRangeDays,
      rawMessageCount: messages.length,
      effectiveMessageCount: standardizedMessages.length || undefined,
      blockCount: structuredAnalysisResult?.blockCount ?? analysisBlocks.length,
      provider: provider.name,
      model,
      status: structuredAnalysisResult ? 'completed' : 'fallback_legacy',
      sourceKind: structuredAnalysisResult ? 'generate_summary' : 'generate_summary_legacy',
      evidenceResolved: structuredAnalysisResult?.evidenceResolved ?? false,
      blocksAvailable: Boolean(structuredAnalysisResult?.blocks.length),
      blocks: structuredAnalysisResult?.blocks,
      blockAnalyses: structuredAnalysisResult?.blockAnalyses,
      finalAnalysis: structuredAnalysisResult?.finalAnalysis,
      createdAt,
      updatedAt: createdAt
    }

    try {
      aiDatabase.saveAnalysisArtifacts(analysisArtifactsPayload)
    } catch (error) {
      console.warn('[AIService] 分析产物写入失败，将由后续 catch-up 补录:', error)
    }

    try {
      memoryDatabase.upsertMemoryItem(this.buildTimelineSummaryMemoryInput({
        summaryId,
        sessionId: options.sessionId,
        timeRangeStart: startTime,
        timeRangeEnd: endTime,
        timeRangeDays: options.timeRangeDays,
        summaryText,
        structuredAnalysis: structuredAnalysisResult?.finalAnalysis
      }))
      void this.refreshSummaryMemories(options.sessionId)
    } catch (error) {
      console.warn('[AIService] 摘要记忆写入失败:', error)
    }

    // 更新使用统计
    aiDatabase.updateUsageStats(provider.name, model, tokensUsed, cost)

    return {
      id: summaryId,
      sessionId: options.sessionId,
      timeRangeStart: startTime,
      timeRangeEnd: endTime,
      timeRangeDays: options.timeRangeDays,
      messageCount: messages.length,
      summaryText: summaryText,
      tokensUsed: tokensUsed,
      cost: cost,
      provider: provider.name,
      model: model,
      createdAt,
      structuredAnalysis: structuredAnalysisResult?.finalAnalysis
    }
  }

  /**
   * 测试连接
   */
  async testConnection(providerName: string, apiKey: string): Promise<{ success: boolean; error?: string; needsProxy?: boolean }> {
    try {
      const provider = this.getProvider(providerName, apiKey)
      const result = await provider.testConnection()

      return result
    } catch (error) {
      return {
        success: false,
        error: `连接失败: ${String(error)}`,
        needsProxy: true
      }
    }
  }

  /**
   * 获取使用统计
   */
  getUsageStats(startDate?: string, endDate?: string): any {
    if (!this.initialized) {
      this.init()
    }

    const rawStats = aiDatabase.getUsageStats(startDate, endDate)

    // 聚合统计数据
    let totalCount = 0
    let totalTokens = 0
    let totalCost = 0

    for (const stat of rawStats) {
      totalCount += stat.request_count || 0
      totalTokens += stat.total_tokens || 0
      totalCost += stat.total_cost || 0
    }

    return {
      totalCount,
      totalTokens,
      totalCost,
      details: rawStats
    }
  }

  listSessionQAConversations(sessionId: string, limit?: number): SessionQAConversationSummary[] {
    if (!this.initialized) {
      this.init()
    }
    return aiDatabase.listSessionQAConversations(sessionId, limit)
  }

  getSessionQAConversation(conversationId: number): SessionQAConversationDetail | null {
    if (!this.initialized) {
      this.init()
    }
    return aiDatabase.getSessionQAConversation(conversationId)
  }

  createSessionQAConversation(input: {
    sessionId: string
    sessionName?: string
    linkedSummaryId?: number
    provider?: string
    model?: string
  }): SessionQAConversationSummary {
    if (!this.initialized) {
      this.init()
    }
    return aiDatabase.createSessionQAConversation(input)
  }

  renameSessionQAConversation(conversationId: number, title: string): boolean {
    if (!this.initialized) {
      this.init()
    }
    return aiDatabase.renameSessionQAConversation(conversationId, title)
  }

  deleteSessionQAConversation(conversationId: number): boolean {
    if (!this.initialized) {
      this.init()
    }
    return aiDatabase.deleteSessionQAConversation(conversationId)
  }

  saveSessionQAMessage(input: {
    conversationId: number
    role: 'user' | 'assistant'
    content: string
    thinkContent?: string
    error?: string
    result?: SessionQAResult
    evidenceRefs?: any[]
    toolCalls?: SessionQAToolCall[]
    progressEvents?: SessionQAProgressEvent[]
    tokensUsed?: number
    cost?: number
    provider?: string
    model?: string
    requestId?: string
    createdAt?: number
  }): number {
    if (!this.initialized) {
      this.init()
    }
    return aiDatabase.saveSessionQAMessage(input)
  }

  async generateSessionQAConversationTitle(options: {
    conversationId: number
    provider?: string
    apiKey?: string
    model?: string
  }): Promise<{ title: string; status: 'generated' | 'fallback' }> {
    if (!this.initialized) {
      this.init()
    }

    const conversation = aiDatabase.getSessionQAConversation(options.conversationId)
    if (!conversation || conversation.titleStatus === 'manual' || conversation.titleStatus === 'generated') {
      return { title: conversation?.title || '新对话', status: 'fallback' }
    }

    const firstUser = conversation.messages.find(message => message.role === 'user' && message.content.trim())
    const firstAssistant = conversation.messages.find(message => message.role === 'assistant' && message.content.trim() && !message.error)
    if (!firstUser || !firstAssistant) {
      const fallback = this.buildFallbackQATitle(firstUser?.content || conversation.title)
      aiDatabase.updateSessionQAConversationTitle(options.conversationId, fallback, 'fallback')
      return { title: fallback, status: 'fallback' }
    }

    try {
      const provider = this.getProvider(options.provider || conversation.provider, options.apiKey)
      const model = options.model || conversation.model || provider.models[0]
      const rawTitle = await provider.chat([
        {
          role: 'system',
          content: '你是聊天标题生成器。只输出一个中文短标题，8到16个汉字，不要引号，不要换行，不要解释，不要标点包装。'
        },
        {
          role: 'user',
          content: [
            '请根据下面这轮问答生成标题。',
            `用户问题：${firstUser.content.slice(0, 600)}`,
            `AI回答：${firstAssistant.content.slice(0, 900)}`
          ].join('\n')
        }
      ], {
        model,
        temperature: 0.2,
        maxTokens: 32,
        enableThinking: false
      })

      const title = this.normalizeGeneratedQATitle(rawTitle) || this.buildFallbackQATitle(firstUser.content)
      const status = title === this.buildFallbackQATitle(firstUser.content) && !this.normalizeGeneratedQATitle(rawTitle)
        ? 'fallback'
        : 'generated'
      aiDatabase.updateSessionQAConversationTitle(options.conversationId, title, status)
      return { title, status }
    } catch (error) {
      console.warn('[AI] 问答会话标题生成失败，使用兜底标题:', error)
      const fallback = this.buildFallbackQATitle(firstUser.content)
      aiDatabase.updateSessionQAConversationTitle(options.conversationId, fallback, 'fallback')
      return { title: fallback, status: 'fallback' }
    }
  }

  /**
   * 单会话 AI 问答（流式）
   */
  async answerSessionQuestion(
    options: SessionQAOptions,
    onChunk: (chunk: string) => void,
    onProgress?: (event: SessionQAProgressEvent) => void
  ): Promise<SessionQAResult> {
    if (!this.initialized) {
      this.init()
    }

    const question = String(options.question || '').trim()
    if (!question) {
      throw new Error('问题不能为空')
    }

    const provider = this.getProvider(options.provider, options.apiKey)
    const model = options.model || provider.models[0]
    const agentDecisionMaxTokens = Number(options.agentDecisionMaxTokens || this.configService.get('aiAgentDecisionMaxTokens') || 2048)
    const agentAnswerMaxTokens = Number(options.agentAnswerMaxTokens || this.configService.get('aiAgentAnswerMaxTokens') || 8192)

    const result = await answerSessionQuestionWithAgent({
      sessionId: options.sessionId,
      sessionName: options.sessionName,
      question,
      summaryText: options.summaryText,
      structuredAnalysis: options.structuredAnalysis,
      history: options.history,
      provider,
      model,
      enableThinking: options.enableThinking,
      agentDecisionMaxTokens,
      agentAnswerMaxTokens,
      onChunk,
      onProgress
    })

    const totalText = result.promptText + result.answerText
    const tokensUsed = this.estimateTokens(totalText)
    const cost = (tokensUsed / 1000) * provider.pricing.input
    const createdAt = Date.now()

    aiDatabase.updateUsageStats(provider.name, model, tokensUsed, cost)

    return {
      sessionId: options.sessionId,
      question,
      answerText: result.answerText,
      evidenceRefs: result.evidenceRefs,
      toolCalls: result.toolCalls,
      tokensUsed,
      cost,
      provider: provider.name,
      model,
      createdAt
    }
  }

  getSessionProfileMemoryState(sessionId: string): SessionProfileMemoryState {
    if (!this.initialized) {
      this.init()
    }
    return memoryProfileService.getSessionProfileState(sessionId)
  }

  async buildSessionProfileMemory(options: SessionProfileMemoryBuildOptions): Promise<SessionProfileMemoryBuildResult> {
    if (!this.initialized) {
      this.init()
    }

    const sessionId = String(options.sessionId || '').trim()
    if (!sessionId) {
      throw new Error('sessionId 不能为空')
    }

    const provider = this.getProvider(options.provider, options.apiKey)
    const model = options.model || provider.models[0]
    const result = await memoryProfileService.buildSessionProfileMemory({
      sessionId,
      sessionName: options.sessionName,
      provider,
      model
    })
    const tokensUsed = this.estimateTokens(result.content)
    const cost = (tokensUsed / 1000) * provider.pricing.input
    aiDatabase.updateUsageStats(provider.name, model, tokensUsed, cost)

    return {
      ...result,
      provider: provider.name,
      model,
      tokensUsed,
      cost
    }
  }

  /**
   * 获取摘要历史
   */
  getSummaryHistory(sessionId: string, limit: number = 10): SummaryResult[] {
    if (!this.initialized) {
      this.init()
    }
    return aiDatabase.getSummaryHistory(sessionId, limit)
  }

  /**
   * 删除摘要
   */
  deleteSummary(id: number): boolean {
    if (!this.initialized) {
      this.init()
    }
    return aiDatabase.deleteSummary(id)
  }

  /**
   * 重命名摘要
   */
  renameSummary(id: number, customName: string): boolean {
    if (!this.initialized) {
      this.init()
    }
    return aiDatabase.renameSummary(id, customName)
  }

  /**
   * 清理过期缓存
   */
  cleanExpiredCache(): void {
    if (!this.initialized) {
      this.init()
    }
    aiDatabase.cleanExpiredCache()
  }
}

// 导出单例
export const aiService = new AIService()
