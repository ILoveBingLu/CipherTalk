const fs = require('fs')
const path = require('path')

const rootDir = path.resolve(__dirname, '..')
const releaseDir = path.join(rootDir, 'release')
const contextPath = path.join(releaseDir, 'release-context.json')
const outputPath = path.join(releaseDir, 'release-body.md')
const glmKey = process.env.GLM_KEY || ''

const PRIMARY_AUTHOR_LOGINS = new Set(['ILoveBingLu'])
const PRIMARY_AUTHOR_NAMES = new Set(['ILoveBingLu', 'BingLu', 'ILoveBinglu'])
const PRIMARY_AUTHOR_EMAILS = new Set(['aiqiji74@gmail.com', 'aiqji74@gmail.com'])

function isPrimaryAuthor(person) {
  if (!person) return false
  const login = String(person.authorLogin || '').trim()
  const name = String(person.authorName || '').trim()
  const email = String(person.authorEmail || '').trim().toLowerCase()
  return PRIMARY_AUTHOR_LOGINS.has(login) || PRIMARY_AUTHOR_NAMES.has(name) || PRIMARY_AUTHOR_EMAILS.has(email)
}

function classifyCommit(subject) {
  const normalized = String(subject || '').toLowerCase()
  if (normalized.startsWith('feat')) return '新增'
  if (normalized.startsWith('fix')) return '修复'
  return '调整'
}

function buildThanks(context) {
  const lines = []

  for (const pr of context.pullRequests || []) {
    if (!isPrimaryAuthor({ authorLogin: pr.authorLogin, authorName: pr.authorName })) {
      lines.push(`- 感谢 @${pr.authorLogin} 提交 PR #${pr.number}《${pr.title}》`)
    }
  }

  const prNumbers = new Set((context.pullRequests || []).map((pr) => pr.number))
  for (const commit of context.commits || []) {
    const hasPrRef = /#(\d+)/.test(commit.subject || '')
    if (hasPrRef) continue
    if (!isPrimaryAuthor(commit)) {
      lines.push(`- 感谢 ${commit.authorName} 提交改动《${commit.subject}》`)
    }
  }

  return Array.from(new Set(lines))
}

function buildReferences(context) {
  const lines = []
  for (const pr of context.pullRequests || []) {
    lines.push(`- PR #${pr.number}: [${pr.title}](${pr.url})`)
  }
  for (const commit of context.commits || []) {
    lines.push(`- Commit [${commit.shortSha}](${commit.url}): ${commit.subject}`)
  }
  return lines
}

function buildFallbackBody(context) {
  const groups = {
    新增: [],
    修复: [],
    调整: []
  }

  for (const commit of context.commits || []) {
    groups[classifyCommit(commit.subject)].push(`- ${commit.subject}（${commit.shortSha}）`)
  }

  const thanks = buildThanks(context)
  const references = buildReferences(context)
  const blockedVersions = context.forceUpdate?.blockedVersions || []
  const hasUpgradeReminder = Boolean(context.forceUpdate?.minimumSupportedVersion || blockedVersions.length > 0)

  return [
    `## CipherTalk ${context.tag}`,
    '',
    '### 概览',
    `本版本包含 ${context.commits.length} 条提交，涉及 ${(context.pullRequests || []).length} 个 PR。`,
    '',
    '### 新增',
    ...(groups.新增.length ? groups.新增 : ['- 无']),
    '',
    '### 修复',
    ...(groups.修复.length ? groups.修复 : ['- 无']),
    '',
    '### 调整',
    ...(groups.调整.length ? groups.调整 : ['- 无']),
    '',
    ...(hasUpgradeReminder ? [
      '### 升级提醒',
      ...(context.forceUpdate.minimumSupportedVersion ? [`- 最低安全版本：${context.forceUpdate.minimumSupportedVersion}`] : []),
      ...(blockedVersions.length ? [`- 封禁版本：${blockedVersions.join(', ')}`] : []),
      ''
    ] : []),
    '### 感谢贡献者',
    ...(thanks.length ? thanks : ['- 本版本无新增外部贡献']),
    '',
    '### 相关提交与 PR',
    ...(references.length ? references : ['- 无']),
    ''
  ].join('\n')
}

function isValidAiBody(body) {
  if (!body) return false
  return body.includes('## CipherTalk') && body.includes('### 感谢贡献者') && body.includes('### 相关提交与 PR')
}

async function generateAiBody(context) {
  if (!glmKey) {
    throw new Error('GLM_KEY 未配置')
  }

  const systemPrompt = [
    '你是一个发布说明撰写助手。',
    '只能基于输入中的 commits 和 pull requests 生成，不得编造任何功能或修复。',
    '输出必须是中文 Markdown。',
    '必须包含以下章节：',
    '## CipherTalk vX.Y.Z',
    '### 概览',
    '### 新增',
    '### 修复',
    '### 调整',
    '### 感谢贡献者',
    '### 相关提交与 PR',
    '如果存在最低安全版本或封禁版本，增加 ### 升级提醒 章节。',
    '有 PR 时优先引用 PR 标题；没有 PR 时才引用 commit 标题。',
    '感谢规则：只有非主作者的 PR/commit 才出现在感谢段。',
    '不要写模糊词，不要写猜测，不要写未在输入中出现的功能。'
  ].join('\n')

  const userPrompt = `请根据以下发布上下文为 ${context.tag} 生成标准化发布说明：\n\n${JSON.stringify(context, null, 2)}`

  const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${glmKey}`
    },
    body: JSON.stringify({
      model: 'glm-4.7-flash',
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  })

  if (!response.ok) {
    throw new Error(`GLM 请求失败: ${response.status}`)
  }

  const data = await response.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('GLM 返回内容为空')
  }

  const body = content.trim()
  if (!isValidAiBody(body)) {
    throw new Error('GLM 返回内容不符合格式要求')
  }

  return body
}

async function main() {
  if (!fs.existsSync(contextPath)) {
    throw new Error(`未找到 release context: ${contextPath}`)
  }

  const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'))

  let body
  try {
    body = await generateAiBody(context)
    console.log('✅ 已生成 AI Release Body')
  } catch (error) {
    console.warn('⚠️ AI 生成失败，回退到模板正文：', String(error))
    body = buildFallbackBody(context)
  }

  fs.writeFileSync(outputPath, `${body.trim()}\n`, 'utf8')
  console.log(`✅ release-body.md 已生成: ${outputPath}`)
}

main().catch((error) => {
  console.error('❌ 生成 release-body.md 失败:', error)
  process.exit(1)
})
