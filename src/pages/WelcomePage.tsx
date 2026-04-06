import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useThemeStore } from '../stores/themeStore'
import { useAppStore } from '../stores/appStore'
import { dialog } from '../services/ipc'
import * as configService from '../services/config'
import {
  ArrowLeft, ArrowRight, CheckCircle2, Eye, EyeOff,
  FolderOpen, ShieldCheck, Wand2, RotateCcw, Minus, X, Fingerprint, Lock
} from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import './WelcomePage.scss'

const steps = [
  { id: 'intro', title: '欢迎', desc: '准备开始你的本地数据探索' },
  { id: 'db', title: '数据库目录', desc: '定位微信数据目录' },
  { id: 'cache', title: '缓存目录', desc: '设置本地缓存存储位置' },
  { id: 'key', title: '解密密钥', desc: '获取密钥与自动识别账号' },
  { id: 'image', title: '图片密钥', desc: '获取 XOR 与 AES 密钥' },
  { id: 'security', title: '安全防护', desc: '配置应用锁保护隐私' },
  { id: 'decrypt', title: '解密数据库', desc: '测试连接并完成配置' }
]

interface WelcomePageProps {
  standalone?: boolean
}

function WelcomePage({ standalone = false }: WelcomePageProps) {
  const navigate = useNavigate()
  const { isDbConnected, setDbConnected } = useAppStore()
  const appIcon = useThemeStore(state => state.appIcon)
  const { enableAuth, disableAuth, isAuthEnabled } = useAuthStore()

  const [stepIndex, setStepIndex] = useState(0)
  const [dbPath, setDbPath] = useState('')
  const [decryptKey, setDecryptKey] = useState('')
  const [imageXorKey, setImageXorKey] = useState('')
  const [imageAesKey, setImageAesKey] = useState('')
  const [cachePath, setCachePath] = useState('')
  const [wxid, setWxid] = useState('')
  const [wxidOptions, setWxidOptions] = useState<string[]>([])
  const [isAccountVerified, setIsAccountVerified] = useState(false)
  const [isVerifyingAccount, setIsVerifyingAccount] = useState(false)
  const [error, setError] = useState('')

  const [isScanningWxid, setIsScanningWxid] = useState(false)
  const [isDetectingPath, setIsDetectingPath] = useState(false)
  const [isFetchingDbKey, setIsFetchingDbKey] = useState(false)
  const [isFetchingImageKey, setIsFetchingImageKey] = useState(false)
  const [showDecryptKey, setShowDecryptKey] = useState(false)
  const [dbKeyStatus, setDbKeyStatus] = useState('')
  const [imageKeyStatus, setImageKeyStatus] = useState('')
  const [authStatus, setAuthStatus] = useState('')
  const [isEnablingAuth, setIsEnablingAuth] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [showWechatPathPrompt, setShowWechatPathPrompt] = useState(false)
  const [customWechatPath, setCustomWechatPath] = useState('')
  const [showHookSuccessToast, setShowHookSuccessToast] = useState(false)
  const [isDecrypting, setIsDecrypting] = useState(false)
  const [decryptStatus, setDecryptStatus] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [hasCache, setHasCache] = useState(false)
  const [platformInfo, setPlatformInfo] = useState<{ platform: string; arch: string }>({
    platform: 'win32',
    arch: 'x64'
  })

  const isMac = platformInfo.platform === 'darwin'
  const biometricLabel = isMac ? 'Touch ID' : 'Windows Hello'

  useEffect(() => {
    const removeStatus = window.electronAPI.wxKey?.onStatus?.((payload) => {
      setDbKeyStatus(payload.status)
      // 检测到 Hook 安装成功的消息
      if (payload.status.includes('hook安装成功') || payload.status.includes('Hook安装成功')) {
        setShowHookSuccessToast(true)
        // 3秒后自动隐藏
        setTimeout(() => {
          setShowHookSuccessToast(false)
        }, 3000)
      }
    })
    const removeImageProgress = window.electronAPI.imageKey?.onProgress?.((msg) => {
      setImageKeyStatus(msg)
    })

    void window.electronAPI.app.getPlatformInfo().then(setPlatformInfo).catch(() => {
      // ignore
    })

    // 请求通知权限
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }

    // 从缓存加载配置
    const loadCachedConfig = () => {
      try {
        const cached = localStorage.getItem('welcomeConfig')
        if (cached) {
          const config = JSON.parse(cached)
          if (config.dbPath) {
            setDbPath(config.dbPath)
            setHasCache(true)
          }
          if (config.cachePath) {
            setCachePath(config.cachePath)
          }
          if (config.wxid) {
            setWxid(config.wxid)
          }
          if (config.decryptKey) {
            setDecryptKey(config.decryptKey)
          }
          if (config.imageXorKey) {
            setImageXorKey(config.imageXorKey)
          }
          if (config.imageAesKey) {
            setImageAesKey(config.imageAesKey)
          }
        }
      } catch (e) {
        console.error('加载缓存配置失败:', e)
      }
    }
    loadCachedConfig()

    // 自动检测最佳缓存路径（如果缓存中没有）
    const initCachePath = async () => {
      if (!cachePath) {
        try {
          const result = await window.electronAPI.dbPath.getBestCachePath()
          if (result.success && result.path) {
            setCachePath(result.path)
          }
        } catch (e) {
          console.error('获取缓存路径失败:', e)
        }
      }
    }
    initCachePath()

    return () => {
      removeStatus?.()
      removeImageProgress?.()
    }
  }, [])

  useEffect(() => {
    setWxidOptions([])
    setIsAccountVerified(false)
    // 注意：不要清空 wxid，因为它可能是从缓存加载的
    // setWxid('')
  }, [dbPath])

  const verifyAccountDirectory = async (candidateWxid: string, key: string, silent = false) => {
    if (!dbPath || !candidateWxid || key.length !== 64) {
      setIsAccountVerified(false)
      return false
    }

    setIsVerifyingAccount(true)
    try {
      const result = await window.electronAPI.wcdb.testConnection(dbPath, key, candidateWxid)
      if (result.success) {
        setIsAccountVerified(true)
        if (!silent) setDbKeyStatus(`账号目录验证成功：${candidateWxid}`)
        return true
      }

      setIsAccountVerified(false)
      if (!silent) setError(result.error || '账号目录验证失败，请重新选择')
      return false
    } catch (e) {
      setIsAccountVerified(false)
      if (!silent) setError(`账号目录验证失败: ${e}`)
      return false
    } finally {
      setIsVerifyingAccount(false)
    }
  }

  // 保存配置到缓存
  useEffect(() => {
    const config = {
      dbPath,
      cachePath,
      wxid,
      decryptKey,
      imageXorKey,
      imageAesKey
    }
    try {
      localStorage.setItem('welcomeConfig', JSON.stringify(config))
    } catch (e) {
      console.error('保存配置到缓存失败:', e)
    }
  }, [dbPath, cachePath, wxid, decryptKey, imageXorKey, imageAesKey])

  const currentStep = steps[stepIndex]
  const rootClassName = `welcome-page${isClosing ? ' is-closing' : ''}${standalone ? ' is-standalone' : ''}`
  const showWindowControls = standalone

  useEffect(() => {
    if (currentStep.id !== 'db') return
    if (dbPath) return
    if (isDetectingPath) return

    void handleAutoDetectPath(true)
  }, [currentStep.id, dbPath, isDetectingPath])

  const handleMinimize = () => {
    window.electronAPI.window.minimize()
  }

  const handleCloseWindow = () => {
    window.electronAPI.window.close()
  }

  const handleResetCachePath = async () => {
    try {
      const result = await window.electronAPI.dbPath.getBestCachePath()
      if (result.success && result.path) {
        setCachePath(result.path)
      }
    } catch (e) {
      setError('获取默认缓存路径失败')
    }
  }

  const handleSelectPath = async () => {
    try {
      const result = await dialog.openFile({
        title: '选择微信数据库目录',
        properties: ['openDirectory']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        setDbPath(result.filePaths[0])
        setError('')
      }
    } catch (e) {
      setError('选择目录失败')
    }
  }

  const handleAutoDetectPath = async (silent = false) => {
    if (isDetectingPath) return

    setIsDetectingPath(true)
    if (!silent) setError('')

    try {
      const result = await window.electronAPI.dbPath.autoDetect()
      if (result.success && result.path) {
        setDbPath(result.path)
        setError('')
        return
      }

      if (!silent) {
        setError(result.error || '未能自动检测到微信数据库目录')
      }
    } catch (e) {
      if (!silent) {
        setError(`自动检测失败: ${e}`)
      }
    } finally {
      setIsDetectingPath(false)
    }
  }

  const handleOpenDetectedPath = async () => {
    if (!dbPath) {
      setError('当前没有可打开的数据库目录')
      return
    }

    try {
      const result = await window.electronAPI.shell.openPath(dbPath)
      if (result) {
        setError(result)
      }
    } catch (e) {
      setError(`打开目录失败: ${e}`)
    }
  }



  const handleSelectCachePath = async () => {
    try {
      const result = await dialog.openFile({
        title: '选择缓存目录',
        properties: ['openDirectory']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        setCachePath(result.filePaths[0])
        setError('')
      }
    } catch (e) {
      setError('选择缓存目录失败')
    }
  }

  const handleScanWxid = async (silent = false) => {
    if (!dbPath) {
      if (!silent) setError('请先选择数据库目录')
      return []
    }
    if (isScanningWxid) return []
    setIsScanningWxid(true)
    if (!silent) setError('')
    try {
      const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
      setWxidOptions(wxids)
      setIsAccountVerified(false)
      if (wxids.length > 0) {
        let selectedWxid = ''

        if (decryptKey.length === 64) {
          const resolved = await window.electronAPI.wcdb.resolveValidWxid(dbPath, decryptKey)
          if (resolved.success && resolved.wxid && wxids.includes(resolved.wxid)) {
            selectedWxid = resolved.wxid
          }
        }

        if (!selectedWxid) {
          let accountInfo: { wxid: string; dbPath: string } | null = null
          accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 10)
          if (!accountInfo) {
            accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 60)
          }

          if (accountInfo && wxids.includes(accountInfo.wxid)) {
            selectedWxid = accountInfo.wxid
          }
        }

        if (!selectedWxid) {
          const wxidAccount = wxids.find(id => id.startsWith('wxid_'))
          selectedWxid = wxidAccount || wxids[0]
        }

        if (selectedWxid) {
          setWxid(selectedWxid)
          if (!silent) setError('')
        } else {
          if (!silent) setError('未能自动确定正确账号目录，请手动选择')
        }
      } else {
        if (!silent) setError('未检测到账号目录，请检查路径')
      }
      return wxids
    } catch (e) {
      if (!silent) setError(`扫描失败: ${e}`)
      return []
    } finally {
      setIsScanningWxid(false)
    }
  }

  const handleAutoGetDbKey = async (wechatPath?: string) => {
    if (isFetchingDbKey) return
    setIsFetchingDbKey(true)
    setError('')
    setDbKeyStatus('正在准备获取密钥...')
    try {
      const result = await window.electronAPI.wxKey.startGetKey(wechatPath, dbPath || undefined)
      if (result.success && result.key) {
        setDecryptKey(result.key)
        setDbKeyStatus('密钥获取成功，正在验证账号目录...')
        setError('')
        setShowWechatPathPrompt(false)

        if (dbPath) {
          const resolved = await window.electronAPI.wcdb.resolveValidWxid(dbPath, result.key)
          if (resolved.success && resolved.wxid) {
            setWxid(resolved.wxid)
            setIsAccountVerified(true)
            setDbKeyStatus(`密钥获取成功，已验证账号目录: ${resolved.wxid}`)
            return
          }
        }

        if (result.validatedWxid) {
          setWxid(result.validatedWxid)
          setDbKeyStatus(`密钥获取成功，已验证账号目录: ${result.validatedWxid}`)
          return
        }

        // 先尝试当前登录账号检测（强信号）
        let accountInfo: { wxid: string; dbPath: string } | null = null
        if (dbPath) {
          accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 10)
          if (!accountInfo) {
            accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 60)
          }
        }

        if (accountInfo) {
          setWxid(accountInfo.wxid)
          const ok = await verifyAccountDirectory(accountInfo.wxid, result.key, true)
          if (ok) {
            setDbKeyStatus(`密钥获取成功，已验证账号目录: ${accountInfo.wxid}`)
            return
          }
        }

        const wxids = await handleScanWxid(true)
        if (wxids.length > 1) {
          // 多账号时仅作为候选，等待用户选择后再验证
          setDbKeyStatus(`密钥获取成功，识别到 ${wxids.length} 个候选账号目录，请选择后验证`)
        } else if (wxids.length === 1) {
          const ok = await verifyAccountDirectory(wxids[0], result.key, true)
          setDbKeyStatus(ok ? '密钥获取成功，已自动识别并验证账号目录' : '密钥获取成功，请手动确认账号目录')
        } else {
          setDbKeyStatus('密钥获取成功，请手动选择并验证账号目录')
        }
      } else {
        if (result.needManualPath) {
          setShowWechatPathPrompt(true)
          setDbKeyStatus('需要手动选择微信安装位置')
        } else {
          setError(result.error || '自动获取密钥失败')
          setDbKeyStatus('')
        }
      }
    } catch (e) {
      setError(`自动获取密钥失败: ${e}`)
      setDbKeyStatus('')
    } finally {
      setIsFetchingDbKey(false)
    }
  }

  const handleSelectWechatPath = async () => {
    try {
      const result = await dialog.openFile({
        title: '选择微信程序 (Weixin.exe)',
        properties: ['openFile'],
        filters: [
          { name: '微信程序', extensions: ['exe'] }
        ]
      })

      if (!result.canceled && result.filePaths.length > 0) {
        const path = result.filePaths[0]
        if (path.toLowerCase().endsWith('weixin.exe')) {
          setCustomWechatPath(path)
          setError('')
        } else {
          setError('请选择 Weixin.exe 文件')
        }
      }
    } catch (e) {
      setError('选择文件失败')
    }
  }

  const handleConfirmWechatPath = () => {
    if (!customWechatPath) {
      setError('请先选择微信程序')
      return
    }
    handleAutoGetDbKey(customWechatPath)
  }

  const handleAutoGetImageKey = async () => {
    if (isFetchingImageKey) return
    if (!dbPath) {
      setError('请先选择数据库目录')
      return
    }
    setIsFetchingImageKey(true)
    setError('')
    setImageKeyStatus('正在准备获取图片密钥...')
    try {
      const accountPath = wxid ? `${dbPath}/${wxid}` : dbPath
      const result = await window.electronAPI.imageKey.getImageKeys(accountPath)
      if (result.success) {
        if (typeof result.xorKey === 'number') {
          setImageXorKey(`0x${result.xorKey.toString(16).toUpperCase().padStart(2, '0')}`)
        }
        if (result.aesKey) {
          setImageAesKey(result.aesKey)
        }
        setImageKeyStatus('已获取图片密钥')

        // 发送系统通知
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('CipherTalk - 图片密钥获取成功', {
            body: '已成功获取图片密钥，可以继续下一步操作',
            icon: appIcon === 'xinnian' ? './xinnian.png' : './logo.png'
          })
        }
      } else {
        setError(result.error || '自动获取图片密钥失败')
      }
    } catch (e) {
      setError(`自动获取图片密钥失败: ${e}`)
    } finally {
      setIsFetchingImageKey(false)
    }
  }

  const canGoNext = () => {
    if (currentStep.id === 'intro') return true
    if (currentStep.id === 'db') return Boolean(dbPath)
    if (currentStep.id === 'cache') return Boolean(cachePath)
    if (currentStep.id === 'key') return decryptKey.length === 64 && Boolean(wxid) && isAccountVerified
    if (currentStep.id === 'image') return true
    if (currentStep.id === 'security') return true
    if (currentStep.id === 'decrypt') return false // 最后一步，不能下一步
    return false
  }

  const handleNext = () => {
    if (!canGoNext()) {
      if (currentStep.id === 'db' && !dbPath) setError('请先选择数据库目录')
      if (currentStep.id === 'cache' && !cachePath) setError('请填写缓存目录')
      if (currentStep.id === 'key') {
        if (decryptKey.length !== 64) setError('密钥长度必须为 64 个字符')
        else if (!wxid) setError('请先选择账号目录')
        else if (!isAccountVerified) setError('账号目录尚未验证，请先验证后继续')
      }
      return
    }
    setError('')
    setStepIndex((prev) => Math.min(prev + 1, steps.length - 1))
  }

  const handleBack = () => {
    setError('')
    setStepIndex((prev) => Math.max(prev - 1, 0))
  }

  const handleStartDecrypt = async () => {
    if (!dbPath) { setError('请先选择数据库目录'); return }
    if (!wxid) { setError('请先选择账号目录'); return }
    if (!isAccountVerified) { setError('账号目录尚未验证，请先验证'); return }
    if (!decryptKey || decryptKey.length !== 64) { setError('请填写 64 位解密密钥'); return }

    setIsDecrypting(true)
    setError('')
    setDecryptStatus('正在保存配置...')

    try {
      // 先保存配置，因为 dataManagementService 需要从配置中读取这些信息
      await configService.setDbPath(dbPath)
      await configService.setDecryptKey(decryptKey)
      await configService.setMyWxid(wxid)
      await configService.setCachePath(cachePath)
      if (imageXorKey) {
        await configService.setImageXorKey(imageXorKey)
      }
      if (imageAesKey) {
        await configService.setImageAesKey(imageAesKey)
      }

      setDecryptStatus('正在测试数据库连接...')

      const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid)
      if (!result.success) {
        setError(result.error || 'WCDB 连接失败')
        setDecryptStatus('')
        setIsDecrypting(false)
        return
      }

      setDecryptStatus('连接成功，开始解密数据库...')

      // 监听解密进度
      const removeProgressListener = window.electronAPI.dataManagement.onProgress((data) => {
        if (data.type === 'decrypt') {
          if (data.fileProgress !== undefined) {
            setDecryptStatus(`正在解密 ${data.fileName} (${data.fileProgress}%)`)
          } else {
            setDecryptStatus(`正在解密数据库 (${data.current + 1}/${data.total})`)
          }
        } else if (data.type === 'complete') {
          setDecryptStatus('解密完成')
        } else if (data.type === 'error') {
          setError(data.error || '解密过程出错')
        }
      })

      // 执行解密
      const decryptResult = await window.electronAPI.wcdb.decryptDatabase(dbPath, decryptKey, wxid)

      // 移除进度监听
      removeProgressListener()

      if (!decryptResult.success) {
        setError(decryptResult.error || '数据库解密失败')
        setDecryptStatus('')
        setIsDecrypting(false)
        return
      }

      const totalFiles = (decryptResult.successCount || 0) + (decryptResult.failCount || 0)
      setDecryptStatus(`解密完成，共解密 ${decryptResult.successCount} 个数据库文件${decryptResult.failCount ? `，失败 ${decryptResult.failCount} 个` : ''}`)
      await new Promise(resolve => setTimeout(resolve, 1000))

      setDecryptStatus('配置保存成功，准备进入应用...')

      // 3秒倒计时，在倒计时期间清除缓存
      setCountdown(3)
      for (let i = 3; i > 0; i--) {
        setCountdown(i)
        setDecryptStatus(`配置保存成功，${i} 秒后进入应用...`)

        // 在倒计时第一秒时清除缓存
        if (i === 3) {
          try {
            localStorage.removeItem('welcomeConfig')
          } catch (e) {
            console.error('清除缓存配置失败:', e)
          }
        }

        await new Promise(resolve => setTimeout(resolve, 1000))
      }

      // 在跳转前设置连接状态
      setDbConnected(true, dbPath)

      if (standalone) {
        setIsClosing(true)
        setTimeout(() => {
          window.electronAPI.window.completeWelcome()
        }, 450)
      } else {
        navigate('/home')
      }
    } catch (e) {
      setError(`连接失败: ${e}`)
      setDecryptStatus('')
      setCountdown(0)
    } finally {
      setIsDecrypting(false)
    }
  }

  if (isDbConnected) {
    return (
      <div className={rootClassName}>
        {showWindowControls && (
          <div className="window-controls">
            <button type="button" className="window-btn" onClick={handleMinimize} aria-label="最小化">
              <Minus size={14} />
            </button>
            <button type="button" className="window-btn is-close" onClick={handleCloseWindow} aria-label="关闭">
              <X size={14} />
            </button>
          </div>
        )}
        <div className="welcome-shell">
          <div className="connected-panel">
            <div className="connected-icon">
              <CheckCircle2 size={48} />
            </div>
            <h1>已连接数据库</h1>
            <p>配置已完成，可以开始使用了</p>
            <button
              className="btn btn-primary btn-large"
              onClick={() => {
                if (standalone) {
                  setIsClosing(true)
                  setTimeout(() => {
                    window.electronAPI.window.completeWelcome()
                  }, 450)
                } else {
                  navigate('/home')
                }
              }}
            >
              进入首页
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={rootClassName}>
      {showWindowControls && (
        <div className="window-controls">
          <button type="button" className="window-btn is-close" onClick={handleCloseWindow} aria-label="关闭">
            <X size={14} />
          </button>
          <button type="button" className="window-btn" onClick={handleMinimize} aria-label="最小化">
            <Minus size={14} />
          </button>
        </div>
      )}

      {/* Hook 安装成功气泡提示 */}
      {showHookSuccessToast && (
        <div className="hook-success-toast">
          <CheckCircle2 size={18} />
          <span>Hook 安装成功，现在登录微信</span>
        </div>
      )}

      {/* 全屏倒计时覆盖层 */}
      {countdown > 0 && (
        <div className="countdown-overlay">
          <div className="countdown-content">
            <div className="countdown-number-large">{countdown}</div>
            <div className="countdown-text-large">秒后进入应用</div>
          </div>
        </div>
      )}

      <div className="welcome-shell">
        {/* 顶部进度条 */}
        <div className="progress-header">
          <div className="step-progress">
            {steps.map((step, index) => (
              <div key={step.id} className={`progress-step ${index === stepIndex ? 'active' : ''} ${index < stepIndex ? 'done' : ''}`}>
                <div className="progress-dot">
                  {index < stepIndex ? <CheckCircle2 size={16} /> : index + 1}
                </div>
                <div className="progress-label">{step.title}</div>
                {index < steps.length - 1 && <div className="progress-line" />}
              </div>
            ))}
          </div>
        </div>

        {/* 底部内容区 */}
        <div className="content-area">
          {/* 左侧说明 */}
          <div className="info-panel">
            <div className="panel-brand">
              <img src={appIcon === 'xinnian' ? "./xinnian.png" : "./logo.png"} alt="CipherTalk" className="brand-logo" />
              <div>
                <h1 className="brand-title">CipherTalk</h1>
                <p className="brand-subtitle">初始引导</p>
              </div>
            </div>

            <div className="info-divider"></div>

            <div className="step-header">
              <h2>{currentStep.title}</h2>
              <p className="info-desc">{currentStep.desc}</p>
            </div>

            {currentStep.id === 'intro' && (
              <div className="info-content">
                <h3>准备好了吗？</h3>
                <p>接下来只需配置数据库目录和获取解密密钥。</p>
                <div className="info-tips">
                  <div className="tip-item">
                    <CheckCircle2 size={16} />
                    <span>数据仅在本地处理</span>
                  </div>
                  <div className="tip-item">
                    <CheckCircle2 size={16} />
                    <span>不上传任何信息</span>
                  </div>
                  <div className="tip-item">
                    <CheckCircle2 size={16} />
                    <span>完全离线运行</span>
                  </div>
                </div>
              </div>
            )}

            {currentStep.id === 'db' && (
              <div className="info-content">
                <h3>自动获取数据库目录</h3>
                <p>系统会优先自动识别当前设备上的微信数据存储目录。</p>
                <ul className="info-list">
                  <li>进入本步骤后会先尝试自动检测</li>
                  <li>检测到结果后可直接打开文件夹确认</li>
                  <li>{isMac ? '若未命中，再手动选择版本目录或账号目录' : '若未命中，再按微信存储位置手动选择'}</li>
                </ul>
                {!isMac && (
                  <div className="info-warning">
                    <ShieldCheck size={16} />
                    <span>如路径包含中文，请在微信中更改存储位置</span>
                  </div>
                )}
              </div>
            )}

            {currentStep.id === 'cache' && (
              <div className="info-content">
                <h3>缓存目录说明</h3>
                <p>用于存储解密后的图片、表情等媒体文件。</p>
                <ul className="info-list">
                  <li>{isMac ? 'macOS 默认使用文稿目录下的 CipherTalkData' : '自动检测可用磁盘（优先 D、E、F 盘）'}</li>
                  <li>{isMac ? '也可以手动指定到其他本地目录' : '避免使用系统盘（C盘）'}</li>
                  <li>需要足够的存储空间</li>
                  <li>可以手动修改路径</li>
                </ul>
              </div>
            )}

            {currentStep.id === 'key' && (
              <div className="info-content">
                <h3>解密密钥说明</h3>
                <p>此步骤会在本机完成密钥识别与账号校验。</p>
                <ul className="info-list">
                  <li>{isMac ? '建议先启动微信，并按界面提示完成授权' : '点击“自动获取”后按提示操作'}</li>
                  <li>{isMac ? '识别完成后会自动尝试匹配账号目录' : '完成后会自动识别账号目录'}</li>
                  <li>密钥仅保存在本地配置中</li>
                </ul>
                <div className="info-warning">
                  <ShieldCheck size={16} />
                  <span>{isMac ? '若系统环境不满足要求，界面会直接给出提示' : '密钥不会上传到服务器'}</span>
                </div>
              </div>
            )}

            {currentStep.id === 'image' && (
              <div className="info-content">
                <h3>图片密钥说明</h3>
                <p>用于解密微信图片的密钥（可选）。</p>
                <ul className="info-list">
                  <li>优先通过本地缓存目录和 kvcomm 码推导图片密钥</li>
                  <li>{isMac ? 'kvcomm 失败时才回退到微信进程内存扫描' : '无需启动微信，秒级获取'}</li>
                  <li>自动匹配当前 wxid 的密钥</li>
                  <li>如无法获取，可手动填写</li>
                </ul>
              </div>
            )}

            {currentStep.id === 'security' && (
              <div className="info-content">
                <h3>安全防护说明</h3>
                <p>为应用添加额外的安全保护（可选）。</p>
                {isMac ? (
                  <>
                    <ul className="info-list">
                      <li>启用后每次启动需要验证</li>
                      <li>使用 macOS 系统 Touch ID 进行认证</li>
                      <li>若当前设备不支持，可跳过后改用应用密码</li>
                      <li>保护您的聊天记录隐私</li>
                    </ul>
                    <div className="info-warning" style={{ background: 'rgba(76, 175, 80, 0.1)', color: '#4CAF50' }}>
                      <ShieldCheck size={16} />
                      <span>推荐在共享设备上开启此功能</span>
                    </div>
                  </>
                ) : (
                  <>
                    <ul className="info-list">
                      <li>启用后每次启动需要验证</li>
                      <li>使用 Windows Hello 进行认证</li>
                      <li>支持面部识别、指纹或 PIN 码</li>
                      <li>保护您的聊天记录隐私</li>
                    </ul>
                    <div className="info-warning" style={{ background: 'rgba(76, 175, 80, 0.1)', color: '#4CAF50' }}>
                      <ShieldCheck size={16} />
                      <span>推荐在公共电脑上开启此功能</span>
                    </div>
                  </>
                )}
              </div>
            )}

            {currentStep.id === 'decrypt' && (
              <div className="info-content">
                <h3>解密数据库说明</h3>
                <p>测试数据库连接并完成配置。</p>
                <ul className="info-list">
                  <li>点击"开始解密"验证配置</li>
                  <li>系统会尝试连接数据库</li>
                  <li>连接成功后保存配置</li>
                  <li>完成后即可开始使用</li>
                </ul>
                <div className="info-warning">
                  <ShieldCheck size={16} />
                  <span>请确保前面的步骤都已正确配置</span>
                </div>
              </div>
            )}

            <div className="info-footer">
              <ShieldCheck size={14} />
              <span>数据仅在本地处理，不上传服务器</span>
            </div>
          </div>

          {/* 右侧配置表单 */}
          <div className="setup-card">
            <div className="setup-body">
              {currentStep.id === 'intro' && (
                <div className="intro-message">
                  <Wand2 size={32} />
                  <h3>点击"下一步"开始配置</h3>
                  <p>整个过程大约需要 3-5 分钟</p>
                </div>
              )}

              {currentStep.id === 'db' && (
                <div className="setup-body">
                  <label className="field-label">数据库根目录</label>
                  {hasCache && (
                    <div className="field-hint" style={{ color: '#4CAF50', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <CheckCircle2 size={14} />
                      <span>已从缓存加载配置数据</span>
                    </div>
                  )}
                  <input
                    type="text"
                    className="field-input"
                    placeholder={isMac
                      ? '例如：~/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/2.0b4.0.9'
                      : '例如：C:\\Users\\xxx\\Documents\\xwechat_files'}
                    value={dbPath}
                    onChange={(e) => setDbPath(e.target.value)}
                  />
                  <div className="button-row">
                    <button
                      className="btn btn-primary"
                      onClick={() => handleAutoDetectPath()}
                      disabled={isDetectingPath}
                    >
                      <Wand2 size={16} /> {isDetectingPath ? '自动检测中...' : '自动检测'}
                    </button>
                    <button className="btn btn-secondary" onClick={handleSelectPath}>
                      <FolderOpen size={16} /> 浏览选择目录
                    </button>
                  </div>
                  {dbPath && (
                    <div className="button-row">
                      <button className="btn btn-secondary" onClick={handleOpenDetectedPath}>
                        <FolderOpen size={16} /> 打开此文件夹
                      </button>
                    </div>
                  )}
                  <div className="field-hint">{isMac ? '请选择微信版本目录或账号根目录' : '请选择微信-设置-存储位置对应的目录'}</div>
                  {!isMac && (
                    <div className="field-hint" style={{ color: '#ff6b6b', marginTop: '4px' }}>⚠️ 目录路径不可包含中文，如有中文请去微信-设置-存储位置点击更改，迁移至全英文目录</div>
                  )}
                </div>
              )}

              {currentStep.id === 'cache' && (
                <div className="setup-body">
                  <label className="field-label">缓存目录</label>
                  <input
                    type="text"
                    className="field-input"
                    placeholder={isMac ? '~/Documents/CipherTalkData' : 'D:\\CipherTalkDB'}
                    value={cachePath}
                    onChange={(e) => setCachePath(e.target.value)}
                  />
                  <div className="button-row">
                    <button className="btn btn-primary" onClick={handleSelectCachePath}>
                      <FolderOpen size={16} /> 浏览选择
                    </button>
                    <button className="btn btn-secondary" onClick={handleResetCachePath}>
                      <RotateCcw size={16} /> 恢复默认
                    </button>
                  </div>
                  <div className="field-hint">{isMac ? '用于头像、表情与图片缓存，默认已选文稿目录' : '用于头像、表情与图片缓存，已自动选择最佳磁盘'}</div>
                </div>
              )}

              {currentStep.id === 'key' && (
                <div className="setup-body">
                  <label className="field-label">账号目录（待验证）</label>
                  <input
                    type="text"
                    className="field-input"
                    placeholder="获取密钥后将自动填充"
                    value={wxid}
                    onChange={(e) => {
                      setWxid(e.target.value)
                      setIsAccountVerified(false)
                    }}
                  />
                  {wxidOptions.length > 0 && (
                    <div className="wxid-options">
                      {wxidOptions.map((id) => (
                        <button
                          key={id}
                          className={`wxid-option ${wxid === id ? 'is-selected' : ''}`}
                          onClick={async () => {
                            setWxid(id)
                            setIsAccountVerified(false)
                            if (decryptKey.length === 64) {
                              await verifyAccountDirectory(id, decryptKey)
                            }
                          }}
                        >
                          <div className="wxid-option-name">{id}</div>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="button-row">
                    <button
                      className="btn btn-secondary btn-inline"
                      onClick={() => verifyAccountDirectory(wxid, decryptKey)}
                      disabled={isVerifyingAccount || !wxid || decryptKey.length !== 64}
                    >
                      {isVerifyingAccount ? '验证中...' : '验证账号目录'}
                    </button>
                  </div>
                  <div className="field-hint">
                    状态：{isAccountVerified ? '✅ 已验证' : '⚠️ 未验证（密钥前只能识别候选目录）'}
                  </div>
                  <label className="field-label">解密密钥</label>
                  <div className="field-with-toggle">
                    <input
                      type={showDecryptKey ? 'text' : 'password'}
                      className="field-input"
                      placeholder="64 位十六进制密钥"
                      value={decryptKey}
                      onChange={(e) => setDecryptKey(e.target.value.trim())}
                    />
                    <button type="button" className="toggle-btn" onClick={() => setShowDecryptKey(!showDecryptKey)}>
                      {showDecryptKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>

                  <button className="btn btn-secondary btn-inline" onClick={() => handleAutoGetDbKey()} disabled={isFetchingDbKey}>
                    {isFetchingDbKey ? '获取中...' : '自动获取密钥'}
                  </button>

                  {!isMac && showWechatPathPrompt && (
                    <div className="manual-prompt">
                      <p className="prompt-text">未能自动找到微信安装位置，请手动选择 Weixin.exe</p>
                      <input
                        type="text"
                        className="field-input"
                        placeholder="例如：C:\Program Files\Tencent\WeChat\Weixin.exe"
                        value={customWechatPath}
                        onChange={(e) => setCustomWechatPath(e.target.value)}
                        style={{ marginBottom: '8px' }}
                      />
                      <div className="button-row">
                        <button className="btn btn-secondary" onClick={handleSelectWechatPath}>
                          <FolderOpen size={16} /> 浏览选择
                        </button>
                        <button className="btn btn-primary" onClick={handleConfirmWechatPath}>
                          确认并继续
                        </button>
                      </div>
                    </div>
                  )}

                  {dbKeyStatus && <div className="field-hint status-text">{dbKeyStatus}</div>}
                  <div className="field-hint">{isMac ? '获取密钥会调用 mac helper，并尝试识别候选账号目录' : '获取密钥会自动启动微信并识别候选账号目录'}</div>
                  <div className="field-hint">
                    {isMac ? 'macOS 要求先关闭 SIP；点击后会弹出管理员授权，再等待微信触发数据库访问即可。' : <>点击自动获取后等待提示<span style={{ color: 'red' }}>hook安装成功</span>，然后登录微信即可</>}
                  </div>
                </div>
              )}

              {currentStep.id === 'image' && (
                <div className="setup-body">
                  <label className="field-label">图片 XOR 密钥</label>
                  <input
                    type="text"
                    className="field-input"
                    placeholder="例如：0xA4"
                    value={imageXorKey}
                    onChange={(e) => setImageXorKey(e.target.value)}
                  />
                  <label className="field-label">图片 AES 密钥</label>
                  <input
                    type="text"
                    className="field-input"
                    placeholder="16 位密钥"
                    value={imageAesKey}
                    onChange={(e) => setImageAesKey(e.target.value)}
                  />
                  <button className="btn btn-secondary btn-inline" onClick={handleAutoGetImageKey} disabled={isFetchingImageKey}>
                    {isFetchingImageKey ? '获取中...' : '自动获取图片密钥'}
                  </button>
                  {imageKeyStatus && <div className="field-hint status-text">{imageKeyStatus}</div>}
                  <div className="field-hint">{isMac ? '优先从 kvcomm 和模板文件推导，若失败再回退到内存扫描。' : '请在电脑微信中打开查看几个图片后再点击获取秘钥，如获取失败请重复以上操作'}</div>
                  {isFetchingImageKey && <div className="field-hint status-text">{isMac ? '正在尝试 kvcomm / 内存扫描，请稍候...' : '正在扫描内存，请稍候...'}</div>}
                </div>
              )}

              {currentStep.id === 'security' && (
                <div className="setup-body">
                  <div className="auth-setup-card">
                    <div className="auth-icon-large">
                      {isMac ? <Lock size={48} /> : <Fingerprint size={48} />}
                    </div>
                    <h3>{biometricLabel} 认证</h3>
                    <p className="auth-desc">
                      {isMac ? '启用 Touch ID 以保护您的数据。' : '启用 Windows Hello 以保护您的数据。'}
                      <br />
                      {isMac ? '启用后，每次打开应用都需要进行系统 Touch ID 验证。' : '启用后，每次打开应用都需要进行生物识别或 PIN 码验证。'}
                    </p>

                    <div className="auth-actions">
                      {!isAuthEnabled ? (
                        <button
                          className="btn btn-primary"
                          onClick={async () => {
                            setIsEnablingAuth(true)
                            setAuthStatus(`正在等待${biometricLabel}验证...`)
                            const result = await enableAuth()
                            setIsEnablingAuth(false)
                            if (result.success) {
                              setAuthStatus('已成功启用认证保护')
                            } else {
                              setError(result.error || '启用失败')
                              setAuthStatus('')
                            }
                          }}
                          disabled={isEnablingAuth}
                        >
                          {isEnablingAuth ? '正在配置...' : '启用应用锁'}
                        </button>
                      ) : (
                        <div className="auth-success-state">
                          <div className="success-badge">
                            <CheckCircle2 size={16} />
                            <span>已启用保护</span>
                          </div>
                          <button
                            className="btn btn-text-danger"
                            onClick={async () => {
                              await disableAuth()
                              setAuthStatus('')
                            }}
                          >
                            关闭保护
                          </button>
                        </div>
                      )}
                    </div>

                    {authStatus && (
                      <div className="auth-status-text">
                        {authStatus}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {currentStep.id === 'decrypt' && (
                <div className="setup-body">
                  <div className="decrypt-summary">
                    <h3>配置摘要</h3>
                    <div className="summary-item">
                      <span className="summary-label">数据库目录：</span>
                      <span className="summary-value">{dbPath || '未设置'}</span>
                    </div>
                    <div className="summary-item">
                      <span className="summary-label">缓存目录：</span>
                      <span className="summary-value">{cachePath || '未设置'}</span>
                    </div>
                    <div className="summary-item">
                      <span className="summary-label">账号目录：</span>
                      <span className="summary-value">{wxid ? `${wxid}${isAccountVerified ? '（已验证）' : '（未验证）'}` : '未设置'}</span>
                    </div>
                    <div className="summary-item">
                      <span className="summary-label">解密密钥：</span>
                      <span className="summary-value">{decryptKey ? '已设置 (64位)' : '未设置'}</span>
                    </div>
                    <div className="summary-item">
                      <span className="summary-label">图片密钥：</span>
                      <span className="summary-value">
                        {imageXorKey || imageAesKey ? '已设置' : '未设置（可选）'}
                      </span>
                    </div>
                  </div>

                  <button
                    className="btn btn-primary btn-full"
                    onClick={handleStartDecrypt}
                    disabled={isDecrypting}
                    style={{ marginTop: '16px' }}
                  >
                    {isDecrypting ? '解密中...' : '开始解密'}
                  </button>

                  {decryptStatus && countdown === 0 && (
                    <div className="decrypt-status-container" style={{ marginTop: '16px' }}>
                      <div className="field-hint status-text" style={{ textAlign: 'center' }}>
                        {decryptStatus}
                      </div>
                    </div>
                  )}

                  {!isDecrypting && !decryptStatus && (
                    <div className="field-hint" style={{ marginTop: '12px', textAlign: 'center' }}>
                      点击"开始解密"按钮，系统将验证配置并连接数据库
                    </div>
                  )}
                </div>
              )}
            </div>

            {error && <div className="error-message">{error}</div>}

            <div className="setup-actions">
              <button className="btn btn-tertiary" onClick={handleBack} disabled={stepIndex === 0 || isDecrypting}>
                <ArrowLeft size={16} /> 上一步
              </button>
              {stepIndex < steps.length - 1 && (
                <button className="btn btn-primary" onClick={handleNext} disabled={!canGoNext()}>
                  下一步 <ArrowRight size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default WelcomePage
