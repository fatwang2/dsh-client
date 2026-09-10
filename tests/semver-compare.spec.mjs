import { describe, expect, it } from 'vitest'

import { compareVersions } from '../scripts/semver-compare.mjs'

/**
 * The harness releases a train of prereleases (`0.1.5-alpha.1`, `0.1.5-rc.1`,
 * `0.1.3-alpha.2`, …) and the tracker decides whether to bump from these
 * comparisons, so the precedence rules are load-bearing. Every expectation here
 * was cross-checked against npm's `semver` (`semver.compare`) for the same pair.
 */
const orderings = [
  // The case behind "is rc newer than alpha": prerelease identifiers compare in
  // ASCII order, and `alpha` < `rc`.
  ['0.1.5-rc.1', '0.1.5-alpha.2', 1],
  ['0.1.5-alpha.1', '0.1.5-alpha.2', -1],
  ['0.1.5-alpha.2', '0.1.5-rc.1', -1],
  // A release outranks its own prereleases.
  ['0.1.5', '0.1.5-rc.1', 1],
  ['0.1.5-rc.1', '0.1.5', -1],
  // Numeric identifiers compare numerically, so this is NOT a string compare:
  // "alpha.10" > "alpha.9" even though "10" < "9" as strings.
  ['0.1.5-alpha.10', '0.1.5-alpha.9', 1],
  ['0.1.5-rc.2', '0.1.5-rc.1', 1],
  ['0.1.5-rc.10', '0.1.5-rc.9', 1],
  // SemVer: a numeric identifier ranks below an alphanumeric one.
  ['0.1.5-1', '0.1.5-alpha', -1],
  ['0.1.5-alpha', '0.1.5-1', 1],
  // Splitting on the first hyphen keeps multi-hyphen prereleases intact; here
  // "1" is numeric and "1-hotfix" is not, so the shorter one is lower.
  ['0.1.5-rc.1', '0.1.5-rc.1-hotfix', -1],
  // Core version wins before any prerelease consideration.
  ['0.2.0-alpha.1', '0.1.5', 1],
  ['0.1.10', '0.1.9', 1],
  ['1.0.0', '0.99.99', 1],
  // Longest identifier list wins when all shared identifiers are equal.
  ['0.1.5-alpha.1.1', '0.1.5-alpha.1', 1],
  // Identical versions are equal.
  ['0.1.5-alpha.2', '0.1.5-alpha.2', 0],
]

describe('compareVersions', () => {
  it.each(orderings)('%s vs %s => %i', (a, b, expected) => {
    expect(Math.sign(compareVersions(a, b))).toBe(expected)
  })

  it('is antisymmetric for every pair it is given', () => {
    const versions = orderings.flatMap(([a, b]) => [a, b])
    for (const a of versions) {
      for (const b of versions) {
        // Sum rather than `-Math.sign(...)`: negating zero yields -0, which
        // `toBe` distinguishes from 0.
        expect(Math.sign(compareVersions(a, b)) + Math.sign(compareVersions(b, a))).toBe(0)
      }
    }
  })

  it('sorts a real release-train sample into the order upstream published it', () => {
    const train = ['0.1.5-rc.1', '0.1.0-rc.6', '0.1.5-alpha.2', '0.1.5', '0.1.5-alpha.10', '0.1.5-alpha.9']
    expect([...train].sort(compareVersions)).toEqual([
      '0.1.0-rc.6',
      '0.1.5-alpha.2',
      '0.1.5-alpha.9',
      '0.1.5-alpha.10',
      '0.1.5-rc.1',
      '0.1.5',
    ])
  })
})
