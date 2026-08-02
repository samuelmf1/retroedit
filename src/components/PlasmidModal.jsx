import { useCallback, useEffect, useMemo, useState } from 'react'

let templateRequest = null
const loadTemplate = () => {
  if (!templateRequest) {
    templateRequest = fetch('/api/plasmid/template').then(async (response) => {
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail || 'Plasmid template is unavailable')
      return response.json()
    }).catch((error) => { templateRequest = null; throw error })
  }
  return templateRequest
}

const MAIN_FEATURES = new Set([
  'U6 promoter', 'Starting G', "MSR 5' conserved region", 'AATD-02-MSD',
  "MSR 3' conserved region", 'pol3 terminator', 'AmpR', 'AmpR promoter', 'ori',
])

// Keep the circular view focused on the design and major backbone landmarks.
// Secondary feature names remain available in the inspector and linear view.
const CIRCULAR_LABEL_LAYOUT = {
  'U6 promoter': { radius: 52 },
  'Starting G': { radius: 36, angle: -5 },
  'Spacer': { radius: 72, angle: -2 },
  'Scaffold': { radius: 78, angle: 4 },
  'AATD-02-MSD': { radius: 54 },
  'Repair template': { radius: 54 },
  'AmpR': { radius: 48 },
  'ori': { radius: 48 },
}

const FEATURE_COLORS = {
  'U6 promoter': '#8cb9db',
  'Starting G': '#111827',
  "MSR 5' conserved region": '#b9c4cc',
  'AATD-02-MSD': '#313b47',
  "MSR 3' conserved region": '#93a4af',
  'pol3 terminator': '#9aa7b4',
  'AmpR': '#8bcf9a',
  'AmpR promoter': '#b8dfc0',
  'ori': '#f1cf32',
  'Spacer': '#2f6fed',
  'Scaffold': '#7b3fe4',
  'Repair template': '#18a56f',
}

const featureColor = (feature) => FEATURE_COLORS[feature.label] || '#788896'

function assemblePlasmid(template, spacer, scaffold, scaffoldLabel, repairTemplate) {
  const guideAt = template.anchors.guide_insert_after
  const repairAt = template.anchors.repair_insert_after
  const guideInsert = `${spacer}${scaffold}`.toUpperCase()
  const repairInsert = repairTemplate.toUpperCase()
  const sequence = template.sequence.slice(0, guideAt) + guideInsert +
    template.sequence.slice(guideAt, repairAt) + repairInsert + template.sequence.slice(repairAt)
  const guideDelta = guideInsert.length
  const repairStart = repairAt + guideDelta

  const mapStart = (position) => position + (position >= guideAt ? guideDelta : 0) +
    (position >= repairAt ? repairInsert.length : 0)
  const mapEnd = (position) => position + (position > guideAt ? guideDelta : 0) +
    (position > repairAt ? repairInsert.length : 0)

  const features = template.features.map((feature) => ({
    ...feature,
    start: mapStart(feature.start),
    end: mapEnd(feature.end),
  }))
  features.push(
    { id: 'user-spacer', label: 'Spacer', type: 'guide', strand: 1, start: guideAt, end: guideAt + spacer.length, inserted: true },
    { id: 'user-scaffold', label: 'Scaffold', detail: scaffoldLabel, type: 'guide', strand: 1, start: guideAt + spacer.length, end: guideAt + guideInsert.length, inserted: true },
    { id: 'user-repair', label: 'Repair template', type: 'repair', strand: 1, start: repairStart, end: repairStart + repairInsert.length, inserted: true },
  )
  return {
    name: `${template.name}_designed`,
    sequence,
    features,
    insertions: features.filter((feature) => feature.inserted),
  }
}

function polar(cx, cy, radius, degrees) {
  const radians = (degrees - 90) * Math.PI / 180
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) }
}

