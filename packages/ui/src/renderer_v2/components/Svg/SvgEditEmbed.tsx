import { useEffect, useRef } from 'react'

/**
 * Thin bridge over the self-hosted svgedit at /svgedit — SAME ORIGIN, static, no external
 * calls and no container, exactly like the draw.io embed powering the Flowchart tab.
 *
 * draw.io needs a postMessage protocol; svgedit does not, because same-origin lets us read
 * the iframe's window directly. We talk only to `window.aiLabSvg`, the narrow bridge defined
 * in our own ailab.html — never to svgedit's internals, so a version bump cannot silently
 * break this.
 */
const SVGEDIT_SRC = '/svgedit/ailab.html'

export interface SvgEditHandle {
  /** Current drawing as SVG text, or '' if the editor is not ready yet. */
  getSvg: () => string
  /** Replace the canvas. Returns false if svgedit rejected the string. */
  loadSvg: (svg: string) => boolean
}

interface Props {
  /** Loaded once the editor signals ready; change reloadKey to load a different drawing. */
  svg: string
  reloadKey: string | number
  onReady?: () => void
  onDirty?: () => void
  handleRef?: (h: SvgEditHandle | null) => void
}

export function SvgEditEmbed({ svg, reloadKey, onReady, onDirty, handleRef }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const svgRef = useRef(svg)
  svgRef.current = svg

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    let cancelled = false
    let tries = 0

    // svgedit has no ready EVENT, so poll for the bridge. Bounded: ~10s then give up loudly
    // rather than spinning forever — a silent never-ready iframe is indistinguishable from a
    // blank canvas, which is precisely the failure mode worth avoiding.
    const wait = () => {
      if (cancelled) return
      const api = (iframe.contentWindow as any)?.aiLabSvg
      if (api?.ready) {
        if (svgRef.current) api.load(svgRef.current)
        if (onDirty) api.onChange(onDirty)
        handleRef?.({
          getSvg: () => api.get() ?? '',
          loadSvg: (s: string) => api.load(s),
        })
        onReady?.()
        return
      }
      if (++tries > 100) {
        console.error('[SvgEditEmbed] /svgedit/ailab.html never exposed window.aiLabSvg after 10s '
          + '— the editor bundle failed to load or its API changed.')
        return
      }
      setTimeout(wait, 100)
    }
    wait()
    return () => { cancelled = true; handleRef?.(null) }
    // reloadKey drives a full remount via key= on the iframe, so this only needs to re-run
    // when the frame itself is replaced.
  }, [reloadKey])

  return (
    <iframe
      key={reloadKey}
      ref={iframeRef}
      src={SVGEDIT_SRC}
      title="SVG editor"
      style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
    />
  )
}
