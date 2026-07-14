// Codon table and synonymous-substitution search, used to make sgRNA-blocking
// mutations silent when the target lies in a coding exon.

import { complementBase, reverseComplement } from './bio.js'

// prettier-ignore
export const CODON_TABLE = {
  TTT:'F',TTC:'F',TTA:'L',TTG:'L',CTT:'L',CTC:'L',CTA:'L',CTG:'L',
  ATT:'I',ATC:'I',ATA:'I',ATG:'M',GTT:'V',GTC:'V',GTA:'V',GTG:'V',
  TCT:'S',TCC:'S',TCA:'S',TCG:'S',CCT:'P',CCC:'P',CCA:'P',CCG:'P',
  ACT:'T',ACC:'T',ACA:'T',ACG:'T',GCT:'A',GCC:'A',GCA:'A',GCG:'A',
  TAT:'Y',TAC:'Y',TAA:'*',TAG:'*',CAT:'H',CAC:'H',CAA:'Q',CAG:'Q',
  AAT:'N',AAC:'N',AAA:'K',AAG:'K',GAT:'D',GAC:'D',GAA:'E',GAG:'E',
  TGT:'C',TGC:'C',TGA:'*',TGG:'W',CGT:'R',CGC:'R',CGA:'R',CGG:'R',
  AGT:'S',AGC:'S',AGA:'R',AGG:'R',GGT:'G',GGC:'G',GGA:'G',GGG:'G',
}

export function translate(dna) {
  let aa = ''
  for (let i = 0; i + 3 <= dna.length; i += 3) aa += CODON_TABLE[dna.slice(i, i + 3)] ?? 'X'
  return aa
}

const SYNONYMS = (() => {
  const byAa = {}
  for (const [codon, aa] of Object.entries(CODON_TABLE)) (byAa[aa] ??= []).push(codon)
  return byAa
})()

export function synonymousCodons(codon) {
  const aa = CODON_TABLE[codon]
  if (!aa) return []
  return SYNONYMS[aa].filter((c) => c !== codon)
}

/**
 * A per-reference-index reading-frame map for one transcript.
 *
 * `codonPos[i]` is 0/1/2 (position of ref base i within its codon, read in the
 * transcript's own direction) or -1 outside the CDS. `strand` is the CDS strand.
 *
 * Follows the GFF3 phase convention: phase is the number of bases to remove from
 * the start of the segment to reach the first base of the next codon, so the
 * first complete codon begins at offset `phase` and base at offset k has codon
 * position (k - phase) mod 3. Verified against a full BRCA2 CDS reconstruction.
 */
export function buildFrameMap(refStart, refLen, cdsSegments, strand) {
  const codonPos = new Int8Array(refLen).fill(-1)
  const segs = cdsSegments
    .filter((s) => s.strand === strand)
    .sort((a, b) => (strand === 1 ? a.start - b.start : b.start - a.start))

  for (const seg of segs) {
    const phase = Number(seg.phase) || 0
    const len = seg.end - seg.start + 1
    for (let k = 0; k < len; k++) {
      // k counts along the transcript's 5'->3' direction within this segment.
      const genomic = strand === 1 ? seg.start + k : seg.end - k
      const refIdx = genomic - refStart
      if (refIdx < 0 || refIdx >= refLen) continue
      codonPos[refIdx] = ((k - phase) % 3 + 3) % 3
    }
  }
  return { codonPos, strand }
}

/**
 * The codon covering ref index `i`: its three ref indices in transcript order,
 * the codon bases (already oriented to the coding strand), and the amino acid.
 * Returns null when any base of the codon falls outside `refSeq` or the CDS.
 */
export function codonAt(frame, refSeq, i) {
  const pos = frame.codonPos[i]
  if (pos < 0) return null
  const step = frame.strand === 1 ? 1 : -1
  const first = i - step * pos // ref index of codon position 0
  const idx = [first, first + step, first + 2 * step]
  if (idx.some((r) => r < 0 || r >= refSeq.length || frame.codonPos[r] < 0)) return null

  const bases = idx.map((r) => refSeq[r])
  const codon = frame.strand === 1
    ? bases.join('')
    : bases.map(complementBase).join('')
  return { refIdx: idx, codon, aa: CODON_TABLE[codon], strand: frame.strand }
}

/**
 * Given a codon and the coding-strand bases we must change (a subset of the
 * three positions, so the change lands on the PAM/seed), return a synonymous
 * codon that differs at *every* required position, or null if none exists.
 * `required` is a set of 0/1/2 codon positions.
 */
export function synonymousChangingPositions(codon, required) {
  for (const alt of synonymousCodons(codon)) {
    if ([...required].every((p) => alt[p] !== codon[p])) return alt
  }
  // Fall back to any synonymous codon that changes at least one required base.
  for (const alt of synonymousCodons(codon)) {
    if ([...required].some((p) => alt[p] !== codon[p])) return alt
  }
  return null
}

/**
 * Per-reference-index codon annotation for the amino-acid track:
 *   pos[r]     0/1/2 within its codon, or -1 outside the CDS
 *   aa[r]      amino-acid letter of r's codon (drawn under the middle base)
 *   parity[r]  0/1 alternating per codon, for readable shading
 */
export function buildCodonTrack(frame, refSeq) {
  if (!frame) return null
  const n = refSeq.length
  const pos = new Int8Array(n).fill(-1)
  const parity = new Int8Array(n).fill(0)
  const aa = new Array(n).fill(null)

  const ordinalOf = new Map()
  let counter = 0
  for (let r = 0; r < n; r++) {
    if (frame.codonPos[r] < 0) continue
    const c = codonAt(frame, refSeq, r)
    if (!c) continue
    const key = c.refIdx[0]
    if (!ordinalOf.has(key)) ordinalOf.set(key, counter++)
    pos[r] = frame.codonPos[r]
    aa[r] = c.aa
    parity[r] = ordinalOf.get(key) % 2
  }
  return { pos, parity, aa }
}

export { reverseComplement }
