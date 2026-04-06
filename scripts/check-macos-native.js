const fs = require('fs')
const path = require('path')

const rootDir = path.resolve(__dirname, '..')
const macosDir = path.join(rootDir, 'resources', 'macos')

const requiredArtifacts = [
  { name: 'libwx_key.dylib', type: 'file', generated: true },
  { name: 'xkey_helper', type: 'file', generated: true },
  { name: 'image_scan_helper', type: 'file', generated: true },
  { name: 'libwcdb_api.dylib', type: 'file', generated: true },
  { name: 'libwcdb_decrypt.dylib', type: 'file', generated: true },
  { name: 'entitlements.mac.plist', type: 'file', generated: false },
  { name: 'image_scan_entitlements.plist', type: 'file', generated: false }
]

function statSafe(targetPath) {
  try {
    return fs.statSync(targetPath)
  } catch {
    return null
  }
}

function main() {
  console.log(`[macos-native-check] target dir: ${macosDir}`)

  if (!fs.existsSync(macosDir)) {
    console.error('[macos-native-check] resources/macos does not exist')
    process.exit(1)
  }

  const missing = []
  const present = []

  for (const artifact of requiredArtifacts) {
    const targetPath = path.join(macosDir, artifact.name)
    const stat = statSafe(targetPath)

    if (!stat || (artifact.type === 'file' && !stat.isFile())) {
      missing.push(artifact)
      continue
    }

    present.push({
      name: artifact.name,
      size: stat.size,
      generated: artifact.generated
    })
  }

  if (present.length > 0) {
    console.log('[macos-native-check] present:')
    for (const item of present) {
      console.log(`  - ${item.name} (${item.size} bytes)${item.generated ? ' [generated]' : ' [static]'}`)
    }
  }

  if (missing.length > 0) {
    console.error('[macos-native-check] missing:')
    for (const item of missing) {
      console.error(`  - ${item.name}${item.generated ? ' [build required]' : ''}`)
    }
    process.exit(2)
  }

  console.log('[macos-native-check] all required macOS native artifacts are present')
}

main()
