const { spawnSync } = require('child_process')
const path = require('path')

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
      CIPHERTALK_BUILD_TARGET: target
    }
  }
)

if (result.status !== 0) {
  process.exit(result.status || 1)
}
