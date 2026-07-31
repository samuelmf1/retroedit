// SpCas9 sgRNA discovery around edited positions.

import {
  findPatternIndices,
  gcFraction,
  reverseComplement,
  reverseComplementPattern,
} from './bio.js'

/**
 * sgRNA scaffolds. Both are SpCas9 single-guide constructs: the crRNA repeat
 * fused to a truncated tracrRNA. The spacer is appended to the 5' end.
 */
export const TRACR_RNAS = {
  hsu2013: {
    id: 'hsu2013',
    label: 'Hsu2013',
    rs3Name: 'Hsu2013',
    scaffold:
      'GTTTTAGAGCTAGAAATAGCAAGTTAAAATAAGGCTAGTCCGTTATCAACTTGAAAAAGTGGCACCGAGTCGGTGC',
    note: 'The original chimeric sgRNA scaffold with a truncated tracrRNA, as used in the first mammalian editing papers.',
    citation: 'Hsu et al., Nat Biotechnol 2013',
  },
  chen2013: {
    id: 'chen2013',
    label: 'Chen2013',
    rs3Name: 'Chen2013', // the value RS3 expects for `sequence_tracr`
    scaffold:
      'GTTTAAGAGCTATGCTGGAAACAGCATAGCAAGTTTAAATAAGGCTAGTCCGTTATCAACTTGAAAAAGTGGCACCGAGTCGGTGC',
    note: 'Optimized "F+E" scaffold. An A–U flip removes a cryptic Pol III terminator and the first stem loop is extended, which raises loading efficiency.',
    citation: 'Chen et al., Cell 2013',
  },
}

export const DEFAULT_PAM = 'NGG'
export const DEFAULT_SPACER_LENGTH = 20
export const DEFAULT_WINDOW_BP = 100

/** SpCas9 cuts bluntly 3 bp 5' of the PAM. */
const CUT_OFFSET_FROM_PAM = 3
/** PAM-proximal bases where mismatches are least tolerated. */
const SEED_LENGTH = 10

// RS3's sequence model is trained on a fixed 30-mer: 4 nt of 5' context, the
// 20 nt protospacer, a 3 nt PAM, then 3 nt of 3' context. Guides that do not
// fit that layout cannot be scored.
const RS3_UPSTREAM = 4
const RS3_DOWNSTREAM = 3
const RS3_SPACER_LENGTH = 20
const RS3_PAM_LENGTH = 3


/** True when this PAM/spacer geometry matches what RS3 was trained on. */
export function rs3Compatible(pam, spacerLength) {
  return spacerLength === RS3_SPACER_LENGTH && pam.length === RS3_PAM_LENGTH
}

