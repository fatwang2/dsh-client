/**
 * Keep the bundled harness on the latest published `@deepseek-ai/dsh`.
 *
 * Subcommands, all driven by `.github/workflows/track-dsh.yml`:
 *
 *   check              Compare the pin in runtime/package.json with the
 *                      newest upstream GitHub Release, and the current app
 *                      version with the GitHub Release it should have, then
 *                      report what the workflow must do. Never writes.
 *   bump <version>     Perform the upgrade: rewrite the pin, resolve the Host
 *                      closure afresh (`stage-runtime.mjs --relock`), bump
 *                      the app's patch version, and write the release notes.
 *                      Idempotent: a pin already at the target is a no-op, so
 *                      a repeated or queued run cannot fail on a race.
 *   status             Report whether the app version on disk already has a
 *                      complete Release; the release job runs this after the
 *                      optional bump so a duplicate run skips the build.
 *
 * The app version is independent from the harness version on purpose. The
 * harness ships release candidates (`0.1.2-rc.1`), and an installed app on a
 * stable version would skip a prerelease update, so every tracked upgrade is
 * one plain patch bump of the app and the notes say which harness it bundles.
 *
 * `check` reports a release as needed when the pin moves *or* when the
 * current app version has no complete GitHub Release yet (a published Release
 * that is missing required assets is repaired, not skipped), so a build that
 * failed after its bump commit landed is retried on the next run instead of
 * stranding `main` on an unreleased version. See scripts/release-assets.mjs
 * for the asset set that defines "complete".
 *
 * Explicit versions are exact and may never downgrade the pin: `workflow_dispatch`
 * with a version older than the current pin is refused.
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { describeReleaseGap, isCompleteRelease } from './release-assets.mjs'
import { compareVersions } from './semver-compare.mjs'

const root = resolve(import.meta.dirname, '..')
const HARNESS = '@deepseek-ai/dsh'
const UPSTREAM_REPO = 'deepseek-ai/deepseek-harness'
const UPSTREAM = `https://github.com/${UPSTREAM_REPO}`
/** Upstream tags its harness releases `dsh-v<version>`; other tags in the monorepo are not ours to track. */
const UPSTREAM_TAG = /^dsh-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u
const RELEASE_REPO = 'fatwang2/dsh-client'
const RUNTIME_MANIFEST = resolve(root, 'runtime/package.json')
const APP_MANIFEST = resolve(root, 'package.json')
/** An exact version, optionally with a prerelease suffix; never a range. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/**
 * Thrown when upstream has released a version that npm does not carry yet.
 * That is a transient state, not a broken pin: the pin must stay put and the
 * tracker retries on the next tick instead of failing every run red.
 */