function arcPath(start, end, length, radius, cx, cy) {
  const startAngle = (start / length) * 360
  const endAngle = (end / length) * 360
  const a = polar(cx, cy, radius, startAngle)
  const b = polar(cx, cy, radius, endAngle)
  return `M ${a.x} ${a.y} A ${radius} ${radius} 0 ${endAngle - startAngle > 180 ? 1 : 0} 1 ${b.x} ${b.y}`
}

function mapFeatures(design) {
  return design.features.filter((feature) => feature.inserted || MAIN_FEATURES.has(feature.label))
}

function featureTitle(feature) {
  return `${feature.label} · ${(feature.start + 1).toLocaleString()}–${feature.end.toLocaleString()} · ${feature.end - feature.start} bp`
}

function CircularMap({ design, features, selected, onSelect, viewBox, gestureProps }) {
  const cx = 350
  const cy = 330
  const radius = 210
  const ticks = Array.from({ length: Math.ceil(design.sequence.length / 500) }, (_, index) => index * 500)
  return (
    <svg className="plasmidmap circular" viewBox={viewBox} aria-label={`Circular map of ${design.name}`}
      {...gestureProps}>
      <circle cx={cx} cy={cy} r={radius + 5} className="plasmidbackboneouter" />
      <circle cx={cx} cy={cy} r={radius} className="plasmidbackboneinner" />
      {ticks.map((position) => {
        const degrees = position / design.sequence.length * 360
        const outer = polar(cx, cy, radius + 10, degrees)
        const inner = polar(cx, cy, radius - 8, degrees)
        const label = polar(cx, cy, radius - 25, degrees)
        const showLabel = position % 1000 === 0
        return <g key={position}><line className="plasmidtickline" x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} />
          {showLabel && <text x={label.x} y={label.y} textAnchor="middle" dominantBaseline="middle"
            className="plasmidtick">{position.toLocaleString()}</text>}</g>
      })}
      {features.map((feature) => {
        const middle = ((feature.start + feature.end) / 2) / design.sequence.length * 360
        const config = CIRCULAR_LABEL_LAYOUT[feature.label]
        const labelAngle = middle + (config?.angle ?? 0)
        const labelRadius = radius + (config?.radius ?? 0)
        const label = config ? polar(cx, cy, labelRadius, labelAngle) : null
        const leaderEnd = config ? polar(cx, cy, labelRadius - 8, labelAngle) : null
        const leaderStart = polar(cx, cy, radius + 9, middle)
        const active = selected?.id === feature.id
        return (
          <g key={feature.id} className={`plasmidfeature${active ? ' active' : ''}`}
            role="button" tabIndex={0} onClick={() => onSelect(feature)}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(feature) }}>
            <title>{featureTitle(feature)}</title>
            <path d={arcPath(feature.start, feature.end, design.sequence.length, radius, cx, cy)}
              fill="none" stroke={featureColor(feature)} strokeWidth={feature.inserted ? 20 : 14} strokeLinecap="round" />
            {config && <>
              <line x1={leaderStart.x} y1={leaderStart.y} x2={leaderEnd.x} y2={leaderEnd.y}
                stroke={featureColor(feature)} strokeWidth="1" />
              <text x={label.x} y={label.y} textAnchor={label.x < cx ? 'end' : 'start'}
                dominantBaseline="middle" fill={featureColor(feature)} className="plasmidfeaturelabel">{feature.label}</text>
            </>}
          </g>
        )
      })}
      <text x={cx} y={cy - 12} textAnchor="middle" className="plasmidname">pWB366 designed plasmid</text>
      <text x={cx} y={cy + 15} textAnchor="middle" className="plasmidsize">{design.sequence.length.toLocaleString()} bp</text>
    </svg>
  )
}

