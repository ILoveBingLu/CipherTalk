import { useState, useEffect, useCallback, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { Database, Check, Circle, Unlock, RefreshCw, RefreshCcw, Image as ImageIcon, Smile, Download, Trash2 } from 'lucide-react'
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

interface DeleteConfirmData {
  image: ImageFileInfo
  show: boolean
}

type TabType = 'database' | 'images' | 'emojis'

function DataManagementPage() {
  const [activeTab, setActiveTab] = useState<TabType>('database')
  const [databases, setDatabases] = useState<DatabaseFile[]>([])
  const [images, setImages] = useState<ImageFileInfo[]>([])
  const [emojis, setEmojis] = useState<ImageFileInfo[]>([])
  const [imageCount, setImageCount] = useState({ total: 0, decrypted: 0 })
  const [emojiCount, setEmojiCount] = useState({ total: 0, decrypted: 0 })
  const [isLoading, setIsLoading] = useState(false)
  const [isDecrypting, setIsDecrypting] = useState(false)
  const [message, setMessage] = useState<{ text: string; success: boolean } | null>(null)
  const [progress, setProgress] = useState<any>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmData>({ image: null as any, show: false })
  const location = useLocation()
  
  // 懒加载相关状态
  const [displayedImageCount, setDisplayedImageCount] = useState(20)
  const [displayedEmojiCount, setDisplayedEmojiCount] = useState(20)
  const imageGridRef = useRef<HTMLDivElement>(null)
  const emojiGridRef = useRef<HTMLDivElement>(null)
  const loadMoreThreshold = 300 // 距离底部多少像素时加载更多

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

      // 找到 images 和 Emojis 目录
      const imagesDir = dirsResult.directories.find(d => d.path.includes('images'))
      const emojisDir = dirsResult.directories.find(d => d.path.includes('Emojis'))

      // 扫描普通图片
      if (imagesDir) {
        console.log('[DataManagement] 扫描图片目录:', imagesDir.path)
        const result = await window.electronAPI.dataManagement.scanImages(imagesDir.path)
        if (result.success && result.images) {
          console.log('[DataManagement] 找到普通图片:', result.images.length, '个')
          setImages(result.images)
          setImageCount({
            total: result.images.length,
            decrypted: result.images.filter(img => img.isDecrypted).length
          })
        }
      }

      // 扫描表情包
      if (emojisDir) {
        console.log('[DataManagement] 扫描表情包目录:', emojisDir.path)
        const result = await window.electronAPI.dataManagement.scanImages(emojisDir.path)
        if (result.success && result.images) {
          console.log('[DataManagement] 找到表情包:', result.images.length, '个')
          setEmojis(result.images)
          setEmojiCount({
            total: result.images.length,
            decrypted: result.images.filter(emoji => emoji.isDecrypted).length
          })
        }
      }
    } catch (e) {
      console.error('[DataManagement] 扫描图片异常:', e)
      showMessage(`扫描图片失败: ${e}`, false)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // 页面加载时预加载图片数量（不加载详细数据）
  useEffect(() => {
    const loadImageCounts = async () => {
      try {
        const dirsResult = await window.electronAPI.dataManagement.getImageDirectories()
        if (dirsResult.success && dirsResult.directories && dirsResult.directories.length > 0) {
          // 找到 images 和 Emojis 目录
          const imagesDir = dirsResult.directories.find(d => d.path.includes('images'))
          const emojisDir = dirsResult.directories.find(d => d.path.includes('Emojis'))

          // 扫描普通图片数量
          if (imagesDir) {
            const result = await window.electronAPI.dataManagement.scanImages(imagesDir.path)
            if (result.success && result.images) {
              setImageCount({
                total: result.images.length,
                decrypted: result.images.filter(img => img.isDecrypted).length
              })
            }
          }

          // 扫描表情包数量
          if (emojisDir) {
            const result = await window.electronAPI.dataManagement.scanImages(emojisDir.path)
            if (result.success && result.images) {
              setEmojiCount({
                total: result.images.length,
                decrypted: result.images.filter(emoji => emoji.isDecrypted).length
              })
            }
          }
        }
      } catch (e) {
        console.error('[DataManagement] 预加载图片数量失败:', e)
      }
    }
    
    loadImageCounts()
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

  const [isDeletingThumbs, setIsDeletingThumbs] = useState(false)
  const [thumbDeleteConfirm, setThumbDeleteConfirm] = useState<{ show: boolean; count: number }>({ show: false, count: 0 })

  const handleDeleteThumbnails = async () => {
    try {
      const result = await window.electronAPI.image.countThumbnails()
      if (!result.success) {
        showMessage(result.error || '统计失败', false)
        return
      }
      if (result.count === 0) {
        showMessage('没有缩略图缓存', true)
        return
      }
      setThumbDeleteConfirm({ show: true, count: result.count })
    } catch (e) {
      showMessage(`统计失败: ${e}`, false)
    }
  }

  const confirmDeleteThumbnails = async () => {
    setThumbDeleteConfirm({ show: false, count: 0 })
    setIsDeletingThumbs(true)
    try {
      const result = await window.electronAPI.image.deleteThumbnails()
      if (result.success) {
        showMessage(`已删除 ${result.deleted} 张缩略图`, true)
        await loadImages()
      } else {
        showMessage(result.error || '删除失败', false)
      }
    } catch (e) {
      showMessage(`删除失败: ${e}`, false)
    } finally {
      setIsDeletingThumbs(false)
    }
  }

  const handleRefresh = () => {
    if (activeTab === 'database') {
      loadDatabases()
    } else if (activeTab === 'images' || activeTab === 'emojis') {
      loadImages()
      // 重置懒加载计数
      setDisplayedImageCount(20)
      setDisplayedEmojiCount(20)
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

  const handleDownloadImage = async (e: React.MouseEvent, image: ImageFileInfo) => {
    e.stopPropagation() // 阻止触发点击打开图片
    
    if (!image.isDecrypted || !image.decryptedPath) {
      showMessage('图片未解密，无法下载', false)
      return
    }

    try {
      // 直接使用浏览器的下载功能
      const link = document.createElement('a')
      link.href = image.decryptedPath.startsWith('file://') 
        ? image.decryptedPath 
        : `file:///${image.decryptedPath.replace(/\\/g, '/')}`
      link.download = image.fileName
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      showMessage('下载成功', true)
    } catch (e) {
      showMessage(`下载失败: ${e}`, false)
    }
  }

  const handleDeleteImage = async (e: React.MouseEvent, image: ImageFileInfo) => {
    e.stopPropagation() // 阻止触发点击打开图片
    
    if (!image.isDecrypted || !image.decryptedPath) {
      showMessage('图片未解密，无法删除', false)
      return
    }

    // 显示自定义确认对话框
    setDeleteConfirm({ image, show: true })
  }

  const confirmDelete = async () => {
    const image = deleteConfirm.image
    setDeleteConfirm({ image: null as any, show: false })

    try {
      // 删除解密后的文件
      const result = await window.electronAPI.file.delete(image.decryptedPath!)
      
      if (result.success) {
        showMessage('删除成功', true)
        // 刷新列表
        await loadImages()
      } else {
        showMessage(`删除失败: ${result.error}`, false)
      }
    } catch (e) {
      showMessage(`删除失败: ${e}`, false)
    }
  }

  const cancelDelete = () => {
    setDeleteConfirm({ image: null as any, show: false })
  }

  // 懒加载：监听滚动事件
  useEffect(() => {
    const handleScroll = (e: Event) => {
      const target = e.target as HTMLDivElement
      const scrollTop = target.scrollTop
      const scrollHeight = target.scrollHeight
      const clientHeight = target.clientHeight
      
      // 距离底部小于阈值时加载更多
      if (scrollHeight - scrollTop - clientHeight < loadMoreThreshold) {
        if (activeTab === 'images' && displayedImageCount < images.length) {
          setDisplayedImageCount(prev => Math.min(prev + 20, images.length))
        } else if (activeTab === 'emojis' && displayedEmojiCount < emojis.length) {
          setDisplayedEmojiCount(prev => Math.min(prev + 20, emojis.length))
        }
      }
    }

    const imageGrid = imageGridRef.current
    const emojiGrid = emojiGridRef.current
    
    if (activeTab === 'images' && imageGrid) {
      imageGrid.addEventListener('scroll', handleScroll)
      return () => imageGrid.removeEventListener('scroll', handleScroll)
    } else if (activeTab === 'emojis' && emojiGrid) {
      emojiGrid.addEventListener('scroll', handleScroll)
      return () => emojiGrid.removeEventListener('scroll', handleScroll)
    }
  }, [activeTab, displayedImageCount, displayedEmojiCount, images.length, emojis.length])

  // 检查是否需要加载更多（如果没有滚动条）
  useEffect(() => {
    const checkAndLoadMore = () => {
      const grid = activeTab === 'images' ? imageGridRef.current : emojiGridRef.current
      if (!grid) return

      const hasScroll = grid.scrollHeight > grid.clientHeight
      const hasMore = activeTab === 'images' 
        ? displayedImageCount < images.length 
        : displayedEmojiCount < emojis.length

      // 如果没有滚动条且还有更多内容，继续加载
      if (!hasScroll && hasMore) {
        if (activeTab === 'images') {
          setDisplayedImageCount(prev => Math.min(prev + 20, images.length))
        } else {
          setDisplayedEmojiCount(prev => Math.min(prev + 20, emojis.length))
        }
      }
    }

    // 延迟检查，等待 DOM 渲染完成
    const timer = setTimeout(checkAndLoadMore, 100)
    return () => clearTimeout(timer)
  }, [activeTab, displayedImageCount, displayedEmojiCount, images.length, emojis.length])

  // 切换标签时重置懒加载计数
  useEffect(() => {
    setDisplayedImageCount(20)
    setDisplayedEmojiCount(20)
  }, [activeTab])

  const pendingCount = databases.filter(db => !db.isDecrypted).length
  const decryptedCount = databases.filter(db => db.isDecrypted).length
  const needsUpdateCount = databases.filter(db => db.needsUpdate).length

  // 使用预加载的计数，如果已加载详细数据则使用详细数据的计数
  const displayImageCount = images.length > 0 ? images.length : imageCount.total
  const displayDecryptedImagesCount = images.length > 0 
    ? images.filter(img => img.isDecrypted).length 
    : imageCount.decrypted
  
  const displayEmojiCount = emojis.length > 0 ? emojis.length : emojiCount.total
  const displayDecryptedEmojisCount = emojis.length > 0 
    ? emojis.filter(emoji => emoji.isDecrypted).length 
    : emojiCount.decrypted


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

      {deleteConfirm.show && (
        <div className="delete-confirm-overlay" onClick={cancelDelete}>
          <div className="delete-confirm-card" onClick={(e) => e.stopPropagation()}>
            <h3>确认删除</h3>
            <p className="confirm-message">确定要删除这张图片吗？</p>
            <p className="confirm-detail">文件名: {deleteConfirm.image?.fileName}</p>
            <p className="confirm-warning">此操作不可恢复！</p>
            <div className="confirm-actions">
              <button className="btn btn-secondary" onClick={cancelDelete}>
                取消
              </button>
              <button className="btn btn-danger" onClick={confirmDelete}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {thumbDeleteConfirm.show && (
        <div className="delete-confirm-overlay" onClick={() => setThumbDeleteConfirm({ show: false, count: 0 })}>
          <div className="delete-confirm-card" onClick={(e) => e.stopPropagation()}>
            <h3>批量删除缩略图</h3>
            <p className="confirm-message">共找到 {thumbDeleteConfirm.count} 张缩略图缓存</p>
            <p className="confirm-warning">删除后查看图片时会重新生成，此操作不可恢复！</p>
            <div className="confirm-actions">
              <button className="btn btn-secondary" onClick={() => setThumbDeleteConfirm({ show: false, count: 0 })}>
                取消
              </button>
              <button className="btn btn-danger" onClick={confirmDeleteThumbnails}>
                确定删除
              </button>
            </div>
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
            图片 ({displayDecryptedImagesCount}/{displayImageCount})
          </button>
          <button
            className={`tab-btn ${activeTab === 'emojis' ? 'active' : ''}`}
            onClick={() => setActiveTab('emojis')}
          >
            <Smile size={16} />
            表情包 ({displayDecryptedEmojisCount}/{displayEmojiCount})
          </button>
        </div>
      </div>

      {activeTab === 'database' && (
        <div className="page-scroll">
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
        </div>
      )}

      {activeTab === 'images' && (
        <>
          <div className="media-header">
            <div>
              <h2>图片管理</h2>
              <p className="section-desc">
                {isLoading ? '正在扫描...' : `共 ${displayImageCount} 张图片，${displayDecryptedImagesCount} 张已解密`}
              </p>
            </div>
            <div className="section-actions">
              <button className="btn btn-secondary" onClick={handleDeleteThumbnails} disabled={isDeletingThumbs}>
                <Trash2 size={16} />
                {isDeletingThumbs ? '删除中...' : '批量删除缩略图'}
              </button>
              <button className="btn btn-secondary" onClick={handleRefresh} disabled={isLoading}>
                <RefreshCw size={16} className={isLoading ? 'spin' : ''} />
                刷新
              </button>
            </div>
          </div>

          <div className="media-grid" ref={imageGridRef}>
            {images.slice(0, displayedImageCount).map((image, index) => (
              <div
                key={index}
                className={`media-item ${image.isDecrypted ? 'decrypted' : 'pending'}`}
                onClick={() => handleImageClick(image)}
              >
                {image.isDecrypted && image.decryptedPath ? (
                  <>
                    {(() => {
                      const name = image.decryptedPath!.toLowerCase()
                      const isThumb = /_thumb\./.test(name) || /_t\./.test(name) || /\.t\./.test(name)
                      const isHd = /_hd\./.test(name) || /_h\./.test(name)
                      return <span className={`media-quality-tag ${isThumb ? 'thumb' : 'hd'}`}>{isThumb ? '缩略图' : isHd ? '高清图' : '原图'}</span>
                    })()}
                    <img 
                      src={image.decryptedPath.startsWith('data:') ? image.decryptedPath : `file:///${image.decryptedPath.replace(/\\/g, '/')}`} 
                      alt={image.fileName}
                      loading="lazy"
                      onError={(e) => {
                        console.error('[DataManagement] 图片加载失败:', image.decryptedPath)
                        e.currentTarget.style.display = 'none'
                      }}
                    />
                    <div className="media-actions">
                      <button 
                        className="action-btn download-btn" 
                        onClick={(e) => handleDownloadImage(e, image)}
                        title="下载"
                      >
                        <Download size={16} />
                      </button>
                      <button 
                        className="action-btn delete-btn" 
                        onClick={(e) => handleDeleteImage(e, image)}
                        title="删除"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </>
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

            {displayedImageCount < images.length && (
              <div className="loading-more">
                加载中... ({displayedImageCount}/{images.length})
              </div>
            )}
          </div>
        </>
      )}

      {activeTab === 'emojis' && (
        <>
          <div className="media-header">
            <div>
              <h2>表情包管理</h2>
              <p className="section-desc">
                {isLoading ? '正在扫描...' : `共 ${displayEmojiCount} 个表情包，${displayDecryptedEmojisCount} 个已解密`}
              </p>
            </div>
            <div className="section-actions">
              <button className="btn btn-secondary" onClick={handleRefresh} disabled={isLoading}>
                <RefreshCw size={16} className={isLoading ? 'spin' : ''} />
                刷新
              </button>
            </div>
          </div>

          <div className="media-grid emoji-grid" ref={emojiGridRef}>
            {emojis.slice(0, displayedEmojiCount).map((emoji, index) => (
              <div
                key={index}
                className={`media-item emoji-item ${emoji.isDecrypted ? 'decrypted' : 'pending'}`}
                onClick={() => handleImageClick(emoji)}
              >
                {emoji.isDecrypted && emoji.decryptedPath ? (
                  <>
                    <img 
                      src={emoji.decryptedPath.startsWith('data:') ? emoji.decryptedPath : `file:///${emoji.decryptedPath.replace(/\\/g, '/')}`} 
                      alt={emoji.fileName}
                      loading="lazy"
                      onError={(e) => {
                        console.error('[DataManagement] 表情包加载失败:', emoji.decryptedPath)
                        e.currentTarget.style.display = 'none'
                      }}
                    />
                    <div className="media-actions">
                      <button 
                        className="action-btn download-btn" 
                        onClick={(e) => handleDownloadImage(e, emoji)}
                        title="下载"
                      >
                        <Download size={16} />
                      </button>
                      <button 
                        className="action-btn delete-btn" 
                        onClick={(e) => handleDeleteImage(e, emoji)}
                        title="删除"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </>
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

            {displayedEmojiCount < emojis.length && (
              <div className="loading-more">
                加载中... ({displayedEmojiCount}/{emojis.length})
              </div>
            )}
          </div>
        </>
      )}
    </>
  )
}

export default DataManagementPage
