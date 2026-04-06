import { ReactNode, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useTitleBarStore } from '../stores/titleBarStore'
import { useUpdateStatusStore } from '../stores/updateStatusStore'
import { useThemeStore } from '../stores/themeStore'
import './TitleBar.scss'

interface TitleBarProps {
  rightContent?: ReactNode
  title?: string
}

function TitleBar({ rightContent, title }: TitleBarProps) {
  const storeRightContent = useTitleBarStore(state => state.rightContent)
  const displayContent = rightContent ?? storeRightContent
  const isUpdating = useUpdateStatusStore(state => state.isUpdating)
  const appIcon = useThemeStore(state => state.appIcon)
  const [platform, setPlatform] = useState<'win32' | 'darwin' | 'linux'>('win32')

  useEffect(() => {
    void window.electronAPI.app.getPlatformInfo().then((info) => {
      setPlatform((info.platform as 'win32' | 'darwin' | 'linux') || 'win32')
    }).catch(() => {
      // ignore
    })
  }, [])

  const isMac = platform === 'darwin'
  const updateStatusNode = isUpdating ? (
    <div className="update-status">
      <RefreshCw
        className="update-indicator"
        size={16}
        strokeWidth={2.5}
      />
      <span className="update-text">正在同步数据...</span>
    </div>
  ) : null

  return (
    <div className={`title-bar ${isMac ? 'is-mac' : 'is-win'}`}>
      <div className="title-bar-left">
        {isMac ? (
          <div className="title-bar-traffic-spacer" aria-hidden="true" />
        ) : (
          <>
            <img src={appIcon === 'xinnian' ? "./xinnian.png" : "./logo.png"} alt="密语" className="title-logo" />
            <span className="titles">{title || 'CipherTalk'}</span>
            {updateStatusNode}
          </>
        )}
      </div>
      {isMac && (
        <div className="title-bar-center">
          <img src={appIcon === 'xinnian' ? "./xinnian.png" : "./logo.png"} alt="密语" className="title-logo" />
          <span className="titles">{title || 'CipherTalk'}</span>
        </div>
      )}
      <div className="title-bar-right">
        {isMac && updateStatusNode}
        {displayContent}
      </div>
    </div>
  )
}

export default TitleBar
