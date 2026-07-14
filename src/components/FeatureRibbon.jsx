import { useEffect, useRef, useState } from 'react'

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

export default function FeatureRibbon({
  opts, onChange, biotypes, status, assembly, frameAvailable,
  exonNav, navigationDisabled, onSnapExon, onPreviousExon, onNextExon,
  onPanLeft, onPanRight,
}) {
  const gnomadOk = status?.gnomad?.available && assembly === status?.gnomad?.assembly
  const clinvarOk = !!status?.clinvar?.available?.[assembly]
  const currentExon = exonNav?.exons?.[exonNav.index]
  const exonLabel = currentExon
    ? `Exon ${currentExon.rank ?? exonNav.index + 1} / ${exonNav.exons.length}`
    : ''

  const setLevel = (level) => onChange({
    ...opts,
    featureLevels: { ...opts.featureLevels, [level]: !opts.featureLevels[level] },
  })
  const setTrack = (key) => onChange({ ...opts, [key]: !opts[key] })

  return (
    <div className="featureribbon">
      <div className="frgroup">
        {currentExon && (
          <div className="exonnav" title={`${exonNav.gene.name} · canonical ${exonNav.transcript.name}`}>
            <button
              type="button"
              className="frchip exonarrow exonjump"
              disabled={navigationDisabled || exonNav.index <= 0}
              title="Jump to previous canonical exon"
              aria-label="Jump to previous canonical exon"
              onClick={onPreviousExon}
            >⇤</button>
            <button
              type="button"
              className="frchip exonarrow exonpan"
              disabled={navigationDisabled}
              title="Move left by one window"
              aria-label="Move left by one window"
              onClick={onPanLeft}
            >←</button>
            <button
              type="button"
              className="frchip exoncurrent"
              disabled={navigationDisabled}
              title={`Snap to ${exonLabel} of canonical transcript ${exonNav.transcript.name}`}
              onClick={onSnapExon}
            >{exonLabel}</button>
            <button
              type="button"
              className="frchip exonarrow exonpan"
              disabled={navigationDisabled}
              title="Move right by one window"
              aria-label="Move right by one window"
              onClick={onPanRight}
            >→</button>
            <button
              type="button"
              className="frchip exonarrow exonjump"
              disabled={navigationDisabled || exonNav.index >= exonNav.exons.length - 1}
              title="Jump to next canonical exon"
              aria-label="Jump to next canonical exon"
              onClick={onNextExon}
            >⇥</button>
          </div>
        )}
        <span className="frlabel">Annotations</span>
        <Chip active={opts.featureLevels.gene} onClick={() => setLevel('gene')}>Genes</Chip>
        <Chip active={opts.featureLevels.transcript} onClick={() => setLevel('transcript')}>Transcripts</Chip>
        <BiotypeMenu biotypes={biotypes} selected={opts.biotypes} onChange={(b) => onChange({ ...opts, biotypes: b })} />
      </div>

      <div className="frgroup">
        <span className="frlabel">Tracks</span>
        <Chip active={opts.codons && frameAvailable} disabled={!frameAvailable}
          title={frameAvailable ? 'Show/hide codons and edited amino-acid consequences' : 'No CDS overlaps this sequence window'}
          onClick={() => setTrack('codons')}>Codons / AA</Chip>
        <Chip active={opts.gnomad} disabled={!gnomadOk}
          title={gnomadOk ? 'Show gnomAD variants' : 'gnomAD data not available in this environment'}
          onClick={() => setTrack('gnomad')}>gnomAD</Chip>
        <Chip active={opts.clinvar} disabled={!clinvarOk}
          title={clinvarOk ? 'Show ClinVar clinical significance' : 'ClinVar data not available in this environment'}
          onClick={() => setTrack('clinvar')}>ClinVar</Chip>
      </div>
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
