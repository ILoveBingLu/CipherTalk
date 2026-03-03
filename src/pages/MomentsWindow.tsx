import { useState, useEffect, useRef, useCallback } from 'react'
import { Loader2, RefreshCw, Search, Calendar, User, X, Filter, AlertTriangle, Play, Download, Heart, Copy, Link, Music, FileDown, ArrowUp } from 'lucide-react'
import { ImagePreview } from '../components/ImagePreview'
import { LivePhotoIcon } from '../components/LivePhotoIcon'
import { parseWechatEmoji, parseWechatEmojiHtml } from '../utils/wechatEmoji'
import TitleBar from '../components/TitleBar'
import JumpToDateDialog from '../components/JumpToDateDialog'
import DateRangePicker from '../components/DateRangePicker'
import './MomentsWindow.scss'

export interface SnsShareInfo {
  title: string
  description: string
  contentUrl: string
  thumbUrl: string
  thumbKey?: string
  thumbToken?: string
  appName?: string
  type?: number
}

interface SnsPost {
  id: string
  username: string
  nickname: string
  avatarUrl?: string
  createTime: number
  contentDesc: string
  type?: number
  media: Array<{
    url: string
    thumb: string
    md5?: string
    token?: string
    key?: string
    encIdx?: string
    livePhoto?: {
      url: string
      thumb: string
      token?: string
      key?: string
      encIdx?: string
    }
  }>
  shareInfo?: SnsShareInfo
  likes: string[]
  comments: SnsComment[]
  rawXml?: string
}

interface SnsCommentEmoji {
  url: string
  md5: string
  width: number
  height: number
  encryptUrl?: string
  aesKey?: string
}

interface SnsCommentImage {
  url: string
  token?: string
  key?: string
  encIdx?: string
  thumbUrl?: string
  thumbUrlToken?: string
  thumbKey?: string
  thumbEncIdx?: string
  width?: number
  height?: number
  heightPercentage?: number
  fileSize?: number
  minArea?: number
  mediaId?: string
  md5?: string
}

interface SnsComment {
  id: string
  nickname: string
  content: string
  refCommentId: string
  refNickname?: string
  emojis?: SnsCommentEmoji[]
  images?: SnsCommentImage[]
}

const isVideoUrl = (url: string) => {
  if (!url) return false
  return url.includes('snsvideodownload') || url.includes('video') || url.includes('.mp4')
}

