import { useState, useEffect, useCallback } from 'react'
import { Search, Download, FolderOpen, RefreshCw, Check, FileJson, FileText, Table, Loader2, X, FileSpreadsheet, Database, FileCode, CheckCircle, XCircle, ExternalLink, MessageSquare, Users, User, Filter, Image, Video, CircleUserRound, Smile, Mic, Paperclip } from 'lucide-react'
import DateRangePicker from '../components/DateRangePicker'
import { useTitleBarStore } from '../stores/titleBarStore'
import * as configService from '../services/config'
import './ExportPage.scss'

type ExportTab = 'chat' | 'contacts'

interface ChatSession {
  username: string
  displayName?: string
  avatarUrl?: string
  summary: string
  lastTimestamp: number
}

interface Contact {
  username: string
  displayName: string
  remark?: string
  nickname?: string
  avatarUrl?: string
  type: 'friend' | 'group' | 'official' | 'other'
}

interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'html' | 'txt' | 'excel' | 'sql'
  startDate: string
  endDate: string
  exportAvatars: boolean
  exportImages: boolean
  exportVideos: boolean
  exportEmojis: boolean
  exportVoices: boolean
  exportFiles: boolean
}

interface ContactExportOptions {
  format: 'json' | 'csv' | 'vcf'
  exportAvatars: boolean
  contactTypes: {
    friends: boolean
    groups: boolean
    officials: boolean
  }
  selectedUsernames?: string[]
}

interface ExportResult {
  success: boolean
  successCount?: number
  failCount?: number
  error?: string
}

// 会话类型筛选
type SessionTypeFilter = 'all' | 'group' | 'private'

