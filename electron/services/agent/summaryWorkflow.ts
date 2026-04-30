import type { AgentDefinition, RunAgentContext, ToolResult } from './types'
import type { Message, Contact } from '../chatService'
import type { AIProvider } from '../ai/providers/base'
import { AgentContext } from '../ai-agent/qa/agentContext'
import {
  standardizeMessagesForAnalysis,
  sliceAnalysisBlocks,
  renderStandardizedMessages
} from '../ai-agent/analyzer/blockSlicer'
import { extractFactsFromBlocks } from '../ai-agent/analyzer/factExtractor'
import { mergeStructuredAnalysisBlocks } from '../ai-agent/analyzer/resultMerger'
import {
  resolveStructuredAnalysisEvidence,
  fallbackStructuredAnalysisWithoutEvidence
} from '../ai-agent/analyzer/evidenceResolver'
import {
  buildStructuredSummaryUserPrompt,
  buildLegacySummaryUserPrompt
} from '../ai-agent/analyzer/summaryRenderer'
import { memoryDatabase } from '../memory/memoryDatabase'
import { createSummaryHooks, type SummaryWorkflowHookOptions } from './workflow/hooks/summaryHooks'
import type { StructuredAnalysis } from '../ai-agent/types/analysis'
import { routeFromHeuristics, enforceConcreteEvidenceRoute } from '../ai-agent/qa/intent/router'
import { resolveWorkflowConfig, resolveBaseAgent, buildAgentDefinition, loadContactMapWithSessionName, createNativeToolExecutor } from './workflowShared'

export type StructuredAnalysisAttempt = {
  blocks: ReturnType<typeof sliceAnalysisBlocks>
  blockAnalyses: any[]
  mergedAnalysis: any
  finalAnalysis: StructuredAnalysis
  blockCount: number
  effectiveMessageCount: number
  evidenceResolved: boolean
}

export type SummaryWorkflowOptions = {
  sessionId: string
  sessionName?: string
  timeRangeDays: number
  timeRangeStart?: number
  timeRangeEnd?: number
  provider: AIProvider
  model: string
  detail?: 'simple' | 'normal' | 'detailed'
  systemPromptPreset?: 'default' | 'decision-focus' | 'action-focus' | 'risk-focus' | 'custom'
  customSystemPrompt?: string
  customRequirement?: string
  enableThinking?: boolean
  inputMessageScopeNote?: string
  answerMaxTokens?: number
  signal?: AbortSignal
}

export type SummaryWorkflowBuildResult = {
  workflowId: string
  agentDef: AgentDefinition
  userMessage: string
  context: RunAgentContext
  structuredAnalysisResult: StructuredAnalysisAttempt | null
  systemPrompt: string
  userPrompt: string
}

function buildTimeRangeLabel(timeRangeDays: number): string {
  return timeRangeDays > 0 ? `最近${timeRangeDays}天` : '全部消息'
}

function buildSummarySystemPrompt(
  detail: string = 'normal',
  preset: 'default' | 'decision-focus' | 'action-focus' | 'risk-focus' | 'custom' = 'default',
  customSystemPrompt?: string
): string {
  const detailInstructions = {
    simple: '生成极简摘要，字数控制在 100 字以内。只保留最核心的事件和结论，忽略寒暄和琐碎细节。',
    normal: '生成内容适中的摘要。涵盖对话主要话题、关键信息点及明确的约定事项。',
    detailed: '生成详尽的深度分析。除了核心信息外，还需捕捉对话背景、各方态度倾向、潜在风险、具体细节以及所有隐含的待办事项。'
  }
  const detailName = { simple: '极致精简', normal: '标准平衡', detailed: '深度详尽' }

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
## 对话概览
[一句话总结本次对话的核心主题和氛围]

## 核心要点
- [关键点A]：简述事情经过或核心论点。
- [关键点B]：相关的背景或补充说明。

## 达成共识/决策
- [决策1]：各方最终确认的具体事项。
- [决策2]：已达成的阶段性结论。

## 待办与后续进展
- [ ] **待办事项**：具体负责人、截止日期（如有）及待执行动作。
- [ ] **跟进事项**：需要进一步明确或调研的问题。

---
*注：若对应部分无相关内容，请直接忽略该标题。*`

  const presetInstructionMap: Record<string, string> = {
    default: '保持通用摘要风格，兼顾信息完整性与可读性。',
    'decision-focus': '重点提取所有决策、结论、拍板事项。若有意见分歧，请明确分歧点和最终取舍。',
    'action-focus': '重点提取可执行事项：负责人、截止时间、前置依赖、下一步动作。尽量转写为清单。',
    'risk-focus': '重点提取风险、阻塞、争议、潜在误解及其影响范围，并给出可执行的缓解建议。'
  }

  if (preset === 'custom') {
    const custom = (customSystemPrompt || '').trim()
    if (custom) return `${basePrompt}\n\n### 用户自定义系统提示词\n${custom}`
    return `${basePrompt}\n\n### 提示\n当前选择了自定义系统提示词，但内容为空。请按默认规则输出。`
  }

  return `${basePrompt}\n\n### 风格偏好\n${presetInstructionMap[preset] || presetInstructionMap.default}`
}

