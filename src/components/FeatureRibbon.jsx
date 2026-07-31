import { useEffect, useRef, useState } from 'react'
import { CLINVAR_CATEGORIES } from '../lib/variants.js'

export const DEFAULT_GNOMAD_MAF = 1e-5
const GNOMAD_MAF_STEPS = [
  { value: 1e-7, label: '0.00001%' },
  { value: 1e-6, label: '0.0001%' },
  { value: 1e-5, label: '0.001%' },
  { value: 5e-5, label: '0.005%' },
  { value: 1e-4, label: '0.01%' },
  { value: 5e-4, label: '0.05%' },
  { value: 1e-3, label: '0.1%' },
  { value: 5e-3, label: '0.5%' },
  { value: 1e-2, label: '1%' },
  { value: 5e-2, label: '5%' },
  { value: 1e-1, label: '10%' },
  { value: 1.5e-1, label: '15%' },
  { value: 2e-1, label: '20%' },
  { value: 2.5e-1, label: '25%' },
  { value: 3e-1, label: '30%' },
  { value: 3.5e-1, label: '35%' },
  { value: 4e-1, label: '40%' },
  { value: 4.5e-1, label: '45%' },
  { value: 5e-1, label: '50%' },
]

function mafIndexFor(value) {
  const exact = GNOMAD_MAF_STEPS.findIndex((step) => step.value === value)
  if (exact >= 0) return exact
  return GNOMAD_MAF_STEPS.reduce((best, step, index) => (
    Math.abs(Math.log10(step.value) - Math.log10(value)) <
    Math.abs(Math.log10(GNOMAD_MAF_STEPS[best].value) - Math.log10(value)) ? index : best
  ), 0)
}
function formatChrom(chrom) {
  return `chr${String(chrom).replace(/^chr/i, '')}`
}


