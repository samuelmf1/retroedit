// HDR donor (ssODN) design.
//
// A donor converts the *reference* allele into the edited allele via homology-
// directed repair. It carries the user's edit plus, when the edit doesn't
// already destroy the guide, blocking mutations so Cas9 cannot re-cut the
// repaired allele. Blocking mutations are made synonymous whenever the target
// sits in a coding exon.
//
// All coordinates here are reference indices (0-based into `refSeq`); the guide
// cuts the reference, so this is the natural frame for the donor.

import { complementBase, reverseComplement } from './bio.js'
import { codonAt, synonymousCodons, translate } from './codon.js'
import { buildRefToDisplay } from './editModel.js'

export const DEFAULT_ARM_LEN = 75

/** Candidate guide positions, ordered by blocking strength. */
function blockingCandidates(guide, pam) {
  const out = []

  // Fixed PAM bases are the strongest blocking sites. On the '-' strand the
  // PAM pattern maps to the reverse-complemented genomic interval.
  const fixed = [...pam].map((c, j) => ({ c, j })).filter(({ c }) => 'ACGT'.includes(c))
  for (const { c, j } of fixed) {
    const refIdx = guide.strand === '+' ? guide.pamStart + j : guide.pamEnd - j
    out.push({ key: `pam:${refIdx}`, refIdx, kind: 'pam', priority: 0, label: `PAM base ${j + 1}`, pamBase: c })
  }

  // Seed sites follow from the PAM-proximal edge outward.
  const seedLen = guide.seedEnd - guide.seedStart + 1
  for (let k = 0; k < seedLen; k++) {
    const refIdx = guide.strand === '+' ? guide.seedEnd - k : guide.seedStart + k
    out.push({
      refIdx,
      key: `seed:${refIdx}`,
      kind: 'seed',
      priority: k + 1,
      label: k === 0 ? 'seed base 1 (PAM-proximal)' : `seed base ${k + 1}`,
    })
  }
  return out
}

