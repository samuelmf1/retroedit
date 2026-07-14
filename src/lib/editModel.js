// The edited sequence is an array of records, one per displayed column:
//   { base: 'A', ref: <0-based reference index> | null, del?: true }
// `ref === null` marks an inserted base. `del === true` marks a *deleted*
// reference base — it stays in the display as a ghost so the alignment does not
// collapse, but it is excluded from the actual edited sequence and the donor.
// Substitutions keep their `ref` and change `base`. Every edit is therefore
// derived by comparing against the reference; there is no separate bookkeeping.

export function makeEdited(refSeq) {
  return Array.from(refSeq, (base, i) => ({ base, ref: i }))
}

/** The realised sequence: inserts included, ghosts (deletions) excluded. */
export function editedSeq(edited) {
  let s = ''
  for (const rec of edited) if (!rec.del) s += rec.base
  return s
}

export function baseStatus(rec, refSeq) {
  if (rec.del) return 'del'
  if (rec.ref == null) return 'ins'
  return refSeq[rec.ref] === rec.base ? 'ref' : 'mut'
}

export function hasEdits(refSeq, edited) {
  if (edited.length !== refSeq.length) return true
  for (let i = 0; i < edited.length; i++) {
    const rec = edited[i]
    if (rec.del || rec.ref !== i || rec.base !== refSeq[i]) return true
  }
  return false
}

/**
 * Reference indices touched by an edit: substituted bases, deleted (ghost)
 * bases, and the two bases flanking each insertion. This is the coordinate
 * space Cas9 sees, so it is what guide proximity is measured against.
 */
export function affectedRefIndices(refSeq, edited) {
  const affected = new Set()

  for (const rec of edited) {
    if (rec.ref == null) continue
    if (rec.del || refSeq[rec.ref] !== rec.base) affected.add(rec.ref)
  }
  // Insertions have no reference index of their own; charge them to the bases
  // on either side of the junction.
  for (let d = 0; d < edited.length; d++) {
    if (edited[d].ref != null) continue
    for (let l = d - 1; l >= 0; l--) {
      if (edited[l].ref != null) { affected.add(edited[l].ref); break }
    }
    for (let r = d + 1; r < edited.length; r++) {
      if (edited[r].ref != null) { affected.add(edited[r].ref); break }
    }
  }

  return [...affected].sort((a, b) => a - b)
}

/** The same idea in display coordinates — used when scanning the edited sequence. */
export function affectedDisplayIndices(refSeq, edited) {
  const affected = new Set()
  for (let d = 0; d < edited.length; d++) {
    const rec = edited[d]
    if (rec.del || rec.ref == null || refSeq[rec.ref] !== rec.base) affected.add(d)
  }
  return [...affected].sort((a, b) => a - b)
}

/**
 * Map reference indices onto display columns. Because deletions are kept as
 * ghosts, every reference base has its own column, so this is a direct lookup.
 */
export function buildRefToDisplay(refSeq, edited) {
  const dispStart = new Int32Array(refSeq.length).fill(-1)
  const dispEnd = new Int32Array(refSeq.length).fill(-1)
  for (let d = 0; d < edited.length; d++) {
    const r = edited[d].ref
    if (r != null) { dispStart[r] = d; dispEnd[r] = d }
  }
  // Fill any reference index without a column (defensive; normally none) by
  // snapping to the nearest neighbour.
  let next = Math.max(0, edited.length - 1)
  for (let i = refSeq.length - 1; i >= 0; i--) {
    if (dispStart[i] === -1) dispStart[i] = next
    else next = dispStart[i]
  }
  let prev = 0
  for (let i = 0; i < refSeq.length; i++) {
    if (dispEnd[i] === -1) dispEnd[i] = prev
    else prev = dispEnd[i]
  }
  return { dispStart, dispEnd }
}

/** Ghosted deletions never leave gaps, so there are no junctions to draw. */
export function deletionJunctions() {
  return new Set()
}

/** HGVS-style genomic descriptions of every edit, in display order. */
export function describeEdits(refSeq, edited, regionStart) {
  const pos = (refIdx) => regionStart + refIdx
  const out = []
  let i = 0

  while (i < edited.length) {
    const rec = edited[i]

    if (rec.del && rec.ref != null) {
      let j = i
      while (j < edited.length && edited[j].del && edited[j].ref != null) j++
      const s = rec.ref
      const e = edited[j - 1].ref
      out.push({
        type: 'del', refStart: s, refEnd: e, length: e - s + 1,
        label: s === e ? `g.${pos(s)}del${refSeq[s]}` : `g.${pos(s)}_${pos(e)}del`,
      })
      i = j
      continue
    }

    if (rec.ref == null) {
      let j = i
      let ins = ''
      while (j < edited.length && edited[j].ref == null) { ins += edited[j].base; j++ }
      let left = -1
      for (let k = i - 1; k >= 0; k--) if (edited[k].ref != null) { left = edited[k].ref; break }
      let right = refSeq.length
      for (let k = j; k < edited.length; k++) if (edited[k].ref != null) { right = edited[k].ref; break }
      const anchor = left < 0
        ? `g.${pos(0)}-1_${pos(0)}`
        : right >= refSeq.length
          ? `g.${pos(refSeq.length - 1)}_${pos(refSeq.length - 1)}+1`
          : `g.${pos(left)}_${pos(right)}`
      out.push({
        type: 'ins', refStart: Math.max(0, left), refEnd: Math.min(refSeq.length - 1, right),
        length: ins.length, label: `${anchor}ins${ins}`,
      })
      i = j
      continue
    }

    if (rec.ref != null && rec.base !== refSeq[rec.ref]) {
      out.push({
        type: 'sub', refStart: rec.ref, refEnd: rec.ref, length: 1,
        label: `g.${pos(rec.ref)}${refSeq[rec.ref]}>${rec.base}`,
      })
    }
    i++
  }

  return out
}

// ---- edit operations (pure; each returns a new array) ----

export function substitute(edited, index, base) {
  if (index < 0 || index >= edited.length) return edited
  const next = edited.slice()
  next[index] = { ...next[index], base, del: false }
  return next
}

export function insertAt(edited, index, str) {
  if (!str) return edited
  const next = edited.slice()
  next.splice(index, 0, ...[...str].map((base) => ({ base, ref: null })))
  return next
}

/**
 * Delete [start, end). Reference bases become ghosts (kept for display);
 * inserted bases, which never existed in the reference, are removed outright.
 */
export function deleteRange(edited, start, end) {
  if (end <= start) return edited
  const next = []
  for (let i = 0; i < edited.length; i++) {
    const rec = edited[i]
    if (i >= start && i < end) {
      if (rec.ref == null) continue // drop inserted bases
      next.push(rec.del ? rec : { ...rec, del: true })
    } else {
      next.push(rec)
    }
  }
  return next
}

/**
 * Replace [start, end) with `str`. A length-preserving replacement over
 * reference bases is recorded as substitutions (coordinates survive, no ghosts);
 * anything else is a ghosting delete followed by an insertion.
 */
export function replaceRange(edited, start, end, str) {
  if (str.length === end - start) {
    const next = edited.slice()
    for (let k = 0; k < str.length; k++) {
      next[start + k] = { ...next[start + k], base: str[k], del: false }
    }
    return next
  }
  return insertAt(deleteRange(edited, start, end), start, str)
}
