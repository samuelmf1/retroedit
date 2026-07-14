export default function EditBar({
  edits, editList, selRange, canUndo, canRedo, onUndo, onRedo, onRevert,
}) {
  return (
    <div className="editbar">
      <div className="edithint">
        type <span className="kbd">A C G T</span> in the sequence to {selRange ? 'replace selection' : 'insert'} ·
        drag to select · double-click a base to mutate · <span className="kbd">⌫</span> to delete
      </div>

      <div className="editactions">
        <button className={`histbtn ${edits ? 'accent' : ''}`} onClick={onUndo} disabled={!canUndo} title="Undo (Cmd/Ctrl+Z)">
          ↶ Undo
        </button>
        <button className="histbtn" onClick={onRedo} disabled={!canRedo} title="Redo (Cmd/Ctrl+Shift+Z)">
          ↷ Redo
        </button>
        <button className={`revert ${edits ? 'accent' : ''}`} onClick={onRevert} disabled={!edits}>
          Revert to reference
        </button>
      </div>

      <div className="editlist">
        {editList.length === 0 && <span className="muted">no edits yet. Mutations you make will list here</span>}
        {editList.map((e, i) => (
          <span key={i} className={`edittag ${e.type}`}>{e.label}</span>
        ))}
      </div>
    </div>
  )
}
