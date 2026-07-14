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