function lowerBound(sorted, value) {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Distance in bp from the nearest value in `sorted` to the span [s, e]; 0 if inside. */
function distanceToSpan(sorted, s, e) {
  if (!sorted.length) return Infinity
  const i = lowerBound(sorted, s)
  let best = Infinity
  if (i < sorted.length) best = Math.min(best, sorted[i] <= e ? 0 : sorted[i] - e)
  if (i > 0) best = Math.min(best, s - sorted[i - 1])
  return best
}

/**
 * Distance in bp from the nearest value in `sorted` to a cut junction that sits
 * between indices `cutBefore - 1` and `cutBefore`.
 */
function distanceToJunction(sorted, cutBefore) {
  if (!sorted.length) return Infinity
  const i = lowerBound(sorted, cutBefore)
  let best = Infinity
  if (i < sorted.length) best = Math.min(best, sorted[i] - cutBefore)
  if (i > 0) best = Math.min(best, cutBefore - 1 - sorted[i - 1])
  return best
}

function anyInSpan(sorted, s, e) {
  const i = lowerBound(sorted, s)
  return i < sorted.length && sorted[i] <= e
}

/**
 * Find every SpCas9 protospacer+PAM on both strands whose footprint lies within
 * `windowBp` of an edited base.
 * Pass `affected: null` to return every guide in the loaded sequence so those
 * stable records can be filtered for new edits without repeating guide work.
 *
 * `seq` and `affected` share a coordinate space, and all returned coordinates
 * are forward-strand indices into `seq` regardless of the guide's strand.
 * With an affected-base array, returns [] until an edit exists. With `null`,
 * returns the full guide catalog for exploration and metric precomputation.
 */
export function findGuides({
  seq,
  pam = DEFAULT_PAM,
  spacerLength = DEFAULT_SPACER_LENGTH,
  affected = [],
  windowBp = DEFAULT_WINDOW_BP,
}) {
  if (!seq || (affected != null && !affected.length)) return []

  const n = seq.length
  const pamLen = pam.length
  const sortedEdits = affected == null ? [] : [...affected].sort((a, b) => a - b)
  const allGuides = affected == null

  // Prefix sum over "is within windowBp of an edit" so span tests are O(1).
  const mask = new Uint8Array(n)
  for (const a of sortedEdits) {
    const lo = Math.max(0, a - windowBp)
    const hi = Math.min(n - 1, a + windowBp)
    for (let i = lo; i <= hi; i++) mask[i] = 1
  }
  const prefix = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + mask[i]
  const spanNearEdit = (s, e) => prefix[e + 1] - prefix[s] > 0

  const rs3Ok = rs3Compatible(pam, spacerLength)
  const guides = []

  const push = ({ strand, protoStart, protoEnd, pamStart, pamEnd, cutBefore }) => {
    const start = Math.min(protoStart, pamStart)
    const end = Math.max(protoEnd, pamEnd)
    if (!allGuides && !spanNearEdit(start, end)) return

    const protoFwd = seq.slice(protoStart, protoEnd + 1)
    const pamFwd = seq.slice(pamStart, pamEnd + 1)
    const spacer = strand === '+' ? protoFwd : reverseComplement(protoFwd)
    const pamSeq = strand === '+' ? pamFwd : reverseComplement(pamFwd)
    if (/[^ACGT]/.test(spacer)) return // skip guides over assembly gaps
    const synthesisHomopolymer = spacer.match(/([ACGT])\1{4,}/)?.[0] ?? null

    const seedStart = strand === '+' ? protoEnd - SEED_LENGTH + 1 : protoStart
    const seedEnd = strand === '+' ? protoEnd : protoStart + SEED_LENGTH - 1

    // 30-mer context in the guide's own 5'->3' orientation.
    let context30 = null
    if (rs3Ok) {
      const ctxStart = strand === '+' ? protoStart - RS3_UPSTREAM : pamStart - RS3_DOWNSTREAM
      const ctxEnd = strand === '+' ? pamEnd + RS3_DOWNSTREAM : protoEnd + RS3_UPSTREAM
      if (ctxStart >= 0 && ctxEnd < n) {
        const raw = seq.slice(ctxStart, ctxEnd + 1)
        const oriented = strand === '+' ? raw : reverseComplement(raw)
        if (oriented.length === 30 && !/[^ACGT]/.test(oriented)) context30 = oriented
      }
    }

    guides.push({
      id: `${strand}${protoStart}`,
      strand,
      spacer,
      pamSeq,
      context30,
      protoStart,
      protoEnd,
      pamStart,
      pamEnd,
      seedStart,
      seedEnd,
      start,
      end,
      cutBefore,
      gc: gcFraction(spacer),
      hasPolyT: spacer.includes('TTTT'),
      synthesisHomopolymer,
      startsWithG: spacer[0] === 'G',
      editDist: distanceToSpan(sortedEdits, start, end),
      cutDist: distanceToJunction(sortedEdits, cutBefore),
      disruptsPam: anyInSpan(sortedEdits, pamStart, pamEnd),
      disruptsSeed: anyInSpan(sortedEdits, seedStart, seedEnd),
      disruptsProto: anyInSpan(sortedEdits, protoStart, protoEnd),
    })
  }

  // Forward strand: PAM sits immediately 3' of the protospacer.
  for (const pamStart of findPatternIndices(seq, pam)) {
    const protoStart = pamStart - spacerLength
    if (protoStart < 0) continue
    push({
      strand: '+',
      protoStart,
      protoEnd: pamStart - 1,
      pamStart,
      pamEnd: pamStart + pamLen - 1,
      cutBefore: pamStart - CUT_OFFSET_FROM_PAM,
    })
  }

  // Reverse strand: scan the forward sequence for the reverse-complemented PAM,
  // which places the PAM to the *left* of the protospacer in forward coords.
  for (const pamStart of findPatternIndices(seq, reverseComplementPattern(pam))) {
    const protoStart = pamStart + pamLen
    const protoEnd = protoStart + spacerLength - 1
    if (protoEnd >= n) continue
    push({
      strand: '-',
      protoStart,
      protoEnd,
      pamStart,
      pamEnd: pamStart + pamLen - 1,
      cutBefore: protoStart + CUT_OFFSET_FROM_PAM,
    })
  }

  guides.sort(compareGuides)
  return guides
}
/**
 * Decorate and filter stable all-guide records for a specific edit. This cheap
 * pass preserves guide identities, so completed RS3 and off-target metrics are
 * reused as the edit changes.
 */
export function guidesNearEdits(guides, affected = [], windowBp = DEFAULT_WINDOW_BP) {
  if (!guides?.length || !affected.length) return []
  const sortedEdits = [...affected].sort((a, b) => a - b)
  return guides
    .filter((guide) => distanceToSpan(sortedEdits, guide.start, guide.end) <= windowBp)
    .map((guide) => ({
      ...guide,
      editDist: distanceToSpan(sortedEdits, guide.start, guide.end),
      cutDist: distanceToJunction(sortedEdits, guide.cutBefore),
      disruptsPam: anyInSpan(sortedEdits, guide.pamStart, guide.pamEnd),
      disruptsSeed: anyInSpan(sortedEdits, guide.seedStart, guide.seedEnd),
      disruptsProto: anyInSpan(sortedEdits, guide.protoStart, guide.protoEnd),
    }))
    .sort(compareGuides)
}


/**
 * Ranking used by the guide table. Guides carrying a red flag (a poly-T U6
 * terminator, or a non-unique genomic match once off-targets are known) are
 * deprioritized; within a flag tier we sort by RS3 descending, then by cut
 * proximity. `offUnique` is undefined until off-targets load, so ranking is
 * stable before that.
 */
export function compareGuides(a, b) {
  const penalty = (g) => (g.hasPolyT ? 1 : 0) + (g.offUnique === false ? 1 : 0)
  const pa = penalty(a)
  const pb = penalty(b)
  if (pa !== pb) return pa - pb
  const aScored = typeof a.rs3 === 'number'
  const bScored = typeof b.rs3 === 'number'
  if (aScored && bScored && a.rs3 !== b.rs3) return b.rs3 - a.rs3
  if (aScored !== bScored) return aScored ? -1 : 1
  return a.cutDist - b.cutDist || a.start - b.start
}

/** Full sgRNA transcript: spacer fused to the chosen scaffold. */
export function fullSgRna(spacer, tracrId) {
  const tracr = TRACR_RNAS[tracrId] ?? TRACR_RNAS.hsu2013
  return spacer + tracr.scaffold
}