function LinearMap({ design, features, selected, onSelect, viewBox, gestureProps }) {
  const left = 70
  const width = 1060
  const xFor = (position) => left + position / design.sequence.length * width
  const ticks = Array.from({ length: Math.ceil(design.sequence.length / 250) + 1 }, (_, index) => index * 250)
    .filter((position) => position <= design.sequence.length)
  return (
    <svg className="plasmidmap linear" viewBox={viewBox} aria-label={`Linearized map of ${design.name}`}
      {...gestureProps}>
      <text x="600" y="46" textAnchor="middle" className="plasmidname">pWB366 designed plasmid · linearized at base 1</text>
      <line x1={left} x2={left + width} y1="108" y2="108" className="linearbackbone" />
      {ticks.map((position) => {
        const x = xFor(position)
        return <g key={position}><line x1={x} x2={x} y1="99" y2="117" className="lineartick" />
          <text x={x} y="88" textAnchor="middle" className="plasmidtick">{position.toLocaleString()}</text></g>
      })}
      {features.map((feature, index) => {
        const x = xFor(feature.start)
        const featureWidth = Math.max(8, xFor(feature.end) - x)
        const lane = index % 4
        const y = 145 + lane * 67
        const active = selected?.id === feature.id
        return (
          <g key={feature.id} className={`linearfeature plasmidfeature${active ? ' active' : ''}`}
            role="button" tabIndex={0} onClick={() => onSelect(feature)}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(feature) }}>
            <title>{featureTitle(feature)}</title>
            <line x1={x + featureWidth / 2} x2={x + featureWidth / 2} y1="108" y2={y} className="featureleader" />
            <rect x={x} y={y} width={featureWidth} height="24" rx="6" fill={featureColor(feature)} />
            <text x={Math.max(left + 5, Math.min(left + width - 5, x + featureWidth / 2))} y={y + 41}
              textAnchor="middle" className="linearfeaturelabel">{feature.label}</text>
          </g>
        )
      })}
      <text x={left} y="430" className="linearend">1</text>
      <text x={left + width} y="430" textAnchor="end" className="linearend">{design.sequence.length.toLocaleString()} bp</text>
    </svg>
  )
}

function FeatureInspector({ features, selected, onSelect }) {
  return (
    <aside className="plasmidlegend">
      <div className="plasmidlegendhead"><h3>Construct features</h3><span>{features.length}</span></div>
      <div className="plasmidfeaturelist">
        {features.map((feature) => (
          <button type="button" key={feature.id} className={selected?.id === feature.id ? 'active' : ''}
            onClick={() => onSelect(feature)}>
            <i style={{ background: featureColor(feature) }} />
            <span>{feature.label}{feature.detail ? <small>{feature.detail}</small> : null}</span>
            {feature.inserted && <b>DESIGN</b>}
            <em>{feature.end - feature.start} bp</em>
          </button>
        ))}
      </div>
      {selected && <div className="plasmiddetail">
        <div><i style={{ background: featureColor(selected) }} /><strong>{selected.label}</strong>{selected.inserted && <b>DESIGN</b>}</div>
        <span>{(selected.start + 1).toLocaleString()}–{selected.end.toLocaleString()} · {selected.end - selected.start} bp</span>
        <span>{selected.strand === -1 ? 'Reverse strand' : 'Forward strand'}{selected.detail ? ` · ${selected.detail}` : ''}</span>
      </div>}
    </aside>
  )
}

