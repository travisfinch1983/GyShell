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
}

const DEFAULT_OPTIONS: Required<CaptureOptions> = {
  selector: '.gyshell-body',
  maxWidth: 1280,
  quality: 0.85,
  exclude: [],
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
  }
}
