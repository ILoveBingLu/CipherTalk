import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Container,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material'
import { Check, Copy, Save } from 'lucide-react'
import * as configService from '../services/config'

type ToastState = {
  text: string
  success: boolean
}

type McpLaunchConfig = {
  command: string
  args: string[]
  cwd: string
  mode: 'dev' | 'packaged'
}

function formatCommandPart(value: string) {
  if (!value) return value
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

function getPackagedLauncherLabel(command: string) {
  return command.endsWith('ciphertalk-mcp') ? '`ciphertalk-mcp`' : '`ciphertalk-mcp.cmd`'
}

const textFieldSx = {
  '& .MuiInputLabel-root': {
    color: 'var(--text-secondary)',
  },
  '& .MuiInputLabel-root.Mui-focused': {
    color: 'var(--primary)',
  },
  '& .MuiOutlinedInput-root': {
    borderRadius: '14px',
    color: 'var(--text-primary)',
    backgroundColor: 'var(--bg-secondary)',
    '& fieldset': {
      borderColor: 'var(--border-color)',
    },
    '&:hover fieldset': {
      borderColor: 'var(--primary)',
    },
    '&.Mui-focused fieldset': {
      borderColor: 'var(--primary)',
    },
  },
  '& .MuiInputBase-input': {
    color: 'var(--text-primary)',
  },
}

const switchSx = {
  '& .MuiSwitch-switchBase.Mui-checked': {
    color: 'var(--primary)',
  },
  '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': {
    backgroundColor: 'var(--primary)',
  },
  '& .MuiSwitch-track': {
    backgroundColor: 'var(--text-tertiary)',
  },
}

const secondaryButtonSx = {
  borderRadius: '999px',
  minWidth: 120,
  textTransform: 'none',
  fontWeight: 600,
  color: 'var(--text-primary)',
  borderColor: 'var(--border-color)',
  backgroundColor: 'var(--bg-secondary)',
  '&:hover': {
    borderColor: 'var(--primary)',
    backgroundColor: 'var(--primary-light)',
  },
}

function McpPage() {
  const [mcpEnabled, setMcpEnabled] = useState(false)
  const [mcpExposeMediaPaths, setMcpExposeMediaPaths] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [launchConfig, setLaunchConfig] = useState<McpLaunchConfig>({
    command: 'npm',
    args: ['run', 'mcp'],
    cwd: 'D:/CipherTalk',
    mode: 'dev',
  })

  useEffect(() => {
    const load = async () => {
      try {
        const [enabled, exposeMediaPaths] = await Promise.all([
          configService.getMcpEnabled(),
          configService.getMcpExposeMediaPaths(),
        ])
        setMcpEnabled(enabled)
        setMcpExposeMediaPaths(exposeMediaPaths)

        try {
          const mcpLaunchConfig = await window.electronAPI.app.getMcpLaunchConfig()
          if (mcpLaunchConfig?.command && Array.isArray(mcpLaunchConfig.args) && mcpLaunchConfig.cwd) {
            setLaunchConfig(mcpLaunchConfig)
          }
        } catch (innerError) {
          const message = String(innerError || '')
          if (!message.includes("No handler registered for 'app:getMcpLaunchConfig'")) {
            console.error('获取 MCP 启动配置失败:', innerError)
          }
        }
      } catch (e) {
        console.error('加载 MCP 配置失败:', e)
        setToast({ text: '加载 MCP 配置失败', success: false })
      } finally {
        setLoading(false)
      }
    }
    void load()
  }, [])

  const mcpRunCommand = useMemo(() => {
    const parts = [launchConfig.command, ...launchConfig.args].map(formatCommandPart)
    return parts.join(' ')
  }, [launchConfig])

  const mcpServerJsonTemplate = useMemo(() => JSON.stringify({
    mcpServers: {
      ciphertalk: {
        command: launchConfig.command,
        args: launchConfig.args,
        cwd: launchConfig.cwd
      }
    }
  }, null, 2), [launchConfig])

  const handleSave = async () => {
    setSaving(true)
    try {
      await Promise.all([
        configService.setMcpEnabled(mcpEnabled),
        configService.setMcpExposeMediaPaths(mcpExposeMediaPaths),
      ])
      setToast({ text: 'MCP 配置已保存', success: true })
    } catch (e) {
      console.error('保存 MCP 配置失败:', e)
      setToast({ text: '保存 MCP 配置失败', success: false })
    } finally {
      setSaving(false)
    }
  }

  const copyText = async (text: string, successText: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setToast({ text: successText, success: true })
    } catch (e) {
      console.error('复制失败:', e)
      setToast({ text: '复制失败，请手动复制', success: false })
    }
  }

  return (
    <Box sx={{ height: '100%', mx: -3, mt: -3, overflowY: 'auto', pb: 3 }}>
      <Container maxWidth="lg" sx={{ px: { xs: 2, md: 4 }, py: { xs: 3, md: 4 } }}>
        <Stack spacing={2.2}>
        <Box sx={{ px: { xs: 0.5, md: 1 }, pt: 0.5 }}>
          <Typography variant="h4" sx={{ fontSize: 30, fontWeight: 700, color: 'var(--text-primary)' }}>
            MCP Server
          </Typography>
          <Typography sx={{ mt: 1, color: 'var(--text-secondary)' }}>
            使用标准 MCP `stdio` 工具接口为 Claude Desktop、Codex、Cherry Studio 等宿主提供本地聊天数据读取能力。
          </Typography>
        </Box>

        <Card
          sx={{
            borderRadius: '26px',
            border: '1px solid var(--border-color)',
            bgcolor: 'var(--bg-secondary)',
            boxShadow: 'none',
          }}
        >
          <CardHeader
            title="服务配置"
            titleTypographyProps={{ fontWeight: 700, fontSize: 18, color: 'var(--text-primary)' }}
            sx={{ px: { xs: 2, md: 3 }, pb: 0.8 }}
          />
          <CardContent sx={{ px: { xs: 2, md: 3 }, pt: 0.6 }}>
            <Stack spacing={2.4}>
              <Alert
                severity="info"
                variant="outlined"
                sx={{
                  borderRadius: '18px',
                  bgcolor: 'var(--bg-primary)',
                  borderColor: 'var(--border-color)',
                  color: 'var(--text-primary)',
                  '& .MuiAlert-message': {
                    color: 'var(--text-primary)',
                  },
                }}
              >
                `mcpEnabled` 现在只作为状态标记和 warning 来源，不阻止宿主拉起 MCP。
                {launchConfig.mode === 'packaged'
                  ? ` 当前展示的是打包版伴随启动器 ${getPackagedLauncherLabel(launchConfig.command)}。`
                  : ' 当前展示的是开发态入口 `npm run mcp`。'}
              </Alert>

              <Box
                sx={{
                  p: 2,
                  borderRadius: '18px',
                  border: '1px solid var(--border-color)',
                  bgcolor: 'var(--bg-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 2,
                }}
              >
                <Box>
                  <Typography sx={{ fontWeight: 600, color: 'var(--text-primary)' }}>MCP 状态标记</Typography>
                  <Typography sx={{ mt: 0.5, fontSize: 13, color: 'var(--text-secondary)' }}>
                    仅用于在 `health_check` / `get_status` 中暴露当前配置状态，不会阻止宿主调用工具。
                  </Typography>
                </Box>
                <Switch
                  checked={mcpEnabled}
                  onChange={(e) => setMcpEnabled(e.target.checked)}
                  disabled={loading || saving}
                  sx={switchSx}
                />
              </Box>

              <Box
                sx={{
                  p: 2,
                  borderRadius: '18px',
                  border: '1px solid var(--border-color)',
                  bgcolor: 'var(--bg-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 2,
                }}
              >
                <Box>
                  <Typography sx={{ fontWeight: 600, color: 'var(--text-primary)' }}>默认解析媒体本地路径</Typography>
                  <Typography sx={{ mt: 0.5, fontSize: 13, color: 'var(--text-secondary)' }}>
                    控制 `get_messages`、`search_messages`、`get_session_context` 默认是否解析并返回图片、视频、语音、文件等本地路径。
                  </Typography>
                </Box>
                <Switch
                  checked={mcpExposeMediaPaths}
                  onChange={(e) => setMcpExposeMediaPaths(e.target.checked)}
                  disabled={loading || saving}
                  sx={switchSx}
                />
              </Box>

              <Box>
                <Typography sx={{ mb: 1, fontWeight: 600, color: 'var(--text-primary)' }}>启动命令</Typography>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.2}>
                  <TextField
                    fullWidth
                    value={mcpRunCommand}
                    InputProps={{ readOnly: true }}
                    sx={textFieldSx}
                  />
                  <Button
                    variant="outlined"
                    startIcon={<Copy size={16} />}
                    onClick={() => copyText(mcpRunCommand, 'MCP 启动命令已复制')}
                    sx={secondaryButtonSx}
                  >
                    复制
                  </Button>
                </Stack>
              </Box>

              <Box>
                <Typography sx={{ mb: 1, fontWeight: 600, color: 'var(--text-primary)' }}>
                  标准 mcpServers 配置（可直接粘贴）
                </Typography>
                <TextField
                  fullWidth
                  multiline
                  minRows={9}
                  value={mcpServerJsonTemplate}
                  InputProps={{ readOnly: true }}
                  sx={{
                    ...textFieldSx,
                    '& .MuiOutlinedInput-root': {
                      borderRadius: '14px',
                      color: 'var(--text-primary)',
                      backgroundColor: 'var(--bg-secondary)',
                      fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)',
                    },
                  }}
                />
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.2} sx={{ mt: 1.2 }}>
                  <Button
                    variant="outlined"
                    startIcon={<Copy size={16} />}
                    onClick={() => copyText(mcpServerJsonTemplate, 'mcpServers 配置已复制')}
                    sx={secondaryButtonSx}
                  >
                    复制配置
                  </Button>
                  <Typography sx={{ alignSelf: 'center', fontSize: 13, color: 'var(--text-secondary)' }}>
                    {launchConfig.mode === 'packaged'
                      ? '打包态请直接把 `command` 指向启动器本身；macOS 不要把 `CipherTalk.app` 本体当作 command。'
                      : '`cwd` 已自动使用当前仓库目录，通常无需修改。'}
                  </Typography>
                </Stack>
              </Box>

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.2} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }}>
                <Typography sx={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  v2 工具：`health_check`、`get_status`、`list_sessions`、`get_messages`、`list_contacts`、`search_messages`、`get_session_context`、`get_global_statistics`、`get_contact_rankings`、`get_activity_distribution`
                </Typography>
                <Button
                  variant="contained"
                  onClick={handleSave}
                  disabled={loading || saving}
                  sx={{
                    minWidth: 42,
                    width: 42,
                    height: 42,
                    borderRadius: '999px',
                    p: 0,
                    textTransform: 'none',
                    fontWeight: 700,
                    background: 'var(--primary-gradient)',
                    '&:hover': {
                      background: 'var(--primary-gradient)',
                      filter: 'brightness(0.98)',
                    },
                  }}
                  title={saving ? '保存中...' : '保存配置'}
                  aria-label={saving ? '保存中' : '保存配置'}
                >
                  <Save size={16} />
                </Button>
              </Stack>

            </Stack>
          </CardContent>
        </Card>
        </Stack>
      </Container>

      <Snackbar
        open={!!toast}
        autoHideDuration={2400}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          icon={toast?.success ? <Check size={16} /> : undefined}
          severity={toast?.success ? 'success' : 'error'}
          variant="filled"
          onClose={() => setToast(null)}
          sx={{
            borderRadius: '12px',
            color: '#fff',
            bgcolor: toast?.success ? 'var(--primary)' : 'var(--danger)',
          }}
        >
          {toast?.text}
        </Alert>
      </Snackbar>
    </Box>
  )
}

export default McpPage
