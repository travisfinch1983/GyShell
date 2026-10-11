import type React from 'react'
import { useCallback, useRef } from 'react'

/**
 * Shift-click range selection for the addon image browsers -- the same behaviour as the training
 * image browser: a plain click toggles one tile and becomes the anchor; shift-click ADDS every tile
 * from the anchor to the clicked one (inclusive) on the current page.
 *
 * The anchor is an item id, not an index: after a page change, filter change or reload an index
 * would silently point at a different tile. If the anchor is no longer on the page, shift-click
 * falls back to a plain toggle (and becomes the new anchor).
 *
 * `pageIds` = the selectable ids in on-screen order (leave out tiles that have no checkbox).
 */
export function useRangeSelect<K>(setSelected: React.Dispatch<React.SetStateAction<Set<K>>>) {
  const anchor = useRef<K | null>(null)
  return useCallback((id: K, pageIds: K[], shift: boolean) => {
    const a = anchor.current === null ? -1 : pageIds.indexOf(anchor.current)
    const b = pageIds.indexOf(id)
    anchor.current = id
    if (shift && a >= 0 && b >= 0) {
      const [lo, hi] = a <= b ? [a, b] : [b, a]
      setSelected((prev) => { const n = new Set(prev); for (let i = lo; i <= hi; i++) n.add(pageIds[i]); return n })
    } else {
      setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
    }
  }, [setSelected])
}

/** onMouseDown for a shift-clickable control: stops the browser highlighting page text on shift-click. */
export const noShiftTextSelect = (e: React.MouseEvent) => { if (e.shiftKey) e.preventDefault() }
