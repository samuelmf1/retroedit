// Region loading, provider-agnostic.

import { buildFrameMap } from './codon.js'
import { getGenome, getProvider, normalizeChrom, registerGenome } from './genomes.js'
import './providers/ensembl.js'
import './providers/static.js'

export { genomesByOrganism, getGenome, listGenomes, registerGenome } from './genomes.js'

const ENSEMBL = 'https://rest.ensembl.org'
const ENSEMBL_GRCH37 = 'https://grch37.rest.ensembl.org'

registerGenome({
  id: 'human-grch38', organism: 'Human', assembly: 'GRCh38',
  provider: 'ensembl', species: 'homo_sapiens', host: ENSEMBL,
})
registerGenome({
  id: 'human-grch37', organism: 'Human', assembly: 'GRCh37',
  provider: 'ensembl', species: 'homo_sapiens', host: ENSEMBL_GRCH37,
  note: 'hg19 coordinates',
})
registerGenome({
  id: 'mouse-grcm39', organism: 'Mouse', assembly: 'GRCm39',
  provider: 'ensembl', species: 'mus_musculus', host: ENSEMBL,
})

export const DEFAULT_GENOME_ID = 'human-grch38'

const REGION_RE = /^(?:chr)?([0-9]{1,2}|[XYxy]|MT|mt|M|m):([\d,_ ]+)(?:\s*(?:\.\.|-|–)\s*([\d,_ ]+))?$/
const clean = (n) => Number(String(n).replace(/[,_ ]/g, ''))

/** Padding around an explicitly requested span, so guides just outside it are still reachable. */
const FOCUS_PAD_BP = 200

/**
 * Turn "BRCA2", "ENSG00000139618", "13:32315717", or "chr13:32,315,717-32,315,767"
 * into a region to load plus the sub-span the user actually asked about.
 *
 * Coordinates are always read in the selected genome's build — there is no liftover.
 */
export async function resolveLocus(query, genome, windowBp) {
  const term = query.trim()
  if (!term) throw new Error('Enter a gene symbol or a chrom:position')

  const match = REGION_RE.exec(term)
  if (match) {
    const chrom = normalizeChrom(match[1])
    const a = clean(match[2])
    const b = match[3] != null ? clean(match[3]) : null
    if (!Number.isFinite(a) || (b != null && !Number.isFinite(b))) {
      throw new Error(`Could not parse coordinates in "${term}"`)
    }
    const focus = b != null
      ? { start: Math.min(a, b), end: Math.max(a, b) }
      : { start: a, end: a }

    const span = Math.max(windowBp, focus.end - focus.start + 1 + 2 * FOCUS_PAD_BP)
    const mid = Math.floor((focus.start + focus.end) / 2)
    const start = Math.max(1, mid - Math.floor(span / 2))
    return {
      chrom, start, end: start + span - 1, focus, gene: null,
      label: `${chrom}:${focus.start.toLocaleString()}` + (b != null ? `-${focus.end.toLocaleString()}` : ''),
    }
  }

  const provider = getProvider(genome.provider)
  const gene = await provider.lookupGene(genome, term)

  // Anchor the window on the transcription start site (strand-aware) so the 5'
  // end of the gene, where edits usually go, is in view. For a minus-strand
  // gene the TSS is at the higher coordinate.
  const tss = gene.strand === -1 ? gene.end : gene.start
  const start = gene.strand === -1
    ? Math.max(1, tss - windowBp + 100) // TSS near the right edge, gene body to the left
    : Math.max(1, tss - 100) // TSS near the left edge, gene body to the right
  const end = start + windowBp - 1
  return {
    chrom: gene.chrom, start, end,
    focus: { start: Math.max(start, tss - 20), end: Math.min(end, tss + 20) },
    gene,
    label: `${gene.name} (${gene.id})`,
  }
}

