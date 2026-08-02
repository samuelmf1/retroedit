import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fetchAdvancedOffTargets } from '../lib/genomics.js'

const LIBRARY_REMINDER_KEY = 'retroedit:skip-library-review-reminder'
const SPACER_LENGTH = 20
const SEED_START_INDEX = 10 // PAM-proximal 10-nt seed: spacer positions 11–20.

function mismatchContext(query, match) {
  if (query.length !== SPACER_LENGTH || match.length !== SPACER_LENGTH) {
    return { positions: [], seedPositions: [] }
  }
  const positions = [...query].flatMap((base, index) => base === match[index] ? [] : [index])
  return { positions, seedPositions: positions.filter((index) => index >= SEED_START_INDEX) }
}

function seedMismatchMessage(total, seedPositions) {
  if (!seedPositions.length || total < 1 || total > 2) return ''
  const positions = seedPositions.map((index) => index + 1).join(', ')
  if (total === 1) {
    return `Lower off-target likelihood: its mismatch is in the PAM-proximal seed (spacer position ${positions}), where mismatches commonly impair Cas9 binding and cleavage.`
  }
  if (seedPositions.length === total) {
    return `Lower off-target likelihood: both mismatches are in the PAM-proximal seed (spacer positions ${positions}), where mismatches commonly impair Cas9 binding and cleavage.`
  }
  return `Lower off-target likelihood: one mismatch is in the PAM-proximal seed (spacer position ${positions}); the other is outside the seed.`
}

function advancedSeedMessage(hit) {
  const count = Number(hit.seedEditCount ?? 0)
  if (!count) return ''
  const noun = hit.bulgeType ? 'edit or bulge' : 'mismatch'
  return `Lower off-target likelihood: ${count === 1 ? `one ${noun} falls` : `${count} edits fall`} in the PAM-proximal seed, where sequence differences commonly impair Cas9 binding and cleavage. This alignment is retained for review.`
}

function chromosomeRank(value) {
  const token = String(value || "").replace(/^chr/i, "").toUpperCase()
  if (/^\d+$/.test(token)) return Number(token)
  if (token === "X") return 23
  if (token === "Y") return 24
  if (token === "M" || token === "MT") return 25
  return 1_000
}

const HUMAN_CHROMOSOMES = [...Array.from({ length: 22 }, (_, index) => String(index + 1)), "X", "Y"]
const HUMAN_CHROMOSOME_LENGTHS = {
  GRCh38: [248956422, 242193529, 198295559, 190214555, 181538259, 170805979, 159345973, 145138636, 138394717, 133797422, 135086622, 133275309, 114364328, 107043718, 101991189, 90338345, 83257441, 80373285, 58617616, 64444167, 46709983, 50818468, 156040895, 57227415, 16569],
  GRCh37: [249250621, 243199373, 198022430, 191154276, 180915260, 171115067, 159138663, 146364022, 141213431, 135534747, 135006516, 133851895, 115169878, 107349540, 102531392, 90354753, 81195210, 78077248, 59128983, 63025520, 48129895, 51304566, 155270560, 59373566, 16571],
}

function normalizeChromosome(value) {
  const token = String(value || "").replace(/^chr/i, "").toUpperCase()
  return token === "MT" ? "M" : token
}

function offTargetHitKey(hit) {
  return [normalizeChromosome(hit.chrom), Number(hit.pos), hit.strand || "+"].join(":")
}

