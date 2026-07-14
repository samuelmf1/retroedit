import { useState } from 'react'
import ArmSlider from './ArmSlider.jsx'
import { TRACR_RNAS, fullSgRna } from '../lib/crispr.js'

// "ssODN" with the leading "ss" in small caps, per house style.
function SsODN() {
  return <span className="term"><span className="sc">ss</span>ODN</span>
}

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
  donor, guide, tracrId, armLeft, armRight, onArmLeft, onArmRight,
  armsCustomized, onApplyArmsToAll, orientation, onOrientation, reference,
  blockingChoice, onBlockingChoice,
}) {
  const [copied, setCopied] = useState(null)

  if (!guide) {
    return (
      <section className="panel donor">
        <header className="panelhead"><h2>HDR donor</h2></header>
        <p className="empty">Select a guide to design its repair template.</p>
      </section>
    )
  }

  const copy = (text, what) => {
    navigator.clipboard?.writeText(text)
    setCopied(what)
    setTimeout(() => setCopied(null), 1200)
  }

  const sgRna = fullSgRna(guide.spacer, tracrId)

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
        <label className="field grow">
          <span>Homology arms (this guide)</span>
          <ArmSlider left={armLeft} right={armRight} onLeft={onArmLeft} onRight={onArmRight} />
        </label>
        <label className="field">
          <span><SsODN /> strand</span>
          <select value={orientation} onChange={(e) => onOrientation(e.target.value)}>
            <option value="auto">Auto (opposite the guide)</option>
            <option value="sense">Sense (+)</option>
            <option value="antisense">Antisense (−)</option>
          </select>
        </label>
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
            <strong>Re-cut block:</strong> {donor.blocking.reason}
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
                  <span>Blocking edit</span>
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
                <strong>More ideal positions not selected:</strong>
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
              protein unchanged across blocked codons:
              <code>{donor.proof.ref}</code> to <code>{donor.proof.donor}</code>
            </div>
          )}

          {donor.warnings.map((w, i) => <div key={i} className="banner warn small">{w}</div>)}

          <DonorTrack track={donor.track} cutRef={donor.cut} />

          <SeqBlock label={<><SsODN /> donor ({donor.orientation})</>} seq={donor.ssodn}
            onCopy={() => copy(donor.ssodn, 'donor')} copied={copied === 'donor'} />
          <SeqBlock label="Spacer" seq={guide.spacer}
            onCopy={() => copy(guide.spacer, 'spacer')} copied={copied === 'spacer'} />
          <details className="sgrna">
            <summary>Full sgRNA · {TRACR_RNAS[tracrId].label} scaffold ({sgRna.length} nt)</summary>
            <div className="seqbox">
              <code className="mono wrap"><span className="hl-spacer">{guide.spacer}</span>{TRACR_RNAS[tracrId].scaffold}</code>
              <button className="copybtn" onClick={() => copy(sgRna, 'sgrna')}>{copied === 'sgrna' ? '✓' : 'copy'}</button>
            </div>
          </details>
        </>
      )}
    </section>
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

// Compact colored map of the donor: arms, edit, blocking, and deleted (ghost) bases.
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
        <span className="dt block">block</span>
        <span className="dt del">del</span>
        <span className="cutkey">| cut</span>
      </div>
    </div>
  )
}
