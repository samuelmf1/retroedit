import { useEffect, useState } from 'react'
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
        Clear Edits
      </button>
    </div>
  )
}

export default function EditBar({
  editList, selRange, edits, canUndo, canRedo, onUndo, onRedo, onRevert,
  annotationOptions, onAnnotationChange, biotypes, inputKey, loadedInputKey,
}) {
  const [hasEditedForInput, setHasEditedForInput] = useState(false)
  const inputChanged = inputKey !== loadedInputKey
  const hideHelper = inputChanged ? false : hasEditedForInput || edits
  const showActions = edits || canUndo || canRedo

  useEffect(() => {
    setHasEditedForInput(false)
  }, [inputKey])

  useEffect(() => {
    if (edits && !inputChanged) setHasEditedForInput(true)
  }, [edits, inputChanged])

  return (
    <div className="editbar">
      {!hideHelper && (
        <div className="edithint">
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
          <span key={i} className={`edittag ${e.type}`}>{e.label}</span>
        ))}
      </div>

      <AnnotationControls
        opts={annotationOptions}
        onChange={onAnnotationChange}
        biotypes={biotypes}
        className="editannotations"
      />
    </div>
  )
}