function ExportPage() {
  const [activeTab, setActiveTab] = useState<ExportTab>('chat')
  const setTitleBarContent = useTitleBarStore(state => state.setRightContent)

  // 聊天导出状态
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [filteredSessions, setFilteredSessions] = useState<ChatSession[]>([])
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set())
  const [isLoading, setIsLoading] = useState(true)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [sessionTypeFilter, setSessionTypeFilter] = useState<SessionTypeFilter>('all')
  const [exportFolder, setExportFolder] = useState<string>('')
  const [isExporting, setIsExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState({
    current: 0,
    total: 0,
    currentName: '',
    phase: '',
    detail: ''
  })
  const [exportResult, setExportResult] = useState<ExportResult | null>(null)

  const [options, setOptions] = useState<ExportOptions>({
    format: 'chatlab',
    startDate: '',
    endDate: '',
    exportAvatars: true,
    exportImages: false,
    exportVideos: false,
    exportEmojis: false,
    exportVoices: false,
    exportFiles: false
  })

  // 通讯录导出状态
  const [contacts, setContacts] = useState<Contact[]>([])
  const [filteredContacts, setFilteredContacts] = useState<Contact[]>([])
  const [selectedContacts, setSelectedContacts] = useState<Set<string>>(new Set())
  const [contactSearchKeyword, setContactSearchKeyword] = useState('')
  const [isLoadingContacts, setIsLoadingContacts] = useState(false)
  const [contactOptions, setContactOptions] = useState<ContactExportOptions>({
    format: 'json',
    exportAvatars: true,
    contactTypes: {
      friends: true,
      groups: false,
      officials: false
    }
  })

  // 加载默认导出配置
  const loadDefaultExportConfig = useCallback(async () => {
    try {
      const defaultDateRange = await configService.getExportDefaultDateRange()
      const defaultAvatars = await configService.getExportDefaultAvatars()

      // 计算日期范围
      let startDate = ''
      let endDate = ''
      if (defaultDateRange > 0) {
        const today = new Date()

        const year = today.getFullYear()
        const month = String(today.getMonth() + 1).padStart(2, '0')
        const day = String(today.getDate()).padStart(2, '0')
        const todayStr = `${year}-${month}-${day}`

        if (defaultDateRange === 1) {
          // 最近1天 = 今天
          startDate = todayStr
          endDate = todayStr
        } else {
          // 其他天数：从 N 天前到今天
          const start = new Date(today)
          start.setDate(today.getDate() - defaultDateRange + 1)

          const startYear = start.getFullYear()
          const startMonth = String(start.getMonth() + 1).padStart(2, '0')
          const startDay = String(start.getDate()).padStart(2, '0')

          startDate = `${startYear}-${startMonth}-${startDay}`
          endDate = todayStr
        }
      }

      setOptions(prev => ({
        ...prev,
        startDate,
        endDate,
        exportAvatars: defaultAvatars
      }))

      setContactOptions(prev => ({
        ...prev,
        exportAvatars: defaultAvatars
      }))
    } catch (e) {
      console.error('加载默认导出配置失败:', e)
      // 即使加载失败也不影响页面显示，使用默认值
    }
  }, [])

  // 监听导出进度
  useEffect(() => {
    const removeListener = window.electronAPI.export.onProgress((data) => {
      // 将 phase 英文映射为中文描述
      const phaseMap: Record<string, string> = {
        'preparing': '正在准备...',
        'exporting': '正在导出消息...',
        'writing': '正在写入文件...',
        'complete': '导出完成'
      }
      setExportProgress({
        current: data.current || 0,
        total: data.total || 0,
        currentName: data.currentSession || '',
        phase: (data.phase ? phaseMap[data.phase] : undefined) || data.phase || '',
        detail: data.detail || ''
      })
    })

    return () => {
      removeListener()
    }
  }, [])

  // 加载聊天会话
  const loadSessions = useCallback(async () => {
    setIsLoading(true)
    try {
      const result = await window.electronAPI.chat.connect()
      if (!result.success) {
        console.error('连接失败:', result.error)
        setIsLoading(false)
        return
      }
      const sessionsResult = await window.electronAPI.chat.getSessions()
      if (sessionsResult.success && sessionsResult.sessions) {
        setSessions(sessionsResult.sessions)
        setFilteredSessions(sessionsResult.sessions)
      }
    } catch (e) {
      console.error('加载会话失败:', e)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // 加载通讯录
  const loadContacts = useCallback(async () => {
    setIsLoadingContacts(true)
    try {
      const result = await window.electronAPI.chat.connect()
      if (!result.success) {
        console.error('连接失败:', result.error)
        setIsLoadingContacts(false)
        return
      }
      const contactsResult = await window.electronAPI.chat.getContacts()
      if (contactsResult.success && contactsResult.contacts) {
        setContacts(contactsResult.contacts)
        setFilteredContacts(contactsResult.contacts)
      }
    } catch (e) {
      console.error('加载通讯录失败:', e)
    } finally {
      setIsLoadingContacts(false)
    }
  }, [])

  const loadExportPath = useCallback(async () => {
    try {
      const savedPath = await configService.getExportPath()
      if (savedPath) {
        setExportFolder(savedPath)
      } else {
        const downloadsPath = await window.electronAPI.app.getDownloadsPath()
        setExportFolder(downloadsPath)
      }
    } catch (e) {
      console.error('加载导出路径失败:', e)
    }
  }, [])

  useEffect(() => {
    loadSessions()
    loadExportPath()
    loadDefaultExportConfig()
  }, [loadSessions, loadExportPath, loadDefaultExportConfig])

  // 切换到通讯录时加载
  useEffect(() => {
    if (activeTab === 'contacts' && contacts.length === 0) {
      loadContacts()
    }
  }, [activeTab, contacts.length, loadContacts])

  // 设置标题栏右侧内容
  useEffect(() => {
    setTitleBarContent(
      <div className="export-tabs">
        <button
          className={`export-tab ${activeTab === 'chat' ? 'active' : ''}`}
          onClick={() => setActiveTab('chat')}
        >
          <MessageSquare size={14} />
          <span>聊天记录</span>
        </button>
        <button
          className={`export-tab ${activeTab === 'contacts' ? 'active' : ''}`}
          onClick={() => setActiveTab('contacts')}
        >
          <Users size={14} />
          <span>通讯录</span>
        </button>
      </div>
    )

    // 离开页面时清除
    return () => setTitleBarContent(null)
  }, [activeTab, setTitleBarContent])

  // 聊天会话搜索与类型过滤
  useEffect(() => {
    let filtered = sessions

    // 类型过滤
    if (sessionTypeFilter === 'group') {
      filtered = filtered.filter(s => s.username.includes('@chatroom'))
    } else if (sessionTypeFilter === 'private') {
      filtered = filtered.filter(s => !s.username.includes('@chatroom'))
    }

    // 关键词过滤
    if (searchKeyword.trim()) {
      const lower = searchKeyword.toLowerCase()
      filtered = filtered.filter(s =>
        s.displayName?.toLowerCase().includes(lower) ||
        s.username.toLowerCase().includes(lower)
      )
    }

    setFilteredSessions(filtered)
  }, [searchKeyword, sessions, sessionTypeFilter])

  // 通讯录搜索过滤
  useEffect(() => {
    let filtered = contacts

    // 类型过滤
    filtered = filtered.filter(c => {
      if (c.type === 'friend' && !contactOptions.contactTypes.friends) return false
      if (c.type === 'group' && !contactOptions.contactTypes.groups) return false
      if (c.type === 'official' && !contactOptions.contactTypes.officials) return false
      return true
    })

    // 关键词过滤
    if (contactSearchKeyword.trim()) {
      const lower = contactSearchKeyword.toLowerCase()
      filtered = filtered.filter(c =>
        c.displayName?.toLowerCase().includes(lower) ||
        c.remark?.toLowerCase().includes(lower) ||
        c.username.toLowerCase().includes(lower)
      )
    }

    setFilteredContacts(filtered)
  }, [contactSearchKeyword, contacts, contactOptions.contactTypes])

  const toggleSession = (username: string) => {
    const newSet = new Set(selectedSessions)
    if (newSet.has(username)) {
      newSet.delete(username)
    } else {
      newSet.add(username)
    }
    setSelectedSessions(newSet)
  }

  const toggleSelectAll = () => {
    if (selectedSessions.size === filteredSessions.length && filteredSessions.length > 0) {
      setSelectedSessions(new Set())
    } else {
      setSelectedSessions(new Set(filteredSessions.map(s => s.username)))
    }
  }

  // 快捷选择：仅选群聊
  const selectOnlyGroups = () => {
    const groupUsernames = filteredSessions
      .filter(s => s.username.includes('@chatroom'))
      .map(s => s.username)
    setSelectedSessions(new Set(groupUsernames))
  }

  // 快捷选择：仅选私聊
  const selectOnlyPrivate = () => {
    const privateUsernames = filteredSessions
      .filter(s => !s.username.includes('@chatroom'))
      .map(s => s.username)
    setSelectedSessions(new Set(privateUsernames))
  }

  const toggleContact = (username: string) => {
    const newSet = new Set(selectedContacts)
    if (newSet.has(username)) {
      newSet.delete(username)
    } else {
      newSet.add(username)
    }
    setSelectedContacts(newSet)
  }

  const toggleSelectAllContacts = () => {
    if (selectedContacts.size === filteredContacts.length && filteredContacts.length > 0) {
      setSelectedContacts(new Set())
    } else {
      setSelectedContacts(new Set(filteredContacts.map(c => c.username)))
    }
  }

  const getAvatarLetter = (name: string) => {
    if (!name) return '?'
    return [...name][0] || '?'
  }

  const openExportFolder = async () => {
    if (exportFolder) {
      await window.electronAPI.shell.openPath(exportFolder)
    }
  }

  // 选择导出文件夹
  const selectExportFolder = async () => {
    try {
      const result = await window.electronAPI.dialog.openFile({
        properties: ['openDirectory'],
        title: '选择导出位置'
      })
      if (!result.canceled && result.filePaths.length > 0) {
        const newPath = result.filePaths[0]
        setExportFolder(newPath)
        // 保存到配置
        await configService.setExportPath(newPath)
      }
    } catch (e) {
      console.error('选择文件夹失败:', e)
    }
  }

  // 导出聊天记录
  const startExport = async () => {
    if (selectedSessions.size === 0 || !exportFolder) return

    setIsExporting(true)
    setExportProgress({ current: 0, total: selectedSessions.size, currentName: '', phase: '准备导出', detail: '' })
    setExportResult(null)

    try {
      const sessionList = Array.from(selectedSessions)
      const exportOptions = {
        format: options.format,
        dateRange: (options.startDate && options.endDate) ? {
          start: Math.floor(new Date(options.startDate + 'T00:00:00').getTime() / 1000),
          end: Math.floor(new Date(options.endDate + 'T23:59:59').getTime() / 1000)
        } : null,
        exportAvatars: options.exportAvatars,
        exportImages: options.exportImages,
        exportVideos: options.exportVideos,
        exportEmojis: options.exportEmojis,
        exportVoices: options.exportVoices,
        exportFiles: options.exportFiles
      }

      if (options.format === 'chatlab' || options.format === 'chatlab-jsonl' || options.format === 'json' || options.format === 'excel' || options.format === 'html') {
        const result = await window.electronAPI.export.exportSessions(
          sessionList,
          exportFolder,
          exportOptions
        )
        setExportResult(result)
      } else {
        setExportResult({ success: false, error: `${options.format.toUpperCase()} 格式导出功能开发中...` })
      }
    } catch (e) {
      console.error('导出失败:', e)
      setExportResult({ success: false, error: String(e) })
    } finally {
      setIsExporting(false)
    }
  }

  // 导出通讯录
  const startContactExport = async () => {
    if (!exportFolder) return

    setIsExporting(true)
    setExportResult(null)

    try {
      const result = await window.electronAPI.export.exportContacts(
        exportFolder,
        {
          format: contactOptions.format,
          exportAvatars: contactOptions.exportAvatars,
          contactTypes: contactOptions.contactTypes,
          selectedUsernames: selectedContacts.size > 0 ? Array.from(selectedContacts) : undefined
        }
      )
      setExportResult(result)
    } catch (e) {
      console.error('导出通讯录失败:', e)
      setExportResult({ success: false, error: String(e) })
    } finally {
      setIsExporting(false)
    }
  }

  const chatFormatOptions = [
    { value: 'chatlab', label: 'ChatLab', icon: FileCode, desc: '标准格式，支持其他软件导入' },
    { value: 'chatlab-jsonl', label: 'ChatLab JSONL', icon: FileCode, desc: '流式格式，适合大量消息' },
    { value: 'json', label: 'JSON', icon: FileJson, desc: '详细格式，包含完整消息信息' },
    { value: 'html', label: 'HTML', icon: FileText, desc: '网页格式，可直接浏览' },
    { value: 'txt', label: 'TXT', icon: Table, desc: '纯文本，通用格式' },
    { value: 'excel', label: 'Excel', icon: FileSpreadsheet, desc: '电子表格，适合统计分析' },
    { value: 'sql', label: 'PostgreSQL', icon: Database, desc: '数据库脚本，便于导入到数据库' }
  ]

  const contactFormatOptions = [
    { value: 'json', label: 'JSON', icon: FileJson, desc: '结构化数据，便于程序处理' },
    { value: 'csv', label: 'CSV', icon: FileSpreadsheet, desc: '表格格式，可用Excel打开' },
    { value: 'vcf', label: 'vCard', icon: User, desc: '通讯录标准格式，可导入手机' }
  ]

  const getContactTypeIcon = (type: string) => {
    switch (type) {
      case 'friend': return <User size={14} />
      case 'group': return <Users size={14} />
      case 'official': return <MessageSquare size={14} />
      default: return <User size={14} />
    }
  }

  const getContactTypeName = (type: string) => {
    switch (type) {
      case 'friend': return '好友'
      case 'group': return '群聊'
      case 'official': return '公众号'
      default: return '其他'
    }
  }

  return (
    <div className="export-page">
      {/* 聊天记录导出 */}
      {activeTab === 'chat' && (
        <>
          <div className="session-panel">
            <div className="panel-header">
              <h2>选择会话</h2>
              <button className="icon-btn" onClick={loadSessions} disabled={isLoading}>
                <RefreshCw size={18} className={isLoading ? 'spin' : ''} />
              </button>
            </div>

            <div className="search-bar">
              <Search size={16} />
              <input
                type="text"
                placeholder="搜索联系人或群组..."
                value={searchKeyword}
                onChange={e => setSearchKeyword(e.target.value)}
              />
              {searchKeyword && (
                <button className="clear-btn" onClick={() => setSearchKeyword('')}>
                  <X size={14} />
                </button>
              )}
            </div>

            <div className="session-type-filter">
              <button
                className={`type-filter-btn ${sessionTypeFilter === 'all' ? 'active' : ''}`}
                onClick={() => setSessionTypeFilter('all')}
              >
                全部
              </button>
              <button
                className={`type-filter-btn ${sessionTypeFilter === 'group' ? 'active' : ''}`}
                onClick={() => setSessionTypeFilter('group')}
              >
                <Users size={13} />
                群聊
              </button>
              <button
                className={`type-filter-btn ${sessionTypeFilter === 'private' ? 'active' : ''}`}
                onClick={() => setSessionTypeFilter('private')}
              >
                <User size={13} />
                私聊
              </button>
            </div>

            <div className="select-actions">
              <div className="select-actions-left">
                <button className="select-all-btn" onClick={toggleSelectAll}>
                  {selectedSessions.size === filteredSessions.length && filteredSessions.length > 0 ? '取消全选' : '全选'}
                </button>
                <button className="select-type-btn" onClick={selectOnlyGroups} title="仅选中列表中的群聊">
                  <Users size={12} />
                  选群聊
                </button>
                <button className="select-type-btn" onClick={selectOnlyPrivate} title="仅选中列表中的私聊">
                  <User size={12} />
                  选私聊
                </button>
              </div>
              <span className="selected-count">已选 {selectedSessions.size} 个</span>
            </div>

            {isLoading ? (
              <div className="loading-state">
                <Loader2 size={24} className="spin" />
                <span>加载中...</span>
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="empty-state">
                <span>暂无会话</span>
              </div>
            ) : (
              <div className="export-session-list">
                {filteredSessions.map(session => (
                  <div
                    key={session.username}
                    className={`export-session-item ${selectedSessions.has(session.username) ? 'selected' : ''}`}
                    onClick={() => toggleSession(session.username)}
                  >
                    <div className="check-box">
                      {selectedSessions.has(session.username) && <Check size={14} />}
                    </div>
                    <div className="export-avatar">
                      {session.avatarUrl ? (
                        <img src={session.avatarUrl} alt="" />
                      ) : (
                        <span className={session.username.includes('@chatroom') ? 'group-placeholder' : ''}>
                          {session.username.includes('@chatroom') ? '群' : getAvatarLetter(session.displayName || session.username)}
                        </span>
                      )}
                    </div>
                    <div className="export-session-info">
                      <div className="export-session-name">{session.displayName || session.username}</div>
                      <div className="export-session-summary">{session.summary || '暂无消息'}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="settings-panel">
            <div className="panel-header">
              <h2>导出设置</h2>
            </div>

            <div className="settings-content">
              <div className="setting-section">
                <h3>导出格式</h3>
                <div className="format-options">
                  {chatFormatOptions.map(fmt => (
                    <div
                      key={fmt.value}
                      className={`format-card ${options.format === fmt.value ? 'active' : ''}`}
                      onClick={() => setOptions({ ...options, format: fmt.value as any })}
                    >
                      <fmt.icon size={24} />
                      <span className="format-label">{fmt.label}</span>
                      <span className="format-desc">{fmt.desc}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="setting-section">
                <h3>时间范围</h3>
                <div className="time-options">
                  <DateRangePicker
                    startDate={options.startDate}
                    endDate={options.endDate}
                    onStartDateChange={(date) => setOptions(prev => ({ ...prev, startDate: date }))}
                    onEndDateChange={(date) => setOptions(prev => ({ ...prev, endDate: date }))}
                  />
                  <p className="time-hint">不选择时间范围则导出全部消息</p>
                </div>
              </div>

              <div className="setting-section">
                <h3>导出选项</h3>
                <div className="export-options">
                  <label className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={options.exportAvatars}
                      onChange={e => setOptions(prev => ({ ...prev, exportAvatars: e.target.checked }))}
                    />
                    <div className="custom-checkbox"></div>
                    <CircleUserRound size={16} style={{ color: 'var(--text-tertiary)' }} />
                    <span>导出头像</span>
                  </label>
                  <label className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={options.exportImages}
                      onChange={e => setOptions(prev => ({ ...prev, exportImages: e.target.checked }))}
                    />
                    <div className="custom-checkbox"></div>
                    <Image size={16} style={{ color: 'var(--text-tertiary)' }} />
                    <span>导出图片</span>
                  </label>
                  <label className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={options.exportVideos}
                      onChange={e => setOptions(prev => ({ ...prev, exportVideos: e.target.checked }))}
                    />
                    <div className="custom-checkbox"></div>
                    <Video size={16} style={{ color: 'var(--text-tertiary)' }} />
                    <span>导出视频</span>
                  </label>
                  <label className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={options.exportEmojis}
                      onChange={e => setOptions(prev => ({ ...prev, exportEmojis: e.target.checked }))}
                    />
                    <div className="custom-checkbox"></div>
                    <Smile size={16} style={{ color: 'var(--text-tertiary)' }} />
                    <span>导出表情包</span>
                  </label>
                  <label className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={options.exportVoices}
                      onChange={e => setOptions(prev => ({ ...prev, exportVoices: e.target.checked }))}
                    />
                    <div className="custom-checkbox"></div>
                    <Mic size={16} style={{ color: 'var(--text-tertiary)' }} />
                    <span>导出语音</span>
                  </label>
                  <label className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={options.exportFiles}
                      onChange={e => setOptions(prev => ({ ...prev, exportFiles: e.target.checked }))}
                    />
                    <div className="custom-checkbox"></div>
                    <Paperclip size={16} style={{ color: 'var(--text-tertiary)' }} />
                    <span>导出文件</span>
                  </label>
                </div>
              </div>

              <div className="setting-section">
                <h3>导出位置</h3>
                <div className="export-path-select" onClick={selectExportFolder}>
                  <FolderOpen size={16} />
                  <span className="path-text">{exportFolder || '点击选择导出位置'}</span>
                  <span className="change-text">更改</span>
                </div>
              </div>
            </div>

            <div className="export-action">
              <button
                className="export-btn"
                onClick={startExport}
                disabled={selectedSessions.size === 0 || !exportFolder || isExporting}
              >
                {isExporting ? (
                  <>
                    <Loader2 size={18} className="spin" />
                    <span>导出中...</span>
                  </>
                ) : (
                  <>
                    <Download size={18} />
                    <span>开始导出</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </>
      )}

      {/* 通讯录导出 */}
      {activeTab === 'contacts' && (
        <>
          <div className="session-panel contacts-panel">
            <div className="panel-header">
              <h2>通讯录预览</h2>
              <button className="icon-btn" onClick={loadContacts} disabled={isLoadingContacts}>
                <RefreshCw size={18} className={isLoadingContacts ? 'spin' : ''} />
              </button>
            </div>

            <div className="search-bar">
              <Search size={16} />
              <input
                type="text"
                placeholder="搜索联系人..."
                value={contactSearchKeyword}
                onChange={e => setContactSearchKeyword(e.target.value)}
              />
              {contactSearchKeyword && (
                <button className="clear-btn" onClick={() => setContactSearchKeyword('')}>
                  <X size={14} />
                </button>
              )}
            </div>

            <div className="select-actions">
              <button className="select-all-btn" onClick={toggleSelectAllContacts}>
                {selectedContacts.size === filteredContacts.length && filteredContacts.length > 0 ? '取消全选' : '全选'}
              </button>
              <span className="selected-count">
                {selectedContacts.size > 0 ? `已选 ${selectedContacts.size} 个` : `共 ${filteredContacts.length} 个联系人`}
              </span>
            </div>

            {isLoadingContacts ? (
              <div className="loading-state">
                <Loader2 size={24} className="spin" />
                <span>加载中...</span>
              </div>
            ) : filteredContacts.length === 0 ? (
              <div className="empty-state">
                <span>暂无联系人</span>
              </div>
            ) : (
              <div className="contacts-list selectable">
                {filteredContacts.slice(0, 100).map(contact => (
                  <div
                    key={contact.username}
                    className={`contact-item ${selectedContacts.has(contact.username) ? 'selected' : ''}`}
                    onClick={() => toggleContact(contact.username)}
                  >
                    <div className="check-box">
                      {selectedContacts.has(contact.username) && <Check size={14} />}
                    </div>
                    <div className="contact-avatar">
                      {contact.avatarUrl ? (
                        <img src={contact.avatarUrl} alt="" />
                      ) : (
                        <span>{getAvatarLetter(contact.displayName)}</span>
                      )}
                    </div>
                    <div className="contact-info">
                      <div className="contact-name">{contact.displayName}</div>
                      {contact.remark && contact.remark !== contact.displayName && (
                        <div className="contact-remark">备注: {contact.remark}</div>
                      )}
                    </div>
                    <div className={`contact-type ${contact.type}`}>
                      {getContactTypeIcon(contact.type)}
                      <span>{getContactTypeName(contact.type)}</span>
                    </div>
                  </div>
                ))}
                {filteredContacts.length > 100 && (
                  <div className="contacts-more">
                    还有 {filteredContacts.length - 100} 个联系人...
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="settings-panel">
            <div className="panel-header">
              <h2>导出设置</h2>
            </div>

            <div className="settings-content">
              <div className="setting-section">
                <h3>导出格式</h3>
                <div className="format-options contact-formats">
                  {contactFormatOptions.map(fmt => (
                    <div
                      key={fmt.value}
                      className={`format-card ${contactOptions.format === fmt.value ? 'active' : ''}`}
                      onClick={() => setContactOptions(prev => ({ ...prev, format: fmt.value as any }))}
                    >
                      <fmt.icon size={24} />
                      <span className="format-label">{fmt.label}</span>
                      <span className="format-desc">{fmt.desc}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="setting-section">
                <h3>联系人类型</h3>
                <div className="export-options">
                  <label className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={contactOptions.contactTypes.friends}
                      onChange={e => setContactOptions(prev => ({
                        ...prev,
                        contactTypes: { ...prev.contactTypes, friends: e.target.checked }
                      }))}
                    />
                    <div className="custom-checkbox"></div>
                    <User size={16} />
                    <span>好友</span>
                  </label>
                  <label className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={contactOptions.contactTypes.groups}
                      onChange={e => setContactOptions(prev => ({
                        ...prev,
                        contactTypes: { ...prev.contactTypes, groups: e.target.checked }
                      }))}
                    />
                    <div className="custom-checkbox"></div>
                    <Users size={16} />
                    <span>群聊</span>
                  </label>
                  <label className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={contactOptions.contactTypes.officials}
                      onChange={e => setContactOptions(prev => ({
                        ...prev,
                        contactTypes: { ...prev.contactTypes, officials: e.target.checked }
                      }))}
                    />
                    <div className="custom-checkbox"></div>
                    <MessageSquare size={16} />
                    <span>公众号</span>
                  </label>
                </div>
              </div>

              <div className="setting-section">
                <h3>导出选项</h3>
                <div className="export-options">
                  <label className="checkbox-item">
                    <input
                      type="checkbox"
                      checked={contactOptions.exportAvatars}
                      onChange={e => setContactOptions(prev => ({ ...prev, exportAvatars: e.target.checked }))}
                    />
                    <div className="custom-checkbox"></div>
                    <span>导出头像</span>
                  </label>
                </div>
              </div>

              <div className="setting-section">
                <h3>导出位置</h3>
                <div className="export-path-select" onClick={selectExportFolder}>
                  <FolderOpen size={16} />
                  <span className="path-text">{exportFolder || '点击选择导出位置'}</span>
                  <span className="change-text">更改</span>
                </div>
              </div>
            </div>

            <div className="export-action">
              <button
                className="export-btn"
                onClick={startContactExport}
                disabled={!exportFolder || isExporting}
              >
                {isExporting ? (
                  <>
                    <Loader2 size={18} className="spin" />
                    <span>导出中...</span>
                  </>
                ) : (
                  <>
                    <Download size={18} />
                    <span>导出通讯录</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </>
      )}

      {/* 导出进度弹窗 */}
      {isExporting && (
        <div className="export-overlay">
          <div className="export-progress-modal">
            <div className="progress-spinner">
              <Loader2 size={32} className="spin" />
            </div>
            <h3>正在导出</h3>
            {exportProgress.phase && <p className="progress-phase">{exportProgress.phase}</p>}
            {exportProgress.currentName && (
              <p className="progress-text">当前会话: {exportProgress.currentName}</p>
            )}
            {exportProgress.detail && <p className="progress-detail">{exportProgress.detail}</p>}
            {!exportProgress.currentName && !exportProgress.detail && (
              <p className="progress-text">准备中...</p>
            )}
            <div className="progress-export-options">
              <span>格式: {options.format.toUpperCase()}</span>
              {options.exportImages && <span> · 含图片</span>}
              {options.exportVideos && <span> · 含视频</span>}
              {options.exportEmojis && <span> · 含表情</span>}
              {options.exportVoices && <span> · 含语音</span>}
              {options.exportFiles && <span> · 含文件</span>}
              {options.exportAvatars && <span> · 含头像</span>}
            </div>
            {exportProgress.total > 0 && (
              <>
                <div className="progress-bar">
                  <div
                    className="progress-fill"
                    style={{ width: `${(exportProgress.current / exportProgress.total) * 100}%` }}
                  />
                </div>
                <p className="progress-count">{exportProgress.current} / {exportProgress.total} 个会话</p>
              </>
            )}
          </div>
        </div>
      )}

      {/* 导出结果弹窗 */}
      {exportResult && (
        <div className="export-overlay">
          <div className="export-result-modal">
            <div className={`result-icon ${exportResult.success ? 'success' : 'error'}`}>
              {exportResult.success ? <CheckCircle size={48} /> : <XCircle size={48} />}
            </div>
            <h3>{exportResult.success ? '导出完成' : '导出失败'}</h3>
            {exportResult.success ? (
              <p className="result-text">
                {exportResult.successCount !== undefined
                  ? `成功导出 ${exportResult.successCount} 个${activeTab === 'chat' ? '会话' : '联系人'}`
                  : '导出成功'}
                {exportResult.failCount ? `，${exportResult.failCount} 个失败` : ''}
              </p>
            ) : (
              <p className="result-text error">{exportResult.error}</p>
            )}
            <div className="result-actions">
              {exportResult.success && (
                <button className="open-folder-btn" onClick={openExportFolder}>
                  <ExternalLink size={16} />
                  <span>打开文件夹</span>
                </button>
              )}
              <button className="close-btn" onClick={() => setExportResult(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ExportPage
