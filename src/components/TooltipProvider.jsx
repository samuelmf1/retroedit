import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const TOOLTIP_ID = 'retroedit-tooltip'
const SHOW_DELAY_MS = 320

export default function TooltipProvider({ children }) {
  const [tooltip, setTooltip] = useState(null)
  const activeRef = useRef(null)
  const timerRef = useRef(null)
  const tooltipRef = useRef(null)
  const pointerSuppressedRef = useRef(null)

  useLayoutEffect(() => {
    const element = tooltipRef.current
    if (!element || !tooltip) return
    const width = element.getBoundingClientRect().width
    const margin = 12
    const left = Math.max(margin + width / 2, Math.min(window.innerWidth - margin - width / 2, tooltip.anchorLeft))
    const arrowLeft = Math.max(10, Math.min(width - 10, width / 2 + tooltip.anchorLeft - left))
    if (Math.abs(left - tooltip.left) < 0.5 && Math.abs(arrowLeft - (tooltip.arrowLeft ?? width / 2)) < 0.5) return
    setTooltip((current) => current ? { ...current, left, arrowLeft } : current)
  }, [tooltip])

  useEffect(() => {
    const clearTimer = () => {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }

    const restoreTitle = ({ target, title }) => {
      if (target.isConnected && !target.hasAttribute('title')) target.setAttribute('title', title)
    }

    const restoreActive = () => {
      clearTimer()
      const active = activeRef.current
      if (!active) return
      // Clear first so restoring title attributes cannot be observed as active tooltips.
      activeRef.current = null
      restoreTitle(active)
      active.suppressed.forEach(restoreTitle)
      if (active.describedBy == null) active.target.removeAttribute('aria-describedby')
      else active.target.setAttribute('aria-describedby', active.describedBy)
      setTooltip(null)
    }

    const suppressRelatedTitles = (target) => {
      const suppressed = []
      const seen = new Set([target])
      const suppress = (element) => {
        if (!(element instanceof Element) || seen.has(element)) return
        seen.add(element)
        const title = element.getAttribute('title')?.trim()
        if (!title) return
        suppressed.push({ target: element, title })
        element.removeAttribute('title')
      }
      target.querySelectorAll('[title]').forEach(suppress)
      let ancestor = target.parentElement?.closest('[title]')
      while (ancestor) {
        suppress(ancestor)
        ancestor = ancestor.parentElement?.closest('[title]')
      }
      return suppressed
    }

    const reveal = (target, immediate = false) => {
      if (!(target instanceof Element)) return
      if (activeRef.current?.target === target) return
      restoreActive()
      const title = target.getAttribute('title')?.trim()
      if (!title) return

      const describedBy = target.getAttribute('aria-describedby')
      target.removeAttribute('title')
      const suppressed = suppressRelatedTitles(target)
      target.setAttribute(
        'aria-describedby',
        describedBy ? `${describedBy} ${TOOLTIP_ID}` : TOOLTIP_ID,
      )
      activeRef.current = { target, title, describedBy, suppressed }

      const show = () => {
        const active = activeRef.current
        if (active?.target !== target) return
        const rect = target.getBoundingClientRect()
        const above = rect.bottom > window.innerHeight * 0.72
        setTooltip({
          text: active.title,
          anchorLeft: rect.left + rect.width / 2,
          left: rect.left + rect.width / 2,
          top: above ? rect.top - 9 : rect.bottom + 9,
          above,
        })
      }
      if (immediate) show()
      else timerRef.current = window.setTimeout(show, SHOW_DELAY_MS)
    }

    const titledTarget = (node) => node instanceof Element ? node.closest('[title]') : null
    const onPointerOver = (event) => {
      if (pointerSuppressedRef.current?.contains(event.target)) return
      const active = activeRef.current?.target
      if (active?.contains(event.target)) return
      reveal(titledTarget(event.target))
    }
    const onPointerOut = (event) => {
      const suppressed = pointerSuppressedRef.current
      if (suppressed && !suppressed.contains(event.relatedTarget)) pointerSuppressedRef.current = null
      const active = activeRef.current?.target
      if (active && !active.contains(event.relatedTarget)) restoreActive()
    }
    const onPointerDown = (event) => {
      const activeTarget = activeRef.current?.target
      const target = activeTarget?.contains(event.target) ? activeTarget : titledTarget(event.target)
      if (!target?.matches('button, [role="button"]')) return
      pointerSuppressedRef.current = target
      clearTimer()
      setTooltip(null)
    }
    const onFocusIn = (event) => {
      const target = titledTarget(event.target)
      if (pointerSuppressedRef.current === target) return
      reveal(target, true)
    }
    const onFocusOut = (event) => {
      const active = activeRef.current?.target
      if (active && !active.contains(event.relatedTarget)) restoreActive()
    }

    const titleObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        const active = activeRef.current
        if (!active || !(mutation.target instanceof Element)) return
        const element = mutation.target
        const related = element === active.target || active.target.contains(element) || element.contains(active.target)
        if (!related) return
        const nextTitle = element.getAttribute('title')?.trim()
        if (!nextTitle) return

        if (element === active.target) {
          active.title = nextTitle
          setTooltip((current) => current ? { ...current, text: nextTitle } : current)
        } else {
          const existing = active.suppressed.find((item) => item.target === element)
          if (existing) existing.title = nextTitle
          else active.suppressed.push({ target: element, title: nextTitle })
        }
        element.removeAttribute('title')
      })
    })
    titleObserver.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['title'],
    })

    document.addEventListener('pointerover', onPointerOver, true)
    document.addEventListener('pointerout', onPointerOut, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('focusout', onFocusOut, true)
    window.addEventListener('scroll', restoreActive, true)
    window.addEventListener('resize', restoreActive)
    return () => {
      document.removeEventListener('pointerover', onPointerOver, true)
      document.removeEventListener('pointerout', onPointerOut, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', onFocusOut, true)
      window.removeEventListener('scroll', restoreActive, true)
      window.removeEventListener('resize', restoreActive)
      titleObserver.disconnect()
      restoreActive()
    }
  }, [])

  return (
    <>
      {children}
      {tooltip && createPortal(
        <div
          ref={tooltipRef}
          id={TOOLTIP_ID}
          className={`retrotooltip${tooltip.above ? ' above' : ''}`}
          role="tooltip"
          style={{
            left: tooltip.left,
            top: tooltip.top,
            '--tooltip-arrow-left': tooltip.arrowLeft == null ? '50%' : `${tooltip.arrowLeft}px`,
          }}
        >
          {tooltip.text}
        </div>,
        document.body,
      )}
    </>
  )
}
