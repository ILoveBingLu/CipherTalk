
import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ZoomIn, ZoomOut, RotateCw, RotateCcw } from 'lucide-react'
import { LivePhotoIcon } from '../components/LivePhotoIcon'
import './ImageWindow.scss'

export default function ImageWindow() {
    const [searchParams] = useSearchParams()
    const imagePath = searchParams.get('imagePath')
    const liveVideoPath = searchParams.get('liveVideoPath')
    const [scale, setScale] = useState(1)
    const [rotation, setRotation] = useState(0)
    const [position, setPosition] = useState({ x: 0, y: 0 })
    const [initialScale, setInitialScale] = useState(1)
    const [isPlayingLive, setIsPlayingLive] = useState(false)
    const [isVideoVisible, setIsVideoVisible] = useState(false)
    const viewportRef = useRef<HTMLDivElement>(null)
    const videoRef = useRef<HTMLVideoElement>(null)

    // 使用 ref 存储拖动状态，避免闭包问题
    const dragStateRef = useRef({
        isDragging: false,
        startX: 0,
        startY: 0,
        startPosX: 0,
        startPosY: 0,
        lastScreenX: 0,
        lastScreenY: 0
    })

    const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 })
    const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })

    const handleZoomIn = () => setScale(prev => Math.min(prev + 0.25, 10))
    const handleZoomOut = () => setScale(prev => Math.max(prev - 0.25, 0.1))
    const handleRotate = () => setRotation(prev => (prev + 90) % 360)
    const handleRotateCcw = () => setRotation(prev => (prev - 90 + 360) % 360)

    // 重置视图
    const handleReset = useCallback(() => {
        setScale(1)
        setRotation(0)
        setPosition({ x: 0, y: 0 })
    }, [])

    // ... existing useEffects for resize/scale ... (not modifying them here, just context if needed)

    // 播放 Live Photo
    const handlePlayLiveVideo = useCallback(() => {
        if (liveVideoPath && !isPlayingLive) {
            setIsPlayingLive(true)
            // 播放视频
            if (videoRef.current) {
                videoRef.current.currentTime = 0
                videoRef.current.play()
            }
        }
    }, [liveVideoPath, isPlayingLive])

    // 视频真正开始播放（画面就绪）
    const handleVideoPlaying = useCallback(() => {
        setIsVideoVisible(true)
    }, [])

    // 视频播放结束后返回图片
    const handleVideoEnded = useCallback(() => {
        setIsVideoVisible(false) // 先隐藏视频（显示下方的图片）
        // 等待过渡动画结束后，卸载视频组件
        setTimeout(() => {
            setIsPlayingLive(false)
        }, 300)
    }, [])

    // 监听窗口大小变化
    useEffect(() => {
        if (!viewportRef.current) return

        const updateViewportSize = () => {
            if (viewportRef.current) {
                setViewportSize({
                    width: viewportRef.current.clientWidth,
                    height: viewportRef.current.clientHeight
                })
            }
        }

        updateViewportSize()
        window.addEventListener('resize', updateViewportSize)
        return () => window.removeEventListener('resize', updateViewportSize)
    }, [])

    // 监听视口大小和图片原始尺寸变化，自动调整初始缩放比例
    useEffect(() => {
        if (naturalSize.width === 0 || viewportSize.width === 0) return

        const viewportWidth = viewportSize.width
        const viewportHeight = viewportSize.height
        const scaleX = viewportWidth / naturalSize.width
        const scaleY = viewportHeight / naturalSize.height
        const fitScale = Math.min(scaleX, scaleY, 1)

        setInitialScale(fitScale)
    }, [naturalSize, viewportSize])

    // 图片加载完成后：
    // 1. 记录原始尺寸
    // 2. 调整窗口大小以适应图片（如果可能）
    const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
        const img = e.currentTarget
        const naturalWidth = img.naturalWidth
        const naturalHeight = img.naturalHeight

        setNaturalSize({ width: naturalWidth, height: naturalHeight })

        // 请求调整窗口大小
        // 目标：让视口内容区域(viewport)能容纳图片
        // viewport = window - titlebar(40px)
        const desiredWidth = naturalWidth
        const desiredHeight = naturalHeight + 40 // +40px TitleBar

        // 调用主进程调整窗口
        // @ts-ignore
        window.electronAPI?.window?.resizeContent?.(desiredWidth, desiredHeight)

        // 重置缩放和位置
        setScale(1)
        setPosition({ x: 0, y: 0 })
    }, [])

    // Use a ref to access latest state in event listeners without re-binding
    const metaRef = useRef({
        scale,
        initialScale,
        naturalSize,
        viewportSize
    })

    useEffect(() => {
        metaRef.current = { scale, initialScale, naturalSize, viewportSize }
    }, [scale, initialScale, naturalSize, viewportSize])

    // 使用原生事件监听器处理拖动
    // 使用原生事件监听器处理拖动
    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!dragStateRef.current.isDragging) return

            // Get latest values from ref
            const { scale, initialScale, naturalSize, viewportSize } = metaRef.current
            const displayScale = initialScale * scale

            const isPannable = viewportSize.width > 0 &&
                (naturalSize.width * displayScale > viewportSize.width + 1 ||
                    naturalSize.height * displayScale > viewportSize.height + 1)

            if (isPannable) {
                const dx = e.clientX - dragStateRef.current.startX
                const dy = e.clientY - dragStateRef.current.startY

                let newX = dragStateRef.current.startPosX + dx
                let newY = dragStateRef.current.startPosY + dy

                // 计算边界限制
                const dw = naturalSize.width * displayScale
                const dh = naturalSize.height * displayScale

                // X轴限制
                if (dw > viewportSize.width) {
                    const limitX = (dw - viewportSize.width) / 2
                    newX = Math.max(-limitX, Math.min(newX, limitX))
                } else {
                    newX = 0
                }

                // Y轴限制
                if (dh > viewportSize.height) {
                    const limitY = (dh - viewportSize.height) / 2
                    newY = Math.max(-limitY, Math.min(newY, limitY))
                } else {
                    newY = 0
                }

                setPosition({ x: newX, y: newY })
            }
            // 不可平移时不做任何操作，窗口拖动由标题栏处理
        }

        const handleMouseUp = () => {
            dragStateRef.current.isDragging = false

            // Restore cursor depending on isPannable
            const { scale, initialScale, naturalSize, viewportSize } = metaRef.current
            const displayScale = initialScale * scale
            const isPannable = viewportSize.width > 0 &&
                (naturalSize.width * displayScale > viewportSize.width + 1 ||
                    naturalSize.height * displayScale > viewportSize.height + 1)

            document.body.style.cursor = isPannable ? 'grab' : 'default'
        }

        document.addEventListener('mousemove', handleMouseMove)
        document.addEventListener('mouseup', handleMouseUp)

        return () => {
            document.removeEventListener('mousemove', handleMouseMove)
            document.removeEventListener('mouseup', handleMouseUp)
        }
    }, [])

    const handleMouseDown = (e: React.MouseEvent) => {
        if (e.button !== 0) return
        e.preventDefault()

        const { scale, initialScale, naturalSize, viewportSize } = metaRef.current
        const displayScale = initialScale * scale
        const isPannable = viewportSize.width > 0 &&
            (naturalSize.width * displayScale > viewportSize.width + 1 ||
                naturalSize.height * displayScale > viewportSize.height + 1)

        dragStateRef.current = {
            isDragging: true,
            startX: e.clientX,
            startY: e.clientY,
            startPosX: position.x,
            startPosY: position.y,
            lastScreenX: e.screenX,
            lastScreenY: e.screenY
        }
        document.body.style.cursor = isPannable ? 'grabbing' : 'default'
    }

    const handleWheel = useCallback((e: React.WheelEvent) => {
        if (!viewportRef.current) return
        // 阻止默认滚动行为，避免触发页面滚动（虽然 overflows hidden 但保险起见）

        const ZOOM_SPEED = 0.15
        const delta = -Math.sign(e.deltaY) * ZOOM_SPEED

        const newScaleRaw = scale + delta
        const newScale = Math.min(Math.max(newScaleRaw, 0.1), 10)

        if (newScale === scale) return

        // 如果缩小到小于等于 1 (适应屏幕大小)，则强制居中
        if (newScale <= 1) {
            setScale(newScale)
            setPosition({ x: 0, y: 0 })
            return
        }

        // 计算鼠标相对于视口中心的偏移
        const rect = viewportRef.current.getBoundingClientRect()
        const mouseX = e.clientX - rect.left
        const mouseY = e.clientY - rect.top
        const centerX = rect.width / 2
        const centerY = rect.height / 2

        const pointerX = mouseX - centerX
        const pointerY = mouseY - centerY

        // 保持鼠标下的点不变：
        // NewPos = Pointer - (Pointer - OldPos) * (NewScale / OldScale)
        const scaleRatio = newScale / scale
        const newPos = {
            x: pointerX - (pointerX - position.x) * scaleRatio,
            y: pointerY - (pointerY - position.y) * scaleRatio
        }

        setScale(newScale)
        setPosition(newPos)
    }, [scale, position])

    // 双击重置
    // 双击：如果当前是适应屏幕 (scale ~ 1)，则放大到 100% (1:1) 并以鼠标为中心；否则重置
    const handleDoubleClick = useCallback((e: React.MouseEvent) => {
        if (Math.abs(scale - 1) < 0.05) {
            // 当前是适应状态 -> 放大到 1:1
            // 1:1 意味着 displayScale = 1.0
            // displayScale = initialScale * scale => scale = 1 / initialScale
            const targetScale = 1 / initialScale

            // 计算新的位置让鼠标处放大
            if (viewportRef.current) {
                const rect = viewportRef.current.getBoundingClientRect()
                const mouseX = e.clientX - rect.left
                const mouseY = e.clientY - rect.top
                const centerX = rect.width / 2
                const centerY = rect.height / 2
                const pointerX = mouseX - centerX
                const pointerY = mouseY - centerY

                const scaleRatio = targetScale / scale
                const newPos = {
                    x: pointerX - (pointerX - position.x) * scaleRatio,
                    y: pointerY - (pointerY - position.y) * scaleRatio
                }
                setPosition(newPos)
            }

            setScale(targetScale)
        } else {
            // 当前是放大/缩小状态 -> 重置
            handleReset()
        }
    }, [scale, initialScale, position, handleReset])

    // 快捷键支持
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (isPlayingLive) {
                    setIsPlayingLive(false)
                } else {
                    window.electronAPI.window.close()
                }
            }
            if (e.key === '=' || e.key === '+') handleZoomIn()
            if (e.key === '-') handleZoomOut()
            if (e.key === 'r' || e.key === 'R') handleRotate()
            if (e.key === '0') handleReset()
            if (e.key === ' ' && liveVideoPath) {
                e.preventDefault()
                handlePlayLiveVideo()
            }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [handleReset, liveVideoPath, isPlayingLive, handlePlayLiveVideo])

    const hasLiveVideo = !!liveVideoPath

    if (!imagePath) {
        return (
            <div className="image-window-empty">
                <span>无效的图片路径</span>
            </div>
        )
    }

    const displayScale = initialScale * scale

    // 判断是否可拖拽平移：只有当显示尺寸大于视口尺寸时才允许平移，否则允许拖拽窗口
    const isPannable = viewportSize.width > 0 &&
        (naturalSize.width * displayScale > viewportSize.width + 1 ||
            naturalSize.height * displayScale > viewportSize.height + 1)
    // height 判定宽松一点或者严格一点？这里用 height 简单判定。
    // 注意：如果旋转了，宽高判断会变。暂不处理旋转后的复杂bbox calculations。

    return (
        <div className="image-window-container">
            <div className="title-bar">
                <div className="window-drag-area"></div>
                <div className="title-bar-controls">
                    {hasLiveVideo && (
                        <>
                            <button
                                onClick={handlePlayLiveVideo}
                                data-tooltip={isPlayingLive ? "正在播放" : "播放 Live Photo (空格)"}
                                className={`live-play-btn ${isPlayingLive ? 'active' : ''}`}
                                disabled={isPlayingLive}
                            >
                                <LivePhotoIcon size={18} />
                                <span>LIVE</span>
                            </button>
                            <div className="divider"></div>
                        </>
                    )}
                    <button onClick={handleZoomOut} title="缩小 (-)"><ZoomOut size={16} /></button>
                    <span className="scale-text">{Math.round(displayScale * 100)}%</span>
                    <button onClick={handleZoomIn} title="放大 (+)"><ZoomIn size={16} /></button>
                    <div className="divider"></div>
                    <button onClick={handleRotateCcw} title="逆时针旋转"><RotateCcw size={16} /></button>
                    <button onClick={handleRotate} title="顺时针旋转 (R)"><RotateCw size={16} /></button>
                </div>
            </div>

            <div
                className="image-viewport"
                ref={viewportRef}
                onWheel={handleWheel}
                onDoubleClick={handleDoubleClick}
                onMouseDown={handleMouseDown}
            >
                <div
                    className="media-wrapper"
                    style={{
                        transform: `translate(${position.x}px, ${position.y}px) scale(${displayScale}) rotate(${rotation}deg)`
                    }}
                >
                    <img
                        src={imagePath}
                        alt="Preview"
                        className={isPannable ? 'pannable' : ''}
                        onLoad={handleImageLoad}
                        draggable={false}
                    />

                    {hasLiveVideo && isPlayingLive && (
                        <video
                            ref={videoRef}
                            src={liveVideoPath || ''}
                            className={`live-video ${isVideoVisible ? 'visible' : ''}`}
                            autoPlay
                            // muted={false} // Default is unmuted, explicit false for clarity
                            onEnded={handleVideoEnded}
                            onPlaying={handleVideoPlaying}
                        />
                    )}
                </div>
            </div>
        </div>
    )
}
