import { ConfigService } from '../config'
import { aiDatabase } from './aiDatabase'
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
import { voiceTranscribeService } from '../voiceTranscribeService'

/**
 * 摘要选项
 */
export interface SummaryOptions {
  sessionId: string
  timeRangeDays: number  // 1, 3, 7, 30
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
}

/**
 * 摘要结果
 */
export interface SummaryResult {
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
   * 格式化消息（完全依赖后端解析结果，不重复解析）
   */
  private formatMessages(messages: Message[], contacts: Map<string, Contact>, sessionId: string): string {
    const formattedLines: string[] = []

    messages.forEach(msg => {
      // 获取发送者显示名称
      const contact = contacts.get(msg.senderUsername || '')
      const sender = contact?.remark || contact?.nickName || msg.senderUsername || '未知'

      // 格式化时间：YYYY-MM-DD-HH:MM:SS
      const date = new Date(msg.createTime * 1000)
      const time = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`

      // 调试日志：检查聊天记录消息
      if (msg.parsedContent && msg.parsedContent.includes('[聊天记录]')) {
        console.log('[AIService] 发现聊天记录消息:', {
          localType: msg.localType,
          parsedContent: msg.parsedContent.substring(0, 100),
          hasChatRecordList: !!msg.chatRecordList,
          chatRecordListLength: msg.chatRecordList?.length || 0,
          rawContentPreview: msg.rawContent?.substring(0, 200)
        })
      }

      // 处理不同类型的消息
      let content = ''
      let messageType = '文本'

      // 特殊处理1：聊天记录（有详细列表）
      // 后端在 parseChatHistory() 中检查 <type>19</type> 并填充 chatRecordList
      if (msg.chatRecordList && msg.chatRecordList.length > 0) {
        messageType = '聊天记录'
        const recordCount = msg.chatRecordList.length
        const recordLines: string[] = []

        // 从 parsedContent 提取标题（格式：[聊天记录] 标题）
        let title = '聊天记录'
        if (msg.parsedContent && msg.parsedContent.startsWith('[聊天记录]')) {
          title = msg.parsedContent.replace('[聊天记录]', '').trim() || '聊天记录'
        }

        recordLines.push(title)
        recordLines.push(`共${recordCount}条消息：`)

        // 遍历聊天记录列表
        msg.chatRecordList.forEach((record, index) => {
          const recordSender = record.sourcename || '未知'

          // 根据datatype判断消息类型
          let recordContent = ''
          if (record.datatype === 1) {
            // 文本消息
            recordContent = record.datadesc || record.datatitle || ''
          } else if (record.datatype === 3) {
            recordContent = '[图片]'
          } else if (record.datatype === 34) {
            recordContent = '[语音]'
          } else if (record.datatype === 43) {
            recordContent = '[视频]'
          } else if (record.datatype === 47) {
            recordContent = '[表情包]'
          } else if (record.datatype === 8 || record.datatype === 49) {
            // 文件消息
            recordContent = `[文件] ${record.datatitle || record.datadesc || ''}`
          } else {
            recordContent = record.datadesc || record.datatitle || '[媒体消息]'
          }

          recordLines.push(`  第${index + 1}条 - ${recordSender}: ${recordContent}`)
        })

        content = recordLines.join('\n')
      }
      // 特殊处理2：语音消息 - 尝试获取转写文本
      else if (msg.localType === 34) {
        messageType = '语音'
        const transcript = voiceTranscribeService.getCachedTranscript(sessionId, msg.createTime)
        content = transcript || msg.parsedContent || '[语音消息]'
      }
      // 特殊处理3：撤回消息 - 跳过
      else if (msg.localType === 10002) {
        return
      }
      // 其他所有消息：直接使用后端解析的 parsedContent
      else {
        content = msg.parsedContent || '[消息]'

        // 根据 parsedContent 的前缀判断消息类型
        if (content.startsWith('[图片]')) {
          messageType = '图片'
        } else if (content.startsWith('[视频]')) {
          messageType = '视频'
        } else if (content.startsWith('[动画表情]') || content.startsWith('[表情包]')) {
          messageType = '表情包'
        } else if (content.startsWith('[文件]')) {
          messageType = '文件'
        } else if (content.startsWith('[转账]')) {
          messageType = '转账'
        } else if (content.startsWith('[链接]')) {
          messageType = '链接'
        } else if (content.startsWith('[小程序]')) {
          messageType = '小程序'
        } else if (content.startsWith('[聊天记录]')) {
          messageType = '聊天记录'
        } else if (content.startsWith('[引用消息]') || msg.localType === 244813135921) {
          messageType = '引用'
        } else if (content.startsWith('[位置]')) {
          messageType = '位置'
        } else if (content.startsWith('[名片]')) {
          messageType = '名片'
        } else if (content.startsWith('[通话]')) {
          messageType = '通话'
        } else if (msg.localType === 10000) {
          messageType = '系统'
        } else if (msg.localType === 1) {
          messageType = '文本'
        } else {
          // 未知类型，记录日志以便调试
          console.log(`[AIService] 未知消息类型: localType=${msg.localType}, parsedContent=${content.substring(0, 100)}`)
          messageType = '未知'
        }
      }

      // 跳过空内容的消息（但保留图片、视频、表情包等媒体消息）
      if (!content && messageType !== '图片' && messageType !== '视频' && messageType !== '表情包') {
        return
      }

      // 格式化输出：[消息类型] {发送者：时间 内容}
      if (messageType === '文本') {
        formattedLines.push(`[文本] {${sender}：${time} ${content}}`)
      } else if (messageType === '转账') {
        formattedLines.push(`[转账] {${sender}：${time} ${content}}`)
      } else if (messageType === '链接') {
        formattedLines.push(`[链接] {${sender}：${time} ${content}}`)
      } else if (messageType === '文件') {
        formattedLines.push(`[文件] {${sender}：${time} ${content}}`)
      } else if (messageType === '语音') {
        formattedLines.push(`[语音] {${sender}：${time} ${content}}`)
      } else if (messageType === '图片') {
        formattedLines.push(`[图片] {${sender}：${time}}`)
      } else if (messageType === '视频') {
        formattedLines.push(`[视频] {${sender}：${time}}`)
      } else if (messageType === '表情包') {
        formattedLines.push(`[表情包] {${sender}：${time}}`)
      } else if (messageType === '小程序') {
        formattedLines.push(`[小程序] {${sender}：${time} ${content}}`)
      } else if (messageType === '聊天记录') {
        formattedLines.push(`[聊天记录] {${sender}：${time} ${content}}`)
      } else if (messageType === '引用') {
        formattedLines.push(`[引用] {${sender}：${time} ${content}}`)
      } else if (messageType === '位置') {
        formattedLines.push(`[位置] {${sender}：${time} ${content}}`)
      } else if (messageType === '名片') {
        formattedLines.push(`[名片] {${sender}：${time} ${content}}`)
      } else if (messageType === '通话') {
        formattedLines.push(`[通话] {${sender}：${time} ${content}}`)
      } else if (messageType === '系统') {
        formattedLines.push(`[系统消息] {${time} ${content}}`)
      } else {
        formattedLines.push(`[${messageType}] {${sender}：${time} ${content}}`)
      }
    })

    return formattedLines.join('\n')
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

    // 计算时间范围
    const endTime = Math.floor(Date.now() / 1000)
    const startTime = endTime - (options.timeRangeDays * 24 * 60 * 60)

    // 获取提供商
    const provider = this.getProvider(options.provider, options.apiKey)
    const model = options.model || provider.models[0]

    // 格式化消息
    const formattedMessages = this.formatMessages(messages, contacts, options.sessionId)

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
    let userPrompt = `请分析我与"${targetName}"的聊天记录（时间范围：最近${options.timeRangeDays}天，共${messages.length}条消息）：

${formattedMessages}

请按照系统提示的格式生成摘要。`

    // 如果有自定义要求，添加到提示词中
    if (options.customRequirement && options.customRequirement.trim()) {
      userPrompt += `\n\n用户的额外要求：${options.customRequirement.trim()}`
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
      promptText: userPrompt
    })

    console.log('[AIService] 摘要已保存到数据库，ID:', summaryId)

    // 更新使用统计
    aiDatabase.updateUsageStats(provider.name, model, tokensUsed, cost)

    return {
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
      createdAt: Date.now()
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

  /**
   * 获取摘要历史
   */
  getSummaryHistory(sessionId: string, limit: number = 10): any[] {
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
