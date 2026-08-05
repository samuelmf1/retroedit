import { IUPAC_SETS, reverseComplement, reverseComplementPattern } from '../lib/bio.js'

const MAX_MM = 3
const SEED_SIZE = 5
const HIT_LIMIT = 100
let records = []
let queue = Promise.resolve()
const cancelled = new Set()
const cache = new Map()

const BASE_BITS = { A: 1, C: 2, G: 4, T: 8 }
const patternMasks = (pattern) => [...pattern].map((code) => {
  let mask = 0
  for (const base of IUPAC_SETS[code] ?? '') mask |= BASE_BITS[base]
  return mask
})

const pamMatches = (sequence, start, masks) => {
  if (start < 0 || start + masks.length > sequence.length) return false
  for (let i = 0; i < masks.length; i += 1) {
    if (!(masks[i] & (BASE_BITS[sequence[start + i]] ?? 0))) return false
  }
  return true
}

const encodeSeed = (sequence, start) => {
  let encoded = 0
  for (let i = 0; i < SEED_SIZE; i += 1) {
    const bits = BASE_BITS[sequence[start + i]]
    if (!bits) return -1
    encoded = (encoded << 2) | (bits === 1 ? 0 : bits === 2 ? 1 : bits === 4 ? 2 : 3)
  }
  return encoded
}

const distance = (a, b) => {
  let mismatches = 0
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i] && ++mismatches > MAX_MM) return mismatches
  }
  return mismatches
}

const scan = async ({ requestId, pam, guides }) => {
  const normalizedPam = pam.toUpperCase()
  const reversePam = reverseComplementPattern(normalizedPam)
  const forwardPamMasks = patternMasks(normalizedPam)
  const reversePamMasks = patternMasks(reversePam)
  const uniqueSpacers = [...new Set(guides.map((guide) => guide.spacer.toUpperCase()))]
  const missing = uniqueSpacers.filter((spacer) => !cache.has(`${normalizedPam}|${spacer}`))
  const seedIndex = new Map()
  missing.forEach((spacer, guideIndex) => {
    for (let offset = 0; offset < spacer.length; offset += SEED_SIZE) {
      const key = (offset / SEED_SIZE) * 1024 + encodeSeed(spacer, offset)
      const list = seedIndex.get(key) ?? []
      list.push(guideIndex)
      seedIndex.set(key, list)
    }
  })
  const counts = missing.map(() => [0, 0, 0, 0])
  const hits = missing.map(() => [])
  const seen = new Int32Array(missing.length)
  let stamp = 0
  const total = records.reduce((sum, record) => sum + record.seq.length, 0)
  let completed = 0
  let nextYield = 250_000

  const consider = (spacer, record, protoStart, strand, pamSeq) => {
    stamp += 1
    for (let offset = 0; offset < 20; offset += SEED_SIZE) {
      const encoded = encodeSeed(spacer, offset)
      if (encoded < 0) return
      const candidates = seedIndex.get((offset / SEED_SIZE) * 1024 + encoded)
      if (!candidates) continue
      for (const guideIndex of candidates) {
        if (seen[guideIndex] === stamp) continue
        seen[guideIndex] = stamp
        const mm = distance(missing[guideIndex], spacer)
        if (mm > MAX_MM) continue
        counts[guideIndex][mm] += 1
        if (hits[guideIndex].length < HIT_LIMIT) {
          hits[guideIndex].push({ chrom: record.name, pos: protoStart + 1, strand, mm, pam: pamSeq })
        }
      }
    }
  }

  if (missing.length) {
  for (const record of records) {
    const sequence = record.seq
    for (let pamStart = 0; pamStart <= sequence.length - normalizedPam.length; pamStart += 1) {
      if (cancelled.has(requestId)) throw new DOMException('Cancelled', 'AbortError')
      if (pamStart >= 20 && pamMatches(sequence, pamStart, forwardPamMasks)) {
        consider(sequence.slice(pamStart - 20, pamStart), record, pamStart - 20, '+', sequence.slice(pamStart, pamStart + normalizedPam.length))
      }
      const reverseProtoStart = pamStart + normalizedPam.length
      if (reverseProtoStart + 20 <= sequence.length && pamMatches(sequence, pamStart, reversePamMasks)) {
        consider(reverseComplement(sequence.slice(reverseProtoStart, reverseProtoStart + 20)), record, reverseProtoStart, '-', reverseComplement(sequence.slice(pamStart, pamStart + normalizedPam.length)))
      }
      if (completed + pamStart >= nextYield) {
        self.postMessage({ type: 'progress', requestId, completed: completed + pamStart, total })
        nextYield += 250_000
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
    completed += sequence.length
    self.postMessage({ type: 'progress', requestId, completed, total })
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  missing.forEach((spacer, index) => {
    cache.set(`${normalizedPam}|${spacer}`, { counts: counts[index], hits: hits[index] })
  })
  }

  const results = guides.map((guide) => {
    const spacer = guide.spacer.toUpperCase()
    const stored = cache.get(`${normalizedPam}|${spacer}`) ?? { counts: [0, 0, 0, 0], hits: [] }
    const countObject = Object.fromEntries(stored.counts.map((value, mm) => [String(mm), value]))
    const top = stored.hits
      .filter((hit) => !(hit.chrom === guide.chrom && hit.pos === guide.protoGenomic && hit.strand === guide.strand))
      .sort((a, b) => a.mm - b.mm)
      .slice(0, 20)
    return {
      id: guide.id,
      counts: countObject,
      unique: stored.counts[0] <= 1 && stored.counts.slice(1).every((value) => value === 0),
      top,
    }
  })
  self.postMessage({ type: 'result', requestId, result: { available: true, guides: results, pendingIds: [], detail: null } })
}

self.addEventListener('message', (event) => {
  const message = event.data
  if (message.type === 'init') {
    records = message.records
    cache.clear()
    cancelled.clear()
    self.postMessage({ type: 'ready' })
    return
  }
  if (message.type === 'cancel') {
    cancelled.add(message.requestId)
    return
  }
  if (message.type !== 'scan') return
  queue = queue.then(() => scan(message)).catch((error) => {
    if (error.name !== 'AbortError') {
      self.postMessage({ type: 'error', requestId: message.requestId, detail: error.message || String(error) })
    }
  }).finally(() => cancelled.delete(message.requestId))
})
