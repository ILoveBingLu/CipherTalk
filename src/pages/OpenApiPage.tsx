import { useEffect, useState, type ReactNode } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  CircularProgress,
  Container,
  IconButton,
  InputAdornment,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import { ChevronDown, ChevronUp, Copy, Eye, EyeOff, FileText, RefreshCw, RotateCcw, Save, Sparkles } from 'lucide-react'
import * as configService from '../services/config'
import { useTitleBarStore } from '../stores/titleBarStore'

const HTTP_API_DOC_URL = 'https://ciphertalk.apifox.cn/'

type ToastState = {
  text: string
  success: boolean
}

type HttpApiStatus = {
  running: boolean
  host: string
  port: number
  enabled: boolean
  startedAt: string
  uptimeMs: number
  tokenConfigured: boolean
  tokenPreview: string
  baseUrl: string
  endpoints: Array<{ method: string; path: string; desc: string }>
  lastError: string
}

type StatusMetricCardProps = {
  label: string
  value: ReactNode
  helper?: string
}

const LARGE_RADIUS = '28px'
const MEDIUM_RADIUS = '24px'
const SMALL_RADIUS = '20px'

const monoSx = {
  fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)',
}

const cardSx = {
  borderRadius: LARGE_RADIUS,
  border: 'none',
  bgcolor: 'transparent',
  backdropFilter: 'none',
  boxShadow: 'none',
  overflow: 'visible',
}

const sectionHeaderSx = {
  px: { xs: 0.5, md: 1 },
  pt: 0,
  pb: 1.5,
}

const sectionContentSx = {
  px: { xs: 0.5, md: 1 },
  pt: 0,
  '&:last-child': {
    pb: 0,
  },
}

const pillButtonSx = {
  borderRadius: '999px',
  px: 2.25,
  minHeight: 44,
  textTransform: 'none',
  fontWeight: 600,
}

const primaryButtonSx = {
  ...pillButtonSx,
  color: '#fff',
  background: 'var(--primary-gradient)',
  boxShadow: '0 10px 28px var(--primary-light)',
  '&:hover': {
    background: 'var(--primary-gradient)',
    filter: 'brightness(0.98)',
    boxShadow: '0 12px 30px var(--primary-light)',
  },
  '&.Mui-disabled': {
    color: 'var(--text-tertiary)',
    background: 'var(--bg-tertiary)',
    boxShadow: 'none',
  },
}

const secondaryButtonSx = {
  ...pillButtonSx,
  color: 'var(--text-primary)',
  borderColor: 'var(--border-color)',
  backgroundColor: 'var(--bg-secondary)',
  '&:hover': {
    borderColor: 'var(--primary)',
    backgroundColor: 'var(--primary-light)',
  },
  '&.Mui-disabled': {
    color: 'var(--text-tertiary)',
    borderColor: 'var(--border-color)',
    backgroundColor: 'transparent',
  },
}

const inlineIconButtonSx = {
  color: 'var(--text-secondary)',
  bgcolor: 'transparent',
  borderRadius: '999px',
  '&:hover': {
    color: 'var(--text-primary)',
    bgcolor: 'var(--primary-light)',
  },
}

const codePillSx = {
  ...monoSx,
  display: 'inline-flex',
  alignItems: 'center',
  px: 1,
  py: 0.5,
  borderRadius: '999px',
  fontSize: 12,
  bgcolor: 'var(--bg-tertiary)',
  border: '1px solid var(--border-color)',
  color: 'var(--text-primary)',
}

const panelSx = {
  p: 2.25,
  borderRadius: MEDIUM_RADIUS,
  border: '1px solid var(--border-color)',
  bgcolor: 'var(--bg-secondary)',
  boxShadow: '0 6px 18px rgba(0, 0, 0, 0.03)',
}

