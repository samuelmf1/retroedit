// Ensembl REST provider. Open CORS, no API key. GRCh37 lives on its own host.

import { normalizeChrom, registerProvider } from '../genomes.js'

const ENSEMBL_ID_RE = /^ENS[A-Z]*G\d+/i
const JSON_CACHE_LIMIT = 256
const jsonCache = new Map()
const jsonInflight = new Map()

function cacheJson(url, payload) {
  jsonCache.delete(url)
  jsonCache.set(url, payload)
  while (jsonCache.size > JSON_CACHE_LIMIT) jsonCache.delete(jsonCache.keys().next().value)
}

async function getJson(url) {
  if (jsonCache.has(url)) {
    const payload = jsonCache.get(url)
    cacheJson(url, payload)
    return payload
  }
  if (jsonInflight.has(url)) return jsonInflight.get(url)

  const request = (async () => {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) {
      let detail = ''
      try { const payload = await res.json(); detail = payload?.error ?? payload?.detail ?? '' } catch { /* body was not json */ }
      throw new Error(detail || `Request returned ${res.status} ${res.statusText}`)
    }
    const payload = await res.json()
    cacheJson(url, payload)
    return payload
  })()
  jsonInflight.set(url, request)
  try {
    return await request
  } finally {
    jsonInflight.delete(url)
  }
}

export const ensemblProvider = registerProvider('ensembl', {
  async lookupGene(genome, term) {
    try {
      const local = await getJson(
        `/api/genomics/gene?assembly=${encodeURIComponent(genome.assembly)}` +
          `&query=${encodeURIComponent(term)}`,
      )
      return { ...local, chrom: normalizeChrom(local.chrom) }
    } catch { /* fall back to Ensembl when no local gene index is available */ }

    const url = ENSEMBL_ID_RE.test(term)
      ? `${genome.host}/lookup/id/${encodeURIComponent(term)}?content-type=application/json`
      : `${genome.host}/lookup/symbol/${genome.species}/${encodeURIComponent(term)}?content-type=application/json`

    const g = await getJson(url).catch((err) => {
      if (/404|not found/i.test(err.message)) throw new Error(`No gene "${term}" in ${genome.label}`)
      throw err
    })
    if (!g?.seq_region_name) throw new Error(`No gene "${term}" in ${genome.label}`)

    return {
      id: g.id,
      name: g.display_name ?? term.toUpperCase(),
      chrom: normalizeChrom(g.seq_region_name),
      start: g.start,
      end: g.end,
      strand: g.strand,
      canonical: g.canonical_transcript ?? null,
      description: g.description ?? '',
    }
  },

  async lookupVariant(genome, term) {
    const data = await getJson(
      `/api/genomics/variant-location?assembly=${encodeURIComponent(genome.assembly)}` +
        `&rsid=${encodeURIComponent(term.trim())}`,
    )
    return { ...data, chrom: normalizeChrom(data.chrom) }
  },

  async fetchSequence(genome, chrom, start, end) {
    try {
      const data = await getJson(
        `/api/genomics/sequence?assembly=${encodeURIComponent(genome.assembly)}` +
          `&chrom=${encodeURIComponent(chrom)}&start=${start}&end=${end}`,
      )
      return { seq: data.seq.toUpperCase() }
    } catch { /* fall back to Ensembl when no local FASTA is available */ }

    const data = await getJson(
      `${genome.host}/sequence/region/${genome.species}/${chrom}:${start}..${end}` +
        `?content-type=application/json`,
    )
    return { seq: data.seq.toUpperCase() }
  },

  async fetchAnnotations(genome, chrom, start, end) {
    return getJson(
      `/api/genomics/annotations?assembly=${encodeURIComponent(genome.assembly)}` +
        `&chrom=${encodeURIComponent(chrom)}&start=${start}&end=${end}`,
    )
  },

  async fetchFeatures(genome, chrom, start, end) {
    const raw = await getJson(
      `${genome.host}/overlap/region/${genome.species}/${chrom}:${start}-${end}` +
        `?feature=gene;feature=transcript;feature=exon;content-type=application/json`,
    )

    // Return genes, transcripts, and exons with biotype / source / IDs. The front
    // end decides which levels and biotypes to draw; genome.js keeps a legacy
    // flat list too, for the coding-frame transcript pick.
    const genes = []
    const transcripts = []
    const exons = []
    for (const f of raw) {
      if (f.feature_type === 'gene') {
        genes.push({
          id: f.id, level: 'gene', name: f.external_name || f.id,
          biotype: f.biotype, source: f.source, description: f.description ?? '',
          start: f.start, end: f.end, strand: f.strand,
        })
      } else if (f.feature_type === 'transcript') {
        transcripts.push({
          id: f.id, level: 'transcript', name: f.external_name || f.id,
          biotype: f.biotype, source: f.source,
          gene: (f.Parent ?? '').split('.')[0],
          tsl: f.transcript_support_level ?? null,
          isCanonical: f.is_canonical === 1,
          start: f.start, end: f.end, strand: f.strand,
        })
      } else if (f.feature_type === 'exon') {
        exons.push({
          id: f.exon_id, level: 'exon',
          transcript: (f.Parent ?? '').split('.')[0],
          rank: f.rank ?? null,
          start: f.start, end: f.end, strand: f.strand,
        })
      }
    }
    return { genes, transcripts, exons }
  },

  async fetchCoding(genome, chrom, start, end) {
    const raw = await getJson(
      `${genome.host}/overlap/region/${genome.species}/${chrom}:${start}-${end}` +
        `?feature=cds;content-type=application/json`,
    )
    return raw.map((f) => ({
      transcript: f.Parent,
      start: f.start,
      end: f.end,
      strand: f.strand,
      phase: Number(f.phase) || 0,
    }))
  },
})