class NpmLagError extends Error {}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}${detail === '' ? '' : `: ${detail}`}`)
  }
  return result.stdout.trim()
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function assertExactVersion(version, label) {
  if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
    throw new Error(`${label} must be an exact ${HARNESS} version, got ${String(version)}`)
  }
  return version
}

function pinnedVersion() {
  return assertExactVersion(readJson(RUNTIME_MANIFEST).dependencies?.[HARNESS], 'runtime/package.json pin')
}

function appVersion() {
  return readJson(APP_MANIFEST).version
}

/**
 * The newest harness upstream has released on GitHub, alphas included:
 * upstream marks every cut as a prerelease, so "latest" there is simply the
 * highest `dsh-v` tag. The pin installs from npm, so the version must also
 * be published there.
 */
function latestPublished() {
  // `--jq '.[]'` emits one compact JSON object per line, which stays parseable
  // across pages (unlike raw `--paginate` output, which concatenates arrays).
  const raw = capture('gh', ['api', `repos/${UPSTREAM_REPO}/releases?per_page=100`, '--paginate', '--jq', '.[]'])
  const releases = raw.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
  const versions = releases
    .filter(release => release.draft !== true)
    .map(release => UPSTREAM_TAG.exec(String(release.tag_name))?.[1])
    .filter(version => version !== undefined)
  if (versions.length === 0) throw new Error(`no dsh-v* releases found in ${UPSTREAM_REPO}`)
  const newest = versions.sort(compareVersions).at(-1)
  const view = JSON.parse(capture('npm', ['view', HARNESS, 'versions', '--json']))
  // A single published version comes back as a bare string, not an array.
  const published = Array.isArray(view) ? view : [view]
  if (!published.includes(newest)) throw new NpmLagError(`${UPSTREAM_REPO} released ${newest} but ${HARNESS}@${newest} is not on npm yet`)
  return newest
}

/**
 * The Release for `tag` as GitHub reports it, or `undefined` when there is no
 * Release for that tag. A 404 is a definite no; any other failure is an error.
 */
function readRelease(tag) {
  const result = spawnSync('gh', ['api', `repos/${RELEASE_REPO}/releases/tags/${tag}`], { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status === 0) return JSON.parse(result.stdout)
  if (/HTTP 404/u.test(result.stderr)) return undefined
  throw new Error(`gh api releases/tags/${tag} failed: ${result.stderr.trim()}`)
}

/** The tag this tracker considers "the Release of the app version". */
function appTag(version) {
  return process.env.DSH_RELEASE_TAG?.trim() || `v${version}`
}

/**
 * True only when the Release for `tag` is publicly consumable and carries
 * every required asset, and — the cheap but important part — when its
 * `latest-mac.yml` agrees that it is `expectedVersion`. A bare tag, a draft,
 * a pre-release, a missing asset, or a manifest pointing at another version is
 * treated as not released, so the next run rebuilds and repairs it
 * (release-mac.mjs uploads with `--clobber` onto an existing tag).
 */
function releaseComplete(tag, expectedVersion) {
  const release = readRelease(tag)
  if (release === undefined || !isCompleteRelease(release)) {
    if (release !== undefined) {
      console.log(`${tag} Release is not complete (${describeReleaseGap(release)}); the next release job will repair it`)
    }
    return false
  }
  const manifest = (release.assets ?? []).find(asset => /latest-mac\.yml$/u.test(asset.name ?? ''))
  if (manifest?.id !== undefined && expectedVersion !== undefined) {
    const text = capture('gh', ['api', `repos/${RELEASE_REPO}/releases/assets/${String(manifest.id)}`, '-H', 'Accept: application/octet-stream'])
    const declared = /^version:\s*(\S+)/mu.exec(text)?.[1]
    if (declared !== expectedVersion) {
      console.log(`${tag} Release carries a latest-mac.yml for ${declared ?? '<missing>'} instead of ${expectedVersion}; the next release job will rebuild it`)
      return false
    }
  }
  return true
}

/** Publish a key/value for the workflow (and echo it for the log). */
function setOutput(name, value) {
  const line = `${name}=${String(value)}`
  if (process.env.GITHUB_OUTPUT !== undefined) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`)
  console.log(line)
}

function check(requested) {
  const pinned = pinnedVersion()
  const app = appVersion()
  // Ask about the release state first: it is what makes a repair run valuable
  // even when the registry comparison below cannot reach a conclusion.
  const released = releaseComplete(appTag(app), app)
  let target
  let bump
  if (requested !== undefined) {
    target = assertExactVersion(requested, 'requested version')
    if (compareVersions(target, pinned) < 0) {
      throw new Error(`refusing to track ${HARNESS} ${target}: the pin is newer (${pinned}); explicit versions may not downgrade`)
    }
    bump = target !== pinned
  } else {
    try {
      target = latestPublished()
      // `>` rather than `!==`: a pin ahead of the newest upstream release is
      // not something to bump down to, and must not fail every tick.
      bump = compareVersions(target, pinned) > 0
      if (!bump && target !== pinned) {
        console.log(`${HARNESS} ${pinned} is ahead of the newest upstream Release (${target}); nothing to bump`)
      }
    } catch (error) {
      if (!(error instanceof NpmLagError)) throw error
      // Upstream tagged a release that npm has not published yet. Hold the pin,
      // and still allow a repair run for the version already on main.
      console.log(`warning: ${error.message}; holding the pin at ${pinned}`)
      target = pinned
      bump = false
    }
  }
  const release = bump || !released
  setOutput('target', target)
  setOutput('pinned', pinned)
  setOutput('app_version', app)
  setOutput('bump', bump)
  setOutput('release', release)
  if (bump) console.log(`${HARNESS} ${pinned} -> ${target}: bump and release`)
  else if (!released) console.log(`${HARNESS} ${pinned} is current but ${appTag(app)} has no complete GitHub Release: release`)
  else console.log(`${HARNESS} ${pinned} is current and ${appTag(app)} is released: nothing to do`)
}

