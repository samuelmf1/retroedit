import { useEffect, useMemo, useRef, useState } from 'react'
import { CLINVAR_CATEGORIES, DEFAULT_GNOMAD_MAF } from '../lib/variants.js'
import { fetchGtexExpression } from '../lib/genomics.js'

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

function formatTpm(value) {
  if (value >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (value >= 100) return value.toFixed(1)
  if (value >= 10) return value.toFixed(2)
  if (value >= 1) return value.toFixed(2)
  return value.toFixed(3)
}

function GtexExpression({ assembly, gene }) {
  const [requestKey, setRequestKey] = useState(0)
  const [state, setState] = useState({ status: 'idle', payload: null, error: '' })

  useEffect(() => {
    if (assembly !== 'GRCh38' || !gene) {
      setState({ status: 'empty', payload: null, error: '' })
      return undefined
    }
    const controller = new AbortController()
    setState({ status: 'loading', payload: null, error: '' })
    fetchGtexExpression(gene, controller.signal).then((payload) => {
      setState({ status: payload?.rows?.length ? 'ready' : 'empty', payload, error: '' })
    }).catch((error) => {
      if (error.name !== 'AbortError') {
        setState({ status: 'error', payload: null, error: error.message || 'GTEx request failed' })
      }
    })
    return () => controller.abort()
  }, [assembly, gene, requestKey])

  const tissues = useMemo(() => {
    const grouped = new Map()
    for (const row of state.payload?.rows ?? []) {
      const tissue = row.tissueSiteDetailId || row.tissueSiteDetail || row.tissue || ''
      const median = Number(row.median)
      if (!tissue || !Number.isFinite(median)) continue
      const aggregate = grouped.get(tissue) ?? { sum: 0, count: 0 }
      aggregate.sum += median
      aggregate.count += 1
      grouped.set(tissue, aggregate)
    }
    return [...grouped].map(([id, aggregate]) => ({
      id, label: id.replaceAll('_', ' '), tpm: aggregate.sum / aggregate.count,
    })).sort((a, b) => b.tpm - a.tpm || a.label.localeCompare(b.label))
  }, [state.payload])

  const maximum = tissues[0]?.tpm ?? 0
  return (
    <section className="gtexpanel" aria-label={`GTEx tissue expression${gene ? ` for ${gene}` : ''}`}>
      <header>
        <span><strong>GTEx tissue expression</strong><small>Median TPM</small></span>
        {state.payload?.gencodeId && <code title="GENCODE v39 · GRCh38">{state.payload.gencodeId}</code>}
      </header>
      {state.status === 'loading' && (
        <div className="gtexloading" role="status" aria-live="polite">
          <span>Loading GTEx expression…</span>
          {[82, 61, 44, 30].map((width) => <i key={width} style={{ '--gtex-width': `${width}%` }} />)}
        </div>
      )}
      {state.status === 'error' && (
        <div className="gtexmessage" role="alert">
          <span>GTEx expression could not be loaded.</span>
          <button type="button" onClick={() => setRequestKey((value) => value + 1)}>Retry</button>
        </div>
      )}
      {state.status === 'empty' && (
        <div className="gtexmessage">
          {assembly === 'GRCh38' && gene
            ? 'No GTEx median expression data found.'
            : 'GTEx expression is available for human GRCh38 genes.'}
        </div>
      )}
      {state.status === 'ready' && (
        <div className="gtexbars" role="list" aria-label={`${tissues.length} tissues, sorted by median TPM`}>
          {tissues.map((tissue) => (
            <div className="gtexbar" role="listitem" key={tissue.id}
              title={`${tissue.label}: ${formatTpm(tissue.tpm)} TPM`}>
              <span>{tissue.label}</span>
              <i><b style={{ width: `${maximum > 0 ? (tissue.tpm / maximum) * 100 : 0}%` }} /></i>
              <output>{formatTpm(tissue.tpm)}</output>
            </div>
          ))}
        </div>
      )}
    </section>
  )
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

function CompactSelect({ value, options, onChange, disabled = false, ariaLabel }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useDismissMenu(open, setOpen, ref)
  const selected = options.find((option) => String(option.value) === String(value)) ?? options[0]

  return (
    <div className={`compactselect${open ? ' open' : ''}`} ref={ref}>
      <button type="button" className="compactselect-trigger" disabled={disabled}
        aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}
        onClick={() => setOpen((current) => !current)}>
        <span>{selected?.label ?? 'Choose'}</span><i aria-hidden="true" />
      </button>
      {open && (
        <div className="compactselect-options" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => {
            const active = String(option.value) === String(value)
            return (
              <button type="button" role="option" aria-selected={active}
                className={active ? 'selected' : ''} key={String(option.value)}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}>
                <span>{option.label}</span><i aria-hidden="true" />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}


function CompactClinvarMultiSelect({ enabled, selected, onChange, disabled = false, showHidden = true }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const isAll = selected == null
  const count = isAll ? CLINVAR_CATEGORIES.length : selected.size
  useDismissMenu(open, setOpen, ref)

  const setAll = () => onChange({ enabled: true, selected: null })
  const setNone = () => onChange({ enabled: true, selected: new Set() })
  const setHidden = () => onChange({ enabled: false, selected })
  const toggle = (id) => {
    const next = new Set(!enabled
      ? []
      : isAll
        ? CLINVAR_CATEGORIES.map((category) => category.id)
        : selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange({
      enabled: true,
      selected: next.size === CLINVAR_CATEGORIES.length ? null : next,
    })
  }

  const summary = disabled
    ? 'Unavailable'
    : !enabled
      ? 'Hidden'
      : isAll
        ? 'All significances'
        : count === 0
          ? 'None selected'
          : `${count} selected`

  return (
    <div className={`compactselect compactmultiselect${open ? ' open' : ''}`} ref={ref}>
      <button type="button" className="compactselect-trigger" disabled={disabled}
        aria-label="ClinVar clinical significance" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((current) => !current)}>
        <span>{summary}</span><i aria-hidden="true" />
      </button>
      {open && (
        <div className="compactselect-options compactmultiselect-options" role="menu"
          aria-label="ClinVar clinical significance filters">
          <div className={`compactmultiselect-actions${showHidden ? '' : ' filters-only'}`}>
            {showHidden && (
              <button type="button" className={!enabled ? 'selected' : ''}
                onClick={setHidden}><span>Hidden</span><i aria-hidden="true" /></button>
            )}
            <button type="button" className={enabled && isAll ? 'selected' : ''}
              onClick={setAll}><span>All significances</span><i aria-hidden="true" /></button>
            {!showHidden && (
              <button type="button" className={enabled && !isAll && count === 0 ? 'selected' : ''}
                onClick={setNone}><span>Deselect all</span><i aria-hidden="true" /></button>
            )}
          </div>
          <div className="compactmultiselect-list">
            {CLINVAR_CATEGORIES.map((category) => (
              <label key={category.id} className="compactmultiselect-row">
                <input type="checkbox"
                  checked={enabled && (isAll || selected.has(category.id))}
                  onChange={() => toggle(category.id)} />
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

export function AnnotationControls({
  opts, onChange, biotypes, status, assembly, className = '', compact = false,
}) {
  const setLevel = (level) => onChange({
    ...opts,
    featureLevels: { ...opts.featureLevels, [level]: !opts.featureLevels[level] },
  })
  const setTrack = (track) => onChange({ ...opts, [track]: !opts[track] })
  const gnomadOk = !!status?.gnomad?.assemblies?.[assembly]
  const clinvarOk = !!status?.clinvar?.available?.[assembly]
  const mafIndex = mafIndexFor(opts.gnomadMaf ?? DEFAULT_GNOMAD_MAF)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)
  useDismissMenu(menuOpen, setMenuOpen, menuRef)

  const geneMode = `${opts.featureLevels.gene ? 'gene' : ''}${opts.featureLevels.transcript ? '+transcript' : ''}` || 'off'
  const activeCount = Number(!!opts.featureLevels.gene) + Number(!!opts.featureLevels.transcript)
    + Number(!!opts.gnomad) + Number(!!opts.clinvar)
  const geneOptions = [
    { value: 'off', label: 'Hidden' },
    { value: 'gene', label: 'Genes' },
    { value: '+transcript', label: 'Transcripts' },
    { value: 'gene+transcript', label: 'Genes + transcripts' },
  ]
  if (compact) {
    return (
      <div className={`annotationmenu${className ? ` ${className}` : ''}`} ref={menuRef}>
        <button type="button" className={`annotationmenusummary${menuOpen ? ' open' : ''}`}
          aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((open) => !open)}>
          <span className="annotationmenuicon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M3 6h18M3 12h18M3 18h18" />
              <rect x="5" y="3.5" width="6" height="5" rx="1" />
              <rect x="13" y="9.5" width="7" height="5" rx="1" />
              <rect x="7" y="15.5" width="5" height="5" rx="1" />
            </svg>
          </span>
          <span>Annotations</span><b>{activeCount} on</b><i aria-hidden="true" />
        </button>
        {menuOpen && (
          <div className="annotationmenupop" role="menu" aria-label="Sequence annotations">
            <div className="annotationselectgrid">
              <div className={`annotationselectfield ${geneMode !== 'off' ? 'enabled' : ''}`}>
                <span>Gene models</span>
                <CompactSelect value={geneMode} options={geneOptions} ariaLabel="Gene model annotations"
                  onChange={(value) => onChange({
                    ...opts,
                    featureLevels: {
                      ...opts.featureLevels,
                      gene: value === 'gene' || value === 'gene+transcript',
                      transcript: value === '+transcript' || value === 'gene+transcript',
                    },
                  })} />
              </div>

              {opts.featureLevels.transcript && (
                <div className="annotationselectfield enabled secondary">
                  <span>Transcript biotypes</span>
                  <BiotypeMenu biotypes={biotypes} selected={opts.biotypes}
                    onChange={(selected) => onChange({ ...opts, biotypes: selected })} />
                </div>
              )}

              <div className={`annotationselectfield trackfield ${opts.gnomad ? 'enabled' : ''}`}>
                <button type="button" className={`annotationtracktoggle${opts.gnomad ? ' active' : ''}`}
                  aria-pressed={opts.gnomad} disabled={!gnomadOk}
                  onClick={() => setTrack('gnomad')}>
                  <i aria-hidden="true" /><span>gnomAD variants</span>
                </button>
                {opts.gnomad && (
                  <label className="compactmafslider" title="Minimum gnomAD minor allele frequency shown">
                    <input type="range" min="0" max={GNOMAD_MAF_STEPS.length - 1} step="1"
                      value={mafIndex} aria-label="Minimum gnomAD minor allele frequency"
                      onChange={(event) => onChange({
                        ...opts,
                        gnomadMaf: GNOMAD_MAF_STEPS[Number(event.target.value)].value,
                      })} />
                    <output>MAF ≥ {GNOMAD_MAF_STEPS[mafIndex].label}</output>
                  </label>
                )}
              </div>

              <div className={`annotationselectfield trackfield ${opts.clinvar ? 'enabled' : ''}`}>
                <button type="button" className={`annotationtracktoggle${opts.clinvar ? ' active' : ''}`}
                  aria-pressed={opts.clinvar} disabled={!clinvarOk}
                  onClick={() => setTrack('clinvar')}>
                  <i aria-hidden="true" /><span>ClinVar variants</span>
                </button>
                {opts.clinvar && (
                  <CompactClinvarMultiSelect enabled
                    selected={opts.clinvarSignificances} showHidden={false}
                    onChange={({ selected }) => onChange({
                      ...opts,
                      clinvar: true,
                      clinvarSignificances: selected,
                    })} />
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

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
          <label className="annotationsetting mafslider" title="Minimum gnomAD minor allele frequency shown">
            <span>MAF</span>
            <input type="range" min="0" max={GNOMAD_MAF_STEPS.length - 1} step="1"
              value={mafIndex} aria-label="Minimum gnomAD minor allele frequency"
              onChange={(event) => onChange({ ...opts, gnomadMaf: GNOMAD_MAF_STEPS[Number(event.target.value)].value })} />
            <output>&gt;= {GNOMAD_MAF_STEPS[mafIndex].label}</output>
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
  const expressionGene = assembly === 'GRCh38' && locusOverview?.exons?.length
    ? locusOverview.label
    : ''
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
    <div className={`featureribbon${navigationDisabled ? ' loading' : ''}${!currentExon ? ' noexon' : ''}${expressionGene ? '' : ' noexpression'}`}>
      <section className="locusoverviewpanel" aria-label="Gene overview and navigation">
        <div className="locuscluster">
          <div className="locusprimary">
            <div className="locusidentity">
              <span className="locusname" title={locusOverview?.description || locusOverview?.label}>
                <strong>{locusOverview?.label}</strong>
                {locusOverview?.description && <small>{locusOverview.description}</small>}
              </span>
              {locusOverview?.strand && (
                <span className={`genomebar-strand locusstrand ${locusOverview.strand === -1 ? 'rev' : 'fwd'}`}
                  title={locusOverview.strand === -1 ? '− strand · transcribed right to left' : '+ strand · transcribed left to right'}>
                  {locusOverview.strand === -1 ? '← − strand' : '+ strand →'}
                </span>
              )}
            </div>
            {currentExon && (
              <div className="exonnav" aria-label={`${exonNav.gene.name} canonical transcript navigation`}>
                <button type="button" className="frchip exonarrow exonpan"
                  disabled={navigationDisabled} title="Slide left"
                  aria-label="Slide left" onClick={onPanLeft}>←</button>
                <button type="button" className="frchip exonarrow exonjump"
                  disabled={navigationDisabled || exonNav.index <= 0}
                  title="Snap to previous exon" aria-label="Snap to previous exon"
                  onClick={onPreviousExon}>⇤</button>
                <button type="button" className="frchip exoncurrent" disabled={navigationDisabled}
                  title="Center current exon"
                  onClick={onSnapExon}>{exonLabel}</button>
                <button type="button" className="frchip exonarrow exonjump"
                  disabled={navigationDisabled || exonNav.index >= exonNav.exons.length - 1}
                  title="Snap to next exon" aria-label="Snap to next exon"
                  onClick={onNextExon}>⇥</button>
                <button type="button" className="frchip exonarrow exonpan"
                  disabled={navigationDisabled} title="Slide right"
                  aria-label="Slide right" onClick={onPanRight}>→</button>
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
      </section>
      {expressionGene && <GtexExpression assembly={assembly} gene={expressionGene} />}
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
