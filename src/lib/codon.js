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

// Homo sapiens codon usage, expressed as occurrences per 1,000 codons.
// These values rank synonymous choices in the interactive amino-acid editor;
// edit distance remains useful context but does not drive the recommendation.
// Source: Kazusa Codon Usage Database, Homo sapiens coding sequences.
// prettier-ignore
export const HUMAN_CODON_USAGE_PER_THOUSAND = {
  TTT:17.6,TTC:20.3,TTA:7.7,TTG:12.9,CTT:13.2,CTC:19.6,CTA:7.2,CTG:39.6,
  ATT:16.0,ATC:20.8,ATA:7.5,ATG:22.0,GTT:11.0,GTC:14.5,GTA:7.1,GTG:28.1,
  TCT:15.2,TCC:17.7,TCA:12.2,TCG:4.4,CCT:17.5,CCC:19.8,CCA:16.9,CCG:6.9,
  ACT:13.1,ACC:18.9,ACA:15.1,ACG:6.1,GCT:18.4,GCC:27.7,GCA:15.8,GCG:7.4,
  TAT:12.2,TAC:15.3,TAA:1.0,TAG:0.8,CAT:10.9,CAC:15.1,CAA:12.3,CAG:34.2,
  AAT:17.0,AAC:19.1,AAA:24.4,AAG:31.9,GAT:21.8,GAC:25.1,GAA:29.0,GAG:39.6,
  TGT:10.6,TGC:12.6,TGA:1.6,TGG:13.2,CGT:4.5,CGC:10.4,CGA:6.2,CGG:11.4,
  AGT:12.1,AGC:19.5,AGA:12.2,AGG:12.0,GGT:10.8,GGC:22.2,GGA:16.5,GGG:16.5,
}

export function synonymousCodons(codon) {
  const aa = CODON_TABLE[codon]
  if (!aa) return []
  return SYNONYMS[aa].filter((c) => c !== codon)
}

/**
 * Return every codon for `aminoAcid`, ranked for expression in human cells.
 * Human usage frequency is the primary criterion. Edit distance is returned
 * for transparency and only breaks exact usage ties.
 */
export function codonsForAminoAcid(currentCodon, aminoAcid) {
  const current = String(currentCodon ?? '').toUpperCase()
  const aa = String(aminoAcid ?? '').toUpperCase()
  const codons = SYNONYMS[aa] ?? []
  if (current.length !== 3 || !codons.length) return []
  const highestUsage = Math.max(...codons.map((codon) => HUMAN_CODON_USAGE_PER_THOUSAND[codon] ?? 0))
  return codons.map((codon) => {
    const humanUsage = HUMAN_CODON_USAGE_PER_THOUSAND[codon] ?? 0
    return {
      codon,
      distance: [...codon].reduce((total, base, index) => total + Number(base !== current[index]), 0),
      humanUsage,
      relativeHumanUsage: highestUsage ? humanUsage / highestUsage : 0,
    }
  }).sort((a, b) =>
    b.humanUsage - a.humanUsage || a.distance - b.distance || a.codon.localeCompare(b.codon))
}

/**
 * Return only the lowest-edit codon(s). Retained for callers that need a strict
 * minimum while the interactive editor uses the complete ranked list above.
 */
export function nearestCodonsForAminoAcid(currentCodon, aminoAcid) {
  const ranked = codonsForAminoAcid(currentCodon, aminoAcid)
    .sort((a, b) => a.distance - b.distance || a.codon.localeCompare(b.codon))
  if (!ranked.length) return []
  return ranked.filter((item) => item.distance === ranked[0].distance)
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
  // Reference indices in transcript order. Unlike genomic adjacency, this
  // order remains continuous across exon junctions and lets a codon span an
  // intron without pretending that the intronic bases belong to the CDS.
  const transcriptRefs = []
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
      transcriptRefs.push(refIdx)
    }
  }

  // Link every visible coding base to the other two bases in its biological
  // codon. `codonPos` supplies the phase; `transcriptRefs` supplies adjacency
  // across introns. Incomplete codons clipped by the displayed window remain
  // unlinked until enough context is loaded.
  const codonRefs = new Array(refLen).fill(null)
  for (let t = 0; t < transcriptRefs.length; t++) {
    const refIdx = transcriptRefs[t]
    const first = t - codonPos[refIdx]
    if (first < 0 || first + 2 >= transcriptRefs.length) continue
    const refs = transcriptRefs.slice(first, first + 3)
    if (refs.some((r, p) => codonPos[r] !== p)) continue
    for (const r of refs) codonRefs[r] = refs
  }

  return { codonPos, codonRefs, strand }
}

/**
 * The codon covering ref index `i`: its three ref indices in transcript order,
 * the codon bases (already oriented to the coding strand), and the amino acid.
 * Returns null when any base of the codon falls outside `refSeq` or the CDS.
 */
export function codonAt(frame, refSeq, i) {
  const pos = frame.codonPos[i]
  if (pos < 0) return null
  const linked = frame.codonRefs?.[i]
  const step = frame.strand === 1 ? 1 : -1
  const first = i - step * pos // compatibility with older frame maps
  const idx = linked ?? [first, first + step, first + 2 * step]
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
  // Bit 1 marks a split on the genomic left edge; bit 2 marks one on the
  // genomic right edge. The renderer uses these as exon-junction continuations.
  const splitEdge = new Uint8Array(n)
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
    for (let p = 1; p < c.refIdx.length; p++) {
      const a = c.refIdx[p - 1]
      const b = c.refIdx[p]
      if (Math.abs(a - b) <= 1) continue
      const left = Math.min(a, b)
      const right = Math.max(a, b)
      splitEdge[left] |= 2
      splitEdge[right] |= 1
    }
  }
  return { pos, parity, aa, splitEdge }
}

export { reverseComplement }
