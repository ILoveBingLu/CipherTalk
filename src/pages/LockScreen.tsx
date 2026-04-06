import { useRef, useState, useEffect } from 'react'
import { useAppStore } from '../stores/appStore'
import { useAuthStore } from '../stores/authStore'
import { Lock, Fingerprint, AlertCircle, KeyRound, ChevronRight } from 'lucide-react'
import './LockScreen.scss'

export default function LockScreen() {
    const { userInfo } = useAppStore()
    const [password, setPassword] = useState('')
    const { unlock, verifyPassword, authMethod } = useAuthStore()
    const [isVerifying, setIsVerifying] = useState(false)
    const [error, setError] = useState('')
    const [platformInfo, setPlatformInfo] = useState<{ platform: string; arch: string }>({ platform: 'win32', arch: 'x64' })
    const hasInvokedRef = useRef(false)

    useEffect(() => {
        void window.electronAPI.app.getPlatformInfo().then(setPlatformInfo).catch(() => {
            // ignore
        })
    }, [])

    useEffect(() => {
        // 自动触发一次验证 (仅当生物识别时)
        if (authMethod === 'biometric' && !hasInvokedRef.current) {
            hasInvokedRef.current = true
            handleUnlock()
        }
    }, [authMethod])

    const handleUnlock = async () => {
        if (isVerifying) return
        setIsVerifying(true)
        setError('')

        try {
            const result = await unlock()
            if (!result.success) {
                // 如果是用户取消（比如刚启动时自动弹出被取消），可以不显示红色错误，或者显示比较温和的提示
                // 这里我们直接显示 store 中转换好的友好错误信息
                setError(result.error || '验证失败')
            }
        } catch (e: any) {
            // unlock 内部已经 catch 了所有错误并返回 friendly error，
            // 这里的 catch 理论上不会触发，除非 unlock 实现有变。
            // 依然做一个兜底
            console.error('LockScreen unlock error:', e)
            setError('验证过程发生意外错误')
        } finally {
            setIsVerifying(false)
        }
    }

    const handlePasswordUnlock = async (e?: React.FormEvent) => {
        e?.preventDefault()
        if (!password.trim() || isVerifying) return

        setIsVerifying(true)
        setError('')

        const result = await verifyPassword(password)
        if (!result.success) {
            setError(result.error || '密码错误')
            setIsVerifying(false)
        } else {
            // 成功，store 会自动更新状态，组件卸载
        }
    }

    return (
        <div className="lock-screen-overlay">
            <div className="lock-content">
                <div className="lock-avatar-container">
                    {userInfo?.avatarUrl ? (
                        <img src={userInfo.avatarUrl} alt="Avatar" className="lock-avatar" />
                    ) : (
                        <div className="lock-avatar" style={{ background: '#e0e0e0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <Lock size={32} color="#999" />
                        </div>
                    )}
                    <div className="lock-icon">
                        <Lock size={14} />
                    </div>
                </div>

                <div className="lock-info">
                    <h2>CipherTalk 已锁定</h2>
                    <p>{userInfo?.nickName ? `欢迎回来，${userInfo.nickName}` : '需要验证身份以继续'}</p>
                </div>

                {authMethod === 'biometric' ? (
                    <button
                        className="unlock-btn"
                        onClick={handleUnlock}
                        disabled={isVerifying}
                    >
                        <Fingerprint size={20} />
                        {isVerifying ? '正在验证...' : platformInfo.platform === 'darwin' ? '使用 Touch ID 解锁' : '使用 Windows Hello 解锁'}
                    </button>
                ) : (
                    <form className="password-form" onSubmit={handlePasswordUnlock}>
                        <div className="password-input-wrapper">
                            <input
                                type="password"
                                placeholder="请输入应用密码"
                                className="password-input"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                autoFocus
                            />
                            <button
                                type="submit"
                                className="password-submit-btn"
                                disabled={isVerifying || !password}
                            >
                                <ChevronRight size={20} />
                            </button>
                        </div>
                    </form>
                )}

                {error && (
                    <div className="error-message">
                        <AlertCircle size={14} />
                        <span>{error}</span>
                    </div>
                )}
            </div>
        </div>
    )
}