/** Choose the safest available PAM or PAM-proximal seed substitution. */
function designBlockingMutations({ refSeq, guide, pam, frame, forbidden, choiceKey = null }) {
  if (guide.disruptsPam || guide.disruptsSeed) {
    return {
      subs: [], broke: true, silent: true, effect: 'edit',
      reason: 'edit already disrupts the guide', selectedSite: null, alternatives: [],
      options: [], selectedKey: null, recommendedKey: null, manual: false,
    }
  }

  const tag = (changes, kind) => changes.map((change) => ({ ...change, kind }))

  // Pick a direct base change while avoiding a new stop codon and, for a PAM G,
  // avoiding guide-oriented A (which can leave a weak NAG PAM).
  const directChange = (candidate) => {
    const { refIdx, kind } = candidate
    const from = refSeq[refIdx]
    const codon = frame ? codonAt(frame, refSeq, refIdx) : null
    const pos = codon?.refIdx.indexOf(refIdx) ?? -1
    const options = ['A', 'C', 'T', 'G'].filter((to) => to !== from).map((to, order) => {
      let aaTo = null
      if (codon && pos >= 0) {
        const alt = codon.codon.split('')
        alt[pos] = frame.strand === 1 ? to : complementBase(to)
        aaTo = translate(alt.join(''))
      }
      const guideBase = guide.strand === '+' ? to : complementBase(to)
      return {
        to,
        aaTo,
        order,
        weakPam: kind === 'pam' && candidate.pamBase === 'G' && guideBase === 'A',
        stopGain: codon?.aa !== '*' && aaTo === '*',
      }
    }).sort((a, b) =>
      Number(a.stopGain) - Number(b.stopGain) ||
      Number(a.weakPam) - Number(b.weakPam) ||
      a.order - b.order
    )
    const best = options[0]
    return [{
      refIdx,
      from,
      to: best.to,
      synonymous: false,
      proteinNeutral: !codon,
      aaFrom: codon?.aa ?? null,
      aaTo: best.aaTo,
    }]
  }

  // Evaluate every synonymous codon, not just the first one. A plan is only
  // valid when all bases needed to create that codon avoid the user's edit.
  const evaluate = (candidate) => {
    if (forbidden.has(candidate.refIdx)) {
      return { candidate, status: 'blocked', changes: [], reason: 'overlaps the requested edit' }
    }
    const codon = frame ? codonAt(frame, refSeq, candidate.refIdx) : null
    if (!codon) {
      return {
        candidate,
        status: 'noncoding',
        changes: tag(directChange(candidate), candidate.kind),
        reason: 'outside the canonical CDS; no amino-acid change',
      }
    }

    const pos = codon.refIdx.indexOf(candidate.refIdx)
    const targetSynonyms = synonymousCodons(codon.codon).filter((alt) => alt[pos] !== codon.codon[pos])
    const plans = targetSynonyms.map((alt) => {
      const changes = []
      for (let p = 0; p < 3; p++) {
        if (alt[p] === codon.codon[p]) continue
        const refIdx = codon.refIdx[p]
        const to = frame.strand === 1 ? alt[p] : complementBase(alt[p])
        changes.push({ refIdx, from: refSeq[refIdx], to, synonymous: true, aaFrom: codon.aa, aaTo: codon.aa })
      }
      return changes.some((change) => forbidden.has(change.refIdx)) ? null : changes
    }).filter(Boolean).sort((a, b) => a.length - b.length)

    if (plans.length) {
      return {
        candidate,
        status: 'synonymous',
        changes: tag(plans[0], candidate.kind),
        reason: 'synonymous codon available',
      }
    }

    const fallback = tag(directChange(candidate), candidate.kind)
    const consequence = fallback[0].aaTo === '*'
      ? 'best direct change would introduce a stop codon'
      : `best direct change would change ${fallback[0].aaFrom} to ${fallback[0].aaTo}`
    const reason = targetSynonyms.length
      ? `synonymous codon alternatives overlap the requested edit; ${consequence}`
      : `no synonymous codon changes this base; ${consequence}`
    return { candidate, status: 'nonsyn', changes: fallback, reason }
  }

  const evaluations = blockingCandidates(guide, pam).map(evaluate)
  const safe = evaluations
    .filter((entry) => entry.status === 'synonymous' || entry.status === 'noncoding')
    .sort((a, b) => a.candidate.priority - b.candidate.priority || a.changes.length - b.changes.length)

  let recommended = safe[0]
  if (!recommended) {
    recommended = evaluations
      .filter((entry) => entry.status === 'nonsyn')
      .sort((a, b) => {
        const aStop = a.changes.some((change) => change.aaFrom !== '*' && change.aaTo === '*')
        const bStop = b.changes.some((change) => change.aaFrom !== '*' && change.aaTo === '*')
        return Number(aStop) - Number(bStop) || a.candidate.priority - b.candidate.priority
      })[0]
  }

  const options = evaluations.map(({ candidate, status, changes, reason }) => ({
    ...candidate,
    status,
    changes,
    reason,
    selectable: status !== 'blocked',
  }))
  const requested = choiceKey
    ? evaluations.find((entry) => entry.candidate.key === choiceKey && entry.status !== 'blocked')
    : null
  const chosen = requested ?? recommended

  if (!chosen) {
    return {
      subs: [], broke: false, silent: false, effect: 'none', reason: 'could not block guide',
      selectedSite: null,
      alternatives: evaluations.map(({ candidate, reason }) => ({ ...candidate, reason })),
      options, selectedKey: null, recommendedKey: null, manual: false,
    }
  }

  const silent = chosen.status !== 'nonsyn'
  const site = chosen.candidate.kind === 'pam' ? 'PAM' : chosen.candidate.label
  const effect = chosen.status === 'synonymous' ? 'silent'
    : chosen.status === 'noncoding' ? 'noncoding' : 'non-syn'
  const alternatives = evaluations
    .filter((entry) => entry.candidate.priority < chosen.candidate.priority)
    .map(({ candidate, reason }) => ({ ...candidate, reason }))

  return {
    subs: chosen.changes.sort((a, b) => a.refIdx - b.refIdx),
    broke: true,
    silent,
    effect: chosen.status,
    reason: `disrupts ${site} (${effect}${requested ? ', user-selected' : ''})`,
    selectedSite: chosen.candidate,
    alternatives,
    options,
    selectedKey: chosen.candidate.key,
    recommendedKey: recommended?.candidate.key ?? null,
    manual: !!requested,
  }
}

/** Determine the actual re-cut blocking strategy for one guide. */
export function planGuideBlock({ refSeq, guide, pam = 'NGG', frame = null, affected = [], blockingChoice = null }) {
  return designBlockingMutations({
    refSeq,
    guide,
    pam,
    frame,
    forbidden: new Set(affected),
    choiceKey: blockingChoice,
  })
}

/**
 * Design an HDR donor for `guide` given the user's edits.
 *
 * @returns {object} donor with sense/ssODN sequences, arm layout, an annotated
 *   base track for drawing, the blocking-mutation list, and any warnings.
 */
