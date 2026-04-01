const fs = require('fs')
const path = require('path')

const rootDir = path.resolve(__dirname, '..')
const releaseDir = path.join(rootDir, 'release')
const contextPath = path.join(releaseDir, 'release-context.json')
const releaseBodyPath = path.join(releaseDir, 'release-body.md')

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_CHAT_IDS = String(process.env.TELEGRAM_CHAT_IDS || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
const TELEGRAM_RELEASE_COVER_URL = process.env.TELEGRAM_RELEASE_COVER_URL || ''
const mode = process.env.TELEGRAM_NOTIFY_MODE || 'success'

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function markdownToPlainSummary(markdown) {
  return String(markdown || '')
    .replace(/^#+\s*/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`>-]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function getContext() {
  if (!fs.existsSync(contextPath)) return null
  return JSON.parse(fs.readFileSync(contextPath, 'utf8'))
}

function getReleaseBody() {
  if (!fs.existsSync(releaseBodyPath)) return ''
  return fs.readFileSync(releaseBodyPath, 'utf8')
}

function buildButtons(version) {
  const releaseUrl = `https://github.com/ILoveBingLu/CipherTalk/releases/tag/v${version}`
  const installerUrl = `https://github.com/ILoveBingLu/CipherTalk/releases/download/v${version}/CipherTalk-${version}-Setup.exe`
  return {
    inline_keyboard: [
      [
        { text: '📦 查看 Release', url: releaseUrl },
        { text: '⬇️ 下载安装包', url: installerUrl }
      ]
    ]
  }
}

function buildSuccessMessage(context, releaseBody) {
  const version = context?.version || process.env.RELEASE_VERSION || 'unknown'
  const blockedVersions = context?.forceUpdate?.blockedVersions || []
  const minimumSupportedVersion = context?.forceUpdate?.minimumSupportedVersion || ''
  const hasForceUpdate = Boolean(minimumSupportedVersion || blockedVersions.length > 0)
  const summary = markdownToPlainSummary(releaseBody)
    .split('\n')
    .filter(Boolean)
    .slice(0, 8)
    .join('\n')

  const thanks = []
  const primaryLogins = new Set(['ILoveBingLu'])
  for (const pr of context?.pullRequests || []) {
    if (pr?.authorLogin && !primaryLogins.has(pr.authorLogin)) {
      thanks.push(`🙏 感谢 @${pr.authorLogin} 提交 PR #${pr.number}`)
    }
  }

  const lines = [
    `🚀 <b>CipherTalk v${escapeHtml(version)} 已发布</b>`,
    '',
    '📝 <b>本次更新摘要</b>',
    escapeHtml(summary || '本次版本已完成发布，可点击下方按钮查看完整说明。'),
  ]

  if (hasForceUpdate) {
    lines.push('', '⚠️ <b>强制更新提醒</b>')
    if (minimumSupportedVersion) {
      lines.push(`- 最低安全版本：<code>${escapeHtml(minimumSupportedVersion)}</code>`)
    }
    if (blockedVersions.length) {
      lines.push(`- 封禁版本：<code>${escapeHtml(blockedVersions.join(', '))}</code>`)
    }
  }

  lines.push('', '🔗 <b>相关链接</b>', `- GitHub Release：<a href="https://github.com/ILoveBingLu/CipherTalk/releases/tag/v${encodeURIComponent(version)}">查看发布说明</a>`)

  if (thanks.length) {
    lines.push('', '🌟 <b>感谢贡献者</b>', ...thanks.map((line) => escapeHtml(line)))
  }

  return lines.join('\n')
}

function buildFailureMessage() {
  const workflowUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : ''
  const version = process.env.RELEASE_VERSION || process.env.GITHUB_REF_NAME || 'unknown'
  const lines = [
    `❌ <b>CipherTalk ${escapeHtml(version)} 发布失败</b>`,
    '',
    '请尽快检查 GitHub Actions 日志。'
  ]
  if (workflowUrl) {
    lines.push('', `🔗 <a href="${workflowUrl}">查看失败日志</a>`)
  }
  return lines.join('\n')
}

async function sendTelegramMessage(chatId, text, replyMarkup) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    reply_markup: replyMarkup
  }

  const endpoint = TELEGRAM_RELEASE_COVER_URL ? 'sendPhoto' : 'sendMessage'
  const payload = TELEGRAM_RELEASE_COVER_URL
    ? {
        chat_id: chatId,
        photo: TELEGRAM_RELEASE_COVER_URL,
        caption: text,
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      }
    : body

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })

  if (!response.ok) {
    const raw = await response.text()
    throw new Error(`Telegram 发送失败 (${response.status}): ${raw}`)
  }
}

async function main() {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_CHAT_IDS.length === 0) {
    console.log('ℹ️ Telegram 未配置，跳过通知')
    return
  }

  const context = getContext()
  const releaseBody = getReleaseBody()
  const version = context?.version || process.env.RELEASE_VERSION || 'unknown'
  const text = mode === 'failure'
    ? buildFailureMessage()
    : buildSuccessMessage(context, releaseBody)
  const replyMarkup = mode === 'failure' ? undefined : buildButtons(version)

  for (const chatId of TELEGRAM_CHAT_IDS) {
    await sendTelegramMessage(chatId, text, replyMarkup)
  }

  console.log(`✅ 已发送 Telegram 通知到 ${TELEGRAM_CHAT_IDS.length} 个目标`)
}

main().catch((error) => {
  console.error('❌ Telegram 通知失败:', error)
  process.exit(1)
})