const textFieldSx = {
  '& .MuiInputLabel-root': {
    color: 'var(--text-secondary)',
  },
  '& .MuiInputLabel-root.Mui-focused': {
    color: 'var(--primary)',
  },
  '& .MuiOutlinedInput-root': {
    height: 42,
    borderRadius: '999px',
    color: 'var(--text-primary)',
    backgroundColor: 'var(--bg-secondary)',
    overflow: 'hidden',
    alignItems: 'stretch',
    pr: 0,
    '& fieldset': {
      borderColor: 'var(--border-color)',
    },
    '&:hover fieldset': {
      borderColor: 'var(--primary)',
    },
    '&.Mui-focused': {
      boxShadow: '0 0 0 4px var(--primary-light)',
    },
    '&.Mui-focused fieldset': {
      borderColor: 'var(--primary)',
      borderWidth: 1,
    },
  },
  '& .MuiInputBase-input': {
    paddingTop: '10px',
    paddingBottom: '10px',
    paddingLeft: '16px',
    paddingRight: '12px',
    color: 'var(--text-primary)',
  },
  '& input[type=number]': {
    appearance: 'textfield',
  },
  '& input[type=number]::-webkit-outer-spin-button, & input[type=number]::-webkit-inner-spin-button': {
    WebkitAppearance: 'none',
    margin: 0,
  },
  '& .MuiInputAdornment-root': {
    margin: 0,
    alignSelf: 'stretch',
    maxHeight: 'none',
    height: '100%',
  },
  '& .MuiFormHelperText-root': {
    marginLeft: 1.5,
    marginTop: 0.75,
    color: 'var(--text-tertiary)',
  },
  '& .MuiFormHelperText-root.Mui-error': {
    color: 'var(--danger)',
  },
}

const endpointCardSx = {
  p: 2.25,
  borderRadius: MEDIUM_RADIUS,
  border: '1px solid var(--border-color)',
  bgcolor: 'var(--bg-secondary)',
  boxShadow: '0 6px 18px rgba(0, 0, 0, 0.03)',
}

const endpointPathSx = {
  ...codePillSx,
  px: 1.4,
  py: 0.85,
  fontSize: 13,
}

const tertiaryButtonSx = {
  borderRadius: '999px',
  minHeight: 34,
  px: 1.5,
  textTransform: 'none',
  color: 'var(--text-secondary)',
  borderColor: 'var(--border-color)',
  backgroundColor: 'transparent',
  '&:hover': {
    borderColor: 'var(--primary)',
    color: 'var(--primary)',
    backgroundColor: 'var(--primary-light)',
  },
}

const stepperButtonSx = {
  width: '100%',
  flex: 1,
  minWidth: 0,
  borderRadius: 0,
  color: 'var(--text-secondary)',
  backgroundColor: 'transparent',
  '& + &': {
    borderTop: '1px solid var(--border-color)',
  },
  '&:hover': {
    color: 'var(--primary)',
    bgcolor: 'var(--primary-light)',
  },
}

const switchSx = {
  '& .MuiSwitch-switchBase.Mui-checked': {
    color: 'var(--primary)',
  },
  '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': {
    backgroundColor: 'var(--primary)',
    opacity: 1,
  },
  '& .MuiSwitch-track': {
    borderRadius: '999px',
    backgroundColor: 'var(--text-tertiary)',
    opacity: 0.35,
  },
}

const getChipSx = (tone: 'primary' | 'neutral' | 'danger' = 'neutral') => {
  if (tone === 'primary') {
    return {
      borderRadius: '999px',
      border: '1px solid var(--primary)',
      color: 'var(--primary)',
      backgroundColor: 'var(--primary-light)',
      fontWeight: 700,
    }
  }

  if (tone === 'danger') {
    return {
      borderRadius: '999px',
      border: '1px solid rgba(220, 53, 69, 0.24)',
      color: 'var(--danger)',
      backgroundColor: 'rgba(220, 53, 69, 0.08)',
      fontWeight: 700,
    }
  }

  return {
    borderRadius: '999px',
    border: '1px solid var(--border-color)',
    color: 'var(--text-secondary)',
    backgroundColor: 'var(--bg-secondary)',
    fontWeight: 700,
  }
}

