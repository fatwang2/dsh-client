/**
 * electron-builder `afterPack` hook: reject the package before signing when
 * the staged Host CLI entry or Web frontend entry is absent from Resources.
 */

const fs = require('node:fs')
const path = require('node:path')

const REQUIRED = [
  path.join('host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  path.join('host', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'),
]

exports.default = async function verifyPackagedRuntime(context) {
  const { appOutDir, packager } = context
  const productFilename = packager.appInfo.productFilename
  const resourceCandidates = [
    path.join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources'),
    path.join(appOutDir, 'resources'),
  ]
  const resourcesRoot = resourceCandidates.find(candidate => fs.existsSync(candidate))
  if (resourcesRoot === undefined) {
    throw new Error(`afterPack: no Resources directory found under ${appOutDir}`)
  }
  for (const relative of REQUIRED) {
    const full = path.join(resourcesRoot, relative)
    if (!fs.existsSync(full)) {
      throw new Error(`afterPack: staged Host artifact missing: ${full}`)
    }
  }
  console.log('afterPack: staged Host runtime verified')
}
