import React, { useRef, useState } from 'react'
import { Download, Save, Shapes } from 'lucide-react'
import { SvgEditEmbed, type SvgEditHandle } from './SvgEditEmbed'

/**
 * SVG tab — self-hosted svgedit with an AI-Lab shell around it.
 *
 * P1 is the EMBED only: the editor works and drawings can be pulled out of it. Persistence
 * (/api/svgs), the svg_* MCP tools and AI generation are P2-P4 — see
 * /claude/plans/ailab-svg-editor.md. The Save button therefore says plainly that it only
 * downloads for now, rather than implying a store that does not exist yet.
 */
export const SvgPanel: React.FC = () => {
  const handleRef = useRef<SvgEditHandle | null>(null)
  const [ready, setReady] = useState(false)
  const [dirty, setDirty] = useState(false)

  const download = () => {
    const svg = handleRef.current?.getSvg()
    if (!svg) return
    const blob = new Blob([svg], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `drawing-${Date.now()}.svg`
    a.click()
    URL.revokeObjectURL(url)
    setDirty(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
        <Shapes size={16} />
        <strong style={{ fontSize: 13 }}>SVG</strong>
        <span style={{ fontSize: 11, color: 'var(--fg-faint)' }}>
          {ready ? (dirty ? 'unsaved changes' : 'ready') : 'loading editor…'}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: 'var(--fg-faint)' }}>
          server store + MCP tools land in P2/P3 — Save downloads a file for now
        </span>
        <button
          onClick={download}
          disabled={!ready}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', border: '1px solid var(--accent)', borderRadius: 8, background: 'var(--accent)', color: 'var(--app-bg)', fontWeight: 600, fontSize: 12, cursor: ready ? 'pointer' : 'default' }}
        >
          <Download size={13} /> Download SVG
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <SvgEditEmbed
          svg=""
          reloadKey="svg-main"
          onReady={() => setReady(true)}
          onDirty={() => setDirty(true)}
          handleRef={(h) => { handleRef.current = h }}
        />
      </div>
    </div>
  )
}
