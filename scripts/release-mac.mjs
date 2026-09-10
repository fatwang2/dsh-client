/**
 * Build a signed and notarized macOS DMG from validated release credentials.
 *
 * Publishing is a cloud-only operation: the upload steps run only when
 * `DSH_RELEASE_UPLOAD=1` *and* `GITHUB_ACTIONS=true`. A developer machine can
 * run the same pipeline to build, sign, notarize, and verify exactly what CI
 * would ship (the artifacts stay in `dist/`), but it can never push them to
 * GitHub Releases — one publisher, one build environment, and no local run
 * racing the workflow for a version tag.
 *
 * Artifacts are strictly scoped to the current release version: `dist/` is
 * wiped right before packaging, and the produced DMG, update ZIP, ZIP
 * blockmap, and `latest-mac.yml` are each asserted to belong to exactly this
 * version before distribution checks or upload — so artifacts left over from
 * an earlier build (e.g. a previous version after a failed rerun) can never
 * satisfy the release or leak into the upload set.
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
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describeReleaseGap, isCompleteRelease } from './release-assets.mjs'

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
const harnessVersion = JSON.parse(readFileSync(resolve(desktopRoot, 'runtime/package.json'), 'utf8')).dependencies['@deepseek-ai/dsh']
// electron-builder output root, as configured by electron-builder.yml `directories.output`.
const distOutput = resolve(desktopRoot, 'dist')

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

/** Regex-escape a literal so it can be embedded in a pattern safely. */
function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * The artifact file-name form of the product name. electron-builder writes
 * artifact file names from electron-builder.yml's artifactName, which uses
 * the hyphenated form of the spaced product name, e.g. for product name
 * "DeepSeek Harness": `DeepSeek-Harness-<version>-mac-<arch>.dmg`.
 */
function artifactFileName(name) {
  return name.replace(/\s+/gu, '-')
}

/**
 * Wipe the previous build output before packaging. Without this, artifacts
 * from an earlier version (e.g. after a failed or repeated local build) would
 * survive in `dist/` and could satisfy the per-version assertion below or be
 * uploaded to the new tag.
 */
function cleanDistOutput() {
  rmSync(distOutput, { recursive: true, force: true })
  console.log(`cleared previous release output: ${distOutput}`)
}

/**
 * Assert that `dist/` holds exactly the artifacts of *this* release version —
 * one `<productName>-<version>-mac-<arch>.dmg`, one matching `.zip`, one
 * `.zip.blockmap`, plus `latest-mac.yml` — and that `latest-mac.yml` agrees
 * with the version and names those same files. A stale artifact from a
 * previous version fails the exact-one counts and is never returned, so it
 * cannot be signed-verified or uploaded.
 */
