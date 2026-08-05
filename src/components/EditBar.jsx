import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnnotationControls } from './FeatureRibbon.jsx'

const MAX_EDIT_SEQUENCE_PREVIEW = 18

function compactEditLabel(edit) {
  if (!edit?.label || edit.length <= MAX_EDIT_SEQUENCE_PREVIEW || edit.type === 'del') return edit?.label ?? ''
  const marker = edit.type === 'ins' ? 'ins' : edit.type === 'sub' ? 'delins' : ''
  const markerIndex = marker ? edit.label.lastIndexOf(marker) : -1
  if (markerIndex < 0) return edit.label
  const prefix = edit.label.slice(0, markerIndex + marker.length)
  const sequence = edit.label.slice(markerIndex + marker.length)
  const head = sequence.slice(0, 9)
  const tail = sequence.slice(-6)
  return `${prefix}${head}…${tail} · ${edit.length.toLocaleString()} bp`
}

function editSummary(edit) {
  const kind = edit.type === 'ins' ? 'Insertion' : edit.type === 'del' ? 'Deletion' : 'Replacement'
  return `${kind} · ${edit.length.toLocaleString()} bp. Center and highlight this edit in the sequence viewer.`
}

export function EditActions({
  edits, canUndo, canRedo, onUndo, onRedo, onRevert, compact = false,
}) {
  return (
    <div className={`editactions ${compact ? 'editbar-actions' : 'sidebar-editactions'}`}
      aria-label="Edit history controls">
      <button className={`histbtn ${edits ? 'accent' : ''}`} onClick={onUndo}
        disabled={!canUndo} title="Undo (Cmd/Ctrl+Z)">
        ↶ Undo
      </button>
      <button className="histbtn" onClick={onRedo} disabled={!canRedo}
        title="Redo (Cmd/Ctrl+Shift+Z)">
        ↷ Redo
      </button>
      <button className={`revert ${edits ? 'accent' : ''}`} onClick={onRevert}
        disabled={!edits} title="Clear all edits and restore the reference sequence">
        Revert to reference
      </button>
    </div>
  )
}