function buildSummaryMemoryContext(sessionId: string, startTime: number, endTime: number): string {
  try {
    type MemorySourceType = 'timeline_summary' | 'conversation_block' | 'fact'
    const sourceTypes: MemorySourceType[] = ['timeline_summary', 'conversation_block', 'fact']
    const SUMMARY_MEMORY_CONTEXT_LIMIT = 18
    const SUMMARY_MEMORY_TEXT_LIMIT = 6000

    const items = sourceTypes.flatMap((sourceType) => memoryDatabase.listMemoryItems({
      sessionId,
      sourceType,
      limit: sourceType === 'fact' ? 80 : 40
    }))
      .filter((item) => {
        const itemStart = Number(item.timeStart || 0)
        const itemEnd = Number(item.timeEnd || 0)
        if (!itemStart && !itemEnd) return true
        return itemEnd >= startTime && itemStart <= endTime
      })
      .sort((a, b) =>
        b.importance - a.importance
        || Number(b.timeEnd || b.timeStart || 0) - Number(a.timeEnd || a.timeStart || 0)
        || b.updatedAt - a.updatedAt
      )
      .slice(0, SUMMARY_MEMORY_CONTEXT_LIMIT)

    if (items.length === 0) return ''

    const compactText = (text: string, max: number) =>
      text.length > max ? `${text.slice(0, max)}...` : text

    const lines = items.map((item, index) => {
      const time = item.timeStart || item.timeEnd
        ? `${item.timeStart || ''}${item.timeEnd && item.timeEnd !== item.timeStart ? `-${item.timeEnd}` : ''}`
        : 'unknown'
      const refs = item.sourceRefs.slice(0, 3)
        .map((ref) => `${ref.createTime}:${compactText(ref.excerpt || '', 80)}`)
        .filter(Boolean)
        .join('；')
      return [
        `${index + 1}. [${item.sourceType}] ${item.title || '无标题'} | time=${time} | importance=${item.importance}`,
        compactText(item.content, 360),
        refs ? `证据索引：${refs}` : ''
      ].filter(Boolean).join('\n')
    })

    return compactText([
      '以下为本地长期记忆中已存在的同会话时间线、对话块和事实，可用于避免重复分析、补足上下文和校对摘要结论。',
      ...lines
    ].join('\n\n'), SUMMARY_MEMORY_TEXT_LIMIT)
  } catch (error) {
    console.warn('[SummaryWorkflow] 读取摘要长期记忆上下文失败:', error)
    return ''
  }
}