export async function loadRegion({ query, genomeId, windowBp }) {
  const genome = getGenome(genomeId)
  const provider = getProvider(genome.provider)
  const locus = await resolveLocus(query, genome, windowBp)

  const length = locus.end - locus.start + 1
  if (length > genome.maxRegionBp) {
    throw new Error(
      `Region is ${length.toLocaleString()} bp; ${genome.label} caps at ${genome.maxRegionBp.toLocaleString()} bp.`,
    )
  }

  const empty = { genes: [], transcripts: [], exons: [], coding: [] }
  const { seq } = await provider.fetchSequence(genome, locus.chrom, locus.start, locus.end)

  if (seq.length !== length) {
    throw new Error(`Provider returned ${seq.length} bp for a ${length} bp region`)
  }


  return {
    reference: {
      genomeId, assembly: genome.assembly, organism: genome.organism,
      chrom: locus.chrom, start: locus.start, end: locus.end,
      seq: seq.toUpperCase(), label: locus.label, gene: locus.gene,
    },
    features: empty,
    frame: null,
    focus: locus.focus,
  }
}

export async function loadRegionAnnotations(region) {
  const { reference } = region
  const genome = getGenome(reference.genomeId)
  const provider = getProvider(genome.provider)
  const length = reference.end - reference.start + 1
  const empty = { genes: [], transcripts: [], exons: [], coding: [] }
  if (length > genome.maxFeatureBp) return { features: empty, frame: null }

  if (provider.fetchAnnotations) {
    try {
      const local = await provider.fetchAnnotations(
        genome, reference.chrom, reference.start, reference.end,
      )
      return {
        features: { ...empty, ...local.features, coding: local.coding ?? [] },
        frame: buildCodingFrame(
          local.coding, reference.start, length, reference.gene,
        ),
      }
    } catch { /* fall back for assemblies without local annotations */ }
  }

  const [rawFeatures, cds] = await Promise.all([
    provider.fetchFeatures(
      genome, reference.chrom, reference.start, reference.end,
    ).catch(() => empty),
    provider.fetchCoding
      ? provider.fetchCoding(
        genome, reference.chrom, reference.start, reference.end,
      ).catch(() => [])
      : Promise.resolve([]),
  ])
  return {
    features: { ...empty, ...rawFeatures, coding: cds },
    frame: buildCodingFrame(cds, reference.start, length, reference.gene),
  }
}


/**
 * Collapse overlapping CDS from many transcripts into a single reading frame.
 *
 * Ensembl's overlap query returns each transcript's *entire* CDS, so a transcript
 * can appear here with no segment actually inside the window. We therefore rank
 * by the coverage that falls *within* the window, prefer the searched gene's
 * canonical transcript only if it codes here, build the frame from that
 * transcript's full CDS (each segment carries its own phase), and return null
 * when no base in the window is coding.
 */
function buildCodingFrame(cds, refStart, refLen, gene) {
  if (!cds?.length) return null
  const winEnd = refStart + refLen - 1
  const overlaps = (s) => s.end >= refStart && s.start <= winEnd

  const inWindow = new Map() // transcript -> in-window coverage
  for (const s of cds) {
    if (!overlaps(s)) continue
    const cov = Math.min(s.end, winEnd) - Math.max(s.start, refStart) + 1
    inWindow.set(s.transcript, (inWindow.get(s.transcript) ?? 0) + cov)
  }
  if (!inWindow.size) return null

  const canonical = gene?.canonical?.split('.')[0]
  let chosen = canonical && inWindow.has(canonical) ? canonical : null
  if (!chosen) {
    let best = -1
    for (const [tx, cov] of inWindow) if (cov > best) { best = cov; chosen = tx }
  }

  const segs = cds.filter((s) => s.transcript === chosen)
  if (!segs.length) return null
  const frame = buildFrameMap(refStart, refLen, segs, segs[0].strand)
  frame.transcript = chosen
  for (const p of frame.codonPos) if (p >= 0) return frame
  return null
}