function PlasmidMap({ design }) {
  const features = mapFeatures(design)
  const [selected, setSelected] = useState(design.insertions[0])
  const [layout, setLayout] = useState('circle')
  const baseView = layout === 'circle' ? { width: 700, height: 660 } : { width: 1200, height: 460 }
  const [mapView, setMapView] = useState({ scale: 1, cx: 350, cy: 330 })
  useEffect(() => setSelected(design.insertions[0]), [design])
  useEffect(() => {
    setMapView({ scale: 1, cx: baseView.width / 2, cy: baseView.height / 2 })
  }, [layout]) // eslint-disable-line react-hooks/exhaustive-deps

  const zoomAt = useCallback((factor, clientX, clientY, element) => {
    if (!Number.isFinite(factor) || factor <= 0 || !element) return
    const rect = element.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const fx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const fy = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    setMapView((current) => {
      const nextScale = Math.max(1, Math.min(6, current.scale * factor))
      if (Math.abs(nextScale - current.scale) < 0.001) return current
      const currentWidth = baseView.width / current.scale
      const currentHeight = baseView.height / current.scale
      const currentLeft = current.cx - currentWidth / 2
      const currentTop = current.cy - currentHeight / 2
      const anchorX = currentLeft + fx * currentWidth
      const anchorY = currentTop + fy * currentHeight
      const nextWidth = baseView.width / nextScale
      const nextHeight = baseView.height / nextScale
      const unclampedCx = anchorX + (0.5 - fx) * nextWidth
      const unclampedCy = anchorY + (0.5 - fy) * nextHeight
      return {
        scale: nextScale,
        cx: Math.max(nextWidth / 2, Math.min(baseView.width - nextWidth / 2, unclampedCx)),
        cy: Math.max(nextHeight / 2, Math.min(baseView.height - nextHeight / 2, unclampedCy)),
      }
    })
  }, [baseView.height, baseView.width])

  const zoomFromCenter = useCallback((factor) => {
    setMapView((current) => ({ ...current, scale: Math.max(1, Math.min(6, current.scale * factor)) }))
  }, [])

  const gestureProps = {
    onWheel: (event) => {
      // Trackpad pinch arrives as Ctrl/Command + wheel. Leave that gesture to
      // the browser; map zoom is deliberately gated behind Shift.
      if (!event.shiftKey || event.ctrlKey || event.metaKey) return
      event.preventDefault()
      zoomAt(Math.exp(-event.deltaY * 0.008), event.clientX, event.clientY, event.currentTarget)
    },
    onDoubleClick: () => setMapView({ scale: 1, cx: baseView.width / 2, cy: baseView.height / 2 }),
  }
  const visibleWidth = baseView.width / mapView.scale
  const visibleHeight = baseView.height / mapView.scale
  const viewBox = `${mapView.cx - visibleWidth / 2} ${mapView.cy - visibleHeight / 2} ${visibleWidth} ${visibleHeight}`
  return (
    <div className="plasmidmapview">
      <div className="plasmidmaptoolbar">
        <div className="mapmodes" role="group" aria-label="Plasmid map layout">
          <button type="button" className={layout === 'circle' ? 'active' : ''}
            aria-pressed={layout === 'circle'} onClick={() => setLayout('circle')}>○ Circular</button>
          <button type="button" className={layout === 'linear' ? 'active' : ''}
            aria-pressed={layout === 'linear'} onClick={() => setLayout('linear')}>↔ Linearized</button>
        </div>
        <span>Click a feature to inspect it · Shift + scroll to zoom the map · normal pinch zooms the page.</span>
        <div className="plasmidzoomcontrols" role="group" aria-label="Plasmid map zoom">
          <button type="button" aria-label="Zoom plasmid map out" title="Zoom map out"
            disabled={mapView.scale <= 1} onClick={() => zoomFromCenter(1 / 1.35)}>−</button>
          <span>{Math.round(mapView.scale * 100)}%</span>
          <button type="button" aria-label="Zoom plasmid map in" title="Zoom map in"
            disabled={mapView.scale >= 6} onClick={() => zoomFromCenter(1.35)}>+</button>
        </div>
        <div className="cargokeys">
          {design.insertions.map((feature) => <span key={feature.id}><i style={{ background: featureColor(feature) }} />{feature.label}</span>)}
        </div>
      </div>
      <div className={`plasmidmaplayout ${layout}`}>
        {layout === 'circle'
          ? <CircularMap design={design} features={features} selected={selected} onSelect={setSelected}
            viewBox={viewBox} gestureProps={gestureProps} />
          : <LinearMap design={design} features={features} selected={selected} onSelect={setSelected}
            viewBox={viewBox} gestureProps={gestureProps} />}
        <FeatureInspector features={features} selected={selected} onSelect={setSelected} />
      </div>
    </div>
  )
}

