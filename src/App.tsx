import { useEffect, useState } from 'react'
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import RouteGuard from './components/RouteGuard'
import DecryptProgressOverlay from './components/DecryptProgressOverlay'
import WelcomePage from './pages/WelcomePage'
import HomePage from './pages/HomePage'
import ChatPage from './pages/ChatPage'
import AnalyticsPage from './pages/AnalyticsPage'
import AnnualReportPage from './pages/AnnualReportPage'
import AnnualReportWindow from './pages/AnnualReportWindow'
import AgreementPage from './pages/AgreementPage'
import GroupAnalyticsPage from './pages/GroupAnalyticsPage'
import DataManagementPage from './pages/DataManagementPage'
import SettingsPage from './pages/SettingsPage'
import ExportPage from './pages/ExportPage'
import ActivationPage from './pages/ActivationPage'
import ImageWindow from './pages/ImageWindow'
import VideoWindow from './pages/VideoWindow'
import BrowserWindowPage from './pages/BrowserWindowPage'
import SplashPage from './pages/SplashPage'
import AISummaryWindow from './pages/AISummaryWindow'
import ChatHistoryPage from './pages/ChatHistoryPage'
import MomentsWindow from './pages/MomentsWindow'
import { useAppStore } from './stores/appStore'
import { useThemeStore } from './stores/themeStore'
import { useChatStore } from './stores/chatStore'
import { useUpdateStatusStore } from './stores/updateStatusStore'
import { useActivationStore } from './stores/activationStore'
import * as configService from './services/config'
import { initTldList } from './utils/linkify'
import LockScreen from './pages/LockScreen'
import { useAuthStore } from './stores/authStore'
import { X, Shield, Loader2 } from 'lucide-react'
import './App.scss'

