/**
 * What a published GitHub Release must contain for the signed automatic-update
 * feed to work, in one place: `scripts/track-dsh.mjs` decides from it whether a
 * release still has to happen, and `scripts/release-mac.mjs` decides from it
 * whether the current version may be published again. Both must agree, so the
 * definition of "complete" lives here rather than in either script.
 */

/**
 * One pattern per required artifact: the installer, the update archive, that
 * archive's blockmap (electron-updater downloads only the changed blocks), and
 * the `latest-mac.yml` manifest that points at them.
 */
export const RELEASE_ASSETS = [/\.dmg$/u, /\.zip$/u, /\.zip\.blockmap$/u, /latest-mac\.yml$/u]

/**
 * Names of the required assets absent from `assetNames`; empty when complete.
 * @param {string[]} assetNames
 * @returns {RegExp[]}
 */
export function missingReleaseAssets(assetNames) {
  return RELEASE_ASSETS.filter(pattern => !assetNames.some(name => pattern.test(name)))
}

/**
 * True only for a Release that is publicly consumable (published, not a draft,
 * not a pre-release) and carries every required asset. A tag alone — or a
 * Release missing the DMG, the update ZIP, its blockmap, or `latest-mac.yml` —
 * is not complete, so the pipeline treats it as still to be built and repairs
 * it instead of skipping it. A pre-release is incomplete on purpose: stable
 * `electron-updater` clients do not see pre-releases, so it cannot serve as
 * the published feed.
 * @param {{ draft?: boolean, prerelease?: boolean, assets?: { name?: string }[] } | undefined} release
 * @returns {boolean}
 */
export function isCompleteRelease(release) {
  if (release === undefined || release === null || release.draft === true) return false
  if (release.prerelease === true) return false
  const names = (release.assets ?? []).map(asset => asset.name ?? '')
  return missingReleaseAssets(names).length === 0
}

/**
 * Human-readable description of what is missing from a Release, for logs.
 * @param {{ draft?: boolean, prerelease?: boolean, assets?: { name?: string }[] } | undefined} release
 * @returns {string}
 */
export function describeReleaseGap(release) {
  if (release === undefined || release === null) return 'no Release'
  if (release.draft === true) return 'draft Release'
  if (release.prerelease === true) return 'pre-release'
  const missing = missingReleaseAssets((release.assets ?? []).map(asset => asset.name ?? ''))
  return missing.length === 0 ? 'complete' : `missing ${missing.map(pattern => pattern.source).join(', ')}`
}
