import { useEffect, useRef } from 'react'

let warnedBadFrame = false

// Self-hosted draw.io is served (static) by the AI-Lab web app at /drawio — SAME ORIGIN, no
// external calls, no container. This component is a thin bridge over draw.io's official embed
// postMessage protocol (proto=json): we don't modify draw.io's source at all.
//   init     (from iframe) -> we reply {action:'load', xml, autosave:1}
//   save     (from iframe) -> onSave(xml)      (user clicked Save in draw.io's toolbar)
//   autosave (from iframe) -> onAutoSave(xml)  (fires on edits when autosave enabled)
//   export   (from iframe) -> onExport(data)   (in reply to an exportDiagram() request)
const DRAWIO_BASE = '/drawio'

export interface DrawioHandle {
  export: (format: 'xmlpng' | 'png' | 'svg' | 'xmlsvg') => void
}

interface Props {
  xml: string
  reloadKey: string | number      // change this to force-reload a different diagram into the editor
  onSave?: (xml: string) => void
  onAutoSave?: (xml: string) => void
  onExport?: (data: string, format: string) => void
  onReady?: () => void
  handleRef?: (h: DrawioHandle | null) => void
}

export function DrawioEmbed({ xml, reloadKey, onSave, onAutoSave, onExport, onReady, handleRef }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const xmlRef = useRef(xml)
  xmlRef.current = xml
  const readyRef = useRef(false)

  const post = (action: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify(action), '*')
  }

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    const onMsg = (e: MessageEvent) => {
      if (e.source !== iframe.contentWindow || typeof e.data !== 'string') return
      let msg: any
      // An unparseable frame from the embed is how a draw.io version bump
      // changing the postMessage envelope would break saving — with no signal.
      // One warn per session is enough to name the culprit.
      try { msg = JSON.parse(e.data) } catch {
        if (!warnedBadFrame) { warnedBadFrame = true; console.warn('[drawio] unparseable postMessage frame from the editor iframe — protocol drift? First 120 chars:', String(e.data).slice(0, 120)) }
        return
      }
      if (!msg || !msg.event) return
      switch (msg.event) {
        case 'configure':
          post({ action: 'configure', config: {} })
          break
        case 'init':
          readyRef.current = true
          post({ action: 'load', xml: xmlRef.current || '', autosave: 1 })
          onReady?.()
          break
        case 'save':
          if (typeof msg.xml === 'string') onSave?.(msg.xml)
          break
        case 'autosave':
          if (typeof msg.xml === 'string') onAutoSave?.(msg.xml)
          break
        case 'export':
          if (typeof msg.data === 'string') onExport?.(msg.data, msg.format || '')
          break
        default:
          break
      }
    }
    window.addEventListener('message', onMsg)
    handleRef?.({ export: (format) => post({ action: 'export', format }) })
    return () => { window.removeEventListener('message', onMsg); handleRef?.(null) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Force-load a different diagram when the selected chart changes.
  useEffect(() => {
    if (readyRef.current) post({ action: 'load', xml: xml || '', autosave: 1 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey])

  // Embed params: json protocol, shape libraries sidebar on, our own diagram store (no drawio
  // storage backends), dark UI, spinner while the app boots. proto=json makes save/autosave/export
  // carry the XML/data inline. See www.drawio.com/doc/faq/embed-mode.
  const params = new URLSearchParams({
    embed: '1', proto: 'json', spin: '1', libraries: '1',
    noSaveBtn: '0', saveAndExit: '0', noExitBtn: '1', ui: 'dark',
  })
  return (
    <iframe
      ref={iframeRef}
      src={`${DRAWIO_BASE}/?${params.toString()}`}
      title="draw.io"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, display: 'block' }}
    />
  )
}