function OffTargetChromosomeMap({ assembly, queryChrom, queryPosition, hits, onQuery, onHit, advanced = false }) {
  const lengths = HUMAN_CHROMOSOME_LENGTHS[assembly] || HUMAN_CHROMOSOME_LENGTHS.GRCh38
  const queryToken = normalizeChromosome(queryChrom)
  const maxLength = Math.max(...lengths.slice(0, 24))
  return (
    <section className="offtargetchromosomes" aria-label="Chromosome locations of query and off-target matches">
      <header>
        <strong>Genomic distribution</strong>
        <span><i className="query" /> query guide <i className="hit mm0" /> 0 MM <i className="hit mm1" /> 1 MM <i className="hit mm2" /> 2 MM</span>
      </header>
      <div className="offtargetchromosomeviewport">
        <div className="offtargetchromosomegrid">
          {HUMAN_CHROMOSOMES.map((chromosome, chromosomeIndex) => {
            const length = lengths[chromosomeIndex]
            const chromosomeHits = hits.filter((hit) => normalizeChromosome(hit.chrom) === chromosome)
            const queryHere = queryToken === chromosome && Number.isFinite(queryPosition)
            const bodyHeight = Math.max(14, Math.round((length / maxLength) * 48))
            return (
              <div className="offtargetchromosome" key={chromosome}>
                <div className="offtargetchromosomebody" style={{ height: bodyHeight }}>
                  {queryHere && (
                    <button type="button" className="offtargetchromosomemarker query"
                      style={{ top: Math.max(2, Math.min(98, (queryPosition / length) * 100)) + "%" }}
                      aria-label={"Query guide on chromosome " + chromosome + "; return to query summary"}
                      title={"Query guide · chr" + chromosome + ":" + queryPosition.toLocaleString()}
                      onClick={onQuery} />
                  )}
                  {chromosomeHits.map((hit, hitIndex) => {
                    const position = Number(hit.pos)
                    const key = offTargetHitKey(hit)
                    return (
                      <button type="button" className={`offtargetchromosomemarker hit mm${Math.min(2, Number(hit.mm) || 0)}`}
                        key={key + ":" + hitIndex}
                        style={{ top: Math.max(2, Math.min(98, (position / length) * 100)) + "%" }}
                        aria-label={"Off-target on chromosome " + chromosome + " with " + hit.mm + (advanced ? " edits" : " mismatches") + "; scroll to alignment"}
                        title={"chr" + chromosome + ":" + position.toLocaleString() + " · " + hit.mm + (advanced ? " ED" : " MM")}
                        onClick={() => onHit(key)} />
                    )
                  })}
                </div>
                <span>{chromosome}</span>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
function MiniOffTargetGeneView({ overview, targetStart, targetEnd }) {
  if (!overview || !Number.isFinite(targetStart)) return null
  const rawStart = Math.min(Number(overview.start), targetStart)
  const rawEnd = Math.max(Number(overview.end), targetEnd)
  const padding = Math.max(1, Math.round((rawEnd - rawStart + 1) * 0.06))
  const start = Math.max(1, rawStart - padding)
  const end = rawEnd + padding
  const span = Math.max(1, end - start + 1)
  const segment = (segmentStart, segmentEnd, minWidth = 0) => {
    const left = Math.max(0, Math.min(100, ((segmentStart - start) / span) * 100))
    const right = Math.max(left, Math.min(100, ((segmentEnd - start + 1) / span) * 100))
    return { left: `${left}%`, width: `max(${minWidth}px, ${right - left}%)` }
  }
  return (
    <div className="offtargetminigene" aria-label={`${overview.name} gene context; off-target at ${targetStart} to ${targetEnd}`}>
      <span><b>{overview.name}</b><small>{overview.strand === -1 ? "− strand ←" : "+ strand →"}</small></span>
      <div className="offtargetminigenetrack" aria-hidden="true">
        <i style={segment(Number(overview.start), Number(overview.end))} />
        {(overview.exons ?? []).map((exon, index) => (
          <b key={`${exon.start}:${exon.end}:${index}`} style={segment(Number(exon.start), Number(exon.end), 4)} />
        ))}
        <em style={segment(targetStart, targetEnd, 5)} />
      </div>
    </div>
  )
}


export default function GuideTable({
  guides, hasEdits, sequenceBlocked = false, exploreMode, scorable, rs3Available, rs3Model, onRs3Model,
  selectedGuideId, onSelect, checked, onToggle, onToggleAll, offAvailable, variantWarn, assembly, pamPattern = 'NGG', getOffTargetHref,
  showOffTargets = true,
}) {
  const [sort, setSort] = useState(null)
  const [libraryPrompt, setLibraryPrompt] = useState(null)
  const [offTargetDialog, setOffTargetDialog] = useState(null)
  const [advancedSearch, setAdvancedSearch] = useState({ status: 'idle', result: null, error: '', show: false })
  const [focusedOffTargetKey, setFocusedOffTargetKey] = useState(null)
  const [skipLibraryReminder, setSkipLibraryReminder] = useState(false)
  const [libraryReminderDisabled, setLibraryReminderDisabled] = useState(() => (
    window.sessionStorage.getItem(LIBRARY_REMINDER_KEY) === '1'
  ))
  const libraryPromptButtonRef = useRef(null)
  const selectedRowRef = useRef(null)
  const offTargetQueryRef = useRef(null)
  const offTargetRowRefs = useRef(new Map())
  const advancedSearchController = useRef(null)
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

  useEffect(() => {
    if (!offTargetDialog) return undefined
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOffTargetDialog(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [offTargetDialog])

  useEffect(() => {
    advancedSearchController.current?.abort()
    advancedSearchController.current = null
    setAdvancedSearch({ status: 'idle', result: null, error: '', show: false })
  }, [offTargetDialog?.id])

  const runAdvancedSearch = async () => {
    if (!offTargetDialog) return
    if (advancedSearch.status === 'loading') {
      advancedSearchController.current?.abort()
      advancedSearchController.current = null
      setAdvancedSearch((current) => ({ ...current, status: 'idle', error: '' }))
      return
    }
    if (advancedSearch.result) {
      setAdvancedSearch((current) => ({ ...current, show: !current.show }))
      return
    }
    const controller = new AbortController()
    advancedSearchController.current = controller
    setAdvancedSearch({ status: 'loading', result: null, error: '', show: false })
    try {
      const result = await fetchAdvancedOffTargets({
        assembly,
        pam: pamPattern,
        guide: {
          id: offTargetDialog.id,
          spacer: offTargetDialog.spacer,
          chrom: offTargetDialog.chrom,
          cutGenomic: offTargetDialog.cutGenomic,
          protoGenomic: offTargetDialog.protoGenomic,
        },
      }, controller.signal)
      if (!result.available) throw new Error(result.detail || 'Advanced off-target search is unavailable')
      setAdvancedSearch({ status: 'done', result, error: '', show: true })
    } catch (error) {
      if (error.name !== 'AbortError') {
        setAdvancedSearch({ status: 'error', result: null, error: error.message || String(error), show: false })
      }
    } finally {
      if (advancedSearchController.current === controller) advancedSearchController.current = null
    }
  }

  useEffect(() => {
    if (!focusedOffTargetKey) return undefined
    const timer = window.setTimeout(() => setFocusedOffTargetKey(null), 1400)
    return () => window.clearTimeout(timer)
  }, [focusedOffTargetKey])

  const queryTargetStart = Number(offTargetDialog?.protoGenomic)
  const queryTargetChromRaw = String(offTargetDialog?.chrom || "")
  const queryTargetChrom = queryTargetChromRaw
    ? (/^chr/i.test(queryTargetChromRaw) ? queryTargetChromRaw : "chr" + queryTargetChromRaw)
    : ""
  const queryTargetLocus = Number.isFinite(queryTargetStart) && queryTargetChrom
    ? queryTargetChrom + ":" + queryTargetStart.toLocaleString() + "–" + (queryTargetStart + 19).toLocaleString()
    : null
  const queryChromRank = chromosomeRank(queryTargetChromRaw)
  const activeOffTarget = advancedSearch.show && advancedSearch.result
    ? advancedSearch.result
    : offTargetDialog?.offtarget
  const orderedOffTargetHits = [...(activeOffTarget?.top ?? [])].sort((left, right) => {
    const mismatchDifference = Number(left.cost ?? left.mm ?? 0) - Number(right.cost ?? right.mm ?? 0)
    if (mismatchDifference) return mismatchDifference
    const chromosomeDifference = Math.abs(chromosomeRank(left.chrom) - queryChromRank) -
      Math.abs(chromosomeRank(right.chrom) - queryChromRank)
    if (chromosomeDifference) return chromosomeDifference
    const leftPosition = Number(left.pos ?? 0)
    const rightPosition = Number(right.pos ?? 0)
    const positionDifference = Math.abs(leftPosition - queryTargetStart) - Math.abs(rightPosition - queryTargetStart)
    return positionDifference || leftPosition - rightPosition
  })
  const focusOffTargetResult = (key) => {
    const target = offTargetRowRefs.current.get(key)
    if (!target) return
    setFocusedOffTargetKey(key)
    target.scrollIntoView({ behavior: "smooth", block: "center" })
  }
  const focusQueryTarget = () => {
    offTargetQueryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <>
    <section className="panel guides">
      <header className="panelhead">
        <h2>sgRNAs</h2>
        <span className="count">{guides.length}</span>
        <div className="exportgroup">
          {!exploreMode && <span className="selcount">{nChecked} in basket</span>}
          {sort && <button type="button" className="restoreorder" onClick={() => setSort(null)}>Restore recommended order</button>}
        </div>
      </header>

      {sequenceBlocked && (
        <p className="empty invalidsequenceempty">Fix unsupported sequence symbols to resume guide scoring and design.</p>
      )}

      {!sequenceBlocked && !hasEdits && !exploreMode && (
        <p className="empty">Make an edit to see guides within 100 bp of it, ranked by Rule Set 3 on-target score.</p>
      )}

      {!sequenceBlocked && !exploreMode && hasEdits && guides.length === 0 && (
        <p className="empty">No PAM sites within 100 bp of the edit. Try a different PAM or edit position.</p>
      )}

      {!sequenceBlocked && exploreMode && guides.length === 0 && (
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
                        title={`${g.synthesisHomopolymer}: Runs of five or more identical bases may increase oligonucleotide synthesis or sequence-verification errors.`}
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
                  {showOffTargets && <td className="num">{offCell(g, offAvailable, setOffTargetDialog)}</td>}
                  {!exploreMode && <td>{blockCell(g)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
      {offTargetDialog && (
        <div className="spacermatchbackdrop" role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setOffTargetDialog(null) }}>
          <section className="spacermatchmodal offtargetmodal" role="dialog" aria-modal="true"
            aria-labelledby="offtarget-dialog-title">
            <header>
              <div className="offtargetheadercopy">
                <h2 id="offtarget-dialog-title">Potential off-target matches</h2>
                <div className="offtargetquerysummary" ref={offTargetQueryRef}>
                  <div className="offtargetquerycontext">
                    <span>Query guide</span>
                    {queryTargetLocus && <strong>{queryTargetLocus}</strong>}
                    <small>{offTargetDialog.strand} strand · 20-nt spacer coordinates</small>
                  </div>
                  <div className="offtargetquerydetails">
                    <code className="offtargetqueryspacer">{offTargetDialog.spacer}</code>
                    <span className="offtargetquerypam"><small>PAM</small><b>{offTargetDialog.pamSeq}</b></span>
                    <span className="offtargetquerycounts" aria-label={`Genome-wide ${activeOffTarget?.advanced ? 'edit-distance' : 'mismatch'} counts`}>
                      {["0", "1", "2"].map((mm) => (
                        <span key={mm} className={`mm${mm}`}><small>{mm} {activeOffTarget?.advanced ? 'ED' : 'MM'}</small><b>{activeOffTarget?.counts?.[mm] ?? 0}</b></span>
                      ))}
                    </span>
                  </div>
                </div>
                <div className="advancedofftargetcontrols">
                  <button type="button" className={advancedSearch.show ? 'active' : ''} onClick={runAdvancedSearch}>
                    {advancedSearch.status === 'loading'
                      ? 'Cancel advanced search'
                      : advancedSearch.result
                        ? advancedSearch.show ? 'Show standard results' : 'Show advanced results'
                        : 'Advanced bulge search'}
                  </button>
                  <span>Slow · searches substitutions and DNA/RNA bulges at edit distance 0–2</span>
                </div>
              </div>
              <button type="button" className="spacermatchclose" aria-label="Close off-target details"
                onClick={() => setOffTargetDialog(null)}>×</button>
            </header>
            <OffTargetChromosomeMap
              assembly={assembly}
              queryChrom={queryTargetChromRaw}
              queryPosition={queryTargetStart}
              hits={orderedOffTargetHits}
              onQuery={focusQueryTarget}
              onHit={focusOffTargetResult}
              advanced={Boolean(activeOffTarget?.advanced)}
            />
            <p className="offtargetnote">
              Genomic matches other than the intended target, ordered by {activeOffTarget?.advanced ? 'edit distance' : 'mismatch count'} and then proximity to the query target.
              {activeOffTarget?.advanced && ' Seed-region alignments remain visible and are marked as lower-likelihood off-targets.'}
              {activeOffTarget?.truncated && ' Results were limited; the closest retained alignments are shown.'}
            </p>
            {advancedSearch.status === 'loading' && (
              <div className="advancedofftargetloading" role="status" aria-live="polite">
                <i aria-hidden="true" />
                <div><strong>Searching genome for bulges…</strong><span>Scanning one chromosome at a time. This can take a while.</span></div>
              </div>
            )}
            {advancedSearch.error && <p className="advancedofftargeterror" role="alert">{advancedSearch.error}</p>}
            <div className="offtargetmatchlist" role="list" aria-label="Potential off-target genomic matches">
              {orderedOffTargetHits.map((hit) => {
                const chrom = String(hit.chrom).replace(/^chr/i, '')
                const start = Number(hit.pos)
                const gene = hit.nearestGene
                const annotation = hit.annotation
                const querySequence = String(offTargetDialog.spacer || "").toUpperCase()
                const matchSequence = String(hit.sequence || "").toUpperCase()
                const queryAligned = String(hit.queryAligned || querySequence).toUpperCase()
                const matchAligned = String(hit.matchAligned || matchSequence).toUpperCase()
                const hasAlignment = queryAligned.length > 0 && queryAligned.length === matchAligned.length
                const mismatch = hit.queryAligned ? { seedPositions: hit.seedColumns ?? [] } : mismatchContext(querySequence, matchSequence)
                const seedPositions = new Set(mismatch.seedPositions)
                const seedNote = hit.queryAligned
                  ? advancedSeedMessage(hit)
                  : seedMismatchMessage(Number(hit.mm), mismatch.seedPositions)
                const editDistance = Number(hit.cost ?? hit.mm ?? 0)
                const targetEnd = Number(hit.protoEnd ?? (start + 19))
                const hitKey = offTargetHitKey(hit)
                return (
                  <article role="listitem" key={hitKey}
                    ref={(node) => {
                      if (node) offTargetRowRefs.current.set(hitKey, node)
                      else offTargetRowRefs.current.delete(hitKey)
                    }}
                    className={focusedOffTargetKey === hitKey ? "located" : ""}>
                    <span className={`offtargetmmbadge mm${Math.min(2, editDistance)}`}>
                      {editDistance} {activeOffTarget?.advanced ? 'ED' : 'MM'}
                    </span>
                    <span className="offtargetlocus">
                      <strong>chr{chrom}:{start.toLocaleString()}–{targetEnd.toLocaleString()}</strong>
                      <small>{hit.strand} strand · PAM <code>{hit.pam}</code>{hit.bulgeType && <b className="offtargetbulgetag">{hit.bulgeType}</b>}</small>
                    </span>
                    <span className="offtargetgene">
                      {gene ? <><strong title={gene.id}>{gene.name}</strong><small>{gene.distance === 0
                        ? "within gene"
                        : `${Number(gene.distance).toLocaleString()} bp away`}</small></> : <small>No nearby gene annotation</small>}
                      {annotation && (
                        <span className="offtargetannotations">
                          {annotation.region && annotation.region !== "genic" && (
                            <b className={`region ${annotation.region.toLowerCase()}`}>{annotation.region}</b>
                          )}
                          {(annotation.exons ?? []).map((rank) => <b key={rank}>Exon {rank}</b>)}
                          {(annotation.spliceSites ?? []).map((site) => <b key={site} className="splice">Splice {site}</b>)}
                          {annotation.transcript && (
                            <em title={annotation.transcriptId}>{annotation.transcript}{annotation.canonical ? " ★" : ""}</em>
                          )}
                        </span>
                      )}
                      {getOffTargetHref?.(hit) && (
                        <a className="offtargetopenlocus" href={getOffTargetHref(hit)} target="_blank" rel="noopener noreferrer">
                          Open locus in new tab <span aria-hidden="true">↗</span>
                        </a>
                      )}
                    </span>
                    {hasAlignment && (
                      <div className="offtargetalignment" aria-label={`Query ${queryAligned} PAM ${offTargetDialog.pamSeq}; genomic match ${matchAligned} PAM ${hit.pam}`}>
                        {seedNote && (
                          <span className="offtargetseednote">
                            <b>Lower off-target likelihood</b>
                            <span>{seedNote.replace(/^Lower off-target likelihood:\s*/, '')}</span>
                          </span>
                        )}
                        <div className="offtargetalignmentcontent">
                          <div className="offtargetalignmentseq">
                            <span>Query</span>
                            <code>{[...queryAligned].map((base, baseIndex) => (
                              <i key={baseIndex} className={base === '-' ? `bulge${seedPositions.has(baseIndex) ? ' seedmismatch' : ''}` : ''}>{base}</i>
                            ))}{[...String(offTargetDialog.pamSeq || "")].map((base, pamIndex) => (
                              <i key={"pam-" + pamIndex} className={`pam${pamIndex === 0 ? " pamstart" : ""}`}>{base}</i>
                            ))}</code>
                            <span aria-hidden="true" />
                            <code className="offtargetmatchmarks" aria-hidden="true">
                              {[...queryAligned].map((base, baseIndex) => (
                                <i key={baseIndex} className={base === matchAligned[baseIndex]
                                  ? ""
                                  : `${base === '-' || matchAligned[baseIndex] === '-' ? 'bulge' : 'mismatch'}${seedPositions.has(baseIndex) ? " seedmismatch" : ""}`}>
                                  {base === matchAligned[baseIndex] ? "│" : base === '-' || matchAligned[baseIndex] === '-' ? '↕' : "•"}
                                </i>
                              ))}
                            </code>
                            <span>Match</span>
                            <code>{[...matchAligned].map((base, baseIndex) => (
                              <i key={baseIndex} className={base === queryAligned[baseIndex]
                                ? ""
                                : `${base === '-' || queryAligned[baseIndex] === '-' ? 'bulge' : 'mismatch'}${seedPositions.has(baseIndex) ? " seedmismatch" : ""}`}>{base}</i>
                            ))}{[...String(hit.pam || "")].map((base, pamIndex) => (
                              <i key={"pam-" + pamIndex} className={`pam${pamIndex === 0 ? " pamstart" : ""}`}>{base}</i>
                            ))}</code>
                          </div>
                          <MiniOffTargetGeneView overview={annotation?.overview} targetStart={start} targetEnd={targetEnd} />
                        </div>
                      </div>
                    )}
                  </article>
                )
              })}
              {!activeOffTarget?.top?.length && advancedSearch.status !== 'loading' && (
                <p className="empty">Detailed off-target coordinates are unavailable for this result.</p>
              )}
            </div>
          </section>
        </div>
      )}
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

function offCell(g, offAvailable, onOpen) {
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
  return (
    <button type="button" className={`offt offtdetails ${cls}`}
      title={`${tip}\nClick to inspect sites or run the advanced bulge search.`}
      aria-label={`Mismatch counts ${label}; inspect potential off-target sites`}
      onClick={(event) => {
        event.stopPropagation()
        onOpen?.(g)
      }}>
      {label}
    </button>
  )
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
