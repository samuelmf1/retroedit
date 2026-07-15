// Client for the backend genomics service (gnomAD / ClinVar / off-targets).
// Everything degrades gracefully: if the backend or its reference files are
// absent, calls resolve to an unavailable/empty result and the UI hides them.

export async function genomicsStatus() {
  try {
    const res = await fetch('/api/genomics/status')
    if (!res.ok) throw new Error(String(res.status))
    return await res.json()
  } catch {
    return { tabix: false, bowtie: false, gnomad: { available: false }, clinvar: { available: {} }, offtarget: { assemblies: {} } }
  }
}

export async function fetchCanonicalExons({ assembly, gene }) {
  try {
    const params = new URLSearchParams({ assembly, query: gene })
    const res = await fetch(`/api/genomics/gene-exons?${params}`)
    if (!res.ok) throw new Error(String(res.status))
    return await res.json()
  } catch {
    return null
  }
}


export async function fetchNearbyFeatures({ assembly, chrom, start, end }, signal) {
  try {
    const midpoint = Math.floor((start + end) / 2)
    const ranges = [[start, midpoint], [midpoint + 1, end]].filter(([a, b]) => b >= a)
    const payloads = await Promise.all(ranges.map(async ([a, b]) => {
      const params = new URLSearchParams({
        assembly, chrom: String(chrom), start: String(a), end: String(b),
      })
      const res = await fetch(`/api/genomics/annotations?${params}`, { signal })
      if (!res.ok) throw new Error(String(res.status))
      return (await res.json()).features
    }))

    const genes = new Map()
    const transcripts = new Map()
    const exons = new Map()
    payloads.forEach((features) => {
      features.genes.forEach((gene) => genes.set(gene.id, gene))
      features.transcripts.forEach((transcript) => transcripts.set(transcript.id, transcript))
      features.exons.forEach((exon) => exons.set(`${exon.transcript}:${exon.start}:${exon.end}`, exon))
    })

    const exonsByTranscript = new Map()
    exons.forEach((exon) => {
      const list = exonsByTranscript.get(exon.transcript) ?? []
      list.push(exon)
      exonsByTranscript.set(exon.transcript, list)
    })
    const transcriptsByGene = new Map()
    transcripts.forEach((transcript) => {
      const list = transcriptsByGene.get(transcript.gene) ?? []
      list.push(transcript)
      transcriptsByGene.set(transcript.gene, list)
    })

    return [...genes.values()].map((gene) => {
      const candidates = transcriptsByGene.get(gene.id) ?? []
      const transcript = candidates.sort((a, b) => (
        Number(b.isCanonical) - Number(a.isCanonical) ||
        (b.end - b.start) - (a.end - a.start)
      ))[0]
      return {
        ...gene,
        exons: transcript ? (exonsByTranscript.get(transcript.id) ?? []) : [],
      }
    }).sort((a, b) => a.start - b.start || b.end - a.end)
  } catch (err) {
    if (err.name === 'AbortError') throw err
    return []
  }
}

export async function fetchVariants({ source, assembly, chrom, start, end }, signal) {
  try {
    const params = new URLSearchParams({ source, assembly, chrom: String(chrom), start: String(start), end: String(end) })
    const res = await fetch(`/api/genomics/variants?${params}`, { signal })
    if (!res.ok) throw new Error(String(res.status))
    return await res.json()
  } catch (err) {
    if (err.name === 'AbortError') throw err
    return { available: false, variants: [] }
  }
}

const OFFTARGET_BUSY_RETRIES = 6

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

export async function fetchOffTargets({ assembly, pam, guides }, signal) {
  try {
    for (let attempt = 0; attempt <= OFFTARGET_BUSY_RETRIES; attempt += 1) {
      const res = await fetch('/api/genomics/offtargets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assembly, pam, guides }),
        signal,
      })
      if (res.status === 429 && attempt < OFFTARGET_BUSY_RETRIES) {
        const retryAfter = Number(res.headers.get('Retry-After') ?? 5)
        await abortableDelay(Math.max(1, retryAfter) * 1000, signal)
        continue
      }
      if (!res.ok) {
        let detail = `off-target service returned ${res.status}`
        try { detail = (await res.json())?.detail ?? detail } catch { /* non-JSON response */ }
        return { available: false, guides: [], detail, status: res.status }
      }
      return await res.json()
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err
    return { available: false, guides: [], detail: String(err) }
  }
}
