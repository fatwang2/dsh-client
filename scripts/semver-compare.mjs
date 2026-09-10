/**
 * SemVer precedence for exact release versions, with no dependency on npm's
 * `semver` package: `scripts/track-dsh.mjs` runs on a bare GitHub runner before
 * any `npm ci`, so it has to carry its own comparison.
 *
 * This follows the SemVer 2.0.0 precedence rules that the harness release train
 * actually exercises:
 *   - numeric core compared numerically, major first;
 *   - a version without a prerelease outranks one with it (`0.1.5` > `0.1.5-rc.1`);
 *   - prerelease identifiers compared left to right, and:
 *       - two numeric identifiers numerically (`rc.10` > `rc.9`);
 *       - two alphanumeric ones in ASCII order (`rc` > `alpha`, so
 *         `0.1.5-rc.1` > `0.1.5-alpha.2`);
 *       - a numeric identifier always ranks *below* an alphanumeric one
 *         (`0.1.5-1` < `0.1.5-alpha`), which is SemVer's rule and the case a
 *         naive "compare as strings" implementation gets wrong;
 *   - if every shared identifier is equal, the longer list wins
 *     (`0.1.5-alpha.1` < `0.1.5-alpha.1.1`).
 *
 * Lexical comparison is what makes `alpha < beta < rc` work, but nothing
 * semantic is implied: any new naming scheme that does not sort in the intended
 * order by ASCII will be ordered by ASCII. `tests/semver-compare.spec.mjs`
 * pins the behaviour against npm's `semver` implementation.
 */

/**
 * Split an exact version into its core and optional prerelease part. Splitting
 * on the first hyphen (not `split('-', 2)`) keeps multi-hyphen prereleases
 * (`0.1.5-rc.1-hotfix`) intact for identifier-wise comparison.
 * @param {string} version
 * @returns {[string, string | undefined]}
 */
function splitVersion(version) {
  const at = version.indexOf('-')
  return at === -1 ? [version, undefined] : [version.slice(0, at), version.slice(at + 1)]
}

/**
 * SemVer precedence: negative when `a` precedes `b`, positive when it follows,
 * zero when they are equal.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const [coreA, preA] = splitVersion(a)
  const [coreB, preB] = splitVersion(b)
  const numsA = coreA.split('.').map(Number)
  const numsB = coreB.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (numsA[index] !== numsB[index]) return (numsA[index] ?? 0) - (numsB[index] ?? 0)
  }
  // A prerelease precedes the corresponding release.
  if (preA === undefined || preB === undefined) {
    return (preA === undefined ? 1 : 0) - (preB === undefined ? 1 : 0)
  }
  const idsA = preA.split('.')
  const idsB = preB.split('.')
  for (let index = 0; index < Math.max(idsA.length, idsB.length); index += 1) {
    const idA = idsA[index]
    const idB = idsB[index]
    // Running out of identifiers first means lower precedence.
    if (idA === undefined) return -1
    if (idB === undefined) return 1
    const numericA = /^\d+$/u.test(idA)
    const numericB = /^\d+$/u.test(idB)
    if (numericA && numericB) {
      if (Number(idA) !== Number(idB)) return Number(idA) - Number(idB)
    } else if (numericA !== numericB) {
      // Numeric identifiers always have lower precedence than alphanumeric ones.
      return numericA ? -1 : 1
    } else if (idA !== idB) {
      return idA < idB ? -1 : 1
    }
  }
  return 0
}
