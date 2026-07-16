import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { complementBase } from '../lib/bio.js'
import { baseStatus } from '../lib/editModel.js'

function featureTooltip(f) {
  const lines = [f.name]
  if (f.id && f.id !== f.name) lines.push(f.id)
  const meta = [f.biotype?.replace(/_/g, ' '), f.source].filter(Boolean).join(' · ')
  if (meta) lines.push(meta)
  if (f.isCanonical) lines.push('canonical')
  if (f.tsl) lines.push(`TSL ${f.tsl}`)
  if (f.strand) lines.push(`${f.strand === -1 ? '-' : '+'} strand`)
  return lines.join('\n')
}

function clinvarCategory(v) {
  const significance = (v.clnsig || '').toLowerCase()
  if (/conflicting/.test(significance)) return 'conflicting'
  if (/pathogenic/.test(significance) && !/benign/.test(significance)) return 'pathogenic'
  if (/uncertain/.test(significance)) return 'uncertain'
  if (/benign/.test(significance) && !/pathogenic/.test(significance)) return 'benign'
  if (/drug response|risk factor|association|protective/.test(significance)) return 'association'
  return 'other'
}

function variantTooltip(v) {
  if (v.source === 'clinvar') {
    return [
      `${v.ref} → ${v.alt}${v.id ? ` · ClinVar Variation ID ${v.id}` : ''}`,
      `Position: ${Number(v.pos).toLocaleString()}`,
      v.clnsig ? `Clinical significance: ${v.clnsig}` : 'Clinical significance: not provided',
      v.gold_stars != null && `Review evidence: ${v.gold_stars} star${v.gold_stars === 1 ? '' : 's'}`,
      v.review_status && `Review status: ${v.review_status}`,
      v.clndn && `Condition: ${v.clndn}`,
    ].filter(Boolean).join('\n')
  }
  const common = (v.af ?? 0) >= 0.01
  return [
    `${v.ref} → ${v.alt}${v.id ? ` · ${v.id}` : ''}`,
    `Position: ${Number(v.pos).toLocaleString()}`,
    `gnomAD alternate allele frequency: ${fmtAf(v.af)}`,
    common && 'Concerning for guide design: frequency is ≥1%; cells carrying the alternate allele may reduce sgRNA annealing.',
    v.grpmax && `Highest ancestry-group frequency: ${v.grpmax} ${fmtAf(v.af_grpmax)}`,
    v.nhomalt != null && `Observed homozygotes: ${v.nhomalt.toLocaleString()}`,
  ].filter(Boolean).join('\n')
}

function fmtAf(af) {
  if (af == null) return 'not available'
  if (af === 0) return '0%'
  if (af < 0.0001) return `${(af * 100).toExponential(1)}%`
  return `${(af * 100).toFixed(af < 0.01 ? 3 : 2)}%`
}

function variantSeverity(v) {
  if (v.source === 'clinvar') return `clin-${clinvarCategory(v)}`
  return (v.af ?? 0) >= 0.01 ? 'common' : 'rare'
}

// Every base occupies a fixed-width cell, so overlay bars line up with glyphs
// without depending on the font's actual metrics.
export const CHAR_W = 9
const BASE_H = 18
const RIBBON_H = 19 // aligned guide / donor letter row
const CODON_H = 17
const VAR_H = 12
const LANE_H = 12
const FEAT_H = 20
const RULER_H = 22
const ROW_GAP = 22
const GUTTER = 18
const MIN_BPR = 30
const MAX_BPR = 240
const MAX_FEATURE_LANES = 32
const OVERSCAN = 4
const MIN_OVERVIEW_BP = 100

function formatChrom(chrom) {
  const value = String(chrom)
  return /^chr/i.test(value) ? `chr${value.slice(3)}` : `chr${value}`
}

/** Greedy interval packing; omit maxLanes to retain every item. */
function packLanes(items, maxLanes = Number.POSITIVE_INFINITY, minGap = 1) {
  const laneEnds = []
  for (const item of [...items].sort((a, b) => a.ds - b.ds)) {
    let lane = laneEnds.findIndex((end) => end < item.ds - minGap)
    if (lane === -1 && laneEnds.length < maxLanes) {
      lane = laneEnds.length
      laneEnds.push(-1)
    }
    item.lane = lane
    if (lane >= 0) laneEnds[lane] = Math.max(laneEnds[lane], item.de)
  }
  return items
}

function packFeatureLanes(items, maxLanes) {
  const genes = packLanes(items.filter((item) => item.level === 'gene'), maxLanes)
  const geneLaneCount = genes.reduce((count, item) => Math.max(count, item.lane + 1), 0)
  const others = packLanes(
    items.filter((item) => item.level !== 'gene'),
    Math.max(0, maxLanes - geneLaneCount),
    0,
  )
  for (const item of others) if (item.lane >= 0) item.lane += geneLaneCount
  return [...genes, ...others]
}


