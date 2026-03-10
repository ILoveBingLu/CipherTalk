import { useState, type ReactElement } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import Avatar from '@mui/material/Avatar'
import Box from '@mui/material/Box'
import Divider from '@mui/material/Divider'
import Drawer from '@mui/material/Drawer'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { Home, MessageSquare, BarChart3, Users, FileText, Database, Settings, SquareChevronLeft, SquareChevronRight, Download, Aperture, Network } from 'lucide-react'
import { useAppStore } from '../stores/appStore'

const DRAWER_WIDTH = 220
const COLLAPSED_DRAWER_WIDTH = 72

type RouteItem = {
  key: string
  label: string
  icon: ReactElement
  type: 'route'
  path: string
}

type ActionItem = {
  key: string
  label: string
  icon: ReactElement
  type: 'action'
  onClick: () => void
}

type NavItemConfig = RouteItem | ActionItem

function Sidebar() {
  const location = useLocation()
  const userInfo = useAppStore(state => state.userInfo)
  const [collapsed, setCollapsed] = useState(false)
  const drawerWidth = collapsed ? COLLAPSED_DRAWER_WIDTH : DRAWER_WIDTH
  const userDisplayName = userInfo?.nickName?.trim() || userInfo?.alias?.trim() || '未连接用户'
  const userInitial = userDisplayName.slice(0, 1).toUpperCase()
  const widthTransition = '220ms cubic-bezier(0.4, 0, 0.2, 1)'
  const fadeTransition = '140ms ease'

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

  const navItems: NavItemConfig[] = [
    { key: 'home', label: '首页', icon: <Home size={20} />, type: 'route', path: '/home' },
    { key: 'chat', label: '聊天查看', icon: <MessageSquare size={20} />, type: 'action', onClick: openChatWindow },
    { key: 'moments', label: '朋友圈', icon: <Aperture size={20} />, type: 'action', onClick: openMomentsWindow },
    { key: 'analytics', label: '私聊分析', icon: <BarChart3 size={20} />, type: 'route', path: '/analytics' },
    { key: 'group-analytics', label: '群聊分析', icon: <Users size={20} />, type: 'action', onClick: openGroupAnalyticsWindow },
    { key: 'annual-report', label: '年度报告', icon: <FileText size={20} />, type: 'route', path: '/annual-report' },
    { key: 'export', label: '导出数据', icon: <Download size={20} />, type: 'route', path: '/export' },
    { key: 'data-management', label: '数据管理', icon: <Database size={20} />, type: 'route', path: '/data-management' },
    { key: 'open-api', label: '开放接口', icon: <Network size={20} />, type: 'route', path: '/open-api' },
  ]

  const navItemSx = {
    minHeight: 44,
    width: collapsed ? 44 : '100%',
    mx: collapsed ? 'auto' : 0,
    px: 1.25,
    py: 1,
    borderRadius: collapsed ? '50%' : '9999px',
    justifyContent: 'center',
    color: 'var(--text-secondary)',
    transition: `width 220ms cubic-bezier(0.4, 0, 0.2, 1), margin 220ms cubic-bezier(0.4, 0, 0.2, 1), border-radius 220ms cubic-bezier(0.4, 0, 0.2, 1), background-color 0.2s ease, color 0.2s ease`,
    '&:hover': {
      backgroundColor: 'var(--bg-tertiary)',
      color: 'var(--text-primary)',
    },
    '&.Mui-selected': {
      backgroundColor: 'var(--primary)',
      color: '#ffffff',
    },
    '&.Mui-selected:hover': {
      backgroundColor: 'var(--primary-hover)',
    },
  }

  const navItemIconSx = {
    minWidth: 24,
    width: 24,
    color: 'inherit',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  }

  const railContentSx = {
    display: 'flex',
    alignItems: 'center',
    overflow: 'hidden',
    width: collapsed ? '24px' : '100%',
    transition: `width ${widthTransition}`,
  }

  const profileContentSx = {
    display: 'flex',
    alignItems: 'center',
    overflow: 'hidden',
    width: collapsed ? '36px' : '100%',
    transition: `width ${widthTransition}`,
  }

  const createLabelSx = (maxWidth: number) => ({
    minWidth: 0,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    maxWidth: collapsed ? '0px' : `${maxWidth}px`,
    opacity: collapsed ? 0 : 1,
    transform: collapsed ? 'translateX(-8px)' : 'translateX(0)',
    marginLeft: collapsed ? '0px' : '12px',
    transition: [
      `max-width ${widthTransition}`,
      `opacity ${fadeTransition}`,
      `transform ${widthTransition}`,
      `margin-left ${widthTransition}`,
    ].join(', '),
  })

  const renderNavItem = (item: NavItemConfig) => {
    const selected = item.type === 'route' ? isActive(item.path) : false
    const button = (
      <ListItemButton
        selected={selected}
        {...(item.type === 'route'
          ? { component: NavLink, to: item.path }
          : { onClick: item.onClick })}
        sx={navItemSx}
      >
        <Box sx={railContentSx}>
          <ListItemIcon sx={navItemIconSx}>
            {item.icon}
          </ListItemIcon>
          <Box sx={createLabelSx(132)}>
            <Typography
              variant="body2"
              sx={{
                fontSize: 14,
                fontWeight: 500,
                color: 'inherit',
                lineHeight: 1.2,
              }}
            >
              {item.label}
            </Typography>
          </Box>
        </Box>
      </ListItemButton>
    )

    return (
      <ListItem key={item.key} disablePadding sx={{ display: 'block' }}>
        <Tooltip title={collapsed ? item.label : ''} placement="right">
          {button}
        </Tooltip>
      </ListItem>
    )
  }

  return (
    <Drawer
      variant="permanent"
      sx={{
        width: drawerWidth,
        flexShrink: 0,
        transition: 'width 0.25s ease',
        '& .MuiDrawer-paper': {
          width: drawerWidth,
          boxSizing: 'border-box',
          position: 'relative',
          height: '100%',
          overflowX: 'hidden',
          borderRight: '1px solid var(--border-color)',
          backgroundColor: 'var(--bg-secondary)',
          boxShadow: 'none',
          px: 1,
          py: 2,
          transition: 'width 0.25s ease',
          backdropFilter: 'blur(18px)',
        },
      }}
    >
      <Box
        component="nav"
        sx={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          minHeight: 0,
        }}
      >
        <List disablePadding sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          {navItems.map(renderNavItem)}
        </List>

        <Box sx={{ mt: 'auto', pt: 1.5 }}>
          <Divider sx={{ borderColor: 'var(--border-color)', mb: 1.5 }} />
          <List disablePadding sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            <ListItem disablePadding sx={{ display: 'block' }}>
              <Tooltip title={collapsed ? userDisplayName : ''} placement="right">
                <Box
                  sx={{
                    display: 'flex',
                    justifyContent: 'center',
                    minHeight: 52,
                    px: 1.25,
                    py: 1,
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                  }}
                >
                  <Box sx={profileContentSx}>
                    <Avatar
                      src={userInfo?.avatarUrl || undefined}
                      alt={userDisplayName}
                      sx={{
                        width: 36,
                        height: 36,
                        bgcolor: 'var(--primary)',
                        color: '#ffffff',
                        fontSize: 15,
                        fontWeight: 600,
                        flexShrink: 0,
                      }}
                    >
                      {userInitial}
                    </Avatar>
                    <Box sx={createLabelSx(140)}>
                      <Typography
                        variant="body2"
                        noWrap
                        sx={{
                          fontSize: 14,
                          fontWeight: 600,
                          color: 'var(--text-primary)',
                          lineHeight: 1.2,
                        }}
                      >
                        {userDisplayName}
                      </Typography>
                      <Typography
                        variant="caption"
                        sx={{
                          display: 'block',
                          mt: 0.35,
                          color: 'var(--text-tertiary)',
                          lineHeight: 1.2,
                        }}
                      >
                        当前用户
                      </Typography>
                    </Box>
                  </Box>
                </Box>
              </Tooltip>
            </ListItem>

            <ListItem disablePadding sx={{ display: 'block' }}>
              <Tooltip title={collapsed ? '设置' : ''} placement="right">
                <ListItemButton
                  component={NavLink}
                  to="/settings"
                  selected={isActive('/settings')}
                  sx={navItemSx}
                >
                  <Box sx={railContentSx}>
                    <ListItemIcon sx={navItemIconSx}>
                      <Settings size={20} />
                    </ListItemIcon>
                    <Box sx={createLabelSx(132)}>
                      <Typography
                        variant="body2"
                        sx={{
                          fontSize: 14,
                          fontWeight: 500,
                          color: 'inherit',
                          lineHeight: 1.2,
                        }}
                      >
                        设置
                      </Typography>
                    </Box>
                  </Box>
                </ListItemButton>
              </Tooltip>
            </ListItem>

            <ListItem disablePadding sx={{ display: 'block' }}>
              <Tooltip title={collapsed ? '展开菜单' : ''} placement="right">
                <ListItemButton
                  onClick={() => setCollapsed(!collapsed)}
                  sx={navItemSx}
                >
                  <Box sx={railContentSx}>
                    <ListItemIcon sx={navItemIconSx}>
                      {collapsed ? <SquareChevronRight size={18} /> : <SquareChevronLeft size={18} />}
                    </ListItemIcon>
                    <Box sx={createLabelSx(132)}>
                      <Typography
                        variant="body2"
                        sx={{
                          fontSize: 14,
                          fontWeight: 500,
                          color: 'inherit',
                          lineHeight: 1.2,
                        }}
                      >
                        {collapsed ? '展开' : '收回'}
                      </Typography>
                    </Box>
                  </Box>
                </ListItemButton>
              </Tooltip>
            </ListItem>
          </List>
        </Box>
      </Box>
    </Drawer>
  )
}

export default Sidebar
