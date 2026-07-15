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
import { cachedOffTargets, fetchCanonicalExons, fetchNearbyFeatures, fetchOffTargets, fetchVariants, genomicsStatus } from './lib/genomics.js'

const DEFAULT_VIEW_OPTS = {
  featureLevels: { gene: true, transcript: false },
  biotypes: null, // null = all biotypes
  codons: true,
  gnomad: false,
  clinvar: false,
}
const MAF_WARN = 0.01 // polymorphism threshold that can impair a guide
const POSITION_VIEW_BP = 700
const EXON_CONTEXT_BP = 200
const EXTEND_BP = 200

const BASES = new Set(['A', 'C', 'G', 'T'])

function extendEditedSnapshot(snapshot, newRefSeq, oldRefLength, leftAdded) {
  const prefix = Array.from(newRefSeq.slice(0, leftAdded), (base, ref) => ({ base, ref }))
  const shifted = snapshot.map((record) => (
    record.ref == null ? record : { ...record, ref: record.ref + leftAdded }
  ))
  const suffixStart = leftAdded + oldRefLength
  const suffix = Array.from(newRefSeq.slice(suffixStart), (base, index) => ({
    base,
    ref: suffixStart + index,
  }))
  return [...prefix, ...shifted, ...suffix]
}

export default function App() {
  const [genomeId, setGenomeId] = useState(DEFAULT_GENOME_ID)
  const [query, setQuery] = useState('')
  const [loadedControls, setLoadedControls] = useState(null)
  const [pam, setPam] = useState(DEFAULT_PAM)
  const [tracrId, setTracrId] = useState('hsu2013')
  const spacerLength = DEFAULT_SPACER_LENGTH
  const loadChanged = loadedControls == null ||
    loadedControls.genomeId !== genomeId ||
    loadedControls.query !== query.trim() ||
    loadedControls.pam !== pam ||
    loadedControls.tracrId !== tracrId

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
  const [sidebarWidth, setSidebarWidth] = useState(640)

  const [viewOpts, setViewOpts] = useState(DEFAULT_VIEW_OPTS)
  const [gStatus, setGStatus] = useState(null)
  const [variants, setVariants] = useState([]) // gnomAD + ClinVar for the region
  const [offTargets, setOffTargets] = useState({ available: false, byGuide: {}, loading: false, pendingIds: new Set() })
  const [exonNav, setExonNav] = useState(null)
  const [nearbyFeatures, setNearbyFeatures] = useState([])

  const viewerRef = useRef(null)
  const [overviewTarget, setOverviewTarget] = useState(null)

  useEffect(() => { checkRs3Health().then(setRs3Status) }, [])
  useEffect(() => { genomicsStatus().then(setGStatus) }, [])

  const doLoad = useCallback(async (opts = {}) => {
    const gid = opts.genomeId ?? genomeId
    const q = opts.query ?? query
    setLoading(true)
    setError(null)
    try {
      let result = await loadRegion({
        query: q,
        genomeId: gid,
        windowBp: POSITION_VIEW_BP,
        locus: opts.locus ?? null,
      })
      let nextExonNav = null

      if (opts.geneContext) result.reference.gene = opts.geneContext
      if (result.reference.gene && !opts.preserveExonNav && !opts.locus) {
        const data = await fetchCanonicalExons({
          assembly: result.reference.assembly,
          gene: result.reference.gene.id,
        })
        if (data?.exons?.length) {
          let index = data.exons.findIndex((exon) => exon.rank === 1)
          if (index < 0) index = data.transcript.strand === -1 ? data.exons.length - 1 : 0
          const exon = data.exons[index]
          const geneContext = { ...data.gene, canonical: data.transcript.id }
          result = await loadRegion({
            genomeId: gid,
            locus: {
              chrom: data.chrom,
              start: Math.max(1, exon.start - EXON_CONTEXT_BP),
              end: exon.end + EXON_CONTEXT_BP,
              focus: { start: exon.start, end: exon.end },
              gene: geneContext,
              label: `${data.gene.name} (${data.gene.id})`,
            },
          })
          nextExonNav = { ...data, index }
        }
      }

      // Commit the replacement view only after all layout-affecting annotation
      // data is ready, avoiding an empty-feature frame followed by a second jump.
      const annotations = await loadRegionAnnotations(result).catch(() => null)
      if (annotations) result = { ...result, ...annotations }

      if (!opts.preserveLoadState) {
        setLoadedControls({ genomeId: gid, query: q.trim(), pam, tracrId })
      }
      setRegion(result)
      setEdited(makeEdited(result.reference.seq))
      setPast([])
      setFuture([])
      setArmMap({})
      setBlockChoiceMap({})
      setSelection(null)
      setSelectedGuideId(null)
      if (!opts.preserveExonNav) setExonNav(nextExonNav)
      const focusIdx = result.focus.start - result.reference.start
      setCaret(Math.max(0, Math.min(result.reference.seq.length, focusIdx)))
      requestAnimationFrame(() => viewerRef.current?.scrollToIndex(Math.max(0, focusIdx)))
      return result
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [genomeId, query, pam, tracrId])

  const snapToExon = useCallback(async (index) => {
    const nav = exonNav
    const exon = nav?.exons?.[index]
    if (!exon) return
    const geneContext = { ...nav.gene, canonical: nav.transcript.id }
    const result = await doLoad({
      preserveExonNav: true,
      preserveLoadState: true,
      geneContext,
      locus: {
        chrom: nav.chrom,
        start: Math.max(1, exon.start - EXON_CONTEXT_BP),
        end: exon.end + EXON_CONTEXT_BP,
        focus: { start: exon.start, end: exon.end },
        gene: geneContext,
        label: `${nav.gene.name} (${nav.gene.id})`,
      },
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
    const reference = region.reference
    const width = reference.end - reference.start + 1
    const requestedStart = reference.start + direction * POSITION_VIEW_BP
    const start = Math.max(1, requestedStart)
    const end = start + width - 1
    const geneContext = { ...nav.gene, canonical: nav.transcript.id }
    const result = await doLoad({
      preserveExonNav: true,
      preserveLoadState: true,
      geneContext,
      locus: {
        chrom: nav.chrom,
        start,
        end,
        focus: { start: Math.floor((start + end) / 2), end: Math.floor((start + end) / 2) },
        gene: geneContext,
        label: `${nav.gene.name} (${nav.gene.id})`,
      },
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
  }, [region, exonNav, doLoad])

  const navigateOverview = useCallback(async (center) => {
    if (!region || loading || !Number.isFinite(center)) return
    const reference = region.reference
    const width = reference.end - reference.start + 1
    const start = Math.max(1, Math.round(center - (width - 1) / 2))
    const end = start + width - 1
    const nav = exonNav
    const geneContext = nav ? { ...nav.gene, canonical: nav.transcript.id } : reference.gene
    const result = await doLoad({
      preserveExonNav: true,
      preserveLoadState: true,
      geneContext,
      locus: {
        chrom: reference.chrom,
        start,
        end,
        focus: { start: Math.round(center), end: Math.round(center) },
        gene: geneContext,
        label: geneContext ? `${geneContext.name} (${geneContext.id})` : `${reference.chrom}:${Math.round(center)}`,
      },
    })
    if (!result || !nav) return
    const resultCenter = (result.reference.start + result.reference.end) / 2
    let nearest = 0
    let distance = Infinity
    nav.exons.forEach((exon, index) => {
      const candidate = Math.abs((exon.start + exon.end) / 2 - resultCenter)
      if (candidate < distance) { distance = candidate; nearest = index }
    })
    setExonNav((current) => (
      current?.transcript?.id === nav.transcript.id ? { ...current, index: nearest } : current
    ))
  }, [region, loading, exonNav, doLoad])

  const resizeOverview = useCallback(async (requestedStart, requestedEnd) => {
    if (!region || loading || !Number.isFinite(requestedStart) || !Number.isFinite(requestedEnd)) return
    const reference = region.reference
    const start = Math.max(1, Math.round(Math.min(requestedStart, requestedEnd)))
    const end = Math.round(Math.max(requestedStart, requestedEnd))
    if (end <= start || (start === reference.start && end === reference.end)) return

    const center = Math.round((start + end) / 2)
    const nav = exonNav
    const geneContext = nav ? { ...nav.gene, canonical: nav.transcript.id } : reference.gene
    const result = await doLoad({
      preserveExonNav: true,
      preserveLoadState: true,
      geneContext,
      locus: {
        chrom: reference.chrom,
        start,
        end,
        focus: { start: center, end: center },
        gene: geneContext,
        label: geneContext ? `${geneContext.name} (${geneContext.id})` : `${reference.chrom}:${center}`,
      },
    })
    if (!result || !nav) return

    const resultCenter = (result.reference.start + result.reference.end) / 2
    let nearest = 0
    let distance = Infinity
    nav.exons.forEach((exon, index) => {
      const candidate = Math.abs((exon.start + exon.end) / 2 - resultCenter)
      if (candidate < distance) { distance = candidate; nearest = index }
    })
    setExonNav((current) => (
      current?.transcript?.id === nav.transcript.id ? { ...current, index: nearest } : current
    ))
  }, [region, loading, exonNav, doLoad])

  const extendRegion = useCallback(async (direction) => {
    if (!region || loading || !direction) return
    const reference = region.reference
    const start = direction < 0 ? Math.max(1, reference.start - EXTEND_BP) : reference.start
    const end = direction > 0 ? reference.end + EXTEND_BP : reference.end
    if (start === reference.start && end === reference.end) return

    setLoading(true)
    setError(null)
    try {
      let result = await loadRegion({
        genomeId: reference.genomeId,
        locus: {
          chrom: reference.chrom,
          start,
          end,
          focus: region.focus,
          gene: reference.gene,
          label: reference.label,
        },
      })
      const annotations = await loadRegionAnnotations(result).catch(() => null)
      if (annotations) result = { ...result, ...annotations }
      const leftAdded = reference.start - start
      const rebase = (snapshot) => extendEditedSnapshot(
        snapshot,
        result.reference.seq,
        reference.seq.length,
        leftAdded,
      )
      setRegion(result)
      setEdited(rebase(edited))
      setPast((snapshots) => snapshots.map(rebase))
      setFuture((snapshots) => snapshots.map(rebase))
      setCaret((position) => position + leftAdded)
      setSelection((current) => current ? {
        anchor: current.anchor + leftAdded,
        focus: current.focus + leftAdded,
      } : null)
      setSelectedGuideId(null)
      setChecked(new Set())
      setArmMap({})
      setBlockChoiceMap({})
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [region, loading, edited])


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

  // Guide discovery needs sequence beyond the ±100 bp search interval so a
  // protospacer, PAM, and RS3 context can be complete at the interval edge.
  // Extend one side at a time; after rebasing, this effect re-checks the other.
  useEffect(() => {
    if (!region || !derived?.edits || loading || !derived.affectedRef.length) return
    const requiredBuffer = DEFAULT_WINDOW_BP + spacerLength + pam.length + 4
    const firstAffected = derived.affectedRef[0]
    const lastAffected = derived.affectedRef[derived.affectedRef.length - 1]
    const leftAvailable = firstAffected
    const rightAvailable = refSeq.length - 1 - lastAffected

    if (leftAvailable < requiredBuffer && region.reference.start > 1) {
      void extendRegion(-1)
      return
    }
    if (rightAvailable < requiredBuffer) void extendRegion(1)
  }, [derived, extendRegion, loading, pam.length, refSeq.length, region, spacerLength])

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
        rs3Complete: rs3 !== undefined,
        metricsReady:
          rs3Status.detail !== 'checking' &&
          !!gStatus &&
          (!scorable || !rs3Status.rs3 || !g.context30 || rs3 !== undefined) &&
          (!gStatus?.offtarget?.assemblies?.[region.reference.assembly]?.ready || !offTargets.pendingIds?.has(g.id)),
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
  }, [derived, region, tracrId, refSeq, edited.length, scoreVersion, offTargets, pam, frame, blockChoiceMap, rs3Status, gStatus, scorable]) // eslint-disable-line react-hooks/exhaustive-deps


  const biotypes = useMemo(() => (region ? biotypesPresent(region.features) : []), [region])

  const featureItems = useMemo(() => {
    if (!region || !derived) return []
    const items = buildFeatureItems({
      raw: region.features,
      opts: viewOpts,
      dispStart: derived.dispStart,
      dispEnd: derived.dispEnd,
      refStart: region.reference.start,
      refLen: refSeq.length,
      gene: region.reference.gene,
    })
    if (!viewOpts.featureLevels.gene) return items
    const nav = exonNav
    const annotationsReady = region.features.transcripts.length > 0
    if (!nav?.exons?.length || !annotationsReady) return items

    const refStart = region.reference.start
    const refEnd = region.reference.end
    const lastRef = refSeq.length - 1
    const toDisplay = (start, end) => {
      const clippedStart = Math.max(refStart, start)
      const clippedEnd = Math.min(refEnd, end)
      if (clippedEnd < clippedStart) return null
      return {
        ds: derived.dispStart[Math.max(0, Math.min(lastRef, clippedStart - refStart))],
        de: derived.dispEnd[Math.max(0, Math.min(lastRef, clippedEnd - refStart))],
      }
    }
    const canonicalTranscript = region.features.transcripts.find(
      (transcript) => transcript.id === nav.transcript.id,
    )
    const proteinCoding = canonicalTranscript?.biotype === 'protein_coding'
    const coding = (region.features.coding ?? [])
      .filter((segment) => segment.transcript === nav.transcript.id)
      .sort((a, b) => a.start - b.start)
    const functional = []

    const addSegment = (level, name, start, end, exon) => {
      const display = toDisplay(start, end)
      if (!display) return
      functional.push({
        id: `${level}-${nav.transcript.id}-${start}-${end}`,
        level,
        name,
        ...display,
        strand: nav.transcript.strand,
        source: `canonical ${nav.transcript.name} · exon ${exon.rank ?? ''}`,
      })
    }
    const utrName = (exon, side) => {
      if (!proteinCoding) return 'non-coding exon'
      if (side === 'before') return nav.transcript.strand === -1 ? '3′ UTR' : '5′ UTR'
      if (side === 'after') return nav.transcript.strand === -1 ? '5′ UTR' : '3′ UTR'
      if (exon.rank === 1) return '5′ UTR'
      if (exon.rank === nav.exons.length) return '3′ UTR'
      return 'non-coding exon'
    }

    nav.exons.filter((exon) => exon.end >= refStart && exon.start <= refEnd).forEach((exon) => {
      const exonStart = Math.max(exon.start, refStart)
      const exonEnd = Math.min(exon.end, refEnd)
      const exonCoding = coding.filter((segment) => segment.end >= exonStart && segment.start <= exonEnd)
      if (!exonCoding.length) {
        addSegment('utr', utrName(exon), exonStart, exonEnd, exon)
        return
      }
      let cursor = exonStart
      exonCoding.forEach((segment, index) => {
        const start = Math.max(exonStart, segment.start)
        const end = Math.min(exonEnd, segment.end)
        if (start > cursor) {
          addSegment('utr', utrName(exon, index === 0 ? 'before' : null), cursor, start - 1, exon)
        }
        addSegment('cds', 'CDS', start, end, exon)
        cursor = Math.max(cursor, end + 1)
      })
      if (cursor <= exonEnd) addSegment('utr', utrName(exon, 'after'), cursor, exonEnd, exon)
    })
    return [...items, ...functional]
  }, [region, derived, refSeq, viewOpts, exonNav])

  useEffect(() => {
    const reference = region?.reference
    const focus = region?.focus
    if (!reference || reference.gene || !focus) {
      setNearbyFeatures([])
      return undefined
    }
    const center = Math.round((focus.start + focus.end) / 2)
    const controller = new AbortController()
    fetchNearbyFeatures({
      assembly: reference.assembly,
      chrom: reference.chrom,
      start: Math.max(1, center - 100_000),
      end: center + 100_000,
    }, controller.signal).then(setNearbyFeatures).catch(() => {})
    return () => controller.abort()
  }, [region?.reference.assembly, region?.reference.chrom, region?.reference.gene, region?.focus?.start, region?.focus?.end])

  const locusOverview = useMemo(() => {
    if (!region) return null
    const gene = exonNav?.gene ?? region.reference.gene
    if (gene) {
      return {
        chrom: exonNav?.chrom ?? region.reference.chrom,
        start: gene.start,
        end: gene.end,
        label: gene.name,
        strand: gene.strand,
        exons: exonNav?.exons ?? [],
      }
    }

    const focus = region.focus
    if (!focus) return null
    const center = Math.round((focus.start + focus.end) / 2)
    return {
      chrom: region.reference.chrom,
      start: Math.max(1, center - 100_000),
      end: center + 100_000,
      label: `chr${String(region.reference.chrom).replace(/^chr/i, '')}:${center.toLocaleString()} ±100 kb`,
      exons: [],
      elements: nearbyFeatures,
    }
  }, [region, exonNav, nearbyFeatures])

  // Codon / amino-acid consequences mapped onto displayed sequence columns.
  const codonCells = useMemo(() => {
    if (!region || !derived || !frame) return null
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
  }, [region, derived, refSeq, edited, frame])

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
    const empty = { available: false, byGuide: {}, loading: false, pendingIds: new Set() }
    if (!region || !derived) { setOffTargets(empty); return }
    const assembly = region.reference.assembly
    const ready = gStatus?.offtarget?.assemblies?.[assembly]?.ready
    if (!ready) { setOffTargets(empty); return }
    const guides = derived.guides.map((g) => ({
      id: g.id, spacer: g.spacer, chrom: region.reference.chrom,
      cutGenomic: region.reference.start + g.cutBefore,
    }))
    if (!guides.length) {
      setOffTargets({ available: true, byGuide: {}, loading: false, pendingIds: new Set() })
      return
    }

    const cached = cachedOffTargets({ assembly, pam, guides })
    const pendingIds = new Set(cached.missing.map((guide) => guide.id))
    setOffTargets({
      available: true,
      byGuide: cached.byGuide,
      loading: pendingIds.size > 0,
      pendingIds,
    })
    if (!cached.missing.length) return

    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetchOffTargets({ assembly, pam, guides }, controller.signal)
        .then((res) => {
          const byGuide = {}
          for (const guide of res.guides) byGuide[guide.id] = guide
          setOffTargets({
            available: res.available || Object.keys(byGuide).length > 0,
            byGuide,
            loading: false,
            pendingIds: new Set(),
          })
        })
        .catch((err) => {
          if (err.name !== 'AbortError') {
            console.error(err)
            setOffTargets({
              available: Object.keys(cached.byGuide).length > 0,
              byGuide: cached.byGuide,
              loading: false,
              pendingIds: new Set(),
            })
          }
        })
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
    for (let col = g.protoDS; col <= g.protoDE; col++) {
      const genomicBase = edited[col]?.base
      if (!genomicBase) continue
      const ch = g.strand === '-' ? complementBase(genomicBase) : genomicBase
      cells.push({ col, ch })
    }
    return {
      ds: g.protoDS, de: g.protoDE, strand: g.strand,
      protoColor: g.fill, lightText: g.lightText, cells, cutCol: g.cutDS,
    }
  }, [selectedGuide, edited])

  const donorRibbon = useMemo(() => {
    if (!donor?.ok || !derived) return null
    const from = derived.dispStart[donor.winStart]
    const cells = donor.track.map((t, i) => ({
      col: from + i,
      ch: donor.orientation === 'antisense' ? complementBase(t.base) : t.base,
      role: t.role,
    }))
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
    const chosen = guideView.sorted.filter((g) => g.metricsReady && checked.has(g.id))
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
        genomeId={genomeId} onGenome={setGenomeId}
        query={query} onQuery={setQuery}
        pam={pam} onPam={setPam}
        tracrId={tracrId} onTracr={setTracrId}
        onSearch={(example) => doLoad(example ? { query: example } : undefined)} loading={loading}
        loadChanged={loadChanged}
      />

      {error && <div className="banner error">⚠ {error}</div>}

      {!region && <GettingStarted />}

      {region && derived && (
        <>
          <div className="locusbar">
            <FeatureRibbon
              opts={viewOpts}
              onChange={setViewOpts}
              biotypes={biotypes}
              status={gStatus}
              assembly={region.reference.assembly}
              frameAvailable={!!frame}
              overviewTargetRef={setOverviewTarget}
              locusOverview={locusOverview}
              exonNav={exonNav}
              navigationDisabled={loading}
              onSnapExon={() => snapToExon(exonNav?.index)}
              onPreviousExon={() => snapToExon((exonNav?.index ?? 0) - 1)}
              onNextExon={() => snapToExon((exonNav?.index ?? -1) + 1)}
              onPanLeft={() => shiftWindow(-1)}
              onPanRight={() => shiftWindow(1)}
            />
          </div>

          <div className="workspace">
            <div className="editorpane">
              <EditBar
                editList={derived.editList}
                selRange={selRange}
                edits={derived.edits}
                canUndo={canUndo}
                canRedo={canRedo}
                onUndo={undo}
                onRedo={redo}
                onRevert={revert}
                annotationOptions={viewOpts}
                onAnnotationChange={setViewOpts}
                biotypes={biotypes}
                inputKey={query}
                loadedInputKey={loadedControls?.query ?? query}
              />
              <SequenceViewer
                ref={viewerRef}
                reference={region.reference}
                locusOverview={locusOverview}
                overviewTarget={overviewTarget}
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
                onOverviewNavigate={navigateOverview}
                onOverviewResize={resizeOverview}
                onOverviewExon={snapToExon}
                overviewDisabled={loading}
                onKeyDown={handleKeyDown}
                onExtendLeft={() => extendRegion(-1)}
                onExtendRight={() => extendRegion(1)}
                extensionDisabled={loading}
              />
            </div>

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

    </div>
  )
}

function GettingStarted() {
  return (
    <main className="gettingstarted">
      <div className="tutorialstart">
        <span className="tutorialarrow up" aria-hidden="true">↑</span>
        <span className="tutorialnumber">1</span>
        <div><h2>Input gene or locus</h2><p>Type a symbol or coordinate above, or choose an example chip, then press Load.</p></div>
      </div>
      <div className="tutorialnavigate">
        <div className="tutorialstep compact">
          <span className="tutorialnumber">2</span>
          <div>
            <h3>Navigate and resize the gene view</h3>
            <p>Drag the highlighted window to move, drag either edge to resize it, or click an exon to snap.</p>
          </div>
        </div>
        <div className="mockoverview" aria-hidden="true">
          <span className="mockoverview-gene" />
          <i className="e1" /><i className="e2" /><i className="e3" /><i className="e4" />
          <b><em /><em /></b>
        </div>
      </div>
      <div className="tutoriallayout">
        <section className="tutorialmock tutorialsequence">
          <div className="tutorialstep">
            <span className="tutorialnumber">3</span>
            <div><h3>Edit sequence here</h3><p>Select bases, type to insert, double-click a base to mutate it, or press Delete to remove it.</p></div>
            <span className="tutorialarrow down" aria-hidden="true">↓</span>
          </div>
          <div className="mocksequence" aria-hidden="true">
            <span className="mockstrand">ACTGACC<span className="mockedit mocksub">A</span>GAGGCTAC<span className="mockedit mockins">TT</span>CGTAG<span className="mockedit mockdel">GCT</span>GACCTGAGGCTACCGTA</span>
            <span className="mockstrand mockcomplement">TGACTGG<span className="mockedit mocksub">T</span>CTCCGATG<span className="mockedit mockins">AA</span>GCATC<span className="mockedit mockdel">CGA</span>CTGGACTCCGATGGCAT</span>
            <div className="mockeditlegend">
              <span className="mocksub">C→A mutation</span>
              <span className="mockins">+TT insertion</span>
              <span className="mockdel">−GCT deletion</span>
            </div>
            <i>GENE</i>
          </div>
        </section>
        <span className="tutorialflow" aria-hidden="true">→</span>
        <aside className="tutorialmock tutorialright">
          <div className="tutorialpanel">
            <div className="tutorialstep compact">
              <span className="tutorialnumber">4</span>
              <div><h3>Select sgRNA</h3><p>Compare efficiency, distance, off-target matches, and re-cut prevention.</p></div>
            </div>
            <div className="mockguides" aria-hidden="true"><i /><i /><i /></div>
          </div>
          <div className="tutorialpanel">
            <div className="tutorialstep compact">
              <span className="tutorialnumber">5</span>
              <div><h3>Select repair template(s)</h3><p>Review donor strand, homology arms, and the blocking mutation.</p></div>
            </div>
            <div className="mockdonor" aria-hidden="true"><i /><i /><i /></div>
          </div>
          <div className="tutorialpanel export">
            <div className="tutorialstep compact">
              <span className="tutorialnumber">6</span>
              <div><h3>Export designs</h3><p>Check completed designs and export FASTA or TSV.</p></div>
              <span className="tutorialarrow up-right" aria-hidden="true">↗</span>
            </div>
          </div>
        </aside>
      </div>
      <div className="tutorialfinish">
        <span className="tutorialnumber">7</span>
        <div>
          <h3>Order reagents and edit in the lab</h3>
          <p>Use your exported designs to order oligos or gBlocks, then take your precise-editing experiment into the lab.</p>
        </div>
      </div>
    </main>
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