function bucketByRow(items, bpr, rowCount) {
  const rows = Array.from({ length: rowCount }, () => [])
  for (const item of items) {
    if (item.lane < 0) continue
    const first = Math.max(0, Math.floor(item.ds / bpr))
    const last = Math.min(rowCount - 1, Math.floor(item.de / bpr))
    for (let r = first; r <= last; r++) rows[r].push(item)
  }
  return rows
}

/** Remove globally reserved lanes that have no feature in a particular row. */
function compactRowLanes(rows) {
  return rows.map((items) => {
    const used = [...new Set(items.map((item) => item.lane))].sort((a, b) => a - b)
    const compact = new Map(used.map((lane, index) => [lane, index]))
    return items.map((item) => ({ ...item, lane: compact.get(item.lane) }))
  })
}

/** Pixel span of [s, e] clipped to a row, or null when they don't overlap. */
function clip(s, e, rowStart, rowEnd) {
  const a = Math.max(s, rowStart)
  const b = Math.min(e, rowEnd)
  if (b < a) return null
  return { left: (a - rowStart) * CHAR_W, width: (b - a + 1) * CHAR_W }
}

const SequenceViewer = forwardRef(function SequenceViewer(
  {
    reference,
    locusOverview,
    overviewTarget,
    edited,
    guideItems,
    featureItems,
    guideRibbon,
    donorRibbon,
    cutColumn,
    tss,
    codonCells,
    variantItems,
    focusSpan,
    nearMask,
    junctions,
    caret,
    selection,
    selectedGuideId,
    onCaretChange,
    onSelectionChange,
    onSelectGuide,
    onOverviewNavigate,
    onOverviewResize,
    onOverviewExon,
    overviewDisabled,
    onExtendLeft,
    onExtendRight,
    extensionDisabled,
    onKeyDown,
  },
  ref,
) {
  const scrollRef = useRef(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(600)
  const [bpr, setBpr] = useState(60)
  const [overviewDragPercent, setOverviewDragPercent] = useState(null)
  const [overviewResizeRange, setOverviewResizeRange] = useState(null)
  const [variantTip, setVariantTip] = useState(null)
  const dragging = useRef(false)
  const overviewDragging = useRef(false)
  const overviewResizing = useRef(null)

  const len = edited.length
  const refSeq = reference.seq

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      // Fill the available width (minus gutters) so no gap opens beside the sidebar.
      const w = entry.contentRect.width - GUTTER * 2
      const fit = Math.floor(w / CHAR_W)
      setBpr(Math.max(MIN_BPR, Math.min(fit, MAX_BPR)))
      setViewportH(entry.contentRect.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const rowCount = Math.max(1, Math.ceil(len / bpr))

  const layout = useMemo(() => {
    const fwd = packLanes(guideItems.filter((g) => g.strand === '+').map((g) => ({ ...g })))
    const rev = packLanes(guideItems.filter((g) => g.strand === '-').map((g) => ({ ...g })))
    const feats = packFeatureLanes(featureItems.map((f) => ({ ...f })), MAX_FEATURE_LANES)

    const fwdRows = bucketByRow(fwd, bpr, rowCount)
    const revRows = bucketByRow(rev, bpr, rowCount)
    const featRows = compactRowLanes(bucketByRow(feats, bpr, rowCount))

    const lanesOf = (rows) => rows.map((items) => items.reduce((m, i) => Math.max(m, i.lane + 1), 0))
    const fwdLanes = lanesOf(fwdRows)
    const revLanes = lanesOf(revRows)
    const featLanes = lanesOf(featRows)

    // Aligned letter ribbons for the selected guide/donor appear only on rows
    // their footprint touches.
    const rowHas = (span) => (r) => span && span.de >= r * bpr && span.ds <= r * bpr + bpr - 1
    const hasGuideRibbon = rowHas(guideRibbon)
    const hasDonorRibbon = rowHas(donorRibbon)

    // Variant markers bucketed by row.
    const varRows = Array.from({ length: rowCount }, () => [])
    for (const v of variantItems ?? []) {
      const r = Math.floor(v.col / bpr)
      if (r >= 0 && r < rowCount) varRows[r].push(v)
    }

    const heights = new Array(rowCount)
    const offsets = new Float64Array(rowCount + 1)
    const guideRibbonH = new Array(rowCount)
    const donorRibbonH = new Array(rowCount)
    const varH = new Array(rowCount)
    const codonH = new Array(rowCount)
    for (let r = 0; r < rowCount; r++) {
      guideRibbonH[r] = hasGuideRibbon(r) ? RIBBON_H : 0
      donorRibbonH[r] = hasDonorRibbon(r) ? RIBBON_H : 0
      varH[r] = varRows[r].length ? VAR_H : 0
      // Reserve the codon row only where the row actually contains coding bases.
      let coding = false
      if (codonCells) {
        const lo = r * bpr
        const hi = Math.min(len - 1, lo + bpr - 1)
        for (let i = lo; i <= hi; i++) if (codonCells.parity[i] >= 0) { coding = true; break }
      }
      codonH[r] = coding ? CODON_H : 0
      heights[r] =
        varH[r] + fwdLanes[r] * LANE_H + guideRibbonH[r] + BASE_H * 2 + codonH[r] +
        donorRibbonH[r] + revLanes[r] * LANE_H + featLanes[r] * FEAT_H + RULER_H + ROW_GAP
      offsets[r + 1] = offsets[r] + heights[r]
    }

    return {
      fwdRows, revRows, featRows, varRows, fwdLanes, revLanes, featLanes,
      guideRibbonH, donorRibbonH, varH, codonH, heights, offsets,
    }
  }, [guideItems, featureItems, guideRibbon, donorRibbon, variantItems, codonCells, bpr, rowCount, len])

  const totalH = layout.offsets[rowCount]

  const [firstRow, lastRow] = useMemo(() => {
    const { offsets } = layout
    const find = (y) => {
      let lo = 0
      let hi = rowCount - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (offsets[mid + 1] <= y) lo = mid + 1
        else hi = mid
      }
      return lo
    }
    return [
      Math.max(0, find(scrollTop) - OVERSCAN),
      Math.min(rowCount - 1, find(scrollTop + viewportH) + OVERSCAN),
    ]
  }, [layout, scrollTop, viewportH, rowCount])

  useImperativeHandle(ref, () => ({
    focus: () => scrollRef.current?.focus(),
    scrollToIndex(index) {
      const el = scrollRef.current
      if (!el) return
      const row = Math.floor(index / bpr)
      const y = layout.offsets[row] - el.clientHeight / 3
      el.scrollTo({ top: Math.max(0, y), behavior: 'smooth' })
    },
  }), [bpr, layout])

  const boundaryAt = useCallback((event, rowStart) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const offset = Math.round((event.clientX - rect.left) / CHAR_W)
    return Math.max(0, Math.min(len, rowStart + Math.max(0, Math.min(bpr, offset))))
  }, [bpr, len])

  const handleMouseDown = useCallback((event, rowStart) => {
    if (event.button !== 0) return
    const pos = boundaryAt(event, rowStart)
    dragging.current = true
    onCaretChange(pos)
    onSelectionChange({ anchor: pos, focus: pos })
    scrollRef.current?.focus()
    event.preventDefault()
  }, [boundaryAt, onCaretChange, onSelectionChange])

  const handleMouseMove = useCallback((event, rowStart) => {
    if (!dragging.current) return
    const pos = boundaryAt(event, rowStart)
    onCaretChange(pos)
    onSelectionChange((prev) => (prev ? { ...prev, focus: pos } : { anchor: pos, focus: pos }))
  }, [boundaryAt, onCaretChange, onSelectionChange])

  const handleDoubleClick = useCallback((event, rowStart) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const i = rowStart + Math.floor((event.clientX - rect.left) / CHAR_W)
    if (i < 0 || i >= len) return
    onSelectionChange({ anchor: i, focus: i + 1 })
    onCaretChange(i + 1)
  }, [len, onCaretChange, onSelectionChange])

  useEffect(() => {
    const stop = () => { dragging.current = false }
    window.addEventListener('mouseup', stop)
    return () => window.removeEventListener('mouseup', stop)
  }, [])

  const selStart = selection ? Math.min(selection.anchor, selection.focus) : -1
  const selEnd = selection ? Math.max(selection.anchor, selection.focus) : -1
  const hasSelection = selEnd > selStart

  const selectionSummary = useMemo(() => {
    if (!hasSelection) return null

    const selected = edited.slice(selStart, selEnd)
    let gcBases = 0
    let dnaBases = 0
    let minRef = Infinity
    let maxRef = -Infinity

    selected.forEach((record) => {
      const base = String(record.base || '').toUpperCase()
      if ('ACGT'.includes(base)) {
        dnaBases += 1
        if (base === 'G' || base === 'C') gcBases += 1
      }
      if (record.ref != null) {
        minRef = Math.min(minRef, record.ref)
        maxRef = Math.max(maxRef, record.ref)
      }
    })

    const hasReferenceRange = Number.isFinite(minRef) && Number.isFinite(maxRef)
    const range = hasReferenceRange
      ? `${formatChrom(reference.chrom)}:${(reference.start + minRef).toLocaleString()}–${(reference.start + maxRef).toLocaleString()}`
      : `edited bases ${(selStart + 1).toLocaleString()}–${selEnd.toLocaleString()}`

    return {
      count: selected.length,
      range,
      gc: dnaBases ? (gcBases / dnaBases) * 100 : 0,
    }
  }, [edited, hasSelection, reference.chrom, reference.start, selEnd, selStart])

  const overviewGeometry = useMemo(() => {
    if (!locusOverview || locusOverview.end < locusOverview.start) return null
    const span = locusOverview.end - locusOverview.start + 1
    const percent = (position) => ((position - locusOverview.start) / span) * 100
    const segment = (start, end) => {
      const clippedStart = Math.max(locusOverview.start, start)
      const clippedEnd = Math.min(locusOverview.end, end)
      if (clippedEnd < clippedStart) return null
      return {
        left: `${Math.max(0, Math.min(100, percent(clippedStart)))}%`,
        width: `${Math.max(0.18, ((clippedEnd - clippedStart + 1) / span) * 100)}%`,
      }
    }

    const laneEnds = []
    const elements = []
    for (const element of [...(locusOverview.elements ?? [])].sort((a, b) => a.start - b.start || b.end - a.end)) {
      const box = segment(element.start, element.end)
      if (!box) continue
      let lane = laneEnds.findIndex((end) => end < element.start)
      if (lane < 0) {
        if (laneEnds.length < 4) {
          lane = laneEnds.length
          laneEnds.push(-Infinity)
        } else {
          lane = laneEnds.indexOf(Math.min(...laneEnds))
        }
      }
      laneEnds[lane] = Math.max(laneEnds[lane], element.end)
      const boxLeft = parseFloat(box.left)
      const boxWidth = parseFloat(box.width)
      const exonBoxes = (element.exons ?? []).map((exon) => segment(exon.start, exon.end)).filter(Boolean).map((exon) => ({
        left: `${Math.max(0, ((parseFloat(exon.left) - boxLeft) / boxWidth) * 100)}%`,
        width: `${Math.min(100, (parseFloat(exon.width) / boxWidth) * 100)}%`,
      }))
      elements.push({ ...element, box, exonBoxes, lane })
    }

    return {
      exons: locusOverview.exons.map((exon, index) => ({ exon, index, style: segment(exon.start, exon.end) })).filter((item) => item.style),
      elements,
      laneCount: Math.max(1, laneEnds.length),
      window: segment(reference.start, reference.end),
    }
  }, [locusOverview, reference.end, reference.start])

  const overviewWindowStyle = useMemo(() => {
    if (!overviewGeometry) return null
    const overviewSpan = locusOverview.end - locusOverview.start + 1
    if (overviewResizeRange) {
      const left = ((overviewResizeRange.start - locusOverview.start) / overviewSpan) * 100
      const width = ((overviewResizeRange.end - overviewResizeRange.start + 1) / overviewSpan) * 100
      return {
        left: `${Math.max(0, Math.min(100, left))}%`,
        width: `${Math.max(0.18, Math.min(100, width))}%`,
      }
    }
    if (overviewDragPercent == null) return overviewGeometry.window
    const windowPercent = Math.min(100, ((reference.end - reference.start + 1) / overviewSpan) * 100)
    const left = Math.max(0, Math.min(100 - windowPercent, overviewDragPercent - windowPercent / 2))
    return { left: `${left}%`, width: `${windowPercent}%` }
  }, [locusOverview, overviewDragPercent, overviewGeometry, overviewResizeRange, reference.end, reference.start])

  const overviewPosition = useCallback((event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const percent = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100))
    const position = Math.round(locusOverview.start + (percent / 100) * (locusOverview.end - locusOverview.start))
    return { percent, position }
  }, [locusOverview])

  const resizedOverviewRange = useCallback((position, side = overviewResizing.current) => {
    if (side === 'start') {
      return {
        start: Math.max(locusOverview.start, Math.min(position, reference.end - MIN_OVERVIEW_BP + 1)),
        end: reference.end,
      }
    }
    return {
      start: reference.start,
      end: Math.min(locusOverview.end, Math.max(position, reference.start + MIN_OVERVIEW_BP - 1)),
    }
  }, [locusOverview.end, locusOverview.start, reference.end, reference.start])

  const handleOverviewPointerDown = useCallback((event) => {
    if (overviewDisabled || event.button !== 0) return
    const { percent } = overviewPosition(event)
    const resizeSide = event.target.closest?.('[data-overview-resize]')?.dataset.overviewResize
    if (resizeSide) {
      overviewResizing.current = resizeSide
      setOverviewResizeRange({ start: reference.start, end: reference.end })
    } else {
      overviewDragging.current = true
      setOverviewDragPercent(percent)
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }, [overviewDisabled, overviewPosition, reference.end, reference.start])

  const handleOverviewPointerMove = useCallback((event) => {
    if (overviewResizing.current) {
      setOverviewResizeRange(resizedOverviewRange(overviewPosition(event).position))
      return
    }
    if (overviewDragging.current) setOverviewDragPercent(overviewPosition(event).percent)
  }, [overviewPosition, resizedOverviewRange])

  const handleOverviewPointerUp = useCallback((event) => {
    if (!overviewDragging.current && !overviewResizing.current) return
    const { position } = overviewPosition(event)
    const resizeSide = overviewResizing.current
    overviewDragging.current = false
    overviewResizing.current = null
    setOverviewDragPercent(null)
    setOverviewResizeRange(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (resizeSide) {
      const range = resizedOverviewRange(position, resizeSide)
      onOverviewResize?.(range.start, range.end)
    } else {
      onOverviewNavigate?.(position)
    }
  }, [onOverviewNavigate, onOverviewResize, overviewPosition, resizedOverviewRange])

  const handleOverviewPointerCancel = useCallback(() => {
    overviewDragging.current = false
    overviewResizing.current = null
    setOverviewDragPercent(null)
    setOverviewResizeRange(null)
  }, [])

  const handleOverviewKeyDown = useCallback((event) => {
    if (overviewDisabled || !onOverviewNavigate) return
    const center = Math.round((reference.start + reference.end) / 2)
    const step = reference.end - reference.start + 1
    let position = null
    if (event.key === 'ArrowLeft') position = center - step
    if (event.key === 'ArrowRight') position = center + step
    if (event.key === 'Home') position = locusOverview.start
    if (event.key === 'End') position = locusOverview.end
    if (position == null) return
    event.preventDefault()
    onOverviewNavigate(Math.max(locusOverview.start, Math.min(locusOverview.end, position)))
  }, [locusOverview, onOverviewNavigate, overviewDisabled, reference.end, reference.start])

  const rows = []
  for (let r = firstRow; r <= lastRow && rowCount > 0; r++) {
    const rowStart = r * bpr
    const rowEnd = Math.min(len - 1, rowStart + bpr - 1)
    if (rowEnd < rowStart) continue

    const fwdLanes = layout.fwdLanes[r]
    const revLanes = layout.revLanes[r]
    const featLanes = layout.featLanes[r]

    const fwdChars = []
    const revChars = []
    const ticks = []

    for (let i = rowStart; i <= rowEnd; i++) {
      const rec = edited[i]
      const status = baseStatus(rec, refSeq)
      const inSel = hasSelection && i >= selStart && i < selEnd
      const cls = [
        'b', status,
        nearMask[i] ? 'near' : '',
        inSel ? 'sel' : '',
        junctions.has(i) ? 'deljunction' : '',
      ].filter(Boolean).join(' ')

      fwdChars.push(<span key={i} className={cls}>{rec.base}</span>)
      revChars.push(<span key={i} className={cls}>{complementBase(rec.base)}</span>)

      if (rec.ref != null) {
        const pos = reference.start + rec.ref
        if (pos % 10 === 0) {
          ticks.push(
            <span key={`t${i}`} className="tick" style={{ left: (i - rowStart) * CHAR_W + CHAR_W / 2 }} />,
          )
          if (pos % 20 === 0) {
            ticks.push(
              <span key={`l${i}`} className="ticklabel" style={{ left: (i - rowStart) * CHAR_W + CHAR_W / 2 }}>
                {pos.toLocaleString()}
              </span>,
            )
          }
        }
      }
    }
    if (junctions.has(len) && rowEnd === len - 1) {
      fwdChars.push(<span key="end" className="b deljunction-end" />)
    }

    const renderGuide = (g) => {
      const proto = clip(g.protoDS, g.protoDE, rowStart, rowEnd)
      const pam = clip(g.pamDS, g.pamDE, rowStart, rowEnd)
      const selected = g.id === selectedGuideId
      const dimmed = selectedGuideId && !selected
      const top = g.lane * LANE_H
      const tip =
        `${g.strand} strand · ${g.spacer} + ${g.pamSeq}\n` +
        `cut ${g.cutGenomic.toLocaleString()} · ${g.cutDist} bp from edit · GC ${(g.gc * 100).toFixed(0)}%` +
        (g.disruptsPam ? '\nedit disrupts the PAM' : g.disruptsSeed ? '\nedit disrupts the seed' : '')
      return (
        <div key={g.id} className={`gwrap${selected ? ' selected' : ''}${dimmed ? ' dimmed' : ''}`} onClick={() => onSelectGuide(g.id)}>
          {proto && (
            <div className="gbar proto"
              style={{ ...proto, top, background: g.fill }} title={tip} />
          )}
          {pam && (
            <div className={`gbar pam ${g.disruptsPam ? 'broken' : ''}`}
              style={{ ...pam, top }} title={tip} />
          )}
          {g.cutDS >= rowStart && g.cutDS <= rowEnd + 1 && (
            <div className="gcut" style={{ left: (g.cutDS - rowStart) * CHAR_W, top }} />
          )}
        </div>
      )
    }

    const focusBand = focusSpan && clip(focusSpan.ds, focusSpan.de, rowStart, rowEnd)
    const selBand = hasSelection && clip(selStart, selEnd - 1, rowStart, rowEnd)
    const caretHere = caret >= rowStart && caret <= rowEnd + 1

    // Aligned letter ribbons for the selected guide/donor.
    const guideCells = layout.guideRibbonH[r]
      ? guideRibbon.cells.filter((c) => c.col >= rowStart && c.col <= rowEnd)
      : null
    const donorCells = layout.donorRibbonH[r]
      ? donorRibbon.cells.filter((c) => c.col >= rowStart && c.col <= rowEnd)
      : null

    const ribbonBox = (cells) => cells?.length ? {
      left: (cells[0].col - rowStart) * CHAR_W,
      width: (cells[cells.length - 1].col - cells[0].col + 1) * CHAR_W,
    } : null
    const guideBox = ribbonBox(guideCells)
    const donorBox = ribbonBox(donorCells)

    const renderGuideRibbon = () => (
      <div className={`ribbon guideribbon strand-${guideRibbon.strand === '-' ? 'minus' : 'plus'}`}
        style={{ height: RIBBON_H, width: bpr * CHAR_W }}>
        {guideRibbon.ds >= rowStart && guideRibbon.ds <= rowEnd &&
          <span className={`ribbontag ${guideRibbon.strand === '-' ? 'minus' : 'plus'}`}
            style={{ left: (guideRibbon.ds - rowStart) * CHAR_W }}>
            spacer ({guideRibbon.strand})
          </span>}
        {guideBox && <span className="ribbonback"
          style={{ ...guideBox, background: guideRibbon.protoColor }} />}
        {guideCells.map((c) => (
          <span
            key={c.col}
            className={`rc${!guideRibbon.lightText ? ' dark' : ''}`}
            style={{ left: (c.col - rowStart) * CHAR_W }}
          >{c.ch}</span>
        ))}
      </div>
    )

    const donorSide = donorRibbon?.orientation === 'antisense' ? 'minus' : 'plus'
    const renderDonorRibbon = () => (
      <div className={`ribbon donorribbon strand-${donorSide}`}
        style={{ height: RIBBON_H, width: bpr * CHAR_W }}>
        {donorRibbon.ds >= rowStart && donorRibbon.ds <= rowEnd &&
          <span className={`ribbontag donor ${donorSide}`}
            style={{ left: (donorRibbon.ds - rowStart) * CHAR_W }}>
            Repair template ({donorSide === 'minus' ? '−' : '+'})
          </span>}
        {donorBox && <span className="ribbonback" style={donorBox} />}
        {donorCells.map((c) => (
          <span key={c.col} className={`rc ${c.role}`}
            style={{ left: (c.col - rowStart) * CHAR_W }}>{c.ch}</span>
        ))}
        {donorRibbon.cutCol >= rowStart && donorRibbon.cutCol <= rowEnd + 1 && (
          <span className="ribboncut" style={{ left: (donorRibbon.cutCol - rowStart) * CHAR_W }} />
        )}
      </div>
    )

    const renderFeature = (f) => {
      const box = clip(f.ds, f.de, rowStart, rowEnd)
      if (!box) return null
      const top = f.lane * FEAT_H
      const tip = featureTooltip(f)
      const displayName = f.isCanonical ? `${f.name} ★` : f.name
      const label = box.width > 42 ? displayName : ''
      if (f.level === 'transcript') {
        return (
          <Fragment key={f.id}>
            <div className="ftxline" style={{ left: box.left, width: box.width, top: top + 14 }} title={tip} />
            {(f.exons ?? []).map((ex, i) => {
              const b = clip(ex.ds, ex.de, rowStart, rowEnd)
              return b ? <div key={i} className="ftxexon" style={{ left: b.left, width: b.width, top: top + 10 }} title={tip} /> : null
            })}
            {(f.cds ?? []).map((segment, i) => {
              const b = clip(segment.ds, segment.de, rowStart, rowEnd)
              return b ? (
                <div
                  key={i}
                  className="ftxcds"
                  style={{ left: b.left, width: b.width, top: top + 9 }}
                  title={`CDS · ${f.name}`}
                />
              ) : null
            })}
            {label && <span className="ftxlabel" style={{ left: Math.max(0, box.left), top }} title={tip}>{label}</span>}
          </Fragment>
        )
      }
      return (
        <div key={f.id} className={`fbar ${f.level}${f.primary ? ' primary' : ''}`} style={{ ...box, top }} title={tip}>
          <span>{label}</span>
        </div>
      )
    }

    const varRow = layout.varH[r] ? layout.varRows[r] : null
    const showCodon = layout.codonH[r] > 0

    rows.push(
      <div key={r} className="row" style={{ position: 'absolute', top: layout.offsets[r], height: layout.heights[r], left: GUTTER }}>
        <div className="lanes" style={{ height: fwdLanes * LANE_H }}>
          {layout.fwdRows[r].map(renderGuide)}
        </div>

        {guideCells && guideRibbon.strand === '+' && renderGuideRibbon()}
        {donorCells && donorRibbon.orientation === 'sense' && renderDonorRibbon()}
        {varRow && (
          <div className="vartrack" style={{ height: VAR_H, width: bpr * CHAR_W }}>
            {varRow.map((v) => (
              <div key={`${v.pos}${v.alt}${v.source}`}
                className={`vmark ${v.source} ${variantSeverity(v)}`}
                style={{ left: (v.col - rowStart) * CHAR_W }}
                role="img"
                tabIndex={0}
                aria-label={variantTooltip(v).replaceAll('\n', '. ')}
                onPointerEnter={(event) => setVariantTip({ v, x: event.clientX, y: event.clientY })}
                onPointerMove={(event) => setVariantTip({ v, x: event.clientX, y: event.clientY })}
                onPointerLeave={() => setVariantTip(null)}
                onFocus={(event) => {
                  const box = event.currentTarget.getBoundingClientRect()
                  setVariantTip({ v, x: box.left + box.width / 2, y: box.bottom })
                }}
                onBlur={() => setVariantTip(null)} />
            ))}
          </div>
        )}

        <div
          className="strands"
          style={{ height: BASE_H * 2, width: bpr * CHAR_W }}
          onMouseDown={(e) => handleMouseDown(e, rowStart)}
          onMouseMove={(e) => handleMouseMove(e, rowStart)}
          onDoubleClick={(e) => handleDoubleClick(e, rowStart)}
        >
          {onExtendLeft && rowStart === 0 && (
            <button
              type="button"
              className="seqextend left"
              style={{ left: -16 }}
              disabled={extensionDisabled}
              title="Extend sequence 200 bp to the left"
              aria-label="Extend sequence 200 bp to the left"
              onMouseDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); onExtendLeft() }}
            >+</button>
          )}
          {onExtendRight && rowEnd === len - 1 && (
            <button
              type="button"
              className="seqextend right"
              style={{ left: (rowEnd - rowStart + 1) * CHAR_W + 2 }}
              disabled={extensionDisabled}
              title="Extend sequence 200 bp to the right"
              aria-label="Extend sequence 200 bp to the right"
              onMouseDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); onExtendRight() }}
            >+</button>
          )}
          {focusBand && <div className="focusband" style={focusBand} />}
          {selBand && <div className="selband" style={selBand} />}
          <div className="strand">{fwdChars}</div>
          <div className="strand">{revChars}</div>
          {caretHere && <div className="caret" style={{ left: (caret - rowStart) * CHAR_W }} />}
          {cutColumn != null && cutColumn >= rowStart && cutColumn <= rowEnd + 1 && (
            <div className="trackcut" style={{ left: (cutColumn - rowStart) * CHAR_W }} title="Cas9 cut site" />
          )}
          {tss && tss.col >= rowStart && tss.col <= rowEnd && (
            <div className={`tss ${tss.strand === '-' ? 'rev' : 'fwd'}`}
              style={{ left: (tss.col - rowStart) * CHAR_W }} title={`Transcription start · ${tss.name} (${tss.strand} strand)`}>
              <span className="tsslabel">TSS</span>
              <svg className="tssarrow" width="22" height="14" viewBox="0 0 22 14">
                <path d="M1 14 L1 4 L17 4" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M14 0.5 L21 4 L14 7.5 Z" fill="currentColor" />
              </svg>
            </div>
          )}
        </div>
        {guideCells && guideRibbon.strand === '-' && renderGuideRibbon()}
        {donorCells && donorRibbon.orientation === 'antisense' && renderDonorRibbon()}

        {showCodon && (
          <div className="codontrack" style={{ height: CODON_H, width: bpr * CHAR_W }}>
            {(() => {
              const cells = []
              for (let i = rowStart; i <= rowEnd; i++) {
                const p = codonCells.parity[i]
                if (p < 0) continue
                cells.push(
                  <span
                    key={i}
                    className={`cc p${p}${codonCells.changed[i] ? ' changed' : ''}${codonCells.kind[i] ? ` ${codonCells.kind[i]}` : ''}`}
                    style={{ left: (i - rowStart) * CHAR_W }}
                    title={codonCells.title[i] || undefined}
                  >
                    {codonCells.aa[i] ?? ''}
                  </span>,
                )
              }
              return cells
            })()}
          </div>
        )}


        <div className="lanes" style={{ height: revLanes * LANE_H }}>
          {layout.revRows[r].map(renderGuide)}
        </div>

        <div className="features" style={{ height: featLanes * FEAT_H }}>
          {layout.featRows[r].map(renderFeature)}
        </div>

        <div className="ruler" style={{ height: RULER_H, width: bpr * CHAR_W }}>
          <div className="rulerline" />
          {ticks}
        </div>
      </div>,
    )
  }

  const overviewTrackHeight = overviewGeometry?.elements.length
    ? Math.max(32, overviewGeometry.laneCount * 14)
    : 22
  return (
    <div className={`viewer${selectionSummary ? ' has-selection' : ''}`}>
      <div
        className="viewer-scroll"
        ref={scrollRef}
        tabIndex={0}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
      >
        <div className="canvas" style={{ height: totalH }}>{rows}</div>
      </div>
      {overviewTarget && overviewGeometry && createPortal(
        <div className="genomebar top" style={{ '--overview-track-height': `${overviewTrackHeight}px`, '--overview-height': `${overviewTrackHeight + 16}px` }}>
          <div
            className={`genomebar-track${overviewGeometry.elements.length ? ' nearby' : ''}${overviewDragPercent == null ? '' : ' dragging'}`}
            role="slider"
            tabIndex={overviewDisabled ? -1 : 0}
            aria-disabled={overviewDisabled}
            aria-valuemin={locusOverview.start}
            aria-valuemax={locusOverview.end}
            aria-valuenow={Math.max(locusOverview.start, Math.min(locusOverview.end, Math.round((reference.start + reference.end) / 2)))}
            aria-label={`${locusOverview.label}, current window ${formatChrom(reference.chrom)}:${reference.start}-${reference.end}`}
            title="Click or drag to move the displayed window. Click an exon to snap to it."
            onPointerDown={handleOverviewPointerDown}
            onPointerMove={handleOverviewPointerMove}
            onPointerUp={handleOverviewPointerUp}
            onPointerCancel={handleOverviewPointerCancel}
            onKeyDown={handleOverviewKeyDown}
          >
            {overviewGeometry.elements.length ? overviewGeometry.elements.map((element, index) => (
              <button
                type="button"
                key={element.id || index}
                className="genomebar-element"
                style={{ ...element.box, top: element.lane * 14 }}
                title={`${element.name} · ${element.biotype?.replace(/_/g, ' ') || 'gene'} · click to navigate`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onOverviewNavigate?.(Math.round((element.start + element.end) / 2))}
              >
                {element.exonBoxes.map((style, exonIndex) => (
                  <span key={exonIndex} className="genomebar-element-exon" style={style} />
                ))}
                <span className="genomebar-element-label">{element.name} <b>{element.strand === -1 ? '− ←' : '+ →'}</b></span>
              </button>
            )) : (
              <>
                <span className={`genomebar-gene ${locusOverview.strand === -1 ? 'rev' : 'fwd'}`}
                  title={locusOverview.strand === -1 ? '− strand · transcribed right to left' : '+ strand · transcribed left to right'} />
                {overviewGeometry.exons.map(({ exon, index, style }) => (
                  <button type="button" key={exon.id || index} className="genomebar-exon" style={style}
                    title={`Exon ${exon.rank ?? index + 1} · click to snap`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => onOverviewExon?.(index)} />
                ))}
              </>
            )}
            {overviewWindowStyle && (
              <span className="genomebar-window" style={overviewWindowStyle}>
                <span className="genomebar-resize left" data-overview-resize="start"
                  title="Drag to resize the left edge of the displayed window" />
                <span className="genomebar-resize right" data-overview-resize="end"
                  title="Drag to resize the right edge of the displayed window" />
              </span>
            )}
          </div>
          <span className="genomebar-range">
            <strong>{reference.seq.length.toLocaleString()} bp shown</strong>
            <span aria-hidden="true"> · </span>
            {formatChrom(locusOverview.chrom)}:{locusOverview.start.toLocaleString()}–{locusOverview.end.toLocaleString()}
          </span>
        </div>,
        overviewTarget,
      )}
      {variantTip && createPortal(
        <div
          className={`varianttip ${variantTip.v.source} ${variantSeverity(variantTip.v)}`}
          role="tooltip"
          style={{
            left: Math.max(8, Math.min(variantTip.x + 12, window.innerWidth - 330)),
            top: Math.max(8, Math.min(variantTip.y + 14, window.innerHeight - 170)),
          }}
        >
          {variantTooltip(variantTip.v).split('\n').map((line, index) => (
            <span key={index} className={index === 0 ? 'varianttip-title' : ''}>{line}</span>
          ))}
        </div>,
        document.body,
      )}
      {selectionSummary && (
        <div className="selectionbar" role="status" aria-live="polite">
          <span><strong>{selectionSummary.count.toLocaleString()}</strong> bases selected</span>
          <span>Range <strong>{selectionSummary.range}</strong></span>
          <span>GC <strong>{selectionSummary.gc.toFixed(1)}%</strong></span>
        </div>
      )}
    </div>
  )
})

export default SequenceViewer
