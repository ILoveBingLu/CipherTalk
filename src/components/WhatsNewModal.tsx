//更新说明！！！
import { Package, Image, Mic, Filter, Send, Aperture } from 'lucide-react'
import './WhatsNewModal.scss'

interface WhatsNewModalProps {
    onClose: () => void
    version: string
}

function WhatsNewModal({ onClose, version }: WhatsNewModalProps) {
    const updates = [
        {
            icon: <Package size={20} />,
            title: '优化',
            desc: '优化聊天消息去重逻辑。'
        },
        {
            icon: <Package size={20} />,
            title: '优化',
            desc: '优化多个界面样式，重点优化设置界面。'
        },
        // {
        //     icon: <Image size={20} />,
        //     title: '聊天内图片',
        //     desc: '支持查看谷歌标准实况图片(iOS端与大疆等实况图片,发送后实况暂不支持)。'
        // }
        // {
        //     icon: <Mic size={20} />,
        //     title: '语音导出',
        //     desc: '支持将语音消息解码为 WAV 格式导出，含转写文字。'
        // },
        {
            icon: <Filter size={20} />,
            title: '新增',
            desc: '新增API端点等功能。'
        },
        {
            icon: <Aperture size={20} />,
            title: '朋友圈',
            desc: '优化样式！'
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
