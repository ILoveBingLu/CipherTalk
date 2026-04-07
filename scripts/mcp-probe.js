const path = require('path')

async function main() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')

  const mode = process.argv[2] || 'dev'
  const cwd = process.cwd()
  let command
  let args
  let transportCwd = cwd

  if (mode === 'packaged') {
    const launcherPath = process.argv[3] || (
      process.platform === 'darwin'
        ? path.join(cwd, 'CipherTalk.app', 'Contents', 'MacOS', 'ciphertalk-mcp')
        : path.join(cwd, 'ciphertalk-mcp.cmd')
    )
    command = launcherPath
    args = []
    transportCwd = path.dirname(launcherPath)
  } else {
    command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    args = ['run', 'mcp']
  }

  const transport = new StdioClientTransport({
    command,
    args,
    cwd: transportCwd,
    stderr: 'pipe'
  })

  const client = new Client({
    name: 'ciphertalk-mcp-probe',
    version: '1.0.0'
  })

  try {
    await client.connect(transport)
    const tools = await client.listTools()
    const health = await client.callTool({ name: 'health_check', arguments: {} })

    console.log(JSON.stringify({
      mode,
      tools: (tools.tools || []).map((tool) => tool.name),
      health
    }, null, 2))
  } finally {
    await client.close()
  }
}

main().catch((error) => {
  console.error('[CipherTalk MCP Probe] failed:', error)
  process.exit(1)
})
