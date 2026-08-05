import { lazy, Suspense, useCallback, useState } from 'react'
import ArmSlider from './ArmSlider.jsx'
const loadPlasmidModal = () => import('./PlasmidModal.jsx')
const PlasmidModal = lazy(loadPlasmidModal)


function blockingOptionLabel(option, refStart, recommendedKey) {
  const edits = option.changes.length
    ? option.changes.map((change) => `g.${refStart + change.refIdx} ${change.from}>${change.to}`).join(', ')
    : `g.${refStart + option.refIdx}`
  const effect = option.status === 'synonymous' ? 'silent'
    : option.status === 'noncoding' ? 'noncoding'
      : option.status === 'nonsyn' ? 'non-syn' : `unavailable: ${option.reason}`
  return `${option.label} · ${edits} · ${effect}${option.key === recommendedKey ? ' · recommended' : ''}`
}

export default function DonorPanel({
  donor, guide, armLeft, armRight, onArmLeft, onArmRight, onArmRatio, onArmTotal,
  armsCustomized, onApplyArmsToAll, orientation, onOrientation, reference,
  blockingChoice, onBlockingChoice, scaffold, scaffoldLabel, guideChecked, guideNeedsUpdate,
  onAddToLibrary, libraryCount, onExport,
}) {
  const [plasmidOpen, setPlasmidOpen] = useState(false)
  const closePlasmid = useCallback(() => setPlasmidOpen(false), [])
  const [copied, setCopied] = useState(null)
  const [lengthDraft, setLengthDraft] = useState('')
  const [cloningExportOpen, setCloningExportOpen] = useState(false)
  const [cloningOverhangs, setCloningOverhangs] = useState({
    top: '', top3: '', bottom: '', bottom3: '', includeBottom: true, namePattern: '{guide}_{strand}',
    scale: '25nm', purification: 'STD',
  })
  const [gBlockExportOpen, setGBlockExportOpen] = useState(false)
  const [gBlockOptions, setGBlockOptions] = useState({
    fivePrimeOverhang: '', threePrimeOverhang: '', namePattern: '{guide}_pWB366',
  })

  const gBlockDialog = gBlockExportOpen && (
    <GBlockExportDialog
      count={libraryCount}
      options={gBlockOptions}
      onChange={setGBlockOptions}
      onClose={() => setGBlockExportOpen(false)}
      onExport={() => {
        onExport('idt-gblocks', gBlockOptions)
        setGBlockExportOpen(false)
      }}
    />
  )

  if (!guide) {
    return (
      <section className="panel donor">
        <header className="panelhead"><h2>HDR donor</h2></header>
        <p className="empty">Select a guide to design its repair template.</p>
        <div className="donoractions">
          <div className="donoractionsleft">
            <button type="button" className="plasmidopen" disabled>View plasmid map</button>
            <button type="button" className="libraryadd" disabled>+ Add to basket</button>
          </div>
          <ExportActions count={libraryCount} onExport={onExport}
            onCloningExport={() => setCloningExportOpen(true)} onGBlockExport={() => setGBlockExportOpen(true)} />
        </div>
        {cloningExportOpen && (
          <CloningExportDialog
            count={libraryCount}
            overhangs={cloningOverhangs}
            onChange={setCloningOverhangs}
            onClose={() => setCloningExportOpen(false)}
            onExport={() => {
              onExport('idt-cloning', {
                topOverhang: cloningOverhangs.top,
                topThreePrimeOverhang: cloningOverhangs.top3,
                bottomOverhang: cloningOverhangs.bottom,
                bottomThreePrimeOverhang: cloningOverhangs.bottom3,
                includeBottom: cloningOverhangs.includeBottom,
                namePattern: cloningOverhangs.namePattern,
                scale: cloningOverhangs.scale,
                purification: cloningOverhangs.purification,
              })
              setCloningExportOpen(false)
            }}
          />
        )}
        {gBlockDialog}
      </section>
    )
  }

  const copy = (text, what) => {
    navigator.clipboard?.writeText(text)
    setCopied(what)
    setTimeout(() => setCopied(null), 1200)
  }

  const armTotal = armLeft + armRight
  const pamSideArm = guide.strand === '+' ? armRight : armLeft
  const armRatio = Math.abs(armLeft - armRight) <= 1
    ? '50:50'
    : Math.abs(pamSideArm / armTotal - 0.28) <= 0.015 ? '72:28' : null
  const commitLengthDraft = () => {
    if (lengthDraft !== '' && Number.isFinite(Number(lengthDraft))) onArmTotal(Number(lengthDraft))
    setLengthDraft('')
  }


  return (
    <section className="panel donor">
      <header className="panelhead">
        <h2>HDR donor</h2>
        <span className="guidebadge">
          <span className={`strandtag ${guide.strand === '+' ? 'fwd' : 'rev'}`}>{guide.strand}</span>
          guide
        </span>
      </header>

      <div className="donorctl">
        <div className="donortopcontrols">
          <div className="repairtemplatelength">
            <span className="repairlengthhead">
              <span className="donorsectionlabel">Repair template length</span>
              <span className="repairlengthvalue">
                <input type="number" min="50" max="250" step="1"
                  value={lengthDraft === '' ? armTotal : lengthDraft}
                  onFocus={() => setLengthDraft(String(armTotal))}
                  onChange={(event) => setLengthDraft(event.target.value)}
                  onBlur={commitLengthDraft}
                  onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
                  aria-label="Repair template length in nucleotides" />
                <span>nt</span>
              </span>
            </span>
            <span className="repairlengthcontrol">
              <span aria-hidden="true">50</span>
              <input
                type="range" min="50" max="250" step="1" value={armTotal}
                onChange={(event) => { setLengthDraft(''); onArmTotal(Number(event.target.value)) }}
                aria-label="Repair template length" aria-valuetext={`${armTotal} nucleotides`}
              />
              <span aria-hidden="true">250 nt</span>
            </span>
          </div>
          <label className="field repairstrand">
            <span className="donorsectionlabel">Repair template strand</span>
            <select value={orientation} onChange={(e) => onOrientation(e.target.value)}>
              <option value="auto">Auto (opposite the guide)</option>
              <option value="sense">Sense (+)</option>
              <option value="antisense">Antisense (−)</option>
            </select>
          </label>
        </div>
        <div className="field grow">
          <span className="donorsectionlabel">Homology arms (this guide)</span>
          <ArmSlider left={armLeft} right={armRight} onLeft={onArmLeft} onRight={onArmRight} />
          <div className="armratio" role="group" aria-label="Homology arm design">
            <span className="donorsectionlabel">Homology design</span>
            <button type="button" className={armRatio === "50:50" ? "active" : ""}
              aria-pressed={armRatio === "50:50"} onClick={() => onArmRatio("50:50")}>
              Symmetric <b>50:50</b>
            </button>
            <span className="armratiooption">
              <button type="button" className={armRatio === "72:28" ? "active" : ""}
                aria-pressed={armRatio === "72:28"} onClick={() => onArmRatio("72:28")}>
                Asymmetric <b>72:28</b>
              </button>
              <span className="armratiotip" role="tooltip">
                Approximates the published 91 nt / 36 nt asymmetric design while preserving the current total length.
                <a href="https://www.nature.com/articles/nbt.3481" target="_blank" rel="noreferrer">
                  Richardson et al., 2016 ↗
                </a>
              </span>
            </span>
            <small>shorter arm on PAM side</small>
          </div>
        </div>
        {armsCustomized && (
          <button type="button" className="applyall" onClick={onApplyArmsToAll}>
            Apply arms to all sgRNAs
          </button>
        )}
      </div>

      {!donor?.ok && (
        <div className="banner error small">{donor?.error ?? 'Cannot design a donor.'}</div>
      )}

      {donor?.ok && (
        <>
          <div className="donorstats">
            <Stat label="Length" value={`${donor.length} nt`} />
            <Stat label="Strand" value={donor.orientation === 'antisense' ? 'antisense (−)' : 'sense (+)'} />
            <Stat label="Cut" value={donor.cutGenomic.toLocaleString()} />
            <Stat label="Arms" value={`${donor.leftArm.length} / ${donor.rightArm.length}`} />
          </div>

          <div className={`blockrow ${donor.blocking.broke ? (donor.blocking.silent ? 'silent' : 'nonsilent') : 'fail'}`}>
            <strong>Re-cut disruption:</strong> {donor.blocking.reason}
            {donor.blocking.subs.length > 0 && (
              <span className="blocksubs">
                {donor.blocking.subs.map((s) => (
                  <span key={s.refIdx} className={`blocksub ${s.synonymous || s.proteinNeutral ? 'syn' : 'ns'}`}>
                    g.{reference.start + s.refIdx} {s.from} to {s.to}
                    {s.synonymous ? ` (${s.aaFrom}, silent)`
                      : s.proteinNeutral ? ' (noncoding)' : ` (${s.aaFrom} to ${s.aaTo}, non-syn)`}
                  </span>
                ))}
              </span>
            )}
            {donor.blocking.options?.length > 0 && (
              <div className="blockselector">
                <label>
                  <span>Alternative PAM/seed disrupting mutations</span>
                  <select
                    value={donor.blocking.manual ? blockingChoice : donor.blocking.recommendedKey}
                    onChange={(event) => onBlockingChoice(
                      event.target.value === donor.blocking.recommendedKey ? null : event.target.value,
                    )}
                  >
                    {donor.blocking.options.map((option) => (
                      <option key={option.key} value={option.key} disabled={!option.selectable}>
                        {blockingOptionLabel(option, reference.start, donor.blocking.recommendedKey)}
                      </option>
                    ))}
                  </select>
                </label>
                {donor.blocking.manual && (
                  <button type="button" onClick={() => onBlockingChoice(null)}>Use recommendation</button>
                )}
              </div>
            )}
            {donor.blocking.alternatives?.length > 0 && (
              <div className="blockalternatives">
                <strong>Alternative PAM/seed disrupting mutations:</strong>
                {donor.blocking.alternatives.map((candidate) => (
                  <span key={`${candidate.kind}-${candidate.refIdx}`}>
                    g.{reference.start + candidate.refIdx} · {candidate.label}: {candidate.reason}
                  </span>
                ))}
              </div>
            )}
          </div>

          {donor.proof && (
            <div className="proof">
              <strong>Protein consequence:</strong> none (silent mutation).
            </div>
          )}

          {donor.warnings.map((w, i) => <div key={i} className="banner warn small">{w}</div>)}

          <DonorTrack track={donor.track} cutRef={donor.cut} />

          <SeqBlock label={`Repair template (${donor.orientation})`} seq={donor.ssodn}
            onCopy={() => copy(donor.ssodn, 'donor')} copied={copied === 'donor'} />
          <SeqBlock label="Spacer" seq={guide.spacer}
            onCopy={() => copy(guide.spacer, 'spacer')} copied={copied === 'spacer'} />
        </>
      )}
      <div className="donoractions">
        <div className="donoractionsleft">
          <button type="button" className="plasmidopen" disabled={!donor?.ok}
            onPointerEnter={loadPlasmidModal} onFocus={loadPlasmidModal}
            onClick={() => setPlasmidOpen(true)}>View plasmid map</button>
          <button type="button" className={`libraryadd${guideChecked && !guideNeedsUpdate ? ' added' : ''}${guideNeedsUpdate ? ' update' : ''}`}
            disabled={!guide.metricsReady || (guideChecked && !guideNeedsUpdate)}
            title={!guide.metricsReady ? 'Available after guide scoring and off-target metrics finish' : undefined}
            onClick={onAddToLibrary}>
            {guideNeedsUpdate ? '↻ Update in basket' : guideChecked ? '✓ Added to basket' : '+ Add to basket'}
          </button>
          {!guide.metricsReady && <span className="librarynote">Available when guide metrics finish</span>}
        </div>
        <ExportActions count={libraryCount} onExport={onExport}
          onCloningExport={() => setCloningExportOpen(true)} onGBlockExport={() => setGBlockExportOpen(true)} />
      </div>
      {cloningExportOpen && (
        <CloningExportDialog
          count={libraryCount}
          overhangs={cloningOverhangs}
          onChange={setCloningOverhangs}
          onClose={() => setCloningExportOpen(false)}
          onExport={() => {
            onExport('idt-cloning', {
              topOverhang: cloningOverhangs.top,
              topThreePrimeOverhang: cloningOverhangs.top3,
              bottomOverhang: cloningOverhangs.bottom,
              bottomThreePrimeOverhang: cloningOverhangs.bottom3,
              includeBottom: cloningOverhangs.includeBottom,
              namePattern: cloningOverhangs.namePattern,
              scale: cloningOverhangs.scale,
              purification: cloningOverhangs.purification,
            })
            setCloningExportOpen(false)
          }}
        />
      )}
      {gBlockDialog}
      {plasmidOpen && (
        <Suspense fallback={(
          <div className="plasmidmodal" role="dialog" aria-modal="true" aria-label="Loading plasmid viewer">
            <div className="plasmidloading" role="status">Loading plasmid viewer…</div>
          </div>
        )}>
          <PlasmidModal
            open
            onClose={closePlasmid}
            spacer={guide.spacer}
            scaffold={scaffold}
            scaffoldLabel={scaffoldLabel}
            repairTemplate={donor?.ssodn ?? ''}
          />
        </Suspense>
      )}
    </section>

  )
}

