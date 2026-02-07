import { useState, useEffect, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { Database, Check, Circle, Unlock, RefreshCw, RefreshCcw, Image as ImageIcon, Smile } from 'lucide-react'
import './DataManagementPage.scss'

interface DatabaseFile {
  fileName: string
  filePath: string
  fileSize: number
  wxid: string
  isDecrypted: boolean
  decryptedPath?: string
  needsUpdate?: boolean
}

interface ImageFileInfo {
  fileName: string
  filePath: string
  fileSize: number
  isDecrypted: boolean
  decryptedPath?: string
  version: number
}

type TabType = 'database' | 'images' | 'emojis'

function DataManagementPage() {
  const [activeTab, setActiveTab] = useState<TabType>('database')
  const [databases, setDatabases] = useState<DatabaseFile[]>([])
  const [images, setImages] = useState<ImageFileInfo[]>([])
  const [emojis, setEmojis] = useState<ImageFileInfo[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isDecrypting, setIsDecrypting] = useState(false)
  const [message, setMessage] = useState<{ text: string; success: boolean } | null>(null)
  const [progress, setProgress] = useState<any>(null)
  const location = useLocation()

  const loadDatabases = useCallback(async () => {
    setIsLoading(true)
    try {
      const result = await window.electronAPI.dataManagement.scanDatabases()
      if (result.success) {
        setDatabases(result.databases || [])
      } else {
        showMessage(result.error || '扫描数据库失败', false)
      }
    } catch (e) {
      showMessage(`扫描失败: ${e}`, false)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const loadImages = useCallback(async () => {
    setIsLoading(true)
    try {
      console.log('[DataManagement] 开始加载图片...')
      
      // 获取图片目录列表
      const dirsResult = await window.electronAPI.dataManagement.getImageDirectories()
      console.log('[DataManagement] 图片目录结果:', dirsResult)
      
      if (!dirsResult.success || !dirsResult.directories || dirsResult.directories.length === 0) {
        showMessage('未找到图片目录，请先解密数据库', false)
        setIsLoading(false)
        return
      }

      // 扫描第一个目录的图片
      const firstDir = dirsResult.directories[0]
      console.log('[DataManagement] 扫描目录:', firstDir.path)
      
      const result = await window.electronAPI.dataManagement.scanImages(firstDir.path)
      console.log('[DataManagement] 扫描结果:', result)
      
      if (result.success && result.images) {
        console.log('[DataManagement] 找到图片数量:', result.images.length)
        
        // 分离图片和表情包
        const imageList: ImageFileInfo[] = []
        const emojiList: ImageFileInfo[] = []
        
        result.images.forEach(img => {
          console.log('[DataManagement] 处理图片:', img.fileName, '路径:', img.filePath)
          // 根据路径判断是否是表情包
          if (img.filePath.includes('CustomEmotions') || img.filePath.includes('emoji')) {
            emojiList.push(img)
          } else {
            imageList.push(img)
          }
        })
        
        console.log('[DataManagement] 图片分类完成 - 普通图片:', imageList.length, '表情包:', emojiList.length)
        setImages(imageList)
        setEmojis(emojiList)
      } else {
        showMessage(result.error || '扫描图片失败', false)
      }
    } catch (e) {
      console.error('[DataManagement] 扫描图片异常:', e)
      showMessage(`扫描图片失败: ${e}`, false)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (activeTab === 'database') {
      loadDatabases()
    } else if (activeTab === 'images' || activeTab === 'emojis') {
      loadImages()
    }

    // 监听进度（手动更新/解密时显示进度弹窗）
    const removeProgressListener = window.electronAPI.dataManagement.onProgress(async (data) => {
      // 解密/更新进度 - 显示弹窗
      if (data.type === 'decrypt' || data.type === 'update') {
        setProgress(data)
        return
      }

      // 完成/错误 - 清除弹窗并刷新数据库列表
      if (data.type === 'complete' || data.type === 'error') {
        setProgress(null)
        // 更新完成后自动刷新数据库列表（显示最新的解密状态和更新状态）
        if (data.type === 'complete') {
          if (activeTab === 'database') {
            await loadDatabases()
          } else if (activeTab === 'images' || activeTab === 'emojis') {
            await loadImages()
          }
        }
      }
    })

    // 监听自动更新完成事件（静默更新时不会发送进度事件，但会触发此事件）
    // 注意：onUpdateAvailable 在更新完成时会传递 false
    let lastUpdateState = false
    const removeUpdateListener = window.electronAPI.dataManagement.onUpdateAvailable(async (hasUpdate) => {
      // 当 hasUpdate 从 true 变为 false 时，表示更新完成
      if (lastUpdateState && !hasUpdate) {
        // 更新完成，延迟一点刷新，确保后端更新完成
        setTimeout(async () => {
          if (activeTab === 'database') {
            await loadDatabases()
          } else if (activeTab === 'images' || activeTab === 'emojis') {
            await loadImages()
          }
        }, 1000)
      }
      lastUpdateState = hasUpdate
    })

    return () => {
      removeProgressListener()
      removeUpdateListener()
    }
  }, [activeTab, loadDatabases, loadImages])

  // 当路由变化到数据管理页面时，重新加载数据
  useEffect(() => {
    if (location.pathname === '/data-management') {
      if (activeTab === 'database') {
        loadDatabases()
      } else if (activeTab === 'images' || activeTab === 'emojis') {
        loadImages()
      }
    }
  }, [location.pathname, activeTab, loadDatabases, loadImages])

  // 窗口可见性变化时刷新数据
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (!document.hidden && location.pathname === '/data-management') {
        // 窗口从隐藏变为可见时，重新加载数据
        if (activeTab === 'database') {
          await loadDatabases()
        } else if (activeTab === 'images' || activeTab === 'emojis') {
          await loadImages()
        }
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [location.pathname, activeTab, loadDatabases, loadImages])


  const showMessage = (text: string, success: boolean) => {
    setMessage({ text, success })
    setTimeout(() => setMessage(null), 3000)
  }

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const handleDecryptAll = async () => {
    // 先检查是否配置了解密密钥
    const decryptKey = await window.electronAPI.config.get('decryptKey')
    if (!decryptKey) {
      showMessage('请先在设置页面配置解密密钥', false)
      // 3秒后自动跳转到设置页面
      setTimeout(() => {
        window.location.hash = '#/settings'
      }, 3000)
      return
    }

    // 检查聊天窗口是否打开
    const isChatOpen = await window.electronAPI.window.isChatWindowOpen()
    if (isChatOpen) {
      showMessage('请先关闭聊天窗口再进行解密操作', false)
      return
    }

    const pendingFiles = databases.filter(db => !db.isDecrypted)
    if (pendingFiles.length === 0) {
      showMessage('所有数据库都已解密', true)
      return
    }

    setIsDecrypting(true)
    try {
      const result = await window.electronAPI.dataManagement.decryptAll()
      if (result.success) {
        showMessage(`解密完成！成功: ${result.successCount}, 失败: ${result.failCount}`, result.failCount === 0)
        await loadDatabases()
      } else {
        showMessage(result.error || '解密失败', false)
      }
    } catch (e) {
      showMessage(`解密失败: ${e}`, false)
    } finally {
      setIsDecrypting(false)
    }
  }

  const handleIncrementalUpdate = async () => {
    // 检查聊天窗口是否打开
    const isChatOpen = await window.electronAPI.window.isChatWindowOpen()
    if (isChatOpen) {
      showMessage('请先关闭聊天窗口再进行增量更新', false)
      return
    }

    const filesToUpdate = databases.filter(db => db.needsUpdate)
    if (filesToUpdate.length === 0) {
      showMessage('没有需要更新的数据库', true)
      return
    }

    setIsDecrypting(true)
    try {
      const result = await window.electronAPI.dataManagement.incrementalUpdate()
      if (result.success) {
        showMessage(`增量更新完成！成功: ${result.successCount}, 失败: ${result.failCount}`, result.failCount === 0)
        await loadDatabases()
      } else {
        showMessage(result.error || '增量更新失败', false)
      }
    } catch (e) {
      showMessage(`增量更新失败: ${e}`, false)
    } finally {
      setIsDecrypting(false)
    }
  }

  const handleRefresh = () => {
    if (activeTab === 'database') {
      loadDatabases()
    } else if (activeTab === 'images' || activeTab === 'emojis') {
      loadImages()
    }
  }

  const handleImageClick = async (image: ImageFileInfo) => {
    if (!image.isDecrypted) {
      showMessage('图片未解密，请先解密数据库', false)
      return
    }
    
    // 打开图片查看窗口
    try {
      await window.electronAPI.window.openImageViewerWindow(image.decryptedPath || image.filePath)
    } catch (e) {
      showMessage(`打开图片失败: ${e}`, false)
    }
  }

  const pendingCount = databases.filter(db => !db.isDecrypted).length
  const decryptedCount = databases.filter(db => db.isDecrypted).length
  const needsUpdateCount = databases.filter(db => db.needsUpdate).length

  const decryptedImagesCount = images.filter(img => img.isDecrypted).length
  const decryptedEmojisCount = emojis.filter(emoji => emoji.isDecrypted).length


  return (
    <>
      {message && (
        <div className={`message-toast ${message.success ? 'success' : 'error'}`}>
          {message.text}
        </div>
      )}

      {progress && (progress.type === 'decrypt' || progress.type === 'update') && (
        <div className="decrypt-progress-overlay">
          <div className="progress-card">
            <h3>
              {progress.type === 'decrypt' ? '正在解密数据库' : '正在增量更新'}
            </h3>
            <p className="progress-file">{progress.fileName}</p>
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{ width: `${progress.fileProgress || 0}%` }}
              />
            </div>
            <p className="progress-text">
              文件 {(progress.current || 0) + 1} / {progress.total || 0} · {progress.fileProgress || 0}%
            </p>
          </div>
        </div>
      )}

      <div className="page-header">
        <h1>数据管理</h1>
        <div className="header-tabs">
          <button
            className={`tab-btn ${activeTab === 'database' ? 'active' : ''}`}
            onClick={() => setActiveTab('database')}
          >
            <Database size={16} />
            数据库
          </button>
          <button
            className={`tab-btn ${activeTab === 'images' ? 'active' : ''}`}
            onClick={() => setActiveTab('images')}
          >
            <ImageIcon size={16} />
            图片 ({decryptedImagesCount}/{images.length})
          </button>
          <button
            className={`tab-btn ${activeTab === 'emojis' ? 'active' : ''}`}
            onClick={() => setActiveTab('emojis')}
          >
            <Smile size={16} />
            表情包 ({decryptedEmojisCount}/{emojis.length})
          </button>
        </div>
      </div>

      <div className="page-scroll">
        {activeTab === 'database' && (
          <section className="page-section">
            <div className="section-header">
              <div>
                <h2>数据库解密（已支持自动更新）</h2>
                <p className="section-desc">
                  {isLoading ? '正在扫描...' : `已找到 ${databases.length} 个数据库，${decryptedCount} 个已解密，${pendingCount} 个待解密`}
                </p>
              </div>
              <div className="section-actions">
                <button className="btn btn-secondary" onClick={handleRefresh} disabled={isLoading}>
                  <RefreshCw size={16} className={isLoading ? 'spin' : ''} />
                  刷新
                </button>
                {needsUpdateCount > 0 && (
                  <button
                    className="btn btn-warning"
                    onClick={handleIncrementalUpdate}
                    disabled={isDecrypting}
                  >
                    <RefreshCcw size={16} />
                    增量更新 ({needsUpdateCount})
                  </button>
                )}
                <button
                  className="btn btn-primary"
                  onClick={handleDecryptAll}
                  disabled={isDecrypting || pendingCount === 0}
                >
                  <Unlock size={16} />
                  {isDecrypting ? '解密中...' : '批量解密'}
                </button>
              </div>
            </div>

            <div className="database-list">
              {databases.map((db, index) => (
                <div key={index} className={`database-item ${db.isDecrypted ? (db.needsUpdate ? 'needs-update' : 'decrypted') : 'pending'}`}>
                  <div className={`status-icon ${db.isDecrypted ? (db.needsUpdate ? 'needs-update' : 'decrypted') : 'pending'}`}>
                    {db.isDecrypted ? <Check size={16} /> : <Circle size={16} />}
                  </div>
                  <div className="db-info">
                    <div className="db-name">{db.fileName}</div>
                    <div className="db-meta">
                      <span>{db.wxid}</span>
                      <span>•</span>
                      <span>{formatFileSize(db.fileSize)}</span>
                    </div>
                  </div>
                  <div className={`db-status ${db.isDecrypted ? (db.needsUpdate ? 'needs-update' : 'decrypted') : 'pending'}`}>
                    {db.isDecrypted ? (db.needsUpdate ? '需更新' : '已解密') : '待解密'}
                  </div>
                </div>
              ))}

              {!isLoading && databases.length === 0 && (
                <div className="empty-state">
                  <Database size={48} strokeWidth={1} />
                  <p>未找到数据库文件</p>
                  <p className="hint">请先在设置页面配置数据库路径</p>
                </div>
              )}
            </div>
          </section>
        )}

        {activeTab === 'images' && (
          <section className="page-section">
            <div className="section-header">
              <div>
                <h2>图片管理</h2>
                <p className="section-desc">
                  {isLoading ? '正在扫描...' : `共 ${images.length} 张图片，${decryptedImagesCount} 张已解密`}
                </p>
              </div>
              <div className="section-actions">
                <button className="btn btn-secondary" onClick={handleRefresh} disabled={isLoading}>
                  <RefreshCw size={16} className={isLoading ? 'spin' : ''} />
                  刷新
                </button>
              </div>
            </div>

            <div className="media-grid">
              {images.slice(0, 100).map((image, index) => (
                <div
                  key={index}
                  className={`media-item ${image.isDecrypted ? 'decrypted' : 'pending'}`}
                  onClick={() => handleImageClick(image)}
                >
                  {image.isDecrypted && image.decryptedPath ? (
                    <img 
                      src={image.decryptedPath.startsWith('data:') ? image.decryptedPath : `file:///${image.decryptedPath.replace(/\\/g, '/')}`} 
                      alt={image.fileName}
                      onError={(e) => {
                        console.error('[DataManagement] 图片加载失败:', image.decryptedPath)
                        e.currentTarget.style.display = 'none'
                      }}
                    />
                  ) : (
                    <div className="media-placeholder">
                      <ImageIcon size={32} />
                      <span>未解密</span>
                    </div>
                  )}
                  <div className="media-info">
                    <span className="media-name">{image.fileName}</span>
                    <span className="media-size">{formatFileSize(image.fileSize)}</span>
                  </div>
                </div>
              ))}

              {!isLoading && images.length === 0 && (
                <div className="empty-state">
                  <ImageIcon size={48} strokeWidth={1} />
                  <p>未找到图片文件</p>
                  <p className="hint">请先解密数据库</p>
                </div>
              )}

              {images.length > 100 && (
                <div className="more-hint">
                  仅显示前 100 张图片，共 {images.length} 张
                </div>
              )}
            </div>
          </section>
        )}

        {activeTab === 'emojis' && (
          <section className="page-section">
            <div className="section-header">
              <div>
                <h2>表情包管理</h2>
                <p className="section-desc">
                  {isLoading ? '正在扫描...' : `共 ${emojis.length} 个表情包，${decryptedEmojisCount} 个已解密`}
                </p>
              </div>
              <div className="section-actions">
                <button className="btn btn-secondary" onClick={handleRefresh} disabled={isLoading}>
                  <RefreshCw size={16} className={isLoading ? 'spin' : ''} />
                  刷新
                </button>
              </div>
            </div>

            <div className="media-grid emoji-grid">
              {emojis.slice(0, 100).map((emoji, index) => (
                <div
                  key={index}
                  className={`media-item emoji-item ${emoji.isDecrypted ? 'decrypted' : 'pending'}`}
                  onClick={() => handleImageClick(emoji)}
                >
                  {emoji.isDecrypted && emoji.decryptedPath ? (
                    <img 
                      src={emoji.decryptedPath.startsWith('data:') ? emoji.decryptedPath : `file:///${emoji.decryptedPath.replace(/\\/g, '/')}`} 
                      alt={emoji.fileName}
                      onError={(e) => {
                        console.error('[DataManagement] 表情包加载失败:', emoji.decryptedPath)
                        e.currentTarget.style.display = 'none'
                      }}
                    />
                  ) : (
                    <div className="media-placeholder">
                      <Smile size={32} />
                      <span>未解密</span>
                    </div>
                  )}
                  <div className="media-info">
                    <span className="media-name">{emoji.fileName}</span>
                  </div>
                </div>
              ))}

              {!isLoading && emojis.length === 0 && (
                <div className="empty-state">
                  <Smile size={48} strokeWidth={1} />
                  <p>未找到表情包</p>
                  <p className="hint">请先解密数据库</p>
                </div>
              )}

              {emojis.length > 100 && (
                <div className="more-hint">
                  仅显示前 100 个表情包，共 {emojis.length} 个
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </>
  )
}

export default DataManagementPage
