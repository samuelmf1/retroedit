import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

const LIBRARY_REMINDER_KEY = 'retroedit:skip-library-review-reminder'

export default function GuideTable({
  guides, hasEdits, exploreMode, onExploreMode, scorable, rs3Available, rs3Model, onRs3Model,
  selectedGuideId, onSelect, checked, onToggle, onToggleAll, offAvailable, variantWarn,
  showOffTargets = true,
}) {
  const [sort, setSort] = useState(null)
  const [libraryPrompt, setLibraryPrompt] = useState(null)
  const [skipLibraryReminder, setSkipLibraryReminder] = useState(false)
  const [libraryReminderDisabled, setLibraryReminderDisabled] = useState(() => (
    window.sessionStorage.getItem(LIBRARY_REMINDER_KEY) === '1'
  ))
  const libraryPromptButtonRef = useRef(null)
  const selectedRowRef = useRef(null)
  const visibleGuides = useMemo(() => sortGuides(guides, sort), [guides, sort])
  const selectedRowIndex = useMemo(
    () => visibleGuides.findIndex((guide) => guide.id === selectedGuideId),
    [selectedGuideId, visibleGuides],
  )

  const onSort = (column) => setSort((current) => (
    current?.column === column
      ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { column, direction: column.startsWith('rs3') ? 'desc' : 'asc' }
  ))

  useLayoutEffect(() => {
    if (selectedRowIndex < 0) return
    const frame = requestAnimationFrame(() => {
      selectedRowRef.current?.scrollIntoView({
        block: 'center',
        inline: 'nearest',
        behavior: 'auto',
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [selectedGuideId, selectedRowIndex, sort])

  const readyIds = guides.filter((guide) => guide.metricsReady).map((guide) => guide.id)
  const selectableIds = exploreMode ? [] : readyIds
  const allChecked = selectableIds.length > 0 && selectableIds.every((id) => checked.has(id))
  const someChecked = selectableIds.some((id) => checked.has(id))
  const nChecked = selectableIds.filter((id) => checked.has(id)).length
  const pendingCount = guides.length - readyIds.length
  const exploreLabel = exploreMode
    ? (hasEdits ? 'Show edit-specific guides' : 'Hide all guides')
    : 'Show all guides'

  const requestGuideToggle = (guide) => {
    if (checked.has(guide.id) || libraryReminderDisabled) {
      onToggle(guide.id)
      return
    }
    setSkipLibraryReminder(false)
    setLibraryPrompt({ kind: 'single', guideId: guide.id, spacer: guide.spacer, pam: guide.pamSeq })
  }

  const requestToggleAll = () => {
    if (allChecked || libraryReminderDisabled) {
      onToggleAll(selectableIds)
      return
    }
    setSkipLibraryReminder(false)
    setLibraryPrompt({
      kind: 'all',
      count: selectableIds.filter((id) => !checked.has(id)).length,
    })
  }

  const closeLibraryPrompt = () => setLibraryPrompt(null)
  const confirmLibraryAdd = () => {
    if (!libraryPrompt) return
    if (skipLibraryReminder) {
      window.sessionStorage.setItem(LIBRARY_REMINDER_KEY, '1')
      setLibraryReminderDisabled(true)
    }
    if (libraryPrompt.kind === 'single') onToggle(libraryPrompt.guideId)
    else onToggleAll(selectableIds)
    setLibraryPrompt(null)
  }
  const reviewLibraryGuide = () => {
    if (libraryPrompt?.kind === 'single' && selectedGuideId !== libraryPrompt.guideId) {
      onSelect(libraryPrompt.guideId)
    }
    setLibraryPrompt(null)
  }

  useEffect(() => {
    if (!libraryPrompt) return undefined
    const frame = requestAnimationFrame(() => libraryPromptButtonRef.current?.focus())
    const onKeyDown = (event) => {
      if (event.key === 'Escape') closeLibraryPrompt()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [libraryPrompt])

  return (
    <>
    <section className="panel guides">
      <header className="panelhead">
        <h2>sgRNAs</h2>
        <span className="count">{guides.length}</span>
        <button
          type="button"
          className={`showallguides${exploreMode ? ' active' : ''}`}
          aria-pressed={exploreMode}
          onClick={onExploreMode}
          title="Explore every spacer and PAM in the displayed sequence before choosing an edit"
        >
          {exploreLabel}
        </button>
        <div className="exportgroup">
          {!exploreMode && <span className="selcount">{nChecked} in basket</span>}
          {sort && <button type="button" className="restoreorder" onClick={() => setSort(null)}>Restore recommended order</button>}
        </div>
      </header>

      {!hasEdits && !exploreMode && (
        <p className="empty">Make an edit to see guides within 100 bp of it, ranked by Rule Set 3 on-target score.</p>
      )}

      {!exploreMode && hasEdits && guides.length === 0 && (
        <p className="empty">No PAM sites within 100 bp of the edit. Try a different PAM or edit position.</p>
      )}

      {exploreMode && guides.length === 0 && (
        <p className="empty">No complete spacer + PAM sites are present in the displayed sequence.</p>
      )}

      {exploreMode && guides.length > 0 && (
        <p className="guideexplorehint">All guides in the displayed sequence. Choose an edit to enable edit distance, re-cut disruption, library selection, and repair-template design.</p>
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
          <strong>{pendingCount} pending</strong>
          <span>{exploreMode
            ? 'RS3 and off-target metrics are being calculated and cached for reuse after you edit.'
            : 'Preview is available. Ability to add guides to the basket unlocks as each finishes.'}</span>
        </div>
      )}

      {guides.length > 0 && (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                {!exploreMode && (
                  <th className="chkcol">
                    <input
                      type="checkbox"
                      disabled={!selectableIds.length}
                      checked={allChecked}
                      ref={(el) => { if (el) el.indeterminate = someChecked && !allChecked }}
                      onChange={() => requestToggleAll()}
                      title={allChecked ? 'Remove all completed guides from the basket' : 'Add all completed guides to the basket'}
                    />
                  </th>
                )}
                <SortHeader column="spacer" label="Spacer + PAM" sort={sort} onSort={onSort}
                  title="Guide spacer followed by the PAM, shown 5′→3′. The PAM is red and is not part of the synthesized guide RNA." />
                <SortHeader column="strand" label="Strand" ariaLabel="guide strand" className="strandcol" sort={sort} onSort={onSort}
                  title="Target strand: + uses the forward reference sequence; − uses its reverse complement." />
                <SortHeader column="rs3Hsu" label="RS3 Hsu" className="num" sort={sort} onSort={onSort}
                  title="Rule Set 3 on-target activity using the Hsu2013 tracrRNA context. Higher is better; this score is not a percentage." />
                <SortHeader column="rs3Chen" label="RS3 Chen" className="num" sort={sort} onSort={onSort}
                  title="Rule Set 3 on-target activity using the Chen2013 tracrRNA context. Higher is better; this score is not a percentage." />
                <SortHeader column="gc" label="%GC" className="num" sort={sort} onSort={onSort}
                  title="GC percentage of the spacer; the PAM is excluded." />
                {!exploreMode && (
                  <SortHeader column="cut" label="Cut Δ" className="num" sort={sort} onSort={onSort}
                    title="Distance in base pairs from the predicted Cas9 cut to the nearest intended edit. Smaller is generally preferred for HDR." />
                )}
                {showOffTargets && (
                  <SortHeader column="matches" label="MM" ariaLabel="mismatch counts" className="num" sort={sort} onSort={onSort}
                    title="Genome-wide match counts shown as 0 MM · 1 MM · 2 MM. A unique guide is 1·0·0; lower off-target counts are better." />
                )}
                {!exploreMode && (
                  <SortHeader column="block" label="Re-cut" sort={sort} onSort={onSort}
                    title="How the repaired allele avoids Cas9 re-cleavage: the intended edit may disrupt the PAM/seed, or the donor may require a disrupting mutation." />
                )}
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
                  {!exploreMode && (
                    <td className="chkcol" title={!g.metricsReady ? 'Available after scoring and off-target metrics finish' : checked.has(g.id) ? 'Remove this guide from the basket' : 'Add this guide to the basket'} onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        disabled={!g.metricsReady}
                        checked={g.metricsReady && checked.has(g.id)}
                        data-guide-library-control
                        aria-label={!g.metricsReady ? 'Guide cannot be added until metrics finish' : checked.has(g.id) ? 'Remove guide from basket' : 'Add guide to basket'}
                        title={!g.metricsReady ? 'Available after scoring and off-target metrics finish' : checked.has(g.id) ? 'Remove this guide from the basket' : 'Add this guide to the basket'}
                        onChange={() => requestGuideToggle(g)}
                      />
                    </td>
                  )}
                  <td className="mono spacer">
                    {g.spacer}<span className="pamsuffix">{g.pamSeq}</span>
                    {g.hasPolyT && (
                      <><br /><span className="flag u6" title="TTTT is a U6 Pol III termination signal">T-homopolymer U6 early terminator</span></>
                    )}
                    {g.synthesisHomopolymer && (
                      <><br /><span
                        className="flag synthesis"
                        title={`${g.synthesisHomopolymer}: Runs of five or more A, C, or G bases may increase oligonucleotide synthesis or sequence-verification errors.`}
                      >
                        Homopolymer synthesis risk
                      </span></>
                    )}
                    {variantWarn?.[g.id] && (
                      <><br /><span className="flag var" title={variantWarnTitle(variantWarn[g.id])}>
                        ⚠ gnomAD AF ≥1%{variantWarn[g.id].count > 1 ? ` (${variantWarn[g.id].count})` : ''}
                      </span></>
                    )}
                  </td>
                  <td className="strandcol"><span className={`strandtag ${g.strand === '+' ? 'fwd' : 'rev'}`} title={g.strand === '+' ? 'Forward reference strand' : 'Reverse-complement strand'}>{g.strand}</span></td>
                  <td className="num">{scoreCell(g, 'rs3Hsu', 'Hsu2013', scorable, rs3Available)}</td>
                  <td className="num">{scoreCell(g, 'rs3Chen', 'Chen2013', scorable, rs3Available)}</td>
                  <td className="num" title={`${Math.round(g.gc * 100)}% GC in the spacer (PAM excluded)`}>{Math.round(g.gc * 100)}</td>
                  {!exploreMode && <td className="num" title={`${g.cutDist} bp from the predicted Cas9 cut to the nearest intended edit`}>{g.cutDist}</td>}
                  {showOffTargets && <td className="num">{offCell(g, offAvailable)}</td>}
                  {!exploreMode && <td>{blockCell(g)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
      {libraryPrompt && (
        <div className="spacermatchbackdrop libraryreviewbackdrop" role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) closeLibraryPrompt() }}>
          <section className="loadconfirmmodal libraryreviewmodal" role="dialog"
            aria-labelledby="library-review-title" aria-describedby="library-review-description">
            <div className="libraryreviewhead">
              <button type="button" className="libraryreviewclose" aria-label="Close review dialog"
                onClick={closeLibraryPrompt}>×</button>
              <span className="libraryreviewicon" aria-hidden="true">+</span>
              <div>
                <span className="libraryrevieweyebrow">Guide basket</span>
                <h2 id="library-review-title">Review before adding</h2>
              </div>
            </div>
            {libraryPrompt.kind === 'single' ? (
              <>
                <div className={`libraryreviewstatus${selectedGuideId === libraryPrompt.guideId ? ' open' : ''}`}>
                  <strong>{selectedGuideId === libraryPrompt.guideId
                    ? 'Repair template currently open'
                    : 'No repair template selected yet'}</strong>
                  <span>{selectedGuideId === libraryPrompt.guideId
                    ? 'Verify the strand, homology arms, and disrupting mutation shown in the repair-template panel.'
                    : 'Open this guide to inspect its repair template before exporting your library.'}</span>
                </div>
                <code className="libraryreviewguide">{libraryPrompt.spacer}<b>{libraryPrompt.pam}</b></code>
              </>
            ) : (
              <div className="libraryreviewstatus">
                <strong>{libraryPrompt.count} guides will be added</strong>
                <span>Repair templates may not have been reviewed individually. Verify each design before export.</span>
              </div>
            )}
            <p id="library-review-description">Adding a guide to the basket saves it to the current export library; it does not confirm that its repair template is final.</p>
            <label className="libraryreminderoption">
              <input type="checkbox" checked={skipLibraryReminder}
                onChange={(event) => setSkipLibraryReminder(event.target.checked)} />
              <span>Don’t remind me again during this session</span>
            </label>
            <div className="libraryreviewactions">
              <button ref={libraryPromptButtonRef} type="button" onClick={reviewLibraryGuide}>
                {libraryPrompt.kind === 'single' ? 'Review first' : 'Cancel'}
              </button>
              <button type="button" className="primary" onClick={confirmLibraryAdd}>
                Add {libraryPrompt.kind === 'all' ? `${libraryPrompt.count} guides` : 'to basket'}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
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
    return <span className="blocktag nonsyn" title={`No re-cut-disrupting mutation was found. ${g.blocking?.reason ?? 'The repaired allele may remain susceptible to Cas9.'}`}>none</span>
  }
  if (!g.blocking.silent) {
    return <span className="blocktag nonsyn" title={`The proposed disrupting mutation prevents re-cutting but changes the encoded amino acid. ${g.blocking.reason ?? ''}`}>non-syn</span>
  }
  if (g.blocking.effect === 'noncoding') {
    return <span className="blocktag neutral" title={`The proposed disrupting mutation prevents re-cutting and lies outside a coding sequence. ${g.blocking.reason ?? ''}`}>noncoding</span>
  }
  return <span className="blocktag none" title={`The proposed disrupting mutation prevents re-cutting without changing the encoded amino acid. ${g.blocking.reason ?? ''}`}>silent</span>
}
