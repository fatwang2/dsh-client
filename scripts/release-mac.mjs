/**
 * Build a signed and notarized macOS DMG from validated release credentials.
 *
 * Requires one of:
 *   - a Developer ID Application identity + private key in the login Keychain
 *     (optionally narrowed by MACOS_SIGN_IDENTITY), or
 *   - CSC_LINK/CSC_NAME/CSC_KEY_PASSWORD for a PKCS#12 certificate.
 *
 * Requires one of for notarization:
 *   - APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or
 *   - APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or
 *   - a stored Keychain profile named by APPLE_KEYCHAIN_PROFILE.
 *
 * Signing/notarization secrets are only exposed to the electron-builder
 * subprocess; every other subprocess sees a sanitized environment.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RELEASE_VARIABLES = [
  'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_ID',
  'APPLE_API_KEY_PATH', 'APPLE_SIGNING_IDENTITY',
  'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_ID', 'APPLE_KEYCHAIN',
  'APPLE_KEYCHAIN_PROFILE', 'APPLE_TEAM_ID', 'CSC_KEY_PASSWORD',
  'CSC_LINK', 'CSC_NAME', 'MACOS_SIGN_IDENTITY', 'SPARKLE_PRIVATE_KEY_FILE',
]

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const productName = 'DeepSeek Harness'
const releaseOwner = 'fatwang2'
const releaseRepository = 'dsh-client'
const releaseRepo = `${releaseOwner}/${releaseRepository}`
const packageMetadata = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'))
const releaseVersion = packageMetadata.version

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
}

function capture(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}${detail === '' ? '' : `: ${detail}`}`)
  }
  return result.stdout.trim()
}

function timed(label, action) {
  const startedAt = Date.now()
  try {
    return action()
  } finally {
    console.log(`[timing] ${label}: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
  }
}

function sanitizedEnvironment(env) {
  const sanitized = { ...env }
  for (const name of RELEASE_VARIABLES) delete sanitized[name]
  for (const name of Object.keys(sanitized)) {
    if (name.startsWith('APPLE_') || name.startsWith('CSC_')) delete sanitized[name]
  }
  return sanitized
}

function listCodeSigningIdentities() {
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`security find-identity exited with ${String(result.status)}`)
  return result.stdout
}

function assertMacReleaseReady(env) {
  if (process.platform !== 'darwin') {
    throw new Error('macOS signed release must be built on macOS')
  }
  const identities = listCodeSigningIdentities()
  const requestedIdentity = env.MACOS_SIGN_IDENTITY?.trim()
  const developerId = identities.split('\n').find(line => requestedIdentity === undefined
    ? line.includes('Developer ID Application')
    : line.includes(requestedIdentity))
  const hasKeychainIdentity = developerId !== undefined
  const hasP12 = env.CSC_LINK !== undefined && env.CSC_KEY_PASSWORD !== undefined
  if (!hasKeychainIdentity && !hasP12) {
    throw new Error(requestedIdentity === undefined
      ? 'no Developer ID Application identity found in Keychain and no CSC_LINK PKCS#12 supplied'
      : `requested signing identity is not available in Keychain: ${requestedIdentity}`)
  }
  const hasAppleId = env.APPLE_ID !== undefined && env.APPLE_APP_SPECIFIC_PASSWORD !== undefined && env.APPLE_TEAM_ID !== undefined
  const hasApiKey = env.APPLE_API_KEY !== undefined && env.APPLE_API_KEY_ID !== undefined && env.APPLE_API_ISSUER !== undefined
  const hasProfile = env.APPLE_KEYCHAIN_PROFILE !== undefined
  if (!hasAppleId && !hasApiKey && !hasProfile) {
    throw new Error('notarization credentials incomplete: supply the Apple ID group, the App Store Connect API key group, or APPLE_KEYCHAIN_PROFILE')
  }
  if (hasApiKey && !existsSync(env.APPLE_API_KEY)) {
    throw new Error(`App Store Connect API key file is missing: ${env.APPLE_API_KEY}`)
  }
  return {
    signing: hasP12 ? 'PKCS#12 (CSC_LINK)' : 'Keychain Developer ID Application',
    notarization: hasProfile ? 'Keychain profile' : hasApiKey ? 'App Store Connect API key' : 'Apple ID',
  }
}

function assertUpdateArtifacts() {
  const output = resolve(desktopRoot, 'dist')
  const entries = readdirSync(output, { withFileTypes: true })
  const files = entries.filter(entry => entry.isFile()).map(entry => entry.name)
  const required = [
    ['DMG', file => file.endsWith('.dmg')],
    ['update ZIP', file => file.endsWith('.zip')],
    ['ZIP blockmap', file => file.endsWith('.zip.blockmap')],
    ['latest-mac.yml', file => file === 'latest-mac.yml'],
  ]
  for (const [label, matches] of required) {
    if (!files.some(matches)) throw new Error(`release did not produce ${label}`)
  }

  const appDirectory = entries.find(entry => entry.isDirectory() && entry.name.startsWith('mac'))
  const appPath = appDirectory === undefined
    ? undefined
    : resolve(output, appDirectory.name, `${productName}.app`)
  const appUpdate = appDirectory === undefined
    ? undefined
    : resolve(output, appDirectory.name, `${productName}.app/Contents/Resources/app-update.yml`)
  if (appPath === undefined || !existsSync(appPath) || appUpdate === undefined || !existsSync(appUpdate)) {
    throw new Error('release app is missing Contents/Resources/app-update.yml')
  }
  const updateConfig = readFileSync(appUpdate, 'utf8')
  if (!updateConfig.includes('provider: github') || !updateConfig.includes(`owner: ${releaseOwner}`) || !updateConfig.includes(`repo: ${releaseRepository}`)) {
    throw new Error(`release app update feed is not ${releaseOwner}/${releaseRepository}`)
  }
  const artifacts = files
    .filter(file => file.endsWith('.dmg') || file.endsWith('.zip') || file.endsWith('.blockmap') || file === 'latest-mac.yml')
    .map(file => resolve(output, file))
  console.log(`release update artifacts verified for GitHub Releases: ${releaseRepo}`)
  return { appPath, artifacts }
}

function assertDistributionReady(appPath, artifacts, env) {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], desktopRoot, env)
  run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath], desktopRoot, env)
  run('xcrun', ['stapler', 'validate', appPath], desktopRoot, env)
  for (const dmg of artifacts.filter(path => path.endsWith('.dmg'))) {
    run('hdiutil', ['verify', dmg], desktopRoot, env)
  }
  console.log('Developer ID signature, Gatekeeper assessment, notarization ticket, and DMG integrity verified')
}

function assertPublishReady(env) {
  const safeEnvironment = sanitizedEnvironment(env)
  const changes = capture('git', ['status', '--porcelain'], desktopRoot, safeEnvironment)
  if (changes !== '') throw new Error('refusing to publish from a dirty worktree')
  const branch = capture('git', ['branch', '--show-current'], desktopRoot, safeEnvironment)
  if (branch !== 'main') throw new Error(`refusing to publish from branch ${branch}; merge to main first`)
  run('gh', ['auth', 'status'], desktopRoot, safeEnvironment)
  capture('gh', ['repo', 'view', releaseRepo, '--json', 'nameWithOwner'], desktopRoot, safeEnvironment)
}

function publishRelease(artifacts, env) {
  const safeEnvironment = sanitizedEnvironment(env)
  const tag = env.DSH_RELEASE_TAG?.trim() || `v${releaseVersion}`
  const notes = resolve(desktopRoot, `.github/release-notes/${releaseVersion}.md`)
  const exists = spawnSync('gh', ['release', 'view', tag, '--repo', releaseRepo], {
    cwd: desktopRoot,
    env: safeEnvironment,
    stdio: 'ignore',
  }).status === 0
  if (exists) {
    run('gh', ['release', 'upload', tag, ...artifacts, '--repo', releaseRepo, '--clobber'], desktopRoot, safeEnvironment)
  } else {
    const argumentsList = [
      'release', 'create', tag, ...artifacts,
      '--repo', releaseRepo,
      '--title', `${productName} ${releaseVersion}`,
      ...(existsSync(notes) ? ['--notes-file', notes] : ['--generate-notes']),
    ]
    run('gh', argumentsList, desktopRoot, safeEnvironment)
  }
  console.log(`published: https://github.com/${releaseRepo}/releases/tag/${tag}`)
}

function main() {
  const releaseStartedAt = Date.now()
  try {
    const releaseEnvironment = { ...process.env }
    const ready = timed('release preflight', () => assertMacReleaseReady(releaseEnvironment))
    const shouldUpload = releaseEnvironment.SKIP_UPLOAD !== '1'
    if (shouldUpload) timed('publish preflight', () => assertPublishReady(releaseEnvironment))
    console.log(`macOS release preflight passed: signing via ${ready.signing}; notarization via ${ready.notarization}; updates via ${releaseRepo}`)
    const buildEnvironment = sanitizedEnvironment(releaseEnvironment)
    timed('application build', () => run('npm', ['run', 'build'], desktopRoot, buildEnvironment))
    timed('host runtime staging', () => run('node', ['scripts/stage-runtime.mjs'], desktopRoot, buildEnvironment))
    const builderIdentity = releaseEnvironment.MACOS_SIGN_IDENTITY?.replace(/^Developer ID Application:\s*/u, '')
    const builderArguments = [
      'electron-builder', '--mac', 'dmg', 'zip', '--publish', 'never',
      '--config.forceCodeSigning=true',
      '--config.mac.notarize=true',
      ...(builderIdentity === undefined
        ? []
        : [`--config.mac.identity=${builderIdentity}`]),
    ]
    timed('packaging, signing, and notarization', () => run('npx', builderArguments, desktopRoot, releaseEnvironment))
    const release = timed('update artifact inspection', () => assertUpdateArtifacts())
    timed('distribution verification', () => assertDistributionReady(release.appPath, release.artifacts, releaseEnvironment))
    if (shouldUpload) {
      timed('GitHub Release upload', () => publishRelease(release.artifacts, releaseEnvironment))
    } else {
      console.log('SKIP_UPLOAD=1: signed and notarized artifacts verified locally; GitHub was not changed')
    }
  } finally {
    console.log(`[timing] total release flow: ${((Date.now() - releaseStartedAt) / 1000).toFixed(1)}s`)
  }
}

main()
