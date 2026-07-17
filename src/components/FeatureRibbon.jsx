import { useEffect, useRef, useState } from 'react'
import { CLINVAR_CATEGORIES } from '../lib/variants.js'

export const DEFAULT_GNOMAD_MAF = 1e-5
const GNOMAD_MAF_STEPS = [
  { value: 1e-7, label: '0.00001%' },
  { value: 1e-6, label: '0.0001%' },
  { value: 1e-5, label: '0.001%' },
  { value: 1e-4, label: '0.01%' },
  { value: 1e-3, label: '0.1%' },
  { value: 1e-2, label: '1%' },
  { value: 1e-1, label: '10%' },
]

function mafIndexFor(value) {
  const exact = GNOMAD_MAF_STEPS.findIndex((step) => step.value === value)
  if (exact >= 0) return exact
  return GNOMAD_MAF_STEPS.reduce((best, step, index) => (
    Math.abs(Math.log10(step.value) - Math.log10(value)) <
    Math.abs(Math.log10(GNOMAD_MAF_STEPS[best].value) - Math.log10(value)) ? index : best
  ), 0)
}

function Chip({ active, disabled, title, onClick, children }) {
  return (
    <button
      type="button"
      className={`frchip ${active ? 'on' : ''}`}
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
      <Chip active={opts.featureLevels.gene} onClick={() => setLevel('gene')}>Genes</Chip>
      <Chip active={opts.featureLevels.transcript} onClick={() => setLevel('transcript')}>Transcripts</Chip>
      {opts.featureLevels.transcript && (
        <BiotypeMenu biotypes={biotypes} selected={opts.biotypes} onChange={(b) => onChange({ ...opts, biotypes: b })} />
      )}
      <Chip active={opts.gnomad} disabled={!gnomadOk}
        title={gnomadOk ? 'Show or hide gnomAD population variants' : 'gnomAD annotations are unavailable for this genome'}
        onClick={() => setTrack('gnomad')}>gnomAD</Chip>
      {opts.gnomad && (
        <label className="mafslider" title="Minimum gnomAD minor allele frequency shown; each step changes by 10×">
          <span>MAF ≥</span>
          <input type="range" min="0" max={GNOMAD_MAF_STEPS.length - 1} step="1"
            value={mafIndex}
            aria-label="Minimum gnomAD minor allele frequency"
            onChange={(event) => onChange({ ...opts, gnomadMaf: GNOMAD_MAF_STEPS[Number(event.target.value)].value })} />
          <output>{GNOMAD_MAF_STEPS[mafIndex].label}</output>
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
  )
}

export default function FeatureRibbon({
  opts, onChange, biotypes, status, assembly, frameAvailable,
  exonNav, navigationDisabled, onSnapExon, onPreviousExon, onNextExon,
  onPanLeft, onPanRight, overviewTargetRef, locusOverview,
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
      <div className="locusidentity">
        <strong>{locusOverview?.label}</strong>
        {locusOverview?.strand && (
          <span className={`genomebar-strand ${locusOverview.strand === -1 ? 'rev' : 'fwd'}`}>
            {locusOverview.strand === -1 ? '← − strand' : '+ strand →'}
          </span>
        )}
      </div>
      {currentExon && (
        <div className="exonnav" title={`${exonNav.gene.name} · canonical ${exonNav.transcript.name}`}>
          <button
            type="button"
            className="frchip exonarrow exonpan"
            disabled={navigationDisabled}
            title="Move left by one window (Q)"
            aria-label="Move left by one window"
            onClick={onPanLeft}
          >←</button>
          <button
            type="button"
            className="frchip exonarrow exonjump"
            disabled={navigationDisabled || exonNav.index <= 0}
            title="Jump to previous canonical exon (W)"
            aria-label="Jump to previous canonical exon"
            onClick={onPreviousExon}
          >⇤</button>
          <button
            type="button"
            className="frchip exoncurrent"
            disabled={navigationDisabled}
            title={`Snap to ${exonLabel} of canonical transcript ${exonNav.transcript.name}`}
            onClick={onSnapExon}
          >{exonLabel}</button>
          <button
            type="button"
            className="frchip exonarrow exonjump"
            disabled={navigationDisabled || exonNav.index >= exonNav.exons.length - 1}
            title="Jump to next canonical exon (S)"
            aria-label="Jump to next canonical exon"
            onClick={onNextExon}
          >⇥</button>
          <button
            type="button"
            className="frchip exonarrow exonpan"
            disabled={navigationDisabled}
            title="Move right by one window (D)"
            aria-label="Move right by one window"
            onClick={onPanRight}
          >→</button>
        </div>
      )}
      <div className="overviewslot" ref={overviewTargetRef} />

    </div>
  )
}

function BiotypeMenu({ biotypes, selected, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

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
      <button type="button" className="frchip" onClick={() => setOpen((o) => !o)}>
        Biotypes ({isAll ? 'all' : `${count}/${biotypes.length}`}) ▾
      </button>
      {open && (
        <div className="biotypepop">
          <button type="button" className="btlink" onClick={() => onChange(null)}>select all</button>
          <button type="button" className="btlink" onClick={() => onChange(new Set())}>none</button>
          <div className="btlist">
            {biotypes.map((b) => (
              <label key={b} className="btrow">
                <input type="checkbox" checked={has(b)} onChange={() => toggle(b)} />
                {b.replace(/_/g, ' ')}
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

  useEffect(() => {
    if (!open) return undefined
    const onDocument = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocument)
    return () => document.removeEventListener('mousedown', onDocument)
  }, [open])

  const toggle = (id) => {
    const next = new Set(isAll ? CLINVAR_CATEGORIES.map((category) => category.id) : selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next.size === CLINVAR_CATEGORIES.length ? null : next)
  }

  return (
    <div className="biotypemenu clinvarmenu" ref={ref}>
      <button type="button" className="frchip" aria-expanded={open}
        onClick={() => setOpen((value) => !value)}>
        Significance ({isAll ? 'all' : `${count}/${CLINVAR_CATEGORIES.length}`}) ▾
      </button>
      {open && (
        <div className="biotypepop clinvarpop">
          <div className="filterlinks">
            <button type="button" className="btlink" onClick={() => onChange(null)}>All</button>
            <button type="button" className="btlink" onClick={() => onChange(new Set())}>None</button>
          </div>
          <div className="btlist">
            {CLINVAR_CATEGORIES.map((category) => (
              <label className="btrow" key={category.id}>
                <input type="checkbox" checked={isAll || selected.has(category.id)}
                  onChange={() => toggle(category.id)} />
                <span>{category.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
