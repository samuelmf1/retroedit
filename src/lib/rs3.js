// Client for the RS3 scoring service (see server/app.py).
//
// Scores are cached per (context, tracr) for the life of the page, so editing a
// base only costs a request for the guides that actually changed.

const cache = new Map()
const key = (context, tracr) => `${tracr}|${context}`

export function cachedScore(context, tracr) {
  return cache.get(key(context, tracr))
}

/**
 * Score `contexts`, fetching only the ones not already cached.
 * Resolves to `{ scores: Map<context, number|null>, available, detail }`.
 * A missing or broken service is not an error — it just means no scores.
 */
export async function scoreContexts(contexts, tracr, signal, serverCache = true) {
  const unique = [...new Set(contexts)]
  const scores = new Map()
  const missing = []

  for (const context of unique) {
    const k = key(context, tracr)
    if (cache.has(k)) scores.set(context, cache.get(k))
    else missing.push(context)
  }

  if (!missing.length) return { scores, available: true, detail: null }

  let payload
  try {
    const res = await fetch('/api/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contexts: missing, tracr, cache: serverCache }),
      signal,
    })
    if (!res.ok) throw new Error(`scoring service returned ${res.status}`)
    payload = await res.json()
  } catch (err) {
    if (err.name === 'AbortError') throw err
    return {
      scores,
      available: false,
      detail: 'RS3 service unreachable. Start it with `npm run dev:api`',
    }
  }

  payload.scores.forEach((score, i) => {
    const context = missing[i]
    const value = typeof score === 'number' ? score : null
    cache.set(key(context, tracr), value)
    scores.set(context, value)
  })

  return { scores, available: payload.available, detail: payload.detail ?? null }
}

export async function checkRs3Health() {
  try {
    const res = await fetch('/api/health')
    if (!res.ok) return { rs3: false, detail: `service returned ${res.status}` }
    return await res.json()
  } catch {
    return { rs3: false, detail: 'RS3 service not running' }
  }
}
