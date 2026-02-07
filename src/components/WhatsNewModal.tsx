import { Zap, Layout, Monitor, MessageSquareQuote, RefreshCw, Mic, Rocket, Sparkles } from 'lucide-react'
import './WhatsNewModal.scss'

interface WhatsNewModalProps {
    onClose: () => void
    version: string
}

function WhatsNewModal({ onClose, version }: WhatsNewModalProps) {
    const updates = [
        // {
        //     icon: <Rocket size={20} />,
        //     title: '性能优化',
        //     desc: '修复消息内容会出现重复的问题。'
        // },
        {
            icon: <MessageSquareQuote size={20} />,
            title: '优化1',
            desc: '优化图片加载逻辑。'
        },
        {
            icon: <MessageSquareQuote size={20} />,
            title: '优化2',
            desc: '优化批量语音转文字功能。'
        },
        // {
        //     icon: <Sparkles size={20} />,
        //     title: 'AI摘要',
        //     desc: '支持AI在单人会话以及群聊会话中进行AI摘要总结。（默认只能选择天数）'
        // },
        // {
        //     icon: <RefreshCw size={20} />,
        //     title: '体验升级',
        //     desc: '修复了一些已知的问题。'
        // }//,
        {
            icon: <Mic size={20} />,
            title: '新功能',
            desc: '数据管理界面可查看所有解密后的图片。'
        }
    ]

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
                    <button className="start-btn" onClick={onClose}>
                        开启新旅程
                    </button>
                </div>
            </div>
        </div>
    )
}

export default WhatsNewModal
