/**
 * Materialize the packaged Host dependency closure into `runtime-host/`.
 *
 * `runtime/package.json` declares the exact pinned `@deepseek-ai/dsh`
 * version. This script installs its production dependency tree with npm's
 * hoisted layout (no pnpm symlink store), strips the `.bin` symlinks, scans
 * for any residual symlinks (belt and braces), and verifies that both the
 * CLI entry and the Web frontend dist exist before the packager copies the
 * tree into `Contents/Resources/host/`.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

const desktopRoot = resolve(import.meta.dirname, '..')
const runtimeManifest = join(desktopRoot, 'runtime/package.json')
const staging = join(desktopRoot, 'runtime-host')
const nodeModules = join(staging, 'node_modules')
const cliEntry = join(nodeModules, '@deepseek-ai/dsh/lib/bin.js')
const frontendEntry = join(nodeModules, '@deepseek-ai/dsh-web-frontend/dist/index.html')

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

async function main() {
  const manifest = JSON.parse(await readFile(runtimeManifest, 'utf8'))
  const pinned = manifest.dependencies?.['@deepseek-ai/dsh']
  if (typeof pinned !== 'string' || !/^\d+\.\d+\.\d+-rc\.\d+$/.test(pinned)) {
    throw new Error(`runtime/package.json must pin @deepseek-ai/dsh to an exact version, got ${String(pinned)}`)
  }
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  await cp(runtimeManifest, join(staging, 'package.json'))
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--install-strategy=hoisted'], staging)
  await materializeLinks()
  if (!existsSync(cliEntry)) throw new Error(`host CLI entry missing after staging: ${cliEntry}`)
  if (!existsSync(frontendEntry)) throw new Error(`host Web frontend missing after staging: ${frontendEntry}`)
  console.log(`host runtime staged at ${staging} (@deepseek-ai/dsh@${pinned})`)
}

await main()
