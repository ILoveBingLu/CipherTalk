import { useEffect, useState } from 'react'
import * as configService from '../services/config'
import { Save, RefreshCw, RotateCcw, Eye, EyeOff, Sparkles, Copy, FileText, AlertCircle } from 'lucide-react'
import { useTitleBarStore } from '../stores/titleBarStore'
import './SettingsPage.scss'

function OpenApiPage() {
  const HTTP_API_DOC_URL = 'https://ciphertalk.apifox.cn/'

  const [message, setMessage] = useState<{ text: string; success: boolean } | null>(null)
  const [httpApiEnabled, setHttpApiEnabled] = useState(false)
  const [httpApiPort, setHttpApiPort] = useState(5031)
  const [httpApiToken, setHttpApiToken] = useState('')
  const [showHttpApiToken, setShowHttpApiToken] = useState(false)
  const [httpApiStatus, setHttpApiStatus] = useState<{
    running: boolean
    host: string
    port: number
    enabled: boolean
    startedAt: string
    uptimeMs: number
    tokenConfigured: boolean
    tokenPreview: string
    baseUrl: string
    endpoints: Array<{ method: string; path: string; desc: string }>
    lastError: string
  } | null>(null)
  const [isSavingHttpApi, setIsSavingHttpApi] = useState(false)
  const [isRefreshingHttpApi, setIsRefreshingHttpApi] = useState(false)
  const [nowTs, setNowTs] = useState(Date.now())

  const showMessage = (text: string, success: boolean) => {
    setMessage({ text, success })
    setTimeout(() => setMessage(null), 3000)
  }

  const copyText = async (text: string, successText: string) => {
    try {
      await navigator.clipboard.writeText(text)
      showMessage(successText, true)
    } catch {
      showMessage('复制失败，请手动复制', false)
    }
  }

  const createRandomToken = () => {
    const randomPart = Math.random().toString(36).slice(2)
    const randomPart2 = Math.random().toString(36).slice(2)
    return `ct_${Date.now().toString(36)}_${randomPart}${randomPart2}`
  }

  useEffect(() => {
    const load = async () => {
      try {
        const enabled = await configService.getHttpApiEnabled()
        const port = await configService.getHttpApiPort()
        const token = await configService.getHttpApiToken()
        setHttpApiEnabled(enabled)
        setHttpApiPort(port)
        setHttpApiToken(token)

        const statusResult = await window.electronAPI.httpApi.getStatus()
        if (statusResult.success && statusResult.status) {
          setHttpApiStatus(statusResult.status)
        }
      } catch (e) {
        showMessage(`加载开放接口配置失败: ${e}`, false)
      }
    }
    load()
  }, [])

  useEffect(() => {
    if (!httpApiStatus?.running) return
    const timer = window.setInterval(() => setNowTs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [httpApiStatus?.running])

  const setTitleBarContent = useTitleBarStore(state => state.setRightContent)

  useEffect(() => {
    setTitleBarContent(
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => window.electronAPI.shell.openExternal(HTTP_API_DOC_URL)}
        style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
      >
        <FileText size={14} /> 接口文档
      </button>
    )
    return () => setTitleBarContent(null)
  }, [setTitleBarContent])

  const refreshHttpApiStatus = async () => {
    setIsRefreshingHttpApi(true)
    try {
      const result = await window.electronAPI.httpApi.getStatus()
      if (result.success && result.status) {
        setHttpApiStatus(result.status)
        setHttpApiEnabled(result.status.enabled)
        setHttpApiPort(result.status.port)
      } else {
        showMessage(result.error || '获取接口状态失败', false)
      }
    } catch (e) {
      showMessage(`获取接口状态失败: ${e}`, false)
    } finally {
      setIsRefreshingHttpApi(false)
    }
  }

  const handleSaveHttpApiSettings = async () => {
    setIsSavingHttpApi(true)
    try {
      const result = await window.electronAPI.httpApi.applySettings({
        enabled: httpApiEnabled,
        port: httpApiPort,
        token: httpApiToken
      })

      if (result.success && result.status) {
        setHttpApiStatus(result.status)
        setHttpApiPort(result.status.port)
        await configService.setHttpApiEnabled(httpApiEnabled)
        await configService.setHttpApiPort(result.status.port)
        await configService.setHttpApiToken(httpApiToken)
        showMessage('开放接口配置已保存并生效', true)
      } else {
        showMessage(result.error || '保存开放接口配置失败', false)
      }
    } catch (e) {
      showMessage(`保存开放接口配置失败: ${e}`, false)
    } finally {
      setIsSavingHttpApi(false)
    }
  }

  const handleRestartHttpApi = async () => {
    setIsRefreshingHttpApi(true)
    try {
      const result = await window.electronAPI.httpApi.restart()
      if (result.success && result.status) {
        setHttpApiStatus(result.status)
        showMessage('接口服务已重启', true)
      } else {
        showMessage(result.error || '接口服务重启失败', false)
      }
    } catch (e) {
      showMessage(`接口服务重启失败: ${e}`, false)
    } finally {
      setIsRefreshingHttpApi(false)
    }
  }

  const status = httpApiStatus
  const startedAtMs = status?.startedAt ? new Date(status.startedAt).getTime() : 0
  const uptime = status?.running && startedAtMs > 0
    ? Math.max(0, nowTs - startedAtMs)
    : (status?.uptimeMs ?? 0)
  const uptimeText = uptime > 0 ? `${Math.floor(uptime / 1000)} 秒` : '0 秒'

  return (
    <div className="settings-page">
      {message && <div className={`message-toast ${message.success ? 'success' : 'error'}`}>{message.text}</div>}

      <div className="settings-body" style={{ marginTop: '0', paddingTop: '24px' }}>
        <div className="tab-content" style={{ paddingTop: '0' }}>
          <section className="settings-section api-settings">
            <h3 className="section-title">开放接口（HTTP API）</h3>
            <div className="section-desc">用于给外部工具调用，默认仅监听本机地址 `127.0.0.1`。</div>

            <div className="form-group">
              <div className="switch-setting">
                <div className="switch-setting-main">
                  <div>
                    <div className="switch-title">启用 HTTP API</div>
                    <div className="switch-desc">关闭后将停止监听端口，不再对外提供接口。</div>
                  </div>
                  <button
                    type="button"
                    className={`api-switch ${httpApiEnabled ? 'on' : 'off'}`}
                    aria-label={httpApiEnabled ? '关闭 HTTP API' : '启用 HTTP API'}
                    title={httpApiEnabled ? '点击关闭' : '点击启用'}
                    onClick={() => setHttpApiEnabled((v) => !v)}
                  >
                    <span className="api-switch-thumb" />
                  </button>
                </div>
              </div>
            </div>

            <div className="form-group">
              <label>监听端口</label>
              <span className="form-hint">建议保持默认 5031，范围 1-65535</span>
              <input
                type="number"
                min={1}
                max={65535}
                value={httpApiPort}
                onChange={(e) => setHttpApiPort(Number(e.target.value || 5031))}
              />
            </div>

            <div className="form-group">
              <label>访问密钥（可选）</label>
              <span className="form-hint">令牌预设说明：留空表示不鉴权；设置后，`/v1/status` 等接口必须携带 `Authorization: Bearer &lt;token&gt;`。</span>
              <div className="input-inline-actions">
                <input
                  type={showHttpApiToken ? 'text' : 'password'}
                  value={httpApiToken}
                  onChange={(e) => setHttpApiToken(e.target.value)}
                  placeholder="留空表示不启用令牌鉴权"
                />
                <div className="inline-actions">
                  <button
                    type="button"
                    className="inline-icon-btn"
                    title={showHttpApiToken ? '隐藏密钥' : '显示密钥'}
                    aria-label={showHttpApiToken ? '隐藏密钥' : '显示密钥'}
                    onClick={() => setShowHttpApiToken((v) => !v)}
                  >
                    {showHttpApiToken ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                  <button
                    type="button"
                    className="inline-icon-btn"
                    title="生成随机密钥"
                    aria-label="生成随机密钥"
                    onClick={() => setHttpApiToken(createRandomToken())}
                  >
                    <Sparkles size={16} />
                  </button>
                </div>
              </div>
            </div>

            <div className="btn-row">
              <button className="btn btn-primary" onClick={handleSaveHttpApiSettings} disabled={isSavingHttpApi}>
                <Save size={16} /> {isSavingHttpApi ? '保存中...' : '保存并应用'}
              </button>
              <button className="btn btn-secondary" onClick={refreshHttpApiStatus} disabled={isRefreshingHttpApi}>
                <RefreshCw size={16} className={isRefreshingHttpApi ? 'spin' : ''} /> 刷新状态
              </button>
              <button className="btn btn-secondary" onClick={handleRestartHttpApi} disabled={isRefreshingHttpApi}>
                <RotateCcw size={16} /> 重启服务
              </button>
            </div>
          </section>

          <div className="divider" style={{ margin: '2rem 0', borderBottom: '1px solid var(--border-color)', opacity: 0.1 }} />

          <section className="settings-section api-settings">
            <h3 className="section-title">接口状态与信息</h3>

            {status ? (
              <>
                <div className="api-status-grid">
                  <div className="api-status-card">
                    <div className="api-status-label">运行状态</div>
                    <div className={`api-status-value ${status.running ? 'ok' : 'error'}`}>{status.running ? '运行中' : '未运行'}</div>
                  </div>
                  <div className="api-status-card">
                    <div className="api-status-label">监听地址</div>
                    <div className="api-status-value mono">{status.host}:{status.port}</div>
                  </div>
                  <div className="api-status-card">
                    <div className="api-status-label">运行时长</div>
                    <div className="api-status-value">{uptimeText}</div>
                  </div>
                  <div className="api-status-card">
                    <div className="api-status-label">鉴权状态</div>
                    <div className="api-status-value">{status.tokenConfigured ? '已启用' : '未启用'}</div>
                  </div>
                </div>

                <div className="form-group" style={{ marginTop: '16px' }}>
                  <label>基础地址</label>
                  <div className="input-inline-actions">
                    <input type="text" value={status.baseUrl} readOnly />
                    <div className="inline-actions">
                      <button
                        type="button"
                        className="inline-icon-btn"
                        title="复制基础地址"
                        aria-label="复制基础地址"
                        onClick={() => copyText(status.baseUrl, '基础地址已复制')}
                      >
                        <Copy size={16} />
                      </button>
                    </div>
                  </div>
                </div>

                <div className="form-group">
                  <label>令牌预览</label>
                  <div className="input-inline-actions">
                    <input type="text" value={status.tokenConfigured ? status.tokenPreview : '未配置'} readOnly />
                    <div className="inline-actions">
                      {status.tokenConfigured && (
                        <button
                          type="button"
                          className="inline-icon-btn"
                          title="复制访问密钥"
                          aria-label="复制访问密钥"
                          onClick={() => copyText(httpApiToken, '访问密钥已复制')}
                        >
                          <Copy size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {status.lastError && (
                  <div className="unavailable-notice" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--danger)' }}>
                    <AlertCircle size={16} />
                    <p>最近错误：{status.lastError}</p>
                  </div>
                )}
              </>
            ) : (
              <p>尚未读取到接口状态，请点击“刷新状态”。</p>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

export default OpenApiPage
