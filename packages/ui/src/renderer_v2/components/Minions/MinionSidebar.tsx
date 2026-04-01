/**
 * MinionSidebar — Resizable panel containing model cards and activity feed
 * with a draggable divider and collapsible feed.
 */

import React, { useRef, useState, useCallback } from 'react'
import { observer } from 'mobx-react-lite'
import type { MinionStore } from '../../stores/MinionStore'
import { MinionCards } from './MinionCards'
import { MinionFeed } from './MinionFeed'
import './MinionSidebar.scss'

interface MinionSidebarProps {
  store: MinionStore
}

export const MinionSidebar = observer(({ store }: MinionSidebarProps) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [feedHeight, setFeedHeight] = useState(200) // px
  const [feedExpanded, setFeedExpanded] = useState(true)
  const [dragging, setDragging] = useState(false)
  const dragStartY = useRef(0)
  const dragStartHeight = useRef(0)

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
    dragStartY.current = e.clientY
    dragStartHeight.current = feedHeight

    const onMouseMove = (ev: MouseEvent) => {
      const delta = dragStartY.current - ev.clientY
      const newHeight = Math.max(60, Math.min(600, dragStartHeight.current + delta))
      setFeedHeight(newHeight)
    }

    const onMouseUp = () => {
      setDragging(false)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [feedHeight])

  const toggleFeed = () => {
    setFeedExpanded(!feedExpanded)
  }

  return (
    <div className="minion-sidebar" ref={containerRef}>
      <div className="minion-sidebar-cards" style={feedExpanded ? { flex: `1 1 0`, minHeight: 80 } : { flex: 1 }}>
        <MinionCards store={store} />
      </div>

      {feedExpanded && (
        <div
          className={`minion-sidebar-divider ${dragging ? 'active' : ''}`}
          onMouseDown={onDragStart}
        >
          <div className="minion-divider-grip" />
        </div>
      )}

      <div
        className={`minion-sidebar-feed ${feedExpanded ? '' : 'collapsed'}`}
        style={feedExpanded ? { height: feedHeight, minHeight: 60 } : {}}
      >
        <div className="minion-feed-toggle" onClick={toggleFeed}>
          <span className="minion-feed-toggle-chevron">{feedExpanded ? '▾' : '▴'}</span>
          <span className="minion-feed-toggle-label">Activity</span>
          <span className="minion-feed-toggle-count">
            {store.allMessages.length || ''}
          </span>
        </div>
        {feedExpanded && (
          <div className="minion-sidebar-feed-content">
            <MinionFeed store={store} />
          </div>
        )}
      </div>
    </div>
  )
})
