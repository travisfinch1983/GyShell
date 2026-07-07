/**
 * ScreenshotService — on-demand screen capture for the agent's `view_screen` tool.
 *
 * Uses getDisplayMedia (REAL rendered pixels) instead of html2canvas. html2canvas choked on
 * AI-Lab's modern CSS (531 color-mix() uses) and — fatally — cannot render cross-origin iframes
 * (Grafana/Dynacat/addons), so it could never show what the user is actually looking at.
 * getDisplayMedia captures the true composited frame: any CSS, any embedded panel.
 *
 * Constraint: getDisplayMedia requires a USER GESTURE, but the agent's capture_request has none.
 * So the first request per session surfaces a "Share screen" button (the click IS the gesture);
 * the granted MediaStream is then kept alive and every later capture grabs a still SILENTLY —
 * no re-prompt, no DOM manipulation, no panel vanish.
 */

export interface CaptureOptions {
  /** Longest edge of the returned JPEG. Default 1600. */
  maxWidth?: number
  /** JPEG quality 0-1. Default 0.85. */
  quality?: number
}

const DEFAULT_OPTIONS: Required<CaptureOptions> = { maxWidth: 1600, quality: 0.85 }

let shareStream: MediaStream | null = null

function liveTrack(): MediaStreamTrack | null {
  const t = shareStream?.getVideoTracks?.().find((v) => v.readyState === 'live')
  return t ?? null
}

/** True when an active screen-share stream is available for a silent capture. */
export function hasLiveShare(): boolean {
  return liveTrack() !== null
}

/** Acquire (or re-acquire) the screen-share stream. MUST be called from a user gesture
 *  (a button click). Resolves true if the user picked a source. The stream persists for the
 *  session; if the user stops sharing it self-clears so the next request re-prompts. */
export async function acquireScreenShare(): Promise<boolean> {
  if (hasLiveShare()) return true
  try {
    const md = navigator.mediaDevices as (MediaDevices & { getDisplayMedia?: (c: unknown) => Promise<MediaStream> }) | undefined
    if (!md?.getDisplayMedia) return false
    const stream = await md.getDisplayMedia({ video: { frameRate: 2 }, audio: false })
    shareStream = stream
    stream.getVideoTracks().forEach((t) => t.addEventListener('ended', () => { if (shareStream === stream) shareStream = null }))
    return true
  } catch {
    shareStream = null // user cancelled / denied / unsupported
    return false
  }
}

/** Stop sharing and release the stream (e.g. when the chat tab closes). */
export function stopScreenShare(): void {
  shareStream?.getTracks().forEach((t) => t.stop())
  shareStream = null
}

/** Grab a still from the live share stream as a JPEG data URL. Returns null if there is no
 *  live stream (caller must acquire first via a gesture) or a frame can't be decoded. */
export async function captureUI(options?: CaptureOptions): Promise<string | null> {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const track = liveTrack()
  if (!track) return null
  const video = document.createElement('video')
  video.muted = true
  video.srcObject = new MediaStream([track])
  try {
    await video.play().catch(() => undefined)
    if (video.readyState < 2) {
      await new Promise<void>((r) => { video.onloadeddata = () => r(); setTimeout(r, 2500) })
    }
    await new Promise<void>((r) => requestAnimationFrame(() => r()))
    const w = video.videoWidth
    const h = video.videoHeight
    if (!w || !h) return null
    const ratio = Math.min(1, opts.maxWidth / w)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(w * ratio)
    canvas.height = Math.round(h * ratio)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', opts.quality)
  } finally {
    video.pause()
    video.srcObject = null
  }
}
