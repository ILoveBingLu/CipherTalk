const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const pkg = require('../package.json')

const target = process.argv[2]

if (!target || !['win', 'mac'].includes(target)) {
  console.error('Usage: node scripts/run-electron-builder.cjs <win|mac>')
  process.exit(1)
}

const cliPath = require.resolve('electron-builder/cli.js')
const configPath = path.join(__dirname, 'electron-builder.config.cjs')

const result = spawnSync(
  process.execPath,
  [cliPath, `--${target}`, '--publish', 'never', '--config', configPath],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      CIPHERTALK_BUILD_TARGET: target,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false'
    }
  }
)

// 构建阶段只要求安装包产物存在，自动更新元数据交给后续发布阶段校验。
const artifactName = target === 'mac'
  ? `release/CipherTalk-${pkg.version}-Setup.dmg`
  : `release/CipherTalk-${pkg.version}-Setup.exe`
if (!fs.existsSync(path.join(__dirname, '..', artifactName))) {
  process.exit(result.status || 1)
}
