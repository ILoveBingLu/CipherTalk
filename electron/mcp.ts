import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createCipherTalkMcpServer } from './services/mcp/server'

let mcpServer: Awaited<ReturnType<typeof createCipherTalkMcpServer>> | null = null

async function start() {
  mcpServer = createCipherTalkMcpServer()
  const transport = new StdioServerTransport()
  await mcpServer.connect(transport)

  process.stderr.write('[CipherTalk MCP] stdio server started\n')
}

async function shutdown(code = 0) {
  try {
    await mcpServer?.close()
  } catch (error) {
    process.stderr.write(`[CipherTalk MCP] close error: ${String(error)}\n`)
  } finally {
    process.exit(code)
  }
}

process.on('SIGINT', () => {
  void shutdown(0)
})

process.on('SIGTERM', () => {
  void shutdown(0)
})

process.on('uncaughtException', (error) => {
  process.stderr.write(`[CipherTalk MCP] uncaughtException: ${String(error)}\n`)
  void shutdown(1)
})

process.on('unhandledRejection', (error) => {
  process.stderr.write(`[CipherTalk MCP] unhandledRejection: ${String(error)}\n`)
  void shutdown(1)
})

void start().catch((error) => {
  process.stderr.write(`[CipherTalk MCP] startup failed: ${String(error)}\n`)
  void shutdown(1)
})
