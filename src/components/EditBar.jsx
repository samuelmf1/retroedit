import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnnotationControls } from './FeatureRibbon.jsx'

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
  onEditFocus,
  annotationOptions, onAnnotationChange, biotypes, annotationStatus, assembly, inputKey, loadedInputKey,
  showAnnotations = true, sequenceSearch, onSequenceSearch, sequenceMatches, sequenceMatchIndex, onPreviousSequenceMatch, onNextSequenceMatch,
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
      const styles = window.getComputedStyle(bar)
      const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight)
      const gap = parseFloat(styles.columnGap || styles.gap) || 0
      const annotations = bar.querySelector('.editannotations')
      const search = bar.querySelector('.sequencefind')
      const actions = bar.querySelector('.editbar-actions')
      const fixedItems = [helper, annotations, search, actions].filter(Boolean)
      const requiredWidth = fixedItems.reduce((total, item) => total + item.getBoundingClientRect().width, 0)
        + Math.max(0, fixedItems.length - 1) * gap + horizontalPadding + 8
      setHideHelperForSpace(requiredWidth > bar.clientWidth)
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(bar)
    const annotations = bar.querySelector('.editannotations')
    const search = bar.querySelector('.sequencefind')
    if (annotations) observer.observe(annotations)
    if (search) observer.observe(search)
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

  return (
    <div className="editbar" ref={editBarRef}>
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

      <div className="editlist">
        {editList.map((e, i) => (
          <button
            key={i}
            type="button"
            className={`edittag ${e.type}`}
            title="Center and highlight this edit in the sequence viewer"
            onClick={() => onEditFocus?.(e)}
          >
            {e.label}
          </button>
        ))}
      </div>

      <>
        {showAnnotations && (
          <AnnotationControls
            opts={annotationOptions}
            onChange={onAnnotationChange}
            biotypes={biotypes}
            status={annotationStatus}
            assembly={assembly}
            className="editannotations"
          />
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
      </>
    </div>
  )
}
