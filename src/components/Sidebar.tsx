import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { Home, MessageSquare, BarChart3, Users, FileText, Database, Settings, SquareChevronLeft, SquareChevronRight, Download, Aperture } from 'lucide-react'
import './Sidebar.scss'

function Sidebar() {
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)

  const isActive = (path: string) => {
    return location.pathname === path
  }

  const openChatWindow = async () => {
    try {
      await window.electronAPI.window.openChatWindow()
    } catch (e) {
      console.error('打开聊天窗口失败:', e)
    }
  }

  const openGroupAnalyticsWindow = async () => {
    try {
      await window.electronAPI.window.openGroupAnalyticsWindow()
    } catch (e) {
      console.error('打开群聊分析窗口失败:', e)
    }
  }

  const openMomentsWindow = async () => {
    try {
      await window.electronAPI.window.openMomentsWindow()
    } catch (e) {
      console.error('打开朋友圈窗口失败:', e)
    }
  }

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <nav className="nav-menu">
        {/* 首页 */}
        <NavLink
          to="/home"
          className={`nav-item ${isActive('/home') ? 'active' : ''}`}
          title={collapsed ? '首页' : undefined}
        >
          <span className="nav-icon"><Home size={20} /></span>
          <span className="nav-label">首页</span>
        </NavLink>

        {/* 聊天 - 打开独立窗口 */}
        <button
          className="nav-item"
          onClick={openChatWindow}
          title={collapsed ? '聊天查看' : undefined}
        >
          <span className="nav-icon"><MessageSquare size={20} /></span>
          <span className="nav-label">聊天查看</span>
        </button>

        {/* 朋友圈 - 打开独立窗口 */}
        <button
          className="nav-item"
          onClick={openMomentsWindow}
          title={collapsed ? '朋友圈' : undefined}
        >
          <span className="nav-icon"><Aperture size={20} /></span>
          <span className="nav-label">朋友圈</span>
        </button>

        {/* 私聊分析 */}
        <NavLink
          to="/analytics"
          className={`nav-item ${isActive('/analytics') ? 'active' : ''}`}
          title={collapsed ? '私聊分析' : undefined}
        >
          <span className="nav-icon"><BarChart3 size={20} /></span>
          <span className="nav-label">私聊分析</span>
        </NavLink>

        {/* 群聊分析 - 打开独立窗口 */}
        <button
          className="nav-item"
          onClick={openGroupAnalyticsWindow}
          title={collapsed ? '群聊分析' : undefined}
        >
          <span className="nav-icon"><Users size={20} /></span>
          <span className="nav-label">群聊分析</span>
        </button>

        {/* 年度报告 */}
        <NavLink
          to="/annual-report"
          className={`nav-item ${isActive('/annual-report') ? 'active' : ''}`}
          title={collapsed ? '年度报告' : undefined}
        >
          <span className="nav-icon"><FileText size={20} /></span>
          <span className="nav-label">年度报告</span>
        </NavLink>

        {/* 导出 */}
        <NavLink
          to="/export"
          className={`nav-item ${isActive('/export') ? 'active' : ''}`}
          title={collapsed ? '导出数据' : undefined}
        >
          <span className="nav-icon"><Download size={20} /></span>
          <span className="nav-label">导出数据</span>
        </NavLink>

        {/* 数据管理 */}
        <NavLink
          to="/data-management"
          className={`nav-item ${isActive('/data-management') ? 'active' : ''}`}
          title={collapsed ? '数据管理' : undefined}
        >
          <span className="nav-icon"><Database size={20} /></span>
          <span className="nav-label">数据管理</span>
        </NavLink>
      </nav>
      
      <div className="sidebar-footer">
        <NavLink 
          to="/settings" 
          className={`nav-item ${isActive('/settings') ? 'active' : ''}`}
          title={collapsed ? '设置' : undefined}
        >
          <span className="nav-icon">
            <Settings size={20} />
          </span>
          <span className="nav-label">设置</span>
        </NavLink>
        
        <button 
          className="collapse-btn"
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? '展开菜单' : '收起菜单'}
        >
          {collapsed ? <SquareChevronRight size={18} /> : <SquareChevronLeft size={18} />}
          <span className="collapse-label">{collapsed ? '展开' : '收回'}</span>
        </button>
      </div>
    </aside>
  )
}

export default Sidebar
