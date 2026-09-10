import { describe, expect, it } from 'vitest'

import { describeReleaseGap, isCompleteRelease, missingReleaseAssets } from '../scripts/release-assets.mjs'

/** The asset set `electron-builder --mac dmg zip` produces and uploads. */
const completeAssets = [
  'DeepSeek-Harness-0.1.1-mac-arm64.dmg',
  'DeepSeek-Harness-0.1.1-mac-arm64.dmg.blockmap',
  'DeepSeek-Harness-0.1.1-mac-arm64.zip',
  'DeepSeek-Harness-0.1.1-mac-arm64.zip.blockmap',
  'latest-mac.yml',
]

const release = assetNames => ({ draft: false, assets: assetNames.map(name => ({ name })) })

describe('missingReleaseAssets', () => {
  it('reports nothing for a complete asset set', () => {
    expect(missingReleaseAssets(completeAssets)).toEqual([])
  })

  it('treats the DMG blockmap and the ZIP blockmap as different assets', () => {
    // electron-updater downloads the ZIP blockmap; a DMG blockmap alone cannot
    // serve an update, so it must not satisfy the requirement.
    const withoutZipBlockmap = completeAssets.filter(name => !name.endsWith('.zip.blockmap'))
    const missing = missingReleaseAssets(withoutZipBlockmap)
    expect(missing).toHaveLength(1)
    expect(missing[0].source).toBe('\\.zip\\.blockmap$')
  })

  it('reports each missing kind once', () => {
    expect(missingReleaseAssets([])).toHaveLength(4)
  })
})

describe('isCompleteRelease', () => {
  it('accepts a published release carrying every asset', () => {
    expect(isCompleteRelease(release(completeAssets))).toBe(true)
  })

  it('rejects a release that exists only as a tag or a draft', () => {
    expect(isCompleteRelease(undefined)).toBe(false)
    expect(isCompleteRelease({ draft: true, assets: completeAssets.map(name => ({ name })) })).toBe(false)
  })

  it('rejects a pre-release even with a full asset set', () => {
    // Stable electron-updater clients never see pre-releases, so such a Release
    // cannot serve as the published feed and must be rebuilt/renormalised.
    expect(isCompleteRelease({ draft: false, prerelease: true, assets: completeAssets.map(name => ({ name })) })).toBe(false)
    expect(describeReleaseGap({ draft: false, prerelease: true })).toBe('pre-release')
  })

  it('rejects a partial release so the pipeline repairs it', () => {
    expect(isCompleteRelease(release(['DeepSeek-Harness-0.1.1-mac-arm64.zip']))).toBe(false)
    expect(isCompleteRelease(release(completeAssets.filter(name => name !== 'latest-mac.yml')))).toBe(false)
  })

  it('tolerates releases without an assets array', () => {
    expect(isCompleteRelease({ draft: false })).toBe(false)
  })
})

describe('describeReleaseGap', () => {
  it('names the missing kinds', () => {
    expect(describeReleaseGap(undefined)).toBe('no Release')
    expect(describeReleaseGap({ draft: true })).toBe('draft Release')
    expect(describeReleaseGap(release(completeAssets))).toBe('complete')
    expect(describeReleaseGap(release([completeAssets[3], completeAssets[4]]))).toContain('\\.dmg$')
  })
})