function assertUpdateArtifacts() {
  const entries = readdirSync(distOutput, { withFileTypes: true })
  const files = entries.filter(entry => entry.isFile()).map(entry => entry.name)
  const stem = `${artifactFileName(productName)}-${releaseVersion}`
  const versioned = new RegExp(`^${escapeRegExp(stem)}-mac-([a-z0-9]+)\\.(dmg|zip)(\\.blockmap)?$`)

  const found = { dmg: [], zip: [], 'zip.blockmap': [] }
  const stray = []
  for (const file of files) {
    const match = versioned.exec(file)
    if (match === null) {
      stray.push(file)
      continue
    }
    const kind = `${match[2]}${match[3] ?? ''}`
    // A `<dmg>.blockmap` matches too but is not part of the release set.
    if (kind in found) found[kind].push(file)
  }

  const describe = () => {
    // Only artifact-like leftovers are worth naming in an error; electron-builder
    // debug files (builder-debug.yml, …) are noise, and latest-mac.yml has its own
    // dedicated checks below.
    const artifactsLike = stray.filter(file => /\.(dmg|zip|blockmap)$/u.test(file))
    const leftovers = artifactsLike.length === 0
      ? ''
      : ` (stale or misnamed files present: ${artifactsLike.slice(0, 8).join(', ')}${artifactsLike.length > 8 ? ', …' : ''})`
    return leftovers
  }
  for (const kind of ['dmg', 'zip', 'zip.blockmap']) {
    if (found[kind].length === 1) continue
    throw new Error(
      found[kind].length === 0
        ? `release did not produce exactly one ${kind} artifact matching ${stem}-mac-<arch>${describe()}`
        : `release produced ${String(found[kind].length)} ${kind} artifacts for ${stem}: ${found[kind].join(', ')}`,
    )
  }
  const [dmg, zip, zipBlockmap] = [found.dmg[0], found.zip[0], found['zip.blockmap'][0]]
  const dmgArch = dmg.match(versioned)[1]
  const zipArch = zip.match(versioned)[1]
  if (zipBlockmap.slice(0, -'.blockmap'.length) !== zip) {
    throw new Error(`ZIP blockmap ${zipBlockmap} does not correspond to update ZIP ${zip}`)
  }
  if (dmgArch !== zipArch) {
    throw new Error(`DMG (${dmg}) and update ZIP (${zip}) are for different architectures`)
  }

  const appDirectory = entries.find(entry => entry.isDirectory() && entry.name.startsWith('mac'))
  const appPath = appDirectory === undefined
    ? undefined
    : resolve(distOutput, appDirectory.name, `${productName}.app`)
  const appUpdate = appDirectory === undefined
    ? undefined
    : resolve(distOutput, appDirectory.name, `${productName}.app/Contents/Resources/app-update.yml`)
  if (appPath === undefined || !existsSync(appPath) || appUpdate === undefined || !existsSync(appUpdate)) {
    throw new Error('release app is missing Contents/Resources/app-update.yml')
  }
  const updateConfig = readFileSync(appUpdate, 'utf8')
  if (!updateConfig.includes('provider: github') || !updateConfig.includes(`owner: ${releaseOwner}`) || !updateConfig.includes(`repo: ${releaseRepository}`)) {
    throw new Error(`release app update feed is not ${releaseOwner}/${releaseRepository}`)
  }

  const manifestFile = resolve(distOutput, 'latest-mac.yml')
  if (!files.includes('latest-mac.yml')) {
    throw new Error(`release did not produce latest-mac.yml for ${stem}`)
  }
  const manifest = readFileSync(manifestFile, 'utf8')
  const manifestVersion = manifest.match(/^version:\s*(\S+)/mu)?.[1]
  if (manifestVersion !== releaseVersion) {
    throw new Error(`latest-mac.yml pins version ${manifestVersion ?? '<missing>'} but this release is ${releaseVersion}`)
  }
  const manifestPath = manifest.match(/^path:\s*(\S+)/mu)?.[1]
  if (manifestPath !== undefined && basename(manifestPath) !== zip) {
    throw new Error(`latest-mac.yml path is ${basename(manifestPath)} but the update ZIP for this release is ${zip}`)
  }
  const manifestUrls = [...manifest.matchAll(/^[ \t]*-\s*url:\s*(\S+)/gmu)].map(line => basename(line[1]))
  if (!manifestUrls.includes(zip)) {
    throw new Error(`latest-mac.yml files do not list the update ZIP ${zip}`)
  }
  if (!existsSync(resolve(distOutput, zip))) {
    throw new Error(`latest-mac.yml names ${zip}, which is missing from ${distOutput}`)
  }

  const artifacts = [dmg, zip, zipBlockmap, 'latest-mac.yml'].map(file => resolve(distOutput, file))
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
  // The release tag is created on HEAD, so HEAD must already be origin/main:
  // otherwise the tag would point at a commit nobody else can see.
  const head = capture('git', ['rev-parse', 'HEAD'], desktopRoot, safeEnvironment)
  const remoteMain = capture('git', ['ls-remote', 'origin', 'refs/heads/main'], desktopRoot, safeEnvironment).split(/\s+/u)[0] ?? ''
  if (head !== remoteMain) {
    throw new Error(`refusing to publish ${head.slice(0, 12)}: origin/main is at ${remoteMain.slice(0, 12) || 'unknown'}; push first so the release tag lands on the built commit`)
  }
  run('gh', ['auth', 'status'], desktopRoot, safeEnvironment)
  capture('gh', ['repo', 'view', releaseRepo, '--json', 'nameWithOwner'], desktopRoot, safeEnvironment)
}

