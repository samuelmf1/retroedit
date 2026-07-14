import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import Controls from './components/Controls.jsx'
import EditBar from './components/EditBar.jsx'
import FeatureRibbon from './components/FeatureRibbon.jsx'
import GuideTable from './components/GuideTable.jsx'
import DonorPanel from './components/DonorPanel.jsx'
import SequenceViewer from './components/SequenceViewer.jsx'
import {
  DEFAULT_PAM,
  DEFAULT_SPACER_LENGTH,
  DEFAULT_WINDOW_BP,
  TRACR_RNAS,
  compareGuides,
  findGuides,
  fullSgRna,
  rs3Compatible,
} from './lib/crispr.js'
import {
  affectedDisplayIndices,
  affectedRefIndices,
  buildRefToDisplay,
  deletionJunctions,
  deleteRange,
  describeEdits,
  hasEdits,
  insertAt,
  makeEdited,
  replaceRange,
} from './lib/editModel.js'
import { DEFAULT_ARM_LEN, designDonor, planGuideBlock } from './lib/hdr.js'
import { rs3Fill, rs3NeedsLightText } from './lib/color.js'
import { DEFAULT_GENOME_ID, loadRegion, loadRegionAnnotations } from './lib/genome.js'
import { cachedScore, checkRs3Health, scoreContexts } from './lib/rs3.js'
import { biotypesPresent, buildFeatureItems } from './lib/features.js'
import { CODON_TABLE, buildCodonTrack, codonAt } from './lib/codon.js'
import { complementBase } from './lib/bio.js'
import { fetchCanonicalExons, fetchOffTargets, fetchVariants, genomicsStatus } from './lib/genomics.js'

const DEFAULT_VIEW_OPTS = {
  featureLevels: { gene: true, transcript: false },
  biotypes: null, // null = all biotypes
  codons: true,
  gnomad: false,
  clinvar: false,
}
const MAF_WARN = 0.01 // polymorphism threshold that can impair a guide

const BASES = new Set(['A', 'C', 'G', 'T'])

