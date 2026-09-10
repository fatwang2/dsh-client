/**
 * electron-builder `afterPack` hook: reject the package before signing when
 * the staged Host CLI entry or Web frontend entry is absent from Resources,
 * or when the bundled harness packages do not all sit on the exact version
 * pinned in ../runtime/package.json.
 *
 * The committed runtime manifest — never the packaged tree itself — is the
 * single source of truth for the expected `@deepseek-ai/dsh` version, so a
 * closure that was swapped wholesale for another self-consistent release is
 * still rejected. The whole `host/node_modules` tree is walked recursively
 * (including nested `node_modules`) for parity with the staging check, so a
 * stray harness package hidden under a nested tree cannot escape scrutiny.
 */

const fs = require('node:fs')
const path = require('node:path')

const HOST = 'host'
const NODE_MODULES = path.join(HOST, 'node_modules')
const REQUIRED = [
  path.join(NODE_MODULES, '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  path.join(NODE_MODULES, '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'),
]

/** Every package published from the harness monorepo's own release train. */
function isHarnessTrain(name) {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

/**
 * Collect `name@version` for every harness-train package anywhere in the
 * tree. Scoped directories are expanded into their member packages, and each
 * package's own nested `node_modules` is walked in turn (mirroring the
 * recursive `collectHarnessTrain` in scripts/stage-runtime.mjs).
 */
function inspectPackage(packageDirectory, found) {
  const manifest = path.join(packageDirectory, 'package.json')
  if (fs.existsSync(manifest)) {
    const { name, version } = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    if (typeof name === 'string' && isHarnessTrain(name)) found.push({ name, version })
  }
  const nested = path.join(packageDirectory, 'node_modules')
  if (fs.existsSync(nested)) collectHarnessTrain(nested, found)
}

function collectHarnessTrain(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const entryPath = path.join(directory, entry.name)
    if (entry.name.startsWith('@')) {
      for (const scoped of fs.readdirSync(entryPath, { withFileTypes: true })) {
        if (scoped.isDirectory()) inspectPackage(path.join(entryPath, scoped.name), found)
      }
      continue
    }
    inspectPackage(entryPath, found)
  }
  return found
}

/**
 * The harness cuts its packages together and promises no compatibility
 * across release candidates, so a CLI from one rc sitting on internals from
 * another is a defect even when it boots. `npm ci` against the committed
 * lockfile should make this unreachable; this is the guard that proves it.
 * The baseline is the exact pin in `runtime/package.json` (resolved from this
 * file's own location, never from the working directory).
 */
function verifySingleRelease(resourcesRoot) {
  const runtimeManifestPath = path.join(__dirname, '..', 'runtime', 'package.json')
  const pinned = JSON.parse(fs.readFileSync(runtimeManifestPath, 'utf8')).dependencies?.['@deepseek-ai/dsh']
  // Exact version only (prerelease suffix allowed); ranges would defeat the pin.
  if (typeof pinned !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pinned)) {
    throw new Error(`afterPack: runtime/package.json must pin @deepseek-ai/dsh to an exact version, got ${String(pinned)}`)
  }
  const train = collectHarnessTrain(path.join(resourcesRoot, NODE_MODULES))
  const drifted = train.filter(entry => entry.version !== pinned)
  if (drifted.length > 0) {
    const sample = drifted.slice(0, 8).map(entry => `${entry.name}@${String(entry.version)}`).join(', ')
    throw new Error(
      `afterPack: bundled harness tree mixes releases (expected @deepseek-ai/dsh@${pinned}): ${sample}${drifted.length > sample.length ? ', …' : ''}`,
    )
  }
  return { pinned, train: train.length }
}

exports.default = async function verifyPackagedRuntime(context) {
  const { appOutDir, packager } = context
  const productFilename = packager.appInfo.productFilename
  const resourceCandidates = [
    // electron-builder mac: appOutDir is the directory that holds `<name>.app`.
    path.join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources'),
    // The .app/Contents-rooted appOutDir convention (and direct test contexts).
    path.join(appOutDir, 'Resources'),
    // Windows/Linux stage layouts use a lowercase resources directory.
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
  const { pinned, train } = verifySingleRelease(resourcesRoot)
  console.log(`afterPack: staged Host runtime verified (@deepseek-ai/dsh@${pinned}, ${String(train)} harness packages)`)
}
