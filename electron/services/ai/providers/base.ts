import OpenAI from 'openai'
import { proxyService } from '../proxyService'

/**
 * AI 提供商基础接口
 */
export interface AIProvider {
  name: string
  displayName: string
  models: string[]
  pricing: {
    input: number   // 每1K tokens价格（元）
    output: number  // 每1K tokens价格（元）
  }

  /**
   * 非流式聊天
   */
  chat(messages: OpenAI.Chat.ChatCompletionMessageParam[], options?: ChatOptions): Promise<string>

  /**
   * 流式聊天
   */
  streamChat(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options: ChatOptions,
    onChunk: (chunk: string) => void
  ): Promise<void>

  /**
   * 测试连接
   */
  testConnection(): Promise<{ success: boolean; error?: string; needsProxy?: boolean }>
}

/**
 * 聊天选项
 */
export interface ChatOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  enableThinking?: boolean  // 是否启用思考模式（处理 reasoning_content）
}

/**
 * AI 提供商抽象基类
 */
export abstract class BaseAIProvider implements AIProvider {
  abstract name: string
  abstract displayName: string
  abstract models: string[]
  abstract pricing: { input: number; output: number }

  protected client: OpenAI
  protected apiKey: string
  protected baseURL: string

  constructor(apiKey: string, baseURL: string) {
    this.apiKey = apiKey
    this.baseURL = baseURL
    
    // 初始化时不创建 client，延迟到实际请求时
    // 这样可以动态获取代理配置
    this.client = null as any
  }

  /**
   * 获取或创建 OpenAI 客户端（支持代理）
   */
  protected async getClient(): Promise<OpenAI> {
    // 每次请求时重新创建 client，确保使用最新的代理配置
    const proxyAgent = await proxyService.createProxyAgent(this.baseURL)
    
    const clientConfig: any = {
      apiKey: this.apiKey,
      baseURL: this.baseURL,
      timeout: 60000, // 60秒超时
    }

    // 如果有代理，注入 httpAgent
    if (proxyAgent) {
      clientConfig.httpAgent = proxyAgent
      console.log(`[${this.name}] 使用代理连接`)
    } else {
      console.log(`[${this.name}] 使用直连`)
    }

    return new OpenAI(clientConfig)
  }

  async chat(messages: OpenAI.Chat.ChatCompletionMessageParam[], options?: ChatOptions): Promise<string> {
    const client = await this.getClient()
    
    const response = await client.chat.completions.create({
      model: options?.model || this.models[0],
      messages: messages,
      temperature: options?.temperature || 0.7,
      max_tokens: options?.maxTokens,
      stream: false
    })

    return response.choices[0]?.message?.content || ''
  }

  async streamChat(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options: ChatOptions,
    onChunk: (chunk: string) => void
  ): Promise<void> {
    const client = await this.getClient()
    const enableThinking = options?.enableThinking !== false  // 默认启用
     const supportsThinkingParams = this.name !== 'ollama'

    const buildRequestParams = (includeThinking: boolean) => {
      const params: any = {
        model: options?.model || this.models[0],
        messages: messages,
        temperature: options?.temperature || 0.7,
        max_tokens: options?.maxTokens,
        stream: true
      }
    
      if (includeThinking) {
        params.reasoning_effort = 'medium'
        params.thinking = { type: 'enabled' }
      }

      return params
    }

    let stream: any
    try {
      stream = await client.chat.completions.create(
        buildRequestParams(enableThinking && supportsThinkingParams)
      ) as any
    } catch (error: any) {
      const errorMessage = error?.message || String(error)
      if (enableThinking && supportsThinkingParams && /reasoning|thinking|not supported/i.test(errorMessage)) {
        stream = await client.chat.completions.create(
          buildRequestParams(false)
        ) as any
      } else {
        throw error
      }
    }
    
    let isThinking = false

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta
      const content = delta?.content || ''
      const reasoning = delta?.reasoning_content || ''

      // 始终处理推理内容（如果模型返回了的话）
      // 因为某些模型（如 Gemini 2.5 Pro、Gemini 3）无法完全关闭推理功能
      if (reasoning) {
        if (!isThinking) {
          onChunk('<think>')
          isThinking = true
        }
        onChunk(reasoning)
      } else if (content) {
        if (isThinking) {
          onChunk('</think>')
          isThinking = false
        }
        onChunk(content)
      }
    }

    // 确保思考标签闭合
    if (isThinking) {
      onChunk('</think>')
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string; needsProxy?: boolean }> {
    try {
      const client = await this.getClient()
      
      // 创建超时 Promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('CONNECTION_TIMEOUT')), 15000) // 15秒超时
      })
      
      // 竞速：API 请求 vs 超时
      await Promise.race([
        client.models.list(),
        timeoutPromise
      ])
      
      return { success: true }
    } catch (error: any) {
      const errorMessage = error?.message || String(error)
      console.error(`[${this.name}] 连接测试失败:`, errorMessage)
      
      // 判断是否需要代理
      const needsProxy = 
        errorMessage.includes('ECONNREFUSED') ||
        errorMessage.includes('ETIMEDOUT') ||
        errorMessage.includes('ENOTFOUND') ||
        errorMessage.includes('CONNECTION_TIMEOUT') ||
        errorMessage.includes('getaddrinfo') ||
        error?.code === 'ECONNREFUSED' ||
        error?.code === 'ETIMEDOUT' ||
        error?.code === 'ENOTFOUND'
      
      // 构建错误提示
      let errorMsg = '连接失败'
      
      if (errorMessage.includes('CONNECTION_TIMEOUT')) {
        errorMsg = '连接超时，请开启代理或检查网络'
      } else if (errorMessage.includes('ECONNREFUSED')) {
        errorMsg = '连接被拒绝，请开启代理或检查网络'
      } else if (errorMessage.includes('ETIMEDOUT')) {
        errorMsg = '连接超时，请开启代理或检查网络'
      } else if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('getaddrinfo')) {
        errorMsg = '无法解析域名，请开启代理或检查网络'
      } else if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
        errorMsg = 'API Key 无效，请检查配置'
      } else if (errorMessage.includes('403') || errorMessage.includes('Forbidden')) {
        errorMsg = '访问被禁止，请检查 API Key 权限'
      } else if (errorMessage.includes('429')) {
        errorMsg = '请求过于频繁，请稍后再试'
      } else if (errorMessage.includes('500') || errorMessage.includes('502') || errorMessage.includes('503')) {
        errorMsg = '服务器错误，请稍后再试'
      } else if (needsProxy) {
        errorMsg = '网络连接失败，请开启代理或检查网络'
      } else {
        errorMsg = `连接失败: ${errorMessage}`
      }
      
      return { 
        success: false, 
        error: errorMsg,
        needsProxy 
      }
    }
  }
}
