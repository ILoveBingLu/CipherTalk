const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const rootDir = path.resolve(__dirname, '..')
const releaseDir = path.join(rootDir, 'release')
const owner = process.env.GITHUB_REPOSITORY_OWNER || 'ILoveBingLu'
const repo = (process.env.GITHUB_REPOSITORY || `${owner}/CipherTalk`).split('/')[1] || 'CipherTalk'
const currentTag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME || ''
const ghToken = process.env.GH_TOKEN || ''
const pkg = require(path.join(rootDir, 'package.json'))

function runGit(command) {
  return execSync(command, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function parseList(value) {
  if (!value) return []
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function getPreviousTag() {
  const tags = runGit('git tag --sort=-version:refname')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (!currentTag) return tags[0] || null

  const currentIndex = tags.indexOf(currentTag)
  if (currentIndex === -1) return tags[0] || null
  return tags[currentIndex + 1] || null
}

function getCommitRange(previousTag, tag) {
  if (!tag) return 'HEAD'
  if (!previousTag || previousTag === tag) return tag
  return `${previousTag}..${tag}`
}

function extractPrNumbers(commits) {
  const prNumbers = new Set()
  for (const commit of commits) {
    const matches = commit.subject.match(/#(\d+)/g)
    if (!matches) continue
    for (const match of matches) {
      prNumbers.add(Number(match.slice(1)))
    }
  }
  return Array.from(prNumbers)
}

async function fetchPullRequest(prNumber) {
  if (!ghToken) return null

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${ghToken}`,
      'User-Agent': 'CipherTalk-Release-Context'
    }
  })

  if (!response.ok) return null
  const data = await response.json()
  return {
    number: data.number,
    title: data.title,
    url: data.html_url,
    authorLogin: data.user?.login || null,
    authorName: data.user?.login || null,
    mergedBy: data.merged_by?.login || null
  }
}

async function main() {
  if (!fs.existsSync(releaseDir)) {
    fs.mkdirSync(releaseDir, { recursive: true })
  }

  const previousTag = getPreviousTag()
  const commitRange = getCommitRange(previousTag, currentTag || 'HEAD')

  const commitLines = runGit(`git log ${commitRange} --pretty=format:"%H|%h|%an|%ae|%s"`)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const commits = commitLines.map((line) => {
    const [sha, shortSha, authorName, authorEmail, ...subjectParts] = line.split('|')
    return {
      sha,
      shortSha,
      url: `https://github.com/${owner}/${repo}/commit/${sha}`,
      authorName,
      authorEmail,
      subject: subjectParts.join('|')
    }
  })

  const prNumbers = extractPrNumbers(commits)
  const prs = []
  for (const prNumber of prNumbers) {
    const pr = await fetchPullRequest(prNumber)
    if (pr) prs.push(pr)
  }

  const context = {
    version: pkg.version,
    tag: currentTag || `v${pkg.version}`,
    previousTag,
    generatedAt: new Date().toISOString(),
    repository: {
      owner,
      repo
    },
    forceUpdate: {
      minimumSupportedVersion: process.env.FORCE_UPDATE_MIN_VERSION || null,
      blockedVersions: parseList(process.env.FORCE_UPDATE_BLOCKED_VERSIONS)
    },
    commits,
    pullRequests: prs
  }

  const outputPath = path.join(releaseDir, 'release-context.json')
  fs.writeFileSync(outputPath, `${JSON.stringify(context, null, 2)}\n`, 'utf8')
  console.log(`✅ release-context.json 已生成: ${outputPath}`)
}

main().catch((error) => {
  console.error('❌ 生成 release-context.json 失败:', error)
  process.exit(1)
})
