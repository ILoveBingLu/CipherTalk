const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const target = process.argv[2]

if (!target || !['win', 'mac'].includes(target)) {
  console.error('Usage: node scripts/run-electron-builder.cjs <win|mac>')
  process.exit(1)
}

const cliPath = require.resolve('electron-builder/cli.js')
const configPath = path.join(__dirname, 'electron-builder.config.cjs')

const result = spawnSync(
  process.execPath,
  [cliPath, `--${target}`, '--config', configPath],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      CIPHERTALK_BUILD_TARGET: target,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false'
    }
  }
)

// 构建成功的判断：latest.yml 已生成（发布失败不影响构建产物）
const latestYml = target === 'mac' ? 'release/latest-mac.yml' : 'release/latest.yml'
if (!fs.existsSync(path.join(__dirname, '..', latestYml))) {
  process.exit(result.status || 1)
}
