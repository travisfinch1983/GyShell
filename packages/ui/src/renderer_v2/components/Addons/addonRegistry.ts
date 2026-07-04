import type React from 'react'
import { ImageUpscale, type LucideIcon } from 'lucide-react'

/**
 * Addon registry — SELF-CONTAINED addon modules folded into AI-Lab as
 * Addons-tab sub-tabs (Travis architecture 2026-07-04).
 *
 * An addon lives in /opt/ai-lab/addons/<id>/ { app/, .venv/, data/, addon.json }
 * on CT152; the AI-Lab backend supervises its local server and proxies its UI
 * SAME-ORIGIN at `/addons/<id>/` (no LAN hosts, no cross-host iframes). The UI
 * only ever consumes that path.
 *
 * ADDING AN ADDON = one entry here (claude2: zero framework edits — the panel
 * renders whatever this array holds). This static registry is the interim
 * source of truth; it swaps to the backend's addon.json manifest list when
 * claude1's manifest endpoint lands (same shape by design).
 *
 * `subtabs`: for addon UIs that are themselves tabbed/multi-page — each inner
 * sub-tab is a different path under the same `/addons/<id>/` root. Omit for
 * single-page addons.
 */
export interface AddonSubtab {
  id: string
  label: string
  /** iframe mode: same-origin path for this inner view (usually `${addon.path}<page>`). */
  path?: string
  /** native mode: a React component rendered directly (blends with AI-Lab styling). */
  component?: React.ComponentType
}

export interface AddonDef {
  id: string
  label: string
  Icon?: LucideIcon
  /** iframe mode: same-origin proxied root of the addon UI: `/addons/<id>/`. */
  path?: string
  /** native mode: React component for the addon's root view. An addon provides
   *  `component` (native), `path` (iframe), or subtabs mixing both per view. */
  component?: React.ComponentType
  subtabs?: AddonSubtab[]
}

export const ADDONS: AddonDef[] = [
  {
    id: 'upscaler',
    label: 'Upscaler',
    Icon: ImageUpscale,
    // Module at /opt/ai-lab/addons/upscaler/ (FastAPI/uvicorn, local port),
    // supervised + proxied by the backend — claude1's half, in flight.
    path: '/addons/upscaler/',
  },
]
