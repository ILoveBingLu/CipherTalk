const pkg = require('../package.json')

const target = process.env.CIPHERTALK_BUILD_TARGET
const base = pkg.build || {}

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

module.exports = {
  ...base,
  extraResources: getExtraResources(target),
  extraFiles: getExtraFiles(target)
}
