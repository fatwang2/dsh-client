/**
 * Materialize the packaged Host dependency closure into `runtime-host/`.
 *
 * `runtime/package.json` declares the exact pinned `@deepseek-ai/dsh`
 * version, and `runtime-host/package-lock.json` — which is committed —
 * pins the rest of the closure. The pin alone is not enough: the harness
 * packages depend on each other through caret ranges, and `^0.1.0-rc.6`
 * matches `0.1.0-rc.7`, so a lockfile-less install silently produces a
 * mixed-release tree. This script therefore installs with `npm ci`, keeps
 * npm's hoisted layout (no pnpm symlink store), strips the `.bin` symlinks,
 * scans for any residual symlinks (belt and braces), asserts that the whole
 * harness release train sits on the pinned version, and verifies that both
 * the CLI entry and the Web frontend dist exist before the packager copies
 * the tree into `Contents/Resources/host/`.
 *
 * Pass `--relock` to resolve the closure afresh and rewrite the lockfile;
 * that is the deliberate act of upgrading, and its diff belongs in the
 * commit that bumps the pin.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const desktopRoot = resolve(import.meta.dirname, '..')
const runtimeManifest = join(desktopRoot, 'runtime/package.json')
const staging = join(desktopRoot, 'runtime-host')
const lockfile = join(staging, 'package-lock.json')
const nodeModules = join(staging, 'node_modules')
const cliEntry = join(nodeModules, '@deepseek-ai/dsh/lib/bin.js')
const frontendEntry = join(nodeModules, '@deepseek-ai/dsh-web-frontend/dist/index.html')
const relock = process.argv.includes('--relock')

function run(command, args, cwd) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env }, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) accept()
      else reject(new Error(`${command} ${args.join(' ')} failed (${code === null ? `signal ${String(signal)}` : `exit ${String(code)}`})`))
    })
  })
}

async function findSymlink(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

async function materializeLinks() {
  for (let link = await findSymlink(nodeModules); link !== undefined; link = await findSymlink(nodeModules)) {
    const segments = link.slice(nodeModules.length + 1).split(sep)
    const bin = segments.lastIndexOf('.bin')
    if (bin >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, bin + 1)), { recursive: true, force: true })
      continue
    }
    const source = await realpath(link)
    await rm(link, { recursive: true, force: true })
    await cp(source, link, {
      recursive: true,
      dereference: true,
      filter: path => path !== join(source, 'node_modules') && !path.startsWith(join(source, 'node_modules') + sep),
    })
  }
}

/** Every package published from the harness monorepo's own release train. */
function isHarnessTrain(name) {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

/** Collect `name@version` for every harness-train package anywhere in the tree. */
async function collectHarnessTrain(directory, found = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const path = join(directory, entry.name)
    if (entry.name.startsWith('@')) {
      for (const scoped of await readdir(path, { withFileTypes: true })) {
        if (scoped.isDirectory()) await inspectPackage(join(path, scoped.name), found)
      }
      continue
    }
    await inspectPackage(path, found)
  }
  return found
}

async function inspectPackage(packageDirectory, found) {
  const manifest = join(packageDirectory, 'package.json')
  if (existsSync(manifest)) {
    const { name, version } = JSON.parse(await readFile(manifest, 'utf8'))
    if (typeof name === 'string' && isHarnessTrain(name)) found.push({ name, version })
  }
  const nested = join(packageDirectory, 'node_modules')
  if (existsSync(nested)) await collectHarnessTrain(nested, found)
}

/**
 * Reject a mixed-release tree. The harness ships ~230 packages that are
 * cut together and carry no cross-version compatibility promise, so a CLI
 * from one release candidate sitting on internals from another is a bug
 * even when it boots.
 */
async function assertSingleRelease(pinned) {
  const train = await collectHarnessTrain(nodeModules)
  const drifted = train.filter(entry => entry.version !== pinned)
  if (drifted.length > 0) {
    const sample = drifted.slice(0, 8).map(entry => `${entry.name}@${String(entry.version)}`)
    throw new Error(
      `staged harness tree mixes releases: ${String(drifted.length)} of ${String(train.length)} packages are not ${pinned}` +
      `\n  ${sample.join('\n  ')}${drifted.length > sample.length ? '\n  …' : ''}` +
      (relock
        // A fresh resolve already produced this, so the pin itself is stale:
        // its caret ranges reach a newer release than the pin names.
        ? `\nthe ${pinned} closure is not self-consistent; bump the pin in runtime/package.json`
        : '\nrun `npm run stage -- --relock` after bumping the pin in runtime/package.json'),
    )
  }
  return train.length
}

async function main() {
  const manifest = JSON.parse(await readFile(runtimeManifest, 'utf8'))
  const pinned = manifest.dependencies?.['@deepseek-ai/dsh']
  // Exact version only (prerelease suffix allowed); ranges would defeat the pin.
  if (typeof pinned !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pinned)) {
    throw new Error(`runtime/package.json must pin @deepseek-ai/dsh to an exact version, got ${String(pinned)}`)
  }

  // The lockfile lives inside the staging directory that this script wipes,
  // so carry it across the reset instead of resolving the closure again.
  const lock = !relock && existsSync(lockfile) ? await readFile(lockfile) : undefined
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  await cp(runtimeManifest, join(staging, 'package.json'))
  if (lock !== undefined) await writeFile(lockfile, lock)

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const flags = ['--omit=dev', '--no-audit', '--no-fund', '--install-strategy=hoisted']
  // `npm ci` fails loudly when the lockfile and the pin disagree, which is
  // exactly the signal a pin bump should produce.
  await run(npm, [lock === undefined ? 'install' : 'ci', ...flags], staging)

  await materializeLinks()
  if (!existsSync(cliEntry)) throw new Error(`host CLI entry missing after staging: ${cliEntry}`)
  if (!existsSync(frontendEntry)) throw new Error(`host Web frontend missing after staging: ${frontendEntry}`)
  const packages = await assertSingleRelease(pinned)
  if (lock === undefined) {
    console.log(`host runtime resolved afresh; commit ${lockfile.slice(desktopRoot.length + 1)} with the pin bump`)
  }
  console.log(`host runtime staged at ${staging} (@deepseek-ai/dsh@${pinned}, ${String(packages)} harness packages)`)
}

await main()
