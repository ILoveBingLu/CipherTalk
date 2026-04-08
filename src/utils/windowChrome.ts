export type WindowPlatform = 'win32' | 'darwin' | 'linux'

type WindowChromeMetrics = {
  controlsLeftSafe: string
  controlsRightSafe: string
  toolbarGap: string
}

type WindowControlsOverlayPadding = {
  left: number
  right: number
}

const DEFAULT_PLATFORM: WindowPlatform = 'win32'
const WINDOW_CHROME_HEIGHT = '40px'

const WINDOW_CHROME_METRICS: Record<WindowPlatform, WindowChromeMetrics> = {
  win32: {
    controlsLeftSafe: '16px',
    controlsRightSafe: '176px',
    toolbarGap: '10px'
  },
  darwin: {
    controlsLeftSafe: '84px',
    controlsRightSafe: '16px',
    toolbarGap: '8px'
  },
  linux: {
    controlsLeftSafe: '16px',
    controlsRightSafe: '144px',
    toolbarGap: '10px'
  }
}

const WINDOW_CONTROLS_OVERLAY_PADDING: Record<WindowPlatform, WindowControlsOverlayPadding> = {
  win32: {
    left: 16,
    right: 12
  },
  darwin: {
    left: 12,
    right: 16
  },
  linux: {
    left: 16,
    right: 12
  }
}

function parsePixels(value: string) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function toPixels(value: number) {
  return `${Math.max(0, Math.round(value))}px`
}

export function normalizeWindowPlatform(platform?: string | null): WindowPlatform {
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
    return platform
  }
  return DEFAULT_PLATFORM
}

export function getWindowChromeMetrics(platform?: string | null) {
  const normalizedPlatform = normalizeWindowPlatform(platform)
  return {
    platform: normalizedPlatform,
    chromeHeight: WINDOW_CHROME_HEIGHT,
    ...WINDOW_CHROME_METRICS[normalizedPlatform]
  }
}

export function applyWindowChromeToDocument(platform?: string | null, root: HTMLElement = document.documentElement) {
  const metrics = getWindowChromeMetrics(platform)

  root.dataset.windowPlatform = metrics.platform
  root.style.setProperty('--window-chrome-height', metrics.chromeHeight)
  root.style.setProperty('--window-controls-left-safe', metrics.controlsLeftSafe)
  root.style.setProperty('--window-controls-right-safe', metrics.controlsRightSafe)
  root.style.setProperty('--window-toolbar-gap', metrics.toolbarGap)
}

export function syncWindowControlsOverlayToDocument(
  platform?: string | null,
  root: HTMLElement = document.documentElement,
  viewportWidth: number = window.innerWidth
) {
  const overlay = navigator.windowControlsOverlay
  if (!overlay || !overlay.visible || viewportWidth <= 0) {
    return false
  }

  const titlebarAreaRect = overlay.getTitlebarAreaRect()
  if (titlebarAreaRect.width <= 0 || titlebarAreaRect.height <= 0) {
    return false
  }

  const normalizedPlatform = normalizeWindowPlatform(platform)
  const overlayPadding = WINDOW_CONTROLS_OVERLAY_PADDING[normalizedPlatform]
  const controlsRightWidth = Math.max(0, viewportWidth - titlebarAreaRect.x - titlebarAreaRect.width)
  const chromeHeight = Math.max(parsePixels(WINDOW_CHROME_HEIGHT), titlebarAreaRect.height)
  const controlsLeftSafe = Math.max(overlayPadding.left, titlebarAreaRect.x + overlayPadding.left)
  const controlsRightSafe = Math.max(overlayPadding.right, controlsRightWidth + overlayPadding.right)

  root.style.setProperty('--window-chrome-height', toPixels(chromeHeight))
  root.style.setProperty('--window-controls-left-safe', toPixels(controlsLeftSafe))
  root.style.setProperty('--window-controls-right-safe', toPixels(controlsRightSafe))
  return true
}