function ExportActions({ count, onExport, onCloningExport, onGBlockExport }) {
  const positionMenu = (event) => {
    const details = event.currentTarget
    if (!details.open) {
      details.removeAttribute('data-positioned')
      return
    }
    requestAnimationFrame(() => {
      const summary = details.querySelector(':scope > summary')
      const menu = details.querySelector(':scope > .donorexportoptions')
      if (!summary || !menu || !details.open) return
      const trigger = summary.getBoundingClientRect()
      const width = menu.offsetWidth
      const height = menu.offsetHeight
      const gap = 7
      const margin = 8
      const roomAbove = trigger.top - margin
      const roomBelow = window.innerHeight - trigger.bottom - margin
      const openAbove = roomAbove >= height + gap || roomAbove >= roomBelow
      const top = Math.max(margin, Math.min(
        window.innerHeight - height - margin,
        openAbove ? trigger.top - height - gap : trigger.bottom + gap,
      ))
      const left = Math.max(margin, Math.min(
        window.innerWidth - width - margin,
        trigger.right - width,
      ))
      details.style.setProperty('--export-menu-top', `${top}px`)
      details.style.setProperty('--export-menu-left', `${left}px`)
      details.setAttribute('data-positioned', 'true')
    })
  }

  const chooseExport = (event, action) => {
    event.currentTarget.closest('details')?.removeAttribute('open')
    action()
  }

  return (
    <div className="donorexports">
      <span>{count} in basket</span>
      <details className="donorexportmenu" name="donor-export-menu" onToggle={positionMenu}>
        <summary aria-label="Download design files">Download <i aria-hidden="true" /></summary>
        <div className="donorexportoptions" role="menu" aria-label="Download design files">
          <button type="button" role="menuitem" disabled={!count}
            onClick={(event) => chooseExport(event, () => onExport('fasta'))}>
            <span>FASTA</span><small>Sequence records</small>
          </button>
          <button type="button" role="menuitem" disabled={!count}
            onClick={(event) => chooseExport(event, () => onExport('tsv'))}>
            <span>TSV</span><small>Design table</small>
          </button>
          <button type="button" role="menuitem" disabled={!count}
            title="Annotated SnapGene file containing the edited locus and every design in the basket"
            onClick={(event) => chooseExport(event, () => onExport('dna'))}>
            <span>SnapGene .dna</span><small>Annotated design</small>
          </button>
          <button type="button" role="menuitem" disabled={!count}
            title="Generic GenBank file containing the edited locus and every design in the basket"
            onClick={(event) => chooseExport(event, () => onExport('gbk'))}>
            <span>GenBank .gbk</span><small>Annotated design</small>
          </button>
        </div>
      </details>
      <details className="donorexportmenu" name="donor-export-menu" onToggle={positionMenu}>
        <summary aria-label="Export files for ordering">Order <i aria-hidden="true" /></summary>
        <div className="donorexportoptions orderoptions" role="menu" aria-label="Export files for ordering">
          <button type="button" role="menuitem" disabled={!count}
            title="IDT bulk-entry CSV: full guide RNA using the selected tracrRNA scaffold; PAM excluded"
            onClick={(event) => chooseExport(event, () => onExport('idt-grna'))}>
            <span>IDT gRNA</span><small>Full guide RNA CSV</small>
          </button>
          <button type="button" role="menuitem" disabled={!count}
            title="Paired spacer oligos with custom 5′ cloning overhangs"
            onClick={(event) => chooseExport(event, onCloningExport)}>
            <span>Cloning oligos</span><small>Configure strands and overhangs</small>
          </button>
          <button type="button" role="menuitem" disabled={!count}
            title="Full designed pWB366 constructs with optional vector-insertion overhangs"
            onClick={(event) => chooseExport(event, onGBlockExport)}>
            <span>gBlocks</span><small>Designed pWB366 CSV</small>
          </button>
        </div>
      </details>
    </div>
  )
}

