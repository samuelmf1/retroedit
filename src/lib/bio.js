// Nucleotide utilities: IUPAC handling, complementation, pattern matching.

/** Bases each IUPAC ambiguity code can stand for. */
export const IUPAC_SETS = {
  A: 'A', C: 'C', G: 'G', T: 'T',
  R: 'AG', Y: 'CT', S: 'CG', W: 'AT', K: 'GT', M: 'AC',
  B: 'CGT', D: 'AGT', H: 'ACT', V: 'ACG', N: 'ACGT',
}

/** Complement of each IUPAC code (R<->Y, K<->M, B<->V, D<->H, S/W/N self). */
export const IUPAC_COMPLEMENT = {
  A: 'T', C: 'G', G: 'C', T: 'A',
  R: 'Y', Y: 'R', S: 'S', W: 'W', K: 'M', M: 'K',
  B: 'V', V: 'B', D: 'H', H: 'D', N: 'N',
}

export const UNAMBIGUOUS = new Set(['A', 'C', 'G', 'T'])

export function complementBase(base) {
  return IUPAC_COMPLEMENT[base] ?? 'N'
}

export function reverseComplement(seq) {
  let out = ''
  for (let i = seq.length - 1; i >= 0; i--) out += complementBase(seq[i])
  return out
}

/** Reverse-complement an IUPAC *pattern*, e.g. NGG -> CCN, TTTV -> BAAA. */
export function reverseComplementPattern(pattern) {
  return reverseComplement(pattern)
}

export function isValidPattern(pattern) {
  if (!pattern) return false
  return [...pattern].every((c) => c in IUPAC_SETS)
}

/** Turn an IUPAC pattern into a regex source string. */
export function patternToRegexSource(pattern) {
  let src = ''
  for (const c of pattern) {
    const set = IUPAC_SETS[c]
    if (!set) throw new Error(`Not an IUPAC code: ${c}`)
    src += set.length === 1 ? set : `[${set}]`
  }
  return src
}

/**
 * Every start index where `pattern` matches, including overlapping matches.
 * Uses a zero-width lookahead so `CCN` finds both hits in `CCCC`.
 */
export function findPatternIndices(seq, pattern) {
  const re = new RegExp(`(?=(${patternToRegexSource(pattern)}))`, 'g')
  const hits = []
  let m
  while ((m = re.exec(seq)) !== null) {
    hits.push(m.index)
    re.lastIndex = m.index + 1 // lookahead matches are zero-width; advance manually
  }
  return hits
}

export function gcFraction(seq) {
  if (!seq.length) return 0
  let gc = 0
  for (const c of seq) if (c === 'G' || c === 'C') gc++
  return gc / seq.length
}

/**
 * Salt-adjusted melting temperature, the classic long-oligo approximation at
 * 100 mM Na+. Fine for the status bar; not a substitute for nearest-neighbour.
 */
export function meltingTemp(seq) {
  const n = seq.length
  if (n < 8) return null
  return 81.5 + 16.6 * Math.log10(0.1) + 41 * gcFraction(seq) - 600 / n
}

export function toRna(seq) {
  return seq.replace(/T/g, 'U')
}
