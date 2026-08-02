import { useEffect, useRef, useState } from 'react'
import { isValidPattern } from '../lib/bio.js'
import { genomesByOrganism, getGenome } from '../lib/genome.js'
import { fetchGeneSuggestions } from '../lib/genomics.js'

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const order = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / (1024 ** order)).toFixed(order ? 1 : 0)} ${units[order]}`
}

const EXAMPLES = {
  'human-grch38': ['HBB', 'rs334', 'chr11:5,227,002'],
  'human-grch37': ['HBB', 'rs334'],
  'mouse-grcm39': ['Ltbr', 'Pcsk9'],
}

export default function Controls({
  genomeId, onGenome,
  query, onQuery,
  pam, onPam,
  onSearch, onCancelLoad, onCustomUpload, customMode, customName,
  customRecords = [], customRecord, onCustomRecord, onCustomPosition, uploadProgress,
  loading, loadChanged, recentSearches = [], onRecent, onClearRecent, onClearSelection,
}) {
  const searchRef = useRef(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [theme, setTheme] = useState(() => {
    const saved = window.localStorage.getItem('retroedit:theme')
    if (saved === 'dark' || saved === 'light') return saved
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  const customPositionRef = useRef(null)
  const [suggestions, setSuggestions] = useState([])
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(-1)


  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    window.localStorage.setItem('retroedit:theme', theme)
  }, [theme])

  useEffect(() => {
    const term = query.trim()
    const eligible = !customMode && !loading && term.length >= 2 &&
      !/^rs\d*$/i.test(term) && !term.includes(':') && !/^[ACGT]{15,}$/i.test(term)
    if (!eligible) {
      setSuggestions([])
      setSuggestionsOpen(false)
      setActiveSuggestion(-1)
      return undefined
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      fetchGeneSuggestions({ assembly: getGenome(genomeId).assembly, query: term }, controller.signal)
        .then((items) => {
          setSuggestions(items)
          setActiveSuggestion(-1)
          setSuggestionsOpen(document.activeElement === searchRef.current && items.length > 0)
        })
        .catch((error) => { if (error.name !== 'AbortError') console.error(error) })
    }, 140)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [customMode, genomeId, loading, query])

  const chooseSuggestion = (suggestion) => {
    const value = /^ENSG/i.test(query.trim()) ? suggestion.id : suggestion.name
    onQuery(value)
    setSuggestionsOpen(false)
    setActiveSuggestion(-1)
    searchRef.current?.blur()
    onSearch(value)
  }
  const focusLocusSearch = () => {
    setShortcutsOpen(false)
    searchRef.current?.focus()
  }

  const clearSequenceSelection = () => {
    setShortcutsOpen(false)
    onClearSelection?.(null)
  }

  useEffect(() => {
    const handleShortcut = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const questionMark = event.key === '?' || (event.code === 'Slash' && event.shiftKey)
      if (questionMark && !event.target?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"]')) {
        event.preventDefault()
        event.stopPropagation()
        setShortcutsOpen((open) => !open)
        return
      }
      if (event.key === 'Escape') {
        if (!event.target?.closest?.('[role="dialog"]')) clearSequenceSelection()
        return
      }
      const slash = event.key === '/' || (event.code === 'Slash' && !event.shiftKey)
      if (!slash || event.target?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      event.preventDefault()
      event.stopPropagation()
      focusLocusSearch()
    }
    window.addEventListener('keydown', handleShortcut, true)
    return () => window.removeEventListener('keydown', handleShortcut, true)
  }, [onClearSelection])

  const pamOk = isValidPattern(pam)
  const examples = EXAMPLES[genomeId] ?? []
  const queryOk = customMode || query.trim().length > 0
  const ensgQuery = /^ENSG/i.test(query.trim())
  const rsidQuery = /^rs\d+$/i.test(query.trim())
  const dnaSequenceQuery = /^[ACGT]{15,}$/i.test(query.trim())
  const spacerQuery = /^[ACGT]{20}$/i.test(query.trim())
  const uploadPercent = uploadProgress?.total
    ? Math.min(100, Math.round((uploadProgress.loaded / uploadProgress.total) * 100))
    : 0

  return (
    <form
      className={`controls${loading ? ' loading' : ''}${customMode ? ' custom-mode' : ''}`}
      aria-busy={loading}
      autoComplete="off"
      onSubmit={(e) => { e.preventDefault(); if (!customMode && queryOk && pamOk && loadChanged && !loading) onSearch() }}
    >
      <a className="controlbrand" href="/" aria-label="RetroEdit home">RetroEdit</a>
      <span className="sr-only" role="status" aria-live="polite">
        {loading ? (spacerQuery ? 'Finding exact genomic spacer matches' : rsidQuery ? 'Resolving rsID and loading region' : customMode ? 'Loading uploaded sequence' : 'Loading genomic region') : ''}
      </span>
      <div className="field genome">
        <div className="genomeinputs">
          <select value={genomeId} onChange={(e) => onGenome(e.target.value)} aria-label="Genome">
            {genomesByOrganism().map(([organism, builds]) => (
              <optgroup key={organism} label={organism}>
                {builds.map((g) => (
                  <option key={g.id} value={g.id}>{g.assembly}{g.note ? ` (${g.note})` : ''}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <div className="customuploadwrap">
            <label className="customupload" title="FASTA, plain DNA, or SnapGene .dna; multi-record FASTA is supported and SnapGene features are imported. The uploaded file stays only in this browser tab and is never stored server-side. RS3 sends only transient 30-nt guide contexts for scoring. Maximum 25 MB.">
              <span>Upload Sequence</span><small>browser only</small>
              <input
                type="file"
                accept=".dna,.fa,.fasta,.fna,.fas,.txt,application/octet-stream,text/plain"
                disabled={loading || !!uploadProgress}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) onCustomUpload(file)
                }}
              />
            </label>
          </div>
        </div>
      </div>

      {customMode ? (
        <div className="customsummary">
          <div className="customsummarymain">
            <strong>{customName || 'Custom DNA'}</strong>
            {customRecords.length > 1 && (
              <label className="customrecordpicker">
                <span>Record</span>
                <select value={customRecord} onChange={(event) => onCustomRecord(event.target.value)} disabled={loading}>
                  {customRecords.map((record) => (
                    <option key={record.name} value={record.name}>{record.name} · {record.length.toLocaleString()} bp{record.features?.length ? ` · ${record.features.length.toLocaleString()} features` : ''}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="custompositionpicker">
              <span>Position</span>
              <input key={customRecord} ref={customPositionRef} type="number" min="1" max={customRecords.find((record) => record.name === customRecord)?.length} defaultValue="1" />
              <button type="button" onClick={() => onCustomPosition(customPositionRef.current?.value)}>Go</button>
            </label>
          </div>
          <span>Uploaded DNA stays only in this browser tab and is never stored server-side. Off-targets run locally; RS3 sends only transient, non-cached 30-nt guide contexts.</span>
        </div>
      ) : (
        <div className="field grow">
          <div className="fieldlabelrow">
            <label htmlFor="gene-or-locus">Gene, locus, variant or guide</label>
            <span className="examplechips" aria-label="Example genes and loci">
              <span className="examplelabel">Examples</span>
              {examples.map((example) => (
                <button key={example} type="button" className="examplechip" disabled={loading} onClick={() => {
                  onQuery(example)
                  onSearch(example)
                }}>
                  {example}
                </button>
              ))}
            </span>
          </div>
          <div className="locussearch">
            <input
              id="gene-or-locus"
              ref={searchRef}
              name="retroedit-locus-query"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={suggestionsOpen}
              aria-controls="gene-suggestions"
              aria-activedescendant={activeSuggestion >= 0 ? `gene-suggestion-${activeSuggestion}` : undefined}
              value={query}
              placeholder="HBB  ·  ENSG00000244734  ·  chr11:5,227,002  ·  rs334  ·  20-nt guide"
              title={dnaSequenceQuery ? 'Enter exactly 20 nucleotides from either strand. Do not include the PAM; the PAM field is applied automatically.' : undefined}
              onChange={(event) => {
                setSuggestionsOpen(false)
                onQuery(event.target.value)
              }}
              onFocus={() => { if (suggestions.length) setSuggestionsOpen(true) }}
              onBlur={() => setSuggestionsOpen(false)}
              onKeyDown={(event) => {
                if (suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                  event.preventDefault()
                  setSuggestionsOpen(true)
                  setActiveSuggestion((current) => {
                    if (event.key === 'ArrowDown') return (current + 1) % suggestions.length
                    return current <= 0 ? suggestions.length - 1 : current - 1
                  })
                  return
                }
                if (event.key === 'Enter' && suggestionsOpen && activeSuggestion >= 0) {
                  event.preventDefault()
                  chooseSuggestion(suggestions[activeSuggestion])
                  return
                }
                if (event.key === 'Escape' && suggestionsOpen) {
                  event.preventDefault()
                  setSuggestionsOpen(false)
                  setActiveSuggestion(-1)
                  return
                }
                if ((event.key === '/' || event.code === 'Slash') && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
                  event.preventDefault()
                  event.currentTarget.select()
                }
              }}
              spellCheck={false}
            />
            {suggestionsOpen && suggestions.length > 0 && (
              <ul id="gene-suggestions" className="genesuggestions" role="listbox" aria-label="Matching genes">
                {suggestions.map((suggestion, index) => {
                  const primaryLabel = ensgQuery ? suggestion.id : suggestion.name
                  const secondaryLabel = ensgQuery
                    ? (suggestion.name !== suggestion.id ? suggestion.name : null)
                    : suggestion.id
                  const chrom = String(suggestion.chrom).replace(/^chr/i, '')
                  return (
                    <li
                      id={`gene-suggestion-${index}`}
                      key={suggestion.id}
                      role="option"
                      aria-selected={index === activeSuggestion}
                      className={index === activeSuggestion ? 'active' : ''}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActiveSuggestion(index)}
                      onClick={() => chooseSuggestion(suggestion)}
                    >
                      <span className="genesuggestionidentity">
                        <span>
                          <strong>{primaryLabel}</strong>
                          {secondaryLabel && <code>{secondaryLabel}</code>}
                        </span>
                        {suggestion.description && <em>{suggestion.description}</em>}
                      </span>
                      <small>chr{chrom}:{suggestion.start.toLocaleString()}–{suggestion.end.toLocaleString()}</small>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}

      <label className="field small">
        <span>PAM</span>
        <input
          value={pam}
          onChange={(e) => onPam(e.target.value.toUpperCase().replace(/[^ACGTRYSWKMBDHVN]/g, ''))}
          className={pamOk ? '' : 'invalid'}
          spellCheck={false}
          title="IUPAC codes allowed, e.g. NGG, NG, TTTV"
        />
      </label>


      {!customMode && (
        <button
          type={loading ? 'button' : 'submit'}
          className={`go${loading ? ' loading-action' : ''}`}
          disabled={!loading && (!queryOk || !pamOk || !loadChanged)}
          aria-label={loading ? 'Cancel current load' : 'Load gene, locus, variant, or guide'}
          title={loading ? 'Cancel the current load' : undefined}
          onClick={loading ? onCancelLoad : undefined}
        >
          {loading ? 'Cancel' : 'Load'}
        </button>
      )}
      {uploadProgress && (
        <div className="uploadprogressbackdrop" role="presentation">
          <section className="uploadprogressmodal" role="dialog" aria-modal="true" aria-labelledby="upload-progress-title">
            <div className="uploadprogressicon" aria-hidden="true">DNA</div>
            <div>
              <h2 id="upload-progress-title">{uploadProgress.phase === 'parsing' ? 'Preparing sequence and annotations…' : `Reading ${uploadProgress.name}`}</h2>
              <p>{uploadProgress.phase === 'parsing'
                ? 'Validating sequences and building the record list in this browser.'
                : `${formatBytes(uploadProgress.loaded)} of ${formatBytes(uploadProgress.total)} · ${uploadPercent}%`}</p>
            </div>
            <div className={`uploadprogresstrack${uploadProgress.phase === 'parsing' ? ' indeterminate' : ''}`}>
              <span style={uploadProgress.phase === 'parsing' ? undefined : { width: `${uploadPercent}%` }} />
            </div>
            <small>The uploaded file is never sent to or stored on the RetroEdit server. Only transient, non-cached 30-nt guide contexts are sent for RS3 scoring.</small>
          </section>
        </div>
      )}
      <div className="navutilities" aria-label="Display and help controls">
        <button type="button" className="themetoggle" aria-pressed={theme === 'dark'}
          aria-label={theme === 'dark' ? 'Use light mode' : 'Use dark mode'}
          title={theme === 'dark' ? 'Use light mode' : 'Use dark mode'}
          onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? (
            <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.5"/><path d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M15.8 4.2l-1.4 1.4M5.6 14.4l-1.4 1.4"/></svg>
          ) : (
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.8 12.7A6.6 6.6 0 0 1 7.3 4.2 6.7 6.7 0 1 0 15.8 12.7Z"/></svg>
          )}
        </button>
        <details className="shortcuthelp" open={shortcutsOpen}>
        <summary
          aria-label={shortcutsOpen ? 'Close keyboard shortcuts' : 'Open keyboard shortcuts'}
          aria-expanded={shortcutsOpen}
          title="Keyboard shortcuts (?)"
          onClick={(event) => { event.preventDefault(); setShortcutsOpen((open) => !open) }}
        >?</summary>
        <div className="shortcutmenu">
          <strong>Keyboard shortcuts</strong>
          <dl>
            <div><dt><kbd>?</kbd></dt><dd>Open or close this panel</dd></div>
            <div><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Move the sequence cursor</dd></div>
            <div><dt><kbd>A</kbd> <kbd>C</kbd> <kbd>G</kbd> <kbd>T</kbd></dt><dd>Insert or replace bases</dd></div>
            <div><dt><kbd>Delete</kbd></dt><dd>Delete selected bases</dd></div>
            <div><dt><kbd>Ctrl/⌘ Z</kbd></dt><dd>Undo an edit</dd></div>
            <div><dt><kbd>Ctrl/⌘ ⇧ Z</kbd></dt><dd>Redo an edit</dd></div>
            <div><dt><kbd>Ctrl/⌘ F</kbd></dt><dd>Find a DNA sequence</dd></div>
            <div><dt><kbd>Ctrl/⌘ C</kbd></dt><dd>Copy highlighted DNA or the guide clicked in the sequence viewer</dd></div>
            <div><dt><kbd>Ctrl/⌘ V</kbd></dt><dd>Paste DNA at the cursor or replace the selected bases</dd></div>
            <div><dt><button type="button" className="shortcutkey" onClick={focusLocusSearch}><kbd>/</kbd></button></dt><dd>Focus locus search</dd></div>
            <div><dt><button type="button" className="shortcutkey" onClick={clearSequenceSelection}><kbd>Esc</kbd></button></dt><dd>Clear sequence selection</dd></div>
          </dl>
          {recentSearches.length > 0 && (
            <section className="recentsearches">
              <div><strong>Recent loci</strong><button type="button" onClick={onClearRecent}>Clear</button></div>
              {recentSearches.map((item) => (
                <button type="button" key={`${item.genomeId}:${item.query}:${item.pam}`}
                  onClick={() => onRecent(item)}>
                  <span>{item.query}</span><small>{item.pam}</small>
                </button>
              ))}
            </section>
          )}
        </div>
        </details>
      </div>
    </form>
  )
}
