import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  CircularProgress,
  Collapse,
  Container,
  IconButton,
  InputAdornment,
  Snackbar,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material'
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  FileText,
  Globe,
  Link2,
  Network,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import * as configService from '../services/config'
import { useTitleBarStore } from '../stores/titleBarStore'

const HTTP_API_DOC_URL = 'https://ciphertalk.apifox.cn/'

type ToastState = {
  text: string
  success: boolean
}

type HttpApiListenMode = 'localhost' | 'lan'

type HttpApiStatus = {
  running: boolean
  host: string
  listenMode: HttpApiListenMode
  port: number
  enabled: boolean
  startedAt: string
  uptimeMs: number
  tokenConfigured: boolean
  tokenPreview: string
  baseUrl: string
  chatlabBaseUrl: string
  lanAddresses: string[]
  endpoints: Array<{ method: string; path: string; desc: string }>
  lastError: string
}

type MetricCardProps = {
  label: string
  value: ReactNode
  helper?: string
}

const LARGE_RADIUS = '28px'
const MEDIUM_RADIUS = '24px'

const monoSx = {
  fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)',
}

const cardSx = {
  borderRadius: LARGE_RADIUS,
  border: 'none',
  bgcolor: 'transparent',
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

const panelSx = {
  p: 2.25,
  borderRadius: MEDIUM_RADIUS,
  border: '1px solid var(--border-color)',
  bgcolor: 'var(--bg-secondary)',
  boxShadow: '0 8px 24px rgba(15, 23, 42, 0.04)',
}

const subtlePanelSx = {
  borderRadius: '20px',
  border: '1px solid var(--border-color)',
  bgcolor: 'var(--bg-tertiary)',
}

const codeStripSx = {
  ...monoSx,
  display: 'block',
  width: '100%',
  px: 1.5,
  py: 1.2,
  fontSize: 13,
  lineHeight: 1.8,
  color: 'var(--text-primary)',
  bgcolor: 'rgba(255, 255, 255, 0.42)',
  border: '1px solid var(--border-color)',
  borderRadius: '16px',
  wordBreak: 'break-all',
}

const endpointPanelSx = {
  position: 'relative',
  overflow: 'hidden',
  borderRadius: '22px',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  background: 'linear-gradient(135deg, rgba(25, 29, 34, 0.98) 0%, rgba(42, 47, 53, 0.94) 100%)',
  boxShadow: '0 18px 42px rgba(15, 23, 42, 0.14)',
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

const endpointActionButtonSx = {
  ...tertiaryButtonSx,
  minHeight: 40,
  px: 2,
  color: '#fff',
  borderColor: 'rgba(255, 255, 255, 0.14)',
  backgroundColor: 'rgba(255, 255, 255, 0.06)',
  '&:hover': {
    color: '#fff',
    borderColor: 'rgba(255, 255, 255, 0.24)',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
  },
}

const textFieldSx = {
  '& .MuiInputLabel-root': {
    color: 'var(--text-secondary)',
  },
  '& .MuiInputLabel-root.Mui-focused': {
    color: 'var(--primary)',
  },
  '& .MuiOutlinedInput-root': {
    minHeight: 48,
    borderRadius: '24px',
    color: 'var(--text-primary)',
    backgroundColor: 'var(--bg-secondary)',
    overflow: 'hidden',
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
    paddingTop: '12px',
    paddingBottom: '12px',
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

const inlineIconButtonSx = {
  color: 'var(--text-secondary)',
  bgcolor: 'transparent',
  borderRadius: '999px',
  '&:hover': {
    color: 'var(--text-primary)',
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
  if (!durationMs || durationMs <= 0) return '0 秒'

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

function MetricCard({ label, value, helper }: MetricCardProps) {
  return (
    <Box sx={panelSx}>
      <Stack gap={0.8}>
        <Typography variant="caption" sx={{ color: 'var(--text-tertiary)' }}>
          {label}
        </Typography>
        {typeof value === 'string'
          ? (
            <Typography variant="body2" sx={{ fontWeight: 700, color: 'var(--text-primary)' }}>
              {value}
            </Typography>
          )
          : value}
        {helper && (
          <Typography variant="caption" sx={{ color: 'var(--text-tertiary)' }}>
            {helper}
          </Typography>
        )}
      </Stack>
    </Box>
  )
}

function OpenApiPage() {
  const [message, setMessage] = useState<ToastState | null>(null)
  const [httpApiEnabled, setHttpApiEnabled] = useState(false)
  const [httpApiPort, setHttpApiPort] = useState(5031)
  const [httpApiToken, setHttpApiToken] = useState('')
  const [httpApiListenMode, setHttpApiListenMode] = useState<HttpApiListenMode>('localhost')
  const [showHttpApiToken, setShowHttpApiToken] = useState(false)
  const [httpApiStatus, setHttpApiStatus] = useState<HttpApiStatus | null>(null)
  const [isSavingHttpApi, setIsSavingHttpApi] = useState(false)
  const [isRefreshingHttpApi, setIsRefreshingHttpApi] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [nowTs, setNowTs] = useState(Date.now())

  const setTitleBarContent = useTitleBarStore((state) => state.setRightContent)

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

  const applyStatusToForm = (status: HttpApiStatus) => {
    setHttpApiEnabled(status.enabled)
    setHttpApiPort(status.port)
    setHttpApiListenMode(status.listenMode)
  }

  useEffect(() => {
    const load = async () => {
      try {
        const [enabled, port, token, listenMode, statusResult] = await Promise.all([
          configService.getHttpApiEnabled(),
          configService.getHttpApiPort(),
          configService.getHttpApiToken(),
          configService.getHttpApiListenMode(),
          window.electronAPI.httpApi.getStatus(),
        ])

        setHttpApiEnabled(enabled)
        setHttpApiPort(port)
        setHttpApiToken(token)
        setHttpApiListenMode(listenMode)

        if (statusResult.success && statusResult.status) {
          setHttpApiStatus(statusResult.status)
          applyStatusToForm(statusResult.status)
        }
      } catch (error) {
        showMessage(`加载开放接口配置失败: ${error}`, false)
      }
    }

    load()
  }, [])

  useEffect(() => {
    if (!httpApiStatus?.running) return

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
        applyStatusToForm(result.status)
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
  const isLanWithoutToken = httpApiListenMode === 'lan' && !httpApiToken.trim()

  const handleSaveHttpApiSettings = async () => {
    if (isPortInvalid) {
      showMessage('监听端口需在 1 到 65535 之间', false)
      return
    }

    if (isLanWithoutToken) {
      showMessage('局域网模式必须先配置访问密钥', false)
      return
    }

    setIsSavingHttpApi(true)

    try {
      const result = await window.electronAPI.httpApi.applySettings({
        enabled: httpApiEnabled,
        port: httpApiPort,
        token: httpApiToken,
        listenMode: httpApiListenMode,
      })

      if (result.success && result.status) {
        setHttpApiStatus(result.status)
        applyStatusToForm(result.status)
        await Promise.all([
          configService.setHttpApiEnabled(httpApiEnabled),
          configService.setHttpApiPort(result.status.port),
          configService.setHttpApiToken(httpApiToken),
          configService.setHttpApiListenMode(httpApiListenMode),
        ])
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
        applyStatusToForm(result.status)
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

  const fallbackHost = httpApiListenMode === 'lan' && status?.lanAddresses?.[0]
    ? status.lanAddresses[0]
    : '127.0.0.1'
  const baseUrl = status?.baseUrl || `http://${fallbackHost}:${isPortInvalid ? 5031 : httpApiPort}/v1`
  const chatlabBaseUrl = status?.chatlabBaseUrl || `http://${fallbackHost}:${isPortInvalid ? 5031 : httpApiPort}/chatlab`
  const advancedEndpoints = useMemo(
    () => (status?.endpoints || []).filter((endpoint) => endpoint.path.startsWith('/v1')),
    [status?.endpoints]
  )

  const listenModeLabel = httpApiListenMode === 'lan' ? '局域网监听' : '仅本机监听'
  const listenModeHint = httpApiListenMode === 'lan'
    ? '绑定 0.0.0.0，同网段设备可直接访问。'
    : '绑定 127.0.0.1，仅当前设备可访问。'

  return (
    <>
      <Box sx={{ height: '100%', mx: -3, mt: -3, overflowY: 'auto', pb: 3 }}>
        <Container maxWidth="lg" sx={{ px: { xs: 2, md: 4 }, py: { xs: 3, md: 4 } }}>
          <Stack spacing={3}>
            <Box>
              <Stack
                direction={{ xs: 'column', md: 'row' }}
                alignItems={{ xs: 'flex-start', md: 'center' }}
                justifyContent="space-between"
                gap={2}
              >
                <Box sx={{ maxWidth: 720 }}>
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
                    这里优先用于对接 ChatLab Pull 数据源。默认只保留必要的接入信息，原生
                    <Box component="span" sx={{ ...monoSx, mx: 0.75, px: 1, py: 0.25, borderRadius: '999px', bgcolor: 'var(--bg-tertiary)', border: '1px solid var(--border-color)' }}>
                      /v1
                    </Box>
                    端点收进下方高级接口。
                  </Typography>
                </Box>

                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                  <Chip label={listenModeLabel} variant="outlined" size="small" sx={getChipSx(httpApiListenMode === 'lan' ? 'primary' : 'neutral')} />
                  <Chip
                    label={httpApiToken.trim() ? 'Bearer 鉴权已配置' : 'Bearer 鉴权未配置'}
                    variant="outlined"
                    size="small"
                    sx={getChipSx(httpApiToken.trim() ? 'primary' : 'danger')}
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
                ? 'HTTP API 已启用配置。保存后会立即同步监听地址、端口和访问密钥。'
                : 'HTTP API 当前关闭。保存并应用后才会开始监听端口，对外提供接口。'}
            </Alert>

            <Card variant="outlined" sx={cardSx}>
              <CardHeader
                sx={sectionHeaderSx}
                title="数据源接入"
                subheader="把 HTTP API 和 ChatLab 数据源接入入口放在同一处，减少来回切换。"
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
                          关闭后会停止监听端口，ChatLab 和其他外部调用都不可用。
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

                  <Box sx={panelSx}>
                    <Stack spacing={1.5}>
                      <Typography variant="subtitle1" sx={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                        监听模式
                      </Typography>
                      <ToggleButtonGroup
                        exclusive
                        value={httpApiListenMode}
                        onChange={(_, value: HttpApiListenMode | null) => {
                          if (value) setHttpApiListenMode(value)
                        }}
                        sx={{
                          alignSelf: 'flex-start',
                          bgcolor: 'var(--bg-tertiary)',
                          borderRadius: '999px',
                          p: 0.5,
                          gap: 0.5,
                          '& .MuiToggleButton-root': {
                            border: 'none',
                            borderRadius: '999px',
                            px: 2,
                            py: 1,
                            textTransform: 'none',
                            color: 'var(--text-secondary)',
                            fontWeight: 600,
                            '&.Mui-selected': {
                              color: 'var(--primary)',
                              bgcolor: 'var(--bg-secondary)',
                              boxShadow: '0 6px 16px rgba(15, 23, 42, 0.06)',
                            },
                          },
                        }}
                      >
                        <ToggleButton value="localhost">仅本机</ToggleButton>
                        <ToggleButton value="lan">局域网</ToggleButton>
                      </ToggleButtonGroup>
                      <Typography variant="body2" sx={{ color: 'var(--text-secondary)' }}>
                        {listenModeHint}
                      </Typography>
                    </Stack>
                  </Box>

                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: { xs: '1fr', md: 'minmax(220px, 280px) 1fr' },
                      gap: 2,
                    }}
                  >
                    <TextField
                      label="监听端口"
                      type="number"
                      fullWidth
                      size="small"
                      sx={textFieldSx}
                      value={httpApiPort}
                      onChange={(event) => {
                        const nextPort = Number.parseInt(event.target.value, 10)
                        setHttpApiPort(Number.isNaN(nextPort) ? 0 : nextPort)
                      }}
                      error={isPortInvalid}
                      helperText={isPortInvalid ? '端口必须在 1 到 65535 之间' : '建议保持默认 5031'}
                      inputProps={{ min: 1, max: 65535, inputMode: 'numeric' }}
                      InputProps={{
                        endAdornment: (
                          <InputAdornment position="end">
                            <Box
                              sx={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignSelf: 'stretch',
                                justifyContent: 'stretch',
                                width: 48,
                                flexShrink: 0,
                                height: '100%',
                                ml: 1,
                                borderLeft: '1px solid var(--border-color)',
                                bgcolor: 'var(--bg-tertiary)',
                                overflow: 'hidden',
                                borderTopRightRadius: '24px',
                                borderBottomRightRadius: '24px',
                              }}
                            >
                              <IconButton
                                size="small"
                                aria-label="端口加 1"
                                onClick={() => setHttpApiPort((port) => Math.min(65535, (port && port > 0 ? port : 5031) + 1))}
                                disabled={httpApiPort >= 65535}
                                sx={{ width: '100%', flex: 1, borderRadius: 0 }}
                              >
                                <ChevronUp size={14} />
                              </IconButton>
                              <IconButton
                                size="small"
                                aria-label="端口减 1"
                                onClick={() => setHttpApiPort((port) => Math.max(1, (port && port > 0 ? port : 5031) - 1))}
                                disabled={httpApiPort <= 1}
                                sx={{ width: '100%', flex: 1, borderRadius: 0 }}
                              >
                                <ChevronDown size={14} />
                              </IconButton>
                            </Box>
                          </InputAdornment>
                        ),
                      }}
                    />

                    <TextField
                      label="访问密钥"
                      type={showHttpApiToken ? 'text' : 'password'}
                      fullWidth
                      size="small"
                      sx={textFieldSx}
                      value={httpApiToken}
                      onChange={(event) => setHttpApiToken(event.target.value)}
                      placeholder="局域网模式下必须填写"
                      error={isLanWithoutToken}
                      helperText={isLanWithoutToken ? '局域网模式必须先配置访问密钥' : '调用受保护接口时使用 Authorization: Bearer <token>'}
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
                                borderTopRightRadius: '24px',
                                borderBottomRightRadius: '24px',
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

                                {httpApiToken.trim() && (
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

                  {httpApiListenMode === 'lan' && (
                    <Alert
                      severity={httpApiToken.trim() ? 'warning' : 'error'}
                      variant="outlined"
                      sx={getAlertSx(httpApiToken.trim() ? 'neutral' : 'danger')}
                    >
                      同一网络中的设备都可以访问当前端口。为避免裸露接口，局域网模式下必须启用 Bearer Token。
                    </Alert>
                  )}

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
                title="ChatLab 数据源"
                subheader="把这组地址直接填进 ChatLab 的远程数据源配置。"
                titleTypographyProps={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}
                subheaderTypographyProps={{ color: 'var(--text-secondary)' }}
              />
              <CardContent sx={sectionContentSx}>
                <Stack spacing={2.5}>
                  <Box
                    sx={{
                      ...panelSx,
                      background: 'linear-gradient(180deg, rgba(15, 23, 42, 0.02) 0%, var(--bg-secondary) 22%, var(--bg-secondary) 100%)',
                      boxShadow: '0 12px 28px rgba(15, 23, 42, 0.05)',
                    }}
                  >
                    <Stack spacing={2}>
                      <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2} flexWrap="wrap">
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Box
                            sx={{
                              width: 42,
                              height: 42,
                              borderRadius: '14px',
                              display: 'grid',
                              placeItems: 'center',
                              color: 'var(--primary)',
                              bgcolor: 'var(--primary-light)',
                            }}
                          >
                            <Network size={18} />
                          </Box>
                          <Box>
                            <Typography variant="subtitle1" sx={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                              主要数据源地址
                            </Typography>
                            <Typography variant="body2" sx={{ color: 'var(--text-secondary)' }}>
                              {httpApiEnabled ? 'ChatLab 直接连接这里即可开始发现会话。' : '请先启用 HTTP API，地址才会真正可用。'}
                            </Typography>
                          </Box>
                        </Stack>

                        <Chip
                          label={httpApiEnabled ? '已可配置' : '等待启用'}
                          variant="outlined"
                          size="small"
                          sx={getChipSx(httpApiEnabled ? 'primary' : 'neutral')}
                        />
                      </Stack>

                      <Box sx={endpointPanelSx}>
                        <Box
                          sx={{
                            position: 'absolute',
                            inset: 0,
                            background: 'linear-gradient(120deg, rgba(255, 255, 255, 0.08) 0%, transparent 48%)',
                            pointerEvents: 'none',
                          }}
                        />
                        <Stack
                          direction={{ xs: 'column', md: 'row' }}
                          alignItems={{ xs: 'stretch', md: 'center' }}
                          sx={{ position: 'relative' }}
                        >
                          <Box sx={{ flex: 1, minWidth: 0, px: { xs: 2, md: 2.5 }, py: { xs: 2, md: 2.25 } }}>
                            <Stack direction="row" spacing={0.9} alignItems="center">
                              <Link2 size={14} color="rgba(255, 255, 255, 0.62)" />
                              <Typography
                                variant="caption"
                                sx={{
                                  color: 'rgba(255, 255, 255, 0.62)',
                                  textTransform: 'uppercase',
                                  letterSpacing: '0.08em',
                                  fontWeight: 700,
                                }}
                              >
                                ChatLab Base URL
                              </Typography>
                            </Stack>

                            <Typography
                              variant="body1"
                              sx={{
                                ...monoSx,
                                mt: 1.2,
                                fontSize: { xs: 14, sm: 15 },
                                lineHeight: 1.85,
                                color: '#fff',
                                wordBreak: 'break-all',
                              }}
                            >
                              {chatlabBaseUrl}
                            </Typography>
                          </Box>

                          <Box
                            sx={{
                              px: { xs: 2, md: 1.5 },
                              pb: { xs: 2, md: 0 },
                              pt: { xs: 0, md: 0 },
                              borderTop: { xs: '1px solid rgba(255, 255, 255, 0.08)', md: 'none' },
                              borderLeft: { xs: 'none', md: '1px solid rgba(255, 255, 255, 0.08)' },
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              minWidth: { md: 142 },
                            }}
                          >
                            <Button
                              variant="outlined"
                              startIcon={<Copy size={14} />}
                              onClick={() => copyText(chatlabBaseUrl, 'ChatLab 数据源地址已复制')}
                              sx={{ ...endpointActionButtonSx, width: { xs: '100%', md: 'auto' } }}
                            >
                              复制地址
                            </Button>
                          </Box>
                        </Stack>
                      </Box>

                      <Box
                        sx={{
                          display: 'grid',
                          gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
                          gap: 1.25,
                        }}
                      >
                        <Box sx={{ ...subtlePanelSx, p: 1.5 }}>
                          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.75 }}>
                            {httpApiListenMode === 'lan'
                              ? <ShieldAlert size={16} color="var(--primary)" />
                              : <ShieldCheck size={16} color="var(--primary)" />}
                            <Typography variant="body2" sx={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                              {httpApiListenMode === 'lan' ? '局域网监听' : '仅本机监听'}
                            </Typography>
                          </Stack>
                          <Typography variant="caption" sx={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                            {httpApiListenMode === 'lan'
                              ? '同网段设备都能访问这组地址，适合给 ChatLab 远程拉取。'
                              : '只允许当前设备访问，适合本机调试和单端同步。'}
                          </Typography>
                        </Box>

                        <Box sx={{ ...subtlePanelSx, p: 1.5 }}>
                          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.75 }}>
                            {httpApiToken.trim()
                              ? <ShieldCheck size={16} color="var(--primary)" />
                              : <ShieldAlert size={16} color="var(--danger)" />}
                            <Typography variant="body2" sx={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                              {httpApiToken.trim() ? 'Bearer Token 已配置' : 'Bearer Token 未配置'}
                            </Typography>
                          </Stack>
                          <Typography
                            variant="caption"
                            sx={{
                              color: httpApiListenMode === 'lan' && !httpApiToken.trim() ? 'var(--danger)' : 'var(--text-secondary)',
                              lineHeight: 1.7,
                            }}
                          >
                            {httpApiListenMode === 'lan' && !httpApiToken.trim()
                              ? '局域网模式下必须先填写 Token，当前设置不能直接保存。'
                              : httpApiToken.trim()
                                ? 'ChatLab 拉取请求会按当前设置校验 Bearer Token。'
                                : '本机模式可不填，只有需要鉴权时再配置即可。'}
                          </Typography>
                        </Box>
                      </Box>
                    </Stack>
                  </Box>

                  {httpApiListenMode === 'lan' && (
                    <Box sx={panelSx}>
                      <Stack spacing={1.5}>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Globe size={16} />
                          <Typography variant="subtitle1" sx={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                            局域网可访问地址
                          </Typography>
                        </Stack>

                        {status?.lanAddresses?.length
                          ? status.lanAddresses.map((address) => {
                            const url = `http://${address}:${status.port}/chatlab`
                            return (
                              <Stack
                                key={address}
                                direction={{ xs: 'column', sm: 'row' }}
                                alignItems={{ xs: 'stretch', sm: 'center' }}
                                justifyContent="space-between"
                                gap={1.5}
                                sx={{
                                  ...subtlePanelSx,
                                  p: 1.5,
                                  borderRadius: '18px',
                                  border: '1px solid var(--border-color)',
                                }}
                              >
                                <Typography variant="body2" sx={{ ...monoSx, color: 'var(--text-primary)', wordBreak: 'break-all' }}>
                                  {url}
                                </Typography>
                                <Button
                                  variant="outlined"
                                  size="small"
                                  startIcon={<Copy size={14} />}
                                  onClick={() => copyText(url, `${address} 地址已复制`)}
                                  sx={{ ...tertiaryButtonSx, flexShrink: 0 }}
                                >
                                  复制
                                </Button>
                              </Stack>
                            )
                          })
                          : (
                            <Alert severity="warning" variant="outlined" sx={getAlertSx('neutral')}>
                              已切到局域网模式，但当前没有检测到可用的 IPv4 地址。你仍可手动确认本机地址后拼接端口使用。
                            </Alert>
                          )}
                      </Stack>
                    </Box>
                  )}

                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: { xs: '1fr', md: '1.2fr 0.8fr' },
                      gap: 2,
                    }}
                  >
                    <Box sx={panelSx}>
                      <Typography variant="subtitle1" sx={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                        接入方式
                      </Typography>
                      <Stack spacing={1.1} sx={{ mt: 1.5 }}>
                        <Typography variant="body2" sx={{ color: 'var(--text-secondary)' }}>
                          1. 在 ChatLab 中新增远程数据源。
                        </Typography>
                        <Typography variant="body2" sx={{ color: 'var(--text-secondary)' }}>
                          2. 粘贴上方
                          <Box component="span" sx={{ ...monoSx, mx: 0.75 }}>/chatlab</Box>
                          地址；如果配置了访问密钥，同时填入 Bearer Token。
                        </Typography>
                        <Typography variant="body2" sx={{ color: 'var(--text-secondary)' }}>
                          3. ChatLab 会自动发现会话，并按需继续拉取消息。
                        </Typography>
                      </Stack>
                    </Box>

                    <Box sx={panelSx}>
                      <Typography variant="subtitle1" sx={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                        兼容端点
                      </Typography>
                      <Stack spacing={1.1} sx={{ mt: 1.5 }}>
                        <Typography variant="body2" sx={{ color: 'var(--text-secondary)' }}>
                          <Box component="span" sx={{ ...monoSx, mr: 0.75 }}>GET /chatlab/sessions</Box>
                          会话发现
                        </Typography>
                        <Typography variant="body2" sx={{ color: 'var(--text-secondary)' }}>
                          <Box component="span" sx={{ ...monoSx, mr: 0.75 }}>GET /chatlab/sessions/:id/messages</Box>
                          消息拉取
                        </Typography>
                        <Typography variant="caption" sx={{ color: 'var(--text-tertiary)', lineHeight: 1.7 }}>
                          兼容 ChatLab 自动补全的版本前缀，例如
                          <Box component="span" sx={{ ...monoSx, mx: 0.5 }}>/chatlab/api/v1/sessions</Box>
                          。
                        </Typography>
                      </Stack>
                    </Box>
                  </Box>
                </Stack>
              </CardContent>
            </Card>

            <Card variant="outlined" sx={cardSx}>
              <CardHeader
                sx={sectionHeaderSx}
                title="服务状态"
                subheader="只保留当前接入最常用的状态信息。"
                titleTypographyProps={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}
                subheaderTypographyProps={{ color: 'var(--text-secondary)' }}
              />
              <CardContent sx={sectionContentSx}>
                {status
                  ? (
                    <Stack spacing={2}>
                      <Box
                        sx={{
                          display: 'grid',
                          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', xl: 'repeat(5, minmax(0, 1fr))' },
                          gap: 1.5,
                        }}
                      >
                        <MetricCard
                          label="运行状态"
                          value={<Chip label={status.running ? '运行中' : '未运行'} variant="outlined" size="small" sx={getChipSx(status.running ? 'primary' : 'danger')} />}
                        />
                        <MetricCard
                          label="监听模式"
                          value={<Chip label={status.listenMode === 'lan' ? '局域网' : '仅本机'} variant="outlined" size="small" sx={getChipSx(status.listenMode === 'lan' ? 'primary' : 'neutral')} />}
                        />
                        <MetricCard
                          label="绑定地址"
                          value={<Typography variant="body2" sx={{ ...monoSx, fontWeight: 700, color: 'var(--text-primary)' }}>{status.host}:{status.port}</Typography>}
                        />
                        <MetricCard label="运行时长" value={uptimeText} />
                        <MetricCard
                          label="鉴权状态"
                          value={<Chip label={status.tokenConfigured ? '已启用' : '未启用'} variant="outlined" size="small" sx={getChipSx(status.tokenConfigured ? 'primary' : 'danger')} />}
                        />
                      </Box>

                      {status.lastError && (
                        <Alert severity="error" variant="outlined" sx={getAlertSx('danger')}>
                          最近错误：{status.lastError}
                        </Alert>
                      )}
                    </Stack>
                  )
                  : (
                    <Alert severity="info" variant="outlined" sx={getAlertSx('neutral')}>
                      尚未读取到接口状态，请点击“刷新状态”。
                    </Alert>
                  )}
              </CardContent>
            </Card>

            <Card variant="outlined" sx={cardSx}>
              <CardHeader
                sx={sectionHeaderSx}
                title="高级接口"
                subheader="原生 /v1 端点保留在这里，默认折叠，避免干扰 ChatLab 接入主流程。"
                titleTypographyProps={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}
                subheaderTypographyProps={{ color: 'var(--text-secondary)' }}
                action={(
                  <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap" sx={{ mt: 1, mr: 1, justifyContent: 'flex-end' }}>
                    <Chip label={`${advancedEndpoints.length} 个端点`} variant="outlined" size="small" sx={getChipSx('neutral')} />
                    <Button
                      variant="outlined"
                      size="small"
                      startIcon={advancedOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      onClick={() => setAdvancedOpen((value) => !value)}
                      sx={tertiaryButtonSx}
                    >
                      {advancedOpen ? '收起' : '展开'}
                    </Button>
                  </Stack>
                )}
              />
              <CardContent sx={sectionContentSx}>
                <Collapse in={advancedOpen}>
                  <Stack spacing={2}>
                    <Box
                      sx={{
                        ...panelSx,
                        background: 'linear-gradient(180deg, rgba(15, 23, 42, 0.015) 0%, var(--bg-secondary) 28%, var(--bg-secondary) 100%)',
                      }}
                    >
                      <Stack spacing={1.75}>
                        <Stack
                          direction={{ xs: 'column', lg: 'row' }}
                          alignItems={{ xs: 'flex-start', lg: 'center' }}
                          justifyContent="space-between"
                          gap={1.5}
                        >
                          <Box sx={{ minWidth: 0, flex: 1 }}>
                            <Typography variant="subtitle1" sx={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                              原生 API Base URL
                            </Typography>
                            <Typography variant="body2" sx={{ mt: 0.5, color: 'var(--text-secondary)' }}>
                              只在自定义集成或调试原生接口时使用，常规 ChatLab 接入不需要关注这里。
                            </Typography>
                          </Box>

                          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'center' }}>
                            <Button
                              variant="outlined"
                              size="small"
                              startIcon={<Copy size={14} />}
                              onClick={() => copyText(baseUrl, '原生 API 地址已复制')}
                              sx={{ ...tertiaryButtonSx, width: { xs: '100%', sm: 'auto' } }}
                            >
                              复制 Base URL
                            </Button>
                          </Stack>
                        </Stack>

                        <Box sx={codeStripSx}>
                          {baseUrl}
                        </Box>
                      </Stack>
                    </Box>

                    <Box
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: { xs: '1fr', xl: 'repeat(2, minmax(0, 1fr))' },
                        gap: 1.5,
                      }}
                    >
                      {advancedEndpoints.map((endpoint) => {
                        const endpointUrl = getEndpointUrl(baseUrl, endpoint.path)

                        return (
                          <Box
                            key={`${endpoint.method}-${endpoint.path}`}
                            sx={{
                              ...subtlePanelSx,
                              p: 1.5,
                            }}
                          >
                            <Stack spacing={1.25}>
                              <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
                                <Chip label={endpoint.method} variant="outlined" size="small" sx={getChipSx('primary')} />
                                <Typography variant="body2" sx={{ color: 'var(--text-primary)', fontWeight: 700 }}>
                                  {endpoint.desc}
                                </Typography>
                              </Stack>

                              <Box
                                component="code"
                                sx={{
                                  ...monoSx,
                                  display: 'inline-flex',
                                  alignSelf: 'flex-start',
                                  px: 1.15,
                                  py: 0.45,
                                  fontSize: 12,
                                  borderRadius: '999px',
                                  color: 'var(--text-secondary)',
                                  bgcolor: 'rgba(255, 255, 255, 0.5)',
                                  border: '1px solid var(--border-color)',
                                }}
                              >
                                {endpoint.path}
                              </Box>

                              <Box sx={codeStripSx}>
                                <Typography
                                  component="span"
                                  variant="caption"
                                  sx={{
                                    ...monoSx,
                                    fontSize: 12,
                                    color: 'var(--text-secondary)',
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
                                sx={{ ...tertiaryButtonSx, width: { xs: '100%', sm: 'auto' }, alignSelf: 'flex-start' }}
                              >
                                复制端点地址
                              </Button>
                            </Stack>
                          </Box>
                        )
                      })}

                      {!advancedEndpoints.length && (
                        <Alert severity="info" variant="outlined" sx={{ ...getAlertSx('neutral'), gridColumn: '1 / -1' }}>
                          当前还没有可展示的原生 /v1 端点信息，请先刷新状态。
                        </Alert>
                      )}
                    </Box>
                  </Stack>
                </Collapse>
              </CardContent>
            </Card>
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
            background: message?.success ? 'var(--primary-gradient)' : 'var(--danger)',
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
