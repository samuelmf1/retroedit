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
          <ExportActions count={libraryCount} onExport={onExport} />
        </div>
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
                    value={donor.blocking.manual ? blockingChoice : ''}
                    onChange={(event) => onBlockingChoice(event.target.value || null)}
                  >
                    <option value="">Automatic (recommended)</option>
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
              protein unchanged across affected codons:
              <code>{donor.proof.ref}</code> to <code>{donor.proof.donor}</code>
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
        <ExportActions count={libraryCount} onExport={onExport} />
      </div>
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

function ExportActions({ count, onExport }) {
  return (
    <div className="donorexports">
      <span>{count} in basket</span>
      <button type="button" disabled={!count} onClick={() => onExport('fasta')}>FASTA</button>
      <button type="button" disabled={!count} onClick={() => onExport('tsv')}>TSV</button>
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
