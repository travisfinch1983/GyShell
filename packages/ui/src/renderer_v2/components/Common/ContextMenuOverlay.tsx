import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  setContextMenuOpenHandler,
  dispatchContextMenuAction,
  type ContextMenuOpenPayload,
} from './contextMenuController'
import './contextMenuOverlay.scss'

/**
 * Top-level overlay that renders the right-click popover anywhere in the
 * app. Mount once at the App root. Listens via the controller singleton.
 */
export const ContextMenuOverlay: React.FC = () => {
  const [menu, setMenu] = useState<ContextMenuOpenPayload | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    setContextMenuOpenHandler((payload) => setMenu(payload))
    return () => setContextMenuOpenHandler(null)
  }, [])

  // Clamp to viewport once we have measured dimensions, so the menu never
  // renders off-screen near the right or bottom edge.
  useLayoutEffect(() => {
    if (!menu) {
      setPosition(null)
      return
    }
    const node = menuRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const x = Math.min(menu.x, Math.max(0, vw - rect.width - 4))
    const y = Math.min(menu.y, Math.max(0, vh - rect.height - 4))
    setPosition({ x, y })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const onWheel = () => close()
    const onResize = () => close()
    // Capture pointerdown so we close BEFORE the click reaches anything else.
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('wheel', onWheel, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('wheel', onWheel, true)
      window.removeEventListener('resize', onResize)
    }
  }, [menu])

  if (!menu) return null

  const handleSelect = (action: 'copy' | 'paste' | 'replace', payload?: string) => {
    const id = menu.id
    setMenu(null)
    // Dispatch on a microtask so the close-pointerdown listener doesn't
    // race the action handler (which may itself open new state).
    queueMicrotask(() => dispatchContextMenuAction({ id, action, payload }))
  }

  const suggestions = menu.suggestions || []

  return (
    <div
      ref={menuRef}
      className="context-menu-overlay"
      style={{
        left: (position?.x ?? menu.x) + 'px',
        top: (position?.y ?? menu.y) + 'px',
        // Hide while measuring to avoid a flash at the original (unclamped) position.
        visibility: position ? 'visible' : 'hidden',
      }}
      role="menu"
      // Stop the global pointerdown-close handler from firing when the user
      // clicks INSIDE the menu (the item's own handler handles the close).
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {suggestions.length > 0 && (
        <>
          {suggestions.map((suggestion, idx) => (
            <button
              key={`sug-${idx}-${suggestion}`}
              type="button"
              className="context-menu-item context-menu-item--suggestion"
              role="menuitem"
              onClick={() => handleSelect('replace', suggestion)}
            >
              {suggestion}
            </button>
          ))}
          <div className="context-menu-separator" role="separator" />
        </>
      )}
      <button
        type="button"
        className="context-menu-item"
        role="menuitem"
        disabled={!menu.canCopy}
        onClick={() => handleSelect('copy')}
      >
        Copy
      </button>
      <button
        type="button"
        className="context-menu-item"
        role="menuitem"
        disabled={!menu.canPaste}
        onClick={() => handleSelect('paste')}
      >
        Paste
      </button>
    </div>
  )
}