const getAlertSx = (tone: 'primary' | 'neutral' | 'danger' = 'primary') => ({
  borderRadius: MEDIUM_RADIUS,
  border: '1px solid',
  borderColor: tone === 'danger' ? 'rgba(220, 53, 69, 0.24)' : 'var(--border-color)',
  bgcolor: tone === 'danger'
    ? 'rgba(220, 53, 69, 0.08)'
    : tone === 'primary'
      ? 'var(--primary-light)'
      : 'var(--bg-secondary)',
  color: 'var(--text-primary)',
  '& .MuiAlert-icon': {
    color: tone === 'danger' ? 'var(--danger)' : 'var(--primary)',
  },
})

function formatDuration(durationMs: number) {
  if (!durationMs || durationMs <= 0) {
    return '0 秒'
  }

  const totalSeconds = Math.floor(durationMs / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const parts = [
    days > 0 ? `${days} 天` : null,
    hours > 0 ? `${hours} 小时` : null,
    minutes > 0 ? `${minutes} 分钟` : null,
    seconds > 0 ? `${seconds} 秒` : null,
  ].filter(Boolean)

  return parts.slice(0, 3).join(' ')
}

function createRandomToken() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `ct_${crypto.randomUUID().replace(/-/g, '')}`
  }

  const randomPart = Math.random().toString(36).slice(2)
  const randomPart2 = Math.random().toString(36).slice(2)
  return `ct_${Date.now().toString(36)}_${randomPart}${randomPart2}`
}

function getEndpointUrl(baseUrl: string, path: string) {
  if (path === '/v1' || path === '/v1/') {
    return baseUrl
  }

  return `${baseUrl}${path.replace(/^\/v1/, '')}`
}

function StatusMetricCard({ label, value, helper }: StatusMetricCardProps) {
  return (
    <Box
      sx={{
        p: 2.25,
        borderRadius: MEDIUM_RADIUS,
        border: '1px solid var(--border-color)',
        bgcolor: 'var(--bg-secondary)',
        boxShadow: '0 6px 18px rgba(0, 0, 0, 0.03)',
      }}
    >
      <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1.5}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="caption" sx={{ color: 'var(--text-tertiary)', display: 'block' }}>
            {label}
          </Typography>
          {helper && (
            <Typography variant="caption" sx={{ mt: 0.5, display: 'block', color: 'var(--text-tertiary)' }}>
              {helper}
            </Typography>
          )}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', textAlign: 'right', flexShrink: 0, minWidth: 'fit-content' }}>
          {typeof value === 'string'
            ? (
              <Typography variant="body2" sx={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                {value}
              </Typography>
            )
            : value}
        </Box>
      </Stack>
    </Box>
  )
}

