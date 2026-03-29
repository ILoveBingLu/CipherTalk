const { spawn } = require('child_process')
const path = require('path')
const electronBinary = require('electron')

const rootDir = path.resolve(__dirname, '..')
const entry = path.join(rootDir, 'dist-electron', 'mcp.js')

const child = spawn(electronBinary, [entry], {
  cwd: rootDir,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1'
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
})

if (process.stdin) {
  process.stdin.pipe(child.stdin)
}

if (child.stdout) {
  child.stdout.pipe(process.stdout)
}

if (child.stderr) {
  child.stderr.pipe(process.stderr)
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})

child.on('error', (error) => {
  process.stderr.write(`[CipherTalk MCP Runner] failed: ${String(error)}\n`)
  process.exit(1)
})