const formatXml = (xml: string) => {
  if (!xml) return ''
  try {
    let formatted = ''
    const reg = /(>)(<)(\/*)/g
    xml = xml.replace(reg, '$1\r\n$2$3')
    let pad = 0
    xml.split('\r\n').forEach((node) => {
      let indent = 0
      if (node.match(/.+<\/\w[^>]*>$/)) {
        indent = 0
      } else if (node.match(/^<\/\w/)) {
        if (pad !== 0) {
          pad -= 1
        }
      } else if (node.match(/^<\w[^>]*[^\/]>.*$/)) {
        indent = 1
      } else {
        indent = 0
      }
      let padding = ''
      for (let i = 0; i < pad; i++) {
        padding += '  '
      }
      formatted += padding + node + '\r\n'
      pad += indent
    })
    return formatted
  } catch (e) {
    return xml
  }
}

// 缓存已解密的媒体路径，用于构建图片列表传给查看器
const mediaPathCache = new Map<string, { imagePath: string; liveVideoPath?: string }>()

// 媒体项组件
const MediaItem = ({ media, isSingle, allMedia, onPreview, onMediaDeleted }: { media: any; isSingle?: boolean; allMedia?: any[]; onPreview: (src: string, isVideo?: boolean, liveVideoPath?: string) => void; onMediaDeleted?: () => void }) => {
  const [error, setError] = useState(false)
  const [deleted, setDeleted] = useState(false)
  const [thumbSrc, setThumbSrc] = useState<string>('')
  const [videoPath, setVideoPath] = useState<string>('')
  const [liveVideoPath, setLiveVideoPath] = useState<string>('')
  const [isDecrypting, setIsDecrypting] = useState(false)
  const [isVisible, setIsVisible] = useState(false)
  const imgRef = useRef<HTMLDivElement>(null)

  const { url, thumb, livePhoto, width: rawWidth, height: rawHeight } = media
  const isLive = !!livePhoto
  const targetUrl = thumb || url

  const isVideo = url && isVideoUrl(url)

  // 骨架屏宽高比和具体尺寸（用于单图模式，防止 max-content width 退化为 0）
  let skeletonStyle: React.CSSProperties | undefined = undefined
  if (rawWidth && rawHeight && rawWidth > 0 && rawHeight > 0) {
    if (isSingle) {
      // 单图模式下，根据原始宽高和最大容器限制计算展示宽高
      const MAX_W = 260
      const MAX_H = 400
      let w = rawWidth
      let h = rawHeight
      if (w > MAX_W) {
        h = h * (MAX_W / w)
        w = MAX_W
      }
      if (h > MAX_H) {
        w = w * (MAX_H / h)
        h = MAX_H
      }
      skeletonStyle = { width: w, height: h }
    } else {
      skeletonStyle = { aspectRatio: `${rawWidth} / ${rawHeight}` }
    }
  } else {
    // 缺失宽高参数时的 fallback 骨架屏，确保一定有占位
    if (isSingle) {
      skeletonStyle = { width: 260, height: 260 }
    } else {
      skeletonStyle = { aspectRatio: '1 / 1' }
    }
  }

  // Intersection Observer 懒加载
  useEffect(() => {
    if (!imgRef.current) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true)
            observer.disconnect()
          }
        })
      },
      {
        rootMargin: '50px', // 提前50px开始加载
        threshold: 0.01
      }
    )

    observer.observe(imgRef.current)

    return () => {
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!isVisible) return // 只有可见时才加载

    let cancelled = false
    setError(false)
    setThumbSrc('')
    setVideoPath('')
    setLiveVideoPath('')
    setIsDecrypting(false)

    const extractFirstFrame = (videoUrl: string) => {
      const video = document.createElement('video')
      video.crossOrigin = 'anonymous'
      video.style.display = 'none'
      video.muted = true
      video.src = videoUrl
      video.currentTime = 0.1

      const onLoadedData = () => {
        if (cancelled) return cleanup()
        try {
          const canvas = document.createElement('canvas')
          canvas.width = video.videoWidth
          canvas.height = video.videoHeight
          const ctx = canvas.getContext('2d')
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
            const dataUrl = canvas.toDataURL('image/jpeg', 0.8)
            if (!cancelled) {
              setThumbSrc(dataUrl)
              setIsDecrypting(false)
            }
          } else {
            if (!cancelled) setIsDecrypting(false)
          }
        } catch (e) {
          console.warn('Frame extraction error', e)
          if (!cancelled) setIsDecrypting(false)
        } finally {
          cleanup()
        }
      }

      const onError = () => {
        if (!cancelled) {
          setIsDecrypting(false)
          setThumbSrc(targetUrl)
        }
        cleanup()
      }

      const cleanup = () => {
        video.removeEventListener('seeked', onLoadedData)
        video.removeEventListener('error', onError)
        video.remove()
      }

      video.addEventListener('seeked', onLoadedData)
      video.addEventListener('error', onError)
      video.load()
    }

    const run = async () => {
      try {
        if (isVideo) {
          setIsDecrypting(true)

          const videoResult = await window.electronAPI.sns.proxyImage({
            url: url,
            key: media.key
          })

          if (cancelled) return

          if (videoResult.success && videoResult.videoPath) {
            const localUrl = videoResult.videoPath.startsWith('file:')
              ? videoResult.videoPath
              : `file://${videoResult.videoPath.replace(/\\/g, '/')}`
            setVideoPath(localUrl)
            extractFirstFrame(localUrl)
          } else {
            setIsDecrypting(false)
            setDeleted(true)
            onMediaDeleted?.()
          }
        } else {
          // 图片：加载缩略图（使用 thumbKey）
          const result = await window.electronAPI.sns.proxyImage({
            url: targetUrl,
            key: media.thumbKey || media.key  // 优先使用 thumbKey，回退到 key
          })

          if (cancelled) return

          if (result.success) {
            let resolvedPath = ''
            if (result.localPath) {
              // 使用本地文件路径（file:// 协议）
              resolvedPath = result.localPath.startsWith('file:')
                ? result.localPath
                : `file://${result.localPath.replace(/\\/g, '/')}`
            } else if (result.dataUrl) {
              // 回退：使用 base64 dataUrl
              resolvedPath = result.dataUrl
            } else if (result.videoPath) {
              // 兼容：某些情况下可能返回 videoPath
              resolvedPath = result.videoPath.startsWith('file:')
                ? result.videoPath
                : `file://${result.videoPath.replace(/\\/g, '/')}`
            }
            if (resolvedPath) {
              setThumbSrc(resolvedPath)
              mediaPathCache.set(targetUrl, { imagePath: resolvedPath })
            }
          } else {
            setDeleted(true)
            onMediaDeleted?.()
          }

          if (isLive && livePhoto && livePhoto.url) {
            window.electronAPI.sns.proxyImage({
              url: livePhoto.url,
              key: livePhoto.key || media.key
            }).then((res: any) => {
              if (cancelled) return
              if (res.success) {
                let liveLocalUrl = ''
                if (res.videoPath) {
                  liveLocalUrl = res.videoPath.startsWith('file:')
                    ? res.videoPath
                    : `file://${res.videoPath.replace(/\\/g, '/')}`
                } else if (res.localPath) {
                  liveLocalUrl = res.localPath.startsWith('file:')
                    ? res.localPath
                    : `file://${res.localPath.replace(/\\/g, '/')}`
                }
                if (liveLocalUrl) {
                  setLiveVideoPath(liveLocalUrl)
                  // 更新缓存中的 liveVideoPath
                  const cached = mediaPathCache.get(targetUrl)
                  if (cached) {
                    cached.liveVideoPath = liveLocalUrl
                  }
                }
              }
            }).catch((e: any) => { })
          }
        }
      } catch (err) {
        if (!cancelled) {
          setDeleted(true)
          onMediaDeleted?.()
          setIsDecrypting(false)
        }
      }
    }

    run()
    return () => { cancelled = true }
  }, [isVisible, targetUrl, url, media.key, isVideo, isLive, livePhoto])

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const result = await window.electronAPI.sns.downloadImage({
        url: url || targetUrl,
        key: media.key
      })
      if (!result.success && result.error !== '用户已取消') {
        alert(`下载失败: ${result.error}`)
      }
    } catch (error) {
      alert('下载过程中发生错误')
    }
  }

  // 只使用解密后的本地路径，不回退到原始加密 URL（否则会显示灰色图片）
  const displaySrc = thumbSrc
  const previewSrc = isVideo ? (videoPath || url) : (thumbSrc || url || targetUrl)

  const handleClick = async () => {
    if (isVideo && isDecrypting) return

    try {
      if (isVideo) {
        // 视频：使用视频播放器窗口
        if (videoPath) {
          const localPath = videoPath.replace(/^file:\/\//, '')
          await window.electronAPI.window.openVideoPlayerWindow(localPath)
        }
      } else {
        // 图片：使用图片查看器窗口
        if (thumbSrc) {
          const localPath = thumbSrc.replace(/^file:\/\//, '')
          const liveVideoLocalPath = isLive && liveVideoPath ? liveVideoPath.replace(/^file:\/\//, '') : undefined

          // 从缓存构建同一条动态的图片列表
          let imageList: Array<{ imagePath: string; liveVideoPath?: string }> | undefined
          if (allMedia && allMedia.length > 1) {
            const list: Array<{ imagePath: string; liveVideoPath?: string }> = []
            for (const m of allMedia) {
              if (m.url && isVideoUrl(m.url)) continue // 跳过视频
              const key = m.thumb || m.url
              const cached = mediaPathCache.get(key)
              if (cached) {
                list.push({
                  imagePath: cached.imagePath.replace(/^file:\/\//, ''),
                  liveVideoPath: cached.liveVideoPath?.replace(/^file:\/\//, '')
                })
              }
            }
            if (list.length > 1) imageList = list
          }

          await window.electronAPI.window.openImageViewerWindow(localPath, liveVideoLocalPath, imageList)
        }
      }
    } catch (error) {
      console.error('[MediaItem] Error opening viewer:', error)
      // Fallback: 使用旧的预览方式
      onPreview(previewSrc, isVideo, liveVideoPath)
    }
  }

  if (deleted) {
    return (
      <div
        ref={imgRef}
        className="media-item deleted-media"
        style={skeletonStyle}
      >
        <div className="deleted-placeholder">
          <AlertTriangle size={24} />
          <span>已删除</span>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={imgRef}
      className={`media-item ${error ? 'error' : ''} ${isVideo && isDecrypting ? 'decrypting' : ''}`}
      style={!displaySrc && skeletonStyle ? skeletonStyle : undefined}
      onClick={handleClick}
    >
      {!isVisible ? (
        // 尚未进入视口：骨架屏占位（保持宽高比）
        <div className="media-skeleton" />
      ) : displaySrc ? (
        <img
          src={displaySrc}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setError(true)}
        />
      ) : error ? (
        <div className="media-placeholder error-state">
          <AlertTriangle size={24} className="error-icon" />
          <span>加载失败</span>
        </div>
      ) : (
        // 可见但仍在加载中/解密中：shimmer 骨架屏
        <div className="media-skeleton" />
      )}

      {isVisible && isVideo && !isDecrypting && (
        <div className="video-play-icon">
          <Play size={24} fill="white" stroke="white" />
        </div>
      )}

      {isVisible && isLive && !isVideo && (
        <div className="live-photo-badge" title={liveVideoPath ? 'Live Photo (已加载)' : 'Live Photo (加载中...)'}>
          <LivePhotoIcon size={14} className="live-icon" />
        </div>
      )}

      {isVisible && (
        <button className="download-btn-overlay" onClick={handleDownload} title="下载原图">
          <Download size={14} />
        </button>
      )}
    </div>
  )
}

// 分享卡片缩略图组件（支持解密加载）
const ShareThumb = ({ shareInfo }: { shareInfo: SnsShareInfo }) => {
  const [imgSrc, setImgSrc] = useState<string>('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!shareInfo.thumbUrl) {
      setFailed(true)
      return
    }
    let cancelled = false
    setFailed(false)
    let currentUrl = shareInfo.thumbUrl
    // 微信图片常以 http 开头，如果本地也是 http 可能没问题，但在生产环境可能会被 mixed content 拦截
    if (currentUrl.startsWith('http://')) {
      currentUrl = currentUrl.replace('http://', 'https://')
    }

    window.electronAPI.sns.proxyImage({
      url: currentUrl,
      key: shareInfo.thumbKey
    }).then((res: any) => {
      if (cancelled) return
      if (res.success) {
        const src = res.localPath
          ? `file://${res.localPath.replace(/\\/g, '/')}`
          : res.dataUrl || currentUrl
        setImgSrc(src)
      } else {
        // 回退
        setImgSrc(currentUrl)
      }
    }).catch(() => {
      if (!cancelled) setImgSrc(currentUrl)
    })
    return () => { cancelled = true }
  }, [shareInfo.thumbUrl, shareInfo.thumbKey])

  const isMusic = shareInfo.type === 3 && shareInfo.appName?.includes('音乐') || false

  if (failed) {
    return (
      <div className="share-placeholder">
        {isMusic ? <Music size={24} color="#888" /> : <Link size={24} color="#888" />}
      </div>
    )
  }

  // 二次加载失败的回调处理
  const handleImageError = () => {
    if (imgSrc.startsWith('https://')) {
      // 如果 https 失败，也许原图 http 也能通（虽然可能是防盗链）
      setImgSrc(imgSrc.replace('https://', 'http://'))
    } else {
      setFailed(true)
    }
  }

  return (
    <>
      {imgSrc
        ? <img src={imgSrc} alt="" referrerPolicy="no-referrer" onError={handleImageError} />
        : (
          <div className="share-placeholder">
            <Loader2 size={18} className="spin" />
          </div>
        )
      }
      {shareInfo.appName?.includes('音乐') && (
        <div className="music-play-overlay">
          <Play size={12} fill="white" stroke="white" />
        </div>
      )}
    </>
  )
}

// 表情包内存缓存：url/encryptUrl → file:// 本地路径
const emojiCache = new Map<string, string>()
const commentImageCache = new Map<string, string>()

// 评论表情包组件（先查内存缓存，再查本地文件，最后才下载）
const CommentEmoji = ({ emoji, onPreview }: {
  emoji: { url: string; md5: string; width: number; height: number; encryptUrl?: string; aesKey?: string }
  onPreview?: (src: string) => void
}) => {
  const cacheKey = emoji.encryptUrl || emoji.url
  const [localSrc, setLocalSrc] = useState<string>(() => emojiCache.get(cacheKey) || '')

  useEffect(() => {
    if (!cacheKey) return
    if (emojiCache.has(cacheKey)) {
      setLocalSrc(emojiCache.get(cacheKey)!)
      return
    }
    let cancelled = false

    const load = async () => {
      try {
        const res = await window.electronAPI.sns.downloadEmoji({
          url: emoji.url,
          encryptUrl: emoji.encryptUrl,
          aesKey: emoji.aesKey
        })
        if (cancelled) return
        if (res.success && res.localPath) {
          const fileUrl = res.localPath.startsWith('file:')
            ? res.localPath
            : `file://${res.localPath.replace(/\\/g, '/')}`
          emojiCache.set(cacheKey, fileUrl)
          setLocalSrc(fileUrl)
        }
      } catch (e) {
        // 静默失败
      }
    }

    load()
    return () => { cancelled = true }
  }, [cacheKey])

  if (!localSrc) return null

  return (
    <img
      src={localSrc}
      alt="emoji"
      className="comment-custom-emoji"
      draggable={false}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onPreview?.(localSrc)
      }}
      style={{
        width: Math.min(emoji.width || 36, 30),
        height: Math.min(emoji.height || 36, 30),
        verticalAlign: 'middle',
        marginLeft: 2,
        borderRadius: 6,
        cursor: 'pointer',
        pointerEvents: 'auto',
        position: 'relative',
        zIndex: 5
      }}
    />
  )
}

const CommentImage = ({ image, onPreview }: {
  image: SnsCommentImage
  onPreview?: (src: string) => void
}) => {
  const targetUrl = image.thumbUrl || image.url
  const targetKey = image.thumbKey || image.key
  const cacheKey = `${targetUrl}|${targetKey || ''}`
  const [localSrc, setLocalSrc] = useState<string>(() => commentImageCache.get(cacheKey) || '')

  useEffect(() => {
    if (!targetUrl) return
    if (commentImageCache.has(cacheKey)) {
      setLocalSrc(commentImageCache.get(cacheKey)!)
      return
    }
    let cancelled = false

    const load = async () => {
      try {
        const res = await window.electronAPI.sns.proxyImage({
          url: targetUrl,
          key: targetKey
        })
        if (cancelled || !res.success) return

        const src = res.localPath
          ? (res.localPath.startsWith('file:') ? res.localPath : `file://${res.localPath.replace(/\\/g, '/')}`)
          : (res.dataUrl || '')
        if (!src) return
        commentImageCache.set(cacheKey, src)
        setLocalSrc(src)
      } catch {
        // 静默失败
      }
    }

    load()
    return () => { cancelled = true }
  }, [cacheKey, targetUrl, targetKey])

  if (!localSrc) return null

  return (
    <img
      src={localSrc}
      alt="comment-image"
      className="comment-image-thumb"
      draggable={false}
      style={{
        pointerEvents: 'auto',
        position: 'relative',
        zIndex: 5
      }}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onPreview?.(localSrc)
      }}
      referrerPolicy="no-referrer"
    />
  )
}

// 朋友圈长文折叠展开组件
const ExpandableText = ({ content }: { content: string }) => {
  const [isExpanded, setIsExpanded] = useState(false)
  const [showExpandBtn, setShowExpandBtn] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = contentRef.current
    if (el) {
      if (el.scrollHeight > el.clientHeight) {
        setShowExpandBtn(true)
      }
    }
  }, [content])

  return (
    <div className="post-content-container">
      <div
        ref={contentRef}
        className={`post-content ${!isExpanded ? 'collapsed' : ''}`}
      >
        {parseWechatEmoji(content)}
      </div>
      {showExpandBtn && (
        <span
          className="expand-btn"
          onClick={(e) => {
            e.stopPropagation()
            setIsExpanded(!isExpanded)
          }}
        >
          {isExpanded ? '收起' : '全文'}
        </span>
      )}
    </div>
  )
}

interface Contact {
  username: string
  displayName: string
  avatarUrl?: string
}

function MomentsWindow() {
  const [isLoading, setIsLoading] = useState(true)
  const [loadingNewer, setLoadingNewer] = useState(false)
  const [posts, setPosts] = useState<SnsPost[]>([])
  const [deletedPostIds, setDeletedPostIds] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  // 筛选状态
  const [searchKeyword, setSearchKeyword] = useState('')
  const [selectedUsernames, setSelectedUsernames] = useState<string[]>(() => {
    const p = new URLSearchParams(window.location.search)
    const u = p.get('filterUsername')
    return u ? [u] : []
  })
  const [jumpTargetDate, setJumpTargetDate] = useState<Date | undefined>(undefined)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [contactSearch, setContactSearch] = useState('')
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => !new URLSearchParams(window.location.search).get('filterUsername'))
  const [showJumpDialog, setShowJumpDialog] = useState(false)

  // 其他状态
  const [previewImage, setPreviewImage] = useState<{ src: string, isVideo?: boolean, liveVideoPath?: string } | null>(null)
  const [debugPost, setDebugPost] = useState<SnsPost | null>(null)
  const [copySuccess, setCopySuccess] = useState(false)

  // 导出状态
  const [exporting, setExporting] = useState(false)
  const [showExportOptions, setShowExportOptions] = useState(false)
  const [exportDateRange, setExportDateRange] = useState<{ start: string, end: string }>({ start: '', end: '' })
  const [exportOptions, setExportOptions] = useState({
    includeImages: true
  })
  const [exportProgress, setExportProgress] = useState({ current: 0, total: 0, status: '' })
  const [hasMore, setHasMore] = useState(true)
  const [hasNewer, setHasNewer] = useState(false)
  const [showGoTop, setShowGoTop] = useState(false)

  const loadingRef = useRef(false)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const isInitialLoad = useRef(true)

  // 监听已有窗口收到的筛选消息
  useEffect(() => {
    const cleanup = window.electronAPI?.window?.onMomentsFilterUser?.((username: string) => {
      setSelectedUsernames([username])
    })
    return () => cleanup?.()
  }, [])

  // 处理滚动，当有新筛选项时回滚到顶部
  useEffect(() => {
    if (!isInitialLoad.current) {
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' })
    }
    isInitialLoad.current = false
  }, [searchKeyword, selectedUsernames, jumpTargetDate])

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setShowGoTop(e.currentTarget.scrollTop > 500)
  }

  const scrollToTop = () => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  // 加载联系人
  const loadContacts = useCallback(async () => {
    try {
      const result = await window.electronAPI.chat.getSessions()
      if (result.success && result.sessions) {
        const systemAccounts = ['filehelper', 'fmessage', 'newsapp', 'weixin', 'qqmail', 'tmessage', 'floatbottle', 'medianote', 'brandsessionholder'];
        const initialContacts = result.sessions
          .filter((s: any) => {
            if (!s.username) return false;
            const u = s.username.toLowerCase();
            if (u.includes('@chatroom') || u.endsWith('@chatroom') || u.endsWith('@openim')) return false;
            if (u.startsWith('gh_')) return false;
            if (systemAccounts.includes(u) || u.includes('helper') || u.includes('sessionholder')) return false;
            return true;
          })
          .map((s: any) => ({
            username: s.username,
            displayName: s.displayName || s.username,
            avatarUrl: s.avatarUrl
          }))
        setContacts(initialContacts)
        // Skip enrichSessionContactInfo as it is missing from preload
      }
    } catch (error) {
      console.error('Failed to load contacts:', error)
    }
  }, [])

  useEffect(() => {
    loadContacts()
  }, [loadContacts])

  // 加载数据
  const loadPosts = useCallback(async (options: { reset?: boolean, direction?: 'older' | 'newer' } = {}) => {
    const { reset = false, direction = 'older' } = options
    if (loadingRef.current) return

    loadingRef.current = true
    if (direction === 'newer') setLoadingNewer(true)
    else if (reset) setIsLoading(true)
    // else loading more (handled by infinite scroll UI)

    if (reset) {
      setError(null)
      setPosts([])
      setHasMore(true)
      setHasNewer(false)
    }

    try {
      if (!window.electronAPI?.sns?.getTimeline) {
        throw new Error('SNS API 未正确加载')
      }

      let startTs: number | undefined
      let endTs: number | undefined
      let currentOffset = 0

      if (reset) {
        if (jumpTargetDate) {
          const d = new Date(jumpTargetDate)
          d.setHours(23, 59, 59, 999)
          endTs = Math.floor(d.getTime() / 1000)
        }
        currentOffset = 0
      } else if (direction === 'newer') {
        const topPost = posts[0]
        if (topPost) {
          startTs = topPost.createTime + 1
        }
        currentOffset = 0
        endTs = undefined // Ensure endTs is cleared for newer posts check
      } else {
        // Load older
        currentOffset = posts.length

        // Maintain jumpTargetDate filter if active
        if (jumpTargetDate) {
          const d = new Date(jumpTargetDate)
          d.setHours(23, 59, 59, 999)
          endTs = Math.floor(d.getTime() / 1000)
        } else {
          endTs = undefined
        }
      }

      const currentLimit = 20

      const result = await window.electronAPI.sns.getTimeline(
        currentLimit,
        currentOffset,
        selectedUsernames,
        searchKeyword,
        startTs,
        endTs
      )

      if (result.success && result.timeline) {
        const newPosts = result.timeline as SnsPost[]

        if (reset) {
          setPosts(newPosts)
          setHasMore(newPosts.length >= currentLimit)
        } else if (direction === 'newer') {
          if (newPosts.length > 0) {
            setPosts(prev => {
              const existingIds = new Set(prev.map(p => p.id))
              const uniqueNew = newPosts.filter(p => !existingIds.has(p.id))
              return [...uniqueNew, ...prev]
            })
          }
          setHasNewer(false)
        } else {
          // Append older
          setPosts(prev => {
            const existingIds = new Set(prev.map(p => p.id))
            const uniqueNew = newPosts.filter(p => !existingIds.has(p.id))
            return [...prev, ...uniqueNew]
          })
          if (newPosts.length < currentLimit) {
            setHasMore(false)
          }
        }
      } else {
        if (reset) setError(result.error || '加载失败')
        if (direction === 'older') setHasMore(false)
      }
    } catch (e: any) {
      if (reset) setError(e.message)
      if (direction === 'older') setHasMore(false)
    } finally {
      setIsLoading(false)
      setLoadingNewer(false)
      loadingRef.current = false
    }
  }, [posts, selectedUsernames, searchKeyword, jumpTargetDate])

  // 监听筛选条件变化，自动重置加载
  useEffect(() => {
    loadPosts({ reset: true })
  }, [selectedUsernames, searchKeyword, jumpTargetDate]) // Removed loadPosts dependency to avoid loop

  // 无限滚动
  useEffect(() => {
    if (!sentinelRef.current) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoading && !loadingRef.current) {
          loadPosts({ direction: 'older' })
        }
      },
      { rootMargin: '200px', threshold: 0.01 }
    )
    observer.observe(sentinelRef.current)
    return () => observer.disconnect()
  }, [hasMore, isLoading, loadPosts])

  const formatTime = (ts: number) => {
    const date = new Date(ts * 1000)
    return date.toLocaleString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const toggleUserSelection = (username: string) => {
    setJumpTargetDate(undefined) // 切换用户时清除时间筛选
    setSelectedUsernames(prev =>
      prev.includes(username)
        ? prev.filter(u => u !== username)
        : [...prev, username]
    )
  }

  const clearFilters = () => {
    setSearchKeyword('')
    setSelectedUsernames([])
    setJumpTargetDate(undefined)
  }

  // 导出朋友圈为 HTML
  const handleExport = useCallback(async () => {
    if (exporting) return

    try {
      // 弹出选择目录对话框
      const result = await window.electronAPI.dialog.openFile({
        title: '选择导出目录',
        properties: ['openDirectory']
      })
      if (!result || result.canceled || !result.filePaths || result.filePaths.length === 0) return

      // 在选择的目录下创建带时间戳的子文件夹
      const now = new Date()
      const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
      const exportDirName = `朋友圈_${ts}`
      const exportDir = `${result.filePaths[0].replace(/\\/g, '/')}/${exportDirName}`

      setExporting(true)
      setExportProgress({ current: 0, total: 0, status: '正在获取动态数据...' })

      const startTs = exportDateRange.start ? Math.floor(new Date(`${exportDateRange.start}T00:00:00`).getTime() / 1000) : undefined
      const endTs = exportDateRange.end ? Math.floor(new Date(`${exportDateRange.end}T23:59:59.999`).getTime() / 1000) : undefined

      // 分批拉取所有动态
      const allPosts: SnsPost[] = []
      const batchSize = 50
      let offset = 0
      let hasMoreData = true

      while (hasMoreData) {
        const res = await window.electronAPI.sns.getTimeline(
          batchSize, offset,
          selectedUsernames.length > 0 ? selectedUsernames : undefined,
          searchKeyword || undefined,
          startTs,
          endTs
        )
        if (res.success && res.timeline && res.timeline.length > 0) {
          allPosts.push(...res.timeline)
          offset += res.timeline.length
          setExportProgress({ current: allPosts.length, total: 0, status: `已获取 ${allPosts.length} 条动态...` })
          if (res.timeline.length < batchSize) hasMoreData = false
        } else {
          hasMoreData = false
        }
      }

      if (allPosts.length === 0) {
        setExporting(false)
        setExportProgress({ current: 0, total: 0, status: '' })
        return
      }

      // 第二阶段：如果需要图片/视频，批量下载到同级 media 目录
      const imageCache = new Map<string, string>() // url -> 相对路径 (media/xxx.jpg)
      const avatarMap = new Map<string, string>() // username -> 相对路径 (media/avatar_xxx.jpg)
      const emojiCache = new Map<string, string>() // url/encryptUrl -> 相对路径

      const htmlDir = exportDir
      const mediaDir = `${htmlDir}/media`

      if (exportOptions.includeImages) {
        // 收集所有媒体、头像和表情包
        const allMediaUrls: { url: string; key?: string; type: 'media' | 'avatar' | 'emoji'; username?: string; md5?: string; encryptUrl?: string; aesKey?: string }[] = []

        // 1. 媒体（使用 md5 或 URL 作为唯一标识去重）
        const mediaUrlSet = new Set<string>()
        for (const p of allPosts) {
          if (p.media) {
            for (const m of p.media) {
              const thumbUrl = m.thumb || m.url
              if (thumbUrl && !mediaUrlSet.has(thumbUrl)) {
                mediaUrlSet.add(thumbUrl)
                allMediaUrls.push({ url: thumbUrl, key: m.key, type: 'media', md5: m.md5 })
              }
              // 普通视频
              if (m.url && isVideoUrl(m.url) && m.url !== thumbUrl && !mediaUrlSet.has(m.url)) {
                mediaUrlSet.add(m.url)
                allMediaUrls.push({ url: m.url, key: m.key, type: 'media', md5: m.md5 })
              }
              // 实况照片视频
              if (m.livePhoto && m.livePhoto.url && !mediaUrlSet.has(m.livePhoto.url)) {
                mediaUrlSet.add(m.livePhoto.url)
                allMediaUrls.push({ url: m.livePhoto.url, key: m.livePhoto.key || m.key, type: 'media' })
              }
            }
          }

          // 收集评论中的表情包
          if (p.comments) {
            for (const c of p.comments) {
              if (c.emojis) {
                for (const emoji of c.emojis) {
                  const emojiId = emoji.md5 || emoji.encryptUrl || emoji.url
                  if (emojiId && !mediaUrlSet.has(emojiId)) {
                    mediaUrlSet.add(emojiId)
                    allMediaUrls.push({
                      type: 'emoji',
                      url: emoji.url,
                      encryptUrl: emoji.encryptUrl,
                      aesKey: emoji.aesKey,
                      md5: emoji.md5
                    })
                  }
                }
              }
              if (c.images) {
                for (const img of c.images) {
                  const thumbUrl = img.thumbUrl || img.url
                  if (thumbUrl && !mediaUrlSet.has(thumbUrl)) {
                    mediaUrlSet.add(thumbUrl)
                    allMediaUrls.push({
                      type: 'media',
                      url: thumbUrl,
                      key: img.thumbKey || img.key,
                      md5: img.md5
                    })
                  }
                  if (img.url && img.url !== thumbUrl && !mediaUrlSet.has(img.url)) {
                    mediaUrlSet.add(img.url)
                    allMediaUrls.push({
                      type: 'media',
                      url: img.url,
                      key: img.key,
                      md5: img.md5
                    })
                  }
                }
              }
            }
          }
        }

        // 2. 唯一头像
        const uniqueUsers = Array.from(new Set(allPosts.filter(p => p.avatarUrl && p.username).map(p => ({ url: p.avatarUrl!, username: p.username }))))
        for (const user of uniqueUsers) {
          allMediaUrls.push({ url: user.url, type: 'avatar', username: user.username })
        }

        if (allMediaUrls.length > 0) {
          setExportProgress({ current: 0, total: allMediaUrls.length, status: `正在下载媒体 0/${allMediaUrls.length}...` })

          // 并发下载，限制并发数为 5
          const concurrency = 5
          let completed = 0
          const downloadBatch = async (items: typeof allMediaUrls) => {
            for (let i = 0; i < items.length; i += concurrency) {
              const batch = items.slice(i, i + concurrency)
              await Promise.allSettled(
                batch.map(async (item, batchIdx) => {
                  try {
                    const globalIdx = i + batchIdx
                    const res = await window.electronAPI.sns.saveMediaToDir({
                      url: item.url,
                      key: item.key,
                      outputDir: htmlDir,
                      index: globalIdx,
                      md5: item.md5,
                      isAvatar: item.type === 'avatar',
                      username: item.username,
                      isEmoji: item.type === 'emoji',
                      encryptUrl: item.encryptUrl,
                      aesKey: item.aesKey
                    })
                    if (res.success && res.fileName) {
                      if (item.type === 'media') {
                        imageCache.set(item.url, `media/${res.fileName}`)
                      } else if (item.type === 'avatar' && item.username) {
                        avatarMap.set(item.username, `media/${res.fileName}`)
                      } else if (item.type === 'emoji') {
                        const cacheKey = item.encryptUrl || item.url
                        if (cacheKey) {
                          emojiCache.set(cacheKey, `media/${res.fileName}`)
                        }
                      }
                    }
                  } catch (e) {
                    // 跳过失败的媒体
                  }
                })
              )
              completed += batch.length
              setExportProgress({
                current: completed,
                total: allMediaUrls.length,
                status: `正在下载媒体 ${completed}/${allMediaUrls.length}...`
              })
            }
          }
          await downloadBatch(allMediaUrls)
        }
      }

      // 第三阶段：生成 HTML
      setExportProgress({ current: 0, total: allPosts.length, status: '正在生成 HTML...' })

      const formatDate = (ts: number) => {
        const d = new Date(ts * 1000)
        return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      }

      const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

      let postsHtml = ''
      for (let i = 0; i < allPosts.length; i++) {
        const p = allPosts[i]
        if (i % 20 === 0) {
          setExportProgress({ current: i + 1, total: allPosts.length, status: `正在生成 ${i + 1}/${allPosts.length}...` })
        }

        let mediaHtml = ''
        if (exportOptions.includeImages && p.media && p.media.length > 0) {
          const mediaCount = p.media.length
          const gridClass = mediaCount === 1 ? 'grid-1' : mediaCount === 2 || mediaCount === 4 ? 'grid-2' : 'grid-3'

          const mediaItems = p.media.map(m => {
            const thumbUrl = m.thumb || m.url || ''
            if (!thumbUrl) return ''

            const photoSrc = imageCache.get(thumbUrl) || escHtml(thumbUrl)

            // 实况照片：点击打开灯箱，灯箱内支持二次点击播放
            if (m.livePhoto && m.livePhoto.url) {
              const videoSrc = imageCache.get(m.livePhoto.url) || ''
              return `<div class="mi lp" onclick="openLightbox('${photoSrc}', '${videoSrc}')">
                <img src="${photoSrc}" loading="lazy" />
                <div class="lp-tag"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg></div>
              </div>`
            }

            const isVid = isVideoUrl(m.url)
            if (isVid) {
              const videoSrc = imageCache.get(m.url) || photoSrc
              const posterSrc = photoSrc
              return `<div class="mi vi"><video src="${videoSrc}"${posterSrc ? ` poster="${posterSrc}"` : ''} controls preload="metadata"></video><div class="play-overlay">▶</div></div>`
            }

            return `<div class="mi" onclick="openLightbox('${photoSrc}')"><img src="${photoSrc}" loading="lazy" /></div>`
          }).join('')
          mediaHtml = `<div class="mg ${gridClass}">${mediaItems}</div>`
        }

        let shareHtml = ''
        if (p.shareInfo) {
          shareHtml = `<a class="lk" href="${escHtml(p.shareInfo.contentUrl)}" target="_blank">
            <div class="lk-body">
              <div class="lk-t">${escHtml(p.shareInfo.title || '查看链接')}</div>
              ${p.shareInfo.description ? `<div class="lk-d">${escHtml(p.shareInfo.description)}</div>` : ''}
            </div>
            <span class="lk-a">›</span>
          </a>`
        }

        let likesHtml = ''
        if (p.likes && p.likes.length > 0) {
          likesHtml = `<div class="interactions"><div class="likes">♥ ${p.likes.map(l => `<span>${escHtml(l)}</span>`).join('、')}</div></div>`
        }

        let commentsHtml = ''
        if (p.comments && p.comments.length > 0) {
          const items = await Promise.all(p.comments.map(async (c: SnsComment) => {
            const reply = c.refNickname ? `<span class="re">回复</span><b>${escHtml(c.refNickname)}</b>` : ''
            let emojiHtml = ''
            if (c.emojis && c.emojis.length > 0) {
              emojiHtml = c.emojis.map((emoji: SnsCommentEmoji) => {
                const cacheKey = emoji.encryptUrl || emoji.url
                const fileUrl = imageCache.get(cacheKey) || emojiCache.get(cacheKey) || '' // 对于导出的表情包，我们可能需要使用对应的路径，由于表情包独立下载可能没存到导出的媒体库，先保留内存路径
                if (!fileUrl) return ''
                return `<img src="${escHtml(fileUrl)}" style="width: ${Math.min(emoji.width || 36, 48)}px; height: ${Math.min(emoji.height || 36, 48)}px; vertical-align: middle; margin-left: 2px; border-radius: 6px; cursor: pointer; pointer-events: auto;" onclick="openLightbox('${escHtml(fileUrl)}')" />`
              }).join('')
            }
            let imageHtml = ''
            if (c.images && c.images.length > 0) {
              imageHtml = c.images.map((img: SnsCommentImage) => {
                const thumbUrl = img.thumbUrl || img.url
                const fileUrl = imageCache.get(thumbUrl || '') || ''
                if (!fileUrl) return ''
                return `<img src="${escHtml(fileUrl)}" style="width: 48px; height: 48px; object-fit: cover; vertical-align: middle; margin-left: 4px; border-radius: 6px; cursor: pointer; pointer-events: auto;" onclick="openLightbox('${escHtml(fileUrl)}')" />`
              }).join('')
            }
            const cContentHtml = await parseWechatEmojiHtml(c.content)
            return `<div class="cmt"><b>${escHtml(c.nickname)}</b>${reply}：${cContentHtml}${emojiHtml}${imageHtml}</div>`
          }))
          commentsHtml = `<div class="interactions${p.likes.length > 0 ? ' cmt-border' : ''}"><div class="cmts">${items.join('')}</div></div>`
        }

        const avatarFile = p.username ? avatarMap.get(p.username) : null
        const avatarHtml = avatarFile
          ? `<div class="avatar"><img src="${avatarFile}" alt=""></div>`
          : `<div class="avatar">${escHtml(p.nickname[0] || '?')}</div>`

        const pContentHtml = await parseWechatEmojiHtml(p.contentDesc)

        postsHtml += `
        <div class="post">
          ${avatarHtml}
          <div class="body">
            <div class="hd">
              <span class="nick">${escHtml(p.nickname)}</span>
              <span class="tm">${formatDate(p.createTime)}</span>
            </div>
            ${p.contentDesc ? `<div class="txt">${pContentHtml}</div>` : ''}
            ${mediaHtml}
            ${shareHtml}
            ${likesHtml}
            ${commentsHtml}
          </div>
        </div>`
      }

      const dateRangeStr = (exportDateRange.start || exportDateRange.end)
        ? `<p style="margin-top: 4px; font-size: 13px; opacity: 0.8;">日期范围: ${exportDateRange.start || '最早'} 至 ${exportDateRange.end || '最新'}</p>`
        : ''

      const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>朋友圈导出 - ${new Date().toLocaleDateString('zh-CN')}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--t1);line-height:1.6;-webkit-font-smoothing:antialiased}
:root{--bg:#F0EEE9;--card:rgba(255,255,255,.92);--t1:#3d3d3d;--t2:#666;--t3:#999;--accent:#8B7355;--border:rgba(0,0,0,.08);--bg3:rgba(0,0,0,.03)}
@media(prefers-color-scheme:dark){:root{--bg:#1a1a1a;--card:rgba(40,40,40,.85);--t1:#e0e0e0;--t2:#aaa;--t3:#777;--accent:#c4a882;--border:rgba(255,255,255,.1);--bg3:rgba(255,255,255,.06)}}
.container{max-width:800px;margin:0 auto;padding:20px 24px 60px}

/* 页面标题 */
.feed-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;padding:20px 4px;border-bottom:1px solid var(--border)}
.feed-hd h2{font-size:24px;font-weight:700;color:var(--accent)}
.feed-hd .info{font-size:13px;color:var(--t3)}

/* 帖子卡片 - 头像+内容双列 */
.post{background:var(--card);border-radius:20px;border:1px solid var(--border);padding:24px;margin-bottom:24px;display:flex;gap:20px;box-shadow:0 2px 12px rgba(0,0,0,.03);transition:transform .2s,box-shadow .2s;backdrop-filter:blur(10px)}
.post:hover{transform:translateY(-2px);box-shadow:0 12px 24px rgba(0,0,0,.08)}
.avatar{width:52px;height:52px;border-radius:14px;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:600;flex-shrink:0;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,.1)}
.avatar img{width:100%;height:100%;object-fit:cover}
.body{flex:1;min-width:0}
.hd{display:flex;flex-direction:column;margin-bottom:10px}
.nick{font-size:16px;font-weight:700;color:var(--accent);margin-bottom:2px}
.tm{font-size:12px;color:var(--t3)}
.txt{font-size:15px;line-height:1.7;white-space:pre-wrap;word-break:break-word;margin-bottom:14px;color:var(--t1)}

/* 媒体网格 */
.mg{display:grid;gap:8px;margin-bottom:14px;max-width:400px}
.grid-1{max-width:320px}
.grid-1 .mi{border-radius:14px;aspect-ratio:auto;height:auto}
.grid-1 .mi img{max-height:500px;width:auto;max-width:100%;object-fit:contain;background:var(--bg3)}
.grid-2{grid-template-columns:1fr 1fr}
.grid-3{grid-template-columns:1fr 1fr 1fr}
.mi{overflow:hidden;border-radius:14px;background:var(--bg3);position:relative;aspect-ratio:1}
.mi img{width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in;transition:transform .3s,opacity .2s}
.mi img:hover{opacity:.9;transform:scale(1.05)}
.vi video{width:100%;height:100%;object-fit:cover;display:block;background:#000}
.play-overlay{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:48px;height:48px;border-radius:50%;background:rgba(0,0,0,0.4);backdrop-filter:blur(4px);color:white;display:flex;align-items:center;justify-content:center;font-size:20px;pointer-events:none}

/* 链接及分享 */
.lk{display:flex;align-items:center;gap:12px;padding:14px;background:var(--bg3);border:1px solid var(--border);border-radius:14px;text-decoration:none;color:var(--t1);font-size:14px;margin-bottom:14px;transition:background .2s}
.lk:hover{background:var(--border)}
.lk-body{flex:1;min-width:0}
.lk-t{font-weight:700;margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lk-d{font-size:12px;color:var(--t2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lk-a{color:var(--t3);font-size:20px;flex-shrink:0}

/* 互动区域 */
.interactions{margin-top:14px;padding-top:14px;border-top:1px dashed var(--border);font-size:13px}
.interactions.cmt-border{border-top:none;padding-top:0;margin-top:10px}
.likes{color:var(--accent);font-weight:600;line-height:1.8}
.likes span{margin-right:2px}
.cmts{background:var(--bg3);border-radius:12px;padding:10px 14px;line-height:1.5}
.cmt{margin-bottom:6px;color:var(--t2);word-break:break-all}
.cmt:last-child{margin-bottom:0}
.cmt b{color:var(--accent);font-weight:600}
.re{color:var(--t3);margin:0 4px;font-size:12px}

/* 灯箱 */
.lb{display:none;position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:9999;align-items:center;justify-content:center;cursor:default;backdrop-filter:blur(15px);animation:fadeIn .2s}
.lb.on{display:flex}
.lb-c{position:relative;width:min-content;height:min-content;display:flex;align-items:center;justify-content:center}
.lb img, .lb video{max-width:94vw;max-height:92vh;object-fit:contain;border-radius:12px;box-shadow:0 0 60px rgba(0,0,0,0.5);display:block;transition:opacity .4s ease}
.lb video{position:absolute;inset:0;width:100%;height:100%;opacity:0;pointer-events:none}
.lb.playing video{opacity:1;pointer-events:auto}
.lb.playing img{opacity:0.3}

/* 灯箱内播放按钮 */
.lb-play{position:absolute;top:20px;right:20px;background:rgba(255,255,255,0.15);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.2);color:#fff;padding:6px 12px;border-radius:20px;font-size:12px;font-weight:700;display:none;align-items:center;gap:6px;cursor:pointer;z-index:10;transition:all .3s;box-shadow:0 4px 15px rgba(0,0,0,0.3)}
.lb-play:hover{background:rgba(255,255,255,0.25);transform:scale(1.05)}
.lb-play svg{width:16px;height:16px}
.lb.playing .lb-play{background:var(--accent);border-color:transparent;color:#fff}
.lb.has-vid .lb-play{display:flex}

/* 回到顶部 */
.btt{position:fixed;right:24px;bottom:32px;width:48px;height:48px;border-radius:50%;background:var(--card);box-shadow:0 4px 16px rgba(0,0,0,.1);border:1px solid var(--border);cursor:pointer;font-size:20px;display:none;align-items:center;justify-content:center;z-index:100;color:var(--accent);transition:transform .2s;backdrop-filter:blur(10px)}
.btt:hover{transform:scale(1.1);background:var(--bg)}
.btt.show{display:flex}

/* 实况照片 LP */
.mi.lp{cursor:pointer}
.lp video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0}
.lp-tag{position:absolute;top:10px;left:10px;background:rgba(0,0,0,0.35);backdrop-filter:blur(12px);color:#fff;padding:5px;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;z-index:2;border:0.5px solid rgba(255,255,255,0.2)}
.lp-tag svg{width:16px;height:16px}

.ft{text-align:center;padding:48px 0 24px;font-size:13px;color:var(--t3);border-top:1px solid var(--border);margin-top:40px}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
</style>
</head>
<body>
<div class="container">
  <div class="feed-hd">
    <h2>朋友圈导出</h2>
    <span class="info">共 ${allPosts.length} 条动态 · 导出于 ${new Date().toLocaleString('zh-CN')}${dateRangeStr ? ` · ${dateRangeStr.replace(/<[^>]+>/g, '')}` : ''}</span>
  </div>
  ${postsHtml}
  <div class="ft">由 密语 CipherTalk 导出</div>
</div>

<div class="lb" id="lb" onclick="closeLb(event)">
  <div class="lb-c" onclick="event.stopPropagation()">
    <img id="lbi" src="">
    <video id="lbv" muted playsinline></video>
    <div class="lb-play" id="lbp" onclick="tLbLp()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>
      <span>LIVE</span>
    </div>
  </div>
</div>
<button class="btt" id="btt" onclick="window.scrollTo({top:0,behavior:'smooth'})">↑</button>

<script>
let hasVid = false;
function openLightbox(s, v){
  const lb = document.getElementById('lb');
  const img = document.getElementById('lbi');
  const vid = document.getElementById('lbv');
  img.src = s;
  if(v){
    vid.src = v;
    hasVid = true;
    lb.classList.add('has-vid');
  } else {
    vid.src = '';
    hasVid = false;
    lb.classList.remove('has-vid');
  }
  lb.classList.remove('playing');
  lb.classList.add('on');
  document.body.style.overflow='hidden';
}
function closeLb(e){
  const lb = document.getElementById('lb');
  const vid = document.getElementById('lbv');
  lb.classList.remove('on');
  lb.classList.remove('playing');
  vid.pause();
  vid.currentTime = 0;
  document.body.style.overflow='';
}
function tLbLp(){
  if(!hasVid) return;
  const lb = document.getElementById('lb');
  const vid = document.getElementById('lbv');
  if(vid.paused){
    lb.classList.add('playing');
    vid.play().catch(e=>{});
    // 播放结束自动切回图片
    vid.onended = function() {
      lb.classList.remove('playing');
      vid.currentTime = 0;
    };
  } else {
    lb.classList.remove('playing');
    vid.pause();
    vid.currentTime = 0;
  }
}
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeLb()});

// 滚动显示回到顶部按钮
window.addEventListener('scroll', function() {
  document.getElementById('btt').classList.toggle('show', window.scrollY > 600);
});

// 视频播放逻辑
document.querySelectorAll('.vi video').forEach(function(v) {
  v.addEventListener('play', function() { 
    var overlay = this.parentElement.querySelector('.play-overlay');
    if(overlay) overlay.style.opacity = '0'; 
  });
  v.addEventListener('pause', function() { 
    var overlay = this.parentElement.querySelector('.play-overlay');
    if(overlay) overlay.style.opacity = '1'; 
  });
});
</script>
</body>
</html>`

      // 写入 index.html 到导出目录
      const htmlFilePath = `${exportDir}/index.html`
      setExportProgress({ current: allPosts.length, total: allPosts.length, status: '正在写入文件...' })
      const writeResult = await window.electronAPI.sns.writeExportFile(htmlFilePath, fullHtml)

      if (writeResult.success) {
        setExportProgress({ current: allPosts.length, total: allPosts.length, status: '导出完成！' })
        // 导出完成后打开导出目录
        window.electronAPI.shell.openPath(exportDir)
      } else {
        setExportProgress({ current: 0, total: 0, status: `写入失败: ${writeResult.error}` })
      }

      setTimeout(() => {
        setExporting(false)
        setShowExportOptions(false)
        setExportProgress({ current: 0, total: 0, status: '' })
      }, 2000)
    } catch (e: any) {
      console.error('导出失败:', e)
      setExportProgress({ current: 0, total: 0, status: `导出失败: ${e.message}` })
      setTimeout(() => {
        setExporting(false)
        setExportProgress({ current: 0, total: 0, status: '' })
      }, 3000)
    }
  }, [exporting, selectedUsernames, searchKeyword, exportOptions, exportDateRange])

  const filteredContacts = contacts.filter(c =>
    c.displayName.toLowerCase().includes(contactSearch.toLowerCase()) ||
    c.username.toLowerCase().includes(contactSearch.toLowerCase())
  )

  return (
    <div className="moments-window">
      <TitleBar
        title="朋友圈"
        rightContent={
          <div className="title-actions">
            <button className="export-btn" onClick={() => setShowExportOptions(true)}>
              <FileDown size={14} />
              <span>导出</span>
            </button>
            <div className="divider"></div>
            <button
              className={`icon-btn ${isSidebarOpen ? 'active' : ''}`}
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              data-tooltip={isSidebarOpen ? "收起筛选" : "打开筛选"}
            >
              <Filter size={16} />
            </button>
            <button onClick={() => loadPosts({ reset: true })} disabled={isLoading} className="refresh-btn" data-tooltip="刷新">
              <RefreshCw size={16} className={isLoading ? 'spinning' : ''} />
            </button>
          </div>
        }
      />

      <div className="moments-container">
        {/* 侧边栏 (左侧) */}
        <aside className={`sns-sidebar ${isSidebarOpen ? 'open' : 'closed'}`}>
          <div className="filter-content custom-scrollbar">
            {/* 1. 搜索 */}
            <div className="filter-card">
              <div className="filter-section">
                <label><Search size={14} /> 关键词搜索</label>
                <div className="search-input-wrapper">
                  <Search size={14} className="input-icon" />
                  <input
                    type="text"
                    placeholder="搜索动态内容..."
                    value={searchKeyword}
                    onChange={e => setSearchKeyword(e.target.value)}
                  />
                  {searchKeyword && (
                    <button className="clear-input" onClick={() => setSearchKeyword('')}>
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* 2. 日期 */}
            <div className="filter-card jump-date-card">
              <div className="filter-section">
                <label><Calendar size={14} /> 时间跳转</label>
                <button className={`jump-date-btn ${jumpTargetDate ? 'active' : ''}`} onClick={() => setShowJumpDialog(true)}>
                  <span className="text">
                    {jumpTargetDate ? jumpTargetDate.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : '选择跳转日期...'}
                  </span>
                  <Calendar size={14} className="icon" />
                </button>
                {jumpTargetDate && (
                  <button className="clear-jump-date-inline" onClick={() => setJumpTargetDate(undefined)}>
                    返回最新动态
                  </button>
                )}
              </div>
            </div>

            {/* 3. 联系人 */}
            <div className="filter-card contact-card">
              <div className="contact-filter-section">
                <div className="section-header">
                  <label><User size={14} /> 联系人</label>
                  <div className="header-actions">
                    {selectedUsernames.length > 0 && (
                      <button className="clear-selection-btn" onClick={() => setSelectedUsernames([])}>清除</button>
                    )}
                    {selectedUsernames.length > 0 && (
                      <span className="selected-count">{selectedUsernames.length}</span>
                    )}
                  </div>
                </div>
                <div className="contact-search">
                  <Search size={12} className="search-icon" />
                  <input
                    type="text"
                    placeholder="搜索好友..."
                    value={contactSearch}
                    onChange={e => setContactSearch(e.target.value)}
                  />
                  {contactSearch && (
                    <X size={12} className="clear-search-icon" onClick={() => setContactSearch('')} />
                  )}
                </div>
                <div className="contact-list custom-scrollbar">
                  {filteredContacts.map(contact => (
                    <div
                      key={contact.username}
                      className={`contact-item ${selectedUsernames.includes(contact.username) ? 'active' : ''}`}
                      onClick={() => toggleUserSelection(contact.username)}
                    >
                      <div className="avatar-wrapper">
                        {contact.avatarUrl ? <img src={contact.avatarUrl} alt="" /> : <div className="avatar-placeholder">{contact.displayName[0]}</div>}
                        {selectedUsernames.includes(contact.username) && (
                          <div className="active-badge"></div>
                        )}
                      </div>
                      <span className="contact-name">{contact.displayName}</span>
                    </div>
                  ))}
                  {filteredContacts.length === 0 && (
                    <div className="empty-contacts">无可显示联系人</div>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="sidebar-footer">
            <button className="clear-btn" onClick={clearFilters}>
              <RefreshCw size={14} />
              重置所有筛选
            </button>
          </div>
        </aside>

        {/* 主内容区 */}
        <div className="moments-main">
          <div className="moments-content-wrapper">
            <div className="moments-content custom-scrollbar" ref={scrollContainerRef} onScroll={handleScroll}>
              {isLoading ? (
                <div className="moments-loading">
                  <Loader2 className="spin" size={32} />
                  <p>加载中...</p>
                </div>
              ) : error ? (
                <div className="moments-error">
                  <p>加载失败: {error}</p>
                  <button onClick={() => loadPosts({ reset: true })}>重试</button>
                </div>
              ) : posts.length === 0 ? (
                <div className="moments-placeholder">
                  <Search size={64} opacity={0.3} />
                  <p>暂无朋友圈动态</p>
                  {(selectedUsernames.length > 0 || searchKeyword || jumpTargetDate) && (
                    <button onClick={clearFilters} style={{ marginTop: 10 }}>重置筛选条件</button>
                  )}
                </div>
              ) : (
                <div className="posts-list">
                  {loadingNewer && (
                    <div className="loading-more">
                      <Loader2 className="spin" size={20} />
                      <span>正在检查更新...</span>
                    </div>
                  )}

                  {posts.map((post) => (
                    <div key={post.id} className={`post-item ${deletedPostIds.has(post.id) ? 'post-deleted' : ''}`}>
                      <div className="post-header">
                        <div className="post-avatar">
                          {post.avatarUrl ? (
                            <img src={post.avatarUrl} alt="" />
                          ) : (
                            <div className="avatar-placeholder">{post.nickname[0]}</div>
                          )}
                        </div>
                        <div className="post-info">
                          <div className="post-nickname">{post.nickname}</div>
                          <div className="post-time">{formatTime(post.createTime)}</div>
                        </div>
                        <div className="post-header-actions">
                          {deletedPostIds.has(post.id) && (
                            <span className="post-deleted-badge">
                              <AlertTriangle size={12} />
                              <span>已删除</span>
                            </span>
                          )}
                          <button
                            className="debug-btn"
                            onClick={() => setDebugPost(post)}
                            title="查看原始数据"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <polyline points="16 18 22 12 16 6"></polyline>
                              <polyline points="8 6 2 12 8 18"></polyline>
                            </svg>
                          </button>
                        </div>
                      </div>
                      {post.contentDesc && (
                        <ExpandableText content={post.contentDesc} />
                      )}
                      {post.media.length > 0 && !post.shareInfo && (
                        <div className={`post-media-grid media-count-${Math.min(post.media.length, 9)}`}>
                          {post.media.map((m, idx) => (
                            <MediaItem
                              key={idx}
                              media={m}
                              isSingle={post.media.length === 1}
                              allMedia={post.media}
                              onPreview={(src, isVideo, liveVideoPath) => setPreviewImage({ src, isVideo, liveVideoPath })}
                              onMediaDeleted={[1, 54].includes(post.type ?? 0) ? () => setDeletedPostIds(prev => new Set(prev).add(post.id)) : undefined}
                            />
                          ))}
                        </div>
                      )}

                      {post.shareInfo && post.shareInfo.type === 28 ? (
                        <div
                          className="post-finder-card"
                          onClick={() => {
                            if (post.shareInfo?.contentUrl) {
                              window.electronAPI.shell.openExternal(post.shareInfo.contentUrl);
                            }
                          }}
                        >
                          <div className="finder-cover">
                            <ShareThumb shareInfo={post.shareInfo} />
                          </div>
                          <div className="finder-info">
                            <div className="finder-desc">{post.shareInfo.description}</div>
                            <div className="finder-source">
                              <span className="finder-badge">视频号</span>
                              <span className="finder-author">{post.shareInfo.title}</span>
                            </div>
                          </div>
                        </div>
                      ) : post.shareInfo ? (
                        <div
                          className="post-share-card"
                          onClick={() => {
                            if (post.shareInfo?.contentUrl) {
                              window.electronAPI.shell.openExternal(post.shareInfo.contentUrl);
                            }
                          }}
                        >
                          <div className="share-card-thumb">
                            <ShareThumb shareInfo={post.shareInfo} />
                          </div>
                          <div className="share-card-content">
                            <div className="share-title">{post.shareInfo.title}</div>
                            {post.shareInfo.description && (
                              <div className="share-desc">{post.shareInfo.description}</div>
                            )}
                            {post.shareInfo.appName && (
                              <div className="share-app-name">{post.shareInfo.appName}</div>
                            )}
                          </div>
                        </div>
                      ) : null}

                      {(post.likes.length > 0 || post.comments.length > 0) && (
                        <div className="post-interactions">
                          {post.likes.length > 0 && (
                            <div className="post-likes">
                              <Heart size={14} className="like-icon-svg" fill="#ff4d4f" color="#ff4d4f" />
                              <span className="like-list">
                                {post.likes.join('，')}
                              </span>
                            </div>
                          )}
                          {post.comments.length > 0 && (
                            <div className="post-comments">
                              {post.comments.map((comment: SnsComment, idx: number) => (
                                <div key={comment.id || idx} className="comment-item">
                                  <span className="comment-nickname">{comment.nickname}</span>
                                  {comment.refNickname && (
                                    <>
                                      <span className="comment-reply-arrow"> 回复 </span>
                                      <span className="comment-ref-nickname">{comment.refNickname}</span>
                                    </>
                                  )}
                                  <span className="comment-separator">: </span>
                                  <span className="comment-content">
                                    {comment.content && parseWechatEmoji(comment.content)}
                                    {comment.emojis && comment.emojis.map((emoji: SnsCommentEmoji, eidx: number) => (
                                      <CommentEmoji key={eidx} emoji={emoji} onPreview={(src) => setPreviewImage({ src })} />
                                    ))}
                                    {comment.images && comment.images.map((image: SnsCommentImage, iidx: number) => (
                                      <CommentImage key={`${image.mediaId || image.md5 || image.url || iidx}_${iidx}`} image={image} onPreview={(src) => setPreviewImage({ src })} />
                                    ))}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}

                  <div ref={sentinelRef} className="load-more-sentinel">
                    {/* Observer Target */}
                    {!hasMore && (
                      <div className="no-more">没有更多动态了</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          {showGoTop && (
            <button className="go-to-top-btn" onClick={scrollToTop} aria-label="返回顶部">
              <ArrowUp size={20} />
            </button>
          )}
        </div>
      </div>

      {
        previewImage && (
          <ImagePreview
            src={previewImage.src}
            isVideo={previewImage.isVideo}
            liveVideoPath={previewImage.liveVideoPath}
            onClose={() => setPreviewImage(null)}
          />
        )
      }

      {
        debugPost && (
          <div className="modal-overlay" onClick={() => setDebugPost(null)}>
            <div className="debug-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="debug-dialog-header">
                <h3>{debugPost.rawXml ? '原始数据 (XML)' : '原始数据 (JSON)'}
                  <span style={{ fontSize: '13px', fontWeight: 'normal', color: 'var(--text-tertiary)', marginLeft: '8px' }}>
                    By {debugPost.nickname}
                  </span>
                </h3>
                <div className="header-actions">
                  <button
                    className={`action-btn ${copySuccess ? 'success' : ''}`}
                    onClick={() => {
                      const content = debugPost.rawXml
                        ? formatXml(debugPost.rawXml)
                        : JSON.stringify(debugPost, null, 2)
                      navigator.clipboard.writeText(content).then(() => {
                        setCopySuccess(true)
                        setTimeout(() => setCopySuccess(false), 2000)
                      })
                    }}
                    title="复制内容"
                  >
                    {copySuccess ? '已复制' : <Copy size={16} />}
                  </button>
                  <button className="close-btn" onClick={() => setDebugPost(null)}>
                    <X size={20} />
                  </button>
                </div>
              </div>
              <div className="debug-dialog-body custom-scrollbar">
                <pre className="json-code">
                  {debugPost.rawXml
                    ? formatXml(debugPost.rawXml)
                    : JSON.stringify(debugPost, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        )
      }

      {
        showExportOptions && (
          <div className="modal-overlay">
            <div className="export-modal fade-in">
              <div className="export-modal-header">
                <h3>导出朋友圈</h3>
                {!exporting && (
                  <button className="close-btn" onClick={() => setShowExportOptions(false)}>
                    <X size={20} />
                  </button>
                )}
              </div>
              <div className="export-modal-body">
                {exporting ? (
                  <div className="exporting-view">
                    <Loader2 size={36} className="spin progress-icon" />
                    <div className="progress-text">{exportProgress.status}</div>
                    {exportProgress.total > 0 && (
                      <div className="progress-track">
                        <div className="progress-fill" style={{ width: `${(exportProgress.current / exportProgress.total) * 100}%` }} />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="export-settings-view">
                    <div className="setting-group">
                      <label className="group-title">时间范围 (可选)</label>
                      <div className="time-options">
                        <DateRangePicker
                          startDate={exportDateRange.start}
                          endDate={exportDateRange.end}
                          onStartDateChange={(date) => setExportDateRange(prev => ({ ...prev, start: date }))}
                          onEndDateChange={(date) => setExportDateRange(prev => ({ ...prev, end: date }))}
                        />
                      </div>
                      <div className="setting-hint">如果不选择将导出所有动态</div>
                    </div>

                    <div className="setting-group">
                      <label className="group-title">导出内容选项</label>
                      <div className="custom-toggle-item" onClick={() => setExportOptions(prev => ({ ...prev, includeImages: !prev.includeImages }))}>
                        <div className="toggle-info">
                          <span className="toggle-label">导出媒体文件</span>
                          <span className="toggle-desc">勾选后将下载图片和视频到本地，这可能需要较长时间</span>
                        </div>
                        <div className={`custom-switch ${exportOptions.includeImages ? 'checked' : ''}`}>
                          <div className="switch-track"></div>
                          <div className="switch-thumb"></div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              {!exporting && (
                <div className="export-modal-footer">
                  <button className="btn-cancel" onClick={() => setShowExportOptions(false)}>取消</button>
                  <button className="btn-primary" onClick={handleExport}>
                    <FileDown size={14} /> 开始导出
                  </button>
                </div>
              )}
            </div>
          </div>
        )
      }

      <JumpToDateDialog
        isOpen={showJumpDialog}
        onClose={() => setShowJumpDialog(false)}
        onSelect={(date) => {
          setJumpTargetDate(date)
          setShowJumpDialog(false)
        }}
        currentDate={jumpTargetDate || new Date()}
      />
    </div >
  )
}

export default MomentsWindow