function OpenApiPage() {
  const [message, setMessage] = useState<ToastState | null>(null)
  const [httpApiEnabled, setHttpApiEnabled] = useState(false)
  const [httpApiPort, setHttpApiPort] = useState(5031)
  const [httpApiToken, setHttpApiToken] = useState('')
  const [showHttpApiToken, setShowHttpApiToken] = useState(false)
  const [httpApiStatus, setHttpApiStatus] = useState<HttpApiStatus | null>(null)
  const [isSavingHttpApi, setIsSavingHttpApi] = useState(false)
  const [isRefreshingHttpApi, setIsRefreshingHttpApi] = useState(false)
  const [nowTs, setNowTs] = useState(Date.now())

  const setTitleBarContent = useTitleBarStore(state => state.setRightContent)

  const showMessage = (text: string, success: boolean) => {
    setMessage({ text, success })
  }

  const copyText = async (text: string, successText: string) => {
    try {
      await navigator.clipboard.writeText(text)
      showMessage(successText, true)
    } catch {
      showMessage('复制失败，请手动复制', false)
    }
  }

  useEffect(() => {
    const load = async () => {
      try {
        const enabled = await configService.getHttpApiEnabled()
        const port = await configService.getHttpApiPort()
        const token = await configService.getHttpApiToken()

        setHttpApiEnabled(enabled)
        setHttpApiPort(port)
        setHttpApiToken(token)

        const statusResult = await window.electronAPI.httpApi.getStatus()
        if (statusResult.success && statusResult.status) {
          setHttpApiStatus(statusResult.status)
        }
      } catch (error) {
        showMessage(`加载开放接口配置失败: ${error}`, false)
      }
    }

    load()
  }, [])

  useEffect(() => {
    if (!httpApiStatus?.running) {
      return
    }

    const timer = window.setInterval(() => setNowTs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [httpApiStatus?.running])

  useEffect(() => {
    setTitleBarContent(
      <Button
        variant="outlined"
        size="small"
        startIcon={<FileText size={14} />}
        onClick={() => window.electronAPI.shell.openExternal(HTTP_API_DOC_URL)}
        sx={{
          ...secondaryButtonSx,
          minHeight: 34,
          px: 1.5,
        }}
      >
        接口文档
      </Button>
    )

    return () => setTitleBarContent(null)
  }, [setTitleBarContent])

  const refreshHttpApiStatus = async () => {
    setIsRefreshingHttpApi(true)

    try {
      const result = await window.electronAPI.httpApi.getStatus()
      if (result.success && result.status) {
        setHttpApiStatus(result.status)
        setHttpApiEnabled(result.status.enabled)
        setHttpApiPort(result.status.port)
      } else {
        showMessage(result.error || '获取接口状态失败', false)
      }
    } catch (error) {
      showMessage(`获取接口状态失败: ${error}`, false)
    } finally {
      setIsRefreshingHttpApi(false)
    }
  }

  const isPortInvalid = !Number.isInteger(httpApiPort) || httpApiPort < 1 || httpApiPort > 65535

  const handleSaveHttpApiSettings = async () => {
    if (isPortInvalid) {
      showMessage('监听端口需在 1 到 65535 之间', false)
      return
    }

    setIsSavingHttpApi(true)

    try {
      const result = await window.electronAPI.httpApi.applySettings({
        enabled: httpApiEnabled,
        port: httpApiPort,
        token: httpApiToken,
      })

      if (result.success && result.status) {
        setHttpApiStatus(result.status)
        setHttpApiPort(result.status.port)
        await configService.setHttpApiEnabled(httpApiEnabled)
        await configService.setHttpApiPort(result.status.port)
        await configService.setHttpApiToken(httpApiToken)
        showMessage('开放接口配置已保存并生效', true)
      } else {
        showMessage(result.error || '保存开放接口配置失败', false)
      }
    } catch (error) {
      showMessage(`保存开放接口配置失败: ${error}`, false)
    } finally {
      setIsSavingHttpApi(false)
    }
  }

  const handleRestartHttpApi = async () => {
    setIsRefreshingHttpApi(true)

    try {
      const result = await window.electronAPI.httpApi.restart()
      if (result.success && result.status) {
        setHttpApiStatus(result.status)
        showMessage('接口服务已重启', true)
      } else {
        showMessage(result.error || '接口服务重启失败', false)
      }
    } catch (error) {
      showMessage(`接口服务重启失败: ${error}`, false)
    } finally {
      setIsRefreshingHttpApi(false)
    }
  }

  const status = httpApiStatus
  const startedAtMs = status?.startedAt ? new Date(status.startedAt).getTime() : 0
  const uptime = status?.running && startedAtMs > 0
    ? Math.max(0, nowTs - startedAtMs)
    : (status?.uptimeMs ?? 0)
  const uptimeText = formatDuration(uptime)
  const fallbackBaseUrl = `http://127.0.0.1:${isPortInvalid ? 5031 : httpApiPort}/v1`
  const baseUrl = status?.baseUrl || fallbackBaseUrl

  return (
    <>
      <Box sx={{ height: '100%', overflowY: 'auto', pb: 3 }}>
        <Container maxWidth="lg" sx={{ px: { xs: 2, md: 3 }, py: 3 }}>
          <Stack spacing={3}>
            <Box>
              <Stack
                direction={{ xs: 'column', md: 'row' }}
                alignItems={{ xs: 'flex-start', md: 'center' }}
                justifyContent="space-between"
                gap={2}
              >
                <Box>
                  <Typography
                    variant="h4"
                    sx={{
                      fontSize: { xs: 26, md: 30 },
                      fontWeight: 700,
                      color: 'var(--text-primary)',
                    }}
                  >
                    开放接口
                  </Typography>
                  <Typography variant="body2" sx={{ mt: 1, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
                    用于给外部工具调用，默认仅监听本机地址
                    <Box component="span" sx={{ ...codePillSx, mx: 1 }}>127.0.0.1</Box>
                    ，正式接口统一使用
                    <Box component="span" sx={{ ...codePillSx, mx: 1 }}>/v1</Box>
                    前缀。
                  </Typography>
                </Box>

                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                  <Chip label="仅本机监听" variant="outlined" size="small" sx={getChipSx('neutral')} />
                  <Chip
                    label={httpApiToken ? 'Bearer 鉴权已配置' : 'Bearer 鉴权可选'}
                    variant="outlined"
                    size="small"
                    sx={getChipSx(httpApiToken ? 'primary' : 'neutral')}
                  />
                </Stack>
              </Stack>
            </Box>

            <Alert
              severity={httpApiEnabled ? 'info' : 'warning'}
              variant="outlined"
              sx={getAlertSx(httpApiEnabled ? 'primary' : 'neutral')}
            >
              {httpApiEnabled
                ? 'HTTP API 已处于启用配置。修改端口或密钥后，需要点击“保存并应用”同步到本地服务。'
                : 'HTTP API 当前关闭。保存并应用后才会开始监听端口，对外提供接口。'}
            </Alert>

            <Card variant="outlined" sx={cardSx}>
              <CardHeader
                sx={sectionHeaderSx}
                title="配置与控制"
                subheader="使用 MUI 组件统一管理开关、端口、令牌和服务操作。"
                titleTypographyProps={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}
                subheaderTypographyProps={{ color: 'var(--text-secondary)' }}
              />
              <CardContent sx={sectionContentSx}>
                <Stack spacing={2.5}>
                  <Box sx={panelSx}>
                    <Stack
                      direction={{ xs: 'column', sm: 'row' }}
                      alignItems={{ xs: 'flex-start', sm: 'center' }}
                      justifyContent="space-between"
                      gap={2}
                    >
                      <Box>
                        <Typography variant="subtitle1" sx={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                          启用 HTTP API
                        </Typography>
                        <Typography variant="body2" sx={{ mt: 0.5, color: 'var(--text-secondary)' }}>
                          关闭后会停止监听端口，不再接受外部请求。
                        </Typography>
                      </Box>

                      <Switch
                        checked={httpApiEnabled}
                        onChange={(event) => setHttpApiEnabled(event.target.checked)}
                        sx={switchSx}
                        inputProps={{
                          'aria-label': httpApiEnabled ? '关闭 HTTP API' : '启用 HTTP API',
                        }}
                      />
                    </Stack>
                  </Box>

                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: { xs: '1fr', md: 'minmax(220px, 300px) 1fr' },
                      gap: 2,
                    }}
                  >
                    <TextField
                      label="监听端口"
                      type="number"
                      fullWidth
                      size="small"
                      sx={{
                        ...textFieldSx,
                        '& input[type=number]': {
                          appearance: 'textfield',
                        },
                        '& input[type=number]::-webkit-outer-spin-button, & input[type=number]::-webkit-inner-spin-button': {
                          WebkitAppearance: 'none',
                          margin: 0,
                        },
                      }}
                      value={httpApiPort || ''}
                      onChange={(event) => {
                        const nextPort = Number(event.target.value)
                        setHttpApiPort(Number.isNaN(nextPort) ? 0 : nextPort)
                      }}
                      error={isPortInvalid}
                      helperText={isPortInvalid ? '端口必须在 1 到 65535 之间' : '建议保持默认 5031'}
                      inputProps={{ min: 1, max: 65535, inputMode: 'numeric' }}
                      InputProps={{
                        endAdornment: (
                          <InputAdornment
                            position="end"
                            sx={{
                              alignSelf: 'stretch',
                              maxHeight: 'none',
                              m: 0,
                              height: '100%',
                            }}
                          >
                            <Box
                              sx={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignSelf: 'stretch',
                                justifyContent: 'stretch',
                                width: 48,
                                flexShrink: 0,
                                height: '100%',
                                mr: 0,
                                ml: 1,
                                borderLeft: '1px solid var(--border-color)',
                                bgcolor: 'var(--bg-tertiary)',
                                overflow: 'hidden',
                                borderTopRightRadius: '999px',
                                borderBottomRightRadius: '999px',
                              }}
                            >
                              <IconButton
                                size="small"
                                aria-label="端口加 1"
                                onClick={() => setHttpApiPort((p) => Math.min(65535, (p && p > 0 ? p : 5031) + 1))}
                                disabled={httpApiPort >= 65535}
                                sx={{ ...stepperButtonSx, p: 0, minHeight: 0 }}
                              >
                                <ChevronUp size={14} />
                              </IconButton>
                              <IconButton
                                size="small"
                                aria-label="端口减 1"
                                onClick={() => setHttpApiPort((p) => Math.max(1, (p && p > 0 ? p : 5031) - 1))}
                                disabled={httpApiPort <= 1}
                                sx={{ ...stepperButtonSx, p: 0, minHeight: 0 }}
                              >
                                <ChevronDown size={14} />
                              </IconButton>
                            </Box>
                          </InputAdornment>
                        ),
                      }}
                    />

                    <TextField
                      label="访问密钥（可选）"
                      type={showHttpApiToken ? 'text' : 'password'}
                      fullWidth
                      size="small"
                      sx={textFieldSx}
                      value={httpApiToken}
                      onChange={(event) => setHttpApiToken(event.target.value)}
                      placeholder="留空表示不启用令牌鉴权"
                      helperText="设置后，请使用 Authorization: Bearer <token> 调用受保护接口。"
                      InputProps={{
                        endAdornment: (
                          <InputAdornment position="end">
                            <Box
                              sx={{
                                alignSelf: 'stretch',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                flexShrink: 0,
                                height: '100%',
                                px: 1,
                                ml: 1,
                                borderLeft: '1px solid var(--border-color)',
                                bgcolor: 'var(--bg-tertiary)',
                                overflow: 'hidden',
                                borderTopRightRadius: '999px',
                                borderBottomRightRadius: '999px',
                              }}
                            >
                              <Stack direction="row" spacing={0.5}>
                                <Tooltip title={showHttpApiToken ? '隐藏密钥' : '显示密钥'}>
                                  <IconButton
                                    edge="end"
                                    aria-label={showHttpApiToken ? '隐藏密钥' : '显示密钥'}
                                    onClick={() => setShowHttpApiToken((value) => !value)}
                                    sx={inlineIconButtonSx}
                                  >
                                    {showHttpApiToken ? <EyeOff size={16} /> : <Eye size={16} />}
                                  </IconButton>
                                </Tooltip>

                                <Tooltip title="生成随机密钥">
                                  <IconButton
                                    edge="end"
                                    aria-label="生成随机密钥"
                                    onClick={() => setHttpApiToken(createRandomToken())}
                                    sx={inlineIconButtonSx}
                                  >
                                    <Sparkles size={16} />
                                  </IconButton>
                                </Tooltip>

                                {httpApiToken && (
                                  <Tooltip title="复制访问密钥">
                                    <IconButton
                                      edge="end"
                                      aria-label="复制访问密钥"
                                      onClick={() => copyText(httpApiToken, '访问密钥已复制')}
                                      sx={inlineIconButtonSx}
                                    >
                                      <Copy size={16} />
                                    </IconButton>
                                  </Tooltip>
                                )}
                              </Stack>
                            </Box>
                          </InputAdornment>
                        ),
                      }}
                    />
                  </Box>

                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                    <Button
                      variant="contained"
                      disableElevation
                      onClick={handleSaveHttpApiSettings}
                      disabled={isSavingHttpApi}
                      startIcon={isSavingHttpApi ? <CircularProgress size={16} color="inherit" /> : <Save size={16} />}
                      sx={primaryButtonSx}
                    >
                      {isSavingHttpApi ? '保存中...' : '保存并应用'}
                    </Button>

                    <Button
                      variant="outlined"
                      onClick={refreshHttpApiStatus}
                      disabled={isRefreshingHttpApi}
                      startIcon={isRefreshingHttpApi ? <CircularProgress size={16} color="inherit" /> : <RefreshCw size={16} />}
                      sx={secondaryButtonSx}
                    >
                      刷新状态
                    </Button>

                    <Button
                      variant="outlined"
                      onClick={handleRestartHttpApi}
                      disabled={isRefreshingHttpApi || !httpApiEnabled}
                      startIcon={<RotateCcw size={16} />}
                      sx={secondaryButtonSx}
                    >
                      重启服务
                    </Button>
                  </Stack>
                </Stack>
              </CardContent>
            </Card>

            <Card variant="outlined" sx={cardSx}>
              <CardHeader
                sx={sectionHeaderSx}
                title="接口状态与信息"
                subheader="展示当前服务状态、监听信息和复制友好的调用入口。"
                titleTypographyProps={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}
                subheaderTypographyProps={{ color: 'var(--text-secondary)' }}
              />
              <CardContent sx={sectionContentSx}>
                {status ? (
                  <Stack spacing={1.75}>
                    <Box
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
                        gap: 1.25,
                        alignItems: 'start',
                      }}
                    >
                      <TextField
                        label="基础地址"
                        value={baseUrl}
                        fullWidth
                        size="small"
                        sx={textFieldSx}
                        InputProps={{
                          readOnly: true,
                          endAdornment: (
                            <InputAdornment position="end">
                              <Box
                                sx={{
                                  alignSelf: 'stretch',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  flexShrink: 0,
                                  width: 48,
                                  height: '100%',
                                  ml: 1,
                                  borderLeft: '1px solid var(--border-color)',
                                  bgcolor: 'var(--bg-tertiary)',
                                  overflow: 'hidden',
                                  borderTopRightRadius: '999px',
                                  borderBottomRightRadius: '999px',
                                }}
                              >
                                <Tooltip title="复制基础地址">
                                  <IconButton
                                    edge="end"
                                    aria-label="复制基础地址"
                                    onClick={() => copyText(baseUrl, '基础地址已复制')}
                                    sx={inlineIconButtonSx}
                                  >
                                    <Copy size={16} />
                                  </IconButton>
                                </Tooltip>
                              </Box>
                            </InputAdornment>
                          ),
                        }}
                      />

                      <TextField
                        label="令牌预览"
                        value={status.tokenConfigured ? status.tokenPreview : '未配置'}
                        fullWidth
                        size="small"
                        sx={textFieldSx}
                        InputProps={{
                          readOnly: true,
                          endAdornment: status.tokenConfigured && httpApiToken
                            ? (
                              <InputAdornment position="end">
                                <Box
                                  sx={{
                                    alignSelf: 'stretch',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    flexShrink: 0,
                                    width: 48,
                                    height: '100%',
                                    ml: 1,
                                    borderLeft: '1px solid var(--border-color)',
                                    bgcolor: 'var(--bg-tertiary)',
                                    overflow: 'hidden',
                                    borderTopRightRadius: '999px',
                                    borderBottomRightRadius: '999px',
                                  }}
                                >
                                  <Tooltip title="复制访问密钥">
                                    <IconButton
                                      edge="end"
                                      aria-label="复制访问密钥"
                                      onClick={() => copyText(httpApiToken, '访问密钥已复制')}
                                      sx={inlineIconButtonSx}
                                    >
                                      <Copy size={16} />
                                    </IconButton>
                                  </Tooltip>
                                </Box>
                              </InputAdornment>
                            )
                            : undefined,
                        }}
                      />
                    </Box>

                    <Box
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', xl: 'repeat(5, minmax(0, 1fr))' },
                        gap: 2,
                      }}
                    >
                      <StatusMetricCard
                        label="运行状态"
                        value={<Chip label={status.running ? '运行中' : '未运行'} variant="outlined" size="small" sx={getChipSx(status.running ? 'primary' : 'danger')} />}
                      />
                      <StatusMetricCard
                        label="配置开关"
                        value={<Chip label={status.enabled ? '已启用' : '已关闭'} variant="outlined" size="small" sx={getChipSx(status.enabled ? 'primary' : 'neutral')} />}
                      />
                      <StatusMetricCard
                        label="监听地址"
                        value={<Typography variant="body2" sx={{ ...monoSx, fontWeight: 700, color: 'var(--text-primary)' }}>{status.host}:{status.port}</Typography>}
                      />
                      <StatusMetricCard label="运行时长" value={uptimeText} />
                      <StatusMetricCard
                        label="鉴权状态"
                        value={<Chip label={status.tokenConfigured ? '已启用' : '未启用'} variant="outlined" size="small" sx={getChipSx(status.tokenConfigured ? 'primary' : 'neutral')} />}
                      />
                    </Box>

                    {status.lastError && (
                      <Alert severity="error" variant="outlined" sx={getAlertSx('danger')}>
                        最近错误：{status.lastError}
                      </Alert>
                    )}
                  </Stack>
                ) : (
                  <Alert severity="info" variant="outlined" sx={getAlertSx('neutral')}>
                    尚未读取到接口状态，请点击“刷新状态”。
                  </Alert>
                )}
              </CardContent>
            </Card>

            {status && (
              <Card variant="outlined" sx={cardSx}>
                <CardHeader
                  sx={sectionHeaderSx}
                  title="可用端点"
                  subheader="正式接口统一走 /v1，下面可直接复制完整 URL。"
                  titleTypographyProps={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}
                  subheaderTypographyProps={{ color: 'var(--text-secondary)' }}
                />
                <CardContent sx={sectionContentSx}>
                  <Stack spacing={0}>
                    {status.endpoints.map((endpoint) => {
                      const endpointUrl = getEndpointUrl(baseUrl, endpoint.path)

                      return (
                        <Box
                          key={`${endpoint.method}-${endpoint.path}`}
                          sx={{
                            py: 2.25,
                            borderBottom: '1px solid var(--border-color)',
                            '&:last-of-type': { borderBottom: 'none', pb: 0 },
                            '&:first-of-type': { pt: 0 },
                          }}
                        >
                          <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
                            <Box sx={{ minWidth: 0, flex: 1 }}>
                              <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap flexWrap="wrap" sx={{ mb: 1.25 }}>
                                <Chip label={endpoint.method} variant="outlined" size="small" sx={getChipSx('primary')} />
                                <Typography variant="body2" sx={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                                  {endpoint.desc}
                                </Typography>
                                <Box component="code" sx={endpointPathSx}>
                                  {endpoint.path}
                                </Box>
                              </Stack>
                              <Typography
                                variant="caption"
                                sx={{
                                  ...monoSx,
                                  display: 'block',
                                  color: 'var(--text-secondary)',
                                  wordBreak: 'break-all',
                                }}
                              >
                                {endpointUrl}
                              </Typography>
                            </Box>

                            <Button
                              variant="outlined"
                              size="small"
                              startIcon={<Copy size={14} />}
                              onClick={() => copyText(endpointUrl, `${endpoint.path} 已复制`)}
                              sx={{ ...tertiaryButtonSx, flexShrink: 0 }}
                            >
                              复制
                            </Button>
                          </Stack>
                        </Box>
                      )
                    })}
                  </Stack>
                </CardContent>
              </Card>
            )}
          </Stack>
        </Container>
      </Box>

      <Snackbar
        open={Boolean(message)}
        autoHideDuration={3000}
        onClose={() => setMessage(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert
          onClose={() => setMessage(null)}
          severity={message?.success ? 'success' : 'error'}
          variant="filled"
          sx={{
            width: '100%',
            borderRadius: '999px',
            color: '#fff',
            background: message?.success
              ? 'var(--primary-gradient)'
              : 'var(--danger)',
            boxShadow: message?.success
              ? '0 12px 32px var(--primary-light)'
              : '0 12px 32px rgba(220, 53, 69, 0.2)',
          }}
        >
          {message?.text}
        </Alert>
      </Snackbar>
    </>
  )
}

export default OpenApiPage