export function designDonor({
  refSeq,
  refStart,
  edited,
  affected, // ref indices touched by the edit
  guide,
  pam = 'NGG',
  frame = null,
  armLeft = DEFAULT_ARM_LEN,
  armRight = DEFAULT_ARM_LEN,
  orientation = 'auto', // 'auto' | 'sense' | 'antisense'
  blockingChoice = null,
}) {
  const warnings = []
  const cut = guide.cutBefore // ref index; cut sits between cut-1 and cut
  let winStart = cut - armLeft
  let winEnd = cut + armRight - 1

  // Each arm must reach past the edit on its side (validation bound).
  const editMin = affected.length ? Math.min(...affected) : cut
  const editMax = affected.length ? Math.max(...affected) : cut - 1
  const needLeft = Math.max(cut - editMin, 1)
  const needRight = Math.max(editMax - cut + 1, 1)
  if (editMin < winStart) {
    return {
      ok: false,
      error: `Left arm is too short. The edit needs at least ${needLeft} bp on the left of the cut.`,
      needLeft, needRight,
    }
  }
  if (editMax > winEnd) {
    return {
      ok: false,
      error: `Right arm is too short. The edit needs at least ${needRight} bp on the right of the cut.`,
      needLeft, needRight,
    }
  }

  if (winStart < 0 || winEnd >= refSeq.length) {
    warnings.push('Homology arm runs past the loaded region; the arm on that side is truncated.')
    winStart = Math.max(0, winStart)
    winEnd = Math.min(refSeq.length - 1, winEnd)
  }

  const block = designBlockingMutations({
    refSeq, guide, pam, frame, forbidden: new Set(affected), choiceKey: blockingChoice,
  })
  if (!block.broke) {
    warnings.push('Could not find a mutation to block re-cutting; the donor may be re-cleaved.')
  } else if (!block.silent) {
    warnings.push('No synonymous PAM or seed substitution was available; the selected fallback changes the protein.')
  }
  const blockByRef = new Map(block.subs.map((s) => [s.refIdx, s]))

  // Build the donor over the reference window in sense orientation. Editing
  // coordinates come from the edited array (so indels are included); blocking
  // mutations are layered on top by reference index.
  const { dispStart, dispEnd } = buildRefToDisplay(refSeq, edited)
  const from = dispStart[winStart]
  const to = dispEnd[winEnd]
  const track = []
  for (let d = from; d <= to; d++) {
    const rec = edited[d]
    const r = rec.ref
    if (rec.del) {
      // Ghost of a deleted base: shown for alignment, absent from the ssODN.
      track.push({ base: rec.base, ref: r, role: 'del' })
      continue
    }
    let base = rec.base
    let role = r == null ? 'ins' : refSeq[r] === base ? 'arm' : 'edit'
    if (r != null && blockByRef.has(r)) {
      base = blockByRef.get(r).to
      role = 'block'
    }
    track.push({ base, ref: r, role })
  }
  // Deleted bases fuse out: the ssODN is the non-ghost track.
  const senseSeq = track.filter((t) => t.role !== 'del').map((t) => t.base).join('')

  // Cut offset within the *ssODN* (ghosts excluded), for the arm split.
  let cutOffset = 0
  for (const t of track) {
    if (t.ref != null && t.ref >= cut) break
    if (t.role !== 'del') cutOffset++
  }

  const useAntisense = orientation === 'antisense' || (orientation === 'auto' && guide.strand === '+')
  const ssodn = useAntisense ? reverseComplement(senseSeq) : senseSeq

  // Silence proof: translate the reference vs donor across any codons the
  // blocking mutations touch, restricted to the coding window.
  let proof = null
  if (frame && block.subs.some((s) => s.synonymous)) {
    proof = silenceProof(refSeq, frame, block.subs, winStart, winEnd)
  }

  return {
    ok: true,
    guideId: guide.id,
    strand: guide.strand,
    armLeft,
    armRight,
    winStart,
    winEnd,
    cut,
    cutGenomic: refStart + cut,
    orientation: useAntisense ? 'antisense' : 'sense',
    senseSeq,
    ssodn,
    length: ssodn.length,
    cutOffset,
    leftArm: senseSeq.slice(0, cutOffset),
    rightArm: senseSeq.slice(cutOffset),
    track,
    blocking: block,
    proof,
    warnings,
    editSpan: { start: refStart + editMin, end: refStart + editMax },
  }
}

/** Reference vs donor protein over the codons touched by silent blocking subs. */
function silenceProof(refSeq, frame, subs, winStart, winEnd) {
  const positions = new Set()
  for (const s of subs) {
    if (!s.synonymous) continue
    const codon = codonAt(frame, refSeq, s.refIdx)
    if (codon) codon.refIdx.forEach((r) => positions.add(r))
  }
  if (!positions.size) return null
  const lo = Math.max(winStart, Math.min(...positions))
  const hi = Math.min(winEnd, Math.max(...positions))

  const donor = refSeq.split('')
  for (const s of subs) donor[s.refIdx] = s.to

  // Read each strand in coding orientation over [lo, hi], snapped to codons.
  const strand = frame.strand
  const readCodons = (arr) => {
    const idx = []
    for (let r = lo; r <= hi; r++) if (frame.codonPos[r] >= 0) idx.push(r)
    if (strand === -1) idx.reverse()
    let dna = ''
    for (const r of idx) dna += strand === 1 ? arr[r] : complementBase(arr[r])
    const offset = frame.codonPos[idx[0]]
    return dna.slice(offset ? 3 - offset : 0)
  }
  return {
    ref: translate(readCodons(refSeq.split(''))),
    donor: translate(readCodons(donor)),
  }
}