function writeReleaseNotes(version, target, previous) {
  const path = resolve(root, `.github/release-notes/${version}.md`)
  const notes = [
    `## DeepSeek Harness ${version}`,
    '',
    `Tracks the DeepSeek Harness release train: bundles \`${HARNESS}\` **${target}** (previously ${previous}).`,
    '',
    `- Upstream release: ${UPSTREAM}/releases/tag/dsh-v${target}`,
    `- Package: https://www.npmjs.com/package/${HARNESS}/v/${target}`,
    '',
    'No client-side changes. Signed and notarized automatically; existing installs update in the background.',
    '',
  ].join('\n')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, notes)
  return path
}

function bump(requested) {
  const target = assertExactVersion(requested, 'bump target')
  const previous = pinnedVersion()
  if (compareVersions(target, previous) < 0) {
    throw new Error(`refusing to downgrade ${HARNESS} from ${previous} to ${target}`)
  }
  // Idempotent: a concurrent or repeated run may already have pinned the
  // target. Report the current state and let the workflow decide from
  // `git status` whether there is anything to commit.
  if (target === previous) {
    console.log(`${HARNESS} is already pinned to ${target}; nothing to bump`)
    setOutput('target', target)
    setOutput('app_version', appVersion())
    return
  }

  const manifest = readJson(RUNTIME_MANIFEST)
  manifest.dependencies[HARNESS] = target
  writeFileSync(RUNTIME_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`pinned ${HARNESS} ${previous} -> ${target}`)

  // Resolve the closure afresh so runtime-host/package-lock.json follows the
  // pin; stage-runtime.mjs rejects a tree that mixes harness releases.
  run('node', ['scripts/stage-runtime.mjs', '--relock'])

  const version = capture('npm', ['version', 'patch', '--no-git-tag-version']).replace(/^v/u, '')
  const notes = writeReleaseNotes(version, target, previous)
  console.log(`app version ${appVersion() === version ? version : `${version} (manifest says ${appVersion()})`}; notes at ${notes.slice(root.length + 1)}`)
  setOutput('target', target)
  setOutput('app_version', version)
}

/**
 * Report whether the app version on disk already has a complete Release.
 * The release job runs this *after* its optional bump, so a queued duplicate
 * run — or a manual release that finished first — finds the target version
 * already out and skips the expensive macOS build instead of clobbering it.
 */
function status() {
  const app = appVersion()
  const released = releaseComplete(appTag(app), app)
  setOutput('released', released)
  console.log(`${appTag(app)} has a complete Release: ${String(released)}`)
}

function main(argv) {
  const [command, ...rest] = argv
  const explicit = rest.indexOf('--version')
  const flagVersion = explicit >= 0 ? rest[explicit + 1] : undefined
  const envVersion = process.env.DSH_TRACK_VERSION?.trim() || undefined
  switch (command) {
    case 'check':
      check(flagVersion ?? envVersion)
      return
    case 'bump':
      bump(rest[0] ?? envVersion)
      return
    case 'status':
      status()
      return
    default:
      throw new Error('usage: track-dsh.mjs check [--version <exact>] | bump <exact> | status')
  }
}

main(process.argv.slice(2))
