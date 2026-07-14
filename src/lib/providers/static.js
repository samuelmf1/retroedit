// In-memory provider: the genome definition carries its own sequence.
//
// Backs the offline demo, and is the shape a custom genome takes — register a
// genome with `provider: 'static'` and a `data` block holding the sequence,
// its origin coordinate, and any features.

import { normalizeChrom, registerProvider } from '../genomes.js'

export const staticProvider = registerProvider('static', {
  async lookupGene(genome, term) {
    const needle = term.toLowerCase()
    const gene = (genome.data.genes ?? []).find(
      (g) => g.name.toLowerCase() === needle || g.id?.toLowerCase() === needle,
    )
    if (!gene) throw new Error(`No gene "${term}" in ${genome.label}`)
    return { ...gene, chrom: normalizeChrom(gene.chrom ?? genome.data.chrom) }
  },

  async fetchSequence(genome, chrom, start, end) {
    const d = genome.data
    if (normalizeChrom(chrom) !== normalizeChrom(d.chrom)) {
      throw new Error(`${genome.label} only contains ${d.chrom}`)
    }
    if (start < d.start || end > d.end) {
      throw new Error(
        `${genome.label} only covers ${d.chrom}:${d.start.toLocaleString()}-${d.end.toLocaleString()}`,
      )
    }
    return { seq: d.seq.slice(start - d.start, end - d.start + 1) }
  },

  async fetchFeatures(genome, chrom, start, end) {
    const feats = (genome.data.features ?? []).filter((f) => f.start <= end && f.end >= start)
    return {
      genes: feats.filter((f) => (f.level ?? f.type) === 'gene'),
      transcripts: feats.filter((f) => (f.level ?? f.type) === 'transcript'),
      exons: feats.filter((f) => (f.level ?? f.type) === 'exon'),
    }
  },

  async fetchCoding(genome, chrom, start, end) {
    return (genome.data.cds ?? []).filter((f) => f.start <= end && f.end >= start)
  },
})