const COMPLEMENT = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N' }
const complement = (sequence) => [...sequence].map((base) => COMPLEMENT[base] || 'N').join('')

function sequenceSegments(design, start, end) {
  const inserted = design.insertions
  const segments = []
  let cursor = start
  while (cursor < end) {
    const feature = inserted.find((item) => cursor >= item.start && cursor < item.end)
    let next = end
    if (feature) next = Math.min(end, feature.end)
    else {
      const upcoming = inserted.filter((item) => item.start > cursor).sort((a, b) => a.start - b.start)[0]
      if (upcoming) next = Math.min(end, upcoming.start)
    }
    segments.push({ start: cursor, text: design.sequence.slice(cursor, next), feature })
    cursor = next
  }
  return segments
}

function PlasmidSequence({ design }) {
  const width = 60
  const rows = Array.from({ length: Math.ceil(design.sequence.length / width) }, (_, index) => index * width)
  return (
    <div className="plasmidsequence">
      <div className="sequencelegend">
        {design.insertions.map((feature) => <span key={feature.id}><i style={{ background: featureColor(feature) }} />{feature.label}</span>)}
      </div>
      <div className="sequencebody">
        {rows.map((start) => {
          const end = Math.min(design.sequence.length, start + width)
          const segments = sequenceSegments(design, start, end)
          return (
            <div className="plasmidseqrow" key={start}>
              <span className="seqcoord">{(start + 1).toLocaleString()}</span>
              <code className="plasmidbases top">{segments.map((segment) => <span key={segment.start}
                style={segment.feature ? { background: `${featureColor(segment.feature)}33`, color: featureColor(segment.feature) } : null}
                title={segment.feature?.label}>{segment.text}</span>)}</code>
              <code className="plasmidbases bottom">{complement(design.sequence.slice(start, end))}</code>
              <span className="seqcoord end">{end.toLocaleString()}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function PlasmidModal({ open, onClose, spacer, scaffold, scaffoldLabel, repairTemplate }) {
  const [template, setTemplate] = useState(null)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('map')

  useEffect(() => {
    if (!open) return undefined
    let active = true
    setError(null)
    loadTemplate().then((data) => { if (active) setTemplate(data) }).catch((err) => { if (active) setError(err.message) })
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      active = false
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  const design = useMemo(() => template && assemblePlasmid(
    template, spacer, scaffold, scaffoldLabel, repairTemplate,
  ), [template, spacer, scaffold, scaffoldLabel, repairTemplate])

  if (!open) return null
  return (
    <div className="plasmidmodal" role="dialog" aria-modal="true" aria-label="Designed plasmid map">
      <header className="plasmidmodalhead">
        <button type="button" className="plasmidclose" onClick={onClose} aria-label="Exit plasmid viewer">
          <span aria-hidden="true">←</span> Exit map
        </button>
        <div><strong>Designed pWB366 plasmid</strong><span>{design ? `${design.sequence.length.toLocaleString()} bp` : 'Loading template…'}</span></div>
        <nav aria-label="Plasmid views">
          <button type="button" className={tab === 'map' ? 'active' : ''} onClick={() => setTab('map')}>Map</button>
          <button type="button" className={tab === 'sequence' ? 'active' : ''} onClick={() => setTab('sequence')}>Sequence</button>
        </nav>
      </header>
      <div className="plasmidmodalbody">
        {error && <div className="plasmiderror">{error}</div>}
        {!error && !design && <div className="plasmidloading">Loading annotated SnapGene template…</div>}
        {design && (tab === 'map' ? <PlasmidMap design={design} /> : <PlasmidSequence design={design} />)}
      </div>
    </div>
  )
}
