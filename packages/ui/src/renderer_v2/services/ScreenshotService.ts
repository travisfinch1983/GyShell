import html2canvas from 'html2canvas'

export interface CaptureOptions {
  /** CSS selector for the root element to capture. Default: '.gyshell-body' */
  selector?: string
  /** Max width in pixels (scales down proportionally). Default: 1280 */
  maxWidth?: number
  /** JPEG quality 0-1. Default: 0.85 */
  quality?: number
  /** CSS selectors to exclude from capture (elements get hidden temporarily). */
  exclude?: string[]
  /** CSS selectors to REMOVE from layout during capture (display:none + reflow,
   *  restored after). Use for overlays/panels that would otherwise cover the
   *  content the capture is meant to show — `exclude`'s visibility:hidden keeps
   *  the element's box and (with html2canvas) can still mask what's behind it. */
  hide?: string[]
}

const DEFAULT_OPTIONS: Required<CaptureOptions> = {
  selector: '.gyshell-body',
  maxWidth: 1280,
  quality: 0.85,
  exclude: [],
  hide: [],
}

/**
 * Capture the GyShell UI as a base64 JPEG data URL.
 * Uses html2canvas to render the DOM to a canvas, then scales and compresses.
 */
export async function captureUI(options?: CaptureOptions): Promise<string | null> {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const element = document.querySelector(opts.selector) as HTMLElement
  if (!element) return null

  // Temporarily hide excluded elements
  const hidden: Array<{ el: HTMLElement; prev: string }> = []
  for (const sel of opts.exclude) {
    document.querySelectorAll<HTMLElement>(sel).forEach(el => {
      hidden.push({ el, prev: el.style.visibility })
      el.style.visibility = 'hidden'
    })
  }
  // Remove `hide` targets from layout entirely so content behind/beside them is
  // captured (overlay → reveals what's underneath; flex/grid sibling → the main
  // view reclaims the space), then let the browser reflow before snapshotting.
  const removed: Array<{ el: HTMLElement; prev: string }> = []
  for (const sel of opts.hide) {
    document.querySelectorAll<HTMLElement>(sel).forEach(el => {
      removed.push({ el, prev: el.style.display })
      el.style.display = 'none'
    })
  }
  if (removed.length) {
    void document.body.offsetHeight // force synchronous reflow
    await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))) // let paint settle
  }

  try {
    const canvas = await html2canvas(element, {
      backgroundColor: null,
      scale: 1,
      logging: false,
      useCORS: true,
      allowTaint: true,
    })

    // Scale down if needed
    const ratio = Math.min(1, opts.maxWidth / canvas.width)
    if (ratio < 1) {
      const scaled = document.createElement('canvas')
      scaled.width = Math.round(canvas.width * ratio)
      scaled.height = Math.round(canvas.height * ratio)
      const ctx = scaled.getContext('2d')
      if (ctx) {
        ctx.drawImage(canvas, 0, 0, scaled.width, scaled.height)
        return scaled.toDataURL('image/jpeg', opts.quality)
      }
    }
    return canvas.toDataURL('image/jpeg', opts.quality)
  } finally {
    // Restore hidden elements
    for (const { el, prev } of hidden) {
      el.style.visibility = prev
    }
    for (const { el, prev } of removed) {
      el.style.display = prev
    }
  }
}
