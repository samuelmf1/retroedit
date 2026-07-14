// Turn raw annotation features (genes / transcripts / exons) into display items
// according to the user's view options. Coordinates are mapped to display
// columns via the ref->display maps; the viewer lane-packs the result.

function groupBy(list, key) {
  const out = new Map()
  for (const item of list) {
    const k = item[key]
    if (!out.has(k)) out.set(k, [])
    out.get(k).push(item)
  }
  return out
}

/** Distinct biotypes present across genes + transcripts, for the filter UI. */
export function biotypesPresent(raw) {
  const set = new Set()
  for (const g of raw?.genes ?? []) if (g.biotype) set.add(g.biotype)
  for (const t of raw?.transcripts ?? []) if (t.biotype) set.add(t.biotype)
  return [...set].sort()
}

export function buildFeatureItems({ raw, opts, dispStart, dispEnd, refStart, refLen, gene }) {
  if (!raw) return []
  const levels = opts.featureLevels
  const biotypes = opts.biotypes // null => all; else Set of allowed
  const lastRef = refLen - 1
  const inWin = (f) => f.end >= refStart && f.start <= refStart + lastRef
  const toDS = (f) => ({
    ds: dispStart[Math.max(0, Math.min(lastRef, f.start - refStart))],
    de: dispEnd[Math.max(0, Math.min(lastRef, f.end - refStart))],
  })
  const passBiotype = (bt) => !biotypes || !bt || biotypes.has(bt)

  const items = []

  if (levels.gene) {
    for (const g of raw.genes) {
      if (!inWin(g) || !passBiotype(g.biotype)) continue
      items.push({
        ...g, ...toDS(g),
        primary: gene && g.id === gene.id,
      })
    }
  }

  if (levels.transcript) {
    const exonsByTx = groupBy(raw.exons ?? [], 'transcript')
    const codingByTx = groupBy(raw.coding ?? [], 'transcript')
    for (const t of raw.transcripts) {
      if (!inWin(t) || !passBiotype(t.biotype)) continue
      const exons = (exonsByTx.get(t.id) ?? [])
        .filter(inWin)
        .map((e) => ({ ...toDS(e), rank: e.rank }))
      const cds = (codingByTx.get(t.id) ?? [])
        .filter(inWin)
        .map((segment) => ({ ...toDS(segment), phase: segment.phase }))
      items.push({ ...t, ...toDS(t), exons, cds })
    }
  }

  return items.sort((a, b) => a.ds - b.ds || b.de - a.de)
}
