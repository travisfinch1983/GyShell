import type React from 'react'
import { Blocks, ImageUpscale, type LucideIcon } from 'lucide-react'

/**
 * Addon registry — SELF-CONTAINED addon modules as Addons-tab sub-tabs.
 * Schema ratified with claude1 (2026-07-04):
 *
 *  - MANIFEST (data-serializable — mirrors the module's addon.json at
 *    /opt/ai-lab/addons/<id>/): { id, label, icon?, basePath, views:
 *    [{id, label, kind: 'native'|'embed', path?}] }. The backend supervises
 *    the addon's local server and proxies it SAME-ORIGIN under basePath.
 *  - NATIVE_VIEWS: client-side lookup `${addonId}.${viewId}` → React
 *    component (a manifest can't carry code). Embed addons are pure data;
 *    native addons = one manifest + ONE lookup line per view.
 *
 * claude2: adding an embed addon = one manifest entry here (zero framework
 * edits). Adding a native addon = manifest entry + one NATIVE_VIEWS line per
 * view. This static list swaps to the backend's addon.json endpoint when it
 * lands — same shape by design.
 */
export interface AddonViewDef {
  id: string
  label: string
  kind: 'native' | 'embed'
  /** embed views: same-origin path (absolute, or relative to basePath). */
  path?: string
}

export interface AddonManifest {
  id: string
  label: string
  /** icon slug (data-serializable) — mapped to lucide via ADDON_ICONS. */
  icon?: string
  /** same-origin proxied root of the addon module: `/addons/<id>`. */
  basePath: string
  views: AddonViewDef[]
}

export const ADDON_ICONS: Record<string, LucideIcon> = {
  upscale: ImageUpscale,
  default: Blocks,
}

/** Native view components, keyed `${addonId}.${viewId}`. One line per view. */
export const NATIVE_VIEWS: Record<string, React.ComponentType> = {
  // Upscaler's 5 native views (dashboard/browse/history/sync + compare detail)
  // register here once built against claude1's JSON contract — HELD until the
  // contract lands (missing ids render an honest pending note, not a blank).
}

export const ADDONS: AddonManifest[] = [
  {
    id: 'upscaler',
    label: 'Upscaler',
    icon: 'upscale',
    // Bundled module at /opt/ai-lab/addons/upscaler (FastAPI, backend-supervised);
    // JSON API under /addons/upscaler/api/* — claude1's half, in flight.
    basePath: '/addons/upscaler',
    views: [
      { id: 'dashboard', label: 'Dashboard', kind: 'native' },
      { id: 'browse', label: 'Browse', kind: 'native' },
      { id: 'history', label: 'History', kind: 'native' },
      { id: 'sync', label: 'Sync', kind: 'native' },
      // 'compare' is a detail view reached from history/browse (overlay), not a tab.
    ],
  },
]
