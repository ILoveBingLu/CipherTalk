import { ConfigService } from '../config'
import { aiDatabase } from './aiDatabase'
import { ZhipuProvider, ZhipuMetadata } from './providers/zhipu'
import { DeepSeekProvider, DeepSeekMetadata } from './providers/deepseek'
import { QwenProvider, QwenMetadata } from './providers/qwen'
import { DoubaoProvider, DoubaoMetadata } from './providers/doubao'
import { KimiProvider, KimiMetadata } from './providers/kimi'
import { SiliconFlowProvider, SiliconFlowMetadata } from './providers/siliconflow'
import { XiaomiProvider, XiaomiMetadata } from './providers/xiaomi'
import { OpenAIProvider, OpenAIMetadata } from './providers/openai'
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
      CustomMetadata,
      OllamaMetadata,
      OpenAIMetadata,
      GeminiMetadata,
      DeepSeekMetadata,
      ZhipuMetadata,
      QwenMetadata,
      DoubaoMetadata,
      KimiMetadata,
      SiliconFlowMetadata,
      XiaomiMetadata
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
      default:
        throw new Error(`不支持的提供商: ${name}`)
    }
  }

  /**
   * 获取系统提示词
   */
  private getSystemPrompt(language: string = 'zh', detail: string = 'normal'): string {
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

    return `### 角色定义
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
  }

  /**
   * 简单的 XML 值提取辅助函数
   */
  private extractXmlValue(xml: string, tagName: string): string {
    if (!xml) return ''
    const regex = new RegExp(`<${tagName}(?:\\s+[^>]*)?>([\\s\\S]*?)</${tagName}>`, 'i')
    const match = regex.exec(xml)
    return match ? match[1].replace(/<!\[CDATA\[(.*?)]]>/g, '$1').trim() : ''
  }

  /**
   * 格式化消息
   */
  /**
   * 格式化消息
   */
  private formatMessages(messages: Message[], contacts: Map<string, Contact>, sessionId: string): string {
    return messages.map(msg => {
      // 获取发送者显示名称
      const contact = contacts.get(msg.senderUsername || '')
      const sender = contact?.remark || contact?.nickName || msg.senderUsername || '未知'

      // 格式化时间
      const time = new Date(msg.createTime * 1000).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })

      // 处理不同类型的消息
      let content = msg.parsedContent || ''

      // 语音消息 (Type 34)
      if (msg.localType === 34) {
        // 尝试获取转写缓存
        // 注意：转写服务使用的是会话ID+创建时间作为键
        const transcript = voiceTranscribeService.getCachedTranscript(sessionId, msg.createTime)
        content = transcript ? `[语音] ${transcript}` : '[语音]'
      }
      // 视频 (Type 43)
      else if (msg.localType === 43) {
        content = '[视频]'
      }
      // 表情包 (Type 47)
      else if (msg.localType === 47) {
        // 尝试从 rawContent 提取信息
        const raw = msg.rawContent || ''
        // 尝试提取 cdnurl 或其他标识，但通常表情包没有有意义的文本名字
        // 这里主要区分是自定义表情还是商店表情
        const md5 = this.extractXmlValue(raw, 'md5')
        content = md5 ? `[表情包]` : '[表情包]'
      }
      // 文件/链接 (Type 49)
      else if (msg.localType === 49) {
        // 提取标题和链接/描述
        const raw = msg.rawContent || ''
        const title = this.extractXmlValue(raw, 'title')
        const url = this.extractXmlValue(raw, 'url')
        const desc = this.extractXmlValue(raw, 'des')

        let label = '[文件/链接]'
        const type = this.extractXmlValue(raw, 'type')
        if (type === '5') label = '[链接]' // 网页链接
        if (type === '6') label = '[文件]' // 文件
        if (type === '33' || type === '36') label = '[小程序]'
        if (type === '57') label = '[引用]' // 引用产生的 AppMsg

        if (title) {
          content = `${label} ${title}`
          if (url && type === '5') content += ` (${url})`
          else if (desc && type !== '57' && desc.length < 50) content += ` - ${desc}`
        } else {
          content = label
        }
      }

      return `[${time}] ${sender}: ${content}`
    }).join('\n')
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
    const systemPrompt = this.getSystemPrompt(options.language, options.detail)

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