export default function EditBar({
  editList, selRange, edits, canUndo, canRedo, onUndo, onRedo, onRevert,
  onEditFocus, customFeatureCount = 0, onDownloadSnapGene, onDownloadGenBank, snapGeneDisabled = false,
  annotationOptions, onAnnotationChange, biotypes, annotationStatus, assembly, inputKey, loadedInputKey,
  showAnnotations = true, sequenceLineMode = 'window', onSequenceLineMode,
  exploreGuides = false, onExploreGuides, sequenceBlocked = false,
  sequenceSearch, onSequenceSearch, sequenceMatches, sequenceMatchIndex, onPreviousSequenceMatch, onNextSequenceMatch,
  proteinMutationCount = 0, onOpenProteinStructure,
}) {
  const [hasEditedForInput, setHasEditedForInput] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [hideHelperForSpace, setHideHelperForSpace] = useState(false)
  const editBarRef = useRef(null)
  const helperRef = useRef(null)
  const searchInputRef = useRef(null)
  const inputChanged = inputKey !== loadedInputKey
  const hideHelper = searchOpen || (inputChanged ? false : hasEditedForInput || edits)
  const showActions = edits || canUndo || canRedo

  useLayoutEffect(() => {
    if (hideHelper) {
      setHideHelperForSpace(false)
      return undefined
    }
    const bar = editBarRef.current
    const helper = helperRef.current
    if (!bar || !helper) return undefined

    const measure = () => {
      const main = bar.querySelector('.editbar-main')
      if (!main) return
      const styles = window.getComputedStyle(main)
      const gap = parseFloat(styles.columnGap || styles.gap) || 0
      const actions = main.querySelector('.editbar-actions')
      const editList = main.querySelector('.editlist')
      const fixedItems = [helper, actions, editList].filter(Boolean)
      const requiredWidth = fixedItems.reduce((total, item) => total + item.getBoundingClientRect().width, 0)
        + Math.max(0, fixedItems.length - 1) * gap + 4
      setHideHelperForSpace(requiredWidth > main.clientWidth)
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(bar)
    const main = bar.querySelector('.editbar-main')
    const tools = bar.querySelector('.editbar-tools')
    if (main) observer.observe(main)
    if (tools) observer.observe(tools)
    return () => observer.disconnect()
  }, [hideHelper, annotationOptions, biotypes, showAnnotations])

  useEffect(() => {
    const openSequenceSearch = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return
      event.preventDefault()
      event.stopPropagation()
      setSearchOpen(true)
      requestAnimationFrame(() => {
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
      })
    }
    window.addEventListener('keydown', openSequenceSearch, true)
    return () => window.removeEventListener('keydown', openSequenceSearch, true)
  }, [])

  useEffect(() => {
    setHasEditedForInput(false)
  }, [inputKey])

  useEffect(() => {
    if (edits && !inputChanged) setHasEditedForInput(true)
  }, [edits, inputChanged])

  const totalEditLabelLength = editList.reduce((total, edit) => total + (edit.label?.length || 0), 0)
  const showEditsInline = editList.length > 0
    && editList.length <= 3
    && totalEditLabelLength <= 72
    && editList.every(edit => (edit.label?.length || 0) <= 42)

  const renderEditTag = (edit, index, compact = false) => {
    const label = compact ? compactEditLabel(edit) : edit.label
    return (
      <button
        key={index}
        type="button"
        className={`edittag ${edit.type}${label !== edit.label ? ' abbreviated' : ''}`}
        title={editSummary(edit)}
        aria-label={`${label}. ${editSummary(edit)}`}
        onClick={() => onEditFocus?.(edit)}
      >
        {label}
      </button>
    )
  }

  return (
    <div className="editbar" ref={editBarRef}>
      <div className="editbar-main">
      {!hideHelper && (
        <div ref={helperRef} className={`edithint${hideHelperForSpace ? ' space-hidden' : ''}`} aria-hidden={hideHelperForSpace || undefined}>
          type <span className="kbd">A C G T</span> in the sequence to {selRange ? 'replace selection' : 'insert'} ·
          drag to select · double-click a base to mutate · <span className="kbd">⌫</span> to delete
        </div>
      )}

      {showActions && (
        <EditActions
          compact
          edits={edits}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={onUndo}
          onRedo={onRedo}
          onRevert={onRevert}
        />
      )}

      {showEditsInline && (
        <div className="editlist inline" aria-label={`${editList.length} sequence ${editList.length === 1 ? 'edit' : 'edits'}`}>
          {editList.map((edit, index) => renderEditTag(edit, index))}
        </div>
      )}

      {editList.length > 0 && !showEditsInline && (
        <details className="editmenu">
          <summary><span>Edits</span><b>{editList.length}</b><i aria-hidden="true" /></summary>
          <div className="editlist">
            {editList.map((edit, index) => renderEditTag(edit, index, true))}
          </div>
        </details>
      )}
      </div>

      <div className="editbar-tools">
      {proteinMutationCount > 0 && (
        <button type="button" className="proteinstructureopen" onClick={onOpenProteinStructure}
          title="View edited residues on the AlphaFold reference structure">
          <svg viewBox="0 0 22 22" aria-hidden="true">
            <circle cx="5" cy="5" r="2" /><circle cx="16.5" cy="4.5" r="2" />
            <circle cx="7.5" cy="16.5" r="2" /><circle cx="17" cy="15" r="2" />
            <path d="M6.7 6.1l7.8-1M6.1 6.8l1 7.6m2.3 1.1l5.7-.5m.8-8.4l.7 6.3M8.8 14.8l6.4-8.3" />
          </svg>
          Protein structure <small>{proteinMutationCount}</small>
        </button>
      )}
      <button type="button" className={`toolbarshowguides${exploreGuides ? ' active' : ''}`}
        aria-pressed={exploreGuides} disabled={sequenceBlocked}
        title={exploreGuides ? 'Return to edit-specific guides' : 'Calculate guides across the displayed sequence'}
        onClick={onExploreGuides}>
        {exploreGuides ? (edits ? 'Edit-specific guides' : 'Hide all guides') : 'Show all guides'}
      </button>
      <div className="sequencelayout" role="group" aria-label="Sequence view">
        {[
          { value: 'window', label: 'Wrap to window' },
          { value: 'fixed', label: 'Fixed 100 bp lines' },
          { value: 'single', label: 'Single line' },
        ].map((mode) => (
          <button type="button" key={mode.value}
            className={sequenceLineMode === mode.value ? 'active' : ''}
            aria-label={mode.label} aria-pressed={sequenceLineMode === mode.value}
            title={mode.label} onClick={() => onSequenceLineMode?.(mode.value)}>
            <span className={`sequenceviewicon ${mode.value}`} aria-hidden="true">
              <i /><i /><i />
            </span>
          </button>
        ))}
      </div>
      </div>

      <div className="editbar-annotationtray">
        <div className={`annotationfeaturegroup${showAnnotations ? ' withannotations' : ''}`}>
          {showAnnotations && (
            <AnnotationControls
              opts={annotationOptions}
              onChange={onAnnotationChange}
              biotypes={biotypes}
              status={annotationStatus}
              assembly={assembly}
              className="editannotations"
              compact
            />
          )}
        </div>
        {customFeatureCount > 0 && (
          <div className="sequenceexportgroup" role="group" aria-label="Save annotated sequence">
            <button type="button" className="snapgeneexport" onClick={onDownloadSnapGene}
              disabled={snapGeneDisabled} title="Download as a SnapGene DNA file">
              <span aria-hidden="true">↓</span> .dna <small>{customFeatureCount}</small>
            </button>
            <button type="button" className="snapgeneexport gbk" onClick={onDownloadGenBank}
              disabled={snapGeneDisabled} title="Download as a generic GenBank file">
              <span aria-hidden="true">↓</span> .gbk
            </button>
          </div>
        )}
          <div className={`sequencefind${searchOpen ? ' open' : ''}`}>
            <button type="button" className="sequencefind-toggle" aria-label="Find DNA sequence"
              aria-pressed={searchOpen} title="Find sequence on either DNA strand"
              onClick={() => {
                if (searchOpen) onSequenceSearch('')
                setSearchOpen((open) => !open)
              }}>
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="8.5" cy="8.5" r="5.5" />
                <path d="M12.5 12.5L17 17" />
              </svg>
            </button>
            {searchOpen && (
              <div className="sequencefind-box">
                <input
                  autoFocus
                  ref={searchInputRef}
                  value={sequenceSearch}
                  onChange={(event) => onSequenceSearch(event.target.value.toUpperCase().replace(/[^ACGTRYSWKMBDHVN]/g, ''))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      if (event.shiftKey) onPreviousSequenceMatch()
                      else onNextSequenceMatch()
                    }
                    if (event.key === 'Escape') {
                      event.stopPropagation()
                      onSequenceSearch('')
                      setSearchOpen(false)
                    }
                  }}
                  placeholder="DNA sequence"
                  aria-label="Sequence to find"
                  spellCheck={false}
                />
                <span className="sequencefind-count" aria-live="polite">
                  {sequenceMatches.length ? `${sequenceMatchIndex + 1} / ${sequenceMatches.length}` : sequenceSearch ? '0 matches' : ''}
                </span>
                <button type="button" onClick={onPreviousSequenceMatch} disabled={!sequenceMatches.length}
                  aria-label="Previous sequence match" title="Previous match (Shift+Enter)">↑</button>
                <button type="button" onClick={onNextSequenceMatch} disabled={!sequenceMatches.length}
                  aria-label="Next sequence match" title="Next match (Enter)">↓</button>
                <button type="button" className="sequencefind-close" aria-label="Close sequence search"
                  onClick={() => { onSequenceSearch(''); setSearchOpen(false) }}>×</button>
              </div>
            )}
          </div>
      </div>
    </div>
  )
}
