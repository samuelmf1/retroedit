// Client for the backend genomics service (gnomAD / ClinVar / off-targets).
// Everything degrades gracefully: if the backend or its reference files are
// absent, calls resolve to an unavailable/empty result and the UI hides them.

const CLIENT_CACHE_LIMIT = 512
const OFFTARGET_CLIENT_CACHE_LIMIT = 10_000
const spacerMatchCache = new Map()
const canonicalExonRequests = new Map()
const geneSuggestionCache = new Map()
const nearbyFeatureCache = new Map()
const variantCache = new Map()
let statusRequest = null
function setBounded(cache, key, value, limit = CLIENT_CACHE_LIMIT) {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > limit) cache.delete(cache.keys().next().value)
}

export function genomicsStatus() {
  if (!statusRequest) {
    statusRequest = fetch('/api/genomics/status')
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status))
        return res.json()
      })
      .catch(() => ({
        tabix: false, bowtie: false, gnomad: { available: false },
        clinvar: { available: {} }, offtarget: { assemblies: {} },
      }))
  }
  return statusRequest
}

export function fetchCanonicalExons({ assembly, gene }) {
  const key = `${assembly}|${gene}`
  if (!canonicalExonRequests.has(key)) {
    const params = new URLSearchParams({ assembly, query: gene })
    const request = fetch(`/api/genomics/gene-exons?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status))
        return res.json()
      })
      .catch(() => null)
    setBounded(canonicalExonRequests, key, request)
  }
  return canonicalExonRequests.get(key)
}

export async function fetchGeneSuggestions({ assembly, query, limit = 8 }, signal) {
  const term = query.trim()
  const key = `${assembly}|${term.toUpperCase()}|${limit}`
  if (geneSuggestionCache.has(key)) {
    const cached = geneSuggestionCache.get(key)
    setBounded(geneSuggestionCache, key, cached)
    return cached
  }
  try {
    const params = new URLSearchParams({ assembly, query: term, limit: String(limit) })
    const response = await fetch(`/api/genomics/gene-suggestions?${params}`, { signal })
    if (!response.ok) return []
    const suggestions = (await response.json()).suggestions ?? []
    setBounded(geneSuggestionCache, key, suggestions)
    return suggestions
  } catch (error) {
    if (error.name === 'AbortError') throw error
    return []
  }
}
export async function fetchNearbyFeatures({ assembly, chrom, start, end }, signal) {
  const key = `${assembly}|${chrom}|${start}|${end}`
  if (nearbyFeatureCache.has(key)) {
    const cached = nearbyFeatureCache.get(key)
    setBounded(nearbyFeatureCache, key, cached)
    return cached
  }
  try {
    const params = new URLSearchParams({
      assembly, chrom: String(chrom), start: String(start), end: String(end),
    })
    const response = await fetch(`/api/genomics/annotations?${params}`, { signal })
    if (!response.ok) throw new Error(String(response.status))
    const features = (await response.json()).features

    const exonsByTranscript = new Map()
    features.exons.forEach((exon) => {
      const list = exonsByTranscript.get(exon.transcript) ?? []
      list.push(exon)
      exonsByTranscript.set(exon.transcript, list)
    })
    const transcriptsByGene = new Map()
    features.transcripts.forEach((transcript) => {
      const list = transcriptsByGene.get(transcript.gene) ?? []
      list.push(transcript)
      transcriptsByGene.set(transcript.gene, list)
    })

    const result = features.genes.map((gene) => {
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
    setBounded(nearbyFeatureCache, key, result)
    return result
  } catch (err) {
    if (err.name === 'AbortError') throw err
    return []
  }
}

export async function fetchVariants({ source, assembly, chrom, start, end }, signal) {
  const key = `${source}|${assembly}|${chrom}|${start}|${end}`
  if (variantCache.has(key)) {
    const payload = variantCache.get(key)
    setBounded(variantCache, key, payload)
    return payload
  }
  try {
    const params = new URLSearchParams({ source, assembly, chrom: String(chrom), start: String(start), end: String(end) })
    const res = await fetch(`/api/genomics/variants?${params}`, { signal })
    if (!res.ok) throw new Error(String(res.status))
    const payload = await res.json()
    if (payload.available) setBounded(variantCache, key, payload)
    return payload
  } catch (err) {
    if (err.name === 'AbortError') throw err
    return { available: false, variants: [] }
  }
}

const OFFTARGET_BUSY_RETRIES = 6
const OFFTARGET_BATCH_SIZE = 100
const offTargetCache = new Map()
const advancedOffTargetCache = new Map()

const offTargetCacheKey = (assembly, pam, guide) => [
  assembly,
  pam.toUpperCase(),
  guide.spacer.toUpperCase(),
  String(guide.chrom ?? '').replace(/^chr/i, ''),
  guide.cutGenomic ?? '',
].join('|')

// Reuse completed Bowtie results for the life of the page. The genomic cut site
// keeps identical spacers at different loci distinct, while the current guide
// ID is restored when a cached result is read into a newly derived guide set.
export function cachedOffTargets({ assembly, pam, guides }) {
  const byGuide = {}
  const missing = []
  for (const guide of guides) {
    const cached = offTargetCache.get(offTargetCacheKey(assembly, pam, guide))
    if (cached) byGuide[guide.id] = { ...cached, id: guide.id }
    else missing.push(guide)
  }
  return { byGuide, missing }
}

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

export async function fetchSpacerMatches({ assembly, spacer, pam }, signal) {
  const normalized = spacer.trim().toUpperCase()
  const key = `${assembly}|${pam.toUpperCase()}|${normalized}`
  if (spacerMatchCache.has(key)) {
    const payload = spacerMatchCache.get(key)
    setBounded(spacerMatchCache, key, payload)
    return payload
  }
  for (let attempt = 0; attempt <= OFFTARGET_BUSY_RETRIES; attempt += 1) {
    const response = await fetch('/api/genomics/spacer-matches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assembly, spacer: normalized, pam }),
      signal,
    })
    if (response.status === 429 && attempt < OFFTARGET_BUSY_RETRIES) {
      const retryAfter = Number(response.headers.get('Retry-After') ?? 5)
      await abortableDelay(Math.max(1, retryAfter) * 1000, signal)
      continue
    }
    if (!response.ok) {
      let detail = `spacer search returned ${response.status}`
      try { detail = (await response.json())?.detail ?? detail } catch { /* non-JSON response */ }
      throw new Error(detail)
    }
    const payload = await response.json()
    if (payload.available) setBounded(spacerMatchCache, key, payload)
    return payload
  }
  return { available: false, matches: [], detail: 'genome search remained busy' }
}
async function fetchOffTargetBatch({ assembly, pam, guides }, signal) {
  for (let attempt = 0; attempt <= OFFTARGET_BUSY_RETRIES; attempt += 1) {
    const response = await fetch('/api/genomics/offtargets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assembly, pam, guides }),
      signal,
    })
    if (response.status === 429 && attempt < OFFTARGET_BUSY_RETRIES) {
      const retryAfter = Number(response.headers.get('Retry-After') ?? 5)
      await abortableDelay(Math.max(1, retryAfter) * 1000, signal)
      continue
    }
    if (!response.ok) {
      let detail = `off-target service returned ${response.status}`
      try { detail = (await response.json())?.detail ?? detail } catch { /* non-JSON response */ }
      return { available: false, guides: [], detail, status: response.status }
    }
    return response.json()
  }
  return { available: false, guides: [], detail: 'off-target service remained busy' }
}

export async function fetchOffTargets({ assembly, pam, guides }, signal, onProgress) {
  const cached = cachedOffTargets({ assembly, pam, guides })
  if (!cached.missing.length) {
    return { available: true, guides: Object.values(cached.byGuide), pendingIds: [], detail: null }
  }

  try {
    for (let offset = 0; offset < cached.missing.length; offset += OFFTARGET_BATCH_SIZE) {
      const batch = cached.missing.slice(offset, offset + OFFTARGET_BATCH_SIZE)
      const payload = await fetchOffTargetBatch({ assembly, pam, guides: batch }, signal)
      if (payload.available) {
        const requestsById = new Map(batch.map((guide) => [guide.id, guide]))
        for (const result of payload.guides) {
          const guide = requestsById.get(result.id)
          if (!guide) continue
          const stored = { ...result }
          delete stored.id
          setBounded(offTargetCache, offTargetCacheKey(assembly, pam, guide), stored, OFFTARGET_CLIENT_CACHE_LIMIT)
          cached.byGuide[guide.id] = { ...stored, id: guide.id }
        }
      }
      const pendingIds = cached.missing.slice(offset + batch.length).map((guide) => guide.id)
      const progress = {
        available: payload.available || Object.keys(cached.byGuide).length > 0,
        guides: Object.values(cached.byGuide),
        pendingIds,
      }
      onProgress?.(progress)
      if (!payload.available) return { ...payload, ...progress, pendingIds: [] }
    }
    return { available: true, guides: Object.values(cached.byGuide), pendingIds: [], detail: null }
  } catch (error) {
    if (error.name === 'AbortError') throw error
    return {
      available: Object.keys(cached.byGuide).length > 0,
      guides: Object.values(cached.byGuide),
      pendingIds: [],
      detail: String(error),
    }
  }
}

export async function fetchAdvancedOffTargets({ assembly, pam, guide }, signal) {
  const key = offTargetCacheKey(assembly, pam, guide)
  if (advancedOffTargetCache.has(key)) {
    const payload = advancedOffTargetCache.get(key)
    setBounded(advancedOffTargetCache, key, payload, 256)
    return payload
  }
  for (let attempt = 0; attempt <= OFFTARGET_BUSY_RETRIES; attempt += 1) {
    const response = await fetch('/api/genomics/offtargets-advanced', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assembly, pam, guide }),
      signal,
    })
    if (response.status === 429 && attempt < OFFTARGET_BUSY_RETRIES) {
      const retryAfter = Number(response.headers.get('Retry-After') ?? 5)
      await abortableDelay(Math.max(1, retryAfter) * 1000, signal)
      continue
    }
    if (!response.ok) {
      let detail = `advanced off-target search returned ${response.status}`
      try { detail = (await response.json())?.detail ?? detail } catch { /* non-JSON response */ }
      throw new Error(detail)
    }
    const payload = await response.json()
    if (payload.available) setBounded(advancedOffTargetCache, key, payload, 256)
    return payload
  }
  return { available: false, detail: 'advanced off-target search remained busy' }
}