/** The Release for `tag` as GitHub reports it, or `undefined` when there is none. */
function readRelease(tag, env) {
  const result = spawnSync('gh', ['api', `repos/${releaseRepo}/releases/tags/${tag}`], { cwd: desktopRoot, env, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status === 0) return JSON.parse(result.stdout)
  if (/HTTP 404/u.test(result.stderr)) return undefined
  throw new Error(`gh api releases/tags/${tag} failed: ${result.stderr.trim()}`)
}

/**
 * Refuse to re-release a version that is already fully published, so a stray
 * dispatch or a repeated run cannot clobber a complete Release. A Release that
 * exists but is *not* complete is deliberately allowed through: that is the
 * repair path. Driven by DSH_REQUIRE_NEW_RELEASE, which applies to dry runs
 * too — a version already out is worth saying before an hour of macOS minutes.
 */
function assertReleaseIsNew(env) {
  const tag = env.DSH_RELEASE_TAG?.trim() || `v${releaseVersion}`
  const release = readRelease(tag, sanitizedEnvironment(env))
  if (release === undefined) return
  if (isCompleteRelease(release)) {
    throw new Error(`${tag} is already released with a complete asset set; bump the app version before releasing again (or allow_republish to replace it)`)
  }
  console.log(`${tag} exists but is not complete (${describeReleaseGap(release)}); this run will build and repair it`)
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
    // Repair path: a Release may exist because an earlier run was interrupted
    // (partial assets) or because someone left it as a draft/pre-release. None
    // of those can serve `electron-updater`, so normalise the flags before
    // replacing the assets — otherwise the tracker would rebuild forever.
    run('gh', ['release', 'edit', tag, '--repo', releaseRepo, '--draft=false', '--prerelease=false'], desktopRoot, safeEnvironment)
    run('gh', ['release', 'upload', tag, ...artifacts, '--repo', releaseRepo, '--clobber'], desktopRoot, safeEnvironment)
  } else {
    const argumentsList = [
      'release', 'create', tag, ...artifacts,
      '--repo', releaseRepo,
      '--target', capture('git', ['rev-parse', 'HEAD'], desktopRoot, safeEnvironment),
      '--title', `${productName} ${releaseVersion} (dsh ${harnessVersion})`,
      ...(existsSync(notes) ? ['--notes-file', notes] : ['--generate-notes']),
    ]
    run('gh', argumentsList, desktopRoot, safeEnvironment)
  }
  console.log(`published: https://github.com/${releaseRepo}/releases/tag/${tag}`)
}

function main() {
  const releaseEnvironment = { ...process.env }
  const ready = assertMacReleaseReady(releaseEnvironment)
  // Cloud-only publishing: the workflow sets DSH_RELEASE_UPLOAD=1 explicitly,
  // and a developer machine is refused even if it copies that variable. The
  // runner-only GITHUB_RUN_ID check is a second, independent signal; the local
  // entrypoint (scripts/release-mac.sh) unsets all of them outright.
  const uploadRequested = releaseEnvironment.DSH_RELEASE_UPLOAD === '1'
  if (uploadRequested && (releaseEnvironment.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_RUN_ID === undefined)) {
    throw new Error('refusing to publish from a local machine: releases are built and published by GitHub Actions (DSH_RELEASE_UPLOAD is set by the workflow only)')
  }
  const shouldUpload = uploadRequested && releaseEnvironment.SKIP_UPLOAD !== '1'
  if (releaseEnvironment.DSH_REQUIRE_NEW_RELEASE === '1') assertReleaseIsNew(releaseEnvironment)
  if (shouldUpload) assertPublishReady(releaseEnvironment)
  console.log(`macOS release preflight passed: signing via ${ready.signing}; notarization via ${ready.notarization}; ${shouldUpload ? `publishing via ${releaseRepo}` : 'local build — this flow never publishes'}`)
  const buildEnvironment = sanitizedEnvironment(releaseEnvironment)
  run('npm', ['run', 'build'], desktopRoot, buildEnvironment)
  run('node', ['scripts/stage-runtime.mjs'], desktopRoot, buildEnvironment)
  // Boot the real staged Host once and validate its readiness line against the
  // shell's parser contract before any signing work: an upstream harness whose
  // readiness format the shell cannot parse fails the release instead of shipping.
  run('node', ['scripts/smoke-host.mjs'], desktopRoot, buildEnvironment)
  // Fresh output only: wipe artifacts of any earlier version so the assertion
  // below sees — and uploads — nothing but what this build produced.
  cleanDistOutput()
  const builderIdentity = releaseEnvironment.MACOS_SIGN_IDENTITY?.replace(/^Developer ID Application:\s*/u, '')
  const builderArguments = [
    'electron-builder', '--mac', 'dmg', 'zip', '--publish', 'never',
    '--config.forceCodeSigning=true',
    '--config.mac.notarize=true',
    ...(builderIdentity === undefined
      ? []
      : [`--config.mac.identity=${builderIdentity}`]),
  ]
  run('npx', builderArguments, desktopRoot, releaseEnvironment)
  const release = assertUpdateArtifacts()
  assertDistributionReady(release.appPath, release.artifacts, releaseEnvironment)
  if (shouldUpload) {
    publishRelease(release.artifacts, releaseEnvironment)
  } else {
    console.log(`signed and notarized artifacts verified locally under ${distOutput}; GitHub was not changed (local runs never publish)`)
  }
}

main()
