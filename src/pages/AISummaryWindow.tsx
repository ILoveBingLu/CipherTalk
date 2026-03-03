import { useState, useEffect, useRef } from 'react'
import { Copy, Download, RefreshCw, Loader2, Send, ArrowLeft, Trash2, LoaderPinwheel, Atom, ChevronDown } from 'lucide-react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { TIME_RANGE_OPTIONS, type SummaryResult } from '../types/ai'
import './AISummaryWindow.scss'

function AISummaryWindow() {
  const [sessionId, setSessionId] = useState<string>('')
  const [sessionName, setSessionName] = useState<string>('')
  const [avatarUrl, setAvatarUrl] = useState<string>('')
  const [aiProviderLogo, setAiProviderLogo] = useState<string>('')
  const [resultProviderInfo, setResultProviderInfo] = useState<{ logo: string; displayName: string } | null>(null)
  const [timeRangeDays, setTimeRangeDays] = useState<number>(7)
  const [customDays, setCustomDays] = useState<string>('')
  const [customRequirement, setCustomRequirement] = useState<string>('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [summaryText, setSummaryText] = useState('')
  const [thinkText, setThinkText] = useState('')
  const [isThinking, setIsThinking] = useState(false)
  const [showThink, setShowThink] = useState(true)
  const [result, setResult] = useState<SummaryResult | null>(null)
  const [error, setError] = useState<string>('')
  const [history, setHistory] = useState<SummaryResult[]>([])
  const thinkContentRef = useRef<HTMLDivElement>(null)

  // 对话框状态
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null)
  const [showRenameDialog, setShowRenameDialog] = useState(false)
  const [renameTargetId, setRenameTargetId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // 思考内容自动滚动
  useEffect(() => {
    if (thinkContentRef.current) {
      thinkContentRef.current.scrollTop = thinkContentRef.current.scrollHeight
    }
  }, [thinkText])

  // 从 URL 参数获取 sessionId
  useEffect(() => {
    // 从 query 参数获取（不是 hash 参数）
    const params = new URLSearchParams(window.location.search)
    const sid = params.get('sessionId')
    const name = params.get('sessionName')

    console.log('[AISummaryWindow] URL params:', { sid, name, search: window.location.search, hash: window.location.hash })

    if (sid) {
      setSessionId(sid)
      setSessionName(decodeURIComponent(name || sid))

      // 获取会话头像
      loadContactAvatar(sid)

      // 加载历史记录
      loadHistory(sid)
    } else {
      setError('未能获取会话信息，请重新打开窗口')
    }

    // 加载默认时间范围
    window.electronAPI.config.get('aiDefaultTimeRange').then((days: any) => {
      if (days) setTimeRangeDays(days as number)
    })

    // 加载当前 AI 提供商的 logo
    loadAiProviderLogo()
  }, [])

  // 加载联系人头像
  const loadContactAvatar = async (sid: string) => {
    try {
      const result = await window.electronAPI.chat.getContactAvatar(sid)
      if (result && result.avatarUrl) {
        setAvatarUrl(result.avatarUrl)
      }
    } catch (e) {
      console.error('加载头像失败:', e)
    }
  }

  // 加载 AI 提供商 logo
  const loadAiProviderLogo = async () => {
    try {
      const { getAiProvider } = await import('../services/config')
      const { getAIProviders } = await import('../types/ai')
      
      const currentProvider = await getAiProvider()
      const providers = await getAIProviders()
      const providerInfo = providers.find(p => p.id === currentProvider)
      
      if (providerInfo?.logo) {
        setAiProviderLogo(providerInfo.logo)
      }
    } catch (e) {
      console.error('加载 AI 提供商 logo 失败:', e)
    }
  }

  // 根据提供商 ID 加载提供商信息
  const loadProviderInfo = async (providerId: string) => {
    try {
      const { getAIProviders } = await import('../types/ai')
      const providers = await getAIProviders()
      const providerInfo = providers.find(p => p.id === providerId)
      
      if (providerInfo) {
        setResultProviderInfo({
          logo: providerInfo.logo || '',
          displayName: providerInfo.displayName
        })
      }
    } catch (e) {
      console.error('加载提供商信息失败:', e)
    }
  }

  // 加载历史记录
  const loadHistory = async (sid: string) => {
    try {
      const result = await window.electronAPI.ai.getSummaryHistory(sid, 10)
      if (result.success && result.history) {
        console.log('[AISummaryWindow] 历史记录:', result.history)
        setHistory(result.history)
      }
    } catch (e) {
      console.error('加载历史记录失败:', e)
    }
  }

  // 生成摘要
  const handleGenerate = async () => {
    if (!sessionId) return

    setIsGenerating(true)
    setError('')
    setSummaryText('')
    setThinkText('')
    setIsThinking(false)
    setShowThink(true)
    setResult(null)

    try {
      // 检查 API 配置 - 使用新的配置服务
      const { getAiApiKey, getAiProvider, getAiModel, getAiSummaryDetail, getAiEnableThinking, getAiSystemPromptPreset, getAiCustomSystemPrompt } = await import('../services/config')
      
      const apiKey = await getAiApiKey()
      console.log('[AISummaryWindow] 当前 API Key:', apiKey ? '已配置' : '未配置', '长度:', apiKey?.length)
      
      if (!apiKey) {
        setError('请先在设置中配置 AI API 密钥')
        setIsGenerating(false)
        return
      }

      // 获取配置
      const provider = await getAiProvider()
      const model = await getAiModel()
      const detail = await getAiSummaryDetail()
      const enableThinking = await getAiEnableThinking()
      const systemPromptPreset = await getAiSystemPromptPreset()
      const customSystemPrompt = await getAiCustomSystemPrompt()
      
      console.log('[AISummaryWindow] 配置信息:', { provider, model, detail, enableThinking, systemPromptPreset })

      // 监听流式输出
      let internalThinkMode = false
      let chunkCount = 0

      const cleanup = window.electronAPI.ai.onSummaryChunk((chunk: string) => {
        try {
          chunkCount++
          if (chunkCount === 1) {
            console.log('[AISummaryWindow] 开始接收流式输出')
          }

          let content = chunk

          // 检测开始标签
          if (content.includes('<think>')) {
            const parts = content.split('<think>')
            // 如果有前置内容，先添加到摘要
            if (parts[0]) {
              setSummaryText(prev => prev + parts[0])
            }

            internalThinkMode = true
            setIsThinking(true)
            setShowThink(true)
            content = parts[1] // 取标签后的内容
          }

          // 检测结束标签
          if (content.includes('</think>')) {
            internalThinkMode = false
            setIsThinking(false)
            setShowThink(false) // 思考结束自动收起

            const parts = content.split('</think>')
            const thinkPart = parts[0]
            const summaryPart = parts[1] || ''

            setThinkText(prev => prev + thinkPart)
            setSummaryText(prev => prev + summaryPart)
            return
          }

          if (internalThinkMode) {
            setThinkText(prev => prev + content)
          } else {
            setSummaryText(prev => prev + content)
          }
        } catch (e) {
          console.error('[AISummaryWindow] 处理流式输出出错:', e)
        }
      })

      console.log('[AISummaryWindow] 开始调用 AI 生成摘要')

      // 调用 AI 服务生成摘要
      const generateResult = await window.electronAPI.ai.generateSummary(
        sessionId,
        timeRangeDays,
        {
          provider: provider || 'zhipu',
          apiKey: apiKey as string,
          model: model || 'glm-4.5-flash',
          detail: detail || 'normal',
          systemPromptPreset,
          customSystemPrompt,
          customRequirement: customRequirement,
          sessionName: sessionName,
          enableThinking: enableThinking !== false  // 默认启用
        }
      )

      console.log('[AISummaryWindow] AI 调用完成，接收到', chunkCount, '个数据块')
      console.log('[AISummaryWindow] 返回结果:', generateResult)

      cleanup()

      if (!generateResult.success) {
        console.error('[AISummaryWindow] 生成失败:', generateResult.error)
        setError('生成摘要失败: ' + generateResult.error)
        setIsGenerating(false)
        return
      }

      // 设置结果
      if (generateResult.result) {
        console.log('[AISummaryWindow] 生成成功:', generateResult.result)
        setResult(generateResult.result)
        // 加载该结果对应的提供商信息
        await loadProviderInfo(generateResult.result.provider)
        // 重新加载历史记录
        await loadHistory(sessionId)
      } else {
        console.error('[AISummaryWindow] 生成结果为空')
        setError('生成摘要失败: 返回结果为空')
      }
      setIsGenerating(false)

    } catch (e) {
      console.error('[AISummaryWindow] 生成异常:', e)
      setError('生成摘要失败: ' + String(e))
      setIsGenerating(false)
    }
  }

  // 渲染 Markdown
  const renderMarkdown = (text: string) => {
    const html = marked.parse(text) as string
    return { __html: DOMPurify.sanitize(html) }
  }

  // 删除历史记录
  const handleDeleteHistory = (id: number, e: React.MouseEvent) => {
    e.stopPropagation()
    console.log('[AISummaryWindow] 删除记录:', id)
    setDeleteTargetId(id)
    setShowDeleteDialog(true)
  }

  // 确认删除
  const confirmDelete = async () => {
    if (!deleteTargetId) return

    console.log('[AISummaryWindow] 确认删除:', deleteTargetId)

    try {
      const deleteResult = await window.electronAPI.ai.deleteSummary(deleteTargetId)
      if (deleteResult.success) {
        console.log('[AISummaryWindow] 删除成功')
        // 重新加载历史记录
        await loadHistory(sessionId)
        // 如果删除的是当前显示的记录，清空显示
        if (result && result.id === deleteTargetId) {
          setResult(null)
          setSummaryText('')
          setThinkText('')
        }
        setShowDeleteDialog(false)
        setDeleteTargetId(null)
      } else {
        alert('删除失败: ' + deleteResult.error)
      }
    } catch (e) {
      console.error('删除失败:', e)
      alert('删除失败: ' + String(e))
    }
  }

  // 重命名历史记录
  const handleRenameHistory = (id: number, currentName: string, e: React.MouseEvent) => {
    e.stopPropagation()
    console.log('[AISummaryWindow] 重命名记录:', id, currentName)
    setRenameTargetId(id)
    setRenameValue(currentName)
    setShowRenameDialog(true)
  }

  // 确认重命名
  const confirmRename = async () => {
    if (!renameTargetId || !renameValue.trim()) return

    console.log('[AISummaryWindow] 确认重命名:', renameTargetId, renameValue)

    try {
      const renameResult = await (window.electronAPI.ai as any).renameSummary(renameTargetId, renameValue.trim())
      if (renameResult.success) {
        console.log('[AISummaryWindow] 重命名成功')
        // 重新加载历史记录
        await loadHistory(sessionId)
        // 如果重命名的是当前显示的记录，更新显示
        if (result && result.id === renameTargetId) {
          setResult({ ...result, customName: renameValue.trim() } as SummaryResult)
        }
        setShowRenameDialog(false)
        setRenameTargetId(null)
        setRenameValue('')
      } else {
        alert('重命名失败: ' + renameResult.error)
      }
    } catch (e) {
      console.error('重命名失败:', e)
      alert('重命名失败: ' + String(e))
    }
  }

  // 返回历史记录列表
  const handleBackToHistory = () => {
    setResult(null)
    setSummaryText('')
    setThinkText('')
  }

  return (
    <div className="ai-summary-window">
      {/* 自定义标题栏 */}
      <div className="title-bar">
        <div className="title-content">
          {avatarUrl && (
            <img src={avatarUrl} alt="" className="session-avatar" />
          )}
          {aiProviderLogo && (
            <>
              <span className="multiply-symbol">×</span>
              <div className="ai-provider-badge">
                <img src={aiProviderLogo} alt="AI" className="ai-provider-logo" />
              </div>
            </>
          )}
          <span className="session-name">{sessionName}</span>
        </div>
        
        {result && (
          <span className="message-count">{result.messageCount}条</span>
        )}

        <div className="title-actions">
          {isGenerating && (
            <div className="generating-status" data-tooltip="正在生成摘要...">
              <Loader2 className="spinner" size={16} />
            </div>
          )}

          {result && !isGenerating && (
            <>
              <button className="title-btn" onClick={handleBackToHistory} data-tooltip="返回记录列表">
                <ArrowLeft size={14} />
              </button>
              <button className="title-btn" onClick={() => {
                if (result.summaryText) {
                  // 1. 移除思考过程
                  let content = result.summaryText
                  if (content.includes('<think>') && content.includes('</think>')) {
                    const parts = content.split('</think>')
                    content = parts[1] || '' // 只取思考结束后的部分
                  }

                  // 2. 解析 Markdown 为 HTML
                  const html = marked.parse(content) as string

                  // 3. 提取纯文本
                  const tempDiv = document.createElement('div')
                  tempDiv.innerHTML = html
                  const plainText = tempDiv.textContent || tempDiv.innerText || ''

                  navigator.clipboard.writeText(plainText.trim())
                }
              }} data-tooltip="复制摘要">
                <Copy size={14} />
              </button>
              <button className="title-btn" onClick={async () => {
                if (!result.summaryText) return
                try {
                  const fileName = `AI摘要_${sessionName}_${new Date().toLocaleDateString()}.txt`
                  const blob = new Blob([result.summaryText], { type: 'text/plain' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = fileName
                  a.click()
                  URL.revokeObjectURL(url)
                } catch (e) {
                  console.error('导出失败:', e)
                }
              }} data-tooltip="导出文本">
                <Download size={14} />
              </button>
              <button className="title-btn" onClick={() => {
                setResult(null)
                setSummaryText('')
                setThinkText('')
              }} data-tooltip="重新生成">
                <RefreshCw size={14} />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="content">

        {!result && !isGenerating && (
          <div className="setup-panel">
            <div className="time-range-section">
              <h3>选择时间范围</h3>
              <div className="time-range-grid">
                {TIME_RANGE_OPTIONS.map(option => (
                  <label
                    key={option.days}
                    className={`time-range-card ${timeRangeDays === option.days ? 'active' : ''}`}
                  >
                    <input
                      type="radio"
                      name="timeRange"
                      value={option.days}
                      checked={timeRangeDays === option.days}
                      onChange={() => {
                        setTimeRangeDays(option.days)
                        setCustomDays('')
                      }}
                    />
                    <span className="range-label">{option.label}</span>
                  </label>
                ))}
              </div>

              <div className="custom-days-input">
                <label>自定义天数：</label>
                <input
                  type="number"
                  min="1"
                  placeholder="输入天数"
                  value={customDays}
                  onChange={(e) => {
                    const value = e.target.value
                    setCustomDays(value)
                    if (value && parseInt(value) > 0) {
                      setTimeRangeDays(parseInt(value))
                    }
                  }}
                />
              </div>

              <h3>自定义要求（可选）</h3>
              <textarea
                className="custom-requirement"
                placeholder="例如：重点关注工作相关的讨论、提取所有待办事项、总结技术问题..."
                value={customRequirement}
                onChange={(e) => setCustomRequirement(e.target.value)}
                rows={3}
              />

              {error && (
                <div className="error-message">{error}</div>
              )}

              <button
                className="generate-button"
                onClick={handleGenerate}
                disabled={!sessionId}
              >
                <Send size={16} />
                <span>开始生成摘要</span>
              </button>
            </div>

            {history.length > 0 && (
              <div className="history-section">
                <h3>历史记录</h3>
                <div className="history-list">
                  {history.map((item) => (
                    <div
                      key={item.id}
                      className="history-item"
                      onClick={() => {
                        setResult(item)
                        loadProviderInfo(item.provider)
                      }}
                    >
                      <div className="history-header">
                        <span className="history-name">{item.customName || '自定义记录名'}</span>
                        <span className="history-date">
                          {new Date(item.createdAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}
                        </span>
                      </div>
                      <div className="history-range">{item.timeRangeDays}天</div>
                      <div className="history-info">
                        <span>{item.messageCount}条消息</span>
                        <span>¥{item.cost.toFixed(4)}</span>
                      </div>
                      <div className="history-actions">
                        <button
                          className="action-btn rename-btn"
                          onClick={(e) => handleRenameHistory(item.id!, (item as any).customName || `${item.timeRangeDays}天摘要`, e)}
                          data-tooltip="重命名"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
                          </svg>
                        </button>
                        <button
                          className="action-btn delete-btn"
                          onClick={(e) => handleDeleteHistory(item.id!, e)}
                          data-tooltip="删除"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {isGenerating && (
          <div className="generating-panel">
            {/* 加载提示 - 在没有内容时显示 */}
            {!summaryText && !thinkText && (
              <div className="loading-hint">
                <Loader2 className="loading-spinner" size={32} />
                <p className="loading-text">正在准备数据...</p>
                <p className="loading-subtext">正在从数据库读取消息并构建提示词</p>
              </div>
            )}
            
            <div className="summary-preview">
              {/* 思考过程 - 生成时显示 */}
              {thinkText && (
                <div className={`think-panel ${!showThink ? 'collapsed' : ''} ${isThinking ? 'thinking' : ''}`}>
                  <div className="think-header" onClick={() => setShowThink(!showThink)}>
                    <div className="think-title">
                      {isThinking ? (
                        <LoaderPinwheel
                          size={14}
                          className="think-icon animate-spin"
                        />
                      ) : (
                        <Atom
                          size={14}
                          className="think-icon"
                        />
                      )}
                      <span>{isThinking ? '深度思考中...' : '深度思考'}</span>
                    </div>
                    <ChevronDown 
                      size={16} 
                      className={`toggle-icon ${showThink ? 'expanded' : ''}`}
                    />
                  </div>
                  <div 
                    className="think-content markdown-body" 
                    ref={thinkContentRef}
                    dangerouslySetInnerHTML={renderMarkdown(thinkText)}
                  />
                </div>
              )}

              <div
                className="summary-text-content markdown-body"
                dangerouslySetInnerHTML={renderMarkdown(summaryText)}
              />
            </div>
          </div>
        )}

        {result && !isGenerating && (
          <div className="result-panel">
            <div className="summary-content">
              {(() => {
                const content = result.summaryText || ''
                let thinkContent = ''
                let mainContent = content
                let hasThink = false

                if (content.includes('<think>') && content.includes('</think>')) {
                  const parts = content.split('<think>')
                  const pre = parts[0]
                  const rest = parts[1]
                  const parts2 = rest.split('</think>')
                  thinkContent = parts2[0]
                  mainContent = pre + (parts2[1] || '')
                  hasThink = true
                }

                return (
                  <>
                    {hasThink && (
                      <div className={`think-panel ${!showThink ? 'collapsed' : ''}`}>
                        <div className="think-header" onClick={() => setShowThink(!showThink)}>
                          <div className="think-title">
                            <Atom size={14} className="think-icon" />
                            <span>深度思考</span>
                          </div>
                          <ChevronDown 
                            size={16} 
                            className={`toggle-icon ${showThink ? 'expanded' : ''}`}
                          />
                        </div>
                        <div 
                          className="think-content markdown-body"
                          dangerouslySetInnerHTML={renderMarkdown(thinkContent)}
                        />
                      </div>
                    )}
                    <div
                      className="markdown-body"
                      dangerouslySetInnerHTML={renderMarkdown(mainContent.trim())}
                    />
                    
                    {/* AI 生成提示 */}
                    {resultProviderInfo && (
                      <div className="ai-disclaimer">
                        <hr className="divider" />
                        <div className="disclaimer-content">
                          {resultProviderInfo.logo && (
                            <div className="ai-provider-badge-small">
                              <img src={resultProviderInfo.logo} alt="AI" />
                            </div>
                          )}
                          <span className="disclaimer-text">
                            内容由 {resultProviderInfo.displayName} 生成，请仔细甄别！
                          </span>
                        </div>
                      </div>
                    )}
                  </>
                )
              })()}
            </div>
          </div>
        )}
      </div>

      {/* 删除确认对话框 */}
      {showDeleteDialog && (
        <div className="dialog-overlay" onClick={() => setShowDeleteDialog(false)}>
          <div className="dialog-box" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header">
              <h3>确认删除</h3>
            </div>
            <div className="dialog-content">
              <p>确定要删除这条摘要记录吗？此操作无法撤销。</p>
            </div>
            <div className="dialog-actions">
              <button className="dialog-btn cancel-btn" onClick={() => setShowDeleteDialog(false)}>
                取消
              </button>
              <button className="dialog-btn confirm-btn delete" onClick={confirmDelete}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 重命名对话框 */}
      {showRenameDialog && (
        <div className="dialog-overlay" onClick={() => setShowRenameDialog(false)}>
          <div className="dialog-box" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header">
              <h3>重命名摘要</h3>
            </div>
            <div className="dialog-content">
              <input
                type="text"
                className="rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder="请输入新名称"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    confirmRename()
                  } else if (e.key === 'Escape') {
                    setShowRenameDialog(false)
                  }
                }}
              />
            </div>
            <div className="dialog-actions">
              <button className="dialog-btn cancel-btn" onClick={() => setShowRenameDialog(false)}>
                取消
              </button>
              <button className="dialog-btn confirm-btn" onClick={confirmRename}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default AISummaryWindow
