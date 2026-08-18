/**
 * Minimal semver-range satisfier for the plugin-market compatibility gate.
 *
 * Supports the range forms peer dependencies actually use: caret, tilde,
 * comparators (`>=`, `>`, `<=`, `<`, `=`), exact and bare-partial versions,
 * and `||` unions — with correct prerelease ordering. Not a general-purpose
 * semver implementation: the gate only answers "does the desktop's closure
 * version fall inside this peer range".
 */

interface Version {
  major: number
  minor: number
  patch: number
  /** Prerelease identifiers, e.g. `['rc', '7']` for `0.1.0-rc.7`; empty = release. */
  pre: string[]
}

/** Parse a full semver string; partial versions are padded by the caller. */
function parseFull(input: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(input.trim())
  if (m === null) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] === undefined ? [] : m[4].split('.') }
}

/** Pad a partial version (`1`, `1.2`) to a full one, dropping any prerelease. */
function parsePartial(input: string): Version | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(input.trim())
  if (m === null) return null
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0), pre: [] }
}

function comparePre(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined && y === undefined) return 0
    // A shorter prerelease list is the greater version.
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) - Number(y)
    if (xn) return -1 // numeric identifiers sort before alphanumeric
    if (yn) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** Full semver comparison (release > any prerelease of the same tuple). */
function compareVersion(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  return comparePre(a.pre, b.pre)
}

type ComparatorOp = 'gte' | 'gt' | 'lte' | 'lt' | 'eq'

interface Comparator {
  op: ComparatorOp
  version: Version
}

function testComparator(comparator: Comparator, version: Version): boolean {
  const diff = compareVersion(version, comparator.version)
  switch (comparator.op) {
    case 'gte': return diff >= 0
    case 'gt': return diff > 0
    case 'lte': return diff <= 0
    case 'lt': return diff < 0
    case 'eq': return diff === 0
  }
}

/** The caret upper bound: next non-zero component, no prerelease. */
function caretUpper(base: Version): Version {
  if (base.major > 0) return { major: base.major + 1, minor: 0, patch: 0, pre: [] }
  if (base.minor > 0) return { major: 0, minor: base.minor + 1, patch: 0, pre: [] }
  return { major: 0, minor: 0, patch: base.patch + 1, pre: [] }
}

/**
 * Expand one comparator token into a comparator list. `^`/`~` become lower and
 * upper bounds; bare partial versions become exact or `>=`/`<` pairs.
 */
function parseComparatorToken(token: string): Comparator[] | null {
  const t = token.trim()
  if (t === '' || t === '*') return []
  const op = /^(>=|<=|>|<|=|\^|~)/.exec(t)?.[1]
  const rest = op === undefined ? t : t.slice(op.length).trim()
  if (rest === '' || rest === '*' || rest === 'x') return []
  switch (op) {
    case '^': {
      // The lower bound keeps a prerelease when the token has one: `^0.1.0-rc.7`
      // means `>=0.1.0-rc.7 <0.2.0`, so the closure's rc.7 satisfies it while
      // an older rc.6 does not.
      const base = parseFull(rest) ?? parsePartial(rest)
      if (base === null) return null
      return [
        { op: 'gte', version: base },
        { op: 'lt', version: caretUpper(base) },
      ]
    }
    case '~': {
      const base = parseFull(rest) ?? parsePartial(rest)
      if (base === null) return null
      const upper = { major: base.major, minor: base.minor + 1, patch: 0, pre: [] }
      return [
        { op: 'gte', version: base },
        { op: 'lt', version: upper },
      ]
    }
    case '>=': case '>': case '<=': case '<': case '=': {
      const full = parseFull(rest) ?? parsePartial(rest)
      if (full === null) return null
      return [{ op: op === '>' ? 'gt' : op === '<' ? 'lt' : op === '>=' ? 'gte' : op === '<=' ? 'lte' : 'eq', version: full }]
    }
    default: {
      // Bare: exact when full; partial pads to `>=X.Y.0 <X.(Y+1).0`.
      const full = parseFull(rest)
      if (full !== null) return [{ op: 'eq', version: full }]
      const partial = parsePartial(rest)
      if (partial === null) return null
      if (rest.includes('.') === false) {
        return [
          { op: 'gte', version: partial },
          { op: 'lt', version: { major: partial.major + 1, minor: 0, patch: 0, pre: [] } },
        ]
      }
      return [
        { op: 'gte', version: partial },
        { op: 'lt', version: { major: partial.major, minor: partial.minor + 1, patch: 0, pre: [] } },
      ]
    }
  }
}

/** Whether a version satisfies one `||`-separated comparator set. */
function satisfiesSet(set: string, version: Version): boolean {
  const tokens = set.trim().split(/\s+/)
  for (const token of tokens) {
    const comparators = parseComparatorToken(token)
    if (comparators === null) return false
    for (const comparator of comparators) {
      if (!testComparator(comparator, version)) return false
    }
  }
  return true
}

/**
 * Whether `version` satisfies `range` (a `||`-union of comparator sets).
 * @param version - a full semver version, e.g. `0.1.0-rc.7`.
 * @param range - an npm range, e.g. `^0.1.0-rc.7`.
 * @returns true when satisfied; false for malformed input or a miss.
 */
export function satisfies(version: string, range: string): boolean {
  const parsed = parseFull(version)
  if (parsed === null) return false
  for (const set of range.split('||')) {
    if (satisfiesSet(set, parsed)) return true
  }
  return false
}