export async function createSummaryWorkflow(
  options: SummaryWorkflowOptions,
  messages: Message[],
  contacts: Map<string, Contact>
): Promise<SummaryWorkflowBuildResult> {
  const workflow = resolveWorkflowConfig('builtin-session-summary')
  const baseAgent = resolveBaseAgent()

  const provider = options.provider
  const model = options.model || provider.models[0]

  // 计算时间范围
  const endTime = Number.isFinite(options.timeRangeEnd) && Number(options.timeRangeEnd) > 0
    ? Math.floor(Number(options.timeRangeEnd))
    : Math.floor(Date.now() / 1000)
  const startTime = Number.isFinite(options.timeRangeStart) && Number(options.timeRangeStart) >= 0
    ? Math.floor(Number(options.timeRangeStart))
    : (options.timeRangeDays > 0
      ? endTime - (options.timeRangeDays * 24 * 60 * 60)
      : (messages[0]?.createTime || endTime))

  // 预处理：标准化消息
  const standardizedMessages = standardizeMessagesForAnalysis(messages, contacts, options.sessionId)
  const analysisBlocks = sliceAnalysisBlocks(standardizedMessages)
  const formattedMessages = renderStandardizedMessages(standardizedMessages)

  // 构建系统提示词
  const systemPrompt = buildSummarySystemPrompt(
    options.detail,
    options.systemPromptPreset || 'default',
    options.customSystemPrompt
  )

  // 记忆上下文
  const memoryContext = buildSummaryMemoryContext(options.sessionId, startTime, endTime)

  // 结构化抽取
  let structuredAnalysisResult: StructuredAnalysisAttempt | null = null
  try {
    if (standardizedMessages.length > 0 && analysisBlocks.length > 0) {
      const blockAnalyses = await extractFactsFromBlocks(analysisBlocks, provider, {
        model,
        sessionName: options.sessionName || options.sessionId,
        timeRangeLabel: buildTimeRangeLabel(options.timeRangeDays)
      })
      const mergedAnalysis = mergeStructuredAnalysisBlocks(blockAnalyses)
      let finalAnalysis: StructuredAnalysis
      let evidenceResolved = false
      try {
        finalAnalysis = resolveStructuredAnalysisEvidence(mergedAnalysis, standardizedMessages, options.sessionId)
        evidenceResolved = true
      } catch {
        finalAnalysis = fallbackStructuredAnalysisWithoutEvidence(mergedAnalysis)
      }
      structuredAnalysisResult = {
        blocks: analysisBlocks,
        blockAnalyses,
        mergedAnalysis,
        finalAnalysis,
        blockCount: analysisBlocks.length,
        effectiveMessageCount: standardizedMessages.length,
        evidenceResolved
      }
    }
  } catch (error) {
    console.warn('[SummaryWorkflow] 结构化抽取失败，回退到原始摘要链路:', error)
  }

  // 构建用户提示词
  const targetName = options.sessionName || options.sessionId
  const timeRangeLabel = buildTimeRangeLabel(options.timeRangeDays)
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

  // Agent 定义
  const agentDef = buildAgentDefinition(baseAgent, workflow, provider, model, options.answerMaxTokens)

  // 用户消息（Agent 决策阶段的输入）
  const userMessage = `请对当前会话生成摘要。时间范围：${timeRangeLabel}，消息数：${messages.length}。${structuredAnalysisResult ? '结构化分析已完成，请确认是否需要补充信息后直接生成摘要。' : '结构化分析未完成，请先阅读消息再生成摘要。'}`

  // 原生工具执行器（复用 sessionQA 的工具体系）
  const contactMap = await loadContactMapWithSessionName(options.sessionId, options.sessionName)
  const route = enforceConcreteEvidenceRoute(
    routeFromHeuristics('生成摘要', ''),
    '生成摘要'
  )
  const agentContext = new AgentContext({
    sessionId: options.sessionId,
    sessionName: options.sessionName,
    question: userMessage,
    provider,
    model,
    summaryText: '',
    onChunk: () => {},
    signal: options.signal
  }, route, contactMap)

  const nativeSessionQAToolExecutor = createNativeToolExecutor(agentContext)

  // Hooks
  const hookOptions: SummaryWorkflowHookOptions = {
    systemPrompt,
    userPrompt,
    structuredAnalysis: structuredAnalysisResult?.finalAnalysis || null,
    answerTemperature: workflow.answerTemperature,
    answerMaxTokens: options.answerMaxTokens,
    enableThinking: options.enableThinking
  }

  return {
    workflowId: workflow.id,
    agentDef,
    userMessage,
    context: {
      provider,
      workflow: createSummaryHooks(hookOptions),
      selection: {
        selectedSessions: [{ id: options.sessionId, name: options.sessionName }]
      },
      nativeSessionQAToolExecutor
    },
    structuredAnalysisResult,
    systemPrompt,
    userPrompt
  }
}
