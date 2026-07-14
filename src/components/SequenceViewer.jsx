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

function variantTooltip(v) {
  if (v.source === 'clinvar') {
    return [
      `${v.ref}>${v.alt}${v.id ? ` (${v.id})` : ''}`,
      v.clnsig && `ClinVar: ${v.clnsig}`,
      v.clndn && v.clndn,
    ].filter(Boolean).join('\n')
  }
  return [
    `${v.ref}>${v.alt}${v.id ? ` (${v.id})` : ''}`,
    `gnomAD MAF ${fmtAf(v.af)}`,
    v.grpmax && `grpmax ${v.grpmax} ${fmtAf(v.af_grpmax)}`,
    v.nhomalt != null && `${v.nhomalt} homozygotes`,
  ].filter(Boolean).join('\n')
}

function fmtAf(af) {
  if (af == null) return 'NA'
  if (af === 0) return '0'
  return af < 0.001 ? af.toExponential(1) : af.toFixed(4)
}

function variantSeverity(v) {
  if (v.source === 'clinvar') {
    return /pathogenic/i.test(v.clnsig || '') && !/conflicting|benign/i.test(v.clnsig || '')
      ? 'path' : 'other'
  }
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
const GUTTER = 12
const MIN_BPR = 30
const MAX_BPR = 240
const MAX_FEATURE_LANES = 32
const OVERSCAN = 4

/** Greedy interval packing; omit maxLanes to retain every item. */
function packLanes(items, maxLanes = Number.POSITIVE_INFINITY) {
  const laneEnds = []
  for (const item of [...items].sort((a, b) => a.ds - b.ds)) {
    let lane = laneEnds.findIndex((end) => end < item.ds - 1)
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
    onKeyDown,
  },
  ref,
) {
  const scrollRef = useRef(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(600)
  const [bpr, setBpr] = useState(60)
  const dragging = useRef(false)

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
    const featRows = bucketByRow(feats, bpr, rowCount)

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
        {varRow && (
          <div className="vartrack" style={{ height: VAR_H, width: bpr * CHAR_W }}>
            {varRow.map((v) => (
              <div key={`${v.pos}${v.alt}${v.source}`}
                className={`vmark ${v.source} ${variantSeverity(v)}`}
                style={{ left: (v.col - rowStart) * CHAR_W }}
                title={variantTooltip(v)} />
            ))}
          </div>
        )}
        <div className="lanes" style={{ height: fwdLanes * LANE_H }}>
          {layout.fwdRows[r].map(renderGuide)}
        </div>

        {guideCells && (
          <div className="ribbon guideribbon" style={{ height: RIBBON_H, width: bpr * CHAR_W }}>
            {guideRibbon.ds >= rowStart && guideRibbon.ds <= rowEnd &&
              <span className="ribbontag" style={{ left: (guideRibbon.ds - rowStart) * CHAR_W }}>
                sgRNA {guideRibbon.strand}
              </span>}
            {guideCells.map((c) => (
              <span
                key={c.col}
                className={`rc ${c.kind}${c.kind === 'proto' && !guideRibbon.lightText ? ' dark' : ''}`}
                style={{
                  left: (c.col - rowStart) * CHAR_W,
                  background: c.kind === 'proto' ? guideRibbon.protoColor : undefined,
                }}
              >{c.ch}</span>
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

        {donorCells && (
          <div className="ribbon donorribbon" style={{ height: RIBBON_H, width: bpr * CHAR_W }}>
            {donorRibbon.ds >= rowStart && donorRibbon.ds <= rowEnd &&
              <span className="ribbontag donor" style={{ left: (donorRibbon.ds - rowStart) * CHAR_W }}>
                <span className="sc">ss</span>ODN {donorRibbon.orientation === 'antisense' ? '−' : '+'}
              </span>}
            {donorCells.map((c) => (
              <span key={c.col} className={`rc ${c.role}`} style={{ left: (c.col - rowStart) * CHAR_W }}>{c.ch}</span>
            ))}
            {donorRibbon.cutCol >= rowStart && donorRibbon.cutCol <= rowEnd + 1 && (
              <span className="ribboncut" style={{ left: (donorRibbon.cutCol - rowStart) * CHAR_W }} />
            )}
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

  return (
    <div
      className="viewer"
      ref={scrollRef}
      tabIndex={0}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
    >
      <div className="canvas" style={{ height: totalH }}>{rows}</div>
    </div>
  )
})

export default SequenceViewer