function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const { setDbConnected } = useAppStore()
  const { currentTheme, themeMode, isLoaded, loadTheme } = useThemeStore()
  const { status: activationStatus, checkStatus: checkActivationStatus, initialized: activationInitialized } = useActivationStore()
  const { isLocked, init: initAuth } = useAuthStore()


  // 协议同意状态
  const [showAgreement, setShowAgreement] = useState(false)
  const [agreementLoading, setAgreementLoading] = useState(true)

  // 激活状态
  const [showActivation, setShowActivation] = useState(false)

  // 更新提示状态
  const [updateInfo, setUpdateInfo] = useState<{ version: string; releaseNotes: string } | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null)

  // 加载主题配置
  useEffect(() => {
    loadTheme()
    // 初始化 TLD 列表（优先从缓存读取）
    initTldList()
    // 初始化认证状态
    initAuth()
  }, [loadTheme])

  // 应用主题
  useEffect(() => {
    if (!isLoaded) return
    document.documentElement.setAttribute('data-theme', currentTheme)

    const applyMode = (mode: string) => {
      document.documentElement.setAttribute('data-mode', mode)
      window.electronAPI.window.setTitleBarOverlay({ symbolColor: mode === 'dark' ? '#ffffff' : '#1a1a1a' })
    }

    if (themeMode === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      applyMode(mq.matches ? 'dark' : 'light')
      const handler = (e: MediaQueryListEvent) => applyMode(e.matches ? 'dark' : 'light')
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    } else {
      applyMode(themeMode)
    }
  }, [currentTheme, themeMode, isLoaded])

  // 检查是否需要显示协议
  useEffect(() => {
    const checkAgreement = async () => {
      try {
        const needShow = await configService.needShowAgreement()
        if (needShow) {
          setShowAgreement(true)
        }
      } catch (e) {
        console.error('检查协议状态失败:', e)
      } finally {
        setAgreementLoading(false)
      }
    }
    checkAgreement()
  }, [])

  const handleAgree = async () => {
    await configService.acceptCurrentAgreement()
    setShowAgreement(false)
    // 协议同意后检查激活状态
    const status = await checkActivationStatus()
    if (!status?.isActivated || (status.daysRemaining !== null && status.daysRemaining <= 0)) {
      setShowActivation(true)
    }
  }

  const handleDisagree = () => {
    window.electronAPI.window.close()
  }

  // 检查激活状态（协议同意后）
  useEffect(() => {
    if (!showAgreement && !agreementLoading && !activationInitialized) {
      checkActivationStatus().then(status => {
        if (!status?.isActivated || (status.daysRemaining !== null && status.daysRemaining <= 0)) {
          setShowActivation(true)
        }
      })
    }
  }, [showAgreement, agreementLoading, activationInitialized])

  const handleActivated = () => {
    setShowActivation(false)
  }

  // 监听启动时的更新通知
  useEffect(() => {
    const removeUpdateListener = window.electronAPI.app.onUpdateAvailable?.((info) => {
      setUpdateInfo(info)
    })

    // 监听数据库是否有更新（正在解密同步）
    const removeUpdateAvailableListener = window.electronAPI.dataManagement.onUpdateAvailable?.((hasUpdate) => {
      const time = new Date().toLocaleTimeString()
      if (hasUpdate) {
        console.log(`[${time}] [自动更新] 检测到源数据库有变化，开始同步...`)
        useUpdateStatusStore.getState().setIsUpdating(true)
        useUpdateStatusStore.getState().addLog('检测到源数据库有更新，正在同步...')
      } else {
        console.log(`[${time}] [自动更新] 同步进程结束`)
        useUpdateStatusStore.getState().setIsUpdating(false)
      }
    })

    // 监听会话自动更新（静默增量同步）
    const removeSessionsListener = window.electronAPI.chat.onSessionsUpdated?.((sessions) => {
      const time = new Date().toLocaleTimeString()
      console.log(`[${time}] [自动增量更新] 收到新数据，当前活跃会话:`, sessions.length)
      useUpdateStatusStore.getState().addLog(`自动同步完成 (${sessions.length}个会话)`)
      useChatStore.getState().setSessions(sessions)
    })

    return () => {
      removeUpdateListener?.()
      removeSessionsListener?.()
      removeUpdateAvailableListener?.()
    }
  }, [])

  // 监听下载进度
  useEffect(() => {
    const removeDownloadListener = window.electronAPI.app.onDownloadProgress?.((progress) => {
      setDownloadProgress(progress)
    })
    return () => {
      removeDownloadListener?.()
    }
  }, [])

  const dismissUpdate = () => {
    setUpdateInfo(null)
  }

  // 检查是否是独立聊天窗口
  const isChatWindow = location.pathname === '/chat-window'
  const isGroupAnalyticsWindow = location.pathname === '/group-analytics-window'
  const isMomentsWindow = location.pathname === '/moments-window'
  const isAnnualReportWindow = location.pathname === '/annual-report-window'
  const isAgreementWindow = location.pathname === '/agreement-window'
  const isAISummaryWindow = location.pathname === '/ai-summary-window'
  const isWelcomeWindow = location.pathname === '/welcome-window'

  // 启动时自动检查配置并连接数据库
  useEffect(() => {
    // 独立窗口不需要自动连接主数据库
    if (isChatWindow || isGroupAnalyticsWindow || isMomentsWindow || isAnnualReportWindow || isAgreementWindow || isAISummaryWindow || location.pathname === '/image-viewer-window') return

    const autoConnect = async () => {
      try {
        const dbPath = await configService.getDbPath()
        const decryptKey = await configService.getDecryptKey()
        const wxid = await configService.getMyWxid()

        // 如果配置完整，检查启动时是否已经连接
        if (dbPath && decryptKey && wxid) {
          // 先检查启动屏阶段是否已经成功连接
          const startupConnected = await window.electronAPI.app.getStartupDbConnected?.()
          if (startupConnected) {
            console.log('启动时已通过启动屏连接数据库，跳过重复连接')
            setDbConnected(true, dbPath)
            // 预加载用户信息
            await preloadUserInfo()
            // 如果当前在欢迎页，跳转到首页
            if (window.location.hash === '#/' || window.location.hash === '') {
              navigate('/home')
            }
            return
          }

          // 启动屏未连接，执行自动连接
          console.log('检测到已保存的配置，正在自动连接...')
          const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid, true) // 标记为自动连接

          if (result.success) {
            console.log('自动连接成功')
            setDbConnected(true, dbPath)
            // 预加载用户信息
            await preloadUserInfo()
            // 如果当前在欢迎页，跳转到首页
            if (window.location.hash === '#/' || window.location.hash === '') {
              navigate('/home')
            }
          } else {
            console.log('自动连接失败:', result.error)
          }
        }
      } catch (e) {
        console.error('自动连接出错:', e)
      }
    }

    // 预加载用户信息
    const preloadUserInfo = async () => {
      try {
        const result = await window.electronAPI.chat.getMyUserInfo()
        if (result.success && result.userInfo) {
          useAppStore.getState().setUserInfo({
            wxid: result.userInfo.wxid,
            nickName: result.userInfo.nickName,
            alias: result.userInfo.alias,
            avatarUrl: result.userInfo.avatarUrl
          })
          console.log('用户信息预加载完成')
        } else {
          useAppStore.getState().setUserInfo(null)
        }
      } catch (e) {
        console.error('预加载用户信息失败:', e)
        useAppStore.getState().setUserInfo(null)
      }
    }

    autoConnect()
  }, [isChatWindow, isGroupAnalyticsWindow])

  // 独立聊天窗口 - 只显示聊天页面，无侧边栏
  if (isChatWindow) {
    return (
      <div className="chat-window-container">
        <ChatPage />
      </div>
    )
  }

  // 独立群聊分析窗口
  if (isGroupAnalyticsWindow) {
    return (
      <div className="chat-window-container">
        <GroupAnalyticsPage />
      </div>
    )
  }

  // 独立朋友圈窗口
  if (isMomentsWindow) {
    return (
      <div className="chat-window-container">
        <MomentsWindow />
      </div>
    )
  }

  // 独立年度报告窗口
  if (isAnnualReportWindow) {
    return (
      <div className="chat-window-container">
        <AnnualReportWindow />
      </div>
    )
  }

  // 独立 AI 摘要窗口
  if (isAISummaryWindow) {
    return <AISummaryWindow />
  }

  // 独立聊天记录窗口
  if (location.pathname.startsWith('/chat-history/')) {
    return (
      <div className="chat-window-container">
        <ChatHistoryPage />
      </div>
    )
  }

  // 独立引导窗口
  if (isWelcomeWindow) {
    return <WelcomePage standalone />
  }

  // 独立图片查看窗口
  if (location.pathname === '/image-viewer-window') {
    return <ImageWindow />
  }

  // 独立视频播放窗口
  if (location.pathname === '/video-player-window') {
    return <VideoWindow />
  }

  // 独立协议窗口
  if (isAgreementWindow) {
    return <AgreementPage />
  }

  // 独立浏览器窗口
  if (location.pathname === '/browser-window') {
    return <BrowserWindowPage />
  }

  // 启动屏
  if (location.pathname === '/splash') {
    return <SplashPage />
  }

  // 首次启动协议弹窗 - 全屏遮罩，不可关闭
  if (showAgreement && !agreementLoading) {
    return (
      <div className="app-container">
        <div className="agreement-fullscreen">
          <div className="agreement-window">
            <div className="agreement-window-header">
              <Shield size={28} />
              <h2>用户协议与隐私政策 <span style={{ fontSize: '14px', fontWeight: 'normal', opacity: 0.6 }}>v{configService.CURRENT_AGREEMENT_VERSION}.0</span></h2>
            </div>
            <div className="agreement-window-body">
              <p className="agreement-intro">欢迎使用密语！在使用本软件前，请仔细阅读并同意以下条款：</p>

              <div className="agreement-scroll">
                <h3>一、用户协议</h3>

                <h4>1. 软件性质与用途说明</h4>
                <p>1.1 本软件是一款技术研究工具，用于读取和分析用户本地设备上已存在的微信数据文件，主要功能包括但不限于：本地数据文件解析、聊天记录查看、数据统计分析、年度报告生成及数据导出。</p>
                <p>1.2 本软件仅供用户个人学习、研究和技术交流之目的使用，不得用于任何商业用途。</p>
                <p>1.3 本软件仅作为数据查看工具，不具备也不提供任何主动获取、拦截、窃取数据的能力，所有操作均基于用户本地设备上已存在的文件。</p>

                <h4>2. 使用限制</h4>
                <p>2.1 用户不得将本软件用于任何违反中华人民共和国法律法规、行政规章、社会公序良俗的用途，包括但不限于侵犯他人隐私权、个人信息权益、商业秘密或其他合法权益。</p>
                <p>2.2 用户不得将本软件用于任何形式的商业使用、商业分发、商业服务、盈利活动或变相商业用途。</p>
                <p>2.3 用户不得对本软件进行反向工程、反编译、反汇编，或以其他方式试图获取本软件的源代码（法律法规另有明确规定的除外）。</p>

                <h4>3. 数据归属与用户责任</h4>
                <p>3.1 用户理解并确认，本软件所读取的微信聊天数据的知识产权及相关权益归属于腾讯公司及相关权利方，本软件及其开发者不主张对该等数据的任何所有权。</p>
                <p>3.2 用户应自行确保其使用本软件的行为符合微信及腾讯相关产品的服务条款、用户协议及适用的法律法规。因用户使用本软件而产生的任何法律责任、纠纷、索赔、处罚或损失，均由用户自行承担，与本软件开发者无任何关联。</p>
                <p>3.3 用户理解并确认，使用本软件可能涉及对本地数据文件的读取操作，用户应自行评估使用风险并做好数据备份，本软件及其开发者不对任何数据丢失、损坏或不可恢复承担责任。</p>
                <p>3.4 用户不得将通过本软件获取的任何数据用于侵犯他人隐私、诽谤、骚扰或其他违法违规用途。</p>

                <h4>4. 免责声明</h4>
                <p>4.1 本软件按"现状"提供，开发者不对本软件的适用性、准确性、完整性、稳定性、可靠性作出任何明示或暗示的保证。</p>
                <p>4.2 在法律允许的最大范围内，因使用或无法使用本软件所导致的任何直接损失、间接损失、附带损失、后果性损失（包括但不限于数据丢失、业务中断、设备损坏、名誉损失等），均由用户自行承担，开发者不承担任何责任。</p>
                <p>4.3 如因不可抗力、第三方原因、系统环境差异、软件冲突或用户自身操作不当导致的任何损失，开发者不承担任何责任。</p>

                <h4>5. 知识产权声明</h4>
                <p>5.1 本软件及其相关的所有内容（包括但不限于程序代码、界面设计、图标、文档说明等）的知识产权，均归开发者依法所有。</p>
                <p>5.2 未经开发者事先书面许可，任何单位或个人不得以任何形式复制、修改、传播、出租、出售或用于其他侵权行为。</p>

                <h4>6. 协议的变更与终止</h4>
                <p>6.1 开发者有权根据需要不定期对本协议进行修订，修订后的协议一经公布即生效。</p>
                <p>6.2 若用户在协议变更后继续使用本软件，即视为用户已接受修改后的协议内容。</p>
                <p>6.3 用户如不同意协议变更内容，应立即停止使用本软件。</p>

                <h4>7. 适用法律与争议解决</h4>
                <p>7.1 本协议的订立、执行、解释及争议解决均适用中华人民共和国大陆地区法律。</p>
                <p>7.2 因本协议或本软件使用所引起的任何争议，双方应首先友好协商解决；协商不成的，任何一方均可向开发者所在地有管辖权的人民法院提起诉讼。</p>

                <h3>二、AI服务说明（补充协议）</h3>
                <p>8.1 本软件提供的AI摘要功能调用第三方大模型服务（如智谱AI、DeepSeek等），相关对话数据将发送至第三方服务器进行处理。</p>
                <p>8.2 发送给AI的数据仅包含您选择的时间范围内的文本消息内容，不会包含图片、视频等文件数据，也不会包含此外的其他隐私信息。</p>
                <p>8.3 AI生成的内容仅供参考，不代表本软件开发者立场。用户在使用AI功能前应自行评估数据隐私风险。</p>
                <p>8.4 本软件不对第三方AI服务的稳定性、准确性及数据安全性承担责任。</p>

                <h3>三、隐私政策</h3>

                <h4>1. 数据收集声明</h4>
                <p>1.1 本软件不会以任何形式收集、存储、上传、分析或共享任何用户的个人信息或聊天数据。</p>
                <p>1.2 开发者无法也不会获取用户的聊天记录、账号信息或任何本地数据内容。</p>

                <h4>2. 本地数据处理说明</h4>
                <p>2.1 本软件的所有核心功能均在用户本地计算机环境中完成。</p>
                <p>2.2 所有解密、解析、统计、导出等操作均仅作用于用户本地文件，不会通过网络传输任何数据。</p>

                <h4>3. 网络请求说明</h4>
                <p>3.1 本软件仅在用户主动或默认启用"检查更新"功能时，访问网络以获取软件版本更新信息。</p>
                <p>3.2 更新检查过程中，不会上传任何用户数据、设备数据或使用行为数据。</p>

                <h4>4. 数据安全措施</h4>
                <p>4.1 本软件不建立服务器端数据存储，因此不存在服务器端数据泄露风险。</p>
                <p>4.2 用户应自行妥善保管其计算机设备及相关数据环境，因设备安全问题导致的风险由用户自行承担。</p>

                <h4>5. 用户权利</h4>
                <p>5.1 用户有权随时停止使用本软件，并自行删除本软件及相关本地文件。</p>
                <p>5.2 由于本软件不收集、不保存任何用户数据，开发者无需也无法提供数据查询、更正或删除服务。</p>

                <p className="agreement-notice">如您对本协议或隐私政策有任何疑问，请在使用前自行进行充分评估。再次提醒：一旦使用本软件，即视为您已完全理解并同意本协议的全部内容。</p>
                <div style={{
                  marginTop: '30px',
                  paddingTop: '20px',
                  borderTop: '1px dashed var(--border-color)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  color: 'var(--text-tertiary)',
                  fontSize: '12px'
                }}>
                  <span>协议版本：v{configService.CURRENT_AGREEMENT_VERSION}.0</span>
                  <span>更新日期：2026年01月23日</span>
                </div>
              </div>
            </div>
            <div className="agreement-window-footer">
              <p className="agreement-hint">点击"同意并继续"即表示您已阅读并同意以上条款</p>
              <div className="agreement-actions">
                <button className="btn btn-secondary" onClick={handleDisagree}>不同意并退出</button>
                <button className="btn btn-primary" onClick={handleAgree}>同意并继续</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // 激活页面 - 未激活或已过期时显示
  if (showActivation && !showAgreement) {
    return (
      <div className="app-container">
        <TitleBar />
        <ActivationPage onActivated={handleActivated} />
      </div>
    )
  }

  // 主窗口 - 完整布局
  return (
    <div className="app-container">
      <TitleBar />
      {updateInfo && (
        <div className="update-toast">
          <div className="update-toast-icon">🎉</div>
          <div className="update-toast-content">
            <div className="update-toast-title">发现新版本</div>
            <div className="update-toast-version">v{updateInfo.version} 已发布</div>
          </div>
          <button className="update-toast-btn" onClick={() => {
            window.electronAPI.app.downloadAndInstall()
            dismissUpdate()
          }}>
            立即更新
          </button>
          <button className="update-toast-close" onClick={dismissUpdate}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="main-layout">
        <Sidebar />
        <main className={`content ${location.pathname === '/data-management' ? 'no-overflow' : ''}`}>
          <RouteGuard>
            <Routes>
              <Route path="/" element={<WelcomePage />} />
              <Route path="/home" element={<HomePage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/annual-report" element={<AnnualReportPage />} />
              <Route path="/data-management" element={<DataManagementPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/export" element={<ExportPage />} />
              <Route path="/chat-history/:sessionId/:messageId" element={<ChatHistoryPage />} />
            </Routes>
          </RouteGuard>
        </main>
      </div>
      <DecryptProgressOverlay />
      {downloadProgress !== null && (
        <div className="download-progress-capsule">
          <Loader2 className="spin" size={14} />
          <span>正在下载更新... {downloadProgress.toFixed(0)}%</span>
          <div className="progress-bar-bg">
            <div className="progress-bar-fill" style={{ width: `${downloadProgress}%` }} />
          </div>
        </div>
      )}
      {isLocked && <LockScreen />}
    </div>
  )
}

export default App
