const fs = require('fs')
const path = require('path')

const targetFile = path.join(__dirname, '..', 'node_modules', 'dmg-builder', 'out', 'dmg.js')

if (!fs.existsSync(targetFile)) {
  console.warn(`[patch-dmg-builder] skip, file not found: ${targetFile}`)
  process.exit(0)
}

const source = fs.readFileSync(targetFile, 'utf8')
const oldSnippet = `        const expandingFinalSize = finalSize * 0.1 + finalSize;
        await (0, hdiuil_1.hdiUtil)(["resize", "-size", expandingFinalSize.toString(), tempDmg]);`
const newSnippet = `        const expandingFinalSize = Math.ceil(finalSize * 0.1 + finalSize);
        await (0, hdiuil_1.hdiUtil)(["resize", "-size", expandingFinalSize.toString(), tempDmg]);`

if (source.includes(newSnippet)) {
  console.log('[patch-dmg-builder] already patched')
  process.exit(0)
}

if (!source.includes(oldSnippet)) {
  console.warn('[patch-dmg-builder] target snippet not found, skip')
  process.exit(0)
}

fs.writeFileSync(targetFile, source.replace(oldSnippet, newSnippet))
console.log('[patch-dmg-builder] patched dmg-builder resize rounding')