function GBlockExportDialog({ count, options, onChange, onClose, onExport }) {
  const invalidFivePrime = /[^ACGT]/i.test(options.fivePrimeOverhang)
  const invalidThreePrime = /[^ACGT]/i.test(options.threePrimeOverhang)
  const emptyName = !options.namePattern.trim()
  const duplicateGuides = count > 1 && !options.namePattern.includes('{guide}') && !options.namePattern.includes('{index}')
  const invalid = invalidFivePrime || invalidThreePrime || emptyName || duplicateGuides
  const update = (key, value) => onChange({
    ...options,
    [key]: value.toUpperCase().replace(/\s+/g, ''),
  })
  const previewName = options.namePattern
    .replaceAll('{guide}', 'fwd_chr11_5227002')
    .replaceAll('{index}', '1')

  return (
    <div className="spacermatchbackdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="loadconfirmmodal cloningexportmodal gblockexportmodal" role="dialog" aria-modal="true"
        aria-labelledby="gblock-export-title">
        <div className="cloningexporthead">
          <div>
            <div className="loadconfirmbrand">IDT gBlocks</div>
            <h2 id="gblock-export-title">Export designed pWB366 constructs</h2>
          </div>
          <button type="button" className="spacermatchclose" onClick={onClose} aria-label="Close">×</button>
        </div>
        <p>Each row contains the complete pWB366 plasmid sequence, linearized at base 1, with that design’s spacer and scaffold after the retained U6 starting G and its repair template after the MSD.</p>
        <div className="gblocknotice">
          Optional terminal overhangs can be added for insertion into another vector. Blank fields remain blank.
        </div>
        <label className="cloningnamefield">
          <span>gBlock name pattern</span>
          <input value={options.namePattern}
            onChange={(event) => onChange({ ...options, namePattern: event.target.value })}
            placeholder="{guide}_pWB366" maxLength="120" />
          <small>Use <code>{'{guide}'}</code> and <code>{'{index}'}</code>. Example: {previewName}</small>
        </label>
        <div className="cloningoverhangfields gblockoverhangfields">
          <label>
            <span>5′ overhang</span>
            <input value={options.fivePrimeOverhang}
              onChange={(event) => update('fivePrimeOverhang', event.target.value)}
              placeholder="Optional vector-insertion sequence" maxLength="120" autoFocus
              aria-invalid={invalidFivePrime} />
          </label>
          <label>
            <span>3′ overhang</span>
            <input value={options.threePrimeOverhang}
              onChange={(event) => update('threePrimeOverhang', event.target.value)}
              placeholder="Optional vector-insertion sequence" maxLength="120"
              aria-invalid={invalidThreePrime} />
          </label>
        </div>
        <small className="gblocksequencepreview">5′–<b>{options.fivePrimeOverhang}</b>{options.fivePrimeOverhang && ' + '}designed pWB366{options.threePrimeOverhang && ' + '}<b>{options.threePrimeOverhang}</b>–3′</small>
        {(invalidFivePrime || invalidThreePrime) && <div className="cloningoverhangerror" role="alert">Overhangs may contain only A, C, G, and T.</div>}
        {emptyName && <div className="cloningoverhangerror" role="alert">Enter a gBlock name pattern.</div>}
        {duplicateGuides && <div className="cloningoverhangerror" role="alert">Add {'{guide}'} or {'{index}'} so each construct has a unique name.</div>}
        <div className="gblocklengthnote">The designed construct is approximately 2.7 kb before overhangs. Confirm the final sequence length against your synthesis provider’s current limits.</div>
        <div className="loadconfirmactions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" disabled={invalid} onClick={onExport}>Export gBlocks CSV</button>
        </div>
      </section>
    </div>
  )
}

