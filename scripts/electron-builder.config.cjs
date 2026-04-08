const pkg = require('../package.json')

const target = process.env.CIPHERTALK_BUILD_TARGET
const base = pkg.build || {}

function appendUnique(items = [], extras = []) {
  return [...new Set([...(items || []), ...extras])]
}

function withoutItems(items = [], values = []) {
  const blacklist = new Set(values)
  return (items || []).filter(item => !blacklist.has(item))
}

function getExtraResources(buildTarget) {
  const common = [
    {
      from: 'electron/assets/',
      to: 'assets/',
      filter: ['**/*']
    },
    {
      from: '.tmp/release-announcement.json',
      to: 'release-announcement.json'
    }
  ]

  if (buildTarget === 'mac') {
    return [
      {
        from: 'resources/macos/',
        to: 'resources/macos/',
        filter: ['**/*']
      },
      ...common
    ]
  }

  if (buildTarget === 'win') {
    return [
      {
        from: 'resources/',
        to: 'resources/',
        filter: ['*.dll']
      },
      ...common,
      {
        from: 'public/icon.ico',
        to: 'icon.ico'
      },
      {
        from: 'public/xinnian.ico',
        to: 'xinnian.ico'
      }
    ]
  }

  return base.extraResources || []
}

function getExtraFiles(buildTarget) {
  if (buildTarget === 'win') {
    return base.extraFiles || []
  }

  if (buildTarget === 'mac') {
    return [
      {
        from: 'scripts/ciphertalk-mcp',
        to: 'MacOS/ciphertalk-mcp'
      },
      {
        from: 'scripts/ciphertalk-mcp-bootstrap.cjs',
        to: 'MacOS/ciphertalk-mcp-bootstrap.cjs'
      }
    ]
  }

  return []
}

function getFiles(buildTarget) {
  const baseFiles = Array.isArray(base.files) ? [...base.files] : []
  const commonFiles = [
    '!node_modules/.vite/**/*'
  ]

  if (buildTarget === 'win') {
    return appendUnique(
      withoutItems(baseFiles, ['node_modules/koffi/build/**/*']),
      [
        ...commonFiles,
        '!node_modules/onnxruntime-node/bin/**/win32/arm64/**/*',
        'node_modules/koffi/build/koffi/win32_x64/**/*'
      ]
    )
  }

  if (buildTarget === 'mac') {
    return appendUnique(
      withoutItems(baseFiles, [
        'node_modules/koffi/build/**/*',
        '!node_modules/sherpa-onnx-node/bin/!(win-x64)/**/*',
        '!node_modules/ffmpeg-static/bin/!(win32-x64)/**/*'
      ]),
      [
        ...commonFiles,
        '!node_modules/onnxruntime-node/bin/**/linux/**/*',
        '!node_modules/onnxruntime-node/bin/**/win32/**/*',
        'node_modules/onnxruntime-node/bin/**/darwin/**/*',
        '!node_modules/sherpa-onnx-win-*/**/*',
        '!node_modules/sherpa-onnx-linux-*/**/*',
        'node_modules/sherpa-onnx-darwin-*/**/*',
        '!node_modules/sherpa-onnx-node/node_modules/sherpa-onnx-win-*/**/*',
        '!node_modules/sherpa-onnx-node/node_modules/sherpa-onnx-linux-*/**/*',
        'node_modules/sherpa-onnx-node/node_modules/sherpa-onnx-darwin-*/**/*',
        'node_modules/koffi/build/koffi/darwin_*/**/*'
      ]
    )
  }

  return appendUnique(baseFiles, commonFiles)
}

function getAsarUnpack(buildTarget) {
  const baseAsarUnpack = Array.isArray(base.asarUnpack) ? [...base.asarUnpack] : []

  if (buildTarget === 'win') {
    return appendUnique(
      withoutItems(baseAsarUnpack, ['node_modules/koffi/**/*']),
      ['node_modules/koffi/build/koffi/win32_x64/**/*']
    )
  }

  if (buildTarget === 'mac') {
    return appendUnique(
      withoutItems(baseAsarUnpack, ['node_modules/koffi/**/*']),
      ['node_modules/koffi/build/koffi/darwin_*/**/*']
    )
  }

  return baseAsarUnpack
}

function getDmg(buildTarget) {
  if (buildTarget === 'mac') {
    return {
      ...(base.dmg || {}),
      writeUpdateInfo: false
    }
  }

  return base.dmg
}

module.exports = {
  ...base,
  files: getFiles(target),
  asarUnpack: getAsarUnpack(target),
  dmg: getDmg(target),
  extraResources: getExtraResources(target),
  extraFiles: getExtraFiles(target)
}
