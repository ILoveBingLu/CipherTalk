import { X, Copy, Check } from 'lucide-react'
import { useState, useMemo } from 'react'
import './JsonViewerModal.scss'

interface JsonViewerModalProps {
  data: any
  title?: string
  onClose: () => void
}

// 简单的 JSON 语法高亮
function highlightJson(obj: any): string {
  const json = JSON.stringify(obj, null, 2)
  
  return json
    .replace(/(".*?"):/g, '<span class="json-key">$1</span>:')
    .replace(/: (".*?")/g, ': <span class="json-string">$1</span>')
    .replace(/: (true|false)/g, ': <span class="json-boolean">$1</span>')
    .replace(/: (null)/g, ': <span class="json-null">$1</span>')
    .replace(/: (-?\d+\.?\d*)/g, ': <span class="json-number">$1</span>')
}

export function JsonViewerModal({ data, title = '原始数据', onClose }: JsonViewerModalProps) {
  const [copied, setCopied] = useState(false)

  const highlightedJson = useMemo(() => highlightJson(data), [data])

  const handleCopy = () => {
    const jsonStr = JSON.stringify(data, null, 2)
    navigator.clipboard.writeText(jsonStr).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  return (
    <div className="json-viewer-modal-overlay" onClick={handleOverlayClick}>
      <div className="json-viewer-modal">
        <div className="json-viewer-header">
          <h3>{title}</h3>
          <div className="json-viewer-actions">
            <button 
              className="copy-btn" 
              onClick={handleCopy}
              title="复制到剪贴板"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? '已复制' : '复制'}
            </button>
            <button className="close-btn" onClick={onClose} title="关闭">
              <X size={20} />
            </button>
          </div>
        </div>
        <div className="json-viewer-content">
          <pre dangerouslySetInnerHTML={{ __html: highlightedJson }} />
        </div>
      </div>
    </div>
  )
}