function Chip({ active, disabled, title, onClick, children }) {
  return (
    <button
      type="button"
      className={`frchip ${active ? 'on' : ''}`}
      aria-pressed={active}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export function AnnotationControls({
  opts, onChange, biotypes, status, assembly, className = '',
}) {
  const setLevel = (level) => onChange({
    ...opts,
    featureLevels: { ...opts.featureLevels, [level]: !opts.featureLevels[level] },
  })
  const setTrack = (track) => onChange({ ...opts, [track]: !opts[track] })
  const gnomadOk = !!status?.gnomad?.assemblies?.[assembly]
  const clinvarOk = !!status?.clinvar?.available?.[assembly]
  const mafIndex = mafIndexFor(opts.gnomadMaf ?? DEFAULT_GNOMAD_MAF)

  return (
    <div className={`frgroup annotationsgroup${className ? ` ${className}` : ''}`}>
      <span className="frlabel">Annotations</span>
      <div className="annotationsegment modelannotations" aria-label="Gene model annotations">
        <Chip active={opts.featureLevels.gene} onClick={() => setLevel('gene')}>Genes</Chip>
        <Chip active={opts.featureLevels.transcript} onClick={() => setLevel('transcript')}>Transcripts</Chip>
        {opts.featureLevels.transcript && (
          <BiotypeMenu biotypes={biotypes} selected={opts.biotypes} onChange={(b) => onChange({ ...opts, biotypes: b })} />
        )}
      </div>
      <div className="annotationsegment variantannotations" aria-label="Variant annotations">
        <Chip active={opts.gnomad} disabled={!gnomadOk}
          title={gnomadOk ? 'Show or hide gnomAD population variants' : 'gnomAD annotations are unavailable for this genome'}
          onClick={() => setTrack('gnomad')}>gnomAD</Chip>
        {opts.gnomad && (
          <label className="annotationsetting mafslider" title="Minimum gnomAD minor allele frequency shown; common-frequency thresholds advance in 5% increments">
            <span>MAF</span>
            <input type="range" min="0" max={GNOMAD_MAF_STEPS.length - 1} step="1"
              value={mafIndex}
              aria-label="Minimum gnomAD minor allele frequency"
              onChange={(event) => onChange({ ...opts, gnomadMaf: GNOMAD_MAF_STEPS[Number(event.target.value)].value })} />
            <output>≥ {GNOMAD_MAF_STEPS[mafIndex].label}</output>
          </label>
        )}
        <Chip active={opts.clinvar} disabled={!clinvarOk}
          title={clinvarOk ? 'Show or hide ClinVar clinical annotations' : 'ClinVar annotations are unavailable for this genome'}
          onClick={() => setTrack('clinvar')}>ClinVar</Chip>
        {opts.clinvar && (
          <ClinvarMenu selected={opts.clinvarSignificances}
            onChange={(selected) => onChange({ ...opts, clinvarSignificances: selected })} />
        )}
      </div>
    </div>
  )
}

export default function FeatureRibbon({
  opts, onChange, biotypes, status, assembly, frameAvailable,
  exonNav, navigationDisabled, onSnapExon, onPreviousExon, onNextExon,
  onPanLeft, onPanRight, overviewTargetRef, locusOverview, shownBp,
}) {
  const currentExon = exonNav?.exons?.[exonNav.index]
  const exonLabel = currentExon
    ? `Exon ${currentExon.rank ?? exonNav.index + 1} / ${exonNav.exons.length}`
    : ''

  useEffect(() => {
    const onKeyDown = (event) => {
      if (navigationDisabled || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (target?.isContentEditable || target?.closest?.('input, textarea, select, .viewer-scroll, [role="dialog"]')) return

      const key = event.key.toLowerCase()
      let action = null
      if (key === 'q') action = onPanLeft
      else if (key === 'd') action = onPanRight
      else if (key === 'w' && currentExon && exonNav.index > 0) action = onPreviousExon
      else if (key === 's' && currentExon && exonNav.index < exonNav.exons.length - 1) action = onNextExon
      if (!action) return

      event.preventDefault()
      action()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [currentExon, exonNav, navigationDisabled, onNextExon, onPanLeft, onPanRight, onPreviousExon])

  return (
    <div className={`featureribbon${navigationDisabled ? ' loading' : ''}${!currentExon ? ' noexon' : ''}`}>
      <div className="locuscluster">
        <div className="locusprimary">
          <div className="locusidentity">
            <strong>{locusOverview?.label}</strong>
          </div>
          {currentExon && (
            <div className="exonnav" aria-label={`${exonNav.gene.name} canonical transcript navigation`}>
              <button type="button" className="frchip exonarrow exonpan"
                disabled={navigationDisabled} title="Slide backward"
                aria-label="Slide backward" onClick={onPanLeft}>←</button>
              <button type="button" className="frchip exonarrow exonjump"
                disabled={navigationDisabled || exonNav.index <= 0}
                title="Previous exon" aria-label="Previous exon"
                onClick={onPreviousExon}>⇤</button>
              <button type="button" className="frchip exoncurrent" disabled={navigationDisabled}
                title="Center current exon"
                onClick={onSnapExon}>{exonLabel}</button>
              <button type="button" className="frchip exonarrow exonjump"
                disabled={navigationDisabled || exonNav.index >= exonNav.exons.length - 1}
                title="Next exon" aria-label="Next exon"
                onClick={onNextExon}>⇥</button>
              <button type="button" className="frchip exonarrow exonpan"
                disabled={navigationDisabled} title="Slide forward"
                aria-label="Slide forward" onClick={onPanRight}>→</button>
            </div>
          )}
        </div>
        {locusOverview && (
          <div className="locusrange">
            <strong>{Number(shownBp || 0).toLocaleString()} bp window</strong>
            <span aria-hidden="true"> · </span>
            {formatChrom(locusOverview.chrom)}:{locusOverview.start.toLocaleString()}–{locusOverview.end.toLocaleString()}
          </div>
        )}
      </div>
      <div className="overviewslot" ref={overviewTargetRef} />
    </div>
  )
}

function useDismissMenu(open, setOpen, ref) {
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, ref, setOpen])
}

function BiotypeMenu({ biotypes, selected, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useDismissMenu(open, setOpen, ref)

  const isAll = selected == null
  const has = (b) => isAll || selected.has(b)
  const toggle = (b) => {
    const next = new Set(isAll ? biotypes : selected)
    if (next.has(b)) next.delete(b)
    else next.add(b)
    onChange(next.size === biotypes.length ? null : next)
  }

  if (!biotypes.length) return null
  const count = isAll ? biotypes.length : selected.size

  return (
    <div className="biotypemenu" ref={ref}>
      <button type="button" className={`frchip filterchip${open ? ' open' : ''}${isAll ? '' : ' filtered'}`}
        aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((value) => !value)}>
        <span>Biotypes</span><b>{isAll ? 'All' : `${count}/${biotypes.length}`}</b><i aria-hidden="true">⌄</i>
      </button>
      {open && (
        <div className="biotypepop" role="menu" aria-label="Transcript biotype filters">
          <div className="filterpophead"><strong>Transcript biotypes</strong><span>{count} of {biotypes.length}</span></div>
          <div className="filterlinks">
            <button type="button" className="btlink" onClick={() => onChange(null)}>All</button>
            <button type="button" className="btlink" onClick={() => onChange(new Set())}>None</button>
          </div>
          <div className="btlist">
            {biotypes.map((b) => (
              <label key={b} className="btrow">
                <input type="checkbox" checked={has(b)} onChange={() => toggle(b)} />
                <span>{b.replace(/_/g, ' ')}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ClinvarMenu({ selected, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const isAll = selected == null
  const count = isAll ? CLINVAR_CATEGORIES.length : selected.size

  useDismissMenu(open, setOpen, ref)

  const toggle = (id) => {
    const next = new Set(isAll ? CLINVAR_CATEGORIES.map((category) => category.id) : selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next.size === CLINVAR_CATEGORIES.length ? null : next)
  }

  return (
    <div className="biotypemenu clinvarmenu" ref={ref}>
      <button type="button" className={`frchip filterchip${open ? ' open' : ''}${isAll ? '' : ' filtered'}`}
        aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((value) => !value)}>
        <span>Significance</span><b>{isAll ? 'All' : `${count}/${CLINVAR_CATEGORIES.length}`}</b><i aria-hidden="true">⌄</i>
      </button>
      {open && (
        <div className="biotypepop clinvarpop" role="menu" aria-label="ClinVar significance filters">
          <div className="filterpophead"><strong>Clinical significance</strong><span>{count} of {CLINVAR_CATEGORIES.length}</span></div>
          <div className="filterlinks">
            <button type="button" className="btlink" onClick={() => onChange(null)}>All</button>
            <button type="button" className="btlink" onClick={() => onChange(new Set())}>None</button>
          </div>
          <div className="btlist">
            {CLINVAR_CATEGORIES.map((category) => (
              <label className="btrow" key={category.id}>
                <input type="checkbox" checked={isAll || selected.has(category.id)} onChange={() => toggle(category.id)} />
                <i className={`filterdot clin-${category.id}`} aria-hidden="true" />
                <span>{category.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