export default function App() {
  const [genomeId, setGenomeId] = useState(DEFAULT_GENOME_ID)
  const [query, setQuery] = useState('BRCA2')
  const [loadedQuery, setLoadedQuery] = useState(null)
  const [windowBp, setWindowBp] = useState(600)
  const [pam, setPam] = useState(DEFAULT_PAM)
  const [tracrId, setTracrId] = useState('hsu2013')
  const spacerLength = DEFAULT_SPACER_LENGTH

  const [region, setRegion] = useState(null)
  const [edited, setEdited] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const [caret, setCaret] = useState(0)
  const [selection, setSelection] = useState(null)
  const [selectedGuideId, setSelectedGuideId] = useState(null)

  // Undo/redo stacks of the edited-sequence array.
  const [past, setPast] = useState([])
  const [future, setFuture] = useState([])

  // Homology arms are per-guide. `armDefault` applies to any guide that has not
  // been customised; `armMap` overrides it for specific guides.
  const [armDefault, setArmDefault] = useState({ left: DEFAULT_ARM_LEN, right: DEFAULT_ARM_LEN, strand: null })
  const [armMap, setArmMap] = useState({})
  const [blockChoiceMap, setBlockChoiceMap] = useState({})
  const [orientation, setOrientation] = useState('auto')

  const [scoreVersion, setScoreVersion] = useState(0)
  const [rs3Status, setRs3Status] = useState({ rs3: false, detail: 'checking' })

  const [checked, setChecked] = useState(() => new Set())
  const [sidebarWidth, setSidebarWidth] = useState(560)

  const [viewOpts, setViewOpts] = useState(DEFAULT_VIEW_OPTS)
  const [gStatus, setGStatus] = useState(null)
  const [variants, setVariants] = useState([]) // gnomAD + ClinVar for the region
  const [offTargets, setOffTargets] = useState({ available: false, byGuide: {} })
  const [exonNav, setExonNav] = useState(null)

  const viewerRef = useRef(null)
  const exonNavRequest = useRef(0)

  useEffect(() => { checkRs3Health().then(setRs3Status) }, [])
  useEffect(() => { genomicsStatus().then(setGStatus) }, [])

  const doLoad = useCallback(async (opts = {}) => {
    const gid = opts.genomeId ?? genomeId
    const q = opts.query ?? query
    setLoading(true)
    setError(null)
    try {
      const result = await loadRegion({ query: q, genomeId: gid, windowBp })
      if (!opts.preserveSearchQuery) setLoadedQuery(q.trim())
      if (opts.geneContext) result.reference.gene = opts.geneContext
      setRegion(result)
      setEdited(makeEdited(result.reference.seq))
      setPast([])
      setFuture([])
      setArmMap({})
      setBlockChoiceMap({})
      setSelection(null)
      setSelectedGuideId(null)
      const focusIdx = result.focus.start - result.reference.start
      setCaret(Math.max(0, Math.min(result.reference.seq.length, focusIdx)))
      requestAnimationFrame(() => viewerRef.current?.scrollToIndex(Math.max(0, focusIdx)))
      if (result.reference.gene && !opts.preserveExonNav) {
        const requestId = ++exonNavRequest.current
        fetchCanonicalExons({
          assembly: result.reference.assembly,
          gene: result.reference.gene.id,
        }).then((data) => {
          if (requestId !== exonNavRequest.current) return
          if (!data?.exons?.length) { setExonNav(null); return }
          const center = (result.reference.start + result.reference.end) / 2
          let index = 0
          let distance = Infinity
          data.exons.forEach((exon, i) => {
            const candidate = Math.abs((exon.start + exon.end) / 2 - center)
            if (candidate < distance) { distance = candidate; index = i }
          })
          setExonNav({ ...data, index })
        })
      } else if (!opts.preserveExonNav) {
        exonNavRequest.current += 1
        setExonNav(null)
      }
      loadRegionAnnotations(result).then((annotations) => {
        setRegion((current) => {
          const a = current?.reference
          const b = result.reference
          if (
            !a ||
            a.genomeId !== b.genomeId ||
            a.chrom !== b.chrom ||
            a.start !== b.start ||
            a.end !== b.end
          ) return current
          return { ...current, ...annotations }
        })
      }).catch(() => {})
      return result
    } catch (err) {
      setError(err.message)
      setRegion(null)
    } finally {
      setLoading(false)
    }
  }, [genomeId, query, windowBp])

  const snapToExon = useCallback(async (index) => {
    const nav = exonNav
    const exon = nav?.exons?.[index]
    if (!exon) return
    const geneContext = {
      ...nav.gene,
      canonical: nav.transcript.id,
    }
    const result = await doLoad({
      query: `${nav.chrom}:${exon.start}-${exon.end}`,
      preserveExonNav: true,
      preserveSearchQuery: true,
      geneContext,
    })
    if (!result) return
    setExonNav((current) => (
      current?.transcript?.id === nav.transcript.id
        ? { ...current, index }
        : current
    ))
  }, [exonNav, doLoad])

  const shiftWindow = useCallback(async (direction) => {
    const nav = exonNav
    if (!region || !nav || !direction) return
    const center = Math.round((region.reference.start + region.reference.end) / 2)
    const target = Math.max(1, center + direction * windowBp)
    const geneContext = {
      ...nav.gene,
      canonical: nav.transcript.id,
    }
    const result = await doLoad({
      query: `${nav.chrom}:${target}`,
      preserveExonNav: true,
      preserveSearchQuery: true,
      geneContext,
    })
    if (!result) return

    const resultCenter = (result.reference.start + result.reference.end) / 2
    let nearest = 0
    let distance = Infinity
    nav.exons.forEach((exon, i) => {
      const candidate = Math.abs((exon.start + exon.end) / 2 - resultCenter)
      if (candidate < distance) { distance = candidate; nearest = i }
    })
    setExonNav((current) => (
      current?.transcript?.id === nav.transcript.id
        ? { ...current, index: nearest }
        : current
    ))
  }, [region, exonNav, windowBp, doLoad])

  // Load a region on mount so the viewer is never empty.
  useEffect(() => { doLoad({ query: 'BRCA2' }) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const refSeq = region?.reference.seq ?? ''
  const frame = region?.frame ?? null

  const derived = useMemo(() => {
    if (!region) return null
    const affectedRef = affectedRefIndices(refSeq, edited)
    const affectedDisp = affectedDisplayIndices(refSeq, edited)
    const { dispStart, dispEnd } = buildRefToDisplay(refSeq, edited)
    const junctions = deletionJunctions(refSeq, edited)

    const guides = findGuides({
      seq: refSeq, pam, spacerLength, affected: affectedRef, windowBp: DEFAULT_WINDOW_BP,
    })

    const nearMask = new Uint8Array(edited.length)
    for (const a of affectedDisp) {
      const lo = Math.max(0, a - DEFAULT_WINDOW_BP)
      const hi = Math.min(edited.length - 1, a + DEFAULT_WINDOW_BP)
      for (let i = lo; i <= hi; i++) nearMask[i] = 1
    }

    return {
      affectedRef, affectedDisp, dispStart, dispEnd, junctions, guides, nearMask,
      editList: describeEdits(refSeq, edited, region.reference.start),
      edits: hasEdits(refSeq, edited),
    }
  }, [region, refSeq, edited, pam, spacerLength])

  const scorable = rs3Compatible(pam, spacerLength)

  // Fetch RS3 scores whenever the guide set or tracrRNA changes.
  useEffect(() => {
    if (!derived || !scorable || !rs3Status.rs3) return
    const contexts = derived.guides.map((g) => g.context30).filter(Boolean)
    if (!contexts.length) return
    const controller = new AbortController()
    const rs3Name = TRACR_RNAS[tracrId].rs3Name
    scoreContexts(contexts, rs3Name, controller.signal)
      .then((res) => {
        setScoreVersion((v) => v + 1)
        if (!res.available && res.detail) setRs3Status({ rs3: false, detail: res.detail })
      })
      .catch((err) => { if (err.name !== 'AbortError') console.error(err) })
    return () => controller.abort()
  }, [derived?.guides, tracrId, scorable, rs3Status.rs3])

  // Merge scores + map guides into display coordinates for the viewer and table.
  const guideView = useMemo(() => {
    if (!derived || !region) return { items: [], sorted: [] }
    const { dispStart, dispEnd } = derived
    const rs3Name = TRACR_RNAS[tracrId].rs3Name
    const items = derived.guides.map((g) => {
      const rs3 = g.context30 ? cachedScore(g.context30, rs3Name) : undefined
      const cutDS = g.cutBefore < refSeq.length ? dispStart[g.cutBefore] : edited.length
      const protoDS = dispStart[g.protoStart]
      const protoDE = dispEnd[g.protoEnd]
      const pamDS = dispStart[g.pamStart]
      const pamDE = dispEnd[g.pamEnd]
      const score = typeof rs3 === 'number' ? rs3 : undefined
      const offtarget = offTargets.byGuide[g.id]
      const blocking = planGuideBlock({
        refSeq, guide: g, pam, frame, affected: derived.affectedRef,
        blockingChoice: blockChoiceMap[g.id] ?? null,
      })
      return {
        ...g,
        rs3: score,
        fill: rs3Fill(score),
        lightText: rs3NeedsLightText(score),
        offtarget,
        blocking,
        offUnique: offtarget ? offtarget.unique : undefined,
        cutGenomic: region.reference.start + g.cutBefore,
        protoDS, protoDE, pamDS, pamDE, cutDS,
        ds: Math.min(protoDS, pamDS),
        de: Math.max(protoDE, pamDE),
      }
    })
    const sorted = [...items].sort(compareGuides)
    return { items, sorted }
    // scoreVersion re-reads the RS3 cache after async scores land.
  }, [derived, region, tracrId, refSeq, edited.length, scoreVersion, offTargets, pam, frame, blockChoiceMap]) // eslint-disable-line react-hooks/exhaustive-deps

  const biotypes = useMemo(() => (region ? biotypesPresent(region.features) : []), [region])

  const featureItems = useMemo(() => {
    if (!region || !derived) return []
    return buildFeatureItems({
      raw: region.features,
      opts: viewOpts,
      dispStart: derived.dispStart,
      dispEnd: derived.dispEnd,
      refStart: region.reference.start,
      refLen: refSeq.length,
      gene: region.reference.gene,
    })
  }, [region, derived, refSeq, viewOpts])

  // Codon / amino-acid consequences mapped onto displayed sequence columns.
  const codonCells = useMemo(() => {
    if (!region || !derived || !viewOpts.codons || !frame) return null
    const track = buildCodonTrack(frame, refSeq)
    if (!track) return null

    const parity = new Int8Array(edited.length).fill(-1)
    const aa = new Array(edited.length).fill(null)
    const changed = new Uint8Array(edited.length)
    const title = new Array(edited.length).fill('')
    const kind = new Array(edited.length).fill('')
    const recordByRef = new Array(refSeq.length)
    const frameTranscript = region.features.transcripts.find(
      (transcript) => transcript.id === frame.transcript,
    )
    const frameLabel = frameTranscript?.name ?? frame.transcript ?? ''

    for (let d = 0; d < edited.length; d++) {
      const rec = edited[d]
      if (rec.ref == null) continue
      recordByRef[rec.ref] = rec
      if (track.pos[rec.ref] >= 0) parity[d] = track.parity[rec.ref]
    }

    for (let r = 0; r < refSeq.length; r++) {
      if (track.pos[r] !== 1) continue
      const codon = codonAt(frame, refSeq, r)
      if (!codon) continue
      const middleDisplay = derived.dispStart[r]
      const records = codon.refIdx.map((idx) => recordByRef[idx])
      let effectTitle

      if (records.some((rec) => !rec || rec.del)) {
        aa[middleDisplay] = 'Δ'
        kind[middleDisplay] = 'indel'
        effectTitle = `${codon.codon} (${codon.aa ?? 'X'}) → deletion; coding frame may change`
      } else {
        const bases = records.map((rec) => rec.base)
        const editedCodon = frame.strand === 1
          ? bases.join('')
          : bases.map(complementBase).join('')
        const editedAa = CODON_TABLE[editedCodon] ?? 'X'
        aa[middleDisplay] = editedAa
        effectTitle = editedCodon === codon.codon
          ? `${codon.codon} · ${codon.aa ?? 'X'}`
          : `${codon.codon} (${codon.aa ?? 'X'}) → ${editedCodon} (${editedAa})` +
            (editedAa === codon.aa ? ' · synonymous' : '')
      }

      effectTitle = frameLabel ? `${frameLabel} · ${effectTitle}` : effectTitle

      const codonChanged = records.some(
        (rec, i) => !rec || rec.del || rec.base !== refSeq[codon.refIdx[i]],
      )
      for (const idx of codon.refIdx) {
        const d = derived.dispStart[idx]
        title[d] = effectTitle
        if (codonChanged) changed[d] = 1
      }
    }

    for (let d = 0; d < edited.length;) {
      if (edited[d].ref != null) { d += 1; continue }
      let end = d + 1
      while (end < edited.length && edited[end].ref == null) end += 1
      const left = d > 0 ? edited[d - 1].ref : null
      const right = end < edited.length ? edited[end].ref : null
      const coding = (left != null && frame.codonPos[left] >= 0) ||
        (right != null && frame.codonPos[right] >= 0)
      if (coding) {
        const inFrame = (end - d) % 3 === 0
        const neighbour = left != null && track.pos[left] >= 0 ? left : right
        parity[d] = neighbour != null ? track.parity[neighbour] : 0
        aa[d] = inFrame ? '+' : 'FS'
        changed[d] = 1
        kind[d] = 'indel'
        title[d] = inFrame
          ? `${end - d} bp in-frame coding insertion`
          : `${end - d} bp coding insertion · frameshift`
      }
      d = end
    }

    return { parity, aa, changed, title, kind }
  }, [region, derived, refSeq, edited, viewOpts.codons, frame])

  // Fetch gnomAD / ClinVar variants for the loaded region when toggled on.
  useEffect(() => {
    if (!region || (!viewOpts.gnomad && !viewOpts.clinvar)) { setVariants([]); return }
    const controller = new AbortController()
    const { assembly, chrom, start, end } = region.reference
    const jobs = []
    if (viewOpts.gnomad) jobs.push(fetchVariants({ source: 'gnomad', assembly, chrom, start, end }, controller.signal))
    if (viewOpts.clinvar) jobs.push(fetchVariants({ source: 'clinvar', assembly, chrom, start, end }, controller.signal))
    Promise.all(jobs)
      .then((results) => setVariants(results.filter((r) => r.available).flatMap((r) => r.variants)))
      .catch((err) => { if (err.name !== 'AbortError') console.error(err) })
    return () => controller.abort()
  }, [region, viewOpts.gnomad, viewOpts.clinvar])

  const variantItems = useMemo(() => {
    if (!region || !derived) return []
    const out = []
    for (const v of variants) {
      const refIdx = v.pos - region.reference.start
      if (refIdx < 0 || refIdx >= refSeq.length) continue
      out.push({ ...v, refIdx, col: derived.dispStart[refIdx] })
    }
    return out
  }, [variants, region, derived, refSeq])

  // Common polymorphisms (MAF >= 1%) that overlap a guide can impair cutting.
  const guideVariantWarn = useMemo(() => {
    if (!derived || !region) return {}
    const common = variantItems
      .filter((v) => v.source === 'gnomad' && (v.af ?? 0) >= MAF_WARN)
      .sort((a, b) => a.refIdx - b.refIdx)
    if (!common.length) return {}
    const out = {}
    for (const g of derived.guides) {
      const hit = common.find((v) => v.refIdx >= g.protoStart && v.refIdx <= g.pamEnd)
      if (hit) out[g.id] = { af: hit.af, pos: hit.pos, id: hit.id, inPam: hit.refIdx >= g.pamStart }
    }
    return out
  }, [derived, region, variantItems])

  // Wait for edits to settle before starting the memory-intensive off-target
  // search. The server also guarantees that only one Bowtie job runs at a time.
  useEffect(() => {
    if (!region || !derived) { setOffTargets({ available: false, byGuide: {} }); return }
    const ready = gStatus?.offtarget?.assemblies?.[region.reference.assembly]?.ready
    if (!ready) { setOffTargets({ available: false, byGuide: {} }); return }
    const guides = derived.guides.map((g) => ({
      id: g.id, spacer: g.spacer, chrom: region.reference.chrom,
      cutGenomic: region.reference.start + g.cutBefore,
    }))
    if (!guides.length) { setOffTargets({ available: true, byGuide: {} }); return }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetchOffTargets({ assembly: region.reference.assembly, pam, guides }, controller.signal)
        .then((res) => {
          const byGuide = {}
          if (res.available) for (const g of res.guides) byGuide[g.id] = g
          setOffTargets({ available: res.available, byGuide })
        })
        .catch((err) => { if (err.name !== 'AbortError') console.error(err) })
    }, 1000)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [region, derived?.guides, gStatus, pam])

  const focusSpanDisplay = useMemo(() => {
    if (!region || !derived) return null
    const s = region.focus.start - region.reference.start
    const e = region.focus.end - region.reference.start
    if (e < 0 || s > refSeq.length - 1) return null
    const { dispStart, dispEnd } = derived
    return { ds: dispStart[Math.max(0, s)], de: dispEnd[Math.min(refSeq.length - 1, e)] }
  }, [region, derived, refSeq])

  // Transcription start site of the searched gene, if it falls in the window.
  const tssMarker = useMemo(() => {
    const gene = region?.reference.gene
    if (!gene || !derived) return null
    const tssGenomic = gene.strand === -1 ? gene.end : gene.start
    const refIdx = tssGenomic - region.reference.start
    if (refIdx < 0 || refIdx >= refSeq.length) return null
    return { col: derived.dispStart[refIdx], strand: gene.strand === -1 ? '-' : '+', name: gene.name }
  }, [region, derived, refSeq])

  const selectedGuide = guideView.items.find((g) => g.id === selectedGuideId) ?? null
  const selectedBlockingChoice = selectedGuide ? blockChoiceMap[selectedGuide.id] ?? null : null
  const setSelectedBlockingChoice = useCallback((choice) => {
    if (!selectedGuide) return
    setBlockChoiceMap((current) => {
      const next = { ...current }
      if (choice) next[selectedGuide.id] = choice
      else delete next[selectedGuide.id]
      return next
    })
  }, [selectedGuide])

  const inheritedArmsFor = useCallback((guide) => (
    guide && armDefault.strand && guide.strand !== armDefault.strand
      ? { left: armDefault.right, right: armDefault.left }
      : { left: armDefault.left, right: armDefault.right }
  ), [armDefault])
  const armsFor = useCallback((guide) => armMap[guide.id] ?? inheritedArmsFor(guide), [armMap, inheritedArmsFor])
  const selectedInheritedArms = selectedGuide ? inheritedArmsFor(selectedGuide) : armDefault
  const selectedArms = selectedGuide ? armsFor(selectedGuide) : armDefault
  const armsCustomized = selectedGuide != null && armMap[selectedGuide.id] != null &&
    (armMap[selectedGuide.id].left !== selectedInheritedArms.left || armMap[selectedGuide.id].right !== selectedInheritedArms.right)

  const setSelectedArm = useCallback((side, value) => {
    if (!selectedGuide) return
    setArmMap((m) => {
      const cur = m[selectedGuide.id] ?? inheritedArmsFor(selectedGuide)
      return { ...m, [selectedGuide.id]: { ...cur, [side]: value } }
    })
  }, [selectedGuide, inheritedArmsFor])

  const applyArmsToAll = useCallback(() => {
    if (!selectedGuide) return
    setArmDefault({ ...selectedArms, strand: selectedGuide.strand })
    setArmMap({}) // opposite-strand guides inherit the left/right swap
  }, [selectedArms, selectedGuide])

  const donor = useMemo(() => {
    if (!region || !selectedGuide || !derived) return null
    return designDonor({
      refSeq,
      refStart: region.reference.start,
      edited,
      affected: derived.affectedRef,
      guide: selectedGuide,
      pam,
      frame,
      armLeft: selectedArms.left,
      armRight: selectedArms.right,
      orientation,
      blockingChoice: selectedBlockingChoice,
    })
  }, [region, selectedGuide, derived, refSeq, edited, pam, frame, selectedArms, orientation, selectedBlockingChoice])

  // Aligned letter ribbons drawn directly against the track for the selected guide.
  const guideRibbon = useMemo(() => {
    if (!selectedGuide) return null
    const g = selectedGuide
    const cells = []
    for (let col = g.ds; col <= g.de; col++) {
      const ch = edited[col]?.base
      if (!ch) continue
      const kind = col >= g.pamDS && col <= g.pamDE ? 'pam'
        : col >= g.protoDS && col <= g.protoDE ? 'proto' : null
      if (kind) cells.push({ col, ch, kind })
    }
    return { ds: g.ds, de: g.de, strand: g.strand, protoColor: g.fill, lightText: g.lightText, cells, cutCol: g.cutDS }
  }, [selectedGuide, edited])

  const donorRibbon = useMemo(() => {
    if (!donor?.ok || !derived) return null
    const from = derived.dispStart[donor.winStart]
    const cells = donor.track.map((t, i) => ({ col: from + i, ch: t.base, role: t.role }))
    return {
      ds: from,
      de: from + donor.track.length - 1,
      cutCol: derived.dispStart[donor.cut], // display column of the cut junction
      orientation: donor.orientation,
      cells,
    }
  }, [donor, derived])

  // ---- multi-select + export ----
  const toggleChecked = useCallback((id) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleAll = useCallback((ids) => {
    setChecked((prev) => (ids.every((id) => prev.has(id)) ? new Set() : new Set(ids)))
  }, [])

  useEffect(() => { setChecked(new Set()) }, [region])

  const exportGuides = useCallback((format) => {
    if (!region || !derived) return
    const chosen = guideView.sorted.filter((g) => checked.has(g.id))
    if (!chosen.length) return
    const rs3Name = TRACR_RNAS[tracrId].rs3Name
    const chrom = region.reference.chrom
    const rows = chosen.map((g) => {
      const arms = armsFor(g)
      const d = designDonor({
        refSeq, refStart: region.reference.start, edited,
        affected: derived.affectedRef, guide: g, pam, frame,
        armLeft: arms.left, armRight: arms.right, orientation,
        blockingChoice: blockChoiceMap[g.id] ?? null,
      })
      return {
        id: `${g.strand === '+' ? 'fwd' : 'rev'}_chr${chrom}_${g.cutGenomic}`,
        strand: g.strand,
        spacer: g.spacer,
        pam: g.pamSeq,
        sgRNA: fullSgRna(g.spacer, tracrId),
        rs3: typeof g.rs3 === 'number' ? g.rs3.toFixed(4) : '',
        gc: (g.gc * 100).toFixed(0),
        cut_genomic: g.cutGenomic,
        cut_dist: g.cutDist,
        context_30mer: g.context30 ?? '',
        ssODN: d.ok ? d.ssodn : '',
        ssODN_strand: d.ok ? d.orientation : '',
        block: d.ok ? d.blocking.reason : '',
      }
    })

    let text
    let filename
    if (format === 'fasta') {
      text = rows.map((r) =>
        `>${r.id}|spacer|rs3=${r.rs3}\n${r.spacer}\n` +
        (r.ssODN ? `>${r.id}|ssODN_${r.ssODN_strand}\n${r.ssODN}\n` : ''),
      ).join('')
      filename = 'retroedit_guides.fasta'
    } else {
      const cols = ['id', 'strand', 'spacer', 'pam', 'sgRNA', 'rs3', 'gc',
        'cut_genomic', 'cut_dist', 'context_30mer', 'ssODN', 'ssODN_strand', 'block']
      text = [cols.join('\t'), ...rows.map((r) => cols.map((c) => r[c]).join('\t'))].join('\n') + '\n'
      filename = 'retroedit_guides.tsv'
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }, [region, derived, guideView.sorted, checked, tracrId, refSeq, edited, pam, frame, armsFor, orientation, blockChoiceMap])

  // ---- panel resizing ----
  const startResize = useCallback((event) => {
    event.preventDefault()
    const startX = event.clientX
    const startW = sidebarWidth
    const onMove = (e) => {
      const w = startW + (startX - e.clientX)
      setSidebarWidth(Math.max(320, Math.min(880, w)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
  }, [sidebarWidth])

  // ---- editing ----
  const selRange = selection && selection.anchor !== selection.focus
    ? [Math.min(selection.anchor, selection.focus), Math.max(selection.anchor, selection.focus)]
    : null

  // Every mutating action goes through commit(), which records history.
  const commit = useCallback((next, nextCaret) => {
    setPast((p) => [...p, edited])
    setFuture([])
    setEdited(next)
    if (nextCaret != null) setCaret(nextCaret)
    setSelection(null)
  }, [edited])

  const canUndo = past.length > 0
  const canRedo = future.length > 0

  const undo = useCallback(() => {
    setPast((p) => {
      if (!p.length) return p
      const prev = p[p.length - 1]
      setFuture((f) => [edited, ...f])
      setEdited(prev)
      setCaret((c) => Math.min(c, prev.length))
      setSelection(null)
      return p.slice(0, -1)
    })
  }, [edited])

  const redo = useCallback(() => {
    setFuture((f) => {
      if (!f.length) return f
      const nxt = f[0]
      setPast((p) => [...p, edited])
      setEdited(nxt)
      setCaret((c) => Math.min(c, nxt.length))
      setSelection(null)
      return f.slice(1)
    })
  }, [edited])

  const handleKeyDown = useCallback((event) => {
    const key = event.key
    if (event.metaKey || event.ctrlKey) {
      // Undo / redo shortcuts.
      if (key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if (key.toLowerCase() === 'y') {
        event.preventDefault(); redo()
      }
      return
    }
    if (event.altKey) return
    const upper = key.toUpperCase()

    if (key.length === 1 && BASES.has(upper)) {
      event.preventDefault()
      if (selRange) commit(replaceRange(edited, selRange[0], selRange[1], upper), selRange[0] + 1)
      else commit(insertAt(edited, caret, upper), caret + 1)
    } else if (key === 'Backspace') {
      event.preventDefault()
      if (selRange) commit(deleteRange(edited, selRange[0], selRange[1]), selRange[0])
      else if (caret > 0) commit(deleteRange(edited, caret - 1, caret), caret - 1)
    } else if (key === 'Delete') {
      event.preventDefault()
      if (selRange) commit(deleteRange(edited, selRange[0], selRange[1]), selRange[0])
      else if (caret < edited.length) commit(deleteRange(edited, caret, caret + 1), caret)
    } else if (key === 'ArrowLeft') {
      event.preventDefault(); setCaret(Math.max(0, caret - 1)); setSelection(null)
    } else if (key === 'ArrowRight') {
      event.preventDefault(); setCaret(Math.min(edited.length, caret + 1)); setSelection(null)
    } else if (key === 'Escape') {
      setSelection(null)
    }
  }, [edited, caret, selRange, commit, undo, redo])

  const revert = useCallback(() => {
    if (!region) return
    commit(makeEdited(region.reference.seq), 0)
    setSelectedGuideId(null)
  }, [region, commit])

  const selectGuide = useCallback((id) => {
    // Clicking the already-selected guide deselects it.
    setSelectedGuideId((cur) => {
      if (cur === id) return null
      const g = guideView.items.find((x) => x.id === id)
      if (g) viewerRef.current?.scrollToIndex(g.ds)
      return id
    })
  }, [guideView.items])

  return (
    <div className="app">
      {/* <header className="topbar">
        <div className="brand">
          <span className="logo">✂︎</span>
          <div>
            <h1>RetroEdit</h1>
            <p>Search a locus, make an edit, pick a guide, get an HDR repair template.</p>
          </div>
        </div>
        <Rs3Badge status={rs3Status} scorable={scorable} />
      </header> */}

      <Controls
        genomeId={genomeId} onGenome={(g) => { setGenomeId(g); doLoad({ genomeId: g }) }}
        query={query} onQuery={setQuery}
        windowBp={windowBp} onWindow={setWindowBp}
        pam={pam} onPam={setPam}
        tracrId={tracrId} onTracr={setTracrId}
        onSearch={() => doLoad()} loading={loading}
        searchChanged={query.trim() !== loadedQuery}
      />

      {error && <div className="banner error">⚠ {error}</div>}

      {region && derived && (
        <>
          <div className="locusbar">
            <div className="locusinfo">
              <strong>{region.reference.label}</strong>
              <span>{region.reference.organism} {region.reference.assembly}</span>
              <span>chr{region.reference.chrom}:{region.reference.start.toLocaleString()}-{region.reference.end.toLocaleString()}</span>
              <span>{refSeq.length.toLocaleString()} bp</span>
              {frame && <span className="chip coding">coding frame</span>}
            </div>
            <FeatureRibbon
              opts={viewOpts}
              onChange={setViewOpts}
              biotypes={biotypes}
              status={gStatus}
              assembly={region.reference.assembly}
              frameAvailable={!!frame}
              exonNav={exonNav}
              navigationDisabled={loading}
              onSnapExon={() => snapToExon(exonNav?.index)}
              onPreviousExon={() => snapToExon((exonNav?.index ?? 0) - 1)}
              onNextExon={() => snapToExon((exonNav?.index ?? -1) + 1)}
              onPanLeft={() => shiftWindow(-1)}
              onPanRight={() => shiftWindow(1)}
            />
          </div>

          <EditBar
            edits={derived.edits}
            editList={derived.editList}
            selRange={selRange}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
            onRevert={revert}
          />

          <div className="workspace">
            <SequenceViewer
              ref={viewerRef}
              reference={region.reference}
              edited={edited}
              guideItems={guideView.items}
              featureItems={featureItems}
              guideRibbon={guideRibbon}
              donorRibbon={donorRibbon}
              cutColumn={selectedGuide ? selectedGuide.cutDS : null}
              tss={tssMarker}
              codonCells={codonCells}
              variantItems={variantItems}
              focusSpan={focusSpanDisplay}
              nearMask={derived.nearMask}
              junctions={derived.junctions}
              caret={caret}
              selection={selection}
              selectedGuideId={selectedGuideId}
              onCaretChange={setCaret}
              onSelectionChange={setSelection}
              onSelectGuide={selectGuide}
              onKeyDown={handleKeyDown}
            />

            <div className="resizer" onMouseDown={startResize} title="Drag to resize" />

            <aside className="sidebar" style={{ width: sidebarWidth }}>
              <GuideTable
                guides={guideView.sorted}
                hasEdits={derived.edits}
                tracrId={tracrId}
                scorable={scorable}
                rs3Available={rs3Status.rs3}
                selectedGuideId={selectedGuideId}
                onSelect={selectGuide}
                checked={checked}
                onToggle={toggleChecked}
                onToggleAll={toggleAll}
                onExport={exportGuides}
                offAvailable={offTargets.available}
                variantWarn={guideVariantWarn}
              />
              <DonorPanel
                donor={donor}
                guide={selectedGuide}
                tracrId={tracrId}
                armLeft={selectedArms.left}
                armRight={selectedArms.right}
                onArmLeft={(v) => setSelectedArm('left', v)}
                onArmRight={(v) => setSelectedArm('right', v)}
                armsCustomized={armsCustomized}
                onApplyArmsToAll={applyArmsToAll}
                orientation={orientation}
                onOrientation={setOrientation}
                blockingChoice={selectedBlockingChoice}
                onBlockingChoice={setSelectedBlockingChoice}
                reference={region.reference}
              />
            </aside>
          </div>
        </>
      )}

      {!region && loading && <div className="banner">Loading…</div>}
    </div>
  )
}

function Rs3Badge({ status, scorable }) {
  const ok = status.rs3
  return (
    <div className={`rs3badge ${ok ? 'on' : 'off'}`} title={status.detail ?? ''}>
      <span className="dot" />
      RS3 {ok ? 'online' : 'offline'}
      {!scorable && ok && <em> · needs 20 nt spacer + 3 nt PAM</em>}
    </div>
  )
}
