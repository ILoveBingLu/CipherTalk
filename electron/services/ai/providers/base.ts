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
   * 原生工具调用（OpenAI-compatible Chat Completions tools/tool_calls）
   */
  chatWithTools(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options: ChatWithToolsOptions
  ): Promise<NativeToolCallResult>

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

export type NativeToolDefinition = OpenAI.Chat.ChatCompletionTool

export interface ChatWithToolsOptions extends ChatOptions {
  tools: NativeToolDefinition[]
  toolChoice?: OpenAI.Chat.ChatCompletionToolChoiceOption
  parallelToolCalls?: boolean
}

export interface NativeToolCallResult {
  message: OpenAI.Chat.ChatCompletionMessage
  finishReason?: string | null
}

export const NATIVE_TOOL_CALLING_UNSUPPORTED_MESSAGE = '当前模型/服务商不支持原生工具调用，请切换支持 tools 的 OpenAI-compatible 模型'

export function isNativeToolCallingUnsupportedError(error: unknown): boolean {
  const status = typeof error === 'object' && error && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : undefined
  const message = error instanceof Error ? error.message : String(error || '')
  const lower = message.toLowerCase()

  return (
    status === 400
    || status === 404
    || status === 422
  ) && (
    lower.includes('tool')
    || lower.includes('tool_choice')
    || lower.includes('tool_calls')
    || lower.includes('function_call')
    || lower.includes('function calling')
    || lower.includes('functions')
    || lower.includes('unsupported parameter')
    || lower.includes('unknown parameter')
    || lower.includes('unrecognized request argument')
  )
}

export function normalizeNativeToolCallingError(error: unknown): Error {
  if (isNativeToolCallingUnsupportedError(error)) {
    return new Error(NATIVE_TOOL_CALLING_UNSUPPORTED_MESSAGE)
  }

  return error instanceof Error ? error : new Error(String(error || '模型工具调用失败'))
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

  protected getDefaultHeaders(): Record<string, string> | undefined {
    return undefined
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

    const defaultHeaders = this.getDefaultHeaders()
    if (defaultHeaders && Object.keys(defaultHeaders).length > 0) {
      clientConfig.defaultHeaders = defaultHeaders
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

  protected resolveModelId(displayName: string): string {
    return displayName
  }

  async chat(messages: OpenAI.Chat.ChatCompletionMessageParam[], options?: ChatOptions): Promise<string> {
    const client = await this.getClient()
    const model = this.resolveModelId(options?.model || this.models[0])
    
    const response = await client.chat.completions.create({
      model,
      messages: messages,
      temperature: options?.temperature || 0.7,
      max_tokens: options?.maxTokens,
      stream: false
    })

    return response.choices[0]?.message?.content || ''
  }

  async chatWithTools(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options: ChatWithToolsOptions
  ): Promise<NativeToolCallResult> {
    const client = await this.getClient()
    const model = this.resolveModelId(options?.model || this.models[0])

    const requestParams: any = {
      model,
      messages,
      temperature: options?.temperature ?? 0.2,
      max_tokens: options?.maxTokens,
      stream: false,
      tools: options.tools,
      tool_choice: options.toolChoice ?? 'auto'
    }

    if (typeof options.parallelToolCalls === 'boolean') {
      requestParams.parallel_tool_calls = options.parallelToolCalls
    }

    try {
      const response = await client.chat.completions.create(requestParams)
      return {
        message: response.choices[0]?.message || { role: 'assistant', content: '' },
        finishReason: response.choices[0]?.finish_reason || null
      }
    } catch (error) {
      throw normalizeNativeToolCallingError(error)
    }
  }

  async streamChat(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options: ChatOptions,
    onChunk: (chunk: string) => void
  ): Promise<void> {
    const client = await this.getClient()
    const enableThinking = options?.enableThinking !== false  // 默认启用
    const model = this.resolveModelId(options?.model || this.models[0])
    
    // 构建请求参数
    const requestParams: any = {
      model,
      messages: messages,
      temperature: options?.temperature || 0.7,
      max_tokens: options?.maxTokens,
      stream: true
    }
    
    // 自适应添加思考模式参数（尝试所有已知的参数格式）
    // API 会自动忽略不支持的参数，不会报错
    if (enableThinking) {
      // DeepSeek 风格: reasoning_effort
      requestParams.reasoning_effort = 'medium'
      
      // 通义千问风格: thinking 对象
      requestParams.thinking = {
        type: 'enabled'
      }
    } else {
      // 禁用思考模式
      // DeepSeek/Gemini 风格: reasoning_effort = 'none'
      requestParams.reasoning_effort = 'none'
      
      // 通义千问风格: thinking.type = 'disabled'
      requestParams.thinking = {
        type: 'disabled'
      }
    }
    
    // 使用 as any 避免类型检查，因为我们添加了额外的参数
    const stream = await client.chat.completions.create(requestParams) as any

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
