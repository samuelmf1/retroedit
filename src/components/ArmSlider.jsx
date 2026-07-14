import { useCallback, useEffect, useRef, useState } from 'react'

// A number field that lets you type freely (including empty / partial values)
// and only clamps to [min,max] on blur or Enter. Valid in-range values commit
// live so the slider tracks as you type.
function ArmInput({ value, min, max, onCommit, ariaLabel }) {
  const [text, setText] = useState(String(value))
  useEffect(() => { setText(String(value)) }, [value])

  const handleChange = (e) => {
    const raw = e.target.value
    setText(raw)
    const v = parseInt(raw, 10)
    if (Number.isFinite(v) && v >= min && v <= max) onCommit(v)
  }
  const commit = () => {
    const v = parseInt(text, 10)
    if (!Number.isFinite(v)) { setText(String(value)); return }
    const clamped = Math.max(min, Math.min(max, v))
    setText(String(clamped))
    onCommit(clamped)
  }
  return (
    <input
      type="number" min={min} max={max} value={text} aria-label={ariaLabel}
      onChange={handleChange}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
    />
  )
}

/**
 * One track, two thumbs — a dot per homology arm. The cut sits at the centre;
 * the left thumb sets the left-arm length (growing leftward) and the right thumb
 * the right-arm length (growing rightward), so the arms are independent.
 */
export default function ArmSlider({ left, right, min = 10, max = 200, onLeft, onRight }) {
  const trackRef = useRef(null)

  const drag = useCallback((side) => (event) => {
    event.preventDefault()
    const track = trackRef.current
    const set = side === 'left' ? onLeft : onRight
    const move = (e) => {
      const rect = track.getBoundingClientRect()
      const mid = rect.left + rect.width / 2
      const half = rect.width / 2
      // Distance from centre toward this side, as a fraction of the half-track.
      const dist = side === 'left' ? (mid - e.clientX) : (e.clientX - mid)
      const value = Math.round((dist / half) * max)
      set(Math.max(min, Math.min(max, value)))
    }
    move(event)
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [max, min, onLeft, onRight])

  const leftPct = 50 - (left / max) * 50
  const rightPct = 50 + (right / max) * 50

  return (
    <div className="armslider">
      <div className="armslider-labels">
        <span className="armfield">
          ←
          <ArmInput value={left} min={min} max={max} onCommit={onLeft} ariaLabel="Left arm length" />
          bp
        </span>
        <span className="armslider-cut">cut</span>
        <span className="armfield">
          <ArmInput value={right} min={min} max={max} onCommit={onRight} ariaLabel="Right arm length" />
          bp →
        </span>
      </div>
      <div className="armslider-track" ref={trackRef}>
        <div className="armslider-fill" style={{ left: `${leftPct}%`, right: `${100 - rightPct}%` }} />
        <div className="armslider-mid" />
        <div
          className="armslider-thumb left"
          style={{ left: `${leftPct}%` }}
          onMouseDown={drag('left')}
          role="slider"
          aria-label="Left arm length"
          aria-valuenow={left}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') onLeft(Math.min(max, left + 1))
            if (e.key === 'ArrowRight') onLeft(Math.max(min, left - 1))
          }}
        />
        <div
          className="armslider-thumb right"
          style={{ left: `${rightPct}%` }}
          onMouseDown={drag('right')}
          role="slider"
          aria-label="Right arm length"
          aria-valuenow={right}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') onRight(Math.min(max, right + 1))
            if (e.key === 'ArrowLeft') onRight(Math.max(min, right - 1))
          }}
        />
      </div>
    </div>
  )
}
