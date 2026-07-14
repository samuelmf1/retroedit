import { useEffect, useMemo, useRef, useState } from 'react'

export default function GuideTable({
  guides, hasEdits, scorable, rs3Available, selectedGuideId, onSelect,
  checked, onToggle, onToggleAll, onExport, offAvailable, variantWarn,
}) {
  const [sort, setSort] = useState(null)
  const selectedRowRef = useRef(null)
  const visibleGuides = useMemo(() => sortGuides(guides, sort), [guides, sort])

  const onSort = (column) => setSort((current) => (
    current?.column === column
      ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { column, direction: column === 'rs3' ? 'desc' : 'asc' }
  ))

  // Reveal the selected row whenever the selection changes (e.g. a guide was
  // clicked in the sequence viewer).
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedGuideId, sort])

  const ids = guides.map((g) => g.id)
  const allChecked = ids.length > 0 && ids.every((id) => checked.has(id))
  const someChecked = ids.some((id) => checked.has(id))
  const nChecked = ids.filter((id) => checked.has(id)).length

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
        <p className="empty">Make an edit to see guides within 100 bp of it, ranked by RuleSet3 on-target score.</p>
      )}

      {hasEdits && guides.length === 0 && (
        <p className="empty">No PAM sites within 100 bp of the edit. Try a different PAM or edit position.</p>
      )}

      {guides.length > 0 && scorable && (
        <div className="rs3legend">
          <span>RS3</span>
          <span className="rs3gradient" />
          <span className="muted">low to high on-target</span>
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
                    checked={allChecked}
                    ref={(el) => { if (el) el.indeterminate = someChecked && !allChecked }}
                    onChange={() => onToggleAll(ids)}
                    title="Select all"
                  />
                </th>
                <SortHeader column="strand" label="±" ariaLabel="guide strand" className="strandcol" sort={sort} onSort={onSort} />
                <SortHeader column="spacer" label="Spacer (5′→3′)" sort={sort} onSort={onSort} />
                <SortHeader column="rs3" label="RS3" className="num" sort={sort} onSort={onSort} />
                <SortHeader column="gc" label="GC" className="num" sort={sort} onSort={onSort} />
                <SortHeader column="cut" label="Cut Δ" className="num" sort={sort} onSort={onSort} />
                <SortHeader column="matches" label="Matches" className="num" sort={sort} onSort={onSort}
                  title="Genomic matches by mismatch (0·1·2). A unique guide is 1·0·0." />
                <SortHeader column="block" label="Block" sort={sort} onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {visibleGuides.map((g) => (
                <tr
                  key={g.id}
                  ref={g.id === selectedGuideId ? selectedRowRef : null}
                  className={g.id === selectedGuideId ? 'selected' : ''}
                  onClick={() => onSelect(g.id)}
                >
                  <td className="chkcol" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={checked.has(g.id)} onChange={() => onToggle(g.id)} />
                  </td>
                  <td className="strandcol"><span className={`strandtag ${g.strand === '+' ? 'fwd' : 'rev'}`}>{g.strand}</span></td>
                  <td className="mono spacer">
                    {/* {g.startsWithG ? '' : <span className="g5" title="does not start with a 5′ G">·</span>} */}
                    {g.spacer}
                    <span className="pamsuffix">{g.pamSeq}</span>
                    {g.hasPolyT && (
                      <><br /><span className="flag u6" title="TTTT is a U6 Pol III termination signal">T-homopolymer U6 early terminator</span></>
                    )}
                    {variantWarn?.[g.id] && (
                      <span className="flag var" title={variantWarnTitle(variantWarn[g.id])}>SNP</span>
                    )}
                  </td>
                  <td className="num">{scoreCell(g, scorable, rs3Available)}</td>
                  <td className="num">{Math.round(g.gc * 100)}</td>
                  <td className="num">{g.cutDist}</td>
                  <td className="num">{offCell(g, offAvailable)}</td>
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
      <button type="button" className="sortbtn" onClick={() => onSort(column)} aria-label={`Sort by ${ariaLabel ?? label}`}>
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
  if (column === 'rs3') return typeof g.rs3 === 'number' ? g.rs3 : null
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

function scoreCell(g, scorable, rs3Available) {
  if (!scorable) return <span className="muted" title="RS3 needs a 20 nt spacer + 3 nt PAM">n/a</span>
  if (!g.context30) return <span className="muted" title="guide runs off the loaded region">n/a</span>
  if (typeof g.rs3 !== 'number') {
    return <span className="muted">{rs3Available ? '…' : 'off'}</span>
  }
  const cls = g.rs3 >= 1 ? 'good' : g.rs3 <= -1 ? 'poor' : 'mid'
  return <span className={`rs3 ${cls}`}>{g.rs3.toFixed(2)}</span>
}

function variantWarnTitle(w) {
  return `Overlaps a common variant (${w.id || 'gnomAD'}, MAF ${(w.af * 100).toFixed(1)}%)` +
    `${w.inPam ? ' in the PAM' : ' in the spacer'} — a mismatch here can lower cutting efficiency.`
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
  if (g.disruptsPam) return <span className="blocktag pam" title="edit disrupts the PAM">PAM✓</span>
  if (g.disruptsSeed) return <span className="blocktag seed" title="edit disrupts the seed">seed✓</span>
  if (!g.blocking?.broke) {
    return <span className="blocktag nonsyn" title={g.blocking?.reason ?? 'No blocking mutation found'}>none</span>
  }
  if (!g.blocking.silent) {
    return <span className="blocktag nonsyn" title={g.blocking.reason}>non-syn</span>
  }
  if (g.blocking.effect === 'noncoding') {
    return <span className="blocktag neutral" title={g.blocking.reason}>noncoding</span>
  }
  return <span className="blocktag none" title={g.blocking.reason}>silent</span>
}
