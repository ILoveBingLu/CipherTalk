import { Package, Image, Mic, Filter, Send, Aperture } from 'lucide-react'
import './WhatsNewModal.scss'

interface WhatsNewModalProps {
    onClose: () => void
    version: string
}

function WhatsNewModal({ onClose, version }: WhatsNewModalProps) {
    const updates = [
        // {
        //     icon: <Package size={20} />,
        //     title: '媒体导出',
        //     desc: '导出聊天记录时可同时导出图片、视频、表情包和语音消息。'
        // },
        // {
        //     icon: <Image size={20} />,
        //     title: '图片自动解密',
        //     desc: '导出时自动解密未缓存的图片，无需提前在密语聊天窗口浏览。'
        // },
        // {
        //     icon: <Mic size={20} />,
        //     title: '语音导出',
        //     desc: '支持将语音消息解码为 WAV 格式导出，含转写文字。'
        // },
        // {
        //     icon: <Filter size={20} />,
        //     title: '分类导出',
        //     desc: '导出时可按群聊或个人聊天筛选，支持日期范围过滤。'
        // }
        {
            icon: <Aperture size={20} />,
            title: '朋友圈',
            desc: '新增朋友圈功能！'
        }
    ]

    const handleTelegram = () => {
        window.electronAPI?.shell?.openExternal?.('https://t.me/+p7YzmRMBm-gzNzJl')
    }

    return (
        <div className="whats-new-overlay">
            <div className="whats-new-modal">
                <div className="modal-header">
                    <span className="version-tag">新版本 {version}</span>
                    <h2>欢迎体验全新的密语</h2>
                    <p>我们为您带来了一些令人兴奋的改进</p>
                </div>

                <div className="modal-content">
                    <div className="update-list">
                        {updates.map((item, index) => (
                            <div className="update-item" key={index}>
                                <div className="item-icon">
                                    {item.icon}
                                </div>
                                <div className="item-info">
                                    <h3>{item.title}</h3>
                                    <p>{item.desc}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="modal-footer">
                    <button className="telegram-btn" onClick={handleTelegram}>
                        <Send size={16} />
                        加入 Telegram 频道
                    </button>
                    <button className="start-btn" onClick={onClose}>
                        开启新旅程
                    </button>
                </div>
            </div>
        </div>
    )
}

export default WhatsNewModal