function CloningExportDialog({ count, overhangs, onChange, onClose, onExport }) {
  const invalidTop = /[^ACGT]/i.test(overhangs.top)
  const invalidTop3 = /[^ACGT]/i.test(overhangs.top3)
  const invalidBottom = overhangs.includeBottom && /[^ACGT]/i.test(overhangs.bottom)
  const invalidBottom3 = overhangs.includeBottom && /[^ACGT]/i.test(overhangs.bottom3)
  const emptyName = !overhangs.namePattern.trim()
  const duplicateStrands = overhangs.includeBottom && !overhangs.namePattern.includes('{strand}')
  const duplicateGuides = count > 1 && !overhangs.namePattern.includes('{guide}') && !overhangs.namePattern.includes('{index}')
  const invalid = invalidTop || invalidTop3 || invalidBottom || invalidBottom3
    || emptyName || duplicateStrands || duplicateGuides
  const update = (key, value) => onChange({ ...overhangs, [key]: value.toUpperCase().replace(/\s+/g, '') })
  const previewName = (strand) => overhangs.namePattern
    .replaceAll('{guide}', 'fwd_chr11_5227002')
    .replaceAll('{index}', '1')
    .replaceAll('{strand}', strand)
  const scaleOptions = [
    ['', 'Leave blank'],
    ['25nm', '25 nmole'],
    ['100nm', '100 nmole'],
    ['250nm', '250 nmole'],
    ['1um', '1 µmole'],
    ['2um', '2 µmole'],
    ['5um', '5 µmole'],
    ['10um', '10 µmole'],
    ['4nmU', '4 nmole Ultramer™'],
    ['20nmU', '20 nmole Ultramer™'],
    ['PU', 'PAGE Ultramer™'],
    ['25nmS', '25 nmole Sameday'],
  ]
  const purificationOptions = [
    ['', 'Leave blank'],
    ['STD', 'Standard Desalting'],
    ['PAGE', 'PAGE'],
    ['HPLC', 'HPLC'],
    ['IEHPLC', 'IE HPLC'],
    ['RNASE', 'RNase Free HPLC'],
    ['DUALHPLC', 'Dual HPLC'],
    ['PAGEHPLC', 'Dual PAGE & HPLC'],
  ]

  return (
    <div className="spacermatchbackdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="loadconfirmmodal cloningexportmodal" role="dialog" aria-modal="true"
        aria-labelledby="cloning-export-title">
        <div className="cloningexporthead">
          <div>
            <div className="loadconfirmbrand">IDT cloning oligos</div>
            <h2 id="cloning-export-title">Add custom overhangs</h2>
          </div>
          <button type="button" className="spacermatchclose" onClick={onClose} aria-label="Close">×</button>
        </div>
        <p>Exports a forward spacer oligo for every guide in the basket, with an optional reverse-complement bottom strand. Add optional 5′ and 3′ cloning overhangs; blank fields remain blank.</p>
        <label className="cloningnamefield">
          <span>Oligo name or prefix pattern</span>
          <input value={overhangs.namePattern}
            onChange={(event) => onChange({ ...overhangs, namePattern: event.target.value })}
            placeholder="{guide}_{strand}" maxLength="120" />
          <small>
            Use <code>{'{guide}'}</code>, <code>{'{index}'}</code>, and <code>{'{strand}'}</code>. Example: {previewName('top')}
          </small>
        </label>
        <div className="cloningordersettings" aria-label="IDT order settings">
          <label>
            <span>Scale</span>
            <select value={overhangs.scale}
              onChange={(event) => onChange({ ...overhangs, scale: event.target.value })}>
              {scaleOptions.map(([code, label]) => (
                <option key={code || 'blank'} value={code}>{code ? `${code} — ${label}` : label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Purification</span>
            <select value={overhangs.purification}
              onChange={(event) => onChange({ ...overhangs, purification: event.target.value })}>
              {purificationOptions.map(([code, label]) => (
                <option key={code || 'blank'} value={code}>{code ? `${code} — ${label}` : label}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="cloningoverhangfields">
          <div className="cloningstrandfields">
            <strong>Top-strand oligo</strong>
            <label>
              <span>5′ overhang</span>
              <input value={overhangs.top} onChange={(event) => update('top', event.target.value)}
                placeholder="Optional, e.g. CACC" maxLength="40" autoFocus aria-invalid={invalidTop} />
            </label>
            <label>
              <span>3′ overhang</span>
              <input value={overhangs.top3} onChange={(event) => update('top3', event.target.value)}
                placeholder="Optional" maxLength="40" aria-invalid={invalidTop3} />
            </label>
            <small>5′–<b>{overhangs.top}</b>{overhangs.top && ' + '}spacer{overhangs.top3 && ' + '}<b>{overhangs.top3}</b>–3′</small>
          </div>
          <div className="cloningbottomoption">
            <label className="cloningbottomtoggle">
              <input type="checkbox" checked={overhangs.includeBottom}
                onChange={(event) => onChange({ ...overhangs, includeBottom: event.target.checked })} />
              <span>Include bottom-strand oligo</span>
            </label>
            {overhangs.includeBottom && (
              <div className="cloningstrandfields">
                <label>
                  <span>5′ overhang</span>
                  <input value={overhangs.bottom} onChange={(event) => update('bottom', event.target.value)}
                    placeholder="Optional, e.g. AAAC" maxLength="40" aria-invalid={invalidBottom} />
                </label>
                <label>
                  <span>3′ overhang</span>
                  <input value={overhangs.bottom3} onChange={(event) => update('bottom3', event.target.value)}
                    placeholder="Optional" maxLength="40" aria-invalid={invalidBottom3} />
                </label>
                <small>5′–<b>{overhangs.bottom}</b>{overhangs.bottom && ' + '}reverse-complement spacer{overhangs.bottom3 && ' + '}<b>{overhangs.bottom3}</b>–3′</small>
              </div>
            )}
          </div>
        </div>
        {(invalidTop || invalidTop3 || invalidBottom || invalidBottom3) && <div className="cloningoverhangerror" role="alert">Overhangs may contain only A, C, G, and T.</div>}
        {emptyName && <div className="cloningoverhangerror" role="alert">Enter an oligo name pattern.</div>}
        {duplicateStrands && <div className="cloningoverhangerror" role="alert">Add {'{strand}'} so top and bottom oligos have unique names.</div>}
        {duplicateGuides && <div className="cloningoverhangerror" role="alert">Add {'{guide}'} or {'{index}'} so each guide has a unique name.</div>}
        <div className="loadconfirmactions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" disabled={invalid} onClick={onExport}>Export IDT CSV</button>
        </div>
      </section>
    </div>
  )
}

function Stat({ label, value }) {
  return <div className="stat"><span className="statlabel">{label}</span><span className="statval">{value}</span></div>
}

function SeqBlock({ label, seq, onCopy, copied }) {
  return (
    <div className="seqblock">
      <div className="seqlabel">{label}</div>
      <div className="seqbox">
        <code className="mono wrap">{seq}</code>
        <button className="copybtn" onClick={onCopy}>{copied ? '✓' : 'copy'}</button>
      </div>
    </div>
  )
}

// Compact colored map of the donor: arms, edits, disrupting mutations, and deleted (ghost) bases.
function DonorTrack({ track, cutRef }) {
  let cutIndex = track.findIndex((t) => t.ref != null && t.ref >= cutRef)
  if (cutIndex < 0) cutIndex = track.length
  return (
    <div className="donortrack mono">
      {track.map((t, i) => (
        <span key={i} className={`dt ${t.role}`}>
          {i === cutIndex && <span className="dtcut" />}
          {t.base}
        </span>
      ))}
      <div className="dtlegend">
        <span className="dt arm">arm</span>
        <span className="dt edit">edit</span>
        <span className="dt ins">insert</span>
        <span className="dt block">disrupt</span>
        <span className="dt del">del</span>
        <span className="cutkey">| cut</span>
      </div>
    </div>
  )
}
