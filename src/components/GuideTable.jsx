import { useEffect, useMemo, useRef, useState } from 'react'

export default function GuideTable({
  guides, hasEdits, scorable, rs3Available, rs3Model, onRs3Model, selectedGuideId, onSelect,
  checked, onToggle, onToggleAll, onExport, offAvailable, variantWarn, showOffTargets = true,
}) {
  const [sort, setSort] = useState(null)
  const selectedRowRef = useRef(null)
  const visibleGuides = useMemo(() => sortGuides(guides, sort), [guides, sort])

  const onSort = (column) => setSort((current) => (
    current?.column === column
      ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { column, direction: column.startsWith('rs3') ? 'desc' : 'asc' }
  ))

  // Reveal the selected row whenever the selection changes (e.g. a guide was
  // clicked in the sequence viewer).
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedGuideId, sort])

  const ids = guides.filter((guide) => guide.metricsReady).map((guide) => guide.id)
  const allChecked = ids.length > 0 && ids.every((id) => checked.has(id))
  const someChecked = ids.some((id) => checked.has(id))
  const nChecked = ids.filter((id) => checked.has(id)).length
  const pendingCount = guides.length - ids.length

  return (
    <section className="panel guides">
      <header className="panelhead">
        <h2>sgRNAs</h2>
        <span className="count">{guides.length}</span>
        <div className="exportgroup">
          <span className="selcount">{nChecked} selected</span>
          {sort && <button type="button" className="restoreorder" onClick={() => setSort(null)}>Restore recommended order</button>}
          <button disabled={!nChecked} onClick={() => onExport('fasta')}>FASTA</button>
          <button disabled={!nChecked} onClick={() => onExport('tsv')}>TSV</button>
        </div>
      </header>

      {!hasEdits && (
        <p className="empty">Make an edit to see guides within 100 bp of it, ranked by Hsu2013 Rule Set 3 on-target score.</p>
      )}

      {hasEdits && guides.length === 0 && (
        <p className="empty">No PAM sites within 100 bp of the edit. Try a different PAM or edit position.</p>
      )}

      {guides.length > 0 && scorable && (
        <div className="rs3legend">
          <span>on-target efficiency (rs3)</span>
          <label className="rs3modelpicker">
            <span>Rank and color by</span>
            <select value={rs3Model} onChange={(event) => { setSort(null); onRs3Model(event.target.value) }}>
              <option value="hsu2013">Hsu2013 (default)</option>
              <option value="chen2013">Chen2013</option>
            </select>
          </label>
          <span className="muted">low</span><span className="rs3gradient" /><span className="muted">high</span>
        </div>
      )}
      {pendingCount > 0 && (
        <div className="guidependingnote" role="status">
          <span className="pendingbadge">Export locked</span>
          <strong>{pendingCount} pending</strong>
          <span>Preview is available; export selection unlocks as each guide finishes.</span>
        </div>
      )}

      {guides.length > 0 && (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th className="chkcol">
                  <input
                    type="checkbox"
                    disabled={!ids.length}
                    checked={allChecked}
                    ref={(el) => { if (el) el.indeterminate = someChecked && !allChecked }}
                    onChange={() => onToggleAll(ids)}
                    title="Select all guides with completed metrics"
                  />
                </th>
                <SortHeader column="strand" label="±" ariaLabel="guide strand" className="strandcol" sort={sort} onSort={onSort}
                  title="Target strand: + uses the forward reference sequence; − uses its reverse complement." />
                <SortHeader column="spacer" label="Spacer + PAM" sort={sort} onSort={onSort}
                  title="Guide spacer followed by the PAM, shown 5′→3′. The PAM is red and is not part of the synthesized guide RNA." />
                <SortHeader column="rs3Hsu" label="RS3 Hsu" className="num" sort={sort} onSort={onSort}
                  title="Rule Set 3 on-target activity using the Hsu2013 tracrRNA context. Higher is better; this score is not a percentage." />
                <SortHeader column="rs3Chen" label="RS3 Chen" className="num" sort={sort} onSort={onSort}
                  title="Rule Set 3 on-target activity using the Chen2013 tracrRNA context. Higher is better; this score is not a percentage." />
                <SortHeader column="gc" label="%GC" className="num" sort={sort} onSort={onSort}
                  title="GC percentage of the spacer; the PAM is excluded." />
                <SortHeader column="cut" label="Cut Δ" className="num" sort={sort} onSort={onSort}
                  title="Distance in base pairs from the predicted Cas9 cut to the nearest intended edit. Smaller is generally preferred for HDR." />
                {showOffTargets && (
                  <SortHeader column="matches" label="MM" ariaLabel="mismatch counts" className="num" sort={sort} onSort={onSort}
                    title="Genome-wide match counts shown as 0 MM · 1 MM · 2 MM. A unique guide is 1·0·0; lower off-target counts are better." />
                )}
                <SortHeader column="block" label="Re-cut" sort={sort} onSort={onSort}
                  title="How the repaired allele avoids Cas9 re-cleavage: the intended edit may disrupt the PAM/seed, or the donor may require a disrupting mutation." />
              </tr>
            </thead>
            <tbody>
              {visibleGuides.map((g) => (
                <tr
                  key={g.id}
                  ref={g.id === selectedGuideId ? selectedRowRef : null}
                  className={`${g.id === selectedGuideId ? 'selected' : ''}${g.metricsReady ? '' : ' metrics-pending'}${variantWarn?.[g.id] ? ' common-variant' : ''}`}
                  onClick={() => onSelect(g.id)}
                >
                  <td className="chkcol" title={g.metricsReady ? 'Select this guide for export' : 'Preview available. Export selection unlocks when this guide’s metrics finish.'} onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      disabled={!g.metricsReady}
                      checked={g.metricsReady && checked.has(g.id)}
                      title={g.metricsReady ? 'Select this guide for export' : 'Preview available; export selection unlocks when this guide’s metrics finish'}
                      onChange={() => onToggle(g.id)}
                    />
                  </td>
                  <td className="strandcol"><span className={`strandtag ${g.strand === '+' ? 'fwd' : 'rev'}`} title={g.strand === '+' ? 'Forward reference strand' : 'Reverse-complement strand'}>{g.strand}</span></td>
                  <td className="mono spacer">
                    {/* {g.startsWithG ? '' : <span className="g5" title="does not start with a 5′ G">·</span>} */}
                    {g.spacer}
                    <span className="pamsuffix">{g.pamSeq}</span>
                    {g.hasPolyT && (
                      <><br /><span className="flag u6" title="TTTT is a U6 Pol III termination signal">T-homopolymer U6 early terminator</span></>
                    )}
                    {variantWarn?.[g.id] && (
                      <><br /><span className="flag var" title={variantWarnTitle(variantWarn[g.id])}>
                        ⚠ gnomAD AF ≥1%{variantWarn[g.id].count > 1 ? ` (${variantWarn[g.id].count})` : ''}
                      </span></>
                    )}
                  </td>
                  <td className="num">{scoreCell(g, 'rs3Hsu', 'Hsu2013', scorable, rs3Available)}</td>
                  <td className="num">{scoreCell(g, 'rs3Chen', 'Chen2013', scorable, rs3Available)}</td>
                  <td className="num" title={`${Math.round(g.gc * 100)}% GC in the spacer (PAM excluded)`}>{Math.round(g.gc * 100)}</td>
                  <td className="num" title={`${g.cutDist} bp from the predicted Cas9 cut to the nearest intended edit`}>{g.cutDist}</td>
                  {showOffTargets && <td className="num">{offCell(g, offAvailable)}</td>}
                  <td>{blockCell(g)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function SortHeader({ column, label, ariaLabel, className = '', sort, onSort, title }) {
  const active = sort?.column === column
  const direction = active ? sort.direction : null
  return (
    <th className={className} title={title} aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}>
      <button type="button" className="sortbtn" title={title} onClick={() => onSort(column)} aria-label={`Sort by ${ariaLabel ?? label}`}>
        {label}<span className="sortarrow" aria-hidden="true">{direction === 'asc' ? '↑' : direction === 'desc' ? '↓' : ''}</span>
      </button>
    </th>
  )
}

function blockKind(g) {
  if (g.disruptsPam) return 'pam'
  if (g.disruptsSeed) return 'seed'
  if (!g.blocking?.broke) return 'none'
  if (!g.blocking.silent) return 'nonsyn'
  if (g.blocking.effect === 'noncoding') return 'noncoding'
  return 'silent'
}

const BLOCK_ORDER = { pam: 0, seed: 1, silent: 2, noncoding: 3, nonsyn: 4, none: 5 }

function sortValue(g, column) {
  if (column === 'strand') return g.strand
  if (column === 'spacer') return `${g.spacer}${g.pamSeq}`
  if (column === 'rs3Hsu') return typeof g.rs3Hsu === 'number' ? g.rs3Hsu : null
  if (column === 'rs3Chen') return typeof g.rs3Chen === 'number' ? g.rs3Chen : null
  if (column === 'gc') return g.gc
  if (column === 'cut') return g.cutDist
  if (column === 'matches') {
    const counts = g.offtarget?.counts
    return counts ? [counts['0'] ?? 0, counts['1'] ?? 0, counts['2'] ?? 0] : null
  }
  if (column === 'block') return BLOCK_ORDER[blockKind(g)]
  return null
}

function compareValues(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const difference = (a[i] ?? 0) - (b[i] ?? 0)
      if (difference) return difference
    }
    return 0
  }
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b)
  return a - b
}

function sortGuides(guides, sort) {
  if (!sort) return guides
  return guides.map((guide, index) => ({ guide, index })).sort((a, b) => {
    const av = sortValue(a.guide, sort.column)
    const bv = sortValue(b.guide, sort.column)
    if (av == null && bv == null) return a.index - b.index
    if (av == null) return 1
    if (bv == null) return -1
    const comparison = compareValues(av, bv)
    return (sort.direction === 'asc' ? comparison : -comparison) || a.index - b.index
  }).map(({ guide }) => guide)
}

function scoreCell(g, field, modelLabel, scorable, rs3Available) {
  if (!scorable) return <span className="muted" title="RS3 needs a 20 nt spacer + 3 nt PAM">n/a</span>
  if (!g.context30) return <span className="muted" title="guide runs off the loaded region">n/a</span>
  const score = g[field]
  if (typeof score !== 'number') {
    return <span className="muted" title={rs3Available ? `${modelLabel} Rule Set 3 score is still being calculated` : 'Rule Set 3 scoring is unavailable'}>{rs3Available ? '…' : 'off'}</span>
  }
  const cls = score >= 1 ? 'good' : score <= -1 ? 'poor' : 'mid'
  return <span className={`rs3 ${cls}`} title={`${modelLabel} Rule Set 3 on-target activity: ${score.toFixed(2)} (higher is better; not a percentage)`}>{score.toFixed(2)}</span>
}

function variantWarnTitle(w) {
  const variants = w.variants?.length ? w.variants : [w]
  const details = variants.slice(0, 4).map((v) => (
    `${v.ref || '?'}>${v.alt || '?'} at ${Number(v.pos).toLocaleString()} ` +
    `(${(v.af * 100).toFixed(2)}% AF, ${v.inPam ? 'PAM' : 'spacer'}${v.id ? `, ${v.id}` : ''})`
  )).join('\n')
  const more = variants.length > 4 ? `\n…and ${variants.length - 4} more.` : ''
  return `Warning: ${variants.length} gnomAD variant${variants.length === 1 ? '' : 's'} with alternate allele frequency ≥1% overlap this guide. ` +
    `Cells carrying an alternate allele may have reduced sgRNA annealing or cutting.\n${details}${more}`
}

function offCell(g, offAvailable) {
  if (!offAvailable) return <span className="muted" title="off-target index not built in this environment">off</span>
  const ot = g.offtarget
  if (!ot) return <span className="muted">…</span>
  const c = ot.counts
  const label = `${c['0'] ?? 0}·${c['1'] ?? 0}·${c['2'] ?? 0}`
  const cls = ot.unique ? 'off-ok' : (c['0'] ?? 0) > 1 ? 'off-bad' : 'off-warn'
  const tip = ot.unique
    ? 'Unique in the genome (1·0·0)'
    : `Not unique — genomic matches 0mm: ${c['0'] ?? 0}, 1mm: ${c['1'] ?? 0}, 2mm: ${c['2'] ?? 0}.` +
      ((c['0'] ?? 0) > 1 ? '\nWARNING: an exact match exists elsewhere.' : '\nClose matches elsewhere can be cut too.')
  return <span className={`offt ${cls}`} title={tip}>{label}</span>
}

function blockCell(g) {
  if (g.disruptsPam) {
    return <span className="blocktag pam" title="The intended edit disrupts the PAM, so no additional disrupting mutation is needed.">PAM✓</span>
  }
  if (g.disruptsSeed) {
    return <span className="blocktag seed" title="The intended edit disrupts the PAM-proximal seed, so no additional disrupting mutation is needed.">seed✓</span>
  }
  if (!g.blocking?.broke) {
    return <span className="blocktag nonsyn" title={`No re-cut-prevention mutation was found. ${g.blocking?.reason ?? 'The repaired allele may remain susceptible to Cas9.'}`}>none</span>
  }
  if (!g.blocking.silent) {
    return <span className="blocktag nonsyn" title={`The proposed disrupting mutation prevents re-cutting but changes the encoded amino acid. ${g.blocking.reason ?? ''}`}>non-syn</span>
  }
  if (g.blocking.effect === 'noncoding') {
    return <span className="blocktag neutral" title={`The proposed disrupting mutation prevents re-cutting and lies outside a coding sequence. ${g.blocking.reason ?? ''}`}>noncoding</span>
  }
  return <span className="blocktag none" title={`The proposed disrupting mutation prevents re-cutting without changing the encoded amino acid. ${g.blocking.reason ?? ''}`}>silent</span>
}
