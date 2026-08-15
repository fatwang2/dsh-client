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
  'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_ID', 'APPLE_KEYCHAIN',
  'APPLE_KEYCHAIN_PROFILE', 'APPLE_TEAM_ID', 'CSC_KEY_PASSWORD',
  'CSC_LINK', 'CSC_NAME', 'MACOS_SIGN_IDENTITY',
]

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const productName = 'DeepSeek Harness'
const releaseOwner = 'fatwang2'
const releaseRepository = 'dsh-client'

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
}

function sanitizedEnvironment(env) {
  const sanitized = { ...env }
  for (const name of RELEASE_VARIABLES) delete sanitized[name]
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
  const developerId = identities.split('\n').find(line => line.includes('Developer ID Application'))
  const hasKeychainIdentity = developerId !== undefined
  const hasP12 = env.CSC_LINK !== undefined && env.CSC_KEY_PASSWORD !== undefined
  if (!hasKeychainIdentity && !hasP12) {
    throw new Error('no Developer ID Application identity found in Keychain and no CSC_LINK PKCS#12 supplied')
  }
  const hasAppleId = env.APPLE_ID !== undefined && env.APPLE_APP_SPECIFIC_PASSWORD !== undefined && env.APPLE_TEAM_ID !== undefined
  const hasApiKey = env.APPLE_API_KEY !== undefined && env.APPLE_API_KEY_ID !== undefined && env.APPLE_API_ISSUER !== undefined
  const hasProfile = env.APPLE_KEYCHAIN_PROFILE !== undefined
  if (!hasAppleId && !hasApiKey && !hasProfile) {
    throw new Error('notarization credentials incomplete: supply the Apple ID group, the App Store Connect API key group, or APPLE_KEYCHAIN_PROFILE')
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
  const appUpdate = appDirectory === undefined
    ? undefined
    : resolve(output, appDirectory.name, `${productName}.app/Contents/Resources/app-update.yml`)
  if (appUpdate === undefined || !existsSync(appUpdate)) {
    throw new Error('release app is missing Contents/Resources/app-update.yml')
  }
  const updateConfig = readFileSync(appUpdate, 'utf8')
  if (!updateConfig.includes('provider: github') || !updateConfig.includes(`owner: ${releaseOwner}`) || !updateConfig.includes(`repo: ${releaseRepository}`)) {
    throw new Error(`release app update feed is not ${releaseOwner}/${releaseRepository}`)
  }
  console.log(`release update artifacts verified for GitHub Releases: ${releaseOwner}/${releaseRepository}`)
}

function main() {
  const releaseEnvironment = { ...process.env }
  const ready = assertMacReleaseReady(releaseEnvironment)
  console.log(`macOS release preflight passed: signing via ${ready.signing}; notarization via ${ready.notarization}; updates via ${releaseOwner}/${releaseRepository}`)
  const buildEnvironment = sanitizedEnvironment(releaseEnvironment)
  run('npm', ['run', 'build'], desktopRoot, buildEnvironment)
  run('node', ['scripts/stage-runtime.mjs'], desktopRoot, buildEnvironment)
  run('npx', [
    'electron-builder', '--mac', 'dmg', 'zip', '--publish', 'never',
    '--config.forceCodeSigning=true',
    '--config.mac.notarize=true',
  ], desktopRoot, releaseEnvironment)
  assertUpdateArtifacts()
}

main()
