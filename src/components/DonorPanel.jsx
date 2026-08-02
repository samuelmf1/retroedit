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
    top: '', bottom: '', includeBottom: true, namePattern: '{guide}_{strand}',
  })

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
          <ExportActions count={libraryCount} onExport={onExport} onCloningExport={() => setCloningExportOpen(true)} />
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
                bottomOverhang: cloningOverhangs.bottom,
                includeBottom: cloningOverhangs.includeBottom,
                namePattern: cloningOverhangs.namePattern,
              })
              setCloningExportOpen(false)
            }}
          />
        )}
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
        <ExportActions count={libraryCount} onExport={onExport} onCloningExport={() => setCloningExportOpen(true)} />
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
              bottomOverhang: cloningOverhangs.bottom,
              includeBottom: cloningOverhangs.includeBottom,
              namePattern: cloningOverhangs.namePattern,
            })
            setCloningExportOpen(false)
          }}
        />
      )}
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

function ExportActions({ count, onExport, onCloningExport }) {
  const chooseExport = (event, action) => {
    event.currentTarget.closest('details')?.removeAttribute('open')
    action()
  }

  return (
    <div className="donorexports">
      <span>{count} in basket</span>
      <details className="donorexportmenu" name="donor-export-menu">
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
        </div>
      </details>
      <details className="donorexportmenu" name="donor-export-menu">
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
            title="IDT gBlocks bulk-entry CSV: Name and repair-template Sequence. IDT accepts gBlocks from 125 to 3,000 bp."
            onClick={(event) => chooseExport(event, () => onExport('idt-gblocks'))}>
            <span>gBlocks</span><small>Repair-template CSV</small>
          </button>
        </div>
      </details>
    </div>
  )
}

function CloningExportDialog({ count, overhangs, onChange, onClose, onExport }) {
  const invalidTop = /[^ACGT]/i.test(overhangs.top)
  const invalidBottom = overhangs.includeBottom && /[^ACGT]/i.test(overhangs.bottom)
  const emptyName = !overhangs.namePattern.trim()
  const duplicateStrands = overhangs.includeBottom && !overhangs.namePattern.includes('{strand}')
  const duplicateGuides = count > 1 && !overhangs.namePattern.includes('{guide}') && !overhangs.namePattern.includes('{index}')
  const invalid = invalidTop || invalidBottom || emptyName || duplicateStrands || duplicateGuides
  const update = (key, value) => onChange({ ...overhangs, [key]: value.toUpperCase().replace(/\s+/g, '') })
  const previewName = (strand) => overhangs.namePattern
    .replaceAll('{guide}', 'fwd_chr11_5227002')
    .replaceAll('{index}', '1')
    .replaceAll('{strand}', strand)

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
        <p>Exports a forward spacer oligo for every guide in the basket, with an optional reverse-complement bottom strand. Enter only the 5′ cloning overhang for each oligo.</p>
        <label className="cloningnamefield">
          <span>Oligo name or prefix pattern</span>
          <input value={overhangs.namePattern}
            onChange={(event) => onChange({ ...overhangs, namePattern: event.target.value })}
            placeholder="{guide}_{strand}" maxLength="120" />
          <small>
            Use <code>{'{guide}'}</code>, <code>{'{index}'}</code>, and <code>{'{strand}'}</code>. Example: {previewName('top')}
          </small>
        </label>
        <div className="cloningoverhangfields">
          <label>
            <span>Top oligo 5′ overhang</span>
            <input value={overhangs.top} onChange={(event) => update('top', event.target.value)}
              placeholder="e.g. CACC" maxLength="40" autoFocus aria-invalid={invalidTop} />
            <small><b>5′–{overhangs.top || 'OVERHANG'}</b> + spacer–3′</small>
          </label>
          <div className="cloningbottomoption">
            <label className="cloningbottomtoggle">
              <input type="checkbox" checked={overhangs.includeBottom}
                onChange={(event) => onChange({ ...overhangs, includeBottom: event.target.checked })} />
              <span>Include bottom-strand oligo</span>
            </label>
            {overhangs.includeBottom && (
              <label>
                <span>Bottom oligo 5′ overhang</span>
                <input value={overhangs.bottom} onChange={(event) => update('bottom', event.target.value)}
                  placeholder="e.g. AAAC" maxLength="40" aria-invalid={invalidBottom} />
                <small><b>5′–{overhangs.bottom || 'OVERHANG'}</b> + reverse-complement spacer–3′</small>
              </label>
            )}
          </div>
        </div>
        {(invalidTop || invalidBottom) && <div className="cloningoverhangerror" role="alert">Overhangs may contain only A, C, G, and T.</div>}
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
